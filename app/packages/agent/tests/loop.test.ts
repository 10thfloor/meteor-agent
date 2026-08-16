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

const seed = async (sessionId: string, text: string) => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({});
  await AgentMessages.removeAsync({});
  await AgentDeltas.removeAsync({});
  await AgentSessions.insertAsync({
    _id: sessionId, agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
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
});
