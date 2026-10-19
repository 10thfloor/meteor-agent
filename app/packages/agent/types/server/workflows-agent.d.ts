import { type TurnOutcome } from './subagent';
import { type WorkflowPrimitive } from './workflows';
/** Host provider and tool fences call this on every resumed execution. The
 * allocations are durable, so rebuilding Crew config cannot reset a budget. */
export declare function assertWorkflowSessionExecution(sessionId: string, opts?: {
    toolCall?: boolean;
    /** Source-bound, tool-free post-turn reflection may outlive successful work.
     * Hosts must opt in only at their dedicated reflection Provider boundary. */
    reflection?: boolean;
}): Promise<void>;
/** The outcome reader spans Session and Transcript reads. Activation can start
 * or finish an approved Turn between them, so accept terminal output only
 * from an unchanged, quiescent checkpoint. A changed snapshot is reconciled
 * on the next poll; it is never treated as failure or an earlier answer. */
export declare function readWorkflowAgentOutcome(sessionId: string): Promise<TurnOutcome | {
    ok: false;
    kind: 'processing';
}>;
/** Reuses the existing Session/Turn/Tool/approval runtime. Deterministic child
 * birth plus the persisted receipt lets retries adopt, never duplicate, work. */
export declare function workflowAgentPrimitive(): WorkflowPrimitive;
export declare function workflowApprovalPrimitive(): WorkflowPrimitive;
//# sourceMappingURL=workflows-agent.d.ts.map