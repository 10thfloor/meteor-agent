import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import { DECIDED_PHASES, type AgentSession, type SessionInc } from '../common/types';
import { systemFrom } from '../common/participants';
import { getAgent, resolveBudget, memoryOpt, type AgentConfig } from './registry';
import { SERVER_ID } from './lease';
import { isRunning } from './turn-state';

/**
 * System turns — a turn nobody typed.
 *
 * Every other entry into a turn is a human action, and `sendToSession` writes a
 * `role: 'user'` row attributed to the session's owner. Scheduled work has no
 * such person, and borrowing one puts a name on an action they did not take.
 *
 * Full design: docs/superpowers/specs/2026-08-25-system-turns.md
 *
 * This module owns the DURABLE part — the park, the single-winner claim, the
 * row — and takes its dispatcher as an argument. That is layering, not
 * ceremony: `loop.ts` is deliberately free of `methods.ts`'s Meteor plumbing,
 * so a consume path that reached for `deferTurn` directly would drag
 * `Meteor.methods` into the loop's dependency graph, or force a module cycle
 * between the two. Injecting the dispatcher keeps ONE consume policy (decision
 * 13) with no cycle: `methods.ts` and `watcher.ts` pass `deferTurn`, the loop's
 * wind-down passes its own `runTurn`.
 */

/** How long a standing intent may sit before a fresh park may replace it.
 *  Without a ceiling, an intent parked onto a session that then halted would
 *  refuse every later firing forever (decision 11). */
export const SYSTEM_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export type SystemTurnResult =
  | { ok: true; ran: true }
  | { ok: true; ran: false; parked: true }
  | {
    ok: false;
    reason: 'duplicate-key' | 'intent-standing' | 'session-halted'
      | 'budget-exhausted' | 'no-session' | 'no-agent';
  };

/** How a consumed intent starts its turn. `deferTurn`'s shape, minus the module
 *  it lives in. */
export type SystemDispatch = (
  sessionId: string,
  config: AgentConfig,
  userId: string | null,
  opts?: { agentName?: string; budget?: ReturnType<typeof resolveBudget>;
    memory?: ReturnType<typeof memoryOpt>['memory'] },
) => void;

/**
 * The system row's `_id`, derived so a repeated key can never write a second
 * row — the `orphan-child` trick, which needs no index because the primary key
 * always exists.
 *
 * Keyed on the IDEMPOTENCY KEY when there is one. Deriving it from the
 * per-call token instead would make the guard protect nothing: a fresh token
 * per call yields a fresh `_id` per call.
 */
export function systemRowId(sessionId: string, keyOrToken: string): string {
  return `sys:${sessionId}:${keyOrToken}`;
}

/**
 * The system-turn budget bound, as clauses for an enclosing `$and`.
 *
 * Existence-tolerant, and that is not defensive coding: Mongo's comparison
 * operators are type-bracketed, so `$lt` does not match a MISSING field — and
 * every session document written before this feature existed has no
 * `budgetSpent.systemTurns`. A bare `$lt` would refuse every system turn on
 * every pre-existing session, silently, forever.
 *
 * Returned as clauses rather than a selector because the lease check
 * contributes a bare `$or` of its own, and two of those in one selector
 * destroy each other.
 */
export function systemBudgetClause(limit?: number): object[] {
  if (limit === undefined) return [];
  return [{
    $or: [
      { 'budgetSpent.systemTurns': { $exists: false } },
      { 'budgetSpent.systemTurns': { $lt: limit } },
    ],
  }];
}

/** Nobody else holds a live lease. Spread into an `$and`, never bare. */
function consumableByUs(now: Date): object {
  return {
    $or: [
      { lease: { $exists: false } },
      { 'lease.until': { $lt: now } },
      { 'lease.serverId': SERVER_ID },
    ],
  };
}

/**
 * Materialize a standing intent and dispatch its turn.
 *
 * It does NOT clear the marker and does NOT spend the budget — both ride the
 * turn's FIRST COMMIT (decision 14, `allocateSeq`'s `$unset`). That is the
 * whole safety property: `deferTurn` is fire-and-forget and `runTurn` returns
 * silently when the session is already running in this process or another
 * server holds the lease, so a consumer that cleared the marker itself would
 * strand the row it had just written — no crash required — with nothing left
 * for the sweep to find. Leaving the marker standing costs only a re-consume,
 * which the derived `_id` makes harmless.
 *
 * Returns true when a turn was dispatched.
 */
export async function consumeSystemIntent(
  sessionId: string, dispatch: SystemDispatch,
): Promise<boolean> {
  const session = await AgentSessions.findOneAsync(sessionId);
  const intent = session?.pendingSystem;
  if (!session || !intent) return false;
  // Each of these is re-asserted in the claim below; this read only avoids the
  // work when the answer is already no.
  if (DECIDED_PHASES.includes(session.phase)) return false;
  if (isRunning(sessionId)) return false;
  if (session.lease && session.lease.until > new Date()
    && session.lease.serverId !== SERVER_ID) return false;

  const target = getAgent(intent.agent ?? session.agent);
  if (!target) return false;

  const rowId = systemRowId(sessionId, intent.key ?? intent.token);
  const existing = await AgentMessages.findOneAsync(rowId);
  if (!existing) {
    const now = new Date();
    // The atomic claim. Its selector re-asserts every guard the read checked,
    // so the write cannot land on a state the read disqualified, and the token
    // makes it single-winner between two servers sweeping at once.
    const before = await AgentSessions.rawCollection().findOneAndUpdate(
      {
        _id: sessionId,
        'pendingSystem.token': intent.token,
        phase: { $nin: DECIDED_PHASES },
        $and: [consumableByUs(now)],
      },
      { $inc: { nextSeq: 1 } satisfies SessionInc, $set: { updatedAt: now } },
      { returnDocument: 'before' },
    ) as unknown as AgentSession | null;
    if (!before) return false;

    try {
      await AgentMessages.insertAsync({
        _id: rowId,
        sessionId,
        seq: before.nextSeq,
        role: 'system',
        content: intent.prompt,
        // Unconditional, roster or not (decision 3). A system row is net-new,
        // so there is no byte-identical 1:1 payload to preserve, and
        // roster-gating the stamp the way `sendToSession` does would drop
        // attribution in exactly the 1:1 case scheduled work uses.
        from: systemFrom(intent.source),
        createdAt: now,
      });
    } catch (e: any) {
      // A duplicate `_id`: another consumer materialized this same intent
      // between our read and our insert, and its turn is already on its way.
      // The seq we allocated becomes a gap, which the transcript tolerates
      // (a discarded turn leaves one too).
      if (e?.code !== 11000) throw e;
      return false;
    }
  }

  // Dispatch naming the target EXPLICITLY. Resolving it from durable state at
  // dispatch time (the way the recovery paths do) cannot honour an intent's own
  // `agent`, and by then the marker may already be gone.
  const primary = getAgent(session.agent);
  if (intent.agent && primary && target !== primary) {
    dispatch(sessionId, target, session.userId, {
      agentName: intent.agent,
      budget: resolveBudget(primary.budget),
      ...memoryOpt(primary),
    });
  } else {
    dispatch(sessionId, target, session.userId);
  }
  return true;
}

/**
 * Park a system turn, and run it now if the session is free.
 *
 * Server-only and deliberately not a DDP method (decision 16): a system turn
 * has no caller to authorize, and a client-reachable one would start turns that
 * bypass both the turn budget and the rate limiter.
 *
 * A busy session — including one parked on an approval, which is the case this
 * exists for — keeps the intent standing until it next goes idle, rather than
 * dropping the request.
 */
export async function startSystemTurnWith(
  dispatch: SystemDispatch,
  sessionId: string,
  prompt: string,
  opts?: { key?: string; agent?: string; source?: string },
): Promise<SystemTurnResult> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return { ok: false, reason: 'no-session' };

  // An intent naming an unregistered agent is a config bug in the caller, so
  // this is a hard refusal — NOT the visible primary fallback the recovery
  // paths use for a renamed colleague. Answering as somebody else would hide
  // it, and a schedule pointing at a teammate that no longer exists is exactly
  // the thing an operator needs told.
  const target = getAgent(opts?.agent ?? session.agent);
  if (!target) return { ok: false, reason: 'no-agent' };
  // The purse is the PRIMARY's, as every other budget in a session is.
  const primary = getAgent(session.agent);

  // `stopped` and `error` are states a person is meant to see and clear.
  // Parking into one would stand forever — the sweep excludes those phases —
  // and then refuse every later firing, turning a transient failure into a
  // permanent block. Refusing now means the scheduler learns on its next tick.
  if (session.phase === 'stopped' || session.phase === 'error') {
    return { ok: false, reason: 'session-halted' };
  }

  const now = new Date();
  const token = Random.id();
  const claimed = await AgentSessions.rawCollection().findOneAndUpdate(
    {
      _id: sessionId,
      phase: { $nin: ['stopped', 'error'] },
      // `Agent.ask`'s throwaway sessions are deleted when the call returns, so
      // an intent parked on one is unreachable by construction.
      ephemeral: { $ne: true },
      ...(opts?.key ? { lastSystemKey: { $ne: opts.key } } : {}),
      $and: [
        {
          $or: [
            { pendingSystem: { $exists: false } },
            // A stale intent may be replaced; a live one may not (decision 11).
            { 'pendingSystem.at': { $lt: new Date(now.getTime() - SYSTEM_INTENT_TTL_MS) } },
          ],
        },
        ...systemBudgetClause(primary?.budget?.systemTurns),
      ],
    },
    {
      $set: {
        pendingSystem: {
          prompt,
          ...(opts?.agent ? { agent: opts.agent } : {}),
          ...(opts?.source ? { source: opts.source } : {}),
          ...(opts?.key ? { key: opts.key } : {}),
          token,
          at: now,
        },
        ...(opts?.key ? { lastSystemKey: opts.key } : {}),
        updatedAt: now,
      },
      // Deliberately absent: `relay: 0` and `$unset: { pendingRelay: 1 }`,
      // which `sendToSession` writes here. A human interjection outranks a
      // pending relay; a machine's scheduled prompt does not (decision 7 —
      // this omission IS the decision).
    },
    { returnDocument: 'before' },
  ) as unknown as AgentSession | null;

  if (!claimed) {
    // Several clauses can miss and the caller deserves to know which, so the
    // failure path — and only the failure path — pays for one more read.
    const after = await AgentSessions.findOneAsync(sessionId);
    if (!after) return { ok: false, reason: 'no-session' };
    if (opts?.key && after.lastSystemKey === opts.key) {
      return { ok: false, reason: 'duplicate-key' };
    }
    if (after.phase === 'stopped' || after.phase === 'error') {
      return { ok: false, reason: 'session-halted' };
    }
    if (after.pendingSystem) return { ok: false, reason: 'intent-standing' };
    return { ok: false, reason: 'budget-exhausted' };
  }

  const ran = await consumeSystemIntent(sessionId, dispatch);
  return ran ? { ok: true, ran: true } : { ok: true, ran: false, parked: true };
}
