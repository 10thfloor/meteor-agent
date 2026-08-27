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
  const waitFor = async (label: string, predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      // Mongo observers settle asynchronously after the update.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

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
      pendingInputs: [{ messageId: 'private-wake-link', seq: 0, at: new Date() }],
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
    assert.isUndefined(
      docs[0].pendingInputs,
      'agent.sessions must not publish `pendingInputs`',
    );
  });

  it('shelves an archived session from agent.sessions, and hands it back on request', async () => {
    const { AgentSessions } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    const base = {
      agent: 'support', userId: 'u1', phase: 'idle' as const, model: 'mock', nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    };
    await AgentSessions.insertAsync({ ...base, _id: 'active' } as any);
    await AgentSessions.insertAsync({ ...base, _id: 'shelved', archived: new Date() } as any);

    const handler = (Meteor.server as any).publish_handlers['agent.sessions'];
    const listed = await handler.call({ userId: 'u1' }, 'support').fetchAsync();
    assert.deepEqual(
      listed.map((d: any) => d._id), ['active'],
      'archived is a shelf for the LIST — the default enumeration omits it',
    );

    const all = await handler.call({ userId: 'u1' }, 'support', true).fetchAsync();
    assert.deepEqual(
      all.map((d: any) => d._id).sort(), ['active', 'shelved'],
      'and there is no second publication: the same one serves the shelf',
    );

    // The point of the separation. An archived session is still a session:
    // nothing in the turn path reads the field, so a routine on a clock or an
    // inbound message still reaches it. `agent.session` is that path's gate,
    // and it stays open — the handler is async, hence the await before the
    // cursors are anything to fetch from.
    const single = (Meteor.server as any).publish_handlers[NAMES.pubSession];
    const cursors = await single.call({ userId: 'u1' }, 'support', 'shelved');
    const served = await Promise.all(cursors.map((c: any) => c.fetchAsync()));
    assert.isAbove(
      served.flat().length, 0,
      'archiving must not make a session unreachable — only unlisted',
    );
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
      pendingInputs: [{ messageId: 'private-wake-link', seq: 0, at: new Date() }],
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
    assert.isUndefined(
      sessionDocs[0].pendingInputs,
      'agent.session must not publish `pendingInputs`',
    );
  });

  it('stops a live agent.session publication when a participant is removed', async () => {
    const { registerPublications } = await import('../server/publications');
    registerPublications();
    const { AgentSessions } = await import('../common/collections');
    await AgentSessions.removeAsync({});

    await AgentSessions.insertAsync({
      _id: 'revoked-member', agent: 'support', userId: 'owner', phase: 'idle', model: 'mock',
      nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      participants: [{
        id: 'h:member', kind: 'human', role: 'member', userId: 'member',
        displayName: 'Member', joinedAt: new Date(),
      }],
      createdAt: new Date(), updatedAt: new Date(),
    } as any);

    let stopped = false;
    const cleanups: Array<() => void> = [];
    const publication = {
      userId: 'member',
      onStop(fn: () => void) { cleanups.push(fn); },
      stop() {
        if (stopped) return;
        stopped = true;
        for (const fn of cleanups) fn();
      },
    };
    const handler = (Meteor.server as any).publish_handlers[NAMES.pubSession];
    const cursors = await handler.call(publication, 'support', 'revoked-member');
    assert.lengthOf(cursors, 3, 'membership authorizes the initial subscription');

    await AgentSessions.updateAsync('revoked-member', {
      $pull: { participants: { id: 'h:member' } },
    } as any);
    await waitFor('the publication to stop after membership removal', () => stopped);
  });

  it('stops a live anonymous publication when its capability session is claimed', async () => {
    const { AgentSessions } = await import('../common/collections');
    await AgentSessions.removeAsync({});
    await AgentSessions.insertAsync({
      _id: 'claimed-anon', agent: 'support', userId: null, phase: 'idle', model: 'mock',
      nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);

    let stopped = false;
    const cleanups: Array<() => void> = [];
    const publication = {
      userId: null,
      onStop(fn: () => void) { cleanups.push(fn); },
      stop() {
        if (stopped) return;
        stopped = true;
        for (const fn of cleanups) fn();
      },
    };
    const handler = (Meteor.server as any).publish_handlers[NAMES.pubSession];
    const cursors = await handler.call(publication, 'support', 'claimed-anon');
    assert.lengthOf(cursors, 3, 'the capability authorizes the initial subscription');

    await AgentSessions.updateAsync('claimed-anon', { $set: { userId: 'new-owner' } });
    await waitFor('the publication to stop after claim', () => stopped);
  });
});

/**
 * WHY EVERY `count` BELOW IS ABSURDLY LARGE.
 *
 * These fixtures register REAL `DDPRateLimiter` rules, and DDPRateLimiter has
 * no supported way to remove a rule or reset its counters — so every rule
 * added here is live against `agent.start`, `agent.send`, `agent.fork` and
 * `agent.interrupt` for the rest of the process, and the effective limit on a
 * method is the TIGHTEST rule matching it. The browser-side tests
 * (`integration.client.ts`, `element.client.ts`) are the only tests whose
 * calls actually pass through the limiter (server-side tests invoke method
 * handlers directly), and they all share one DDP connection, hence one
 * counter. A `count: 1` fixture therefore used to cap the ENTIRE client suite
 * at one send per minute, failing with `too-many-requests` in a way that looks
 * like a harness flake and has nothing to do with the code under test.
 *
 * Nothing in this suite asserts on the count VALUE — only on how many rules
 * were added, and on which method invocations they match — so the headroom is
 * free. Keep it: raise these numbers rather than rationing calls in the
 * browser half. The deliberately INVALID entries (count 0, intervalMs 0, a
 * missing intervalMs) stay exactly as they are; they must still throw.
 */
const HEADROOM = 200;

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
      rateLimit: { sends: { count: HEADROOM, intervalMs: 60000 } },
    });
    assert.equal(added, 2);
  });

  it('adds six rules when both sends and starts are configured', async () => {
    // Two per method, and `starts` governs TWO methods: `agent.start` and
    // `agent.fork`. A fork creates a session exactly as a start does (and
    // copies a transcript on top), so it shares the session-creation budget
    // rather than getting a cheaper knob of its own.
    const { applyRateLimits } = await import('../server/rate-limits');
    const added = applyRateLimits({
      rateLimit: {
        sends: { count: HEADROOM, intervalMs: 60000 },
        starts: { count: HEADROOM, intervalMs: 30000 },
      },
    });
    assert.equal(added, 6);
  });

  it('a starts entry registers rules for agent.fork as well as agent.start', async () => {
    // The pairing is load-bearing, not incidental: forks are session creation,
    // and an unlimited `agent.fork` would be the cheap way to do the thing a
    // `starts` limit refuses — one call per copy of an entire transcript.
    const { applyRateLimits } = await import('../server/rate-limits');
    const { DDPRateLimiter } = await import('meteor/ddp-rate-limiter');
    const input = {
      type: 'method', name: NAMES.mFork,
      userId: 'rl-user-fork', connectionId: 'rl-conn-fork', clientAddress: '127.0.0.1',
    };
    const before = await (DDPRateLimiter as any).findAllMatchingRulesAsync(input);
    applyRateLimits({ rateLimit: { starts: { count: HEADROOM, intervalMs: 60000 } } });
    const after = await (DDPRateLimiter as any).findAllMatchingRulesAsync(input);
    assert.isAbove(
      after.length, before.length,
      'a starts entry must register rules matching a real agent.fork invocation',
    );
  });

  it('adds eight rules when interrupts is configured alongside sends and starts', async () => {
    // `interrupts` gets the identical two-rule treatment, not a cheaper one:
    // it is an unauthenticated-reachable write, so the anonymous-isolation
    // pair rule and the per-user cap on multi-connection multiplication both
    // apply exactly as they do to sends.
    const { applyRateLimits } = await import('../server/rate-limits');
    const added = applyRateLimits({
      rateLimit: {
        sends: { count: HEADROOM, intervalMs: 60000 },
        starts: { count: HEADROOM, intervalMs: 30000 },
        interrupts: { count: HEADROOM, intervalMs: 10000 },
      },
    });
    assert.equal(added, 8);
  });

  it('registers a rule that actually matches an agent.interrupt invocation', async () => {
    // Same seam and the same caveat as the agent.send case below: rules are
    // never removable, so this asserts the match count INCREASED and that the
    // new rule is scoped to agent.interrupt rather than to every method.
    const { applyRateLimits } = await import('../server/rate-limits');
    const { DDPRateLimiter } = await import('meteor/ddp-rate-limiter');
    const input = {
      type: 'method', name: NAMES.mInterrupt,
      userId: 'rl-user-2', connectionId: 'rl-conn-2', clientAddress: '127.0.0.1',
    };
    const sendInput = { ...input, name: NAMES.mSend };
    const before = await (DDPRateLimiter as any).findAllMatchingRulesAsync(input);
    const sendBefore = await (DDPRateLimiter as any).findAllMatchingRulesAsync(sendInput);

    applyRateLimits({ rateLimit: { interrupts: { count: HEADROOM, intervalMs: 60000 } } });

    const after = await (DDPRateLimiter as any).findAllMatchingRulesAsync(input);
    assert.isAbove(
      after.length, before.length,
      'the newly-registered rule must match a real agent.interrupt invocation',
    );
    const sendAfter = await (DDPRateLimiter as any).findAllMatchingRulesAsync(sendInput);
    assert.equal(
      sendAfter.length, sendBefore.length,
      'an interrupts entry must not add rules to agent.send',
    );
  });

  it('adds twelve rules when approvals joins sends, starts and interrupts', async () => {
    // `approvals` is the second entry governing TWO methods: `agent.approve`
    // and `agent.deny` are the same decision made two ways, and separate knobs
    // would make `deny` the cheap way to hammer the path `approve` limits.
    // Two rules per method, so the entry adds four — 8 + 4.
    const { applyRateLimits } = await import('../server/rate-limits');
    const added = applyRateLimits({
      rateLimit: {
        sends: { count: HEADROOM, intervalMs: 60000 },
        starts: { count: HEADROOM, intervalMs: 30000 },
        interrupts: { count: HEADROOM, intervalMs: 10000 },
        approvals: { count: HEADROOM, intervalMs: 10000 },
      },
    });
    assert.equal(added, 12);
  });

  it('an approvals entry registers rules for BOTH agent.approve and agent.deny', async () => {
    const { applyRateLimits } = await import('../server/rate-limits');
    const { DDPRateLimiter } = await import('meteor/ddp-rate-limiter');
    const approveInput = {
      type: 'method', name: NAMES.mApprove,
      userId: 'rl-user-appr', connectionId: 'rl-conn-appr', clientAddress: '127.0.0.1',
    };
    const denyInput = { ...approveInput, name: NAMES.mDeny };
    const approveBefore = await (DDPRateLimiter as any).findAllMatchingRulesAsync(approveInput);
    const denyBefore = await (DDPRateLimiter as any).findAllMatchingRulesAsync(denyInput);

    applyRateLimits({ rateLimit: { approvals: { count: HEADROOM, intervalMs: 60000 } } });

    assert.isAbove(
      (await (DDPRateLimiter as any).findAllMatchingRulesAsync(approveInput)).length,
      approveBefore.length,
      'the entry must match a real agent.approve invocation',
    );
    assert.isAbove(
      (await (DDPRateLimiter as any).findAllMatchingRulesAsync(denyInput)).length,
      denyBefore.length,
      'and a real agent.deny one — one entry, both methods',
    );
  });

  it('adds fourteen rules when compacts joins the other four entries', async () => {
    // `compacts` governs ONE method, so it adds the plain two — 12 + 2. It gets
    // an entry of its own rather than sharing `sends` because both buy a
    // provider round trip but an operator tunes them apart: a compaction is
    // bookkeeping a UI fires rarely, a send is the product.
    const { applyRateLimits } = await import('../server/rate-limits');
    const added = applyRateLimits({
      rateLimit: {
        sends: { count: HEADROOM, intervalMs: 60000 },
        starts: { count: HEADROOM, intervalMs: 30000 },
        interrupts: { count: HEADROOM, intervalMs: 10000 },
        approvals: { count: HEADROOM, intervalMs: 10000 },
        compacts: { count: HEADROOM, intervalMs: 10000 },
      },
    });
    assert.equal(added, 14);
  });

  it('a compacts entry registers rules scoped to agent.compact', async () => {
    // The limit exists because `agent.compact` is the one method besides
    // `agent.send` whose every accepted call buys a provider round trip, with
    // no turn budget in front of it — so it must be its own rule, not a
    // side effect of some other entry.
    const { applyRateLimits } = await import('../server/rate-limits');
    const { DDPRateLimiter } = await import('meteor/ddp-rate-limiter');
    const input = {
      type: 'method', name: NAMES.mCompact,
      userId: 'rl-user-comp', connectionId: 'rl-conn-comp', clientAddress: '127.0.0.1',
    };
    const sendInput = { ...input, name: NAMES.mSend };
    const before = await (DDPRateLimiter as any).findAllMatchingRulesAsync(input);
    const sendBefore = await (DDPRateLimiter as any).findAllMatchingRulesAsync(sendInput);

    applyRateLimits({ rateLimit: { compacts: { count: HEADROOM, intervalMs: 60000 } } });

    assert.isAbove(
      (await (DDPRateLimiter as any).findAllMatchingRulesAsync(input)).length,
      before.length,
      'the entry must match a real agent.compact invocation',
    );
    assert.equal(
      (await (DDPRateLimiter as any).findAllMatchingRulesAsync(sendInput)).length,
      sendBefore.length,
      'a compacts entry must not add rules to agent.send',
    );
  });

  it('throws naming the field for a malformed compacts entry', async () => {
    const { applyRateLimits } = await import('../server/rate-limits');
    let threw: any;
    try {
      applyRateLimits({ rateLimit: { compacts: { count: 3, intervalMs: -1 } } });
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'a negative intervalMs must throw');
    assert.include(threw.message, 'compacts.intervalMs');
  });

  it('throws naming the field for a malformed approvals entry', async () => {
    const { applyRateLimits } = await import('../server/rate-limits');
    let threw: any;
    try {
      applyRateLimits({ rateLimit: { approvals: { count: -1, intervalMs: 60000 } } });
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'a negative count must throw');
    assert.include(threw.message, 'approvals.count');
  });

  it('throws naming the field for a malformed interrupts entry', async () => {
    const { applyRateLimits } = await import('../server/rate-limits');
    let threw: any;
    try {
      applyRateLimits({ rateLimit: { interrupts: { count: 4, intervalMs: 0 } } });
    } catch (e) {
      threw = e;
    }
    assert.isDefined(threw, 'a non-positive intervalMs must throw');
    assert.include(threw.message, 'interrupts.intervalMs');
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

    applyRateLimits({ rateLimit: { sends: { count: HEADROOM, intervalMs: 60000 } } });

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
