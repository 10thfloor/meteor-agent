import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import {
  DECIDED_PHASES, type AgentSession, type Phase,
} from '../common/types';
import type { SessionQuery } from '../common/db';
import { systemFrom } from '../common/participants';
import { getAgent, resolveBudget, memoryOpt, type AgentConfig } from './registry';
import { SERVER_ID } from './lease';
import { beginSessionTreeOperation } from './session-operations';
import { isRunning } from './turn-state';
import { commitOperationMessage } from './transcript';

/** Phases that block parking. Named once so the three sites cannot drift. */
const HALTED_PHASES: Phase[] = ['stopped', 'error'];

/** System turns — durable prompts nobody typed. Activation is the normal
 * coordinator; the dispatcher Adapter remains for compatibility. */

/** Stale intent ceiling — without it a halted session blocks all future firings. */
export const SYSTEM_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export type SystemTurnResult =
  | { ok: true; ran: true }
  | { ok: true; ran: false; parked: true }
  | {
    ok: false;
    reason: 'duplicate-key' | 'intent-standing' | 'session-halted'
      | 'budget-exhausted' | 'no-session' | 'no-agent';
  };

/** Legacy dispatcher Adapter used by the durable System-intent primitives. */
export type SystemDispatch = (
  sessionId: string,
  config: AgentConfig,
  userId: string | null,
  opts?: { agentName?: string; budget?: ReturnType<typeof resolveBudget>;
    memory?: ReturnType<typeof memoryOpt>['memory'] },
) => void;

/** Derived `_id` for idempotency — keyed on the idempotency key, not the token. */
export function systemRowId(sessionId: string, keyOrToken: string): string {
  return `sys:${sessionId}:${keyOrToken}`;
}

/** Budget guard as `$and` clauses. Uses `$exists` because Mongo's `$lt` skips
 *  missing fields, which would silently block all pre-existing sessions. */
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
function consumableByUs(now: Date): SessionQuery {
  return {
    $or: [
      { lease: { $exists: false } },
      { lease: null },
      { 'lease.until': { $lt: now } },
      { 'lease.serverId': SERVER_ID },
    ],
  };
}

/** Materialize a standing intent and hand it to a Turn dispatcher. The marker
 *  and budget are consumed by the Turn's first commit, not here. */
export async function consumeSystemIntent(
  sessionId: string, dispatch: SystemDispatch,
): Promise<boolean> {
  const session = await AgentSessions.findOneAsync({
    _id: sessionId, erasingAt: { $exists: false },
  });
  const intent = session?.pendingSystem;
  if (!session || !intent) return false;
  // Early-out; the claim re-asserts all of these atomically.
  if (DECIDED_PHASES.includes(session.phase)) return false;
  if (isRunning(sessionId)) return false;
  if (session.lease && session.lease.until > new Date()
    && session.lease.serverId !== SERVER_ID) return false;

  const target = getAgent(intent.agent ?? session.agent);
  if (!target) return false;
  const operation = await beginSessionTreeOperation(sessionId);
  if (!operation) return false;
  try {
    const rowId = systemRowId(sessionId, intent.key ?? intent.token);
    const existing = await AgentMessages.findOneAsync(rowId);
    if (!existing) {
      const now = new Date();
      await operation.assertActive();
      // Token claim, sequence, and System row are one lifecycle transaction.
      const seq = await commitOperationMessage(
        operation,
        sessionId,
        rowId,
        {
          'pendingSystem.token': intent.token,
          phase: { $nin: DECIDED_PHASES },
          $and: [consumableByUs(now)],
        },
        {},
        () => ({
          role: 'system',
          content: intent.prompt,
          // Unconditional (decision 3) — roster-gating would drop attribution in 1:1.
          from: systemFrom(intent.source),
          createdAt: now,
        }),
      );
      if (seq === null) return false;
    }

    // Name the target explicitly — recovery-time resolution can't honour intent.agent.
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
  } finally {
    await operation.close();
  }
}

/** Park a system turn, and run it now if the session is free.
 *  Server-only (decision 16) — client-reachable would bypass budgets. */
export async function startSystemTurnWith(
  dispatch: SystemDispatch,
  sessionId: string,
  prompt: string,
  opts?: { key?: string; agent?: string; source?: string },
): Promise<SystemTurnResult> {
  const session = await AgentSessions.findOneAsync({
    _id: sessionId, erasingAt: { $exists: false },
  });
  if (!session) return { ok: false, reason: 'no-session' };

  const primary = getAgent(session.agent);
  // Hard-refuse an unregistered agent name — don't silently fall back to primary.
  const target = opts?.agent ? getAgent(opts.agent) : primary;
  if (!target) return { ok: false, reason: 'no-agent' };

  // Parking into a halted phase would stand forever; refuse so the scheduler learns.
  if (HALTED_PHASES.includes(session.phase)) {
    return { ok: false, reason: 'session-halted' };
  }

  const now = new Date();
  const token = Random.id();
  const claimed = await AgentSessions.rawCollection().findOneAndUpdate(
    {
      _id: sessionId,
      erasingAt: { $exists: false },
      phase: { $nin: HALTED_PHASES },
      ephemeral: { $ne: true },  // throwaway sessions are deleted after the call
      ...(opts?.key ? { lastSystemKey: { $ne: opts.key } } : {}),
      $and: [
        {
          $or: [
            { pendingSystem: { $exists: false } },
            { 'pendingSystem.at': { $lt: new Date(now.getTime() - SYSTEM_INTENT_TTL_MS) } }, // stale may be replaced (decision 11)
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
      // No relay reset — a scheduled prompt does not outrank a pending relay (decision 7).
    },
    { returnDocument: 'before' },
  ) as unknown as AgentSession | null;

  if (!claimed) {
    // Diagnose which clause missed so the caller gets a specific reason.
    const after = await AgentSessions.findOneAsync(sessionId);
    if (!after) return { ok: false, reason: 'no-session' };
    if (opts?.key && after.lastSystemKey === opts.key) {
      return { ok: false, reason: 'duplicate-key' };
    }
    if (HALTED_PHASES.includes(after.phase)) {
      return { ok: false, reason: 'session-halted' };
    }
    if (after.pendingSystem) return { ok: false, reason: 'intent-standing' };
    return { ok: false, reason: 'budget-exhausted' };
  }

  const ran = await consumeSystemIntent(sessionId, dispatch);
  return ran ? { ok: true, ran: true } : { ok: true, ran: false, parked: true };
}
