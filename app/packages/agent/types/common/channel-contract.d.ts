import type { AgentMessage } from './types';
/**
 * The lens contract (channels spec §8): what the shared planner emits, what a
 * per-surface lens must render and interpret, and the one law that binds the
 * two halves together.
 *
 * BOTH VOCABULARIES ARE CLOSED, like the `Phase` union — a channel cannot
 * invent items or intents, and extending either set is a framework change made
 * deliberately, here, once. The unit test asserts the item list is total so a
 * new member cannot be added without the totality check knowing about it.
 *
 * ISOMORPHIC on purpose — pure functions and types only, no Node globals (`Buffer`,
 * `crypto`) — which is why it lives under `common/` and why the server-only
 * webhook helpers (`headerValue`, `safeEqual`, `RawInbound`) live beside the
 * registry instead. Today only the server entry re-exports it; a client may.
 */
/**
 * A file riding a DELIVERY ITEM at render time: hydrated, base64 `content`.
 * A lens never fetches — by the time `out` sees the item, the bytes are in it
 * (the egress worker hydrates refs from the store on the POST path, the same
 * lazy seam verdict-token minting uses). Base64 end to end, deliberately:
 * providers emit and demand it, the contract stays isomorphic (no `Buffer`),
 * and decoding to binary in between would buy nothing.
 */
export interface ChannelAttachment {
    name: string;
    contentType: string;
    /** DECODED byte count — what a human-readable size line should say. */
    size: number;
    /** The bytes, base64. */
    content: string;
}
/**
 * A file the provider delivered as a REFERENCE, not bytes (participants spec
 * §6) — the chat surfaces' shape: Slack hands a private download URL, Twilio
 * a media URL, WhatsApp and Telegram an id whose fetch needs credentials to
 * even name the resource. The LENS stays pure and secret-free (it is a module
 * constant — it cannot carry a token and must not fetch): it translates the
 * event's facts into this, and CORE performs the size-gated fetch under the
 * channel def's `media` recipe — the host allowlist authored by the channel,
 * never derived from the event.
 */
export interface RemoteAttachment {
    name: string;
    contentType: string;
    /** The provider's CLAIM — checked against the per-file cap BEFORE fetching,
     *  so an honestly-oversized file costs nothing; the streaming abort is what
     *  handles a lying one. Absent = fetch and find out. */
    declaredSize?: number;
    /** The resource, when the event names one directly (https only). */
    url?: string;
    /** The provider's file id, when naming the resource itself needs
     *  credentials (Telegram) — the def's `media.request` builds the URL. */
    ref?: string;
    /** Two-step providers (WhatsApp's media lookup, Telegram's getFile): the
     *  first response is JSON from which the def's `media.resolveIndirect`
     *  extracts — or constructs — the real target, fetched next with the SAME
     *  headers (a credentialed, allowlisted provider API call — unlike
     *  redirects, which strip auth cross-host; both targets are host-checked). */
    indirect?: true;
}
/** A lens hands core either bytes (email inlines them in the webhook) or a
 *  reference (everything else). The discriminant is `content`. */
export type InboundAttachment = ChannelAttachment | RemoteAttachment;
export declare function isRemoteAttachment(a: InboundAttachment): a is RemoteAttachment;
/**
 * The naming-clause FLOOR for a surface that cannot carry bytes (§8.5's
 * degrade, downward from the full row): one text line per file, appended to
 * the rendered text so the recipient learns the file exists and what it is
 * called. Email renders real provider attachments instead; carrying actual
 * bytes to the chat surfaces is future work per surface — naming them is the
 * floor, and the floor is mandatory (`assertLensRoundTrip`'s naming check).
 * Empty string when there is nothing to name, so call sites can append
 * unconditionally.
 */
export declare function attachmentNotice(attachments?: ChannelAttachment[], 
/** A surface's own text escaping (Slack's `&<>`), applied to each name —
 *  names ultimately come through tool bodies and deserve the same handling
 *  as any other text landing in live markup. */
escape?: (name: string) => string): string;
/**
 * The DISPLAY-CLAUSE FLOOR: the tool's own one-line account of a parked call
 * (participants spec §8), hydrated at park time, rendered by every surface that
 * shows an approval.
 *
 * This exists because raw arguments are not a decision. `{"refs":["a7f3…"]}`
 * tells an approver nothing; "Send invoice-04.pdf (82 KB) to accounts@acme" is
 * the thing they are being asked to consent to. A lens renders it ABOVE the raw
 * args where it has the room, or INSTEAD of them where it does not — on a
 * 160-character surface a clamped JSON fragment is neither readable nor a
 * faithful record, so it earns none of the space it costs. What no lens may do
 * is drop it: that ships an approval prompt the human cannot act on, and it is
 * mandatory (`assertLensRoundTrip`'s display check).
 *
 * Empty string when the park hydrated none, so call sites can render
 * unconditionally.
 */
export declare function promptDisplay(display: string | undefined, opts?: {
    /** The surface's room for it; clamped with an ellipsis past this. */
    limit?: number;
    /** A surface's own text escaping, applied to the line. `display` is
     *  AUTHORED by an app's `describe`, but it routinely interpolates the
     *  model's own arguments into itself — so it reaches live markup with
     *  exactly the provenance of any other model text, and takes the same
     *  handling. */
    escape?: (text: string) => string;
}): string;
/** One choice a prompt offers. `token` is CANONICAL (`approve`/`deny`) — the
 *  lens maps it onto whatever the surface does (a button postback, a reply
 *  keyword, a single-use URL) and back. The grammar fields are filled per the
 *  profile's `interact` before the lens sees the item:
 *
 *    `match` — `menu` only: the reply word the surface's grammar registers
 *              ("Reply YES to approve"); the same word lands in the delivery
 *              receipt's `expects`, so the render and the parse are one
 *              artifact by construction.
 *    `url`   — `link` only: the single-use approval URL for this choice,
 *              minted at delivery time (see `issueVerdictToken`). Absent when
 *              the channel supplies no `approvalUrl`.
 */
export interface PromptChoice {
    token: 'approve' | 'deny';
    label: string;
    match?: string;
    url?: string;
}
export type DeliveryItem = 
/** The turn's answer — opaque text, passed through. The core never parses
 *  it (no markdown parser in the shared core, §8.5); a lens that wants
 *  Slack markup or email HTML converts inside its own `out`.
 *
 *  `attachments` is a SIDECAR, not a new item kind: a file almost never
 *  travels alone (email sends body + files as one message), and a separate
 *  `file` item would post two mails for one answer. Every lens must account
 *  for it — see the naming clause in `assertLensRoundTrip`. */
{
    item: 'reply';
    text: string;
    attachments?: ChannelAttachment[];
}
/** A harness note the channel opted into (`statuses` in the channel def).
 *  Structured token in, surface prose out — the lens is a second `noteText`. */
 | {
    item: 'status';
    kind: NonNullable<AgentMessage['kind']>;
    reason?: string;
    /** `kind: 'approval'` notes only — the post-verdict audit outcome. The ASK
     *  itself is never a status; it is always the `prompt` item. */
    approved?: boolean;
    /** `kind: 'approval'` notes only, and only when true: nobody answered
     *  before `budget.approval` elapsed and the watcher denied the ask. A lens
     *  must be able to say "timed out" rather than imply a person refused. */
    timedOut?: boolean;
    budget?: AgentMessage['budget'];
}
/** The parked approval, built from `session.pending` — never from a note.
 *  `toolCallId` names the exact ask, and travels into the delivery receipt's
 *  `expects` so a stale reply cannot decide a different later ask. */
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
/** A reply that would not fit the profile's `limit`: a MECHANICAL head-slice
 *  (the worker never calls a model — no summarization) plus, when the
 *  audience rules allow one, a link to the session's web view.
 *
 *  Overflow KEEPS its files: the TEXT overflowed, not the work product — a
 *  truncated cover note must not cost the recipient the report. */
 | {
    item: 'overflow';
    head: string;
    url?: string;
    attachments?: ChannelAttachment[];
};
/** Every `item` discriminant, for the totality test and for lens authors who
 *  want to switch exhaustively. Kept adjacent to the union so they cannot
 *  drift apart unnoticed — the unit test asserts they agree. */
export declare const DELIVERY_ITEM_KINDS: readonly ['reply', 'status', 'prompt', 'overflow'];
export type InboundIntent = {
    kind: 'message';
    text: string;
}
/** `toolCallId`, when the surface's activation carries one (a native
 *  postback rendered from a prompt item should embed it), lets the router
 *  drop a click whose ask is no longer the parked one — §8.3's staleness
 *  rule. Absent, the single-winner verdict write is still the backstop. */
 | {
    kind: 'verdict';
    verdict: 'approved' | 'denied';
    reason?: string;
    toolCallId?: string;
} | {
    kind: 'link-request';
}
/** Everything without a defined meaning maps here BY DESIGN, not by
 *  accident: URL-verification handshakes, delivery callbacks, bounces,
 *  message edits, reactions, read receipts, typing indicators, the bot's own
 *  echoes. */
 | {
    kind: 'noop';
};
/**
 * What `lens.in` returns: the intent plus the routing envelope. The envelope
 * is how the generic pipeline (§9) stays provider-free — every
 * provider-specific extraction happens inside the lens.
 *
 * `eventId` must be the provider's REDELIVERY-STABLE id; it powers
 * exactly-once admission. A `noop` may leave the routing fields undefined —
 * nothing routes on it.
 */
export interface InboundReading {
    intent: InboundIntent;
    eventId?: string;
    externalUserId?: string;
    /**
     * Whether the CHANNEL vouches that `externalUserId` really is who sent this
     * event — the gate on resolving it to a linked account (§12). Omitted by
     * provider-authenticated surfaces (the provider proved the id, so it is
     * trustworthy to map to an account); set to `false` by a surface whose
     * sender id is forgeable (email, unless the mail passed author-aligned DKIM)
     * so the core keeps an unverified sender ANONYMOUS and a spoofed id cannot
     * inherit a linked owner's account. Never gates ROUTING — an unverified
     * sender still drives its own anonymous conversation; it gates only identity.
     */
    senderVerified?: boolean;
    conversationRef?: string;
    /** Where replies to this conversation go — stored on the binding at bind
     *  time, opaque to the core. */
    destination?: unknown;
    /** Whether the destination has one recipient or many — §8.5's capability-URL
     *  rule reads it. Defaults to `'group'` (the safe direction) when a lens
     *  does not say. */
    audience?: 'direct' | 'group';
    /** `noop` only: a body the provider expects echoed in the 200 — Slack's
     *  URL-verification `challenge` is the canonical case. Ignored on routable
     *  intents, whose 200 carries no body. */
    respond?: string;
    /**
     * Files the provider delivered with a `message` intent — inline base64
     * (email's webhook carries the bytes) or a `RemoteAttachment` reference
     * (the chat surfaces — core fetches under the def's `media` recipe,
     * participants spec §6). CAPS ARE NOT THE LENS'S JOB: admission policy is
     * core policy — the pipeline applies the channel's caps, keeps what passes,
     * stores the bytes, and notes what it dropped or could not retrieve. The
     * lens translates.
     */
    attachments?: InboundAttachment[];
}
/**
 * The per-surface adapter: two halves of one object, deliberately — on a
 * surface with no buttons, "Reply YES to approve" is a parse grammar the
 * OUTBOUND render created, and splitting render from interpret is how the two
 * drift (the documented Bot Framework failure). A lens with no gesture for
 * `link-request` simply never emits it.
 *
 * `out` may return one payload or several (a long SMS split into segments);
 * the worker posts them in order under one receipt. Both halves must be PURE —
 * no I/O — which is what lets `assertLensRoundTrip` run with zero provider
 * credentials, and what makes redelivery after a crash re-produce the same
 * payload (idempotence comes from receipts, not from rendering).
 */
export interface Lens {
    out(item: DeliveryItem, destination: unknown): unknown | unknown[];
    in(event: unknown): InboundReading;
}
/**
 * How choices are OFFERED on this surface — not what inbound is accepted
 * (a typed YES on a buttons surface still reaches `in`; it reads as a
 * `message`, because only the `menu` grammar registers reply words in the
 * receipt's `expects` — see `expectationsFor`):
 *
 *   `native` — real affordances (buttons, quick replies); postbacks carry the
 *              canonical token.
 *   `menu`   — no affordances, cheap replies (SMS): the prompt renders a reply
 *              menu and registers its tokens in the receipt's `expects`.
 *   `link`   — replies are awkward (email): each choice is a single-use
 *              URL bound to the specific pending verdict.
 *
 * `limit` is the hard payload budget; a reply over it becomes an `overflow`
 * item (head-slice + web link, audience permitting).
 */
export interface ChannelProfile {
    interact: 'native' | 'menu' | 'link';
    limit?: number;
}
/**
 * The provider call itself — supplied by the channel package (Slack SDK,
 * Twilio, SMTP), never by the core, so the package takes no provider
 * dependency. `post` receives whatever `lens.out` produced.
 *
 * `idempotencyKey` is passed where the provider honors one (tier A, §11);
 * `reconcile` is tier B — "did a post carrying this key already land at this
 * destination?" — and its presence is what makes `onUncertainDelivery:
 * 'reconcile'` legal for the channel. The key it is asked about is the BARE
 * receipt id, which is what segment 0 of a multi-payload post was sent under
 * (later segments carry `<receiptId>:<i>`); "did segment 0 land" is the
 * question, because a post that got past its first segment has a receipt
 * worth settling.
 */
export interface ChannelTransport {
    post(destination: unknown, payload: unknown, opts: {
        idempotencyKey: string;
    }): Promise<{
        providerMessageId?: string;
    } | void>;
    reconcile?(destination: unknown, idempotencyKey: string): Promise<boolean>;
}
/** The `menu` grammar's canonical reply words. ONE place — the planner fills
 *  choices from it, the receipt's `expects` registers it, and the round-trip
 *  helper normalizes its corpus with it — so render, registration and test
 *  can never disagree about the words. */
export declare const MENU_MATCHES: Record<'approve' | 'deny', string>;
/** The canonical choice token → the verdict it records. ONE place, so the
 *  planner's grammar, the round-trip helper, the `link` token mint and every
 *  lens's postback agree on which word means what. */
export declare const VERDICT_FOR: {
    readonly approve: 'approved';
    readonly deny: 'denied';
};
/** The bare word that asks for an account link: exact after trimming, any
 *  case — "link" and " LINK " ask; "link my account" is a message. The core's
 *  own group hint names this word ("send me the word "link" in a direct
 *  message"), so it lives here and lenses read it rather than spelling their
 *  own: what the hint says to type is, by construction, what the lens
 *  interprets. A lens with a surface-specific spelling (`/link@Bot`) still
 *  accepts this one. */
export declare const LINK_GESTURE = "link";
export declare function isLinkGesture(text: string): boolean;
/**
 * The wire shape a `native` lens embeds in a button's postback, so the click
 * comes back carrying the canonical token AND the ask it answers (§8.3's
 * staleness rule): terse JSON, `{ t: 'a' | 'd', c: toolCallId }`. Pure, and
 * shared so every surface's buttons decode the same way.
 *
 * `maxBytes` is for providers that cap the postback (Telegram's
 * `callback_data` is 64 bytes). Over the cap the id is DROPPED, not cut:
 * `{ t }` alone still decides the parked ask (the single-winner verdict write
 * is the backstop), whereas a truncated id would name a WRONG ask and be
 * dropped as stale — or worse, collide. Degrading to token-only is deliberate.
 */
export declare function encodeVerdictPostback(token: 'approve' | 'deny', toolCallId: string, opts?: {
    maxBytes?: number;
}): string;
/**
 * The other half: a postback (the raw string, or a value the provider already
 * parsed) → the verdict and, when it rode along, the ask. `null` for anything
 * that is not a verdict postback — malformed JSON, a non-object, an unknown
 * `t` — so a lens maps it to `noop` rather than throwing.
 *
 * `JSON.parse('null')` SUCCEEDS and yields `null`, whose `typeof` is
 * `'object'` — a user-craftable payload that would pass a bare object check
 * and then throw on the `t` read. Guarded explicitly.
 */
export declare function decodeVerdictPostback(raw: unknown): {
    verdict: 'approved' | 'denied';
    toolCallId?: string;
} | null;
/**
 * The ONE rule deciding whether free inbound text answers an outstanding
 * prompt, shared by the pipeline and the round-trip helper so they cannot
 * drift: exact word after trimming, case-insensitive — "yes" and " YES "
 * decide, "yes please" is a message. `toolCallId` travels with the verdict so
 * the router can drop a match whose ask is no longer the parked one.
 */
/** One choice a delivered prompt offered, and the exact ask it answers.
 *  `match` is the reply token the surface's grammar registered (a keyword, a
 *  postback value); `toolCallId` names the parked call, so a stale YES aimed at
 *  last week's ask can never decide today's different one (§8.3). */
export interface ReceiptExpectation {
    match: string;
    verdict: 'approved' | 'denied';
    toolCallId: string;
}
export declare function matchExpectation(text: string, expects: ReadonlyArray<ReceiptExpectation>): {
    verdict: 'approved' | 'denied';
    toolCallId: string;
} | null;
/**
 * The reply grammar a delivered prompt registers (§8.3): what the receipt's
 * `expects` records, and what the inbound side matches free text against
 * before falling through to "this is a message". Only `menu` choices carry a
 * text grammar — `native` postbacks and `link` redemptions arrive as their own
 * event shapes, interpreted by the lens and the token table respectively.
 */
export declare function expectationsFor(prompt: Extract<DeliveryItem, {
    item: 'prompt';
}>): ReceiptExpectation[];
/** Canonical exemplars, one per item kind — the default corpus
 *  `assertLensRoundTrip` renders when the caller supplies none. The corpus
 *  carries a FILE-BEARING reply as well as a bare one, so every lens meets a
 *  file and the naming clause below is exercised by default — a surface that
 *  cannot carry bytes must still say the file's name.
 *
 *  The prompt carries a `display` for the same reason: without one in the
 *  corpus, four shipped lenses dropped it and passed this helper anyway, which
 *  is precisely the silence the clause below now forbids. */
export declare function exemplarItems(): DeliveryItem[];
export interface RoundTripOptions {
    /** The corpus to render; defaults to `exemplarItems()`. */
    items?: DeliveryItem[];
    /** A destination `out` accepts; defaults to `{}`. */
    destination?: unknown;
    /**
     * The half only the lens author can supply: the inbound event the SURFACE
     * would deliver when a user activates `choice` of a rendered prompt. The
     * framework cannot forge a provider's wire format — this closure is where
     * that knowledge lives, next to the lens it tests.
     */
    synthesize?: (choice: PromptChoice, rendered: unknown | unknown[]) => unknown;
    /** A plain inbound message event carrying `text`; checked to read back as a
     *  `message` intent with that text. */
    message?: (text: string) => unknown;
    /**
     * The MEDIA half of the law (participants spec §6.4): a FILE-ONLY inbound
     * event — no text, carrying these files in the surface's own wire shape.
     * Checked to read back as a `message` intent (the sharpened guard: a file
     * with no words is still a message) whose `attachments` carry every file's
     * name and contentType. Without this, all four chat translations would ship
     * on the one seam the contract leaves untested.
     */
    mediaMessage?: (files: Array<{
        name: string;
        contentType: string;
    }>) => unknown;
}
/**
 * The shipped round-trip helper. Two jobs:
 *
 *  TOTALITY — every delivery item renders to a non-null payload, so no surface
 *  can silently drop an approval ask.
 *
 *  ROUND-TRIP — every affordance `out` offers, `in` interprets back to the
 *  exact canonical intent: render the prompt, feed each choice's synthetic
 *  event through `in`, require the matching verdict. If a lens renders a
 *  button it must interpret the click; if it renders "Reply YES" it must
 *  interpret YES.
 *
 * Throws with a named failure on the first violation; returns quietly when the
 * lens holds. Pure lens + caller-supplied synthetic events = runnable with no
 * provider credentials.
 */
export declare function assertLensRoundTrip(lens: Lens, profile: ChannelProfile, opts?: RoundTripOptions): void;
//# sourceMappingURL=channel-contract.d.ts.map