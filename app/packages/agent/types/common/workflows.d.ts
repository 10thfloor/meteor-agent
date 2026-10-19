/** A workflow is a versioned graph of developer-owned primitives. No source
 * code, dynamic imports, expressions, or tool entitlements come from its JSON. */
export type WorkflowStrategy = 'workflow' | 'supervisor' | 'handoff' | 'council';
export type WorkflowReplay = 'safe' | 'idempotent' | 'guarded' | 'never';
export type WorkflowStatus = 'queued' | 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled';
export type WorkflowStepStatus = 'pending' | 'running' | 'awaiting' | 'completed' | 'skipped' | 'failed' | 'cancelled';
/** Conditions select among typed answers, never expressions or executable code. */
export type WorkflowCondition = {
    stepId: string;
    questionId: string;
    type: 'choice' | 'score' | 'noul';
    operator: 'eq' | 'neq' | 'gte' | 'gt' | 'lte' | 'lt';
    value: string | number;
    minConfidence?: number;
} | {
    stepId: string;
    otherwise: true;
};
export interface WorkflowBranchField {
    type: 'choice' | 'score' | 'noul';
    choices?: string[];
    min?: number;
    max?: number;
}
export interface WorkflowStep {
    id: string;
    label: string;
    primitive: string;
    version: number;
    input: Record<string, unknown>;
    dependsOn: string[];
    requireApproval?: boolean;
    when?: WorkflowCondition;
    /** Wait for every dependency to settle, then continue if at least one ran. */
    dependencyMode?: 'all' | 'any';
}
export interface WorkflowBudget {
    steps: number;
    timeoutMs: number;
    turns: number;
    toolCalls: number;
    spend: number;
}
export interface WorkflowDefinition {
    id: string;
    revision: number;
    name: string;
    strategy: WorkflowStrategy;
    steps: WorkflowStep[];
    budget: WorkflowBudget;
}
export interface WorkflowStepState {
    id: string;
    label: string;
    primitive: string;
    agent?: string;
    status: WorkflowStepStatus;
    /** Distinguishes background work from a request for a person's decision. */
    waitReason?: 'processing' | 'approval';
    attempts: number;
    fingerprint: string;
    idempotencyKey: string;
    /** A persisted receipt belongs to this exact primitive input and version. */
    receipt?: Record<string, unknown>;
    output?: unknown;
    summary?: string;
    error?: string;
    replayAllowed?: boolean;
    retryAllowed?: boolean;
    approval?: {
        fingerprint: string;
        approved: boolean;
        userId: string;
        at: Date;
    };
    childSessionId?: string;
    startedAt?: Date;
    completedAt?: Date;
}
export interface WorkflowRun {
    _id: string;
    namespace: string;
    userId: string;
    missionId: string;
    definitionRevision: number;
    name: string;
    strategy: WorkflowStrategy;
    definition: WorkflowDefinition;
    definitionHash: string;
    status: WorkflowStatus;
    states: Record<string, WorkflowStepState>;
    executions: number;
    createdAt: Date;
    updatedAt: Date;
    finishedAt?: Date;
    /** Approval waits do not expire a run; each activation is time-bounded. */
    activeMs: number;
    error?: string;
    parentRunId?: string;
    replayFrom?: string;
    lease?: {
        token: string;
        until: Date;
    };
}
export interface WorkflowStepResult {
    output?: unknown;
    summary?: string;
    receipt?: Record<string, unknown>;
    childSessionId?: string;
    /** External work/approval can remain durable without occupying a worker. */
    waiting?: boolean;
    waitReason?: 'processing' | 'approval';
}
//# sourceMappingURL=workflows.d.ts.map