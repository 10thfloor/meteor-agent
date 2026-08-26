import { timingSafeEqual } from 'crypto';
import type { AgentMessage, AgentSession } from '../../common/types';
import type {
  ChannelProfile, ChannelTransport, Lens, RemoteAttachment,
} from '../../common/channel-contract';

/* Channel registry (§10): `Agent.channel(kind, def)` over a module-level
 * Map. Validated at registration, overwrite-with-warning on hot reload. */

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
export function headerValue(raw: RawInbound, name: string): string | undefined {
  const v = raw.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Constant-time string equality for signature checks. Server-only. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

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
  throttle?: { limit: number; intervalMs: number };
  /** Inbound attachment caps. `false` = drop all; absent = defaults. */
  attachments?: false | { maxFileBytes?: number; maxFiles?: number; maxTotalBytes?: number };
  /** Admission policy for new bindings. Default `'opener'`. */
  admits?: 'opener' | 'members' | 'linked';
  /** Destination adoption (§5): merge incoming addressing into a binding
   *  whose stored destination is incomplete. Pure. */
  adoptDestination?: (bound: unknown, incoming: unknown) => unknown | undefined;
  /** Remote-media recipe (§6). `hosts` is the SSRF allowlist; `request`
   *  builds the credentialed fetch; `resolveIndirect` handles two-hop URLs. */
  media?: {
    hosts: string[];
    request?: (att: RemoteAttachment) => { url: string; headers?: Record<string, string> };
    resolveIndirect?: (json: unknown) => string | null;
  };
  /** Webhook body ceiling when 1 MB is too small (email's base64'd
   *  attachments). Full body verification happens after this capped read;
   *  `preverify` may reject a header-authenticated request before it. */
  maxInboundBytes?: number;
}

/** Knobs a tier-1 factory forwards to core untouched. */
export type ChannelKnobs = Pick<
  ChannelDef,
  'statuses' | 'onUncertainDelivery' | 'sessionUrl' | 'linkUrl' | 'throttle'
  | 'attachments' | 'maxInboundBytes' | 'admits'
>;

/** Value-side twin of `ChannelKnobs` — `satisfies` catches a missing key. */
export const CHANNEL_KNOB_KEYS = [
  'statuses', 'onUncertainDelivery', 'sessionUrl', 'linkUrl', 'throttle',
  'attachments', 'maxInboundBytes', 'admits',
] as const satisfies ReadonlyArray<keyof ChannelKnobs>;

/** Copy only the knobs present on `options` — no explicit-undefined keys. */
export function channelKnobs(options: ChannelKnobs): ChannelKnobs {
  const out: Record<string, unknown> = {};
  for (const key of CHANNEL_KNOB_KEYS) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out as ChannelKnobs;
}

const channels = new Map<string, ChannelDef>();

export function registerChannel(kind: string, def: ChannelDef): void {
  if (typeof kind !== 'string' || kind === '' || /[^a-z0-9_-]/i.test(kind)) {
    throw new Error(
      '[10thfloor:agent] Agent.channel(kind, def) needs a short identifier kind '
      + `(letters, digits, - or _); got ${JSON.stringify(kind)}`,
    );
  }
  // Validate at registration so a miswired channel is a startup error.
  if (!def || typeof def.agent !== 'string' || def.agent === '') {
    throw new Error(`[10thfloor:agent] channel "${kind}": def.agent must name a registered agent`);
  }
  if (!def.transport || typeof def.transport.post !== 'function') {
    throw new Error(`[10thfloor:agent] channel "${kind}": def.transport.post must be a function`);
  }
  if (!def.lens || typeof def.lens.out !== 'function' || typeof def.lens.in !== 'function') {
    throw new Error(`[10thfloor:agent] channel "${kind}": def.lens must carry out() and in()`);
  }
  if (!def.profile || !['native', 'menu', 'link'].includes(def.profile.interact)) {
    throw new Error(
      `[10thfloor:agent] channel "${kind}": def.profile.interact must be `
      + "'native', 'menu' or 'link'",
    );
  }
  if (typeof def.verify !== 'function' || typeof def.parse !== 'function') {
    throw new Error(`[10thfloor:agent] channel "${kind}": def.verify and def.parse are required`);
  }
  if (def.preverify !== undefined && typeof def.preverify !== 'function') {
    throw new Error(`[10thfloor:agent] channel "${kind}": def.preverify must be a function`);
  }
  // Half-specified throttle would silently never throttle.
  if (def.throttle && !(
    Number.isFinite(def.throttle.limit) && def.throttle.limit > 0
    && Number.isFinite(def.throttle.intervalMs) && def.throttle.intervalMs > 0
  )) {
    throw new Error(`[10thfloor:agent] channel "${kind}": def.throttle must be { limit > 0, intervalMs > 0 }`);
  }
  // Non-positive body cap would refuse every webhook silently.
  if (def.maxInboundBytes !== undefined
    && !(Number.isFinite(def.maxInboundBytes) && def.maxInboundBytes > 0)) {
    throw new Error(`[10thfloor:agent] channel "${kind}": def.maxInboundBytes must be a positive number`);
  }
  if (def.admits !== undefined && !['opener', 'members', 'linked'].includes(def.admits)) {
    throw new Error(
      `[10thfloor:agent] channel "${kind}": def.admits must be 'opener', 'members' or 'linked'`,
    );
  }
  // No allowlist would make the fetcher an open proxy.
  if (def.media !== undefined && !(
    Array.isArray(def.media.hosts) && def.media.hosts.length > 0
    && def.media.hosts.every((h) => typeof h === 'string' && h !== '')
  )) {
    throw new Error(
      `[10thfloor:agent] channel "${kind}": def.media.hosts must be a non-empty `
      + 'array of hostnames — it is the fetcher\'s SSRF allowlist',
    );
  }
  if (def.onUncertainDelivery === 'reconcile' && typeof def.transport.reconcile !== 'function') {
    throw new Error(
      `[10thfloor:agent] channel "${kind}": onUncertainDelivery 'reconcile' needs `
      + 'transport.reconcile (tier B, spec §11) — declare \'retry\' or \'abandon\' instead',
    );
  }
  if (channels.has(kind)) {
    console.warn(
      `[10thfloor:agent] channel "${kind}" was already registered; overwriting `
      + '(expected on a dev hot reload, a real conflict otherwise)',
    );
  }
  channels.set(kind, def);
}

export function getChannel(kind: string): ChannelDef | undefined {
  return channels.get(kind);
}

/** Every registered channel as `[kind, def]` pairs. */
export function listChannels(): Array<[string, ChannelDef]> {
  return [...channels.entries()];
}

/** Test seam: clear the registry between tests. */
export function _clearChannels(): void {
  channels.clear();
}

/** Recovery mode for a `sending` receipt after crash (§11). */
export function uncertainDeliveryMode(
  def: Pick<ChannelDef, 'transport' | 'onUncertainDelivery'>,
): 'reconcile' | 'retry' | 'abandon' {
  if (def.onUncertainDelivery) return def.onUncertainDelivery;
  return typeof def.transport.reconcile === 'function' ? 'reconcile' : 'retry';
}
