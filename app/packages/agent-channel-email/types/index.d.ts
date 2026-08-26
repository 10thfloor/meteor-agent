import { type ChannelDef, type ChannelKnobs, type ChannelProfile, type ChannelTransport, type Gate, type InlineTool, type Lens, type RawInbound } from 'meteor/10thfloor:agent';
/**
 * The email channel — Postmark as the reference provider: one lens, one
 * transport, one profile default, zero npm dependencies (Postmark is JSON
 * both ways over `fetch`; the inbound webhook's trust boundary is the
 * Basic-auth credential Postmark sends, compared in constant time).
 *
 * The five decisions, stated up front — email answers them least like the
 * chat surfaces, which is why it is worth having:
 *
 *  CONVERSATION KEY — the THREAD, recovered STATELESSLY. The first message's
 *  Message-ID is the thread root; its key is a short hash of that id. Every
 *  reply we send sets `Reply-To: <local>+<key>@<inbound domain>`, so a later
 *  reply — even from a client that drops `References` — comes back carrying
 *  the key as Postmark's `MailboxHash`. Fallback order: mailbox hash, then
 *  the first `References` entry (the root), then `In-Reply-To`, then the
 *  message's own id (a new thread). The lens never needs a lookup table.
 *
 *  IDENTITY KEY — the sender address, normalized. WEAK: a From header is
 *  forgeable unless the receiving provider enforced DKIM/SPF on the way in,
 *  and that is the provider's setting, not ours. Fine to recognize, never to
 *  privilege until linked — and linking by answering the word "link" to that
 *  very address is the classic email verification.
 *
 *  AUDIENCE — `direct`: our replies go to one address, the sender.
 *
 *  INTERACTION — `link`: approvals render as single-use Approve / Deny URLs
 *  the core mints per choice at delivery (`approvalUrl`). Without an
 *  `approvalUrl` the factory falls back to `menu` — "Reply YES to approve" —
 *  which the pipeline matches against the reply's stripped text. Both are
 *  honest email; the link form is the one that survives mail clients.
 *
 *  ECHO RULE — the email self-reply loop is auto-responder ping-pong:
 *  out-of-office replies, bounces, mailer-daemon and list traffic are noops
 *  (`Auto-Submitted`, `X-Autoreply`, `Precedence`, the daemon senders), so
 *  the agent never answers a machine that will answer it back.
 */
/** The thread key: a short, address-safe hash of the root Message-ID.
 *  Normalized (no angle brackets, lower-cased, trimmed) so the same id keyed
 *  from a `References` entry and from a `Message-ID` header agree. */
export declare function threadKey(rootMessageId: string): string;
/** `reply+<key>@inbound.example.com` — the address whose plus-hash carries
 *  the conversation back to us, whatever the client does to the headers. */
export declare function replyToFor(inboundAddress: string, key: string): string;
/** `Re:` once, whatever the incoming subject carried. */
export declare function reSubject(subject: string | undefined): string;
/**
 * The new text above a quoted reply — what the sender actually wrote.
 * Postmark's `StrippedTextReply` does this well when present; this is the
 * fallback for providers and clients that do not. Cuts at the common reply
 * markers ("On … wrote:", Outlook's "-----Original Message-----" / "From:"
 * block, the "___" rule), drops `>`-quoted lines, and trims a "-- "
 * signature. Conservative on purpose: when unsure it keeps text — a reply
 * with a stray quoted line is a message; a reply stripped to nothing is a
 * noop nobody can explain.
 */
export declare function stripQuotedReply(text: string): string;
/**
 * Postmark's inbound webhook carries no signature; the documented trust
 * boundary is HTTP Basic auth in the webhook URL (`https://user:pass@host/…`),
 * which Postmark sends as an `Authorization: Basic …` header on every post.
 * Compared in constant time; an IP allowlist at the edge is the belt to this
 * suspenders (README).
 */
export declare function verifyPostmarkWebhook(raw: RawInbound, user: string, password: string): boolean;
export type EmailEvent = {
    email: 'inbound';
    body: any;
} | {
    email: 'ignore';
};
export declare function parsePostmarkInbound(raw: RawInbound): EmailEvent;
/** What the transport needs to thread a reply, fixed at bind time. `subject`
 *  and `rootMessageId` never change for the thread's life; `to` is the
 *  sender; `replyKey` is what becomes the Reply-To mailbox hash. */
export interface EmailDestination {
    to: string;
    subject: string;
    rootMessageId?: string;
    replyKey: string;
}
/**
 * Whether the mail's `From` was authenticated by the receiving provider —
 * the gate on letting this sender resolve to a LINKED account (a raw From is
 * forgeable SMTP; an unverified one must stay anonymous, per the header
 * comment). Postmark exposes no dedicated auth field: it runs SpamAssassin on
 * inbound mail and reports the verdicts in `X-Spam-Tests` (a comma/space
 * list). `DKIM_VALID_AU` is the token that matters — a DKIM signature that is
 * valid AND aligned to the AUTHOR (the From domain), i.e. the From was not
 * forged. `SPF_PASS` is deliberately NOT accepted: SPF authenticates the
 * envelope return-path, not the header From, so it does not prove the From a
 * human reads (and a spoofer's own domain passes its own SPF). An absent
 * header — SpamAssassin disabled on the stream, or a provider that does not
 * emit it — reads as UNVERIFIED: fail closed, the sender is treated
 * anonymously and simply cannot inherit a linked account (see the README).
 */
export declare function isFromAuthenticated(headers: Map<string, string>): boolean;
export declare const emailLens: Lens;
export interface EmailTransportOptions {
    /** Postmark Server API token (the server's "API Tokens" page). */
    serverToken: string;
    /** The From address — a verified Sender Signature or domain. */
    from: string;
    /** The inbound address whose plus-hash carries the thread key back —
     *  `inbound@yourdomain.com` (MX'd to Postmark) or the stream's
     *  `…@inbound.postmarkapp.com` address. */
    inboundAddress: string;
    /** Postmark message stream; default `outbound`. */
    messageStream?: string;
    /**
     * The RFC 3834 class stamped on outbound mail. `auto-replied` (default) is
     * the reactive channel's answer-to-a-message; COMPOSE stamps
     * `auto-generated` — a machine-sent mail that OPENS a correspondence rather
     * than answering one. Both suppress well-behaved auto-responders, and our
     * own inbound `isAutomated` drops any echo of either.
     */
    autoSubmitted?: 'auto-replied' | 'auto-generated';
    /** TEST SEAM. */
    fetchImpl?: typeof fetch;
}
/**
 * `POST https://api.postmarkapp.com/email` — one call, JSON. The lens's
 * payload (Subject, TextBody) is spread FIRST and addressing last, so no
 * payload can redirect a post (the sweep's rule for every transport). The
 * receipt key rides a custom header; Postmark has no idempotency key on
 * send, so this channel's recovery tier is `retry` (§11 tier C, declared).
 */
export declare function emailTransport(options: EmailTransportOptions): ChannelTransport;
export interface EmailChannelOptions extends ChannelKnobs {
    agent: string;
    serverToken: string;
    from: string;
    inboundAddress: string;
    /** The Basic-auth credential you put in the inbound webhook URL. */
    webhookUser: string;
    webhookPassword: string;
    /** Turns a minted verdict token into the URL an approval mail's Approve /
     *  Deny lines carry (`link` profile). Omit it and the factory falls back
     *  to the `menu` profile — "Reply YES to approve". */
    approvalUrl?: ChannelDef['approvalUrl'];
    messageStream?: string;
    /** Override `limit` only; `interact` follows from `approvalUrl`. */
    profile?: Pick<ChannelProfile, 'limit'>;
    fetchImpl?: typeof fetch;
}
export declare function email(options: EmailChannelOptions): ChannelDef;
/**
 * The recipient POLICY — the one decision compose refuses to default (§7's
 * rule survives contact with a destination parameter: the model PROPOSES
 * `to`; trusted app code decides):
 *
 *   `'linked'`   — addresses in `ChannelIdentities` belonging to the SESSION'S
 *                  OWNER (kind `'email'`). Covers "email it to me"; an
 *                  anonymous session has no linked addresses and every
 *                  recipient is refused.
 *   `string[]`   — an explicit allowlist, compared case-insensitively.
 *   a predicate  — `(to, { sessionId, userId }) => boolean`, sync or async.
 *                  A predicate that THROWS refuses (fail closed).
 */
export type ComposeRecipientsPolicy = 'linked' | string[] | ((to: string, session: {
    sessionId: string;
    userId: string | null;
}) => boolean | Promise<boolean>);
export interface ComposeEmailToolOptions {
    /** The same thin transport the channel uses — compose depends on the
     *  TRANSPORT, not on the channel registration; an app can list this tool
     *  with no email channel registered at all (§2 decision 6). `'continue'`
     *  is the one mode that needs the registration — see `onReply`. */
    serverToken: string;
    from: string;
    /** Where a recipient's REPLY lands. `'fresh'` (the default): composed mail
     *  replies-to the PLAIN inbound address — no thread key — so their answer
     *  starts its own fresh conversation (email v2 decision 8). `'continue'`
     *  supersedes it (participants spec §5). */
    inboundAddress: string;
    messageStream?: string;
    fetchImpl?: typeof fetch;
    /** REQUIRED — no permissive default exists. See `ComposeRecipientsPolicy`. */
    recipients: ComposeRecipientsPolicy;
    /** Default `'ask'`: every compose parks for approval unless the app
     *  explicitly loosens it. The parked prompt shows `to`, `subject`, `body`
     *  and the ref ids through the existing prompt rendering. */
    gate?: Gate;
    /**
     * What a recipient's reply does (participants spec §5, superseding email
     * v2 decision 8). `'fresh'` (the default): the reply opens its own new
     * conversation. `'continue'`: the send mints the thread key decision 8
     * withheld, pre-binds the conversation to the COMPOSING session (a
     * `member: true` binding — outward replies only, no prompts, no capability
     * URLs), and joins the recipient to the roster — their reply continues
     * this session, attributed. NAMED LOUDLY: 'continue' turns the session
     * into a group conversation; every subsequent outward reply is delivered
     * to the recipient. It requires the `kind` channel to be REGISTERED (the
     * reply needs a webhook to arrive through) and refuses — structured,
     * model-routable — inside throwaway (`Agent.ask`) and subagent-child
     * sessions, whose lifetimes cannot honor a promised correspondence.
     */
    onReply?: 'fresh' | 'continue';
    /** The registered channel KIND whose webhook carries `'continue'` replies —
     *  kinds are app-chosen strings, so it cannot be assumed. Default 'email'.
     *  The registered channel's inboundAddress must be THIS tool's
     *  `inboundAddress`, or the minted Reply-To points at a webhook that will
     *  never see the reply. */
    kind?: string;
    name?: string;
    description?: string;
}
/**
 * A tool factory: compose and send a NEW email — the §7 side-action pattern
 * with the one parameter §7 forbids (a destination) handled the only
 * acceptable way: validated by app-authored policy, gated `'ask'` by default.
 *
 *   tools: [composeEmailTool({
 *     serverToken, from: 'Agent <agent@ourdomain.com>', inboundAddress,
 *     recipients: (to) => to.endsWith('@ourco.com'),
 *   })]
 *
 * Effectively-once through the existing three-phase receipt log: the tool
 * passes `deliverOnce` a SYNTHETIC binding keyed on the tool call
 * (`compose:email:<toolCallId>`), so the crash-recovery re-run of a dispatched
 * tool finds the receipt settled and does not re-send — §7's "idempotency key
 * carried through to the tool itself", verbatim.
 *
 * What compose is NOT: a reply path. The worker already delivers the turn's
 * answer to the conversation's own surfaces; composing to the person you are
 * talking to is the double-delivery trap. The description says so to the model.
 */
export declare function composeEmailTool(options: ComposeEmailToolOptions): InlineTool;
//# sourceMappingURL=index.d.ts.map