import type { AgentMessage, AgentSession } from '../../common/types';
import { MENU_MATCHES, type ChannelProfile, type DeliveryItem } from './contract';

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

/** A reply over the profile's limit becomes a MECHANICAL head-slice — the
 *  worker never calls a model, so there is no summarization, only a slice with
 *  room reserved for the ellipsis and the link. */
function overflow(text: string, limit: number, url?: string): DeliveryItem {
  const reserve = 2 + (url ? url.length + 1 : 0);
  let end = Math.max(1, limit - reserve);
  // Never cut a surrogate pair: a lone high surrogate is a payload providers
  // reject deterministically (see egress.ts MAX_DELIVERY_ATTEMPTS).
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  const head = `${text.slice(0, end)}…`;
  return { item: 'overflow', head, ...(url !== undefined ? { url } : {}) };
}

function itemFor(message: AgentMessage, opts: PlanOptions): DeliveryItem | null {
  if (message.role === 'assistant') {
    // The turn-final signal: no toolCalls. Empty text is possible (a turn that
    // ended on a refusal note) — nothing to say is nothing to post.
    if (message.toolCalls && message.toolCalls.length > 0) return null;
    const text = message.content ?? '';
    if (text === '') return null;
    const limit = opts.profile.limit;
    if (limit !== undefined && text.length > limit) {
      return overflow(text, limit, opts.overflowUrl);
    }
    return { item: 'reply', text };
  }
  if (message.role === 'note' && message.kind && opts.statuses?.includes(message.kind)) {
    return {
      item: 'status',
      kind: message.kind,
      ...(message.reason !== undefined ? { reason: message.reason } : {}),
      ...(message.approved !== undefined ? { approved: message.approved } : {}),
      ...(message.budget !== undefined ? { budget: message.budget } : {}),
    };
  }
  return null;
}

/**
 * Plan the tail of a transcript for one surface. `messages` are the rows past
 * the binding's cursor, in seq order — the caller reads them with the same
 * `{ sessionId, seq }` range scan every transcript consumer uses.
 */
export function planItems(messages: AgentMessage[], opts: PlanOptions): PlannedRow[] {
  return messages.map((message) => ({ message, item: itemFor(message, opts) }));
}

/**
 * The parked approval as a `prompt` item — built from `session.pending`, never
 * from a note (§8.2), and only while the ask is still UNANSWERED. `toolCallId`
 * rides along so the receipt's `expects` can name the exact ask a reply
 * answers (§8.3's staleness rule).
 *
 * The profile decides the grammar the choices carry: `menu` choices get their
 * reply `match` words here — the single source the lens renders from and the
 * worker registers — and `link` choices get their signed `url`s later, at
 * delivery time, because minting a token is I/O and the planner is pure.
 */
export function promptItem(
  session: AgentSession, profile: ChannelProfile,
): Extract<DeliveryItem, { item: 'prompt' }> | null {
  const pending = session.pending;
  if (session.phase !== 'awaiting' || !pending || pending.verdict) return null;
  const menu = profile.interact === 'menu';
  return {
    item: 'prompt',
    name: pending.name,
    args: pending.args,
    // Presence, not truthiness: `runAs: null` is the anonymous service
    // context, a fact an approver is entitled to see (see the session type).
    ...('runAs' in pending ? { runAs: pending.runAs } : {}),
    toolCallId: pending.toolCallId,
    choices: [
      { token: 'approve', label: 'Approve', ...(menu ? { match: MENU_MATCHES.approve } : {}) },
      { token: 'deny', label: 'Deny', ...(menu ? { match: MENU_MATCHES.deny } : {}) },
    ],
  };
}

export { expectationsFor, matchExpectation } from './contract';
