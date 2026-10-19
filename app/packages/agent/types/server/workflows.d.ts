import { Mongo } from 'meteor/mongo';
import type { WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepResult, WorkflowStepState, WorkflowReplay, WorkflowBranchField, WorkflowCondition } from '../common/workflows';
export * from '../common/workflows';
export declare const AgentWorkflowRuns: Mongo.Collection<WorkflowRun, WorkflowRun>;
/** Canonical, bounded JSON also prevents Mongo path/operator injection. */
export declare function workflowCanonical(value: unknown): string;
export declare const workflowFingerprint: (value: unknown) => string;
export interface WorkflowContext {
    run: WorkflowRun;
    step: WorkflowStep;
    state: WorkflowStepState;
    userId: string;
    missionId: string;
    signal: AbortSignal;
    idempotencyKey: string;
    outputs: Record<string, unknown>;
    /** Re-read lease, cancellation and host authorization before external work. */
    assertActive(): Promise<void>;
    /** Save a reconciliation receipt before a side effect can become ambiguous. */
    checkpoint(receipt: Record<string, unknown>, extra?: {
        childSessionId?: string;
    }): Promise<void>;
}
export interface WorkflowPrimitive {
    name: string;
    version: number;
    label: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    replay: WorkflowReplay;
    /** Approval policy is developer-owned; a JSON graph can only tighten it. */
    requireApproval?: boolean;
    /** Developer-owned contract for branching on output.answers. */
    branchSchema?(input: Record<string, unknown>): Record<string, WorkflowBranchField>;
    execute(input: Record<string, unknown>, context: WorkflowContext): Promise<WorkflowStepResult>;
    /** Guarded replay must inspect actual receipts, not a model's assertion. */
    canReplay?(state: WorkflowStepState, run: WorkflowRun): Promise<boolean>;
    /** Optional reconciliation guard for idempotent primitives with terminal
     * external receipts that must not be repeated. */
    canRetry?(state: WorkflowStepState, run: WorkflowRun): Promise<boolean>;
    cancel?(state: WorkflowStepState, run: WorkflowRun): Promise<void>;
}
/** Fail closed on missing or malformed answers, including on fallback branches. */
export declare function workflowConditionMatches(condition: Exclude<WorkflowCondition, {
    otherwise: true;
}>, output: unknown): boolean;
export interface WorkflowEngineOptions {
    namespace: string;
    /** Required and checked at start, resume and each execution boundary. */
    authorize(userId: string, missionId: string, step?: WorkflowStep): Promise<boolean>;
}
/** Recovery and approval resumes enter the existing Agent runtime, so its
 * host fence resolves the same live workflow authority as the graph worker. */
export declare function assertWorkflowRunAuthority(run: WorkflowRun, step?: WorkflowStep): Promise<void>;
/** Each host owns its registry. Changing implementation requires a new
 * primitive version; persisted graphs continue to resolve their exact version. */
export declare class WorkflowEngine {
    private readonly options;
    private primitives;
    private active;
    private polling;
    constructor(options: WorkflowEngineOptions);
    register(primitive: WorkflowPrimitive): this;
    catalog(): Array<Omit<WorkflowPrimitive, 'execute' | 'canReplay' | 'canRetry' | 'cancel' | 'branchSchema'>>;
    private primitive;
    private policyHints;
    validate(value: WorkflowDefinition): Promise<WorkflowDefinition>;
    get(runId: string, userId: string): Promise<WorkflowRun>;
    private permitted;
    start(args: {
        userId: string;
        missionId: string;
        definition: WorkflowDefinition;
        requestKey: string;
    }): Promise<string>;
    wake(runId: string): void;
    private write;
    drive(runId: string): Promise<void>;
    private execute;
    approve(args: {
        runId: string;
        userId: string;
        stepId: string;
        fingerprint: string;
        approved: boolean;
    }): Promise<void>;
    cancel(runId: string, userId: string): Promise<void>;
    retry(runId: string, userId: string, stepId: string): Promise<void>;
    replay(args: {
        runId: string;
        userId: string;
        stepId: string;
        requestKey: string;
    }): Promise<string>;
    /** Recover queued/interrupted runs and reconcile durable external waits. */
    poll(): Promise<void>;
}
//# sourceMappingURL=workflows.d.ts.map