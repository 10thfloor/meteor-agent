import { Meteor } from 'meteor/meteor';
import { Mongo, MongoInternals } from 'meteor/mongo';
import { DDP } from 'meteor/ddp';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
}

// ─────────────────────────────────────────────────────────────────────────────
// S2 — Does DDP._CurrentMethodInvocation propagate userId across awaits?
// ─────────────────────────────────────────────────────────────────────────────

Meteor.methods({
  'spike.whoami'() {
    return this.userId;
  },
  async 'spike.whoamiAsync'() {
    await sleep(5);
    return this.userId;
  },
});

async function spikeS2() {
  const detail = {};

  // 2a. Which accessors actually exist on this release?
  detail.accessors = {
    _CurrentMethodInvocation: typeof DDP._CurrentMethodInvocation,
    _CurrentInvocation: typeof DDP._CurrentInvocation,
    _CurrentPublicationInvocation: typeof DDP._CurrentPublicationInvocation,
  };
  const EV = DDP._CurrentMethodInvocation || DDP._CurrentInvocation;
  if (!EV || typeof EV.withValue !== 'function') {
    return record('S2', 'DDP invocation context', false, {
      ...detail,
      fatal: 'no usable environment variable with withValue()',
    });
  }
  detail.usedAccessor = DDP._CurrentMethodInvocation ? '_CurrentMethodInvocation' : '_CurrentInvocation';

  // Meteor.userId() is contributed by accounts-base, NOT by core meteor. Read
  // through the environment variable so the result is independent of that.
  detail.meteorUserIdIsFunction = typeof Meteor.userId === 'function';
  const currentUserId = () =>
    typeof Meteor.userId === 'function' ? Meteor.userId() : EV.get()?.userId;

  // 2b. Does a PLAIN OBJECT work as an invocation, or is DDPCommon required?
  detail.plainObject = await EV.withValue({ userId: 'u-plain', isSimulation: false }, async () => {
    try {
      return { userIdFn: currentUserId(), fromEnv: EV.get()?.userId };
    } catch (e) {
      return { error: e.message };
    }
  });

  // 2c. Survives multiple awaits of different kinds (timer, Mongo, microtask)?
  const probe = new Mongo.Collection('spike_probe');
  detail.acrossAwaits = await EV.withValue({ userId: 'u-await', isSimulation: false }, async () => {
    const seen = [];
    seen.push(currentUserId());
    await sleep(10);
    seen.push(currentUserId());
    await probe.findOneAsync({ _id: 'nope' });
    seen.push(currentUserId());
    await Promise.resolve();
    seen.push(currentUserId());
    await Promise.all([sleep(5), sleep(1)]);
    seen.push(currentUserId());
    return seen;
  });

  // 2d. Does an UNMODIFIED Meteor method handler see this.userId when invoked
  //     from inside the wrapped context? (the tools-are-methods premise)
  detail.methodSync = await EV.withValue({ userId: 'u-method', isSimulation: false }, async () =>
    Meteor.callAsync('spike.whoami'),
  );
  detail.methodAsync = await EV.withValue({ userId: 'u-method-async', isSimulation: false }, async () =>
    Meteor.callAsync('spike.whoamiAsync'),
  );

  // 2e. Concurrency isolation — interleaved runs must not leak userId.
  const interleaved = await Promise.all(
    ['a', 'b', 'c', 'd'].map((u, i) =>
      EV.withValue({ userId: `u-${u}`, isSimulation: false }, async () => {
        await sleep(20 - i * 4);
        const mid = currentUserId();
        await sleep(i * 3);
        const viaMethod = await Meteor.callAsync('spike.whoamiAsync');
        return { expected: `u-${u}`, mid, viaMethod };
      }),
    ),
  );
  detail.interleaved = interleaved;

  const pass =
    detail.plainObject?.userIdFn === 'u-plain' &&
    detail.acrossAwaits.every((v) => v === 'u-await') &&
    detail.methodSync === 'u-method' &&
    detail.methodAsync === 'u-method-async' &&
    interleaved.every((r) => r.mid === r.expected && r.viaMethod === r.expected);

  record('S2', 'DDP invocation context across awaits', pass, detail);
}

// ─────────────────────────────────────────────────────────────────────────────
// S3 — Capped collection: does observeChangesAsync see eviction as `removed`?
// ─────────────────────────────────────────────────────────────────────────────

const Deltas = new Mongo.Collection('spike_deltas');

async function spikeS3() {
  const detail = {};
  const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;

  // Fresh capped collection, deliberately tiny so eviction happens fast.
  try {
    await db.collection('spike_deltas').drop();
  } catch (e) {
    /* did not exist */
  }
  await db.createCollection('spike_deltas', { capped: true, size: 4096 });
  const stats = await db.command({ collStats: 'spike_deltas' });
  detail.capped = stats.capped === true;
  detail.maxSize = stats.maxSize;

  // Raw MongoDB change stream — is eviction even IN the oplog?
  const rawEvents = [];
  const rawStream = db.collection('spike_deltas').watch([], { fullDocument: 'default' });
  rawStream.on('change', (c) => rawEvents.push(c.operationType));

  // Meteor's own observe path — this is what a publication uses.
  const meteorEvents = { added: 0, changed: 0, removed: 0 };
  const handle = await Deltas.find({}).observeChangesAsync({
    added: () => (meteorEvents.added += 1),
    changed: () => (meteorEvents.changed += 1),
    removed: () => (meteorEvents.removed += 1),
  });

  await sleep(300); // let both watchers attach

  // Overflow the cap several times over.
  const chunk = 'x'.repeat(200);
  for (let i = 0; i < 120; i += 1) {
    await Deltas.insertAsync({ sessionId: 's1', seq: i, kind: 'text', chunk, at: new Date() });
  }

  await sleep(1500); // let change streams catch up

  const surviving = await Deltas.find({}).countAsync();
  detail.inserted = 120;
  detail.surviving = surviving;
  detail.evicted = 120 - surviving;
  detail.meteorEvents = meteorEvents;
  detail.rawOperationTypes = rawEvents.reduce((acc, t) => {
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  await handle.stop();
  await rawStream.close();

  // The design assumes evicted docs disappear client-side. Two ways that can
  // hold: Mongo emits deletes, or Meteor reconciles some other way.
  detail.evictionVisibleToMeteor = meteorEvents.removed > 0;
  detail.evictionInOplog = (detail.rawOperationTypes.delete || 0) > 0;

  const pass = detail.capped && detail.evicted > 0 && detail.evictionVisibleToMeteor;
  record('S3', 'Capped collection eviction via observeChangesAsync', pass, detail);
}

// ─────────────────────────────────────────────────────────────────────────────
// S4 — Lease guard: exactly-once commit under two concurrent runners.
// ─────────────────────────────────────────────────────────────────────────────

const Sessions = new Mongo.Collection('spike_sessions');
const Messages = new Mongo.Collection('spike_messages');

async function claimLease(sessionId, serverId, now) {
  const n = await Sessions.updateAsync(
    {
      _id: sessionId,
      $or: [{ lease: null }, { 'lease.until': { $lt: now } }],
    },
    { $set: { lease: { serverId, until: new Date(now.getTime() + 30_000) } } },
  );
  return n === 1;
}

async function guardedCommit(sessionId, serverId, seq) {
  // The design's core claim: commits are conditional on still owning the lease.
  const n = await Sessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId },
    { $set: { updatedAt: new Date() } },
  );
  if (n !== 1) return false;
  await Messages.insertAsync({ sessionId, serverId, seq, role: 'assistant' });
  return true;
}

async function spikeS4() {
  const ITERATIONS = 200;
  const detail = { iterations: ITERATIONS };
  await Sessions.removeAsync({});
  await Messages.removeAsync({});

  let doubleClaims = 0;
  let zeroClaims = 0;
  let doubleCommits = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const sessionId = `s${i}`;
    // Start with an EXPIRED lease held by a third server — the orphan case.
    await Sessions.insertAsync({
      _id: sessionId,
      lease: { serverId: 'dead-server', until: new Date(Date.now() - 60_000) },
    });

    const now = new Date();
    const [aWon, bWon] = await Promise.all([
      claimLease(sessionId, 'A', now),
      claimLease(sessionId, 'B', now),
    ]);
    const winners = [aWon && 'A', bWon && 'B'].filter(Boolean);
    if (winners.length > 1) doubleClaims += 1;
    if (winners.length === 0) zeroClaims += 1;

    // Both runners now attempt to commit, believing they own the run.
    const [aCommit, bCommit] = await Promise.all([
      guardedCommit(sessionId, 'A', 1),
      guardedCommit(sessionId, 'B', 1),
    ]);
    if (aCommit && bCommit) doubleCommits += 1;
  }

  const totalMessages = await Messages.find({}).countAsync();
  detail.doubleClaims = doubleClaims;
  detail.zeroClaims = zeroClaims;
  detail.doubleCommits = doubleCommits;
  detail.totalMessages = totalMessages;
  detail.expectedMessages = ITERATIONS;

  const pass =
    doubleClaims === 0 && zeroClaims === 0 && doubleCommits === 0 && totalMessages === ITERATIONS;
  record('S4', 'Lease guard exactly-once commit', pass, detail);
}

// ─────────────────────────────────────────────────────────────────────────────

Meteor.startup(async () => {
  const run = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      record(name, `${name} (threw)`, false, { error: e.message, stack: e.stack?.split('\n')[1] });
    }
  };

  await run('S1', async () => {
    const { s1Report } = await import('./s1.js');
    const detail = s1Report();
    record('S1', 'pi-ai import under Meteor bundler', detail.rootResolved && detail.subpathResolved, detail);
  });
  await run('S1b', async () => {
    const { s1bReport } = await import('./s1b.js');
    const { ok, detail } = await s1bReport();
    record('S1b', 'pi-ai via new Function import() (fallback A)', ok, detail);
  });
  await run('S1c', async () => {
    const { s1cReport } = await import('./s1c.js');
    const { ok, detail } = await s1cReport();
    record('S1c', 'pi-ai via Node createRequire / .mjs shim (fallback B)', ok, detail);
  });
  await run('S2', spikeS2);
  await run('S2b', async () => {
    const { s2bReport } = await import('./s2b.js');
    const { detail } = await s2bReport();
    const plainObjectSufficient = detail.directWithPlainObject?.ok === true;
    record('S2b', 'Plain object vs DDPCommon.MethodInvocation', plainObjectSufficient, detail);
  });
  await run('S3', spikeS3);
  await run('S4', spikeS4);
  await run('S5', async () => {
    const { s5Report } = await import('./s5.js');
    const r = s5Report();
    record('S5', `Merge logic (${r.total} cases)`, r.pass, {
      total: r.total,
      failures: r.failures,
    });
  });

  console.log('\n__SPIKE_REPORT_BEGIN__');
  console.log(JSON.stringify(results, null, 2));
  console.log('__SPIKE_REPORT_END__');
  console.log('__SPIKES_DONE__');
});
