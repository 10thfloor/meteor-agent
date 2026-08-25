import { type RawInbound } from './registry';
/**
 * Ingress (channels spec §9): one provider-free pipeline every channel shares.
 *
 *   verify signature → lens.in(event) → throttle → claim eventId → route
 *
 * Everything provider-specific happens inside `def.verify`/`def.parse` and the
 * lens; everything after the reading is generic. The core is `handleInbound` —
 * a plain function over `{ headers, rawBody }` returning a status — so the
 * whole pipeline is testable without an HTTP server; `mountChannelRoutes` is
 * the thin express glue that feeds it.
 */
interface InboundResponse {
    status: number;
    body?: string;
}
/** TEST SEAM: throttle state is process-lifetime, and a test must not inherit
 *  the previous test's windows. */
export declare function _clearThrottle(): void;
/** TEST SEAM: how many senders the throttle is currently tracking, and a way
 *  to force the sweep — the bound is the property under test. */
export declare function _throttleStats(now?: number): {
    tracked: number;
};
/**
 * The whole webhook, as a function — §9's five steps in order. Returns the
 * HTTP answer; throws only on a genuinely unexpected failure — the claim is
 * RELEASED on the way out (the catch below) so the provider's retry can try
 * again, and the mount answers 500.
 */
export declare function handleInbound(kind: string, raw: RawInbound): Promise<InboundResponse>;
/**
 * The most a webhook body may be. Every provider's payload is small (a Slack
 * event envelope is a few KB; Twilio's form a few hundred bytes), and this
 * read happens BEFORE signature verification — so without a cap an
 * unauthenticated sender could stream gigabytes into process memory. Over
 * the cap the socket is closed and the request answered 413, having spent
 * nothing but the bytes already buffered.
 */
export declare const MAX_INBOUND_BYTES: number;
/**
 * Mount every registered channel at `/agent/channels/<kind>` on Meteor's
 * connect/express handler stack. Called from the package's `Meteor.startup`
 * (server/index.ts), by which point every app-file `Agent.channel(...)` has
 * run — startup callbacks fire after all code loads.
 */
export declare function mountChannelRoutes(webAppHandlers: {
    use(path: string, fn: (req: any, res: any, next: () => void) => void): void;
}): void;
export {};
//# sourceMappingURL=ingress.d.ts.map