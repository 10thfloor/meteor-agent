import { type ChannelIdentity } from './collections';
/** The identity row for one external sender, or null — null means UNLINKED,
 *  which is a legal state (an anonymous capability-owned session), never an
 *  error. The reverse lookup is a primary-key read on the derived id. */
export declare function resolveIdentity(kind: string, externalUserId: string): Promise<ChannelIdentity | null>;
/**
 * Mint a single-use, short-lived token bound to ONE external identity. The
 * caller — the pipeline answering a `link-request` intent (`route()` in
 * ingress.ts), or an app's own flow — delivers it to that identity's surface,
 * proving, when it comes back through a signed-in session, that the presenter
 * controls both sides. (A lens never calls this: lenses are pure.)
 */
export declare function issueLinkToken(kind: string, externalUserId: string, opts?: {
    ttlMs?: number;
}): Promise<string>;
/**
 * Burn a token and link its identity to `userId` — called from the app's own
 * authenticated surface (a method or route that already knows who the web user
 * is; that authentication is the app's, not this module's).
 *
 * `findOneAndDelete` is the single-winner point: of two racing redeems exactly
 * one gets the document, so a token is spent at most once even across
 * servers. Expiry is checked on the way out — a TTL index also reaps expired
 * rows (indexes.ts), but Mongo's TTL sweep runs on its own schedule and a
 * token must be dead the millisecond it expires, not within a minute of it.
 *
 * Returns the identity row on success, null on an unknown, spent, or expired
 * token — one indistinguishable null, deliberately, so a probe learns nothing
 * about which.
 */
export declare function redeemLinkToken(token: string, userId: string): Promise<ChannelIdentity | null>;
/**
 * Write the identity row and CLAIM HISTORY (§12): sessions the external
 * identity created before linking are anonymous (`userId: null`), and the
 * moment their owner proves who they are, those sessions become theirs — the
 * alternative is silently losing a user's history the moment they sign in.
 *
 * The rewrite is GUARDED: only rows still owned by `null` and still naming
 * this exact external conversation are touched, so an already-owned session —
 * whatever owns it — is never reassigned. Bindings first, then their sessions,
 * each conditional, so a crash between the two leaves only un-claimed rows the
 * next redeem (idempotent — same derived id, same guards) finishes.
 *
 * OIDC callers use this directly with `assurance: 'oidc'` after their own
 * round-trip proved both sides.
 */
export declare function linkIdentity(kind: string, externalUserId: string, userId: string, assurance: 'link' | 'oidc'): Promise<ChannelIdentity>;
/**
 * Mint the approval capability for ONE choice of one delivered prompt — the
 * `link` grammar's affordance. The egress worker calls this when a
 * link-interact channel delivers a prompt; the app's route hands the token to
 * `redeemVerdictToken`. Longer-lived than a linking token by default (a day,
 * not ten minutes): an email approval is read on the reader's schedule, and
 * the real staleness guard is the `toolCallId` check at redemption, not the
 * clock.
 */
export declare function issueVerdictToken(agent: string, sessionId: string, toolCallId: string, verdict: 'approved' | 'denied', opts?: {
    ttlMs?: number;
}): Promise<string>;
/**
 * Burn a verdict token and record its verdict. The token IS the authorization
 * — a capability addressed to the person the prompt was delivered to — so the
 * verdict is recorded AS the session's owner, exactly the identity an
 * anonymous capability-URL approval already uses. The agent's own `approve`
 * predicate is still consulted (it sees that owner), and the single-winner
 * verdict write still applies, so a racing human click and token click
 * produce exactly one verdict.
 *
 * Two staleness guards, layered: the token must name the CURRENTLY parked
 * call (`toolCallId` — a yes aimed at last week's ask cannot decide today's),
 * and beneath that the conditional verdict write remains the final authority.
 *
 * Returns true when this redemption decided the ask; false on an unknown,
 * spent, expired, or stale token — one indistinguishable false, so a probe
 * learns nothing.
 */
export declare function redeemVerdictToken(token: string): Promise<boolean>;
//# sourceMappingURL=linking.d.ts.map