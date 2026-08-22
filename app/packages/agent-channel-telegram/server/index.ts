import { timingSafeEqual } from 'crypto';
import type {
  ChannelDef, ChannelProfile, ChannelTransport, DeliveryItem, InboundReading,
  Lens, RawInbound,
} from 'meteor/10thfloor:agent';

/**
 * The Telegram channel: one lens, one transport, one profile default — the
 * channels spec's §8.7 contract, third surface. Zero npm dependencies: the
 * Bot API is plain HTTPS + JSON over `fetch`, and webhook authentication is
 * Telegram's `secret_token` header compared in constant time.
 *
 * The five decisions (the channel-authoring recipe), stated up front:
 *
 *  CONVERSATION KEY — the `chat.id`. A private chat, a group, a supergroup:
 *  each is ONE durable conversation however many messages flow (the DM-
 *  amnesia lesson from the Slack lens, applied from the start). Forum topics
 *  inside supergroups are not keyed separately in v1.
 *
 *  IDENTITY KEY — the numeric `from.id`, stringified. Stable across chats,
 *  which is exactly what the identities table wants.
 *
 *  AUDIENCE — `chat.type === 'private'` is `direct`; groups, supergroups and
 *  channels are `group`, so an anonymous session's capability URL never
 *  lands where strangers can read it (§8.5).
 *
 *  INTERACTION — `native`: inline keyboards. Each button's `callback_data`
 *  carries the canonical token AND the exact ask (`toolCallId`), so the
 *  staleness rule rides the button. Telegram caps callback_data at 64 BYTES —
 *  the payload is compacted, and an over-long toolCallId degrades to a
 *  token-only payload (the single-winner verdict write remains the backstop).
 *
 *  ECHO RULE — Telegram never delivers a bot its own messages, so the
 *  self-reply loop cannot form; what must still be dropped is OTHER bots
 *  (`from.is_bot`) and non-message updates (edits, channel posts, member
 *  events), all noops by design.
 */

// ---- The prompt's callback payload -----------------------------------------

/** Compact on purpose: Telegram rejects callback_data over 64 bytes. `t` is
 *  the verdict ('a'pprove / 'd'eny), `c` the exact ask it answers. */
function callbackData(token: 'approve' | 'deny', toolCallId: string): string {
  const full = JSON.stringify({ t: token === 'approve' ? 'a' : 'd', c: toolCallId });
  if (Buffer.byteLength(full, 'utf8') <= 64) return full;
  // Degrade rather than truncate the ask into a WRONG ask: a payload without
  // `c` skips the router's staleness pre-check and leans on the verdict
  // write's own single-winner guard.
  return JSON.stringify({ t: token === 'approve' ? 'a' : 'd' });
}

// ---- Status prose — this surface's noteText --------------------------------

function statusProse(item: Extract<DeliveryItem, { item: 'status' }>): string {
  switch (item.kind) {
    case 'error':
      return `⚠️ Something went wrong${item.reason ? ` (${item.reason})` : ''}. Send a message to try again.`;
    case 'budget':
      return `⛔ The session reached its ${item.budget ?? 'usage'} limit.`;
    case 'interrupted':
      return '🛑 The turn was stopped.';
    case 'approval':
      if (item.reason === 'approval timed out') return '⏳ The approval request timed out and was denied.';
      return item.approved ? '✅ Approved.' : '❌ Denied.';
    case 'compaction':
      return '📦 Earlier conversation was summarized to stay within context.';
    case 'orphan-child':
      return '🔧 A background sub-task was recovered.';
    default:
      return `[${item.kind}]${item.reason ? ` ${item.reason}` : ''}`;
  }
}

// ---- Verify: the secret_token header ---------------------------------------

/**
 * Telegram signs nothing per-request; its webhook authentication is the
 * `secret_token` you register with `setWebhook`, echoed on every delivery as
 * `X-Telegram-Bot-Api-Secret-Token`. Equality is checked in constant time —
 * it is still a bearer credential.
 */
export function verifyTelegramSecret(raw: RawInbound, webhookSecret: string): boolean {
  const header = raw.headers['x-telegram-bot-api-secret-token'];
  const got = Array.isArray(header) ? header[0] : header;
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(webhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseTelegramUpdate(raw: RawInbound): unknown {
  try {
    return JSON.parse(raw.rawBody);
  } catch {
    return {};
  }
}

// ---- The lens --------------------------------------------------------------

const NOOP: InboundReading = { intent: { kind: 'noop' } };

/** `/link@MyBot` and `/link` and `link` all mean the same gesture; a sentence
 *  containing the word does not. */
function isLinkGesture(text: string): boolean {
  const word = text.trim().toLowerCase().split('@')[0];
  return word === 'link' || word === '/link';
}

export const telegramLens: Lens = {
  out(item: DeliveryItem): unknown {
    switch (item.item) {
      case 'reply':
        // Plain text, no parse_mode: Telegram's MarkdownV2 demands escaping
        // that mangles ordinary prose, and the core's rule stands — content
        // is opaque unless a surface opts into conversion. This one opts out.
        return { text: item.text };
      case 'status':
        return { text: statusProse(item) };
      case 'overflow':
        return { text: `${item.head}${item.url ? `\n${item.url}` : ''}` };
      case 'prompt': {
        const args = JSON.stringify(item.args ?? {});
        const clamped = args.length > 800 ? `${args.slice(0, 800)}…` : args;
        const runAs = 'runAs' in item && item.runAs !== undefined
          ? `\nruns as: ${item.runAs ?? 'anonymous service context'}` : '';
        return {
          text: `The agent wants to run ${item.name}(${clamped})${runAs}`,
          reply_markup: {
            inline_keyboard: item.choices.map((choice) => ([{
              text: choice.label,
              callback_data: callbackData(choice.token, item.toolCallId),
            }])),
          },
        };
      }
      default:
        return null;
    }
  },

  in(event: unknown): InboundReading {
    const update = event as any;
    if (!update || typeof update !== 'object') return NOOP;
    const eventId = update.update_id !== undefined ? String(update.update_id) : undefined;

    // A button press. `callback_query.message` is the prompt the keyboard was
    // attached to — its chat is the conversation the verdict belongs to.
    if (update.callback_query) {
      const cq = update.callback_query;
      let data: { t?: string; c?: string } = {};
      try { data = JSON.parse(cq.data ?? '{}'); } catch { return NOOP; }
      // Telegram lets any client send arbitrary `data` for a bot's message,
      // and `JSON.parse('null')` succeeds — guard the shape before reading
      // it, or a crafted click is a TypeError, a 500, and a retry loop.
      if (!data || typeof data !== 'object') return NOOP;
      if (data.t !== 'a' && data.t !== 'd') return NOOP;
      const chat = cq.message?.chat;
      if (!chat) return NOOP;
      return {
        intent: {
          kind: 'verdict',
          verdict: data.t === 'a' ? 'approved' : 'denied',
          ...(data.c !== undefined ? { toolCallId: data.c } : {}),
        },
        eventId,
        externalUserId: String(cq.from?.id ?? ''),
        conversationRef: String(chat.id),
        destination: { chatId: chat.id },
        audience: chat.type === 'private' ? 'direct' : 'group',
      };
    }

    // Only live user messages route. Edits, channel posts, member events,
    // and other bots are noops BY DESIGN — and a bot never receives its own
    // messages, so the echo loop cannot form here.
    const m = update.message;
    if (!m || !m.from || m.from.is_bot) return NOOP;
    const text = String(m.text ?? '').trim();
    if (text === '') return NOOP;   // photos, stickers, joins — nothing to say yet

    const envelope = {
      eventId,
      externalUserId: String(m.from.id),
      conversationRef: String(m.chat.id),
      destination: { chatId: m.chat.id },
      audience: (m.chat.type === 'private' ? 'direct' : 'group') as 'direct' | 'group',
    };
    // The linking gesture is honored in PRIVATE chats only: the URL it earns
    // is a credential, and the core refuses to post one into a group anyway —
    // in a group, `/link` is just a message.
    if (isLinkGesture(text) && m.chat.type === 'private') {
      return { intent: { kind: 'link-request' }, ...envelope };
    }
    return { intent: { kind: 'message', text }, ...envelope };
  },
};

// ---- The transport ---------------------------------------------------------

export interface TelegramTransportOptions {
  botToken: string;
  /** TEST SEAM: the fetch to use. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * `sendMessage`, nothing else. No idempotency key exists on the Bot API, so
 * the channel's honest recovery tier for a crash between post and confirm is
 * `retry` (a rare duplicate rather than a lost message) — declared by
 * default, overridable like everything else.
 */
export function telegramTransport(options: TelegramTransportOptions): ChannelTransport {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async post(destination: unknown, payload: unknown) {
      const dest = (destination ?? {}) as { chatId?: number | string };
      const res = await doFetch(`https://api.telegram.org/bot${options.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Payload first, addressing last: a payload can never redirect a post.
        body: JSON.stringify({ ...(payload as Record<string, unknown>), chat_id: dest.chatId }),
      });
      const json: any = await res.json();
      if (!json?.ok) {
        throw new Error(`[agent-channel-telegram] sendMessage failed: ${json?.description ?? res.status}`);
      }
      return { providerMessageId: String(json.result?.message_id ?? '') };
    },
  };
}

// ---- The factory (§8.7 tier 1) ---------------------------------------------

export interface TelegramChannelOptions {
  /** The registered agent this bot fronts. */
  agent: string;
  /** The BotFather token (`123456:ABC-…`). */
  botToken: string;
  /** The `secret_token` you passed to `setWebhook` — the webhook's whole
   *  authentication, so make it long and random. */
  webhookSecret: string;
  /** Note kinds delivered as statuses. Default `['error', 'approval']`. */
  statuses?: ChannelDef['statuses'];
  onUncertainDelivery?: ChannelDef['onUncertainDelivery'];
  sessionUrl?: ChannelDef['sessionUrl'];
  linkUrl?: ChannelDef['linkUrl'];
  throttle?: ChannelDef['throttle'];
  /** Override pieces of the default `{ interact: 'native', limit: 4096 }`. */
  profile?: Partial<ChannelProfile>;
  /** TEST SEAM, threaded to the transport. */
  fetchImpl?: typeof fetch;
}

export function telegram(options: TelegramChannelOptions): ChannelDef {
  if (!options?.agent) throw new Error('[agent-channel-telegram] telegram({ agent }) is required');
  if (!options.botToken) throw new Error('[agent-channel-telegram] telegram({ botToken }) is required');
  if (!options.webhookSecret) throw new Error('[agent-channel-telegram] telegram({ webhookSecret }) is required');
  return {
    agent: options.agent,
    transport: telegramTransport({ botToken: options.botToken, fetchImpl: options.fetchImpl }),
    lens: telegramLens,
    profile: { interact: 'native', limit: 4096, ...options.profile },
    verify: (raw) => verifyTelegramSecret(raw, options.webhookSecret),
    parse: parseTelegramUpdate,
    statuses: options.statuses ?? ['error', 'approval'],
    ...(options.onUncertainDelivery ? { onUncertainDelivery: options.onUncertainDelivery } : {}),
    ...(options.sessionUrl ? { sessionUrl: options.sessionUrl } : {}),
    ...(options.linkUrl ? { linkUrl: options.linkUrl } : {}),
    ...(options.throttle ? { throttle: options.throttle } : {}),
  };
}
