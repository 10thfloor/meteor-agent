import { assert } from 'chai';

const base = {
  agent: 'support', userId: 'u1', phase: 'idle' as const, model: 'mock', nextSeq: 0,
  usage: { input: 0, output: 0, cost: 0 },
  budgetSpent: { turns: 0, toolCalls: 0 },
  createdAt: new Date(), updatedAt: new Date(),
};

describe('lease', () => {
  it('lets exactly one of two racing servers claim an orphaned run', async function () {
    this.timeout(60000);
    const { AgentSessions } = await import('../common/collections');
    const { claimLease } = await import('../server/lease');
    await AgentSessions.removeAsync({});

    let doubleClaims = 0;
    let zeroClaims = 0;
    for (let i = 0; i < 100; i += 1) {
      const _id = `s${i}`;
      await AgentSessions.insertAsync({
        ...base, _id,
        lease: { serverId: 'dead', until: new Date(Date.now() - 60000) },
      } as any);
      const [a, b] = await Promise.all([claimLease(_id, 'A'), claimLease(_id, 'B')]);
      const winners = [a, b].filter(Boolean).length;
      if (winners > 1) doubleClaims += 1;
      if (winners === 0) zeroClaims += 1;
    }
    assert.equal(doubleClaims, 0, 'two servers claimed the same run');
    assert.equal(zeroClaims, 0, 'nobody claimed an orphaned run');
  });

  it('refuses a claim on a live lease held by someone else', async () => {
    const { AgentSessions } = await import('../common/collections');
    const { claimLease } = await import('../server/lease');
    await AgentSessions.removeAsync({});
    await AgentSessions.insertAsync({
      ...base, _id: 'live',
      lease: { serverId: 'A', until: new Date(Date.now() + 30000) },
    } as any);
    assert.isFalse(await claimLease('live', 'B'));
    assert.isTrue(await claimLease('live', 'A'), 'the holder may renew');
  });

  it('rejects a guarded update from a server that lost the lease', async () => {
    const { AgentSessions } = await import('../common/collections');
    const { claimLease, guardedUpdate } = await import('../server/lease');
    await AgentSessions.removeAsync({});
    await AgentSessions.insertAsync({ ...base, _id: 'g1' } as any);

    assert.isTrue(await claimLease('g1', 'A'));
    assert.isTrue(await guardedUpdate('g1', 'A', { $set: { phase: 'streaming' } }));
    assert.isFalse(await guardedUpdate('g1', 'B', { $set: { phase: 'error' } }));

    const doc = await AgentSessions.findOneAsync('g1');
    assert.equal(doc!.phase, 'streaming');
  });

  it('releases a lease so another server can take it', async () => {
    const { AgentSessions } = await import('../common/collections');
    const { claimLease, releaseLease } = await import('../server/lease');
    await AgentSessions.removeAsync({});
    await AgentSessions.insertAsync({ ...base, _id: 'r1' } as any);
    await claimLease('r1', 'A');
    await releaseLease('r1', 'A');
    assert.isTrue(await claimLease('r1', 'B'));
  });
});
