import { Random } from 'meteor/random';
import { guardedUpdate, SERVER_ID } from './lease';
import { commitLeasedMessage } from './transcript';

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
  const seq = await commitLeasedMessage(sessionId, {
    _id: Random.id(), role: 'note', kind: 'budget', budget,
    error: { error: 'budget-exhausted', reason: BUDGET_REASONS[budget] },
    createdAt: new Date(),
  });
  if (seq === null) return;
  await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'stopped' } });
}

/** In-process guard against concurrent `runTurn` calls for the same session.
 *  The lease protects against a second server; this Set against a second call. */
export const running = new Set<string>();

/** Local duplicate-work hint. The Lease remains the cross-process authority. */
export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}
