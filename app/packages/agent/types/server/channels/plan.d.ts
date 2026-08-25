import type { AgentMessage, AgentSession } from '../../common/types';
import { type ChannelProfile, type DeliveryItem } from '../../common/channel-contract';
/**
 * The shared planner (channels spec §8.2): decide WHAT a surface receives.
 * Everything here is pure — same rows in, same items out — which is what makes
 * redelivery after a crash reproduce the same payload, and what makes the
 * planner testable with plain arrays.
 *
 * The line it draws (§7): the turn's ANSWER is an assistant row with no
 * `toolCalls` (a row WITH them is committed before dispatch and is
 * intermediate planning, not an answer). Notes are opt-in per channel via
 * `statuses`. Everything else — user rows, tool rows, planning rows,
 * un-opted notes — is advanced past silently: the cursor still moves, nothing
 * posts.
 */
export interface PlanOptions {
    /** Which note kinds this channel delivers as `status` items. The `approval`
     *  note is the POST-VERDICT audit outcome — the ask itself is never a
     *  status; it is always the `prompt` item (§8.2). */
    statuses?: ReadonlyArray<NonNullable<AgentMessage['kind']>>;
    profile: ChannelProfile;
    /** The session's web view, when the audience rules allow linking to it
     *  (§8.5): for an ANONYMOUS session the URL is the credential, so the caller
     *  passes it only for a `direct` destination; an owned session's URL is
     *  login-gated and may go anywhere. Absent = overflow carries no link. */
    overflowUrl?: string;
}
/** One planned row: the message (for its `seq` and `_id` — the receipt key and
 *  the cursor advance) and what to send for it, `null` meaning "advance past,
 *  post nothing". */
export interface PlannedRow {
    message: AgentMessage;
    item: DeliveryItem | null;
}
/**
 * Plan the tail of a transcript for one surface. `messages` are the rows past
 * the binding's cursor, in seq order — the caller reads them with the same
 * `{ sessionId, seq }` range scan every transcript consumer uses.
 */
export declare function planItems(messages: AgentMessage[], opts: PlanOptions): PlannedRow[];
/**
 * The parked approval as a `prompt` item — built from `session.pending`, never
 * from a note (§8.2), and only while the ask is still UNANSWERED. `toolCallId`
 * rides along so the receipt's `expects` can name the exact ask a reply
 * answers (§8.3's staleness rule).
 *
 * The profile decides the grammar the choices carry: `menu` choices get their
 * reply `match` words here — the single source the lens renders from and the
 * worker registers — and `link` choices get their single-use `url`s later, at
 * delivery time, because minting a token is I/O and the planner is pure.
 */
export declare function promptItem(session: AgentSession, profile: ChannelProfile): Extract<DeliveryItem, {
    item: 'prompt';
}> | null;
//# sourceMappingURL=plan.d.ts.map