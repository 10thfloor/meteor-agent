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

    const deltas = await AgentDeltas.find({ sessionId: 's1' }).fetchAsync();
    assert.isAbove(deltas.length, 0, 'tokens should have streamed');
    assert.equal(deltas[0].msgSeq, msgs[1].seq, 'deltas must carry the future seq');

    // mergeView walks back only while seq decrements by exactly 1, so a gap —
    // or a seq assigned out of push order — silently truncates the render.
    const seqs = deltas.map((d) => d.seq).sort((a, b) => a - b);
    seqs.forEach((s, i) => assert.equal(s, i, 'delta seqs must be contiguous from 0'));
  });

  it('reconstructs the same text from deltas as it commits', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentDeltas } = await import('../common/collections');
    const { mergeView } = await import('../common/merge');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s2', 'hello');
    await runTurn('s2', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'streamed answer' })),
    });

    const deltas = await AgentDeltas.find({ sessionId: 's2' }).fetchAsync();
    const fromDeltas = mergeView([], deltas).map((m) => m.content).join('');
    const committed = await AgentMessages.findOneAsync({ sessionId: 's2', role: 'assistant' });
    assert.equal(fromDeltas, committed!.content);
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
});
