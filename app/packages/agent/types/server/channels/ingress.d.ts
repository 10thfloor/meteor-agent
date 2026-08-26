import { type RawInbound } from './registry';
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
/** The whole webhook as a function — §9's five steps. Throws only on
 *  unexpected failures; the claim is released so the provider's retry works. */
export declare function handleInbound(kind: string, raw: RawInbound): Promise<InboundResponse>;
/** Cap on webhook bodies — read before full raw-body verification, so without
 *  it a channel lacking header pre-verification could stream GB into memory. */
export declare const MAX_INBOUND_BYTES: number;
/** Mount every registered channel on Meteor's connect handler. Called from
 *  `Meteor.startup`, after all `Agent.channel(...)` registrations. */
export declare function mountChannelRoutes(webAppHandlers: {
    use(path: string, fn: (req: any, res: any, next: () => void) => void): void;
}): void;
export {};
//# sourceMappingURL=ingress.d.ts.map