/**
 * Leaf module for turn primitives shared by compaction, dispatch, and loop.
 * Lives here (not in loop.ts) to keep the dependency graph acyclic.
 */
/** Dollars to add to `usage.cost`. Provider-reported cost wins; falls back to
 *  configured pricing; accrues zero when neither exists (no guessing). */
export declare function accruedCost(usage: {
    input: number;
    output: number;
    cost?: number;
}, pricing?: {
    input: number;
    output: number;
}): number;
/** §10: 429/408/5xx and unknowns retry; other 4xx are fatal; aborts abandon.
 *  An explicit `e.retryable` hint from the adapter short-circuits status. */
export declare function classifyProviderError(e: any): 'retryable' | 'fatal' | 'abandon';
/** Which limit tripped, and the sentence a UI shows for it. */
declare const BUDGET_REASONS: {
    readonly turns: 'Turn budget reached.';
    readonly toolCalls: 'Tool-call budget reached.';
    readonly spend: 'Spend budget reached.';
};
/** Record a tripped budget as a structured note and stop the session (§9).
 *  Both writes are lease-guarded; losing the lease means another server owns it. */
export declare function commitBudgetNote(sessionId: string, budget: keyof typeof BUDGET_REASONS): Promise<void>;
/** In-process guard against concurrent `runTurn` calls for the same session.
 *  The lease protects against a second server; this Set against a second call. */
export declare const running: Set<string>;
/** Local duplicate-work hint. The Lease remains the cross-process authority. */
export declare function isRunning(sessionId: string): boolean;
export {};
//# sourceMappingURL=turn-state.d.ts.map