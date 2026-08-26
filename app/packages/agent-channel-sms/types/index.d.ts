import { type ChannelDef, type ChannelKnobs, type ChannelProfile, type ChannelTransport, type Lens, type RawInbound } from 'meteor/10thfloor:agent';
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
/**
 * The per-surface conversion opt-in (§8.5), in the opposite direction from
 * Slack's: SMS renders nothing, so markdown DECORATION is stripped —
 * `**bold**` and `_italic_` markers, heading hashes — while links keep both
 * halves as "label (url)", because on a phone the words and the address are
 * each worth keeping.
 */
export declare function toPlainText(markdown: string): string;
export declare function parseTwilioForm(rawBody: string): Record<string, string>;
/**
 * Twilio's scheme, exactly as documented: base64(HMAC-SHA1(authToken,
 * webhookUrl + concat(sortedKey + value…))) must equal `X-Twilio-Signature`.
 * The signature covers the FULL PUBLIC URL Twilio was configured with —
 * scheme, host, path — which a server behind a tunnel or proxy cannot learn
 * from the request it receives, so the channel takes `webhookUrl` as
 * configuration and the two must match to the character.
 */
export declare function verifyTwilioSignature(raw: RawInbound, authToken: string, webhookUrl: string): boolean;
export declare const smsLens: Lens;
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
export declare function smsTransport(options: SmsTransportOptions): ChannelTransport;
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
export declare function sms(options: SmsChannelOptions): ChannelDef;
//# sourceMappingURL=index.d.ts.map