import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { NAMES } from '../common/names';

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

  it('rejects when agent_deltas exists but is not capped', async function () {
    this.timeout(20000);
    const { ensureCapped } = await import('../server/capped');
    const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;

    try {
      await db.collection(NAMES.deltas).drop();
    } catch { /* absent */ }
    await db.createCollection(NAMES.deltas); // normal (uncapped) collection

    try {
      let threw: any;
      try {
        await ensureCapped();
      } catch (e) {
        threw = e;
      }
      assert.isDefined(threw, 'ensureCapped() must reject for an uncapped existing collection');
      assert.include(threw.message, NAMES.deltas);
    } finally {
      // Recreate it capped so later tests in this run (other files also use
      // agent_deltas) don't inherit an uncapped collection.
      await db.collection(NAMES.deltas).drop();
      await ensureCapped();
    }
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

  it('publishes nothing from agent.sessions to an anonymous caller', async () => {
    const { registerPublications } = await import('../server/publications');
    registerPublications();
    const { AgentSessions } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    // Two ANONYMOUS sessions exist. userId: null matches every anonymous
    // caller equally, so publishing them would let any logged-out browser
    // enumerate other visitors' session ids — each of which unlocks the full
    // transcript and send/interrupt. Anonymous sessions are capability-URLs;
    // the capability model only holds if ids never leak in bulk.
    const base = {
      agent: 'support', phase: 'idle' as const, model: 'mock', nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    };
    await AgentSessions.insertAsync({ ...base, _id: 'anon-1', userId: null } as any);
    await AgentSessions.insertAsync({ ...base, _id: 'anon-2', userId: null } as any);

    const handler = (Meteor.server as any).publish_handlers['agent.sessions'];
    const result = handler.call({ userId: null }, 'support');
    // Empty array = publish nothing (and mark ready); a cursor would enumerate.
    assert.isArray(result);
    assert.lengthOf(result, 0);
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

  it('denies a non-owner of agent.session: publishes nothing', async () => {
    const { registerPublications } = await import('../server/publications');
    registerPublications();
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});

    const sessionId = 'idor-session';
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'idor-msg-1', sessionId, seq: 0, role: 'user', content: 'secret',
      createdAt: new Date(),
    } as any);
    await AgentDeltas.insertAsync({
      _id: 'idor-delta-1', sessionId, messageId: 'idor-msg-1', msgSeq: 0, seq: 0,
      kind: 'text', chunk: 'sec', at: new Date(),
    } as any);

    const handler = (Meteor.server as any).publish_handlers[NAMES.pubSession];
    const asOtherUser = await handler.call({ userId: 'u2' }, 'support', sessionId);
    assert.deepEqual(asOtherUser, []);
  });

  it('denies an unauthenticated caller of agent.session: publishes nothing', async () => {
    const { registerPublications } = await import('../server/publications');
    registerPublications();
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});

    const sessionId = 'idor-session-anon';
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'idor-msg-anon-1', sessionId, seq: 0, role: 'user', content: 'secret',
      createdAt: new Date(),
    } as any);
    await AgentDeltas.insertAsync({
      _id: 'idor-delta-anon-1', sessionId, messageId: 'idor-msg-anon-1', msgSeq: 0, seq: 0,
      kind: 'text', chunk: 'sec', at: new Date(),
    } as any);

    const handler = (Meteor.server as any).publish_handlers[NAMES.pubSession];
    const asAnonymous = await handler.call({ userId: null }, 'support', sessionId);
    assert.deepEqual(asAnonymous, []);
  });

  it('gives the owner of agent.session all three cursors, including the seeded message', async () => {
    const { registerPublications } = await import('../server/publications');
    registerPublications();
    const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});

    const sessionId = 'owner-session';
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'support', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: 'owner-msg-1', sessionId, seq: 0, role: 'user', content: 'hello',
      createdAt: new Date(),
    } as any);

    const handler = (Meteor.server as any).publish_handlers[NAMES.pubSession];
    const result = await handler.call({ userId: 'u1' }, 'support', sessionId);
    assert.equal(result.length, 3);

    const messages = await result[1].fetchAsync();
    assert.isTrue(messages.some((m: any) => m._id === 'owner-msg-1'));
  });
});
