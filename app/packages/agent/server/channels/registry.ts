import { timingSafeEqual } from 'crypto';
import type { AgentMessage, AgentSession } from '../../common/types';
import type { ChannelProfile, ChannelTransport, Lens } from '../../common/channel-contract';

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
export function headerValue(raw: RawInbound, name: string): string | undefined {
  const v = raw.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Constant-time string equality for signature checks. `timingSafeEqual`
 *  throws on unequal lengths, so the length is compared first — which leaks
 *  the length, not the content, and every scheme's digest length is public
 *  anyway. SERVER-ONLY (Buffer, crypto) — which is why it lives here beside
 *  `RawInbound` and not in the isomorphic contract. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

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
  throttle?: { limit: number; intervalMs: number };
}

/** The knobs a tier-1 factory forwards to the core untouched (§8.7): a
 *  channel package's `options` accepts these by the core's own types and hands
 *  them to `Agent.channel` as-is, so the package neither re-documents nor
 *  re-validates what the core already owns. */
export type ChannelKnobs = Pick<
  ChannelDef, 'statuses' | 'onUncertainDelivery' | 'sessionUrl' | 'linkUrl' | 'throttle'
>;

/** The value-side twin of `ChannelKnobs`, and its totality check: the keys a
 *  factory forwards, as data, `satisfies` the type so a knob added to the Pick
 *  without a matching entry here is a compile error — not a silently dropped
 *  option in four packages. */
export const CHANNEL_KNOB_KEYS = [
  'statuses', 'onUncertainDelivery', 'sessionUrl', 'linkUrl', 'throttle',
] as const satisfies ReadonlyArray<keyof ChannelKnobs>;

/** The knobs PRESENT on `options`, and nothing else — what a tier-1 factory
 *  spreads into its ChannelDef. Copied only when set, so a def carries no
 *  explicit-undefined keys; one place, so every package forwards every knob. */
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
  // Validate the pieces the shared machinery will call, at registration, so a
  // miswired channel is a startup error rather than a dropped delivery.
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
  // A half-specified throttle (`{ limit: 30 }` from a JS host) would make every
  // window compare against `undefined`, filter empty, and never throttle —
  // silently. Refuse it here, like every other knob the machinery reads.
  if (def.throttle && !(
    Number.isFinite(def.throttle.limit) && def.throttle.limit > 0
    && Number.isFinite(def.throttle.intervalMs) && def.throttle.intervalMs > 0
  )) {
    throw new Error(`[10thfloor:agent] channel "${kind}": def.throttle must be { limit > 0, intervalMs > 0 }`);
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

/** Every registered channel as `[kind, def]` pairs, for boot wiring and for a
 *  host's own admin surface. A fresh array — the Map is not handed out. */
export function listChannels(): Array<[string, ChannelDef]> {
  return [...channels.entries()];
}

/** TEST SEAM, like `Agent.clearHooks`: channels register once at startup in an
 *  app, so the only caller with a reason to clear them is a test that must not
 *  leak one into the next test's boot. */
export function _clearChannels(): void {
  channels.clear();
}

/** The declared recovery for a `sending` receipt (§11) — see
 *  `ChannelDef.onUncertainDelivery` for why the default depends on the
 *  transport's capability. */
export function uncertainDeliveryMode(def: ChannelDef): 'reconcile' | 'retry' | 'abandon' {
  if (def.onUncertainDelivery) return def.onUncertainDelivery;
  return typeof def.transport.reconcile === 'function' ? 'reconcile' : 'retry';
}
