import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import type { AgentSession, SessionInc } from '../common/types';
import type { SessionSet } from '../common/db';
import { guardedUpdate, SERVER_ID } from './lease';

/**
 * Leaf module for turn primitives shared by compaction, dispatch, and loop.
 * Lives here (not in loop.ts) to keep the dependency graph acyclic.
 */

/** Dollars to add to `usage.cost`. Provider-reported cost wins; falls back to
 *  configured pricing; accrues zero when neither exists (no guessing). */
export function accruedCost(
  usage: { input: number; output: number; cost?: number },
  pricing?: { input: number; output: number },
): number {
  if (typeof usage.cost === 'number'
    && Number.isFinite(usage.cost)
    && usage.cost >= 0) return usage.cost;
  if (!pricing) return 0;
  const calculated = (usage.input * pricing.input + usage.output * pricing.output) / 1e6;
  return Number.isFinite(calculated) && calculated >= 0 ? calculated : 0;
}

/** §10: 429/408/5xx and unknowns retry; other 4xx are fatal; aborts abandon.
 *  An explicit `e.retryable` hint from the adapter short-circuits status. */
export function classifyProviderError(e: any): 'retryable' | 'fatal' | 'abandon' {
  if (e?.retryable === 'abandon' || e?.name === 'AbortError') return 'abandon';
  if (e?.retryable === true) return 'retryable';
  if (e?.retryable === false) return 'fatal';
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status === 429 || status === 408
    || (typeof status === 'number' && status >= 500)) return 'retryable';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'fatal';
  return 'retryable';
}

/** Atomically allocate the next `seq` under the lease guard. Returns null
 *  when the lease is gone or the optional Stop guard loses — caller must
 *  abandon that write. */
export async function allocateSeq(
  sessionId: string,
  // Typed to SessionInc so a mistyped counter path is a compile error.
  inc: SessionInc = {},
  // Extra `$set` that must ride the same atomic write (e.g. pendingRelay).
  set?: SessionSet,
  // Markers to clear atomically — the turn's first commit consumes the relay
  // or system intent so a crash before commit leaves the wake standing.
  unset?: { pendingRelay?: 1; pendingSystem?: 1 },
  // Turn-output commits use this to make Stop the winner. Tool-result and
  // repair allocations deliberately do not: an already-committed tool_use
  // still needs its matching result when a descendant is interrupted.
  opts: { unlessStopped?: boolean } = {},
): Promise<number | null> {
  // Double cast: driver returns the document (not ModifyResult) with v5+ defaults.
  const before = await AgentSessions.rawCollection().findOneAndUpdate(
    {
      _id: sessionId,
      'lease.serverId': SERVER_ID,
      ...(opts.unlessStopped ? { phase: { $ne: 'stopped' as const } } : {}),
    },
    {
      $inc: { nextSeq: 1, ...inc } satisfies SessionInc,
      $set: { updatedAt: new Date(), ...(set ?? {}) },
      ...(unset && Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    },
    { returnDocument: 'before' },
  ) as unknown as AgentSession | null;
  return before ? before.nextSeq : null;
}

/** Which limit tripped, and the sentence a UI shows for it. */
const BUDGET_REASONS = {
  turns: 'Turn budget reached.',
  toolCalls: 'Tool-call budget reached.',
  spend: 'Spend budget reached.',
} as const;

/** Record a tripped budget as a structured note and stop the session (§9).
 *  Both writes are lease-guarded; losing the lease means another server owns it. */
export async function commitBudgetNote(
  sessionId: string, budget: keyof typeof BUDGET_REASONS,
): Promise<void> {
  const seq = await allocateSeq(sessionId);
  if (seq === null) return;
  await AgentMessages.insertAsync({
    _id: Random.id(), sessionId, seq, role: 'note', kind: 'budget', budget,
    error: { error: 'budget-exhausted', reason: BUDGET_REASONS[budget] },
    createdAt: new Date(),
  });
  await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'stopped' } });
}

/** In-process guard against concurrent `runTurn` calls for the same session.
 *  The lease protects against a second server; this Set against a second call. */
export const running = new Set<string>();

/** Optimization: lets the sweep skip wake-ups it knows will be no-ops. */
export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}
