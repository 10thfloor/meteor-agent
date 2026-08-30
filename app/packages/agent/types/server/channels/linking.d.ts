import { type ChannelIdentity } from './collections';
/** The identity row for one external sender, or null — null means UNLINKED,
 *  which is a legal state (an anonymous capability-owned session), never an
 *  error. The reverse lookup is a primary-key read on the derived id. */
export declare function resolveIdentity(kind: string, externalUserId: string): Promise<ChannelIdentity | null>;
/** Mint a single-use token bound to one external identity. The caller
 *  delivers it to that surface; presenting it from a signed-in session
 *  proves control of both sides. */
export declare function issueLinkToken(kind: string, externalUserId: string, opts?: {
    ttlMs?: number;
}): Promise<string>;
export interface LinkTokenPreview {
    state: 'ready' | 'expired' | 'unavailable';
    channel?: string;
    expiresAt?: Date;
}
/** Inspect an account-link capability without spending it. External identity
 * ids remain private; the page only needs the Channel label and expiry. */
export declare function previewLinkToken(token: string): Promise<LinkTokenPreview>;
/** Burn token, link identity. findOneAndDelete is single-winner;
 *  indistinguishable null on any failure. */
export declare function redeemLinkToken(token: string, userId: string): Promise<ChannelIdentity | null>;
/** Write the identity row and claim anonymous history (§12). Guarded:
 *  only null-owned rows matching this external identity are touched, so
 *  crash-recovery is idempotent. OIDC callers use this directly. */
export declare function linkIdentity(kind: string, externalUserId: string, userId: string, assurance: 'link' | 'oidc'): Promise<ChannelIdentity>;
export interface VerdictTokenPreview {
    state: 'ready' | 'expired' | 'unavailable';
    verdict?: 'approved' | 'denied';
    missionTitle?: string;
    toolName?: string;
    requestingAgent?: string;
    runContext?: 'owner' | 'anonymous' | 'elevated';
    source?: string;
    scope?: 'one-call';
    expiresAt?: Date;
}
/** Inspect a verdict capability without spending it. The token itself is the
 * authority to see this deliberately small summary; tool args, user ids, and
 * transcript content never leave the server. A stale/missing request is kept
 * indistinguishable from a token that was already used. */
export declare function previewVerdictToken(token: string): Promise<VerdictTokenPreview>;
/** Mint a verdict-approval token for one choice of one delivered prompt.
 *  24h default TTL; the real staleness guard is toolCallId at redemption. */
export declare function issueVerdictToken(agent: string, sessionId: string, toolCallId: string, verdict: 'approved' | 'denied', opts?: {
    ttlMs?: number;
}): Promise<string>;
/** Burn a verdict token and record the verdict. Token must name the
 *  currently parked toolCallId (staleness guard). Returns true when this
 *  redemption decided the ask; indistinguishable false otherwise. */
export declare function redeemVerdictToken(token: string): Promise<boolean>;
//# sourceMappingURL=linking.d.ts.map