import { AgentMessages, AgentSessions } from '../common/collections';
import { ACTIVE_PHASES, type AgentSession } from '../common/types';
import { getAgent } from './registry';
import { recordTimeoutVerdict } from './methods';
import { resumeSessionErasures } from './session-lifecycle';
import { beginSessionMutationOperation } from './session-operations';
import { startActivationRecovery } from './activation';
import { commitOperationMessage } from './transcript';

/** Recovery supervisor. Activation owns durable Session-to-Turn recovery;
 * this Module composes it with approval expiry, lifecycle cleanup, and
 * orphan-child transcript repair. */

/** Phases where a turn should be running; unleased = orphan. */
export { ACTIVE_PHASES };

export interface WatcherOptions {
  /** How often the sweep runs. Default 15s; tests lower it. */
  sweepMs?: number;
  /** Grace before newly durable verdict, Relay, System, or input evidence is
   * eligible for sweep recovery. Prevents racing its local Activation nudge.
   * Default one sweep interval, minimum 1s. */
  verdictGraceMs?: number;
  /** Grace period before a child session is treated as orphaned (case 4).
   *  Covers the window between child creation and `activeChild` write. */
  relinkGraceMs?: number;
}

export interface Watcher {
  /** Tear down the observer AND the interval, awaiting whatever is in flight. */
  stop(): Promise<void>;
}

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

/** Case 4: write an orphan-child note for any child unreachable from its parent
 *  transcript. Three batched queries, not per-child, so cost scales with sweeps. */
async function relinkOrphanChildren(cutoff: Date, isStopped: () => boolean): Promise<void> {
  const children = await AgentSessions.find(
    {
      'parent.sessionId': { $exists: true },
      erasingAt: { $exists: false },
      createdAt: { $lt: cutoff },
    },
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

    // eslint-disable-next-line no-await-in-loop
    const operation = await beginSessionMutationOperation(parentId);
    if (!operation) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await operation.assertActive();
      // Derived id, allocation, and row commit are one replay-safe transaction.
      // eslint-disable-next-line no-await-in-loop
      await commitOperationMessage(
        operation,
        parentId,
        `orphan-child-${child._id}`,
        {},
        {},
        () => ({
          role: 'note',
          kind: 'orphan-child',
          childSessionId: child._id,
          childAgent: child.agent,
          reason: 'recovered',
          createdAt: new Date(),
        }),
      );
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await operation.close();
    }
  }
}

export function startWatcher(opts: WatcherOptions = {}): Watcher {
  const sweepMs = opts.sweepMs ?? 15_000;
  const verdictGraceMs = opts.verdictGraceMs ?? Math.max(sweepMs, 1000);
  const relinkGraceMs = opts.relinkGraceMs ?? Math.max(sweepMs, 1000);
  const activationRecovery = startActivationRecovery({
    sweepMs, graceMs: verdictGraceMs,
  });

  let stopped = false;

  /** Approval expiry and orphan-child repair. Activation recovery owns all
   * Session→Turn discovery, observation, and scheduling. */
  const sweep = async (): Promise<void> => {
    const now = new Date();

    // Lifecycle recovery precedes wake recovery: an erased Session must never
    // be revived merely because its previous server disappeared mid-cleanup.
    await resumeSessionErasures();

    // Timed-out approval. Limit is per-Agent (`budget.approval`);
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

    // Orphaned children. Runs last; the only local repair that writes rows.
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

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await activationRecovery.stop();
      if (sweeping) await sweeping;
    },
  };
}
