import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import type { SessionInc } from '../common/types';
import { guardedUpdate, SERVER_ID } from './lease';

/**
 * The turn machinery's shared, low-level primitives — the in-process run
 * registry, the atomic seq/usage allocation every committing write funnels
 * through, and the two pure helpers (`accruedCost`, `classifyProviderError`)
 * that both `runTurn` and the compaction subsystem call.
 *
 * They live in this leaf module for one concrete reason: `compaction.ts` and
 * `dispatch.ts` need `allocateSeq`/`accruedCost`/`classifyProviderError` at
 * RUNTIME, and `loop.ts` (which owns `runTurn`) imports FROM those modules — so
 * leaving these here rather than in `loop.ts` is what keeps the dependency
 * graph a DAG instead of a cycle. Nothing in this module imports from another
 * server module except `lease.ts` and the collections, so it is a true leaf.
 */

/**
 * Dollars to add to `usage.cost` for one model call.
 *
 * The provider's own figure wins whenever it reports one. pi-ai prices each
 * call against its catalog including cacheRead/cacheWrite tokens, which
 * `ProviderChunk` does not carry and a two-rate table cannot express — so
 * recomputing from input/output alone would systematically underprice cached
 * calls, and a spend budget that undercounts is not a budget.
 *
 * With no reported cost and no configured `pricing`, this accrues ZERO rather
 * than guessing. A session with no way to price itself simply has no spend
 * budget: `usage.cost` stays 0, the spend check never trips, and the turn and
 * tool-call budgets are what limit the run. Guessing a rate would be worse —
 * it would trip a cap on a number nobody chose.
 */
export function accruedCost(
  usage: { input: number; output: number; cost?: number },
  pricing?: { input: number; output: number },
): number {
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost;
  if (!pricing) return 0;
  return (usage.input * pricing.input + usage.output * pricing.output) / 1e6;
}

/** §10: 429, 408 (a request timeout is transient by definition — Anthropic's
 *  and OpenAI's own client libraries retry it alongside 429 and 5xx), 5xx and
 *  network-ish errors retry; other 4xx auth/request errors do not. Anything
 *  unclassifiable is treated as retryable — a transient blip should not
 *  permanently kill a session, and retries are bounded anyway.
 *
 *  'abandon' is the third answer: a cancelled request. Retrying re-issues the
 *  very request the user stopped, and a failure note blames them for their
 *  own cancellation — so an abort takes the interrupt path instead. Detected
 *  by the adapter's hint or by the standard AbortError name a raw aborted
 *  fetch carries (no status at all, so it would otherwise default to
 *  retryable).
 *
 *  An explicit `e.retryable` hint (set by an adapter that has better
 *  information than an HTTP status — pi-ai's own transient-error classifier,
 *  for one) short-circuits the status-based classification. */
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

/**
 * Atomically allocate the next message `seq` under the lease guard: one
 * `findOneAndUpdate`, so no interleaving with `agent.send`'s own atomic
 * allocation can hand out the same seq twice. Returns null when the lease is
 * gone (or the session vanished) — the caller must abandon without writing.
 *
 * This exists because read-then-`$inc` is NOT atomic: the loop used to capture
 * `nextSeq` before the stream and `$inc` at commit, so a user message sent
 * mid-stream landed on the same seq the assistant then committed at.
 */
export async function allocateSeq(
  sessionId: string,
  // Typed to the counter-path union, not `Record<string, number>`: this is the
  // funnel every committing turn's budget/usage `$inc` passes through, so a
  // mistyped path here is a compile error rather than a silently-dropped
  // increment. See `SessionInc`.
  inc: SessionInc = {},
): Promise<number | null> {
  const before = await AgentSessions.rawCollection().findOneAndUpdate(
    { _id: sessionId, 'lease.serverId': SERVER_ID } as any,
    { $inc: { nextSeq: 1, ...inc }, $set: { updatedAt: new Date() } },
    { returnDocument: 'before' },
  );
  return before ? (before as any).nextSeq : null;
}

/** Which limit tripped, and the sentence a UI shows for it. */
const BUDGET_REASONS = {
  turns: 'Turn budget reached.',
  toolCalls: 'Tool-call budget reached.',
  spend: 'Spend budget reached.',
} as const;

/**
 * Record a tripped budget and stop the session (§9).
 *
 * Structured, never prose: `kind: 'budget'` plus the same `{ error, reason }`
 * shape the provider-failure note uses, plus WHICH budget it was — so a UI can
 * offer to raise the right limit instead of saying "exhausted" and leaving the
 * operator to guess.
 *
 * `phase: 'stopped'` reuses the interrupt's semantics exactly, including its
 * durability: the loop refuses to run while it stands and the outer `finally`
 * preserves it, so the next `agent.send` is what clears it. For `turns` and
 * `spend` that next send then refuses (`mSend`) or trips again on its first
 * iteration — the closed loop is the design, not an oversight.
 *
 * Both writes are lease-guarded (`allocateSeq`, `guardedUpdate`). Losing the
 * lease means another server owns the session and will make its own decision;
 * writing a stop from here would stop ITS turn.
 */
export async function commitBudgetNote(
  sessionId: string, budget: keyof typeof BUDGET_REASONS,
): Promise<void> {
  const seq = await allocateSeq(sessionId);
  if (seq === null) return;
  await AgentMessages.insertAsync({
    _id: Random.id(), sessionId, seq, role: 'note', kind: 'budget', budget,
    error: { error: 'budget-exhausted', reason: BUDGET_REASONS[budget] },
    createdAt: new Date(),
  } as any);
  await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'stopped' } });
}

/**
 * Sessions running a turn IN THIS PROCESS. `claimLease` succeeds on its
 * "already ours" branch, so two concurrent `runTurn` calls in one process would
 * both hold the lease and both pass every `guardedUpdate`; the read-then-`$inc`
 * of `nextSeq` is not atomic, so both could insert at the same `seq`. The
 * lease protects against a second SERVER, this Set against a second CALL —
 * a double-submitting user reaching `Meteor.defer(() => runTurn(...))` twice.
 */
export const running = new Set<string>();

/**
 * Is a turn for this session running in THIS process?
 *
 * The watcher's read of the same guard `runTurn` enforces internally. It is an
 * optimization, not a correctness boundary: calling `runTurn` for a session
 * already running here returns immediately anyway, and a run on ANOTHER server
 * is invisible to this Set (that is what the lease is for). It exists so a sweep
 * does not queue wake-ups it knows will be no-ops.
 */
export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}
