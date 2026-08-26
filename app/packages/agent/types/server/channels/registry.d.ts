import type { AgentMessage, AgentSession } from '../../common/types';
import type { ChannelProfile, ChannelTransport, Lens, RemoteAttachment } from '../../common/channel-contract';
/** Raw webhook request: unparsed body (signatures sign raw bytes) and
 *  headers lower-cased the Node way. `url` absent in tests. */
export interface RawInbound {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    url?: string;
}
/** The request metadata available before the body is buffered. A pre-verifier
 *  can cheaply reject bearer/header-authenticated webhooks at this stage. */
export type RawInboundHead = Omit<RawInbound, 'rawBody'>;
/** First value of a possibly-repeated header. */
export declare function headerValue(raw: RawInbound, name: string): string | undefined;
/** Constant-time string equality for signature checks. Server-only. */
export declare function safeEqual(a: string, b: string): boolean;
export interface ChannelDef {
    /** Agent this surface drives. */
    agent: string;
    /** Transport — supplied here so the package never depends on a provider SDK. */
    transport: ChannelTransport;
    lens: Lens;
    profile: ChannelProfile;
    /** Optional cheap rejection gate, run before buffering the request body.
     *  Success only permits the read; `verify` remains authoritative afterward. */
    preverify?: (raw: RawInboundHead) => boolean | Promise<boolean>;
    /** Trust boundary: does this request come from the provider? */
    verify: (raw: RawInbound) => boolean | Promise<boolean>;
    /** Raw request → the provider event `lens.in` reads. Pure. */
    parse: (raw: RawInbound) => unknown;
    /** Which note kinds to deliver as `status` items. Default none. */
    statuses?: ReadonlyArray<NonNullable<AgentMessage['kind']>>;
    /** §11 crash recovery: what to do with a receipt found mid-`sending`.
     *  Default: `'reconcile'` if transport supports it, else `'retry'`. */
    onUncertainDelivery?: 'reconcile' | 'retry' | 'abandon';
    /** Session web URL for overflow links (§8.5). Audience rules enforced
     *  by the caller, not here. */
    sessionUrl?: (session: AgentSession) => string | undefined;
    /** Link-interact only (§8.4): verdict token → app URL. */
    approvalUrl?: (token: string) => string;
    /** Linking token → URL for link-request intent (§12). */
    linkUrl?: (token: string) => string;
    /** Per-sender webhook throttle. Default 30/60s. */
    throttle?: {
        limit: number;
        intervalMs: number;
    };
    /** Inbound attachment caps. `false` = drop all; absent = defaults. */
    attachments?: false | {
        maxFileBytes?: number;
        maxFiles?: number;
        maxTotalBytes?: number;
    };
    /** Admission policy for new bindings. Default `'opener'`. */
    admits?: 'opener' | 'members' | 'linked';
    /** Destination adoption (§5): merge incoming addressing into a binding
     *  whose stored destination is incomplete. Pure. */
    adoptDestination?: (bound: unknown, incoming: unknown) => unknown | undefined;
    /** Remote-media recipe (§6). `hosts` is the SSRF allowlist; `request`
     *  builds the credentialed fetch; `resolveIndirect` handles two-hop URLs. */
    media?: {
        hosts: string[];
        request?: (att: RemoteAttachment) => {
            url: string;
            headers?: Record<string, string>;
        };
        resolveIndirect?: (json: unknown) => string | null;
    };
    /** Webhook body ceiling when 1 MB is too small (email's base64'd
     *  attachments). Full body verification happens after this capped read;
     *  `preverify` may reject a header-authenticated request before it. */
    maxInboundBytes?: number;
}
/** Knobs a tier-1 factory forwards to core untouched. */
export type ChannelKnobs = Pick<ChannelDef, 'statuses' | 'onUncertainDelivery' | 'sessionUrl' | 'linkUrl' | 'throttle' | 'attachments' | 'maxInboundBytes' | 'admits'>;
/** Value-side twin of `ChannelKnobs` — `satisfies` catches a missing key. */
export declare const CHANNEL_KNOB_KEYS: readonly ["statuses", "onUncertainDelivery", "sessionUrl", "linkUrl", "throttle", "attachments", "maxInboundBytes", "admits"];
/** Copy only the knobs present on `options` — no explicit-undefined keys. */
export declare function channelKnobs(options: ChannelKnobs): ChannelKnobs;
export declare function registerChannel(kind: string, def: ChannelDef): void;
export declare function getChannel(kind: string): ChannelDef | undefined;
/** Every registered channel as `[kind, def]` pairs. */
export declare function listChannels(): Array<[string, ChannelDef]>;
/** Test seam: clear the registry between tests. */
export declare function _clearChannels(): void;
/** Recovery mode for a `sending` receipt after crash (§11). */
export declare function uncertainDeliveryMode(def: Pick<ChannelDef, 'transport' | 'onUncertainDelivery'>): 'reconcile' | 'retry' | 'abandon';
//# sourceMappingURL=registry.d.ts.map