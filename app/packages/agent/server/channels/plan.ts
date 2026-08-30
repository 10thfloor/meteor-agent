import type { AgentMessage, AgentSession } from '../../common/types';
import { MENU_MATCHES, type ChannelProfile, type DeliveryItem } from '../../common/channel-contract';

/* Shared planner (§8.2): pure function — same rows in, same items out.
 * An ANSWER is an assistant row with no toolCalls; notes are opt-in via
 * `statuses`; everything else advances past silently. */

export interface PlanOptions {
  /** Which note kinds to deliver as `status` items. */
  statuses?: ReadonlyArray<NonNullable<AgentMessage['kind']>>;
  profile: ChannelProfile;
  /** Session web URL for overflow links (§8.5). Absent = no link. */
  overflowUrl?: string;
  /** Opaque source token of the binding being planned. Channel human rows
   *  skip only a matching origin; every other binding may receive them. */
  origin?: string;
}

/** One planned row: the message and its delivery item, or null (advance past). */
export interface PlannedRow {
  message: AgentMessage;
  item: DeliveryItem | null;
}

/** Head-slice a reply over the profile's limit — no summarization. */
function overflow(text: string, limit: number, url?: string): DeliveryItem {
  const reserve = 2 + (url ? url.length + 1 : 0);
  let end = Math.max(1, limit - reserve);
  // Never cut a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  const head = `${text.slice(0, end)}…`;
  return { item: 'overflow', head, ...(url !== undefined ? { url } : {}) };
}

function itemFor(message: AgentMessage, opts: PlanOptions): DeliveryItem | null {
  const source = message.source;
  // Trusted Desktop input fans out everywhere. New Channel input carries a
  // random binding token and fans out everywhere EXCEPT its exact origin.
  // Legacy source-less / channel-without-origin rows stay local: guessing an
  // origin would create an echo on the surface the person just used.
  const outwardHuman = message.role === 'user'
    && (source?.kind === 'desktop'
      || (source?.kind === 'channel' && !!source.origin && source.origin !== opts.origin));
  if (outwardHuman) {
    const rawName = message.from?.name
      ?? (source?.kind === 'channel' ? 'Channel participant' : 'Desktop');
    // Attribution should remain one bounded line even for hand-inserted legacy
    // roster data that predates display-name sanitization.
    // eslint-disable-next-line no-control-regex
    const name = rawName.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || 'Desktop';
    const surface = source?.kind === 'channel'
      ? ` · ${source.channel.replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'Channel'}`
      : '';
    const label = message.kind === 'crew-note'
      ? `${name}${surface} · crew note`
      : `${name}${surface}`;
    const text = `${label}: ${message.content ?? ''}`;
    const limit = opts.profile.limit;
    if (limit !== undefined && text.length > limit) {
      return overflow(text, limit, opts.overflowUrl);
    }
    return { item: 'reply', text };
  }
  if (message.role === 'assistant') {
    // Model-to-model deliberation: channels advance past it.
    if (message.to?.startsWith('m:')) return null;
    // Turn-final = no toolCalls. Empty text + no attachments = nothing to post.
    if (message.toolCalls && message.toolCalls.length > 0) return null;
    const text = message.content ?? '';
    if (text === '' && !(message.attachments?.length)) return null;
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
      ...(message.timedOut !== undefined ? { timedOut: message.timedOut } : {}),
      ...(message.budget !== undefined ? { budget: message.budget } : {}),
    };
  }
  return null;
}

/** Plan the tail of a transcript for one surface. */
export function planItems(messages: AgentMessage[], opts: PlanOptions): PlannedRow[] {
  return messages.map((message) => ({ message, item: itemFor(message, opts) }));
}

/** Build the `prompt` item from a parked approval. Menu choices get
 *  match words here; link choices get URLs at delivery time (I/O). */
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
    // Park-time legibility line, passed through untouched.
    ...(pending.display !== undefined ? { display: pending.display } : {}),
    // Presence, not truthiness: `runAs: null` is a real value.
    ...('runAs' in pending ? { runAs: pending.runAs } : {}),
    toolCallId: pending.toolCallId,
    choices: [
      { token: 'approve', label: 'Approve', ...(menu ? { match: MENU_MATCHES.approve } : {}) },
      { token: 'deny', label: 'Deny', ...(menu ? { match: MENU_MATCHES.deny } : {}) },
    ],
  };
}
