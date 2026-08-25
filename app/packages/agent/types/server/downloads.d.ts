import type { Fields, TypedCollection } from '../common/db';
/**
 * The web download surface (participants spec §7): a minted, SINGLE-USE
 * capability — never a standing URL. The chip's click calls the DDP method,
 * which authorizes exactly like the publication (roster-aware, the anonymous
 * capability included), mints a ~60-second token, and the browser GETs
 * `/agent/attachments/<token>`. Owned and anonymous sessions use the
 * IDENTICAL flow — the method is the gate, so there is no
 * login-cookie-on-GET problem and no permanent URL to leak. Serving is
 * `Content-Disposition: attachment` + `nosniff`, always: a stored HTML or
 * SVG file must never execute in the app's origin.
 */
/** One minted download: the full link-token idiom — `Random.secret()` id,
 *  TTL-indexed `expiresAt` checked in code at redemption, burned atomically
 *  by `findOneAndDelete`, and DENY-BELTED in server/index.ts (without that, a
 *  client under `insecure` could insert a forged token naming any session's
 *  attachment — an exfiltration primitive). */
export interface AttachmentDownloadToken {
    _id: string;
    sessionId: string;
    attachmentId: string;
    expiresAt: Date;
    createdAt: Date;
}
export type DownloadTokenQuery = Fields<AttachmentDownloadToken> & {
    $or?: DownloadTokenQuery[];
    $and?: DownloadTokenQuery[];
    $nor?: DownloadTokenQuery[];
};
export declare const AttachmentDownloadTokens: TypedCollection<AttachmentDownloadToken, string | DownloadTokenQuery, never>;
/**
 * Mint a download token for a ref in an ALREADY-AUTHORIZED session. The
 * AUTHORIZATION lives at the caller (`agent.attachmentToken` in methods.ts
 * runs `requireSession` — owner, account member, the anonymous capability —
 * before minting), keeping this module a leaf; the session-scoped existence
 * check here is what makes a ref a capability only inside its own
 * conversation, and the token inherits exactly that scope. Null = no such
 * ref in that session.
 */
export declare function issueAttachmentToken(sessionId: string, attachmentId: string): Promise<string | null>;
/**
 * Redeem a token: burned atomically (`findOneAndDelete` — of two racing GETs
 * exactly one serves), expiry checked in code (the TTL index is only the
 * janitor), then a SESSION-SCOPED store read. Unknown, spent, expired, and
 * reaped-attachment all return null — one indistinguishable 404, so a probe
 * learns nothing about which.
 */
export declare function redeemAttachmentToken(token: string): Promise<{
    name: string;
    contentType: string;
    content: Buffer;
} | null>;
/** The route path every minted URL points under. */
export declare const DOWNLOAD_ROUTE = "/agent/attachments";
/**
 * The HTTP half, testable without a server (the `handleInbound` pattern):
 * token → status + headers + body. `Content-Disposition: attachment` and
 * `nosniff` are unconditional — the store must never become a same-origin
 * XSS host — and the filename is quoted-sanitized on top of the store's own
 * display-string discipline.
 */
export declare function handleDownload(token: string): Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: Buffer;
}>;
/**
 * Mount `GET /agent/attachments/<token>` — its OWN startup call, outside the
 * channels guard (the channel routes mount only when channels exist, and a
 * web app with no channel still downloads its files), and not under test:
 * route tests drive `handleDownload` directly.
 */
export declare function mountDownloadRoute(webAppHandlers: {
    use(path: string, fn: (req: any, res: any, next: () => void) => void): void;
}): void;
//# sourceMappingURL=downloads.d.ts.map