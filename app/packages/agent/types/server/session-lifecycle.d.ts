/** Outcome deliberately hides whether an id belonged to another owner/agent. */
export type SessionErasure = 'erased' | 'absent';
/** Result of fencing parked work for one Agent identity. The host must first
 * make that Agent unavailable (for example by committing an archive status),
 * so no fresh turn can create another park while this finite sweep runs. */
export interface AbandonedAgentTurns {
    sessions: number;
    toolCalls: string[];
}
/** Cancel every parked turn owned by one Agent for an exact Session owner.
 *
 * The Session fence lands before transcript cleanup. That ordering makes a
 * racing approval lose its conditional write and revokes any resume Lease;
 * should best-effort cleanup be interrupted, the ordinary unanswered-tool-use
 * repair removes the now-unreferenced assistant batch before the next turn.
 * Agent-owned learning is deliberately untouched.
 *
 * Host lifecycle primitive used after its own availability fence. It is
 * exported for applications that archive Agent definitions outside the core. */
export declare function abandonPendingAgentTurns(agent: string, userId: string | null): Promise<AbandonedAgentTurns>;
//# sourceMappingURL=session-lifecycle.d.ts.map