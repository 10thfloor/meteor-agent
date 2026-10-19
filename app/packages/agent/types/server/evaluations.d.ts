/** Evaluation runs are deliberately separate from Agent learning. They use the
 * configured model, instructions, skills and tool schemas, but no identity,
 * Fact Memory, Experience, Practice, approvals, or executable Tools. The model
 * can still propose a Tool call, which is enough to score tool selection
 * without letting a benchmark mutate the workspace or an external system. */
export declare const EVALUATION_TEXT_MAX = 50000;
export declare const EVALUATION_ASSERTION_MAX = 20;
export declare const EVALUATION_SCORER_MAX = 12;
export declare const EVALUATION_SCORER_TIMEOUT_MS = 30000;
export declare const EVALUATION_SCORER_TIMEOUT_MAX_MS = 60000;
export interface EvaluationExpected {
    contains: string[];
    avoids: string[];
    requiredTool?: string;
}
/** Synthetic, immutable context for evaluating memory-shaped behavior without
 * reading or writing the live Agent's stores. These strings are ordinary test
 * prompt material; they do not claim to exercise retrieval ranking. */
export interface EvaluationFixtures {
    facts?: string[];
    experiences?: string[];
    practices?: string[];
    constitution?: string;
}
export interface EvaluationScenarioSnapshot {
    scenarioId: string;
    revision: number;
    name: string;
    prompt: string;
    expected: EvaluationExpected;
    scorerIds: string[];
    fixtures?: EvaluationFixtures;
}
export interface EvaluationAgentRun {
    output: string;
    /** Tool names only. Arguments and results may contain secrets and are not
     * evaluation evidence for the deterministic selection gate. */
    toolCalls: string[];
    durationMs: number;
    model?: string;
    agentVersion?: string;
    usage?: {
        input: number;
        output: number;
        cost: number;
    };
    error?: {
        code: string;
        reason: string;
    };
}
export interface EvaluationScore {
    id: string;
    kind: 'deterministic' | 'custom' | 'model';
    pass: boolean;
    /** Normalized 0..1 so custom and model judges can be compared. */
    score: number;
    reason: string;
}
export interface EvaluationScorerContext {
    userId: string;
    agentId: string;
    scenario: EvaluationScenarioSnapshot;
    run: Readonly<EvaluationAgentRun>;
    /** Hooks that perform I/O should stop promptly when the evaluation times out. */
    signal?: AbortSignal;
}
export interface EvaluationScorerDefinition {
    id: string;
    name: string;
    kind: 'custom' | 'model';
    timeoutMs?: number;
    evaluate(context: EvaluationScorerContext): Promise<Partial<Pick<EvaluationScore, 'pass' | 'score' | 'reason'>>> | Partial<Pick<EvaluationScore, 'pass' | 'score' | 'reason'>>;
}
export interface EvaluatedAgentRun extends EvaluationAgentRun {
    status: 'passed' | 'failed' | 'error';
    scores: EvaluationScore[];
}
/** Pure, repeatable gates: every configured assertion must pass. An empty
 * assertion set is a passing baseline, not an invented model-quality score. */
export declare function scoreEvaluationDeterministically(expected: EvaluationExpected, run: Pick<EvaluationAgentRun, 'output' | 'toolCalls'>): EvaluationScore[];
/** Apply deterministic gates, then only the explicitly selected registered
 * hooks. A judge failure becomes a failed score instead of losing the rest of
 * an experiment. */
export declare function evaluateAgentRun(context: EvaluationScorerContext, scorers?: ReadonlyMap<string, EvaluationScorerDefinition>): Promise<EvaluatedAgentRun>;
/** Run a configured Agent in a non-enumerable throwaway Session. It intentionally
 * does not call Agent#ask: ask preserves identity learning, while an evaluation
 * must be observational. Cleanup is part of success; a result is withheld if
 * temporary transcript erasure cannot be proved. */
export declare function runIsolatedAgentEvaluation(agentId: string, prompt: string, opts: {
    instructionUserId: string;
    fixtures?: EvaluationFixtures;
}): Promise<EvaluationAgentRun>;
/** Validate application-registered hooks once at startup. */
export declare function evaluationScorerRegistry(definitions?: EvaluationScorerDefinition[]): ReadonlyMap<string, EvaluationScorerDefinition>;
//# sourceMappingURL=evaluations.d.ts.map