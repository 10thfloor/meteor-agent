import { assert } from 'chai';

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

  it('leaves the transcript resumable after an abandoned turn', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { mockProvider } = await import('../server/providers/mock');
    const { runTurn } = await import('../server/loop');

    await seed('s4', 'hello');
    // Another server steals the lease mid-turn.
    await AgentSessions.updateAsync('s4', {
      $set: { lease: { serverId: 'other', until: new Date(Date.now() + 60000) } },
    } as any);

    await runTurn('s4', {
      model: 'mock', system: '', tools: [],
      provider: mockProvider(() => ({ text: 'should not commit' })),
    });

    const msgs = await AgentMessages.find({ sessionId: 's4' }, { sort: { seq: 1 } }).fetchAsync();
    const last = msgs[msgs.length - 1];
    assert.equal(last.role, 'user', 'transcript must end in user or tool to be resumable');
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
