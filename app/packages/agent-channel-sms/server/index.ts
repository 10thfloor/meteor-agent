import { createHmac } from 'crypto';
import {
  attachmentNotice, channelKnobs, headerValue, isLinkGesture, promptDisplay, safeEqual,
  type ChannelDef, type ChannelKnobs, type ChannelProfile, type ChannelTransport,
  type DeliveryItem, type InboundReading, type Lens, type RawInbound,
} from 'meteor/10thfloor:agent';

/**
 * The SMS channel (Twilio): one lens, one transport, one profile default —
 * and the spec's designated stress test for the whole design, because SMS has
 * NONE of the affordances the richer surfaces lean on: no buttons, no
 * threads, no markup, 160-character segments, and identity that is only a
 * phone number. Zero npm dependencies — Twilio's REST API is form-encoded
 * HTTPS over `fetch`, its signature scheme is HMAC-SHA1 over node `crypto`.
 *
 * The five decisions:
 *
 *  CONVERSATION KEY — the NUMBER PAIR, `${ourNumber}:${theirNumber}`. A
 *  phone's message thread is one ongoing conversation; keying by anything
 *  finer is the DM-amnesia bug. Both numbers, not just theirs, so an app
 *  running several Twilio numbers keeps them as distinct conversations.
 *
 *  IDENTITY KEY — the sender's E.164 number. Weak identity by nature (SIM
 *  swap is routine — the spec's §12 words): fine for "what's my order
 *  status", never for anything privileged without a real link.
 *
 *  AUDIENCE — always `direct`. SMS is one recipient by construction, which
 *  makes it the one surface where an anonymous session's capability URL may
 *  always travel (§8.5).
 *
 *  INTERACTION — `menu`, the grammar this surface exists to prove: prompts
 *  render as "Reply YES to approve, NO to deny", the reply words are
 *  REGISTERED in the delivery receipt's `expects`, and the shared pipeline —
 *  not this lens — turns a later "yes" into a verdict. Render and parse are
 *  one artifact by construction.
 *
 *  ECHO RULE — Twilio only webhooks INBOUND messages, so the self-reply loop
 *  cannot form; what must still be dropped is delivery-status callbacks
 *  (`MessageStatus` posts with no inbound body), noops by design.
 */

// ---- Text: minimal Markdown → plain ----------------------------------------

/**
 * The per-surface conversion opt-in (§8.5), in the opposite direction from
 * Slack's: SMS renders nothing, so markdown DECORATION is stripped —
 * `**bold**` and `_italic_` markers, heading hashes — while links keep both
 * halves as "label (url)", because on a phone the words and the address are
 * each worth keeping.
 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '');
}

// ---- Status prose ----------------------------------------------------------

function statusProse(item: Extract<DeliveryItem, { item: 'status' }>): string {
  switch (item.kind) {
    case 'error':
      return `Something went wrong${item.reason ? ` (${item.reason})` : ''}. Text again to retry.`;
    case 'budget':
      return `This conversation reached its ${item.budget ?? 'usage'} limit.`;
    case 'interrupted':
      return 'The reply was stopped.';
    case 'approval':
      // The structured flag, not the note's prose: a timeout is a denial that
      // nobody made, and the surface must say so rather than imply a refusal.
      if (item.timedOut) return 'The approval request timed out and was denied.';
      return item.approved ? 'Approved.' : 'Denied.';
    case 'compaction':
      return 'Earlier conversation was summarized.';
    case 'orphan-child':
      return 'A background task was recovered.';
    default:
      return `[${item.kind}]${item.reason ? ` ${item.reason}` : ''}`;
  }
}

// ---- Verify: Twilio's signature --------------------------------------------

export function parseTwilioForm(rawBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawBody)) out[k] = v;
  return out;
}

/**
 * Twilio's scheme, exactly as documented: base64(HMAC-SHA1(authToken,
 * webhookUrl + concat(sortedKey + value…))) must equal `X-Twilio-Signature`.
 * The signature covers the FULL PUBLIC URL Twilio was configured with —
 * scheme, host, path — which a server behind a tunnel or proxy cannot learn
 * from the request it receives, so the channel takes `webhookUrl` as
 * configuration and the two must match to the character.
 */
export function verifyTwilioSignature(
  raw: RawInbound, authToken: string, webhookUrl: string,
): boolean {
  const signature = headerValue(raw, 'x-twilio-signature');
  if (!signature) return false;
  const params = parseTwilioForm(raw.rawBody);
  const data = webhookUrl + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', authToken).update(data).digest('base64');
  return safeEqual(signature, expected);
}

// ---- The lens --------------------------------------------------------------

const NOOP: InboundReading = { intent: { kind: 'noop' } };

export const smsLens: Lens = {
  out(item: DeliveryItem): unknown {
    switch (item.item) {
      case 'reply':
        // The naming clause: SMS carries no bytes (MMS is future work), so
        // each file appears as a text line naming it.
        return { body: `${toPlainText(item.text)}${attachmentNotice(item.attachments)}` };
      case 'status':
        return { body: statusProse(item) };
      case 'overflow':
        return { body: `${toPlainText(item.head)}${item.url ? ` ${item.url}` : ''}${attachmentNotice(item.attachments)}` };
      case 'prompt': {
        const args = JSON.stringify(item.args ?? {});
        const clamped = args.length > 300 ? `${args.slice(0, 300)}…` : args;
        // The display clause — and on THIS surface the tool's account replaces
        // the arguments rather than leading them. The contract allows either;
        // here it is the only honest choice. A 1500-character body carries the
        // menu and about one sentence, and a JSON fragment clamped at 300 is
        // neither readable at a glance nor a faithful record of what was asked,
        // so it earns none of the room it costs. Where no `display` was
        // hydrated the args still beat silence, so they stay as the fallback.
        const display = promptDisplay(item.display, { limit: 900 });
        const what = display
          ? `${item.name}: ${display}${/[.!?…]$/.test(display) ? '' : '.'}`
          : `${item.name}(${clamped}).`;
        const runAs = 'runAs' in item && item.runAs !== undefined
          ? ` It runs as ${item.runAs ?? 'the anonymous service context'}.` : '';
        // The reply menu IS the interaction contract: these words came from
        // the planner's choices (MENU_MATCHES), the worker registers the very
        // same words in the receipt's expects, and the pipeline matches the
        // answer — one artifact, three readers, no drift possible.
        const menu = item.choices
          .filter((c) => c.match !== undefined)
          .map((c) => `${c.match} to ${c.label.toLowerCase()}`)
          .join(', or ');
        return {
          body: `The agent wants to run ${what}${runAs} Reply ${menu}.`,
        };
      }
      default:
        return null;
    }
  },

  in(event: unknown): InboundReading {
    const p = event as Record<string, string>;
    if (!p || typeof p !== 'object') return NOOP;
    const body = (p.Body ?? '').trim();

    // MMS media ride as REFERENCES (participants spec §6): `MediaUrl<i>` on
    // api.twilio.com (which 302s to Twilio's CDN — the core fetcher re-checks
    // the redirect against the factory's host list). Twilio reports no size
    // up front; the streaming abort is the ceiling.
    const media: Array<{ name: string; contentType: string; url: string }> = [];
    const n = Number(p.NumMedia ?? 0) || 0;
    for (let i = 0; i < n; i += 1) {
      const url = p[`MediaUrl${i}`];
      if (typeof url === 'string' && url !== '') {
        media.push({
          name: `media-${i + 1}`,
          contentType: p[`MediaContentType${i}`] ?? 'application/octet-stream',
          url,
        });
      }
    }
    // A delivery-status callback, not an inbound message — noop by design.
    // The sharpened guard (participants spec §6.3): an image-only MMS is a
    // MESSAGE, not a noop.
    if ((body === '' && media.length === 0) || !p.From || !p.To) return NOOP;

    const envelope = {
      eventId: p.MessageSid ?? p.SmsSid,
      externalUserId: p.From,
      conversationRef: `${p.To}:${p.From}`,
      destination: { to: p.From, from: p.To },
      audience: 'direct' as const,
    };
    // The core's link gesture, unguarded: SMS is `direct` by construction, so
    // the DM-only surface rule the group-capable lenses apply has nothing to
    // restrict here.
    if (isLinkGesture(body)) return { intent: { kind: 'link-request' }, ...envelope };
    // Everything else is a message — INCLUDING "YES"/"NO": whether those
    // decide a parked approval is the PIPELINE's call, made against the
    // receipt's registered expects (§8.3), never this stateless lens's.
    return {
      intent: { kind: 'message', text: body },
      ...envelope,
      ...(media.length > 0 ? { attachments: media } : {}),
    };
  },
};

// ---- The transport ---------------------------------------------------------

export interface SmsTransportOptions {
  accountSid: string;
  authToken: string;
  /** TEST SEAM: the fetch to use. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * `Messages.json`, nothing else. Twilio's Messages API accepts no client
 * idempotency key, so the channel's honest recovery tier for a crash between
 * post and confirm is `retry` — a rare duplicate text rather than a lost one
 * — declared by default and overridable.
 */
export function smsTransport(options: SmsTransportOptions): ChannelTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const auth = Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64');
  return {
    async post(destination: unknown, payload: unknown) {
      const dest = (destination ?? {}) as { to?: string; from?: string };
      const body = (payload ?? {}) as { body?: string };
      const form = new URLSearchParams({
        To: dest.to ?? '',
        From: dest.from ?? '',
        Body: body.body ?? '',
      });
      const res = await doFetch(
        `https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${auth}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        },
      );
      const json: any = await res.json();
      if (!res.ok || json?.error_code || !json?.sid) {
        throw new Error(
          `[agent-channel-sms] Messages.json failed: ${json?.message ?? json?.error_code ?? res.status}`,
        );
      }
      return { providerMessageId: json.sid as string };
    },
  };
}

// ---- The factory (§8.7 tier 1) ---------------------------------------------

/** The five core knobs (`statuses`, `onUncertainDelivery`, `sessionUrl`,
 *  `linkUrl`, `throttle`) come from `ChannelKnobs` — the core's own types,
 *  forwarded untouched — plus what Twilio itself needs. */
export interface SmsChannelOptions extends ChannelKnobs {
  /** The registered agent this number fronts. */
  agent: string;
  /** Twilio Account SID (`AC…`). */
  accountSid: string;
  /** Twilio auth token — also the signature key. */
  authToken: string;
  /** The EXACT public URL configured as the number's messaging webhook —
   *  Twilio's signature covers it, so a mismatch (scheme, host, trailing
   *  slash) is a 401 on every request. */
  webhookUrl: string;
  /** Override the default `limit: 1500`. `interact` is fixed at `menu` — the
   *  reply-word grammar is how this lens answers prompts at all. */
  profile?: Pick<ChannelProfile, 'limit'>;
  /** Set when the Twilio account enforces HTTP auth on media URLs (an account
   *  setting; media is publicly fetchable by default): the fetcher then sends
   *  Basic `accountSid:authToken`. */
  mediaAuth?: boolean;
  /** TEST SEAM, threaded to the transport. */
  fetchImpl?: typeof fetch;
}

export function sms(options: SmsChannelOptions): ChannelDef {
  if (!options?.agent) throw new Error('[agent-channel-sms] sms({ agent }) is required');
  if (!options.accountSid) throw new Error('[agent-channel-sms] sms({ accountSid }) is required');
  if (!options.authToken) throw new Error('[agent-channel-sms] sms({ authToken }) is required');
  if (!options.webhookUrl) throw new Error('[agent-channel-sms] sms({ webhookUrl }) is required');
  return {
    agent: options.agent,
    transport: smsTransport({
      accountSid: options.accountSid, authToken: options.authToken, fetchImpl: options.fetchImpl,
    }),
    lens: smsLens,
    // 1500, under Twilio's hard 1600-character API cap with room for the
    // overflow link — long answers become a head-slice plus the web URL,
    // which on this always-`direct` surface may always be sent (§8.5).
    profile: { interact: 'menu', limit: options.profile?.limit ?? 1500 },
    verify: (raw) => verifyTwilioSignature(raw, options.authToken, options.webhookUrl),
    parse: (raw) => parseTwilioForm(raw.rawBody),
    // Note kinds delivered as statuses: the errors a texter must hear about,
    // and the approval outcome that closes a "Reply YES" exchange.
    statuses: options.statuses ?? ['error', 'approval'],
    // The media recipe (participants spec §6): MediaUrl fetches are anonymous
    // by default (Basic auth only when the account enforces media auth —
    // `mediaAuth: true`). The CDN host is NOT contractual Twilio API surface;
    // it is pinned here as a named maintenance liability — if Twilio moves
    // its media CDN, this list is the one line that follows it.
    media: {
      hosts: ['api.twilio.com', 'media.twiliocdn.com'],
      ...(options.mediaAuth ? {
        request: (att) => ({
          url: att.url ?? '',
          headers: {
            authorization: `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`,
          },
        }),
      } : {}),
    },
    // Every knob the core names, forwarded by one helper — a knob added to
    // ChannelKnobs tomorrow is forwarded here without this file changing.
    ...channelKnobs(options),
  };
}
