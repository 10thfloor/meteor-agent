import { type ChannelDef, type ChannelKnobs, type ChannelProfile, type ChannelTransport, type Lens, type RawInbound } from 'meteor/10thfloor:agent';
/** True when this request is Meta's GET subscription handshake — the query
 *  carries `hub.mode=subscribe` and no body is sent. */
export declare function isSubscriptionHandshake(raw: RawInbound): boolean;
/**
 * Two trust checks, one per request shape. The handshake authenticates by
 * the `hub.verify_token` you configured in the app dashboard; every event
 * POST authenticates by `X-Hub-Signature-256` — `sha256=` + HMAC-SHA256 of
 * the raw body under the APP SECRET (not the access token). Both compared in
 * constant time.
 */
export declare function verifyWhatsAppRequest(raw: RawInbound, appSecret: string, verifyToken: string): boolean;
/** What `parse` hands the lens: the handshake (echo the challenge) or an
 *  event envelope. */
export type WhatsAppEvent = {
    wa: 'handshake';
    challenge: string;
} | {
    wa: 'event';
    body: any;
} | {
    wa: 'ignore';
};
export declare function parseWhatsAppRequest(raw: RawInbound): WhatsAppEvent;
export declare const whatsappLens: Lens;
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
export declare function whatsappTransport(options: WhatsAppTransportOptions): ChannelTransport;
/** The core's `ChannelKnobs` ride along untouched; `statuses` defaults to
 *  `['error', 'approval']` here. */
export interface WhatsAppChannelOptions extends ChannelKnobs {
    /** The registered agent this number fronts. */
    agent: string;
    /** Graph API access token (System User, `whatsapp_business_messaging`). */
    accessToken: string;
    /** The Meta APP SECRET — the `X-Hub-Signature-256` key. Not the token. */
    appSecret: string;
    /** The `hub.verify_token` you type into the webhook dashboard — you invent
     *  it; the GET handshake checks it. */
    verifyToken: string;
    /** Override pieces of the default `{ interact: 'native', limit: 4000 }`. */
    profile?: Partial<ChannelProfile>;
    /** Graph API version segment, threaded to the transport. */
    apiVersion?: string;
    /** TEST SEAM, threaded to the transport. */
    fetchImpl?: typeof fetch;
}
export declare function whatsapp(options: WhatsAppChannelOptions): ChannelDef;
//# sourceMappingURL=index.d.ts.map