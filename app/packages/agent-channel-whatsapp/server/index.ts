import { createHmac, timingSafeEqual } from 'crypto';
import type {
  ChannelDef, ChannelProfile, ChannelTransport, DeliveryItem, InboundReading,
  Lens, RawInbound,
} from 'meteor/10thfloor:agent';

/**
 * The WhatsApp channel (Meta's Cloud API): one lens, one transport, one
 * profile default. Zero npm dependencies — the Graph API is JSON over
 * `fetch`, webhook authentication is `X-Hub-Signature-256` over node
 * `crypto`, and the subscription handshake is the GET-with-query dance the
 * core's `RawInbound.url` exists for.
 *
 * The five decisions:
 *
 *  CONVERSATION KEY — `${phone_number_id}:${wa_id}`: your business number
 *  and the customer's WhatsApp id. One customer, one ongoing conversation
 *  per business number — the same both-ends key as SMS, because the Cloud
 *  API is 1:1 (no groups).
 *
 *  IDENTITY KEY — the `wa_id` (the customer's phone in WhatsApp's form).
 *  Same weak-identity caveat as SMS: fine to recognize, never to privilege
 *  without a real link.
 *
 *  AUDIENCE — always `direct`.
 *
 *  INTERACTION — `native`: reply buttons (the Cloud API's interactive
 *  messages; up to three buttons, titles ≤ 20 characters — 'Approve' and
 *  'Deny' fit with room to spare). Each button's `id` carries the canonical
 *  token AND the exact ask, so the staleness rule rides the button; the
 *  256-character id cap is roomy enough to never degrade.
 *
 *  ECHO RULE — the webhook's `messages` array contains only CUSTOMER
 *  messages; your own sends come back as `statuses` entries, which are noops
 *  by design. The self-reply loop cannot form.
 *
 * THE 24-HOUR WINDOW is this surface's defining constraint and it is honest
 * to name it here: free-form messages send only within 24 hours of the
 * customer's last message. Outside it the Graph API refuses (template
 * messages are the sanctioned alternative, out of scope for v1), the
 * delivery receipt stays mid-`sending`, and the worker's sweep retries —
 * which means a late reply DELIVERS ITSELF the next time the customer
 * writes and the window reopens. Emergent, and worth knowing on purpose.
 */

// ---- Status prose ----------------------------------------------------------

function statusProse(item: Extract<DeliveryItem, { item: 'status' }>): string {
  switch (item.kind) {
    case 'error':
      return `⚠️ Something went wrong${item.reason ? ` (${item.reason})` : ''}. Send a message to try again.`;
    case 'budget':
      return `⛔ This conversation reached its ${item.budget ?? 'usage'} limit.`;
    case 'interrupted':
      return '🛑 The reply was stopped.';
    case 'approval':
      if (item.reason === 'approval timed out') return '⏳ The approval request timed out and was denied.';
      return item.approved ? '✅ Approved.' : '❌ Denied.';
    case 'compaction':
      return '📦 Earlier conversation was summarized.';
    case 'orphan-child':
      return '🔧 A background task was recovered.';
    default:
      return `[${item.kind}]${item.reason ? ` ${item.reason}` : ''}`;
  }
}

// ---- Verify: signature for POSTs, verify_token for the GET handshake -------

function queryParams(url: string | undefined): URLSearchParams {
  const q = (url ?? '').split('?')[1] ?? '';
  return new URLSearchParams(q);
}

/** True when this request is Meta's GET subscription handshake — the query
 *  carries `hub.mode=subscribe` and no body is sent. */
export function isSubscriptionHandshake(raw: RawInbound): boolean {
  return queryParams(raw.url).get('hub.mode') === 'subscribe';
}

/**
 * Two trust checks, one per request shape. The handshake authenticates by
 * the `hub.verify_token` you configured in the app dashboard; every event
 * POST authenticates by `X-Hub-Signature-256` — `sha256=` + HMAC-SHA256 of
 * the raw body under the APP SECRET (not the access token). Both compared in
 * constant time.
 */
export function verifyWhatsAppRequest(
  raw: RawInbound, appSecret: string, verifyToken: string,
): boolean {
  if (isSubscriptionHandshake(raw)) {
    const got = queryParams(raw.url).get('hub.verify_token') ?? '';
    const a = Buffer.from(got);
    const b = Buffer.from(verifyToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const header = raw.headers['x-hub-signature-256'];
  const signature = Array.isArray(header) ? header[0] : header;
  if (!signature) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(raw.rawBody).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What `parse` hands the lens: the handshake (echo the challenge) or an
 *  event envelope. */
export type WhatsAppEvent =
  | { wa: 'handshake'; challenge: string }
  | { wa: 'event'; body: any }
  | { wa: 'ignore' };

export function parseWhatsAppRequest(raw: RawInbound): WhatsAppEvent {
  if (isSubscriptionHandshake(raw)) {
    return { wa: 'handshake', challenge: queryParams(raw.url).get('hub.challenge') ?? '' };
  }
  try {
    return { wa: 'event', body: JSON.parse(raw.rawBody) };
  } catch {
    return { wa: 'ignore' };
  }
}

// ---- The lens --------------------------------------------------------------

const NOOP: InboundReading = { intent: { kind: 'noop' } };

export const whatsappLens: Lens = {
  out(item: DeliveryItem): unknown {
    switch (item.item) {
      case 'reply':
        return { type: 'text', text: { body: item.text } };
      case 'status':
        return { type: 'text', text: { body: statusProse(item) } };
      case 'overflow':
        return {
          type: 'text',
          text: { body: `${item.head}${item.url ? `\n${item.url}` : ''}` },
        };
      case 'prompt': {
        const args = JSON.stringify(item.args ?? {});
        const clamped = args.length > 600 ? `${args.slice(0, 600)}…` : args;
        const runAs = 'runAs' in item && item.runAs !== undefined
          ? `\nruns as: ${item.runAs ?? 'anonymous service context'}` : '';
        return {
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: `The agent wants to run ${item.name}(${clamped})${runAs}` },
            action: {
              buttons: item.choices.map((choice) => ({
                type: 'reply',
                reply: {
                  // The id carries the token AND the exact ask (§8.3's
                  // staleness rule riding the button); the Cloud API allows
                  // 256 characters here, so no degrade path is needed.
                  id: JSON.stringify({ t: choice.token, c: item.toolCallId }),
                  title: choice.label,   // ≤ 20 chars: 'Approve' / 'Deny' fit
                },
              })),
            },
          },
        };
      }
      default:
        return null;
    }
  },

  in(event: unknown): InboundReading {
    const e = event as WhatsAppEvent;
    if (!e || typeof e !== 'object') return NOOP;

    if (e.wa === 'handshake') {
      return { intent: { kind: 'noop' }, respond: e.challenge };
    }
    if (e.wa !== 'event') return NOOP;

    // One change per delivery in practice; the shape is nested for batching.
    const value = e.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return NOOP;
    // Our own sends echo back as `statuses` — noop BY DESIGN; this is the
    // surface's echo rule.
    const m = value.messages?.[0];
    if (!m) return NOOP;

    const phoneNumberId = String(value.metadata?.phone_number_id ?? '');
    const from = String(m.from ?? '');
    const envelope = {
      eventId: m.id,
      externalUserId: from,
      conversationRef: `${phoneNumberId}:${from}`,
      destination: { phoneNumberId, to: from },
      audience: 'direct' as const,
    };

    if (m.type === 'interactive' && m.interactive?.button_reply) {
      let data: { t?: string; c?: string } = {};
      try { data = JSON.parse(m.interactive.button_reply.id ?? '{}'); } catch { return NOOP; }
      if (data.t !== 'approve' && data.t !== 'deny') return NOOP;
      return {
        intent: {
          kind: 'verdict',
          verdict: data.t === 'approve' ? 'approved' : 'denied',
          ...(data.c !== undefined ? { toolCallId: data.c } : {}),
        },
        ...envelope,
      };
    }

    if (m.type === 'text') {
      const text = String(m.text?.body ?? '').trim();
      if (text === '') return NOOP;
      if (text.toLowerCase() === 'link') return { intent: { kind: 'link-request' }, ...envelope };
      return { intent: { kind: 'message', text }, ...envelope };
    }

    // Media, reactions, contacts, location — nothing the item vocabulary
    // carries yet (attachments are the spec's named open question).
    return NOOP;
  },
};

// ---- The transport ---------------------------------------------------------

export interface WhatsAppTransportOptions {
  /** A System User access token with `whatsapp_business_messaging`. */
  accessToken: string;
  /** Graph API version segment. Default `v20.0`. */
  apiVersion?: string;
  /** TEST SEAM: the fetch to use. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * `/{phone_number_id}/messages`, nothing else. No idempotency key exists on
 * the Cloud API, so the declared recovery tier is `retry` — and remember the
 * module comment: outside the 24-hour window this call FAILS by policy, the
 * receipt stays mid-`sending`, and the sweep's retry is what delivers the
 * message when the customer writes again.
 */
export function whatsappTransport(options: WhatsAppTransportOptions): ChannelTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const version = options.apiVersion ?? 'v20.0';
  return {
    async post(destination: unknown, payload: unknown) {
      const dest = (destination ?? {}) as { phoneNumberId?: string; to?: string };
      const res = await doFetch(
        `https://graph.facebook.com/${version}/${dest.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: dest.to,
            ...(payload as Record<string, unknown>),
          }),
        },
      );
      const json: any = await res.json();
      if (!res.ok || json?.error) {
        throw new Error(
          `[agent-channel-whatsapp] messages send failed: ${json?.error?.message ?? res.status}`,
        );
      }
      return { providerMessageId: String(json?.messages?.[0]?.id ?? '') };
    },
  };
}

// ---- The factory (§8.7 tier 1) ---------------------------------------------

export interface WhatsAppChannelOptions {
  /** The registered agent this number fronts. */
  agent: string;
  /** Graph API access token (System User, `whatsapp_business_messaging`). */
  accessToken: string;
  /** The Meta APP SECRET — the `X-Hub-Signature-256` key. Not the token. */
  appSecret: string;
  /** The `hub.verify_token` you type into the webhook dashboard — you invent
   *  it; the GET handshake checks it. */
  verifyToken: string;
  /** Note kinds delivered as statuses. Default `['error', 'approval']`. */
  statuses?: ChannelDef['statuses'];
  onUncertainDelivery?: ChannelDef['onUncertainDelivery'];
  sessionUrl?: ChannelDef['sessionUrl'];
  linkUrl?: ChannelDef['linkUrl'];
  throttle?: ChannelDef['throttle'];
  /** Override pieces of the default `{ interact: 'native', limit: 4000 }`. */
  profile?: Partial<ChannelProfile>;
  /** Graph API version segment, threaded to the transport. */
  apiVersion?: string;
  /** TEST SEAM, threaded to the transport. */
  fetchImpl?: typeof fetch;
}

export function whatsapp(options: WhatsAppChannelOptions): ChannelDef {
  if (!options?.agent) throw new Error('[agent-channel-whatsapp] whatsapp({ agent }) is required');
  if (!options.accessToken) throw new Error('[agent-channel-whatsapp] whatsapp({ accessToken }) is required');
  if (!options.appSecret) throw new Error('[agent-channel-whatsapp] whatsapp({ appSecret }) is required');
  if (!options.verifyToken) throw new Error('[agent-channel-whatsapp] whatsapp({ verifyToken }) is required');
  return {
    agent: options.agent,
    transport: whatsappTransport({
      accessToken: options.accessToken,
      apiVersion: options.apiVersion,
      fetchImpl: options.fetchImpl,
    }),
    lens: whatsappLens,
    profile: { interact: 'native', limit: 4000, ...options.profile },
    verify: (raw) => verifyWhatsAppRequest(raw, options.appSecret, options.verifyToken),
    parse: parseWhatsAppRequest,
    statuses: options.statuses ?? ['error', 'approval'],
    ...(options.onUncertainDelivery ? { onUncertainDelivery: options.onUncertainDelivery } : {}),
    ...(options.sessionUrl ? { sessionUrl: options.sessionUrl } : {}),
    ...(options.linkUrl ? { linkUrl: options.linkUrl } : {}),
    ...(options.throttle ? { throttle: options.throttle } : {}),
  };
}
