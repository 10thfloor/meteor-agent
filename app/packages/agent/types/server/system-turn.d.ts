import { resolveBudget, memoryOpt, type AgentConfig } from './registry';
/** System turns — durable prompts nobody typed. Activation is the normal
 * coordinator; the dispatcher Adapter remains for compatibility. */
/** Stale intent ceiling — without it a halted session blocks all future firings. */
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
/** Legacy dispatcher Adapter used by the durable System-intent primitives. */
export type SystemDispatch = (sessionId: string, config: AgentConfig, userId: string | null, opts?: {
    agentName?: string;
    budget?: ReturnType<typeof resolveBudget>;
    memory?: ReturnType<typeof memoryOpt>['memory'];
}) => void;
/** Derived `_id` for idempotency — keyed on the idempotency key, not the token. */
export declare function systemRowId(sessionId: string, keyOrToken: string): string;
/** Budget guard as `$and` clauses. Uses `$exists` because Mongo's `$lt` skips
 *  missing fields, which would silently block all pre-existing sessions. */
export declare function systemBudgetClause(limit?: number): object[];
/** Materialize a standing intent and hand it to a Turn dispatcher. The marker
 *  and budget are consumed by the Turn's first commit, not here. */
export declare function consumeSystemIntent(sessionId: string, dispatch: SystemDispatch): Promise<boolean>;
/** Park a system turn, and run it now if the session is free.
 *  Server-only (decision 16) — client-reachable would bypass budgets. */
export declare function startSystemTurnWith(dispatch: SystemDispatch, sessionId: string, prompt: string, opts?: {
    key?: string;
    agent?: string;
    source?: string;
}): Promise<SystemTurnResult>;
//# sourceMappingURL=system-turn.d.ts.map