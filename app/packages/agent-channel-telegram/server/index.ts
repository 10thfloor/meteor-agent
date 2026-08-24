import {
  attachmentNotice, channelKnobs, LINK_GESTURE, encodeVerdictPostback, decodeVerdictPostback, headerValue, promptDisplay, safeEqual,
  type ChannelDef, type ChannelKnobs, type ChannelProfile, type ChannelTransport,
  type DeliveryItem, type InboundReading, type Lens, type RawInbound,
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
 *  staleness rule rides the button — the core's shared postback codec, with
 *  Telegram's cap applied: callback_data is 64 BYTES, so an over-long
 *  toolCallId degrades to a token-only payload (the single-winner verdict
 *  write remains the backstop).
 *
 *  ECHO RULE — Telegram never delivers a bot its own messages, so the
 *  self-reply loop cannot form; what must still be dropped is OTHER bots
 *  (`from.is_bot`) and non-message updates (edits, channel posts, member
 *  events), all noops by design.
 */

// ---- The prompt's callback payload -----------------------------------------

/** Telegram rejects callback_data over 64 bytes. The core's postback codec
 *  (`{ t: 'a' | 'd', c: toolCallId }`) takes that cap and, past it, DROPS the
 *  ask rather than truncating it into a WRONG ask: a payload without `c`
 *  skips the router's staleness pre-check and leans on the verdict write's
 *  own single-winner guard. */
const CALLBACK_DATA_MAX_BYTES = 64;

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
      if (item.timedOut) return '⏳ The approval request timed out and was denied.';
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
  const got = headerValue(raw, 'x-telegram-bot-api-secret-token');
  if (!got) return false;
  return safeEqual(got, webhookSecret);
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
 *  containing the word does not. The bare word is the core's `LINK_GESTURE`
 *  (what its group hint tells people to type), read from the same constant so
 *  hint and lens cannot disagree; the slash-command spelling, with or without
 *  Telegram's `@Bot` suffix, is this surface's addition — which is why this is
 *  not a bare `isLinkGesture(text)`: the `@Bot` suffix is stripped first, and
 *  only from the slash form as the whole token, so `/link@MyBot please` and
 *  `link@anything` stay messages. */
function isTelegramLinkGesture(text: string): boolean {
  const word = text.trim().toLowerCase().replace(/^(\/\S+?)@\S+$/, '$1');
  return word === LINK_GESTURE || word === `/${LINK_GESTURE}`;
}

export const telegramLens: Lens = {
  out(item: DeliveryItem): unknown {
    switch (item.item) {
      case 'reply':
        // Plain text, no parse_mode: Telegram's MarkdownV2 demands escaping
        // that mangles ordinary prose, and the core's rule stands — content
        // is opaque unless a surface opts into conversion. This one opts out.
        // The naming clause: no bytes on this surface yet, so each file
        // appears as a text line naming it.
        return { text: `${item.text}${attachmentNotice(item.attachments)}` };
      case 'status':
        return { text: statusProse(item) };
      case 'overflow':
        return { text: `${item.head}${item.url ? `\n${item.url}` : ''}${attachmentNotice(item.attachments)}` };
      case 'prompt': {
        const args = JSON.stringify(item.args ?? {});
        const clamped = args.length > 800 ? `${args.slice(0, 800)}…` : args;
        // The tool's own account of the call leads (the display clause); the
        // raw args stay underneath as the exact record. No escaping: this
        // surface sends plain text with no parse_mode (see the reply case).
        const display = promptDisplay(item.display, { limit: 800 });
        const lead = display ? `\n${display}` : '';
        const runAs = item.runAs !== undefined
          ? `\nruns as: ${item.runAs ?? 'anonymous service context'}` : '';
        return {
          text: `The agent wants to run ${item.name}:${lead}\n${clamped}${runAs}`,
          reply_markup: {
            inline_keyboard: item.choices.map((choice) => ([{
              text: choice.label,
              callback_data: encodeVerdictPostback(
                choice.token, item.toolCallId, { maxBytes: CALLBACK_DATA_MAX_BYTES },
              ),
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
      // Telegram lets any client send arbitrary `data` for a bot's message;
      // the shared codec answers `null` for anything that is not a verdict
      // postback (bad JSON, the literal `'null'`, an unknown token), so a
      // crafted click is a noop rather than a TypeError, a 500, and a retry
      // loop.
      const decoded = decodeVerdictPostback(cq.data);
      if (!decoded) return NOOP;
      const chat = cq.message?.chat;
      if (!chat) return NOOP;
      return {
        intent: { kind: 'verdict', ...decoded },
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
    // Media messages carry their words in `caption`, not `text` (participants
    // spec §6.3) — a photo with a caption is a message saying the caption.
    const text = String(m.text ?? (m as any).caption ?? '').trim();

    // Files ride as REFERENCES: the Bot API delivers a `file_id` whose fetch
    // needs the bot token to even name the resource (getFile, then the
    // token-in-path download URL) — the factory's media recipe owns both. A
    // photo is ONE attachment: Telegram's `photo` array is thumbnail sizes of
    // the same image, and mapping them all would spend the file cap on
    // duplicates — the largest is the photo.
    const files: Array<{ name: string; contentType: string; declaredSize?: number; ref: string; indirect: true }> = [];
    const photo = Array.isArray((m as any).photo) ? (m as any).photo : [];
    if (photo.length > 0) {
      const largest = photo.reduce(
        (a: any, b: any) => ((Number(b?.file_size) || 0) > (Number(a?.file_size) || 0) ? b : a),
        photo[photo.length - 1],
      );
      if (typeof largest?.file_id === 'string') {
        files.push({
          name: 'photo.jpg', contentType: 'image/jpeg',
          ...(Number(largest.file_size) > 0 ? { declaredSize: Number(largest.file_size) } : {}),
          ref: largest.file_id, indirect: true,
        });
      }
    }
    const doc = (m as any).document;
    if (doc && typeof doc.file_id === 'string') {
      files.push({
        name: String(doc.file_name ?? 'file'),
        contentType: String(doc.mime_type ?? 'application/octet-stream'),
        ...(Number(doc.file_size) > 0 ? { declaredSize: Number(doc.file_size) } : {}),
        ref: doc.file_id, indirect: true,
      });
    }
    // The sharpened guard: a file with no words is still a message; stickers
    // and joins still have nothing to say.
    if (text === '' && files.length === 0) return NOOP;

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
    if (isTelegramLinkGesture(text) && m.chat.type === 'private') {
      return { intent: { kind: 'link-request' }, ...envelope };
    }
    return {
      intent: { kind: 'message', text },
      ...envelope,
      ...(files.length > 0 ? { attachments: files } : {}),
    };
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

/** The credentials plus the core's five pass-through knobs (`ChannelKnobs`:
 *  `statuses`, `onUncertainDelivery`, `sessionUrl`, `linkUrl`, `throttle`),
 *  forwarded to the `ChannelDef` untouched — except `statuses`, which defaults
 *  to `['error', 'approval']`. */
export interface TelegramChannelOptions extends ChannelKnobs {
  /** The registered agent this bot fronts. */
  agent: string;
  /** The BotFather token (`123456:ABC-…`). */
  botToken: string;
  /** The `secret_token` you passed to `setWebhook` — the webhook's whole
   *  authentication, so make it long and random. */
  webhookSecret: string;
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
    // The media recipe (participants spec §6): Telegram is the token-in-path
    // case — even NAMING the resource needs the bot token (getFile), and the
    // download URL is `file/bot<TOKEN>/<file_path>`, CONSTRUCTED by the
    // extractor from the getFile response. Both hops live on api.telegram.org.
    // Note the Bot API's own getFile ceiling is 20 MB — files past it fail
    // the fetch and become a note, which is the honest answer.
    media: {
      hosts: ['api.telegram.org'],
      request: (att) => ({
        url: `https://api.telegram.org/bot${options.botToken}/getFile?file_id=${encodeURIComponent(att.ref ?? '')}`,
      }),
      resolveIndirect: (json) => {
        const r = json as { ok?: unknown; result?: { file_path?: unknown } } | null;
        const path = r?.ok === true && typeof r.result?.file_path === 'string'
          ? r.result.file_path : null;
        return path === null ? null : `https://api.telegram.org/file/bot${options.botToken}/${path}`;
      },
    },
    // Every knob the core names, forwarded by one helper — a knob added to
    // ChannelKnobs tomorrow is forwarded here without this file changing.
    ...channelKnobs(options),
  };
}
