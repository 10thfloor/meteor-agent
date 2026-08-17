import { assert } from 'chai';
import type { Provider } from '../server/providers/types';
import type { AgentMessage } from '../common/types';

/** Every unanswered `toolCalls[].id` in a transcript. A provider rejects a
 *  `tool_use` with no matching `tool_result` with a 400 on every retry, so an
 *  abandoned turn must never leave one behind. */
const unansweredToolUses = (msgs: AgentMessage[]): string[] => {
  const answered = new Set(
    msgs.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId),
  );
  return msgs
    .flatMap((m) => m.toolCalls ?? [])
    .map((c) => c.id)
    .filter((id) => !answered.has(id));
};

/** Deferred work (the resume a verdict schedules, the turn a send defers)
 *  exposes no promise to await, so every wait here is bounded by a deadline and
 *  fails loudly rather than hanging the suite. */
const waitFor = async (cond: () => Promise<boolean>, label: string, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
};

const seed = async (sessionId: string, text: string, agent = 'support') => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
  await AgentSessions.insertAsync({
    _id: sessionId, agent, userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  await AgentMessages.insertAsync({
    _id: 'u-msg', sessionId, seq: 0, role: 'user', content: text, createdAt: new Date(),
  } as any);
};

describe('turn loop', () => {
  it('streams deltas then commits one assistant message', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s1', 'hello');
    await runTurn('s1', {
      model: 'mock', system: 'You are a test.', tools: [],
      provider: mockProvider(() => ({ text: 'hi there' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's1' }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(msgs, 2);
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content, 'hi there');

    // The committed message supersedes its deltas, which are removed at
    // commit — old sessions must not accumulate every token ever streamed.
    const remaining = await AgentDeltas.find({ sessionId: 's1' }).countAsync();
    assert.equal(remaining, 0, 'commit must clean up the deltas it supersedes');
  });

  it('reconstructs the same text from deltas as it commits', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas } = await import('../common/collections');
    const { mergeView } = await import('../common/merge');
    const { runTurn } = await import('../server/loop');

    await seed('s2', 'hello');
    // Deltas are removed at commit, so they must be captured DURING the
    // stream: after the last text chunk, wait past the flush interval, then
    // snapshot before yielding 'done'.
    let captured: any[] = [];
    const capturing: Provider = {
      async *stream() {
        for (const ch of 'streamed answer') yield { kind: 'text', chunk: ch };
        await new Promise((r) => setTimeout(r, 200)); // > flushMs: all flushed
        captured = await AgentDeltas.find({ sessionId: 's2' }).fetchAsync();
        yield { kind: 'done', usage: { input: 1, output: 15 } };
      },
    };
    await runTurn('s2', { model: 'mock', system: '', tools: [], provider: capturing });

    const committed = await AgentMessages.findOneAsync({ sessionId: 's2', role: 'assistant' });
    assert.isAbove(captured.length, 0, 'tokens should have streamed');
    assert.equal(captured[0].msgSeq, committed!.seq, 'deltas must carry the future seq');

    // mergeView walks back only while seq decrements by exactly 1, so a gap —
    // or a seq assigned out of push order — silently truncates the render.
    const seqs = captured.map((d) => d.seq).sort((a, b) => a - b);
    seqs.forEach((s, i) => assert.equal(s, i, 'delta seqs must be contiguous from 0'));

    const fromDeltas = mergeView([], captured).map((m) => m.content).join('');
    assert.equal(fromDeltas, committed!.content);
  });

  it('sweeps crash-orphaned deltas on the next turn (repair-on-entry)', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s-crash', 'hello');
    // A SIGKILL mid-stream leaves deltas under a messageId that was never
    // committed: discardTurn never ran, and nothing in mergeView suppresses
    // them — they render as a permanently-streaming ghost row at the SAME
    // msgSeq the retry will stream at. Repair-on-entry must sweep them.
    await AgentDeltas.insertAsync({
      _id: 'ghost-1', sessionId: 's-crash', messageId: 'never-committed',
      msgSeq: 1, seq: 0, kind: 'text', chunk: 'half an ans', at: new Date(),
    } as any);

    await runTurn('s-crash', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'clean retry' })),
    });

    const ghosts = await AgentDeltas
      .find({ sessionId: 's-crash', messageId: 'never-committed' }).countAsync();
    assert.equal(ghosts, 0, 'crash-orphaned deltas must be swept on entry');
    const committed = await AgentMessages
      .findOneAsync({ sessionId: 's-crash', role: 'assistant' });
    assert.equal(committed!.content, 'clean retry');
  });

  it('runs a tool call and feeds the result back', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s3', 'look it up');
    let call = 0;
    await runTurn('s3', {
      model: 'mock', system: '',
      tools: [{
        name: 'lookup', description: 'x', args: { type: 'object', properties: {} },
        run: async () => ({ found: 42 }),
      }],
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? { toolCalls: [{ id: 't1', name: 'lookup', args: {} }] }
          : { text: 'it is 42' };
      }),
    });

    const msgs = await AgentMessages.find({ sessionId: 's3' }, { sort: { seq: 1 } }).fetchAsync();
    const roles = msgs.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(msgs[3].content, 'it is 42');
    assert.equal(msgs[2].content, JSON.stringify({ found: 42 }));
  });

  it('commits nothing when the lease is stolen mid-stream', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s4', 'hello');

    // Another server steals the lease BETWEEN yields — after the turn is
    // underway. Stealing it before `runTurn` would make `claimLease` fail and
    // the loop return having exercised nothing at all.
    const stealer: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'should ' };
        await AgentSessions.updateAsync('s4', {
          $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
        } as any);
        yield { kind: 'text', chunk: 'not commit' };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };

    await runTurn('s4', { model: 'mock', system: '', tools: [], provider: stealer });

    assert.equal(
      await AgentMessages.find({ sessionId: 's4', role: 'assistant' }).countAsync(), 0,
      'no assistant message may commit once the lease is gone',
    );
    assert.equal(
      await AgentDeltas.find({ sessionId: 's4' }).countAsync(), 0,
      'orphaned deltas would render as a permanent streaming ghost row',
    );

    const msgs = await AgentMessages.find({ sessionId: 's4' }, { sort: { seq: 1 } }).fetchAsync();
    assert.equal(msgs[msgs.length - 1].role, 'user', 'transcript must stay resumable');
  });

  it('leaves no unanswered tool_use when the lease is stolen during a tool call', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s6', 'look it up');
    let call = 0;
    await runTurn('s6', {
      model: 'mock', system: '',
      tools: [{
        name: 'lookup', description: 'x', args: { type: 'object', properties: {} },
        // The steal lands after the assistant(toolCalls) row is committed and
        // before its tool result can be written — the exact window that used
        // to strand a tool_use forever.
        run: async () => {
          await AgentSessions.updateAsync('s6', {
            $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
          } as any);
          return { found: 42 };
        },
      }],
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? { toolCalls: [{ id: 't1', name: 'lookup', args: {} }] }
          : { text: 'it is 42' };
      }),
    });

    const msgs = await AgentMessages.find({ sessionId: 's6' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'an abandoned tool turn must not leave a tool_use the provider will 400 on',
    );
    assert.equal(
      msgs.filter((m) => m.role === 'assistant').length, 0,
      'the assistant row whose tool results never landed must be removed',
    );
    assert.equal(msgs[msgs.length - 1].role, 'user', 'transcript must stay resumable');
    assert.equal(
      await AgentDeltas.find({ sessionId: 's6' }).countAsync(), 0,
      'the abandoned turn must take its deltas with it',
    );
  });

  it('repairs an unanswered tool_use left behind by a previous run', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // Hand-seed what a crash between commit and tool dispatch leaves behind:
    // [user, assistant(toolCalls)] with no tool results, and a free lease.
    await seed('s7', 'look it up');
    await AgentMessages.insertAsync({
      _id: 'a-orphan', sessionId: 's7', seq: 1, role: 'assistant', content: '',
      toolCalls: [{ id: 't-dead', name: 'lookup', args: {} }], createdAt: new Date(),
    } as any);
    await AgentDeltas.insertAsync({
      _id: 'd-orphan', sessionId: 's7', messageId: 'a-orphan', msgSeq: 1, seq: 0,
      kind: 'text', chunk: 'half an answer', at: new Date(),
    } as any);
    await AgentSessions.updateAsync('s7', { $set: { nextSeq: 2 } } as any);

    await runTurn('s7', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's7' }, { sort: { seq: 1 } }).fetchAsync();
    assert.isUndefined(
      msgs.find((m) => m._id === 'a-orphan'), 'the dangling assistant must be repaired away',
    );
    assert.deepEqual(unansweredToolUses(msgs), []);
    assert.equal(msgs[msgs.length - 1].role, 'assistant', 'the recovery turn must complete');
    assert.equal(msgs[msgs.length - 1].content, 'recovered');
    assert.equal(
      await AgentDeltas.find({ messageId: 'a-orphan' }).countAsync(), 0,
      'the orphan deltas must go with the message that never got answered',
    );
  });

  it('repairs an assistant whose tool calls were only partially answered', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // Parallel tool calls are the DEFAULT for Anthropic and OpenAI alike, so a
    // kill between the first and second result is the common crash, not an
    // exotic one. Tool rows carry a HIGHER seq than the assistant they answer,
    // so what it leaves behind ends in a `tool` row — a transcript that looks
    // healthy to anything that only inspects the tail, while `t2` stays
    // unanswered and 400s every provider call from here to forever.
    await seed('s8', 'look them both up');
    await AgentMessages.insertAsync({
      _id: 'a-partial', sessionId: 's8', seq: 1, role: 'assistant', content: '',
      toolCalls: [
        { id: 't1', name: 'lookup', args: {} },
        { id: 't2', name: 'lookup', args: {} },
      ],
      createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'tool-t1', sessionId: 's8', seq: 2, role: 'tool', toolCallId: 't1',
      content: JSON.stringify({ found: 1 }), createdAt: new Date(),
    } as any);
    await AgentSessions.updateAsync('s8', { $set: { nextSeq: 3 } } as any);

    await runTurn('s8', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's8' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'repair must scan the whole transcript, not just its tail',
    );
    assert.isUndefined(
      msgs.find((m) => m._id === 'a-partial'),
      'the half-answered assistant must be repaired away',
    );
    assert.isUndefined(
      msgs.find((m) => m._id === 'tool-t1'),
      'its landed partial answer must go with it, or it strands a tool_result',
    );
    assert.equal(msgs[msgs.length - 1].content, 'recovered', 'the recovery turn must complete');
  });

  it('scopes tool-call answered-detection to its own turn window, not the whole session', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // `t1` is answered once, at seq 2 — then reused, unanswered, by a LATER
    // assistant at seq 5. A session-wide "answered" set would see `t1` in the
    // set from the seq-2 tool row and never flag the seq-5 assistant: a
    // permanent 400 with no self-heal. Detection must be scoped to each
    // assistant's own (seq, next-assistant-seq) window.
    await seed('s10', 'look it up');
    await AgentMessages.insertAsync({
      _id: 'a1', sessionId: 's10', seq: 1, role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'lookup', args: {} }], createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'tool1', sessionId: 's10', seq: 2, role: 'tool', toolCallId: 't1',
      content: JSON.stringify({ found: 1 }), createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'a-done', sessionId: 's10', seq: 3, role: 'assistant', content: 'done',
      createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'u2', sessionId: 's10', seq: 4, role: 'user', content: 'again', createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'a2', sessionId: 's10', seq: 5, role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'lookup', args: {} }], createdAt: new Date(),
    } as any);
    await AgentSessions.updateAsync('s10', { $set: { nextSeq: 6 } } as any);

    await runTurn('s10', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'recovered' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's10' }, { sort: { seq: 1 } }).fetchAsync();

    assert.isUndefined(
      msgs.find((m) => m._id === 'a2'),
      'the seq-5 assistant with an unanswered t1 must be repaired away',
    );
    assert.isDefined(
      msgs.find((m) => m._id === 'a1'),
      'the seq-1 assistant, whose t1 WAS answered inside its own window, must survive untouched',
    );
    assert.isDefined(
      msgs.find((m) => m._id === 'tool1'),
      'the seq-2 tool row that answered seq-1 must survive untouched',
    );
    assert.equal(msgs[msgs.length - 1].content, 'recovered', 'the recovery turn must complete');
  });

  it('does not dispatch a second tool once the lease is gone', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s9', 'look them both up');
    let ranSecond = false;

    // The takeover has to land AFTER the first result commits. Stealing from
    // inside the first tool's `run` trips the post-hoc `guardedUpdate` instead
    // — the branch the s6 test above already covers — and the loop returns
    // before a second dispatch ever happens. Both guards test the identical
    // lease predicate, so the only way to reach the pre-flight `holdsLease` is
    // for another server to take over in the window between one tool result
    // landing and the next dispatch. Hooking the insert puts the steal exactly
    // there, with no timing race.
    const original = (AgentMessages as any).insertAsync.bind(AgentMessages);
    const descriptor = Object.getOwnPropertyDescriptor(AgentMessages, 'insertAsync');
    (AgentMessages as any).insertAsync = async (doc: any, ...rest: any[]) => {
      const id = await original(doc, ...rest);
      if (doc.role === 'tool' && doc.toolCallId === 't1') {
        await AgentSessions.updateAsync('s9', {
          $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
        } as any);
      }
      return id;
    };

    try {
      let call = 0;
      await runTurn('s9', {
        model: 'mock', system: '',
        tools: [
          {
            name: 'first', description: 'x', args: { type: 'object', properties: {} },
            run: async () => ({ found: 1 }),
          },
          {
            name: 'second', description: 'x', args: { type: 'object', properties: {} },
            run: async () => { ranSecond = true; return { found: 2 }; },
          },
        ],
        provider: mockProvider(() => {
          call += 1;
          return call === 1
            ? {
              toolCalls: [
                { id: 't1', name: 'first', args: {} },
                { id: 't2', name: 'second', args: {} },
              ],
            }
            : { text: 'never reached' };
        }),
      });
    } finally {
      if (descriptor) Object.defineProperty(AgentMessages, 'insertAsync', descriptor);
      else delete (AgentMessages as any).insertAsync;
    }

    assert.isFalse(
      ranSecond,
      'a tool is a real side effect — it must not run under a lease we no longer hold',
    );
    const msgs = await AgentMessages.find({ sessionId: 's9' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'abandoning at the pre-flight must still take the whole turn with it',
    );
    assert.equal(msgs[msgs.length - 1].role, 'user', 'transcript must stay resumable');
  });

  it('sets phase back to idle and releases the lease when done', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s5', 'hello');
    await runTurn('s5', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'done' })),
    });

    const doc = await AgentSessions.findOneAsync('s5');
    assert.equal(doc!.phase, 'idle');
    assert.isUndefined(doc!.lease);
  });

  it('honors an interrupt mid-stream: no commit, no ghost deltas, phase stays stopped', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s-int', 'hello');
    // The interrupt lands between chunks, exactly as agent.interrupt would:
    // phase flips to 'stopped' while the provider is mid-response.
    const interrupting: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'should ' };
        await new Promise((r) => setTimeout(r, 30));
        await AgentSessions.updateAsync('s-int', { $set: { phase: 'stopped' } } as any);
        await new Promise((r) => setTimeout(r, 30));
        yield { kind: 'text', chunk: 'never ' };
        await new Promise((r) => setTimeout(r, 30));
        yield { kind: 'text', chunk: 'commit' };
        yield { kind: 'done', usage: { input: 1, output: 3 } };
      },
    };

    await runTurn('s-int', {
      model: 'mock', system: '', tools: [],
      provider: interrupting, interruptCheckMs: 5,
    });

    const assistants = await AgentMessages
      .find({ sessionId: 's-int', role: 'assistant' }).countAsync();
    assert.equal(assistants, 0, 'an interrupted stream must not commit');
    const deltas = await AgentDeltas.find({ sessionId: 's-int' }).countAsync();
    assert.equal(deltas, 0, 'an interrupted stream must clean up its deltas');
    const doc = await AgentSessions.findOneAsync('s-int');
    assert.equal(doc!.phase, 'stopped', 'the finally must preserve the stop');
  });

  it('interrupt during tool dispatch discards the turn instead of stranding tool_use', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s-int2', 'do two things');
    let secondToolRan = false;
    let call = 0;

    await runTurn('s-int2', {
      model: 'mock', system: '',
      tools: [
        {
          name: 'first', description: 'x', args: { type: 'object', properties: {} },
          run: async () => {
            // Interrupt lands while tool 1 runs; tool 2 must never dispatch.
            await AgentSessions.updateAsync('s-int2', { $set: { phase: 'stopped' } } as any);
            return 'one';
          },
        },
        {
          name: 'second', description: 'x', args: { type: 'object', properties: {} },
          run: async () => { secondToolRan = true; return 'two'; },
        },
      ],
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? { toolCalls: [
              { id: 'i1', name: 'first', args: {} },
              { id: 'i2', name: 'second', args: {} },
            ] }
          : { text: 'unreachable' };
      }),
    });

    assert.isFalse(secondToolRan, 'the second tool must not run after an interrupt');
    const msgs = await AgentMessages
      .find({ sessionId: 's-int2' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'no stranded tool_use after interrupt');
    assert.equal(
      msgs[msgs.length - 1].role, 'user',
      'the discarded turn must leave the transcript resumable',
    );
  });

  it('a send landing mid-stream never duplicates a seq', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    // Methods are already registered by the package's own Meteor.startup —
    // registering again throws "already defined". Registry entries, by
    // contrast, live in a Map and overwrite cleanly.
    // mSend resolves its config from the registry; the deferred runTurn it
    // schedules hits the in-process running guard and returns immediately.
    new Agent('support', {
      model: 'mock', instructions: 'x', tools: [],
      provider: mockProvider(() => ({ text: 'unused' })),
    });

    await seed('s-race', 'first message');
    const sendHandler = (Meteor.server as any).method_handlers[NAMES.mSend];

    // The provider injects a REAL agent.send between yields — the exact
    // interleaving that used to hand the user message and the streaming
    // assistant the same seq (both read nextSeq before either $inc'd it).
    // One-shot: the loop answers the interjection with a SECOND iteration,
    // which calls the provider again.
    let injected = false;
    const racing: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'reply ' };
        if (!injected) {
          injected = true;
          await sendHandler.call({ userId: 'u1' }, 'support', 's-race', 'second message');
        }
        yield { kind: 'text', chunk: 'text' };
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };

    await runTurn('s-race', {
      model: 'mock', system: '', tools: [], provider: racing,
    });

    const msgs = await AgentMessages
      .find({ sessionId: 's-race' }, { sort: { seq: 1 } }).fetchAsync();
    const seqs = msgs.map((m) => m.seq);
    assert.equal(new Set(seqs).size, seqs.length,
      `every message must own a unique seq, got [${seqs.join(', ')}]`);
    assert.lengthOf(
      msgs.filter((m) => m.role === 'user' && m.content === 'second message'), 1,
      'the mid-stream send must be committed, not lost',
    );
    // The interjection must be ANSWERED, not merely committed: the loop
    // notices a user message it never saw and runs another iteration instead
    // of ending the turn. Two user messages, two assistant replies, and the
    // final message is the answer.
    assert.lengthOf(msgs.filter((m) => m.role === 'assistant'), 2,
      'the mid-stream send must be answered by a second iteration');
    assert.equal(msgs[msgs.length - 1].role, 'assistant');
  });

  it('rejects send and interrupt against a session the caller does not own', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    new Agent('authtest', {
      model: 'mock', instructions: 'x', tools: [],
      provider: mockProvider(() => ({ text: 'ok' })),
    });
    // Registered so the wrong-agent case below fails on session lookup
    // ('no-session'), not on registry lookup ('no-agent').
    new Agent('authtest-other', {
      model: 'mock', instructions: 'x', tools: [],
      provider: mockProvider(() => ({ text: 'ok' })),
    });

    await AgentSessions.removeAsync({});
    await AgentSessions.insertAsync({
      _id: 'auth-s1', agent: 'authtest', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);

    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    const interrupt = (Meteor.server as any).method_handlers[NAMES.mInterrupt];

    const rejects = async (fn: () => Promise<unknown>, label: string) => {
      try { await fn(); } catch (e: any) {
        assert.equal(e.error, 'no-session', label);
        return;
      }
      assert.fail(`${label}: expected no-session, but the call succeeded`);
    };

    // Another user and an anonymous caller are both strangers to this session.
    await rejects(() => send.call({ userId: 'u2' }, 'authtest', 'auth-s1', 'hi'), 'send as other user');
    await rejects(() => send.call({ userId: null }, 'authtest', 'auth-s1', 'hi'), 'send as anonymous');
    await rejects(() => interrupt.call({ userId: 'u2' }, 'authtest', 'auth-s1'), 'interrupt as other user');
    // The wrong AGENT name is a stranger too, even for the owner.
    await rejects(() => send.call({ userId: 'u1' }, 'authtest-other', 'auth-s1', 'hi'), 'send via wrong agent');
    // And the owner through the right agent works.
    const sid = await send.call({ userId: 'u1' }, 'authtest', 'auth-s1', 'hello');
    assert.equal(sid, 'auth-s1');
  });

  it('retries a retryable provider failure and then succeeds', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-retry', 'hello');
    let attempts = 0;
    const flaky: Provider = {
      async *stream() {
        attempts += 1;
        if (attempts < 3) { const e: any = new Error('rate limited'); e.status = 429; throw e; }
        yield { kind: 'text', chunk: 'recovered' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };
    await runTurn('s-retry', { model: 'mock', system: '', tools: [], provider: flaky, retry: { attempts: 3, baseMs: 10 } });
    assert.equal(attempts, 3);
    const committed = await AgentMessages.findOneAsync({ sessionId: 's-retry', role: 'assistant' });
    assert.equal(committed!.content, 'recovered');
    assert.equal((await AgentSessions.findOneAsync('s-retry'))!.phase, 'idle');
  });

  it('does not retry a fatal provider error and surfaces a sanitized note', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-fatal', 'hello');
    let attempts = 0;
    const broken: Provider = {
      // eslint-disable-next-line require-yield
      async *stream() { attempts += 1; const e: any = new Error('invalid x-api-key sk-SECRET'); e.status = 401; throw e; },
    };
    await runTurn('s-fatal', { model: 'mock', system: '', tools: [], provider: broken, retry: { attempts: 3, baseMs: 10 } });
    assert.equal(attempts, 1, 'a 401 must not be retried');
    const note = await AgentMessages.findOneAsync({ sessionId: 's-fatal', role: 'note', kind: 'error' } as any);
    assert.isDefined(note);
    assert.notInclude(JSON.stringify(note), 'SECRET', 'raw provider messages must never reach the transcript');
    assert.equal((await AgentSessions.findOneAsync('s-fatal'))!.phase, 'error');
  });

  it('exhausted retries also produce an error note, and no partial commit', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-exhaust', 'hello');
    const alwaysDown: Provider = {
      async *stream() { yield { kind: 'text', chunk: 'par' }; const e: any = new Error('boom'); e.status = 503; throw e; },
    };
    await runTurn('s-exhaust', { model: 'mock', system: '', tools: [], provider: alwaysDown, retry: { attempts: 2, baseMs: 10 } });
    assert.equal(await AgentMessages.find({ sessionId: 's-exhaust', role: 'assistant' }).countAsync(), 0);
    assert.equal(await AgentDeltas.find({ sessionId: 's-exhaust' }).countAsync(), 0, 'partial deltas cleaned per attempt');
    assert.isDefined(await AgentMessages.findOneAsync({ sessionId: 's-exhaust', role: 'note', kind: 'error' } as any));
    assert.equal((await AgentSessions.findOneAsync('s-exhaust'))!.phase, 'error');
  });

  it('a stop landing during a failed attempt outranks the retry', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions, AgentDeltas } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-stop-retry', 'hello');
    let attempts = 0;
    // The shape a 429/503 actually takes: the stream throws BEFORE yielding a
    // single chunk, so the in-stream interrupt check never runs even once.
    // The user's stop therefore reaches the retry branch and nowhere else —
    // and the retry branch is the only place left that can honor it.
    const saboteur: Provider = {
      // eslint-disable-next-line require-yield
      async *stream() {
        attempts += 1;
        await AgentSessions.updateAsync('s-stop-retry', {
          $set: { phase: 'stopped', updatedAt: new Date() },
        } as any);
        const e: any = new Error('rate limited'); e.status = 429; throw e;
      },
    };

    await runTurn('s-stop-retry', {
      model: 'mock', system: '', tools: [], provider: saboteur,
      retry: { attempts: 3, baseMs: 10 },
    });

    assert.equal(attempts, 1, 'a stop must prevent the retry entirely');
    assert.equal(
      await AgentMessages.find({ sessionId: 's-stop-retry', role: 'assistant' }).countAsync(), 0,
      'a cancelled turn must never commit an assistant message',
    );
    assert.equal(
      await AgentMessages.find({ sessionId: 's-stop-retry', role: 'note' } as any).countAsync(), 0,
      'a stop outranks the error note too — the user cancelled, nothing failed at them',
    );
    assert.equal(await AgentDeltas.find({ sessionId: 's-stop-retry' }).countAsync(), 0);
    assert.equal((await AgentSessions.findOneAsync('s-stop-retry'))!.phase, 'stopped',
      'retry must not overwrite the stop with `retrying`/`error`');
  });

  it('shows phase `retrying` between attempts and sleeps a real backoff', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-retry-phase', 'hello');
    let attempts = 0;
    const flaky: Provider = {
      async *stream() {
        attempts += 1;
        if (attempts === 1) { const e: any = new Error('down'); e.status = 503; throw e; }
        yield { kind: 'text', chunk: 'back up' };
        yield { kind: 'done', usage: { input: 1, output: 1 } };
      },
    };

    // `retrying` is only observable BETWEEN attempts, so poll for it rather
    // than reading the phase after the fact — by then it is `idle` again.
    const seenPhases = new Set<string>();
    const sampler = setInterval(() => {
      void AgentSessions.findOneAsync('s-retry-phase')
        .then((s) => { if (s) seenPhases.add(s.phase); })
        .catch(() => { /* sampling is best-effort */ });
    }, 15);

    const startedAt = Date.now();
    try {
      await runTurn('s-retry-phase', {
        model: 'mock', system: '', tools: [], provider: flaky,
        retry: { attempts: 2, baseMs: 120 },
      });
    } finally { clearInterval(sampler); }
    const elapsed = Date.now() - startedAt;

    assert.equal(attempts, 2);
    assert.isTrue(seenPhases.has('retrying'),
      `the retry must be visible to the client, saw [${[...seenPhases].join(', ')}]`);
    // Floor only. CI is slow and the sleep is bounded from below by design;
    // asserting an upper bound would just be a flake generator.
    assert.isAtLeast(elapsed, 120, 'the backoff must be a real sleep, not a no-op');
    const committed = await AgentMessages.findOneAsync({ sessionId: 's-retry-phase', role: 'assistant' });
    assert.equal(committed!.content, 'back up');
  });

  it('streams every attempt under a fresh messageId', async function () {
    this.timeout(30000);
    const { AgentDeltas } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    await seed('s-retry-ids', 'hello');
    let attempts = 0;
    let firstAttemptIds: string[] = [];
    let secondAttemptDeltas: any[] = [];
    // Same mid-stream capture idiom as the 'reconstructs' test: deltas are
    // removed the moment an attempt ends, so they must be read from inside
    // the stream, after a wait longer than the flush interval.
    const flaky: Provider = {
      async *stream() {
        attempts += 1;
        yield { kind: 'text', chunk: 'partial ' };
        yield { kind: 'text', chunk: 'answer' };
        await new Promise((r) => { setTimeout(r, 200); });
        const live = await AgentDeltas.find({ sessionId: 's-retry-ids' }).fetchAsync();
        if (attempts === 1) {
          firstAttemptIds = [...new Set(live.map((d: any) => d.messageId))];
          const e: any = new Error('down'); e.status = 503; throw e;
        }
        secondAttemptDeltas = live;
        yield { kind: 'done', usage: { input: 1, output: 2 } };
      },
    };

    await runTurn('s-retry-ids', {
      model: 'mock', system: '', tools: [], provider: flaky,
      retry: { attempts: 2, baseMs: 10 },
    });

    assert.isAbove(firstAttemptIds.length, 0, 'attempt 1 should have streamed deltas');
    assert.isAbove(secondAttemptDeltas.length, 0, 'attempt 2 should have streamed deltas');
    const dead = new Set(firstAttemptIds);
    secondAttemptDeltas.forEach((d: any) => assert.isFalse(
      dead.has(d.messageId),
      'a retry must stream under a fresh messageId, or a straggler flush from '
      + 'the dead attempt lands under the live one',
    ));
    assert.equal(
      secondAttemptDeltas.filter((d: any) => dead.has(d.messageId)).length
      + (await AgentDeltas.find({ messageId: { $in: [...dead] } } as any).countAsync()),
      0, 'no delta from the failed attempt may survive',
    );
  });
});

describe('approval gates', () => {
  /**
   * Register an agent, seed a session for it, and run one turn whose first
   * provider response asks for `calls`. Registration is load-bearing: approve
   * and deny resume through the REGISTRY config, exactly as a real caller
   * would, so the tools and provider the method finds have to be the same
   * objects this fixture drives the initial park with.
   */
  const buildFixture = async (
    sessionId: string,
    agentName: string,
    calls: Array<{ id: string; name: string; gate: 'auto' | 'ask' }>,
    extra: Record<string, unknown> = {},
  ) => {
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    const state = { ran: [] as string[], providerCalls: 0 };
    const provider = mockProvider(() => {
      state.providerCalls += 1;
      return state.providerCalls === 1
        ? { toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: { amt: 5 } })) }
        : { text: 'all done' };
    });
    const tools = calls.map((c) => ({
      name: c.name,
      description: 'x',
      gate: c.gate,
      args: { type: 'object', properties: {} },
      run: async () => { state.ran.push(c.name); return { did: c.name }; },
    }));

    new Agent(agentName, {
      model: 'mock', instructions: '', tools, provider, ...extra,
    } as any);
    await seed(sessionId, 'refund please', agentName);
    await runTurn(sessionId, { model: 'mock', system: '', tools, provider });
    return state;
  };

  it('parks on an ask-gated tool: pending set, lease released, nothing dispatched', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { mockProvider } = await import('../server/providers/mock');

    await seed('s-gate', 'refund please');
    let toolRan = false;
    await runTurn('s-gate', {
      model: 'mock',
      system: '',
      tools: [{
        name: 'refund',
        description: 'x',
        gate: 'ask',
        args: { type: 'object', properties: {} },
        run: async () => { toolRan = true; return 'refunded'; },
      }],
      provider: mockProvider(() => ({ toolCalls: [{ id: 'g1', name: 'refund', args: { amt: 5 } }] })),
    });

    assert.isFalse(toolRan, 'an ask-gated tool must not run before a human answers');
    const doc = (await AgentSessions.findOneAsync('s-gate'))!;
    assert.equal(doc.phase, 'awaiting');
    assert.deepInclude(doc.pending as any, { toolCallId: 'g1', name: 'refund' });
    assert.isUndefined(doc.lease, 'a parked run holds no lease');

    // The assistant carrying the tool_use is COMMITTED — it is legitimate
    // history, and the thing the human is being asked to approve.
    const assistant = await AgentMessages.findOneAsync({ sessionId: 's-gate', role: 'assistant' });
    assert.isDefined(assistant);
    assert.isDefined(assistant!.toolCalls);
    assert.equal(assistant!.toolCalls![0].id, 'g1');
    // No result row: the batch is deliberately unanswered while parked.
    assert.equal(await AgentMessages.find({ sessionId: 's-gate', role: 'tool' }).countAsync(), 0);
  });

  it('approve wakes the run, executes the parked tool, and continues the turn', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-approve', 'gate-approve', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);
    assert.equal((await AgentSessions.findOneAsync('s-approve'))!.phase, 'awaiting');

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-approve', 's-approve');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-approve', role: 'assistant' }).countAsync()) === 2,
      'the resumed turn to produce a final assistant reply',
    );

    assert.deepEqual(state.ran, ['refund'], 'approval must run the tool exactly once');
    const msgs = await AgentMessages
      .find({ sessionId: 's-approve' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'no tool_use may be left stranded');

    const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
    assert.isDefined(row, 'the approved call must be answered');
    assert.isUndefined(row.error);
    assert.equal(row.content, JSON.stringify({ did: 'refund' }));

    const note = msgs.find((m) => m.role === 'note' && (m as any).kind === 'approval') as any;
    assert.isDefined(note, 'the verdict belongs in the transcript');
    assert.isTrue(note.approved);
    assert.equal(note.by, 'u1');
    assert.isUndefined(note.content, 'notes carry structured fields, not prose');

    const doc = (await AgentSessions.findOneAsync('s-approve'))!;
    assert.isUndefined(doc.pending, 'the marker must be cleared once resolved');
    assert.equal(doc.phase, 'idle');
    assert.equal(msgs[msgs.length - 1].content, 'all done');
  });

  it('deny writes a denied tool result the model can see, and continues', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-deny', 'gate-deny', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    const deny = (Meteor.server as any).method_handlers[NAMES.mDeny];
    await deny.call({ userId: 'u1' }, 'gate-deny', 's-deny', 'too large');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-deny', role: 'assistant' }).countAsync()) === 2,
      'the denied turn to continue rather than wedge',
    );

    assert.deepEqual(state.ran, [], 'a denied tool must never run');
    const msgs = await AgentMessages
      .find({ sessionId: 's-deny' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), []);

    const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
    assert.isDefined(row, 'the model must SEE the refusal, not just miss a result');
    assert.deepEqual(row.error, { error: 'denied', reason: 'too large' });
    assert.include(row.content!, 'denied');

    const note = msgs.find((m) => m.role === 'note' && (m as any).kind === 'approval') as any;
    assert.isFalse(note.approved);
    assert.equal(note.reason, 'too large');

    const doc = (await AgentSessions.findOneAsync('s-deny'))!;
    assert.isUndefined(doc.pending);
    assert.equal(msgs[msgs.length - 1].content, 'all done');
  });

  it('a parked run survives repair-on-entry untouched', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');
    const { getAgent } = await import('../server/registry');

    await buildFixture('s-park-repair', 'gate-repair', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);
    const config = getAgent('gate-repair')!;

    // Re-entering with no verdict is the recovering-server case: repair must
    // read `pending`/`awaiting` as legitimate history, not as an abandoned
    // turn, and the loop must exit still parked rather than re-streaming over
    // an unanswered tool_use.
    await runTurn('s-park-repair', {
      model: 'mock', system: '', tools: config.tools ?? [], provider: config.provider!,
    });

    const msgs = await AgentMessages
      .find({ sessionId: 's-park-repair' }, { sort: { seq: 1 } }).fetchAsync();
    const assistants = msgs.filter((m) => m.role === 'assistant');
    assert.lengthOf(assistants, 1, 'repair must not discard the parked assistant');
    assert.equal(assistants[0].toolCalls![0].id, 'g1');
    assert.deepEqual(
      unansweredToolUses(msgs), ['g1'],
      'the unanswered call is the REQUEST — it must survive until a human answers',
    );

    const doc = (await AgentSessions.findOneAsync('s-park-repair'))!;
    assert.equal(doc.phase, 'awaiting');
    assert.deepInclude(doc.pending as any, { toolCallId: 'g1' });
    assert.isUndefined((doc.pending as any).verdict);
    assert.isUndefined(doc.lease);
  });

  it('approving one call of a mixed batch still answers the auto-gated rest', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    // The park happens at call 1, so call 2 was never dispatched. Resuming
    // ONLY call 1 would leave `g2` a stranded tool_use — a permanent 400.
    const state = await buildFixture('s-batch-mixed', 'gate-mixed', [
      { id: 'g1', name: 'refund', gate: 'ask' },
      { id: 'g2', name: 'logit', gate: 'auto' },
    ]);
    assert.deepEqual(state.ran, [], 'the park precedes every dispatch in the batch');

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-mixed', 's-batch-mixed');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-batch-mixed', role: 'assistant' }).countAsync()) === 2,
      'the resumed batch to finish and the think loop to reply',
    );

    assert.deepEqual(state.ran, ['refund', 'logit'], 'the whole batch must run, in order');
    const msgs = await AgentMessages
      .find({ sessionId: 's-batch-mixed' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'the rest of the batch must be answered, not stranded',
    );
    assert.lengthOf(msgs.filter((m) => m.role === 'tool'), 2);
    assert.isUndefined((await AgentSessions.findOneAsync('s-batch-mixed'))!.pending);
    assert.equal(msgs[msgs.length - 1].content, 'all done');
  });

  it('approving one call of an all-gated batch parks again on the next gate', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-batch-gated', 'gate-both', [
      { id: 'g1', name: 'refund', gate: 'ask' },
      { id: 'g2', name: 'escalate', gate: 'ask' },
    ]);

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-both', 's-batch-gated');

    // Each remaining call is re-gated on its OWN declaration: approving g1
    // says nothing about g2.
    await waitFor(
      async () => {
        const s = await AgentSessions.findOneAsync('s-batch-gated');
        return (s?.pending as any)?.toolCallId === 'g2';
      },
      'the second gate to park',
    );

    assert.deepEqual(state.ran, ['refund'], 'only the approved call may run');
    let doc = (await AgentSessions.findOneAsync('s-batch-gated'))!;
    assert.equal(doc.phase, 'awaiting');
    assert.isUndefined((doc.pending as any).verdict, 'the re-park must carry no verdict');
    assert.isUndefined(doc.lease, 'the re-parked run holds no lease either');
    let msgs = await AgentMessages
      .find({ sessionId: 's-batch-gated' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), ['g2']);
    assert.lengthOf(msgs.filter((m) => m.role === 'assistant'), 1, 'the think loop must not run yet');

    // And the second verdict finishes the batch.
    await approve.call({ userId: 'u1' }, 'gate-both', 's-batch-gated');
    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-batch-gated', role: 'assistant' }).countAsync()) === 2,
      'the second approval to finish the batch and continue the turn',
    );

    assert.deepEqual(state.ran, ['refund', 'escalate']);
    msgs = await AgentMessages
      .find({ sessionId: 's-batch-gated' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'no stranded tool_use at any exit');
    doc = (await AgentSessions.findOneAsync('s-batch-gated'))!;
    assert.isUndefined(doc.pending);
    assert.lengthOf(msgs.filter((m) => m.role === 'note' && (m as any).kind === 'approval'), 2);
  });

  it('rejects approve and deny from a non-owner and from an anonymous caller', async function () {
    this.timeout(30000);
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    await buildFixture('s-auth', 'gate-auth', [{ id: 'g1', name: 'refund', gate: 'ask' }]);

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    const deny = (Meteor.server as any).method_handlers[NAMES.mDeny];
    const rejects = async (fn: () => Promise<unknown>, code: string, label: string) => {
      try { await fn(); } catch (e: any) {
        assert.equal(e.error, code, label);
        return;
      }
      assert.fail(`${label}: expected ${code}, but the call succeeded`);
    };

    await rejects(() => approve.call({ userId: 'u2' }, 'gate-auth', 's-auth'), 'no-session', 'approve as other user');
    await rejects(() => approve.call({ userId: null }, 'gate-auth', 's-auth'), 'no-session', 'approve as anonymous');
    await rejects(() => deny.call({ userId: 'u2' }, 'gate-auth', 's-auth', 'no'), 'no-session', 'deny as other user');
    await rejects(() => deny.call({ userId: null }, 'gate-auth', 's-auth', 'no'), 'no-session', 'deny as anonymous');
  });

  it('rejects approve when nothing is pending', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    new Agent('gate-nopending', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'unused' })),
    });
    await seed('s-nopending', 'hello', 'gate-nopending');

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    try {
      await approve.call({ userId: 'u1' }, 'gate-nopending', 's-nopending');
    } catch (e: any) {
      assert.equal(e.error, 'no-pending');
      return;
    }
    assert.fail('approving an idle session must not succeed');
  });

  it('lets exactly one of two racing approvers win', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-race-approve', 'gate-race', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    // Both callers read the parked state before either writes: the verdict
    // write is what has to break the tie, not the pre-check.
    const results = await Promise.allSettled([
      approve.call({ userId: 'u1' }, 'gate-race', 's-race-approve'),
      approve.call({ userId: 'u1' }, 'gate-race', 's-race-approve'),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.lengthOf(won, 1, 'exactly one approver may win');
    assert.lengthOf(lost, 1, 'the loser gets an error, never a silent success');
    assert.equal((lost[0] as PromiseRejectedResult).reason.error, 'no-pending');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-race-approve', role: 'assistant' }).countAsync()) === 2,
      'the single winning resume to finish',
    );
    assert.deepEqual(state.ran, ['refund'], 'a raced approval must not run the tool twice');
    const notes = await AgentMessages
      .find({ sessionId: 's-race-approve', role: 'note', kind: 'approval' } as any).countAsync();
    assert.equal(notes, 1, 'one verdict, one note');
  });

  it('refuses a caller that config.approve rejects', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture(
      's-notallowed', 'gate-notallowed',
      [{ id: 'g1', name: 'refund', gate: 'ask' }],
      { approve: async () => false },
    );

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    try {
      await approve.call({ userId: 'u1' }, 'gate-notallowed', 's-notallowed');
      assert.fail('config.approve returning false must block the verdict');
    } catch (e: any) {
      assert.equal(e.error, 'not-allowed');
    }

    assert.deepEqual(state.ran, [], 'a blocked approval must not run the tool');
    const doc = (await AgentSessions.findOneAsync('s-notallowed'))!;
    assert.equal(doc.phase, 'awaiting', 'the run must stay parked');
    assert.isUndefined((doc.pending as any).verdict);
    assert.equal(
      await AgentMessages.find({ sessionId: 's-notallowed', role: 'note' } as any).countAsync(), 0,
      'a refused verdict is not transcript history',
    );
  });

  it('answers an approved call whose tool is gone with the unknown-tool result', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-gone', 'gate-gone', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    // Redefine the agent WITHOUT the tool: a rename or a removal deployed
    // while the request sat on someone's screen. The gate declaration is what
    // parked the call, so the resume still owes it an answer — and a
    // `tool_use` left unanswered because a name moved is a permanent 400.
    new Agent('gate-gone', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'all done' })),
    });

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-gone', 's-gone');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-gone', role: 'assistant' }).countAsync()) === 2,
      'the resumed turn to close the batch and reply',
    );

    assert.deepEqual(state.ran, [], 'there is no tool left to run');
    const msgs = await AgentMessages
      .find({ sessionId: 's-gone' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'a vanished tool must not strand its call');
    const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
    assert.equal(row.error!.error, 'unknown-tool');
    assert.isUndefined((await AgentSessions.findOneAsync('s-gone'))!.pending);
  });

  it('an interrupt cancels the park, and the next send is answered not wedged', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-park-stop', 'gate-stop', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    const interrupt = (Meteor.server as any).method_handlers[NAMES.mInterrupt];
    await interrupt.call({ userId: 'u1' }, 'gate-stop', 's-park-stop');

    // The stop cancels the WAIT, not the record of what was asked.
    const stopped = (await AgentSessions.findOneAsync('s-park-stop'))!;
    assert.equal(stopped.phase, 'stopped');
    assert.deepInclude(stopped.pending as any, { toolCallId: 'g1' });

    // And a verdict is no longer answerable: approve/deny require 'awaiting'.
    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    try {
      await approve.call({ userId: 'u1' }, 'gate-stop', 's-park-stop');
      assert.fail('an interrupted park must not accept a verdict');
    } catch (e: any) {
      assert.equal(e.error, 'no-pending');
    }

    // The send clears the stop. The dead request must go with it — otherwise
    // its unanswered tool_use 400s every provider call from here on, and the
    // message the user just sent is never answered at all.
    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    await send.call({ userId: 'u1' }, 'gate-stop', 's-park-stop', 'never mind');

    await waitFor(
      async () => !!(await AgentMessages.findOneAsync({
        sessionId: 's-park-stop', role: 'assistant', content: 'all done',
      } as any)),
      'the send after an interrupted park to be answered',
    );

    assert.deepEqual(state.ran, [], 'a cancelled gate never runs its tool');
    const msgs = await AgentMessages
      .find({ sessionId: 's-park-stop' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'the cancelled request must not strand a call');
    assert.lengthOf(msgs.filter((m) => m.role === 'assistant'), 1, 'the dead turn was discarded');
    const doc = (await AgentSessions.findOneAsync('s-park-stop'))!;
    assert.isUndefined(doc.pending, 'the dead marker must not outlive the turn');
    assert.equal(doc.phase, 'idle');
  });

  it('resumes the parked turn, not an older one that reused the same call id', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // Tool call ids are unique only within ONE provider response — this repo's
    // own mock reuses `t1` on every turn. Turn 1 asked for `t1` and was
    // answered at seq 2; turn 2 asked for `t1` again and parked on a gate.
    // Locating the batch by "first assistant carrying this id" finds the OLD,
    // already-answered turn: the approval is silently voided (the tool never
    // runs, `pending` is cleared) while the real `tool_use` stays unanswered.
    await seed('s-locate', 'refund please');
    await AgentMessages.insertAsync({
      _id: 'old-a', sessionId: 's-locate', seq: 1, role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'refund', args: {} }], createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'old-tool', sessionId: 's-locate', seq: 2, role: 'tool', toolCallId: 't1',
      content: JSON.stringify({ did: 'an older refund' }), createdAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'parked-a', sessionId: 's-locate', seq: 3, role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'refund', args: { amt: 5 } }], createdAt: new Date(),
    } as any);
    // The state approve() leaves behind: verdict recorded, phase back to idle,
    // lease free — the parking run exited long ago.
    await AgentSessions.updateAsync('s-locate', {
      $set: {
        nextSeq: 4,
        phase: 'idle',
        pending: {
          toolCallId: 't1', name: 'refund', args: { amt: 5 },
          requestedAt: new Date(), verdict: 'approved', by: 'u1',
        },
      },
    } as any);

    const ran: string[] = [];
    await runTurn('s-locate', {
      model: 'mock', system: '',
      tools: [{
        name: 'refund', description: 'x', gate: 'ask',
        args: { type: 'object', properties: {} },
        run: async () => { ran.push('refund'); return { did: 'refund' }; },
      }],
      provider: mockProvider(() => ({ text: 'all done' })),
    });

    assert.deepEqual(ran, ['refund'], 'the approval must run the tool the PARKED turn asked for');
    const msgs = await AgentMessages
      .find({ sessionId: 's-locate' }, { sort: { seq: 1 } }).fetchAsync();
    assert.isDefined(msgs.find((m) => m._id === 'old-a'), "turn 1's assistant must survive");
    assert.isDefined(msgs.find((m) => m._id === 'old-tool'), "turn 1's answer must survive");
    assert.isDefined(
      msgs.find((m) => m._id === 'parked-a'),
      'the parked assistant IS the request being approved',
    );
    assert.isDefined(
      msgs.find((m) => m.role === 'tool' && m.toolCallId === 't1' && m.seq > 3),
      'the parked call must be answered inside ITS OWN window, not by turn 1',
    );
    assert.deepEqual(unansweredToolUses(msgs), []);
    assert.isUndefined((await AgentSessions.findOneAsync('s-locate'))!.pending);
  });

  it('a verdict landing while the parking run winds down still runs the tool', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');

    // approve/deny record a verdict and defer a resume. A verdict landing
    // between the park write and the parking run's releaseLease/running.delete
    // makes that deferred resume a no-op — it finds the session still running
    // in-process (or still leased, from another server) and returns, and
    // nothing retries. Residue: verdict recorded, phase idle, tool never ran,
    // UI says done. Here the verdict is written with NO defer at all, so the
    // ONLY thing that can pick it up is the winding-down run's own self-check.
    const original = (AgentSessions as any).updateAsync.bind(AgentSessions);
    const descriptor = Object.getOwnPropertyDescriptor(AgentSessions, 'updateAsync');
    let injected = false;
    (AgentSessions as any).updateAsync = async (sel: any, mod: any, ...rest: any[]) => {
      const n = await original(sel, mod, ...rest);
      // The park is the only write that sets `pending`.
      if (!injected && mod?.$set?.pending) {
        injected = true;
        await AgentSessions.rawCollection().updateOne(
          { _id: 's-wake' } as any,
          { $set: { 'pending.verdict': 'approved', 'pending.by': 'u1', phase: 'idle' } } as any,
        );
      }
      return n;
    };

    let state: { ran: string[]; providerCalls: number } | null = null;
    try {
      state = await buildFixture('s-wake', 'gate-wake', [
        { id: 'g1', name: 'refund', gate: 'ask' },
      ]);
    } finally {
      if (descriptor) Object.defineProperty(AgentSessions, 'updateAsync', descriptor);
      else delete (AgentSessions as any).updateAsync;
    }
    assert.isTrue(injected, 'the verdict must have landed on the park write');

    await waitFor(
      async () => state!.ran.length === 1,
      'the winding-down run to notice the verdict and execute the approved tool',
    );

    assert.deepEqual(state!.ran, ['refund'], 'a dropped wake-up loses an approved tool');
    const msgs = await AgentMessages
      .find({ sessionId: 's-wake' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'the woken batch must close cleanly');
    const row = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'g1')!;
    assert.isDefined(row, 'the approved call must be answered');
    assert.isUndefined((await AgentSessions.findOneAsync('s-wake'))!.pending);
  });

  it('a stop outranks a recorded verdict, and the send that clears it resumes', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');
    const { runTurn } = await import('../server/loop');
    const { getAgent } = await import('../server/registry');

    const state = await buildFixture('s-stop-verdict', 'gate-stopverdict', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);
    const config = getAgent('gate-stopverdict')!;

    // Exactly what agent.approve writes, followed by an interrupt that lands
    // before the resumed run reaches the tool. Running it anyway is a real
    // side effect the user just cancelled — and dispatchCalls would then
    // discard the assistant AND the executed call's row, leaving a transcript
    // that says "approved" with no record it ever ran.
    await AgentSessions.updateAsync('s-stop-verdict', {
      $set: { 'pending.verdict': 'approved', 'pending.by': 'u1', phase: 'idle' },
    } as any);
    await AgentSessions.updateAsync('s-stop-verdict', {
      $set: { phase: 'stopped' },
    } as any);

    await runTurn('s-stop-verdict', {
      model: 'mock', system: '', tools: config.tools ?? [], provider: config.provider!,
    });

    assert.deepEqual(state.ran, [], 'a stop must cancel an approved tool that has not run yet');
    let doc = (await AgentSessions.findOneAsync('s-stop-verdict'))!;
    assert.equal(doc.phase, 'stopped', 'the interrupt is durable until a send clears it');
    assert.deepInclude(
      doc.pending as any, { toolCallId: 'g1', verdict: 'approved' },
      'the verdict must survive: it is what makes the next send resume this batch',
    );
    let msgs = await AgentMessages
      .find({ sessionId: 's-stop-verdict' }, { sort: { seq: 1 } }).fetchAsync();
    assert.lengthOf(msgs.filter((m) => m.role === 'tool'), 0, 'nothing ran, so nothing answered');
    assert.lengthOf(
      msgs.filter((m) => m.role === 'assistant'), 1,
      'the parked assistant must survive a refusal to run',
    );

    // The send clears the stop; the verdict is still standing, so the batch
    // resumes rather than stranding its tool_use.
    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    await send.call({ userId: 'u1' }, 'gate-stopverdict', 's-stop-verdict', 'go ahead');

    await waitFor(async () => state.ran.length === 1, 'the send to resume the approved call');
    msgs = await AgentMessages
      .find({ sessionId: 's-stop-verdict' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), [], 'the resumed batch must close cleanly');
    doc = (await AgentSessions.findOneAsync('s-stop-verdict'))!;
    assert.isUndefined(doc.pending, 'the spent verdict must be cleared');
  });

  it('a send while awaiting is queued, then answered once the verdict resumes', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    const state = await buildFixture('s-queue', 'gate-queue', [
      { id: 'g1', name: 'refund', gate: 'ask' },
    ]);

    // A send while awaiting does not cancel the approval and does not wake
    // anything: `agent.send` clears 'stopped'/'error' only, and the loop exits
    // on 'awaiting'. The message is QUEUED — and the think loop that runs after
    // the verdict is what has to answer it, or it sits there forever.
    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    await send.call({ userId: 'u1' }, 'gate-queue', 's-queue', 'and hurry');

    const parked = (await AgentSessions.findOneAsync('s-queue'))!;
    assert.equal(parked.phase, 'awaiting', 'a send must not cancel a live approval request');
    assert.deepInclude(parked.pending as any, { toolCallId: 'g1' });
    assert.isUndefined((parked.pending as any).verdict, 'a send is not a verdict');
    assert.deepEqual(state.ran, [], 'and it must not run the gated tool either');

    const approve = (Meteor.server as any).method_handlers[NAMES.mApprove];
    await approve.call({ userId: 'u1' }, 'gate-queue', 's-queue');

    await waitFor(
      async () => (await AgentMessages
        .find({ sessionId: 's-queue', role: 'assistant' }).countAsync()) === 2,
      'the resumed turn to answer the queued message',
    );

    assert.deepEqual(state.ran, ['refund']);
    const msgs = await AgentMessages
      .find({ sessionId: 's-queue' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(unansweredToolUses(msgs), []);
    assert.lengthOf(
      msgs.filter((m) => m.role === 'user' && m.content === 'and hurry'), 1,
      'the queued message must be committed exactly once',
    );
    assert.equal(msgs[msgs.length - 1].role, 'assistant', 'and it must be ANSWERED, not just stored');
    assert.equal(msgs[msgs.length - 1].content, 'all done');
    assert.isUndefined((await AgentSessions.findOneAsync('s-queue'))!.pending);
  });

  it('a stop landing between the phase check and the park is not overwritten', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s-park-race', 'do both');
    let firstRan = false;
    let refundRan = false;
    let sabotaged = false;

    // The park write is the last thing a gated call does, and the phase it
    // acted on was read before the previous tool ran — a window as long as
    // that tool takes. Guarded on the lease alone, the park overwrites a
    // `stopped` that landed inside it: a cancelled turn resurrected as an
    // approval request that only approve/deny can ever clear. The stop is
    // injected immediately after the gated call's own phase check reads a
    // healthy phase, which is the only way into that window.
    const original = (AgentSessions as any).findOneAsync.bind(AgentSessions);
    const descriptor = Object.getOwnPropertyDescriptor(AgentSessions, 'findOneAsync');
    (AgentSessions as any).findOneAsync = async (sel: any, ...rest: any[]) => {
      const doc = await original(sel, ...rest);
      // `holdsLease` passes a selector OBJECT; the dispatch phase check passes
      // the bare id — so this fires on the phase check and nowhere else.
      if (firstRan && !sabotaged && sel === 's-park-race') {
        sabotaged = true;
        await AgentSessions.rawCollection().updateOne(
          { _id: 's-park-race' } as any, { $set: { phase: 'stopped' } } as any,
        );
      }
      return doc;
    };

    try {
      await runTurn('s-park-race', {
        model: 'mock', system: '',
        tools: [
          {
            name: 'logit', description: 'x', gate: 'auto',
            args: { type: 'object', properties: {} },
            run: async () => { firstRan = true; return 'logged'; },
          },
          {
            name: 'refund', description: 'x', gate: 'ask',
            args: { type: 'object', properties: {} },
            run: async () => { refundRan = true; return 'refunded'; },
          },
        ],
        provider: mockProvider(() => ({
          toolCalls: [
            { id: 'p1', name: 'logit', args: {} },
            { id: 'p2', name: 'refund', args: {} },
          ],
        })),
      });
    } finally {
      if (descriptor) Object.defineProperty(AgentSessions, 'findOneAsync', descriptor);
      else delete (AgentSessions as any).findOneAsync;
    }

    assert.isTrue(sabotaged, 'the stop must have landed inside the park window');
    assert.isFalse(refundRan, 'a gated tool never runs at the park itself');
    const doc = (await AgentSessions.findOneAsync('s-park-race'))!;
    assert.equal(doc.phase, 'stopped', 'the park must not overwrite an interrupt');
    assert.isUndefined(
      doc.pending, 'a cancelled turn must not leave an approval request standing',
    );
    const msgs = await AgentMessages
      .find({ sessionId: 's-park-race' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [], 'the abandoned batch must take its tool_use with it',
    );
    assert.equal(msgs[msgs.length - 1].role, 'user', 'transcript must stay resumable');
  });
});

describe('budgets', () => {
  it('refuses the send that would exceed the turn budget', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { NAMES } = await import('../common/names');
    const { Meteor } = await import('meteor/meteor');

    // DDPRateLimiter never sees a loop-initiated call, so the turn budget is
    // the only thing standing between a user and unbounded model spend.
    new Agent('budget-turns', {
      model: 'mock', instructions: '', tools: [],
      provider: mockProvider(() => ({ text: 'ok' })),
      budget: { turns: 1 },
    } as any);
    await seed('s-budget-turns', 'seeded', 'budget-turns');

    const send = (Meteor.server as any).method_handlers[NAMES.mSend];
    // `seed` commits a user row but spends nothing: mSend is what $incs
    // budgetSpent.turns, so this send is the one that exhausts a budget of 1.
    await send.call({ userId: 'u1' }, 'budget-turns', 's-budget-turns', 'first');
    await waitFor(
      async () => (await AgentSessions.findOneAsync('s-budget-turns'))!.phase === 'idle',
      'the first turn to finish',
    );
    assert.equal(
      (await AgentSessions.findOneAsync('s-budget-turns'))!.budgetSpent.turns, 1,
      'the allowed send must spend its turn',
    );

    try {
      await send.call({ userId: 'u1' }, 'budget-turns', 's-budget-turns', 'second');
      assert.fail('the send past the turn budget must be refused, not queued');
    } catch (e: any) {
      assert.equal(e.error, 'budget-exhausted');
    }

    const doc = (await AgentSessions.findOneAsync('s-budget-turns'))!;
    assert.equal(
      doc.budgetSpent.turns, 1,
      'a refused send must not spend the budget it was refused for',
    );
    assert.equal(
      await AgentMessages
        .find({ sessionId: 's-budget-turns', content: 'second' } as any).countAsync(), 0,
      'the refused message must not reach the transcript either',
    );
  });

  it('stops mid-turn when the tool-call budget trips, stranding no tool_use', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s-budget-tools', 'do both');
    const ran: string[] = [];
    let call = 0;

    await runTurn('s-budget-tools', {
      model: 'mock',
      system: '',
      budget: { toolCalls: 1 },
      tools: [
        {
          name: 'first', description: 'x', args: { type: 'object', properties: {} },
          run: async () => { ran.push('first'); return { did: 1 }; },
        },
        {
          name: 'second', description: 'x', args: { type: 'object', properties: {} },
          run: async () => { ran.push('second'); return { did: 2 }; },
        },
      ],
      provider: mockProvider(() => {
        call += 1;
        return call === 1
          ? {
            toolCalls: [
              { id: 'b1', name: 'first', args: {} },
              { id: 'b2', name: 'second', args: {} },
            ],
          }
          : { text: 'unreachable' };
      }),
    });

    assert.deepEqual(ran, ['first'], 'the check is BEFORE the spend: the limit stops call two');
    assert.equal(call, 1, 'a tripped budget must not go round the think loop again');

    const msgs = await AgentMessages
      .find({ sessionId: 's-budget-tools' }, { sort: { seq: 1 } }).fetchAsync();
    assert.deepEqual(
      unansweredToolUses(msgs), [],
      'a budget trip must discard the in-flight turn exactly as an interrupt does',
    );
    assert.lengthOf(
      msgs.filter((m) => m.role === 'assistant'), 0,
      'the half-answered assistant must go with the batch it can no longer finish',
    );
    assert.equal(
      msgs.filter((m) => m.role !== 'note').pop()!.role, 'user',
      'the discarded turn must leave the transcript resumable',
    );

    const note = msgs.find((m) => m.role === 'note' && m.kind === 'budget') as any;
    assert.isDefined(note, 'a tripped budget is transcript history, not a silent stop');
    assert.equal(note.budget, 'toolCalls');
    assert.deepEqual(note.error, { error: 'budget-exhausted', reason: 'Tool-call budget reached.' });
    assert.isUndefined(note.content, 'notes carry structured fields, not prose');

    const doc = (await AgentSessions.findOneAsync('s-budget-tools'))!;
    assert.equal(doc.phase, 'stopped');
    assert.equal(
      doc.budgetSpent.toolCalls, 1,
      'the discarded result still cost a real side effect — the spend stands',
    );
  });

  it('refuses the next turn once the spend budget is crossed, before any provider call', async function () {
    this.timeout(30000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s-budget-spend', 'hello');
    // Just under a one-cent cap. No cost is reported by this provider, so the
    // configured pricing is what has to move `usage.cost` past the line.
    await AgentSessions.updateAsync('s-budget-spend', {
      $set: { 'usage.cost': 0.009 },
    } as any);

    let calls = 0;
    const spender: Provider = {
      async *stream() {
        calls += 1;
        yield { kind: 'text', chunk: 'spending' };
        yield { kind: 'done', usage: { input: 2000, output: 0 } };
      },
    };
    const config = {
      model: 'mock', system: '', tools: [], provider: spender,
      pricing: { input: 1, output: 1 },
      budget: { spend: 0.01 },
    };

    await runTurn('s-budget-spend', config);
    assert.equal(
      calls, 1,
      'the check is before the spend, so the turn that CROSSES the cap still runs',
    );
    let doc = (await AgentSessions.findOneAsync('s-budget-spend'))!;
    assert.closeTo(doc.usage.cost, 0.011, 1e-9, 'cost must accrue through the commit $inc');
    assert.equal(doc.phase, 'idle', 'crossing is not tripping');
    assert.equal(
      await AgentMessages
        .find({ sessionId: 's-budget-spend', role: 'note' } as any).countAsync(), 0,
    );

    await runTurn('s-budget-spend', config);
    assert.equal(calls, 1, 'the next turn must refuse BEFORE it calls the provider');
    const note = await AgentMessages.findOneAsync({
      sessionId: 's-budget-spend', role: 'note', kind: 'budget',
    } as any) as any;
    assert.isDefined(note, 'the refusal must be visible in the transcript');
    assert.equal(note.budget, 'spend');
    assert.deepEqual(note.error, { error: 'budget-exhausted', reason: 'Spend budget reached.' });
    doc = (await AgentSessions.findOneAsync('s-budget-spend'))!;
    assert.equal(doc.phase, 'stopped');
    assert.lengthOf(
      await AgentMessages
        .find({ sessionId: 's-budget-spend', role: 'assistant' }).fetchAsync(), 1,
      'the refused turn commits nothing of its own',
    );
  });

  it('prefers a provider-reported cost over the pricing computation', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { runTurn } = await import('../server/loop');

    await seed('s-cost-reported', 'hello');
    // pi-ai computes its own cost and reports it on the done event, including
    // the cacheRead/cacheWrite tokens a two-rate input/output table cannot
    // see. Where the provider has priced the call, its number wins.
    const reporting: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'x' };
        yield { kind: 'done', usage: { input: 1000, output: 1000, cost: 0.05 } };
      },
    };

    await runTurn('s-cost-reported', {
      model: 'mock', system: '', tools: [], provider: reporting,
      pricing: { input: 1, output: 1 },   // would compute 0.002
    });

    const doc = (await AgentSessions.findOneAsync('s-cost-reported'))!;
    assert.closeTo(
      doc.usage.cost, 0.05, 1e-9,
      'the provider knows what it charged better than a two-rate table does',
    );
  });

  it('computes cost from pricing when none is reported, and accrues zero with neither', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    // mockProvider is deliberately cost-free, which is what makes it the
    // fixture for the fallback path.
    await seed('s-cost-priced', 'hello');
    await runTurn('s-cost-priced', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'hi', usage: { input: 1000, output: 2000 } })),
      pricing: { input: 3, output: 15 },   // $ per million tokens
    });
    const priced = (await AgentSessions.findOneAsync('s-cost-priced'))!;
    assert.closeTo(priced.usage.cost, 0.033, 1e-9, '(1000*3 + 2000*15) / 1e6');
    assert.equal(priced.usage.input, 1000);
    assert.equal(priced.usage.output, 2000);

    await seed('s-cost-free', 'hello');
    await runTurn('s-cost-free', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'hi', usage: { input: 1000, output: 2000 } })),
    });
    assert.equal(
      (await AgentSessions.findOneAsync('s-cost-free'))!.usage.cost, 0,
      'no reported cost and no pricing accrues nothing — never a guess',
    );
  });
});

describe('parseSpend()', () => {
  it('accepts a dollar string or a plain number and rejects anything else', async () => {
    const { parseSpend } = await import('../server/registry');
    assert.equal(parseSpend('$1.50'), 1.5);
    assert.equal(parseSpend(2), 2);
    assert.equal(parseSpend('0.25'), 0.25);
    assert.equal(parseSpend('$0'), 0);
    assert.throws(() => parseSpend('a dollar fifty'), /spend/);
    assert.throws(() => parseSpend('$'), /spend/);
    assert.throws(() => parseSpend('1.5 USD'), /spend/);
    assert.throws(() => parseSpend(Number.NaN), /spend/);
    assert.throws(() => parseSpend(-1), /spend/);
  });

  it('rejects a malformed spend at define() time, not mid-turn', async () => {
    const { Agent } = await import('../server/agent');
    // A config error is a STARTUP error. Deferring it to the first turn means
    // the app boots green and the only brake on loop-initiated work fails
    // open, in production, under load.
    assert.throws(
      () => new Agent('budget-malformed', {
        model: 'mock', instructions: '', tools: [], budget: { spend: 'lots' },
      } as any),
      /spend/,
    );
  });
});

describe('classifyProviderError()', () => {
  it('lets an adapter hint outrank the status, and defaults to retryable', async () => {
    const { classifyProviderError } = await import('../server/loop');
    // An adapter that classified the error itself (pi-ai's own transient
    // taxonomy) knows more than the status line, in BOTH directions.
    assert.equal(classifyProviderError({ retryable: false, status: 503 }), 'fatal');
    assert.equal(classifyProviderError({ retryable: true, status: 401 }), 'retryable');
    // 408 is a timeout, but the current table treats the whole 4xx range as
    // fatal. Pinned deliberately: change the table, change this line.
    assert.equal(classifyProviderError({ status: 408 }), 'fatal');
    // Unclassifiable (a socket hang-up, a DNS blip) retries — bounded anyway.
    assert.equal(classifyProviderError({}), 'retryable');
  });
});
