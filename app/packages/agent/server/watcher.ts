import { AgentMessages, AgentSessions } from '../common/collections';
import { ACTIVE_PHASES, DECIDED_PHASES, type AgentSession, type SessionInc } from '../common/types';
import type { SessionQuery } from '../common/db';
import { getAgent } from './registry';
import {
  consumeStandingIntent, deferResolvedTurn, recordTimeoutVerdict,
} from './methods';
import { isRunning } from './turn-state';

/** §4.3 Recovery watcher. Sweeps + observer catch four orphan shapes:
 *  (1) dead-server leases, (2) timed-out approvals, (3) dropped wakes,
 *  (4) orphaned children. Delegates to existing machinery; owns no repair logic. */

/** Phases where a turn should be running; unleased = orphan. */
export { ACTIVE_PHASES };

/** Shares `DECIDED_PHASES` with the loop's wake self-check so they cannot drift. */
const WAKE_EXCLUDED = DECIDED_PHASES;

export interface WatcherOptions {
  /** How often the sweep runs. Default 15s; tests lower it. */
  sweepMs?: number;
  /** Grace period before a standing verdict is treated as dropped (case 3).
   *  Prevents racing a legitimate resume. Default one sweep interval, min 1s. */
  verdictGraceMs?: number;
  /** Grace period before a child session is treated as orphaned (case 4).
   *  Covers the window between child creation and `activeChild` write. */
  relinkGraceMs?: number;
}

export interface Watcher {
  /** Tear down the observer AND the interval, awaiting whatever is in flight. */
  stop(): Promise<void>;
}

/** Mirrors `claimLease`'s $or so the watcher considers exactly what the claim will take. */
function noLiveLease(now: Date): SessionQuery {
  return {
    $or: [
      { lease: { $exists: false } },
      { lease: null },
      { 'lease.until': { $lt: now } },
    ],
  };
}

/** Same predicate as `noLiveLease`, in memory, for the observer path. */
function isOrphan(session: AgentSession, now: Date): boolean {
  if (!ACTIVE_PHASES.includes(session.phase)) return false;
  const until = session.lease?.until;
  return !until || until.getTime() < now.getTime();
}

/** Wake a session via the deferred-turn path.
 *  Unregistered agents are warned and skipped, never thrown. */
/** Deduplicate warnings: retired-agent orphans match every sweep forever. */
const warnedUnregistered = new Set<string>();

function warnUnregisteredOnce(session: AgentSession, why: string): void {
  if (warnedUnregistered.has(session._id)) return;
  warnedUnregistered.add(session._id);
  console.warn(
    `[10thfloor:agent] watcher: a session names unregistered agent `
    + `"${session.agent}"; skipping ${why} (warned once per session per process)`,
  );
}

/** Deduplicate warnings for parentless children (same reason as `warnedUnregistered`). */
const warnedParentless = new Set<string>();

/** Warn once about a child whose parent session no longer exists.
 *  The sweep never deletes session data; retention belongs to the host. */
function warnParentlessOnce(child: AgentSession): void {
  if (warnedParentless.has(child._id)) return;
  warnedParentless.add(child._id);
  console.warn(
    '[10thfloor:agent] watcher: a child session names a parent that no longer '
    + 'exists; leaving it in place '
    + '(warned once per process)',
  );
}

async function wake(session: AgentSession, why: string): Promise<void> {
  // `deferResolvedTurn` re-derives the addressee from durable state (decision 6).
  // False = primary agent unregistered; nothing can recover.
  if (!(await deferResolvedTurn(session))) {
    warnUnregisteredOnce(session, why);
  }
}

/** Case 4: write an orphan-child note for any child unreachable from its parent
 *  transcript. Three batched queries, not per-child, so cost scales with sweeps. */
async function relinkOrphanChildren(cutoff: Date, isStopped: () => boolean): Promise<void> {
  const children = await AgentSessions.find(
    { 'parent.sessionId': { $exists: true }, createdAt: { $lt: cutoff } },
    { fields: { agent: 1, parent: 1 } },
  ).fetchAsync();
  if (children.length === 0) return;

  const parentIds = [...new Set(children.map((c) => c.parent!.sessionId))];
  const parents = new Map(
    (await AgentSessions.find(
      { _id: { $in: parentIds } }, { fields: { activeChild: 1 } },
    ).fetchAsync()).map((p) => [p._id, p] as [string, AgentSession]),
  );
  const reachable = new Set(
    (await AgentMessages.find(
      {
        sessionId: { $in: parentIds },
        childSessionId: { $in: children.map((c) => c._id) },
      },
      { fields: { childSessionId: 1 } },
    ).fetchAsync()).map((m) => m.childSessionId),
  );

  for (const child of children) {
    if (isStopped()) return;
    const parentId = child.parent!.sessionId;
    const parent = parents.get(parentId);
    if (!parent) { warnParentlessOnce(child); continue; }
    // Live dispatch: the parent will write the tool row when the child resolves.
    if (parent.activeChild?.sessionId === child._id) continue;
    if (reachable.has(child._id)) continue;

    // Atomic seq allocation — the parent may be running a concurrent turn.
    // eslint-disable-next-line no-await-in-loop
    const before = await AgentSessions.rawCollection().findOneAndUpdate(
      { _id: parentId },
      { $inc: { nextSeq: 1 } satisfies SessionInc, $set: { updatedAt: new Date() } },
      { returnDocument: 'before' },
    ) as unknown as AgentSession | null;
    // The parent went away between the two reads. Next sweep warns.
    if (!before) continue;

    try {
      // Derived _id ensures idempotence across servers (loser gets dup-key).
      // eslint-disable-next-line no-await-in-loop
      await AgentMessages.insertAsync({
        _id: `orphan-child-${child._id}`,
        sessionId: parentId,
        seq: before.nextSeq,
        role: 'note',
        kind: 'orphan-child',
        childSessionId: child._id,
        childAgent: child.agent,
        reason: 'recovered',
        createdAt: new Date(),
      });
    } catch (e: any) {
      // 11000 = duplicate key from a concurrent sweep; anything else re-throws.
      const duplicate = e?.code === 11000 || /duplicate key/i.test(String(e?.message ?? ''));
      if (!duplicate) throw e;
    }
  }
}

export function startWatcher(opts: WatcherOptions = {}): Watcher {
  const sweepMs = opts.sweepMs ?? 15_000;
  const verdictGraceMs = opts.verdictGraceMs ?? Math.max(sweepMs, 1000);
  const relinkGraceMs = opts.relinkGraceMs ?? Math.max(sweepMs, 1000);

  let stopped = false;

  /** One sweep. Cases unioned by _id so one session never gets two wakes. */
  const sweep = async (): Promise<void> => {
    const now = new Date();
    const toWake = new Map<string, { session: AgentSession; why: string }>();

    // CASE 1 — orphan: an active phase with no live lease. The dead-server case.
    const orphans = await AgentSessions.find({
      phase: { $in: ACTIVE_PHASES },
      ...noLiveLease(now),
    }).fetchAsync();
    for (const session of orphans) {
      if (!isRunning(session._id)) toWake.set(session._id, { session, why: 'orphan claim' });
    }

    // CASE 3 — dropped wake: standing verdict, no lease, past grace period.
    const stale = await AgentSessions.find({
      'pending.verdict': { $exists: true },
      phase: { $nin: WAKE_EXCLUDED },
      updatedAt: { $lt: new Date(now.getTime() - verdictGraceMs) },
      ...noLiveLease(now),
    }).fetchAsync();
    for (const session of stale) {
      if (!isRunning(session._id) && !toWake.has(session._id)) {
        toWake.set(session._id, { session, why: 'standing verdict' });
      }
    }

    // CASE 5 — dropped relay (same shape as case 3 with a different marker).
    const relays = await AgentSessions.find({
      pendingRelay: { $exists: true },
      phase: { $nin: WAKE_EXCLUDED },
      updatedAt: { $lt: new Date(now.getTime() - verdictGraceMs) },
      ...noLiveLease(now),
    }).fetchAsync();
    for (const session of relays) {
      if (!isRunning(session._id) && !toWake.has(session._id)) {
        toWake.set(session._id, { session, why: 'standing relay' });
      }
    }

    for (const { session, why } of toWake.values()) {
      if (stopped) return;
      // eslint-disable-next-line no-await-in-loop
      await wake(session, why);
    }

    // CASE 2 — timed-out approval. Limit is per-agent (`budget.approval`);
    // unset means wait forever.
    const parked = await AgentSessions.find({
      phase: 'awaiting',
      'pending.verdict': { $exists: false },
      'pending.requestedAt': { $exists: true },
    }).fetchAsync();
    for (const session of parked) {
      if (stopped) return;
      const config = getAgent(session.agent);
      if (!config) {
        warnUnregisteredOnce(session, 'approval timeout');
        continue;
      }
      const limit = config.budget?.approval;
      const requestedAt = session.pending?.requestedAt;
      if (limit === undefined || !requestedAt) continue;
      if (now.getTime() - requestedAt.getTime() < limit) continue;
      // Awaited (not deferred): the conditional write is the single-winner point.
      // eslint-disable-next-line no-await-in-loop
      await recordTimeoutVerdict(session._id);
    }

    // CASE 6 — dropped system intent (§4.6). Unlike cases 1/3/5, the intent's
    // row must be materialized before waking. Race-safe via the intent's token.
    if (stopped) return;
    const intents = await AgentSessions.find({
      pendingSystem: { $exists: true },
      phase: { $nin: WAKE_EXCLUDED },
      'pendingSystem.at': { $lt: new Date(now.getTime() - verdictGraceMs) },
      ...noLiveLease(now),
    }).fetchAsync();
    for (const session of intents) {
      if (stopped) return;
      if (isRunning(session._id)) continue;
      // eslint-disable-next-line no-await-in-loop
      await consumeStandingIntent(session._id);
    }

    // CASE 4 — orphaned children. Runs last; the only case that writes rows.
    if (stopped) return;
    await relinkOrphanChildren(new Date(now.getTime() - relinkGraceMs), () => stopped);
  };

  /** In-flight sweep, so `stop()` can await it. */
  let sweeping: Promise<void> | null = null;
  const runSweep = (): void => {
    if (stopped || sweeping) return;   // never overlap: a slow sweep skips a tick
    sweeping = sweep()
      .catch(() => {
        // One bad document must not stop the next tick.
        console.error('[10thfloor:agent] watcher sweep failed');
      })
      .then(() => { sweeping = null; });
  };

  const timer = setInterval(runSweep, sweepMs);

  /** Observer catches transitions instantly (vs. sweep-interval); the sweep
   *  catches expired leases (no write to observe). Projection limits noise. */
  let handle: { stop(): void } | null = null;
  /** Serialized so `stop()` has one thing to await. */
  let chain: Promise<void> = Promise.resolve();

  const consider = async (sessionId: string): Promise<void> => {
    if (stopped) return;
    // Re-read the full doc: `changed` carries only changed fields.
    const session = await AgentSessions.findOneAsync(sessionId);
    if (!session || stopped) return;
    if (!isOrphan(session, new Date())) return;
    if (isRunning(sessionId)) return;
    await wake(session, 'orphan claim');
  };

  const notice = (sessionId: string): void => {
    chain = chain.then(() => consider(sessionId)).catch(() => {
      console.error('[10thfloor:agent] watcher: orphan check failed');
    });
  };

  const observing = AgentSessions.find(
    { phase: { $in: ACTIVE_PHASES } },
    { fields: { agent: 1, userId: 1, phase: 1, lease: 1 } },
  ).observeChangesAsync({
    added(id: string) { notice(id); },
    changed(id: string) { notice(id); },
  }).then((h: any) => {
    // Stop immediately if `stop()` won the race against observe resolution.
    handle = h;
    if (stopped) h.stop();
    return undefined;
  }).catch(() => {
    console.error('[10thfloor:agent] watcher: could not observe sessions');
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await observing;
      if (handle) { handle.stop(); handle = null; }
      await chain;
      if (sweeping) await sweeping;
    },
  };
}
