import { assert } from 'chai';
import type { AgentSession } from '../common/types';
import type { SystemTurnResult } from '../server/system-turn';
import {
  canned, clean, countRole, finished, seedSolo, settle, waitFor,
} from './system-turn-helpers';

/**
 * System turns, groups C and D of the matrix (system-turn spec §10):
 * IDEMPOTENCY and the STRAND, and the BUDGET.
 *
 * The two groups share a file because they share one mechanism. A key is only
 * idempotent because the park's `lastSystemKey` clause and the row's derived
 * `_id` are checked in the same conditional write the budget bound rides in,
 * and the budget is only honest because the counter is spent by the TURN'S
 * FIRST COMMIT rather than by the park — which is also what leaves a dropped
 * turn recoverable. C8 and D1 are two readings of that one decision.
 *
 * Every wait here ends on a TERMINAL state (`finished`), and every
 * assert-an-absence is preceded by `settle()`: the dispatch is
 * `Meteor.defer`red, so "nothing happened" is only meaningful after the thing
 * that would have happened had its chance to.
 */

type Ok = Extract<SystemTurnResult, { ok: true }>;
type Refused = Extract<SystemTurnResult, { ok: false }>;

/** Narrow a result to its success arm, failing with the whole object rather
 *  than `expected false to be true` when it is a refusal. */
const ok = (r: SystemTurnResult, label: string): Ok => {
  assert.isTrue(r.ok, `${label}: expected ok, got ${JSON.stringify(r)}`);
  return r as Ok;
};

const refused = (r: SystemTurnResult, label: string): Refused => {
  assert.isFalse(r.ok, `${label}: expected a refusal, got ${JSON.stringify(r)}`);
  return r as Refused;
};

/** The `budgetSpent.systemTurns` of a session, as the code reads it: an absent
 *  field is zero (it is optional precisely so no migration is needed). */
const spentSystemTurns = async (sessionId: string): Promise<number> => {
  const { AgentSessions } = await import('../common/collections');
  const doc = await AgentSessions.findOneAsync(sessionId);
  return doc?.budgetSpent.systemTurns ?? 0;
};

/**
 * Age a standing intent so the watcher's grace window has passed.
 *
 * Rewrites the WHOLE subdocument (token included) rather than the dotted path,
 * because the token is the consume's single-winner credential: an intent aged
 * by replacing it with a fresh one would be a different intent.
 */
const backdateIntent = async (sessionId: string, ms = 5000): Promise<void> => {
  const { AgentSessions } = await import('../common/collections');
  const doc = await AgentSessions.findOneAsync(sessionId);
  assert.isOk(doc?.pendingSystem, 'backdateIntent needs a standing intent');
  await AgentSessions.updateAsync(sessionId, {
    $set: {
      pendingSystem: { ...doc!.pendingSystem!, at: new Date(Date.now() - ms) },
    },
  });
};

/**
 * Sessions the watcher's CASE 6 sweep would pick up, by the same selector it
 * uses (`watcher.ts`, system-turn spec §4.6).
 *
 * MIRRORED, not imported — the sweep builds its selector inline. C5's whole
 * claim is that a crash between the park and the consume leaves a document
 * this shape matches, so the shape has to be stated somewhere the test can
 * read it. If `watcher.ts` ever changes the sweep's predicate, this copy must
 * change with it.
 */
const sweepCandidates = async (graceMs: number): Promise<AgentSession[]> => {
  const { AgentSessions } = await import('../common/collections');
  const { DECIDED_PHASES } = await import('../common/types');
  const now = new Date();
  return AgentSessions.find({
    pendingSystem: { $exists: true },
    phase: { $nin: DECIDED_PHASES },
    'pendingSystem.at': { $lt: new Date(now.getTime() - graceMs) },
    $or: [
      { lease: { $exists: false } },
      { lease: null },
      { 'lease.until': { $lt: now } },
    ],
  }).fetchAsync();
};

describe('system turns — idempotency, the strand, and the budget', () => {
  // A standing intent outlives its test: it is durable by design, and the
  // sweep in a LATER test would consume it against a session that test seeded.
  beforeEach(clean);
  after(clean);

  /* ── C — idempotency and the strand ────────────────────────────────────── */

  it('C1: the same key twice runs exactly once', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-c1', {
      model: 'mock', instructions: '', tools: [], provider: canned('c1 ran'),
    });
    await seedSolo('sbb-c1', 'stb-c1');

    const first = ok(
      await startSystemTurn('sbb-c1', 'review the overnight queue', { key: 'k-c1' }),
      'first firing',
    );
    assert.isTrue(first.ran, 'an idle session runs the intent immediately');
    await waitFor(() => finished('sbb-c1', 1), 'the first system turn to finish');

    // The scheduler's next tick, deriving the same key for the same slot.
    const replay = refused(
      await startSystemTurn('sbb-c1', 'review the overnight queue', { key: 'k-c1' }),
      'replay',
    );
    assert.equal(replay.reason, 'duplicate-key');

    await settle();
    assert.equal(await countRole('sbb-c1', 'system'), 1, 'one key, one system row');
    assert.equal(await countRole('sbb-c1', 'assistant'), 1, 'and one turn');
    const doc = (await AgentSessions.findOneAsync('sbb-c1'))!;
    assert.equal(doc.lastSystemKey, 'k-c1', 'the claimed slot is durable');
    assert.isUndefined(doc.pendingSystem, 'the turn that ran cleared its marker');
  });

  it('C2: two concurrent firings of the SAME key resolve to one, and neither rejects', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-c2', {
      model: 'mock', instructions: '', tools: [], provider: canned('c2 ran'),
    });
    await seedSolo('sbb-c2', 'stb-c2');

    // Two app servers ticking the same schedule at the same instant. The park
    // is ONE conditional write, so the loser must lose by being TOLD, not by
    // throwing: a scheduler that has to catch to find out is a scheduler that
    // will log an exception every tick.
    const settled = await Promise.allSettled([
      startSystemTurn('sbb-c2', 'the 06:30 review', { key: 'k-c2' }),
      startSystemTurn('sbb-c2', 'the 06:30 review', { key: 'k-c2' }),
    ]);
    assert.deepEqual(
      settled.map((s) => s.status), ['fulfilled', 'fulfilled'],
      'neither racer rejects — a refusal is a value',
    );

    const results = settled.map((s) => (s as PromiseFulfilledResult<SystemTurnResult>).value);
    assert.equal(
      results.filter((r) => r.ok).length, 1,
      `exactly one racer wins the slot: ${JSON.stringify(results)}`,
    );
    const loser = refused(results.find((r) => !r.ok)!, 'the losing racer');
    assert.oneOf(
      loser.reason, ['duplicate-key', 'intent-standing'],
      'the loser is refused for the slot it lost, not for something incidental',
    );

    await waitFor(() => finished('sbb-c2', 1), 'the one winning turn to finish');
    await settle();
    assert.equal(await countRole('sbb-c2', 'system'), 1, 'one row, whoever won');
    assert.equal(await countRole('sbb-c2', 'assistant'), 1);
    assert.equal(await spentSystemTurns('sbb-c2'), 1, 'and one turn billed');
  });

  it('C3: different keys both run', async function () {
    this.timeout(30000);
    const { AgentMessages } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');
    const { systemRowId } = await import('../server/system-turn');

    new Agent('stb-c3', {
      model: 'mock', instructions: '', tools: [], provider: canned('c3 ran'),
    });
    await seedSolo('sbb-c3', 'stb-c3');

    // Sequential, not concurrent, and that IS the semantics: one slot per
    // session (decision 9), so the second firing waits for the first to be
    // consumed rather than queueing behind it.
    ok(await startSystemTurn('sbb-c3', 'morning', { key: 'k-c3-a' }), 'key A');
    await waitFor(() => finished('sbb-c3', 1), 'the first system turn to finish');
    ok(await startSystemTurn('sbb-c3', 'evening', { key: 'k-c3-b' }), 'key B');
    await waitFor(() => finished('sbb-c3', 2), 'the second system turn to finish');

    assert.equal(await countRole('sbb-c3', 'system'), 2, 'two keys, two rows');
    assert.equal(await countRole('sbb-c3', 'assistant'), 2);
    assert.equal(await spentSystemTurns('sbb-c3'), 2, 'two turns, two charges');
    assert.isOk(
      await AgentMessages.findOneAsync(systemRowId('sbb-c3', 'k-c3-a')),
      'each key owns its own derived row id',
    );
    assert.isOk(await AgentMessages.findOneAsync(systemRowId('sbb-c3', 'k-c3-b')));
  });

  it('C4: no key still works, and claims no slot', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-c4', {
      model: 'mock', instructions: '', tools: [], provider: canned('c4 ran'),
    });
    await seedSolo('sbb-c4', 'stb-c4');

    // Idempotency is opt-in: a caller with nothing to replay — a webhook, a
    // manual "run it now" — should not have to invent a key.
    const res = ok(await startSystemTurn('sbb-c4', 'run it now'), 'keyless firing');
    assert.isTrue(res.ran);
    await waitFor(() => finished('sbb-c4', 1), 'the keyless system turn to finish');

    const doc = (await AgentSessions.findOneAsync('sbb-c4'))!;
    assert.isUndefined(doc.lastSystemKey, 'no key, no slot claimed');
    assert.equal(await countRole('sbb-c4', 'system'), 1);
    const sys = (await AgentMessages
      .find({ sessionId: 'sbb-c4', role: 'system' }).fetchAsync())[0];
    assert.match(
      sys._id, /^sys:sbb-c4:/,
      'the row id still derives — from the per-call token when there is no key',
    );
  });

  it('C5: a crash between the park and the consume leaves exactly what the sweep looks for', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');
    const { running } = await import('../server/turn-state');

    new Agent('stb-c5', {
      model: 'mock', instructions: '', tools: [], provider: canned('c5 ran'),
    });
    await seedSolo('sbb-c5', 'stb-c5');

    // The park succeeds and the consume declines — the session is already
    // running a turn in this process. Nothing else in the system knows this
    // intent exists, which is precisely the state a crashed process leaves.
    running.add('sbb-c5');
    try {
      const res = ok(await startSystemTurn('sbb-c5', 'stranded', { key: 'k-c5' }), 'park');
      assert.isFalse(res.ran, 'a busy session parks rather than running');
      await settle();
      assert.equal(await countRole('sbb-c5', 'system'), 0, 'nothing was materialized');
    } finally {
      running.delete('sbb-c5');
    }

    await backdateIntent('sbb-c5');
    const doc = (await AgentSessions.findOneAsync('sbb-c5'))!;
    assert.isOk(doc.pendingSystem, 'the intent stands');
    assert.equal(doc.pendingSystem!.key, 'k-c5', 'carrying the key its row will derive from');
    assert.equal(doc.budgetSpent.systemTurns ?? 0, 0, 'and unbilled');

    const candidates = await sweepCandidates(1000);
    assert.deepEqual(
      candidates.map((s) => s._id), ['sbb-c5'],
      'the stranded session is exactly what the watcher CASE 6 selector matches',
    );
  });

  it('C6: a replayed key can never write a second row, even once the slot has moved on', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');
    const { systemRowId } = await import('../server/system-turn');

    new Agent('stb-c6', {
      model: 'mock', instructions: '', tools: [], provider: canned('c6 ran'),
    });
    await seedSolo('sbb-c6', 'stb-c6');

    // Keys A, B, A — §6's "one slot deep, plus a permanent per-key row guard".
    // `lastSystemKey` has moved to B by the third firing, so the slot no longer
    // refuses A; the DERIVED `_id` is what refuses a second A row, and it needs
    // no index to do it.
    ok(await startSystemTurn('sbb-c6', 'slot A', { key: 'A' }), 'A');
    await waitFor(() => finished('sbb-c6', 1), 'A to finish');
    ok(await startSystemTurn('sbb-c6', 'slot B', { key: 'B' }), 'B');
    await waitFor(() => finished('sbb-c6', 2), 'B to finish');

    const replay = ok(await startSystemTurn('sbb-c6', 'slot A', { key: 'A' }), 'A replayed');
    assert.isTrue(replay.ran, 'the slot no longer refuses A, so this one parks and dispatches');
    await waitFor(() => finished('sbb-c6', 3), 'the replayed dispatch to finish');

    assert.equal(
      await countRole('sbb-c6', 'system'), 2,
      'two rows for three firings: the replay dispatched against the row A already had',
    );
    assert.equal(
      await AgentMessages.find({ _id: systemRowId('sbb-c6', 'A') }).countAsync(), 1,
      'the derived id is the permanent guard — one row per key, forever',
    );
    const doc = (await AgentSessions.findOneAsync('sbb-c6'))!;
    assert.equal(doc.lastSystemKey, 'A', 'the slot follows the last key claimed');
    assert.isUndefined(doc.pendingSystem, 'and the replayed intent was consumed');
    // Three turns ran, so three are billed — the row guard bounds ROWS, not
    // dispatches, and §6 says so. Stated here so it reads as the design.
    assert.equal(await spentSystemTurns('sbb-c6'), 3);
  });

  it('C7: a key is scoped to its session', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-c7', {
      model: 'mock', instructions: '', tools: [], provider: canned('c7 ran'),
    });
    await seedSolo('sbb-c7-one', 'stb-c7');
    await seedSolo('sbb-c7-two', 'stb-c7');

    // One routine firing across two sessions derives ONE key. Scoping it
    // globally would let the first session answering a schedule silence every
    // other session on it.
    ok(await startSystemTurn('sbb-c7-one', 'daily', { key: 'shared' }), 'session one');
    ok(await startSystemTurn('sbb-c7-two', 'daily', { key: 'shared' }), 'session two');
    await waitFor(() => finished('sbb-c7-one', 1), 'session one to finish');
    await waitFor(() => finished('sbb-c7-two', 1), 'session two to finish');

    assert.equal(await countRole('sbb-c7-one', 'system'), 1);
    assert.equal(await countRole('sbb-c7-two', 'system'), 1);
  });

  /**
   * C8 — THE BLOCKER'S REGRESSION TEST.
   *
   * The draft cleared `pendingSystem` and spent the budget in the consume's own
   * write, outside any turn. `deferTurn` is `Meteor.defer(() => runTurn(…))`
   * and `runTurn` returns SILENTLY when the session is already running in this
   * process or another server holds the lease — so a dispatched turn is dropped
   * with no crash, no error and no log. Under the draft that left the system
   * row stranded in the transcript with its budget spent and NOTHING able to
   * find it again: the marker it would have been found by was already gone.
   *
   * Both halves construct a real drop and then assert the three properties that
   * make the strand impossible: the marker still stands, the counter is
   * unspent, and the sweep recovers it.
   */

  it('C8: a dispatched turn that is silently dropped leaves the intent standing, unbilled, and sweepable', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurnWith, systemRowId } = await import('../server/system-turn');
    const { startWatcher } = await import('../server/watcher');

    new Agent('stb-c8-drop', {
      model: 'mock', instructions: '', tools: [], provider: canned('recovered'),
    });
    await seedSolo('sbb-c8-drop', 'stb-c8-drop');

    // A dispatcher that accepts the turn and never runs it. This is not a
    // contrivance — it is exactly what `deferTurn` LOOKS LIKE from the
    // consume's side when `runTurn` returns early, which the consume cannot
    // observe and must not depend on.
    let dispatched = 0;
    const dropped = () => { dispatched += 1; };
    const res = ok(
      await startSystemTurnWith(dropped, 'sbb-c8-drop', 'the dropped turn', { key: 'k-c8' }),
      'park + consume with a dropping dispatcher',
    );
    assert.isTrue(res.ran, 'the consume reports it dispatched — it cannot know better');
    assert.equal(dispatched, 1, 'and it really did dispatch');

    // The row was materialized. Under the draft this is the stranded row.
    assert.isOk(
      await AgentMessages.findOneAsync(systemRowId('sbb-c8-drop', 'k-c8')),
      'the consume materialized the row before dispatching',
    );
    await settle();
    assert.equal(await countRole('sbb-c8-drop', 'assistant'), 0, 'and no turn ran');

    const stranded = (await AgentSessions.findOneAsync('sbb-c8-drop'))!;
    assert.isOk(
      stranded.pendingSystem,
      '(a) the marker STANDS — only a turn\'s first commit may clear it',
    );
    assert.equal(
      stranded.budgetSpent.systemTurns ?? 0, 0,
      '(b) and the budget is UNSPENT — a turn that never ran is never billed',
    );

    // (c) recovery. The sweep finds it by the marker that was never cleared.
    await backdateIntent('sbb-c8-drop');
    const w = startWatcher({ sweepMs: 60, verdictGraceMs: 1000 });
    try {
      await waitFor(
        () => finished('sbb-c8-drop', 1),
        'the watcher to recover the dropped turn and run it',
      );
    } finally {
      await w.stop();
    }

    assert.equal(
      await countRole('sbb-c8-drop', 'system'), 1,
      'recovery re-used the materialized row rather than writing a second one',
    );
    const done = (await AgentSessions.findOneAsync('sbb-c8-drop'))!;
    assert.isUndefined(done.pendingSystem, 'the recovered turn\'s first commit cleared the marker');
    assert.equal(done.budgetSpent.systemTurns, 1, 'and billed it exactly once, when it ran');
    // The recovered turn ran through the watcher's real dispatcher
    // (`methods.deferTurn`), not this one.
    assert.equal(dispatched, 1, 'the dropping dispatcher was never called again');
  });

  it('C8: an intent parked while the session is already running is neither consumed nor billed, and the sweep recovers it', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');
    const { running } = await import('../server/turn-state');
    const { startWatcher } = await import('../server/watcher');

    new Agent('stb-c8-busy', {
      model: 'mock', instructions: '', tools: [], provider: canned('swept up'),
    });
    await seedSolo('sbb-c8-busy', 'stb-c8-busy');

    // The other half of the same drop: the in-process guard `runTurn` enforces
    // is read by the consume too, so nothing is written at all. A design that
    // cleared the marker at park time would have lost the intent HERE, before
    // it ever reached a row.
    running.add('sbb-c8-busy');
    try {
      const res = ok(
        await startSystemTurn('sbb-c8-busy', 'behind a live turn', { key: 'k-c8b' }),
        'park behind a running turn',
      );
      assert.isFalse(res.ran, 'the consume declines while a turn is running here');
      await settle();
      assert.equal(await countRole('sbb-c8-busy', 'system'), 0);
      assert.equal(await countRole('sbb-c8-busy', 'assistant'), 0);

      const parked = (await AgentSessions.findOneAsync('sbb-c8-busy'))!;
      assert.isOk(parked.pendingSystem, '(a) the marker stands');
      assert.equal(parked.budgetSpent.systemTurns ?? 0, 0, '(b) unbilled');
    } finally {
      running.delete('sbb-c8-busy');
    }

    await backdateIntent('sbb-c8-busy');
    const w = startWatcher({ sweepMs: 60, verdictGraceMs: 1000 });
    try {
      await waitFor(
        () => finished('sbb-c8-busy', 1),
        'the watcher to sweep the intent nobody consumed',
      );
    } finally {
      await w.stop();
    }

    assert.equal(await countRole('sbb-c8-busy', 'system'), 1, '(c) the sweep materialized it once');
    const done = (await AgentSessions.findOneAsync('sbb-c8-busy'))!;
    assert.isUndefined(done.pendingSystem);
    assert.equal(done.budgetSpent.systemTurns, 1);
  });

  /* ── D — budget ────────────────────────────────────────────────────────── */

  it('D1: a COMPLETED system turn increments systemTurns, and nothing else', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-d1', {
      model: 'mock', instructions: '', tools: [], provider: canned('d1 ran'),
    });
    await seedSolo('sbb-d1', 'stb-d1');

    ok(await startSystemTurn('sbb-d1', 'count me'), 'firing');
    // The charge rides the turn's FIRST COMMIT, not the park — so the wait has
    // to be for a FINISHED turn or this asserts on a counter mid-flight.
    await waitFor(() => finished('sbb-d1', 1), 'the system turn to finish');

    const doc = (await AgentSessions.findOneAsync('sbb-d1'))!;
    assert.equal(doc.budgetSpent.systemTurns, 1, 'the machine purse');
    assert.equal(doc.budgetSpent.turns, 0, 'never the human one');
    assert.equal(doc.budgetSpent.toolCalls, 0);
  });

  it('D1b: a TOOL-using system turn is billed once, not once per iteration', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { mockProvider } = await import('../server/providers/mock');
    const { startSystemTurn } = await import('../server/methods');

    // Every OTHER system-turn test drives a single-iteration provider
    // (tools: []), so the commit runs once and the bill is coincidentally
    // right. A real scheduled turn does tool work: the model asks for a tool,
    // the tool runs, the model answers — two commits, two trips through the
    // block that spends `budgetSpent.systemTurns`. This pins that the charge
    // is once PER TURN, the thing the per-iteration bug got wrong.
    const calls = { n: 0 };
    const provider = mockProvider(() => {
      calls.n += 1;
      return calls.n === 1
        ? { toolCalls: [{ id: 't1', name: 'peek', args: {} }] }
        : { text: 'done looking' };
    });
    new Agent('stb-d1b', {
      model: 'mock',
      instructions: '',
      tools: [{
        name: 'peek', description: 'x', args: { type: 'object', properties: {} },
        run: async () => ({ ok: true }),
      }],
      provider,
    } as any);
    await seedSolo('sbb-d1b', 'stb-d1b');

    ok(await startSystemTurn('sbb-d1b', 'look into it'), 'firing');
    // Two assistant rows: the tool-call round, then the answer.
    await waitFor(() => finished('sbb-d1b', 2), 'the tool-using system turn to finish');

    const doc = (await AgentSessions.findOneAsync('sbb-d1b'))!;
    assert.equal(doc.budgetSpent.systemTurns, 1, 'billed once for the whole turn, not per commit');
    assert.equal(doc.budgetSpent.toolCalls, 1, 'and the one tool call it made');
  });

  it('D2: a human send still increments only turns', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { sendToSession } = await import('../server/methods');

    new Agent('stb-d2', {
      model: 'mock', instructions: '', tools: [], provider: canned('d2 ran'),
    });
    await seedSolo('sbb-d2', 'stb-d2');

    await sendToSession('stb-d2', 'sbb-d2', 'hello', 'u1');
    await waitFor(() => finished('sbb-d2', 1), 'the human turn to finish');

    const doc = (await AgentSessions.findOneAsync('sbb-d2'))!;
    assert.equal(doc.budgetSpent.turns, 1);
    assert.isUndefined(
      doc.budgetSpent.systemTurns,
      'a session that has never run scheduled work has no systemTurns field at all',
    );
  });

  it('D3: a refused park costs nothing — no row, no seq, no slot, no clock', async function () {
    this.timeout(30000);
    const { AgentMessages, AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-d3', {
      model: 'mock', instructions: '', tools: [], budget: { systemTurns: 1 },
      provider: canned('never runs'),
    });
    // Already at the cap.
    await seedSolo('sbb-d3', 'stb-d3', {
      budgetSpent: { turns: 0, toolCalls: 0, systemTurns: 1 },
    });
    const before = (await AgentSessions.findOneAsync('sbb-d3'))!;

    const res = refused(
      await startSystemTurn('sbb-d3', 'over budget', { key: 'k-d3' }),
      'over-budget firing',
    );
    assert.equal(res.reason, 'budget-exhausted');

    await settle();
    const after = (await AgentSessions.findOneAsync('sbb-d3'))!;
    assert.equal(
      await AgentMessages.find({ sessionId: 'sbb-d3' }).countAsync(), 0,
      'a refusal writes no transcript row of any kind — not even a note (decision 6)',
    );
    assert.equal(after.nextSeq, before.nextSeq, 'and burns no seq');
    assert.deepEqual(after.budgetSpent, before.budgetSpent, 'and spends nothing');
    assert.isUndefined(after.pendingSystem, 'and parks nothing');
    assert.isUndefined(after.lastSystemKey, 'and does NOT claim the key it was refused for');
    assert.equal(
      after.updatedAt.getTime(), before.updatedAt.getTime(),
      'the whole park is one conditional write: a miss touches the document not at all',
    );
    assert.equal(after.phase, 'idle', 'a budget refusal is a refusal, not a stop');
  });

  it('D4: the two purses are independent in both directions', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { sendToSession, startSystemTurn } = await import('../server/methods');

    // (a) the HUMAN purse is empty; scheduled work still runs.
    new Agent('stb-d4-turns', {
      model: 'mock', instructions: '', tools: [], budget: { turns: 1 },
      provider: canned('d4a ran'),
    });
    await seedSolo('sbb-d4-turns', 'stb-d4-turns', {
      budgetSpent: { turns: 1, toolCalls: 0 },
    });
    ok(
      await startSystemTurn('sbb-d4-turns', 'the human budget is not mine'),
      'a spent turn budget must not refuse a system turn',
    );
    await waitFor(() => finished('sbb-d4-turns', 1), 'the system turn to finish');
    const a = (await AgentSessions.findOneAsync('sbb-d4-turns'))!;
    assert.equal(a.budgetSpent.turns, 1, 'the human purse is untouched');
    assert.equal(a.budgetSpent.systemTurns, 1);

    // (b) the MACHINE purse is empty; a person can still speak.
    new Agent('stb-d4-system', {
      model: 'mock', instructions: '', tools: [], budget: { systemTurns: 1 },
      provider: canned('d4b ran'),
    });
    await seedSolo('sbb-d4-system', 'stb-d4-system', {
      budgetSpent: { turns: 0, toolCalls: 0, systemTurns: 1 },
    });
    await sendToSession('stb-d4-system', 'sbb-d4-system', 'hello', 'u1');
    await waitFor(() => finished('sbb-d4-system', 1), 'the human turn to finish');
    const b = (await AgentSessions.findOneAsync('sbb-d4-system'))!;
    assert.equal(b.budgetSpent.turns, 1);
    assert.equal(b.budgetSpent.systemTurns, 1, 'the machine purse is untouched');
  });

  it('D5: N concurrent firings under systemTurns: 1 yield exactly one turn', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-d5', {
      model: 'mock', instructions: '', tools: [], budget: { systemTurns: 1 },
      provider: canned('d5 ran'),
    });
    await seedSolo('sbb-d5', 'stb-d5');

    // Distinct keys, so `lastSystemKey` cannot be what refuses them: the bound
    // is folded into the park's own selector, which makes check-and-park one
    // operation and a budget of N permit exactly N under any concurrency.
    const settled = await Promise.allSettled(
      [0, 1, 2, 3].map((i) => startSystemTurn('sbb-d5', `firing ${i}`, { key: `k-d5-${i}` })),
    );
    assert.deepEqual(
      settled.map((s) => s.status),
      ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
      'no racer rejects',
    );
    const results = settled.map((s) => (s as PromiseFulfilledResult<SystemTurnResult>).value);
    assert.equal(
      results.filter((r) => r.ok).length, 1,
      `exactly one park wins: ${JSON.stringify(results)}`,
    );
    results.filter((r) => !r.ok).forEach((r) => {
      assert.oneOf(
        (r as Refused).reason, ['intent-standing', 'budget-exhausted'],
        'the losers lose to the one slot or to the bound, and to nothing else',
      );
    });

    await waitFor(() => finished('sbb-d5', 1), 'the one permitted turn to finish');
    await settle();
    assert.equal(await countRole('sbb-d5', 'system'), 1);
    assert.equal(await countRole('sbb-d5', 'assistant'), 1);
    assert.equal(await spentSystemTurns('sbb-d5'), 1);
  });

  it('D6: a legacy session with NO systemTurns field is not refused', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-d6', {
      model: 'mock', instructions: '', tools: [], budget: { systemTurns: 2 },
      provider: canned('d6 ran'),
    });
    // EVERY session document written before this feature existed looks like
    // this. Mongo's comparison operators are type-bracketed, so a bare
    // `{ 'budgetSpent.systemTurns': { $lt: 2 } }` matches ZERO of them — every
    // system turn on every pre-existing session refused, silently, forever.
    await seedSolo('sbb-d6', 'stb-d6', { budgetSpent: { turns: 0, toolCalls: 0 } });
    const seeded = (await AgentSessions.findOneAsync('sbb-d6'))!;
    assert.notProperty(
      seeded.budgetSpent, 'systemTurns',
      'the fixture must actually lack the field, or this test stops testing the trap',
    );

    const res = ok(
      await startSystemTurn('sbb-d6', 'the migration trap', { key: 'k-d6' }),
      'a bounded budget against a legacy document',
    );
    assert.isTrue(res.ran);
    await waitFor(() => finished('sbb-d6', 1), 'the system turn to finish');
    assert.equal(await spentSystemTurns('sbb-d6'), 1, 'and the field materializes on the charge');
  });

  it('D7: the counter lands under the exact dotted path', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');

    new Agent('stb-d7', {
      model: 'mock', instructions: '', tools: [], provider: canned('d7 ran'),
    });
    await seedSolo('sbb-d7', 'stb-d7');
    ok(await startSystemTurn('sbb-d7', 'count me precisely'), 'firing');
    await waitFor(() => finished('sbb-d7', 1), 'the system turn to finish');

    const doc = (await AgentSessions.findOneAsync('sbb-d7'))!;
    // A `$inc` on a mistyped path does not fail — it CREATES the key. So the
    // assertion is the exact key set, not the value: `budgetSpent.systemTurn`
    // would leave `systemTurns` undefined at every consumer and a stray sibling
    // here, and a value-only check would pass for a `budgetSpent` clobbered
    // down to a single key.
    assert.deepEqual(
      Object.keys(doc.budgetSpent).sort(),
      ['systemTurns', 'toolCalls', 'turns'],
      'exactly the three counters, under exactly those names',
    );
    assert.equal(doc.budgetSpent.systemTurns, 1);
    assert.notProperty(doc, 'budgetSpent.systemTurns', 'and never as a literal top-level key');
  });

  it('D8: a fork inherits no system-turn spend', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { startSystemTurn } = await import('../server/methods');
    const { forkSession } = await import('../server/fork');

    new Agent('stb-d8', {
      model: 'mock', instructions: '', tools: [], provider: canned('d8 ran'),
    });
    await seedSolo('sbb-d8', 'stb-d8');
    ok(await startSystemTurn('sbb-d8', 'spend one'), 'firing');
    await waitFor(() => finished('sbb-d8', 1), 'the system turn to finish');
    assert.equal(await spentSystemTurns('sbb-d8'), 1);

    const forkId = await forkSession((await AgentSessions.findOneAsync('sbb-d8'))!);
    const fork = (await AgentSessions.findOneAsync(forkId))!;
    // A fork costs from the moment it runs, not from its parent's history —
    // the same rule `turns` and `toolCalls` already follow.
    assert.equal(fork.budgetSpent.systemTurns ?? 0, 0, 'the machine purse is fresh');
    assert.equal(fork.budgetSpent.turns, 0);
    assert.equal(fork.budgetSpent.toolCalls, 0);
    assert.equal(
      await spentSystemTurns('sbb-d8'), 1,
      'and the source keeps its own spend',
    );
  });

  it('D9: budget.systemTurns is validated at define time and survives into the resolved budget', async () => {
    const { Agent } = await import('../server/agent');
    const { getAgent, resolveBudget } = await import('../server/registry');

    // `assertCountLimit` rejects `<= 0` — "no scheduled work" is expressed by
    // not calling the primitive, not by a budget of zero (§6). This is the
    // FIRST of the three coordinated edits `registry.ts` needs.
    assert.throws(
      () => new Agent('stb-d9-zero', {
        model: 'mock', instructions: '', tools: [], budget: { systemTurns: 0 },
      }),
      /systemTurns/,
      'a zero system-turn budget must fail at startup, where an operator sees it',
    );
    assert.isUndefined(
      getAgent('stb-d9-zero'),
      'and validation runs BEFORE registration, so no half-usable agent is left behind',
    );
    assert.throws(
      () => new Agent('stb-d9-frac', {
        model: 'mock', instructions: '', tools: [], budget: { systemTurns: 1.5 },
      }),
      /systemTurns/,
    );

    // The THIRD edit, and the one nothing ties to the other two:
    // `resolveBudget`'s returned literal has no spread, so a key added to the
    // type and to the validator but not here validates at startup and is
    // `undefined` at every consumer — a cap that silently never applies.
    assert.equal(
      resolveBudget({ systemTurns: 3 })!.systemTurns, 3,
      'the resolved budget must actually carry the limit it validated',
    );
    assert.isUndefined(
      resolveBudget({ turns: 2 })!.systemTurns,
      'undefined in, undefined out — no budget is not a budget of zero',
    );
  });
});
