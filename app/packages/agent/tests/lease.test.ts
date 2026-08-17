import { assert } from 'chai';
import type { Provider } from '../server/providers/types';

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

  it('renews the lease via heartbeat during a turn that outlives one lease period', async function () {
    this.timeout(15000);
    const { AgentSessions, AgentMessages } = await import('../common/collections');
    const { _setLeaseTimings } = await import('../server/lease');
    const { runTurn } = await import('../server/loop');

    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentSessions.insertAsync({ ...base, _id: 'hb1' } as any);

    // Shrunk well below the ~1s paced turn below: the turn survives past one
    // lease period, and `lease.until` advances past its initial grant, ONLY
    // if `runTurn`'s heartbeat interval is actually firing and renewing it.
    // `LEASE_MS`/`HEARTBEAT_MS` are read at call time by `claimLease` and
    // `heartbeat` (both already do), so setting this BEFORE the turn starts
    // is enough — no loop.ts change needed.
    const previous = _setLeaseTimings({ leaseMs: 300, heartbeatMs: 80 });
    try {
      const paced: Provider = {
        async *stream() {
          for (const ch of 'paced response over one second!!') {
            yield { kind: 'text', chunk: ch };
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => { setTimeout(r, 30); });
          }
          yield { kind: 'done', usage: { input: 1, output: 32 } };
        },
      };

      // Sample `lease.until` throughout the turn rather than only at the end:
      // by the time the turn returns, the interesting mid-turn renewals are
      // long past and only the final value would be left to inspect.
      const samples: Date[] = [];
      const sampler = setInterval(() => {
        void AgentSessions.findOneAsync('hb1')
          .then((s) => { if (s?.lease?.until) samples.push(s.lease.until); })
          .catch(() => { /* sampling is best-effort */ });
      }, 20);

      try {
        await runTurn('hb1', { model: 'mock', system: '', tools: [], provider: paced });
      } finally {
        clearInterval(sampler);
      }

      assert.isAtLeast(samples.length, 2, 'must have sampled the lease while the turn was running');
      const first = samples[0].getTime();
      const last = Math.max(...samples.map((d) => d.getTime()));
      assert.isAbove(
        last, first,
        'lease.until must advance past its initial grant during the turn — nothing but the '
        + 'heartbeat renews it mid-turn, and the turn is paced to outlast one lease period',
      );

      const committed = await AgentMessages.findOneAsync({ sessionId: 'hb1', role: 'assistant' });
      assert.isDefined(committed, 'the turn must still commit normally');
      assert.equal(committed!.content, 'paced response over one second!!');
    } finally {
      _setLeaseTimings(previous);
    }
  });
});
