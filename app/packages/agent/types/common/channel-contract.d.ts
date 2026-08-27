import type { AgentMessage } from './types';
/** Lens contract (§8): closed item/intent vocabularies, isomorphic (no Node
 *  globals) — extending either set is a deliberate framework change. */
/** A file on a delivery item at render time — hydrated base64, never fetched
 *  by the lens. Base64 end-to-end to stay isomorphic. */
export interface ChannelAttachment {
    name: string;
    contentType: string;
    /** DECODED byte count — what a human-readable size line should say. */
    size: number;
    /** The bytes, base64. */
    content: string;
}
/** A provider-delivered file reference (not bytes). The lens translates the
 *  event into this; core fetches under the channel def's `media` recipe. */
export interface RemoteAttachment {
    name: string;
    contentType: string;
    /** Provider's claimed size — checked before fetch. Absent = fetch and find out. */
    declaredSize?: number;
    /** The resource, when the event names one directly (https only). */
    url?: string;
    /** Provider's file id when naming the resource needs credentials. */
    ref?: string;
    /** Two-step providers: first fetch yields JSON, `media.resolveIndirect`
     *  extracts the real target, fetched next with the same credentials. */
    indirect?: true;
}
/** A lens hands core either bytes (email inlines them in the webhook) or a
 *  reference (everything else). The discriminant is `content`. */
export type InboundAttachment = ChannelAttachment | RemoteAttachment;
export declare function isRemoteAttachment(a: InboundAttachment): a is RemoteAttachment;
/** Naming-clause floor: one text line per file for surfaces that cannot carry
 *  bytes. Empty string when nothing to name, so call sites append freely. */
export declare function attachmentNotice(attachments?: ChannelAttachment[], 
/** Surface's text escaping, applied to each name. */
escape?: (name: string) => string): string;
/** Display-clause floor: the tool's one-line account of a parked call, so
 *  approvers read intent rather than raw arg ids. Empty string when absent. */
export declare function promptDisplay(display: string | undefined, opts?: {
    /** Clamped with an ellipsis past this. */
    limit?: number;
    /** Surface's text escaping — display interpolates model args, same provenance as model text. */
    escape?: (text: string) => string;
}): string;
/** One choice a prompt offers. `token` is canonical; the lens maps it to the
 *  surface's affordance. `match` (menu) / `url` (link) filled per profile. */
export interface PromptChoice {
    token: 'approve' | 'deny';
    label: string;
    match?: string;
    url?: string;
}
export type DeliveryItem = 
/** The turn's answer. `attachments` is a sidecar — files ride with the
 *  reply so a single message carries both (every lens must name them). */
{
    item: 'reply';
    text: string;
    attachments?: ChannelAttachment[];
}
/** A harness note the channel opted into — structured token in, surface prose out. */
 | {
    item: 'status';
    kind: NonNullable<AgentMessage['kind']>;
    reason?: string;
    /** `kind: 'approval'` only — post-verdict audit outcome. */
    approved?: boolean;
    /** `kind: 'approval'` only, when true: watcher denied after timeout. */
    timedOut?: boolean;
    budget?: AgentMessage['budget'];
}
/** The parked approval from `session.pending`. `toolCallId` names the exact
 *  ask so stale replies cannot decide a different one. */
 | {
    item: 'prompt';
    name: string;
    args: unknown;
    /** The tool's own one-line account of the call (participants spec §8),
     *  hydrated at park time — a lens renders it ABOVE (or instead of) the
     *  raw args, so an approver reads names and sizes, not ref ids. */
    display?: string;
    runAs?: string | null;
    toolCallId: string;
    choices: PromptChoice[];
}
/** A reply over the profile's `limit`: mechanical head-slice (no model),
 *  optional web-view link. Keeps attachments — text overflowed, not files. */
 | {
    item: 'overflow';
    head: string;
    url?: string;
    attachments?: ChannelAttachment[];
};
/** Every `item` discriminant — the unit test asserts this agrees with the union. */
export declare const DELIVERY_ITEM_KINDS: readonly ['reply', 'status', 'prompt', 'overflow'];
export type InboundIntent = {
    kind: 'message';
    text: string;
}
/** `toolCallId` lets the router drop a stale click (§8.3). */
 | {
    kind: 'verdict';
    verdict: 'approved' | 'denied';
    reason?: string;
    toolCallId?: string;
} | {
    kind: 'link-request';
}
/** Catch-all for events with no routable meaning (handshakes, bounces, echoes, etc.). */
 | {
    kind: 'noop';
};
/** What `lens.in` returns: intent plus routing envelope. `eventId` must be
 *  redelivery-stable (deduplicated admission within the retention window). */
export interface InboundReading {
    intent: InboundIntent;
    eventId?: string;
    externalUserId?: string;
    /** Gates identity resolution, not routing: `false` keeps a forgeable sender
     *  anonymous so a spoofed id cannot inherit a linked account (§12). */
    senderVerified?: boolean;
    conversationRef?: string;
    /** Where replies to this conversation go — stored on the binding at bind
     *  time, opaque to the core. */
    destination?: unknown;
    /** One recipient or many — defaults to `'group'` (the safe direction). */
    audience?: 'direct' | 'group';
    /** `noop` only: body echoed in the 200 (e.g. Slack's URL-verification challenge). */
    respond?: string;
    /** Files on a `message` intent — the lens translates, core enforces caps. */
    attachments?: InboundAttachment[];
}
/** Per-surface adapter. Render and interpret are ONE object to prevent drift.
 *  Both halves must be pure (no I/O) — idempotence comes from receipts. */
export interface Lens {
    out(item: DeliveryItem, destination: unknown): unknown | unknown[];
    in(event: unknown): InboundReading;
}
/** How choices are offered: `native` (buttons), `menu` (reply words),
 *  `link` (single-use URLs). `limit` triggers overflow when exceeded. */
export interface ChannelProfile {
    interact: 'native' | 'menu' | 'link';
    limit?: number;
}
/** Provider call — supplied by the channel package, not core. `reconcile`
 *  enables tier-B uncertain-delivery recovery (§11). */
export interface ChannelPostOptions {
    idempotencyKey: string;
    /** Cancels the provider request when the caller no longer needs the post. */
    signal?: AbortSignal;
}
export interface ChannelTransport {
    post(destination: unknown, payload: unknown, opts: ChannelPostOptions): Promise<{
        providerMessageId?: string;
    } | void>;
    reconcile?(destination: unknown, idempotencyKey: string): Promise<boolean>;
}
/** Canonical reply words — one place so render, registration, and test agree. */
export declare const MENU_MATCHES: Record<'approve' | 'deny', string>;
/** Canonical token → verdict mapping — one place for all consumers. */
export declare const VERDICT_FOR: {
    readonly approve: 'approved';
    readonly deny: 'denied';
};
/** The bare word that asks for an account link — exact after trim, any case.
 *  Lives here so the core's hint and every lens agree on the word. */
export declare const LINK_GESTURE = "link";
export declare function isLinkGesture(text: string): boolean;
/** Encode a verdict postback as `{ t, c }`. Over `maxBytes` the toolCallId
 *  is DROPPED (not cut) — a truncated id would name the wrong ask. */
export declare function encodeVerdictPostback(token: 'approve' | 'deny', toolCallId: string, opts?: {
    maxBytes?: number;
}): string;
/** Decode a verdict postback → verdict + optional toolCallId, or `null`.
 *  Guards against `JSON.parse('null')` yielding a typeof-object null. */
export declare function decodeVerdictPostback(raw: unknown): {
    verdict: 'approved' | 'denied';
    toolCallId?: string;
} | null;
/** One registered prompt choice. `toolCallId` ties the match to the exact
 *  parked call so a stale reply cannot decide a different ask (§8.3). */
export interface ReceiptExpectation {
    match: string;
    verdict: 'approved' | 'denied';
    toolCallId: string;
}
export declare function matchExpectation(text: string, expects: ReadonlyArray<ReceiptExpectation>): {
    verdict: 'approved' | 'denied';
    toolCallId: string;
} | null;
/** Build the receipt's `expects` from a prompt's menu-grammar choices. */
export declare function expectationsFor(prompt: Extract<DeliveryItem, {
    item: 'prompt';
}>): ReceiptExpectation[];
/** Default corpus for `assertLensRoundTrip` — one per item kind, including a
 *  file-bearing reply and a prompt with `display` to exercise both clauses. */
export declare function exemplarItems(): DeliveryItem[];
export interface RoundTripOptions {
    /** The corpus to render; defaults to `exemplarItems()`. */
    items?: DeliveryItem[];
    /** A destination `out` accepts; defaults to `{}`. */
    destination?: unknown;
    /** Lens-author-supplied: synthesize the inbound event a surface would
     *  deliver when a user activates `choice` of a rendered prompt. */
    synthesize?: (choice: PromptChoice, rendered: unknown | unknown[]) => unknown;
    /** A plain inbound message event carrying `text`; checked to read back as a
     *  `message` intent with that text. */
    message?: (text: string) => unknown;
    /** A file-only inbound event (no text) — checked to read back as a
     *  `message` with attachments preserving name and contentType. */
    mediaMessage?: (files: Array<{
        name: string;
        contentType: string;
    }>) => unknown;
}
/** Asserts totality (every item renders) and round-trip (every affordance
 *  `out` offers, `in` interprets back). Throws on first violation. */
export declare function assertLensRoundTrip(lens: Lens, profile: ChannelProfile, opts?: RoundTripOptions): void;
//# sourceMappingURL=channel-contract.d.ts.map