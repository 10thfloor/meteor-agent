import { type AgentMessage, type AgentSession, type SessionParticipant } from '../common/types';
export interface AddParticipantOptions {
    /** The participant id performing the add, recorded as `addedBy`. */
    by?: string;
    /** Display name for the owner's seeded row (default 'owner'). */
    ownerName?: string;
}
/** Add a participant, seeding the roster on first join. Two single-winner
 *  writes avoid a race where concurrent first-joins duplicate seed rows.
 *  Re-adding an existing id is an idempotent adopt. */
export declare function addParticipant(sessionId: string, participant: Omit<SessionParticipant, 'joinedAt' | 'displayName'> & {
    displayName?: string;
}, opts?: AddParticipantOptions): Promise<string | null>;
/** Remove a member (§4.6). Refused for the owner. Also deletes the member's
 *  bindings so egress stops routing to the departed participant. */
export declare function removeParticipant(sessionId: string, participantId: string): Promise<boolean>;
/** Read the roster fresh; empty array when absent. */
export declare function listParticipants(sessionId: string): Promise<SessionParticipant[]>;
/** The addressee of one exact user row, if that addressee has not answered it.
 * Addressee-aware: only a later reply FROM that model counts. */
export declare function unansweredMessageAddressee(session: AgentSession, user: AgentMessage): Promise<{
    id: string;
    agent: string;
} | null>;
/** Compatibility query for callers that intentionally ask about the newest
 * user row rather than a durable Transcript Commit link. */
export declare function unansweredAddressee(session: AgentSession): Promise<{
    id: string;
    agent: string;
} | null>;
/** Resolve which agent should answer a wake, from durable state:
 *  pending.agent > pendingRelay > unanswered addressee > pendingSystem >
 *  mid-flight tool author > primary. */
export declare function resolveWakeAgent(session: AgentSession): Promise<string>;
//# sourceMappingURL=participants.d.ts.map