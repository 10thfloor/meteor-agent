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
    await AgentSessions.insertAsync({
      ...base, _id: 'mine', userId: 'u1',
      lease: { serverId: 's1', until: new Date() },
    } as any);
    await AgentSessions.insertAsync({ ...base, _id: 'theirs', userId: 'u2' } as any);

    const handler = (Meteor.server as any).publish_handlers['agent.sessions'];
    const cursor = handler.call({ userId: 'u1' }, 'support');
    const docs = await cursor.fetchAsync();
    const ids = docs.map((d: any) => d._id);
    assert.deepEqual(ids, ['mine']);
    // Wire hygiene: `lease` is server-internal (server/lease.ts) and must
    // never reach the client, even though the doc above was seeded with one.
    assert.isUndefined(docs[0].lease, 'agent.sessions must not publish `lease`');
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
      // Set deliberately, so the assertion below proves the field is
      // stripped by the publication rather than merely absent from the doc.
      lease: { serverId: 's1', until: new Date() },
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

    // Wire hygiene: `lease` is server-internal (server/lease.ts) and must
    // never reach the client.
    const sessionDocs = await result[0].fetchAsync();
    assert.equal(sessionDocs.length, 1);
    assert.isUndefined(sessionDocs[0].lease, 'agent.session must not publish `lease`');
  });
});

describe('applyRateLimits', () => {
  it('adds nothing and does not throw when settings are absent', async () => {
    const { applyRateLimits } = await import('../server/rate-limits');
    assert.equal(applyRateLimits(undefined), 0);
    assert.equal(applyRateLimits({}), 0);
    assert.equal(applyRateLimits({ packages: {} }), 0);
  });

  it('adds a per-connection-pair rule AND a per-user rule per configured entry', async () => {
    // Two rules per entry is the design, not an accident: the (userId,
    // connectionId) pair rule isolates anonymous floods per connection, and
    // the authenticated-only per-user rule caps the multiply-your-limit-by-
    // opening-N-connections bypass the pair rule alone would allow.
    const { applyRateLimits } = await import('../server/rate-limits');
    const added = applyRateLimits({
      rateLimit: { sends: { count: 5, intervalMs: 60000 } },
    });
    assert.equal(added, 2);
  });

  it('adds four rules when both sends and starts are configured', async () => {
    const { applyRateLimits } = await import('../server/rate-limits');
    const added = applyRateLimits({
      rateLimit: {
        sends: { count: 5, intervalMs: 60000 },
        starts: { count: 3, intervalMs: 30000 },
      },
    });
    assert.equal(added, 4);
  });

  it('throws naming the field for a non-positive count', async () => {
    const { applyRateLimits } = await import('../server/rate-limits');
    let threw: any;
    try {
      applyRateLimits({ rateLimit: { sends: { count: 0, intervalMs: 60000 } } });
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'a non-positive count must throw');
    assert.include(threw.message, 'sends.count');
  });

  it('throws naming the field for a missing intervalMs', async () => {
    const { applyRateLimits } = await import('../server/rate-limits');
    let threw: any;
    try {
      applyRateLimits({ rateLimit: { starts: { count: 5 } as any } });
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'a missing intervalMs must throw');
    assert.include(threw.message, 'starts.intervalMs');
  });

  it('registers a rule that actually matches an agent.send method invocation', async () => {
    // DDPRateLimiter has no supported way to remove a rule or reset between
    // tests, and rules registered by earlier tests (or by server/index.ts's
    // own startup call) persist for the life of the process — so this
    // asserts the MATCH COUNT increased after our call, not that it is
    // exactly 1. `findAllMatchingRulesAsync` is the least-brittle entry
    // point available: unlike `_check`/`_increment`/`_checkRules` it carries
    // no leading underscore, so it is the one DDPRateLimiter internal that
    // reads as intentionally reusable rather than private, even though it
    // is not declared in the package's .d.ts (hence the `as any`).
    const { applyRateLimits } = await import('../server/rate-limits');
    const { DDPRateLimiter } = await import('meteor/ddp-rate-limiter');
    const input = {
      type: 'method', name: NAMES.mSend,
      userId: 'rl-user-1', connectionId: 'rl-conn-1', clientAddress: '127.0.0.1',
    };
    const unrelatedInput = { ...input, name: 'some.other.method' };
    const before = await (DDPRateLimiter as any).findAllMatchingRulesAsync(input);
    const unrelatedBefore = await (DDPRateLimiter as any).findAllMatchingRulesAsync(unrelatedInput);

    applyRateLimits({ rateLimit: { sends: { count: 1, intervalMs: 60000 } } });

    const after = await (DDPRateLimiter as any).findAllMatchingRulesAsync(input);
    assert.isAbove(
      after.length, before.length,
      'the newly-registered rule must match a real agent.send invocation',
    );

    // And it must NOT match an unrelated method name.
    const unrelatedAfter = await (DDPRateLimiter as any).findAllMatchingRulesAsync(unrelatedInput);
    assert.equal(
      unrelatedAfter.length, unrelatedBefore.length,
      'the rule must be scoped to agent.send, not every method',
    );
  });
});
