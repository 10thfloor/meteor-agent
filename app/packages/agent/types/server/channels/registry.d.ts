import type { AgentMessage, AgentSession } from '../../common/types';
import type { ChannelProfile, ChannelTransport, Lens, RemoteAttachment } from '../../common/channel-contract';
/**
 * The channel registry (channels spec §10): a static `Agent.channel(kind, def)`
 * over a module-level Map, exactly the `Agent.provider` shape — validated
 * cheaply at registration, resolved at use, overwrite-with-warning on
 * re-registration so a dev hot reload does not throw.
 *
 * A channel definition is everything one surface needs and nothing more: one
 * lens, one transport, one profile, the webhook's trust boundary, and the
 * knobs the shared machinery reads. Everything else — the worker, the planner,
 * the pipeline, the tables — is shared.
 */
/** The raw material the webhook hands a channel's `verify`/`parse`: headers
 *  lower-cased the Node way, and the UNPARSED body, because signature schemes
 *  (Slack's v0 HMAC, Twilio's) sign the raw bytes and a re-serialized JSON
 *  body would never verify. `url` is the request's path+query as Node saw it —
 *  some providers put protocol material there (WhatsApp's GET subscription
 *  handshake carries `hub.challenge` in the query; Twilio's signature covers
 *  the full webhook URL). Absent when a caller has no HTTP request (tests
 *  driving `handleInbound` directly). */
export interface RawInbound {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    url?: string;
}
/** The first value of a possibly-repeated header — Node hands a repeated
 *  header up as an array, and a signature scheme wants ONE string to check.
 *  `undefined` when absent. */
export declare function headerValue(raw: RawInbound, name: string): string | undefined;
/** Constant-time string equality for signature checks. `timingSafeEqual`
 *  throws on unequal lengths, so the length is compared first — which leaks
 *  the length, not the content, and every scheme's digest length is public
 *  anyway. SERVER-ONLY (Buffer, crypto) — which is why it lives here beside
 *  `RawInbound` and not in the isomorphic contract. */
export declare function safeEqual(a: string, b: string): boolean;
export interface ChannelDef {
    /** The registered agent this surface drives. */
    agent: string;
    /** The provider call itself — supplied here so the package never depends on
     *  a provider SDK. */
    transport: ChannelTransport;
    lens: Lens;
    profile: ChannelProfile;
    /** The trust boundary (§9 step 1): does this request really come from the
     *  provider? A false is answered 401 before anything else runs. */
    verify: (raw: RawInbound) => boolean | Promise<boolean>;
    /** Raw request → the provider event `lens.in` reads. Pure. */
    parse: (raw: RawInbound) => unknown;
    /** Which note kinds this surface delivers as `status` items (§8.2). Default
     *  none — an error is worth an SMS, a compaction note is not, and the
     *  channel says which. */
    statuses?: ReadonlyArray<NonNullable<AgentMessage['kind']>>;
    /**
     * §11's tier declaration: what to do with a receipt found mid-`sending`
     * after a crash. `'reconcile'` needs `transport.reconcile` (tier B);
     * `'retry'` re-posts under the same idempotency key (tier A — the provider
     * collapses it; on a tier-C transport this MAY DUPLICATE); `'abandon'` marks
     * the receipt abandoned and moves on (MAY LOSE). Leaving a tier-C transport
     * undeclared just picks one by accident, so the default is `'reconcile'`
     * when the transport can, `'retry'` otherwise.
     */
    onUncertainDelivery?: 'reconcile' | 'retry' | 'abandon';
    /**
     * The session's web view for overflow links (§8.5). App-supplied because
     * only the app knows its routes. The AUDIENCE rule is enforced by the
     * caller, not here: for an anonymous session the URL is the credential and
     * is only ever sent to a `direct` destination.
     */
    sessionUrl?: (session: AgentSession) => string | undefined;
    /**
     * `link`-interact channels only (§8.4): turn a minted verdict token into the
     * app URL a prompt's choice renders as. The app's route hands the token back
     * to `redeemVerdictToken`, which burns it and records the verdict. Without
     * this, a `link` channel's prompts render without URLs and the lens must say
     * how to answer some other way.
     */
    approvalUrl?: (token: string) => string;
    /**
     * Where a minted LINKING token (§12) becomes a URL the surface can carry —
     * the answer to a `link-request` intent. The app's route hands the token to
     * `redeemLinkToken` from a signed-in session. Without this, link-requests
     * are acknowledged and ignored.
     */
    linkUrl?: (token: string) => string;
    /** The per-sender webhook throttle (§9 step 3). In-memory, per process —
     *  the brake on a flood, not an accounting system. Default 30 events per
     *  60s per sender. */
    throttle?: {
        limit: number;
        intervalMs: number;
    };
    /**
     * Inbound attachment admission for this surface (email v2 spec §5). `false`
     * restores the ignore-them behavior (files are dropped without a store
     * write or a note); an object overrides the default caps
     * (`DEFAULT_ATTACHMENT_CAPS` — 5 MB/file, 5 files, 6 MB/message); absent
     * means the defaults. Caps are CORE policy, applied by the pipeline at
     * admission — never by the lens, which only translates.
     */
    attachments?: false | {
        maxFileBytes?: number;
        maxFiles?: number;
        maxTotalBytes?: number;
    };
    /**
     * The admission policy NEW bindings of this channel are stamped with
     * (participants spec decision 11) — see `ChannelBinding.admits`. Default
     * `'opener'`, v1's posture. A group-thread deployment that wants every
     * linked workspace member speaking sets `'linked'`; compose's pre-bind
     * writes `'members'` on its own binding regardless of this knob.
     */
    admits?: 'opener' | 'members' | 'linked';
    /**
     * DESTINATION ADOPTION (participants spec §5): merge what an admitted
     * inbound event knows about the conversation's addressing into a binding
     * whose stored destination is missing it. Email is the motivating case —
     * a compose pre-bind knows no `rootMessageId` (Postmark's send response
     * carries its own id, not the RFC header), so without adoption every
     * subsequent reply ships un-threaded and the conversation shatters in the
     * recipient's mail client. PURE — bound × incoming → merged, or undefined
     * for "keep what is stored". The destination stays opaque to the core;
     * only the channel knows its fields.
     */
    adoptDestination?: (bound: unknown, incoming: unknown) => unknown | undefined;
    /**
     * The remote-media recipe (participants spec §6): how core turns a lens's
     * `RemoteAttachment` references into bytes. `hosts` is the SSRF boundary —
     * an exact-match https allowlist AUTHORED BY THE CHANNEL, never derived
     * from the event; every fetched URL (first hop, indirect hop, redirect
     * targets) must match it. `request` builds the credentialed fetch (the
     * factory closes over its secrets — the lens never carries one); default:
     * the attachment's own `url`, no headers. `resolveIndirect` extracts — or
     * constructs, Telegram's token-in-path case — the second hop's URL from
     * the first response's JSON. A channel whose lens emits remote attachments
     * without this recipe drops every file with a visible note.
     */
    media?: {
        hosts: string[];
        request?: (att: RemoteAttachment) => {
            url: string;
            headers?: Record<string, string>;
        };
        resolveIndirect?: (json: unknown) => string | null;
    };
    /**
     * The webhook body ceiling for THIS surface, when the shared default
     * (`MAX_INBOUND_BYTES`, 1 MB) is too small for the provider's honest
     * payloads. Email needs it: Postmark delivers up to 35 MB of cumulative
     * attachments base64'd INSIDE the webhook JSON, and a 1 MB cap would 413
     * the whole mail — text included — before the lens ever saw it. The read
     * still happens BEFORE signature verification, so this is a per-surface
     * trade the channel makes knowingly; admission caps then decide what is
     * KEPT (parsing the body is the provider's ceiling, not ours to change
     * from below — email v2 spec §11).
     */
    maxInboundBytes?: number;
}
/** The knobs a tier-1 factory forwards to the core untouched (§8.7): a
 *  channel package's `options` accepts these by the core's own types and hands
 *  them to `Agent.channel` as-is, so the package neither re-documents nor
 *  re-validates what the core already owns. */
export type ChannelKnobs = Pick<ChannelDef, 'statuses' | 'onUncertainDelivery' | 'sessionUrl' | 'linkUrl' | 'throttle' | 'attachments' | 'maxInboundBytes' | 'admits'>;
/** The value-side twin of `ChannelKnobs`, and its totality check: the keys a
 *  factory forwards, as data, `satisfies` the type so a knob added to the Pick
 *  without a matching entry here is a compile error — not a silently dropped
 *  option in four packages. */
export declare const CHANNEL_KNOB_KEYS: readonly ["statuses", "onUncertainDelivery", "sessionUrl", "linkUrl", "throttle", "attachments", "maxInboundBytes", "admits"];
/** The knobs PRESENT on `options`, and nothing else — what a tier-1 factory
 *  spreads into its ChannelDef. Copied only when set, so a def carries no
 *  explicit-undefined keys; one place, so every package forwards every knob. */
export declare function channelKnobs(options: ChannelKnobs): ChannelKnobs;
export declare function registerChannel(kind: string, def: ChannelDef): void;
export declare function getChannel(kind: string): ChannelDef | undefined;
/** Every registered channel as `[kind, def]` pairs, for boot wiring and for a
 *  host's own admin surface. A fresh array — the Map is not handed out. */
export declare function listChannels(): Array<[string, ChannelDef]>;
/** TEST SEAM, like `Agent.clearHooks`: channels register once at startup in an
 *  app, so the only caller with a reason to clear them is a test that must not
 *  leak one into the next test's boot. */
export declare function _clearChannels(): void;
/** The declared recovery for a `sending` receipt (§11) — see
 *  `ChannelDef.onUncertainDelivery` for why the default depends on the
 *  transport's capability. A PICK because `deliverOnce` may be handed a bare
 *  transport+lens (compose's explicit def) rather than a registered channel. */
export declare function uncertainDeliveryMode(def: Pick<ChannelDef, 'transport' | 'onUncertainDelivery'>): 'reconcile' | 'retry' | 'abandon';
//# sourceMappingURL=registry.d.ts.map