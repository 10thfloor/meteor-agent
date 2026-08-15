import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';

describe('capped delta collection', () => {
  it('creates agent_deltas as capped and is idempotent', async function () {
    this.timeout(20000);
    const { ensureCapped } = await import('../server/capped');
    await ensureCapped();
    await ensureCapped(); // must not throw on second call

    const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
    const stats = await db.command({ collStats: 'agent_deltas' });
    assert.isTrue(stats.capped);
    assert.isAbove(stats.maxSize, 1024 * 1024);
  });

  it('evicts oldest documents when the cap is exceeded', async function () {
    this.timeout(30000);
    const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
    try { await db.collection('agent_deltas_probe').drop(); } catch { /* absent */ }
    await db.createCollection('agent_deltas_probe', { capped: true, size: 4096 });

    const coll = db.collection('agent_deltas_probe');
    const chunk = 'x'.repeat(200);
    for (let i = 0; i < 120; i += 1) {
      await coll.insertOne({ seq: i, chunk });
    }
    const surviving = await coll.countDocuments();
    assert.isBelow(surviving, 120, 'eviction should have occurred');

    const remaining = await coll.find({}).toArray();
    const seqs = remaining.map((d: any) => d.seq).sort((a: number, b: number) => a - b);
    assert.equal(seqs[seqs.length - 1], 119, 'the newest document must survive');
    assert.isAbove(seqs[0], 0, 'the head must be what was evicted');
  });
});

describe('publications', () => {
  it('registers both publication names', async () => {
    const { registerPublications } = await import('../server/publications');
    registerPublications();
    const handlers = (Meteor.server as any).publish_handlers;
    assert.isFunction(handlers['agent.session']);
    assert.isFunction(handlers['agent.sessions']);
  });

  it('scopes agent.sessions to the calling user', async () => {
    const { AgentSessions } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    const base = {
      agent: 'support', phase: 'idle' as const, model: 'mock', nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    };
    await AgentSessions.insertAsync({ ...base, _id: 'mine', userId: 'u1' } as any);
    await AgentSessions.insertAsync({ ...base, _id: 'theirs', userId: 'u2' } as any);

    const handler = (Meteor.server as any).publish_handlers['agent.sessions'];
    const cursor = handler.call({ userId: 'u1' }, 'support');
    const ids = (await cursor.fetchAsync()).map((d: any) => d._id);
    assert.deepEqual(ids, ['mine']);
  });
});
