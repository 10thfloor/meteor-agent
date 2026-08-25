import { resolveBudget, memoryOpt, type AgentConfig } from './registry';
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
export declare const SYSTEM_INTENT_TTL_MS: number;
export type SystemTurnResult = {
    ok: true;
    ran: true;
} | {
    ok: true;
    ran: false;
    parked: true;
} | {
    ok: false;
    reason: 'duplicate-key' | 'intent-standing' | 'session-halted' | 'budget-exhausted' | 'no-session' | 'no-agent';
};
/** How a consumed intent starts its turn. `deferTurn`'s shape, minus the module
 *  it lives in. */
export type SystemDispatch = (sessionId: string, config: AgentConfig, userId: string | null, opts?: {
    agentName?: string;
    budget?: ReturnType<typeof resolveBudget>;
    memory?: ReturnType<typeof memoryOpt>['memory'];
}) => void;
/**
 * The system row's `_id`, derived so a repeated key can never write a second
 * row — the `orphan-child` trick, which needs no index because the primary key
 * always exists.
 *
 * Keyed on the IDEMPOTENCY KEY when there is one. Deriving it from the
 * per-call token instead would make the guard protect nothing: a fresh token
 * per call yields a fresh `_id` per call.
 */
export declare function systemRowId(sessionId: string, keyOrToken: string): string;
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
export declare function systemBudgetClause(limit?: number): object[];
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
export declare function consumeSystemIntent(sessionId: string, dispatch: SystemDispatch): Promise<boolean>;
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
export declare function startSystemTurnWith(dispatch: SystemDispatch, sessionId: string, prompt: string, opts?: {
    key?: string;
    agent?: string;
    source?: string;
}): Promise<SystemTurnResult>;
//# sourceMappingURL=system-turn.d.ts.map