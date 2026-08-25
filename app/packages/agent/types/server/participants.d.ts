import { type AgentSession, type SessionParticipant } from '../common/types';
export interface AddParticipantOptions {
    /** The participant id performing the add, recorded as `addedBy`. */
    by?: string;
    /** Display name for the OWNER's seeded row, used only when this add is the
     *  one that materializes the roster. Default 'owner'. */
    ownerName?: string;
}
/**
 * Add one participant to a session's roster, seeding it first if this is the
 * first join. Returns the participant's id, or null when the session is gone
 * or the roster is full.
 *
 * TWO single-winner writes, deliberately (a reviewer-found race: two racing
 * first-joins each passing a per-id guard would BOTH seed, duplicating the
 * owner and primary rows):
 *
 *   1. Materialization — `$set` of the complete seed, filtered on
 *      `participants: { $exists: false }`. Exactly one racer lands it; the
 *      loser's zero-match is not an error, the roster simply already exists.
 *   2. The join itself — `$push` filtered on `'participants.id' != id` (and
 *      the cap), so two racing joins of the same id resolve to one row and
 *      two different ids both land.
 *
 * Adding a participant who is already present ADOPTS the existing row (the
 * id collides, the push no-ops) — which is what makes compose's
 * crash-recovery re-run and a repeat compose to the same recipient both
 * idempotent here.
 */
export declare function addParticipant(sessionId: string, participant: Omit<SessionParticipant, 'joinedAt' | 'displayName'> & {
    displayName?: string;
}, opts?: AddParticipantOptions): Promise<string | null>;
/**
 * Remove a member from the roster (§4.6). REFUSED for the owner row —
 * ownership transfer is a named open question, and a session whose owner
 * evaporated would break every anchor the scalar owner holds. Returns whether
 * a row was removed.
 *
 * Binding teardown rides with it: the member's `member: true` bindings are
 * DELETED — egress consults only bindings, so removal without teardown would
 * keep mailing the departed member every future reply forever. The roster
 * removal is what makes ingress refuse their next event, because admission
 * reads the roster; a live web subscription is revoked on reconnect (the
 * publication authorizes at subscribe time — named and accepted, §4.6).
 */
export declare function removeParticipant(sessionId: string, participantId: string): Promise<boolean>;
/** The roster, read fresh. Empty array when absent — the classic pair. */
export declare function listParticipants(sessionId: string): Promise<SessionParticipant[]>;
/**
 * The newest user row's ADDRESSEE, iff that addressee has not answered it —
 * the shared "unanswered tail" predicate (decision 6). ADDRESSEE-AWARE,
 * which is the load-bearing part: an addressed interjection is typically
 * followed by the RUNNING model's own reply at a higher seq, so "any
 * assistant row after the user row" reads answered when the addressee never
 * spoke (a reviewer-confirmed strand). For an addressed row, only an
 * assistant row FROM that addressee counts as its answer; for an unaddressed
 * row, any assistant row does (the primary's business, today's rule). Null =
 * nothing owed.
 */
export declare function unansweredAddressee(session: AgentSession): Promise<{
    id: string;
    agent: string;
} | null>;
/**
 * WHICH AGENT should answer a wake of this session (decision 6) — resolved
 * from durable state at wake time, never trusted from the argument a caller
 * happened to hold:
 *
 *   1. `pending.agent` — a parked (or verdict-carrying) turn belongs to the
 *      model that parked it.
 *   2. `pendingRelay.agent` — a scheduled relay belongs to its addressee.
 *   3. The newest user row's UNANSWERED addressee (rostered sessions,
 *      addressee-aware — see `unansweredAddressee`): a send addressed to a
 *      non-primary model whose deferred turn was dropped by the running/
 *      lease guards must not be answered by the primary, even when the
 *      running model's own reply committed after it.
 *   4. A mid-flight addressed turn's own tail: the newest assistant row still
 *      carrying unanswered toolCalls names its author in `from` — orphan
 *      recovery must resume that batch as that model.
 *   5. `session.agent` — the primary, today's answer.
 */
export declare function resolveWakeAgent(session: AgentSession): Promise<string>;
//# sourceMappingURL=participants.d.ts.map