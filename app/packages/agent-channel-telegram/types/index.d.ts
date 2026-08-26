import { type ChannelDef, type ChannelKnobs, type ChannelProfile, type ChannelTransport, type Lens, type RawInbound } from 'meteor/10thfloor:agent';
/**
 * Telegram signs nothing per-request; its webhook authentication is the
 * `secret_token` you register with `setWebhook`, echoed on every delivery as
 * `X-Telegram-Bot-Api-Secret-Token`. Equality is checked in constant time —
 * it is still a bearer credential.
 */
export declare function verifyTelegramSecret(raw: RawInbound, webhookSecret: string): boolean;
export declare function parseTelegramUpdate(raw: RawInbound): unknown;
export declare const telegramLens: Lens;
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
export declare function telegramTransport(options: TelegramTransportOptions): ChannelTransport;
/** The credentials plus the core's `ChannelKnobs`, forwarded to the
 *  `ChannelDef` untouched — except `statuses`, which defaults to
 *  `['error', 'approval']`. */
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
export declare function telegram(options: TelegramChannelOptions): ChannelDef;
//# sourceMappingURL=index.d.ts.map