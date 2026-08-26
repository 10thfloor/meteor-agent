import type { Fields, TypedCollection } from '../common/db';
/** One minted download token. DENY-belted in server/index.ts. */
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
/** Mint a download token for an attachment in an already-authorized
 *  session. Null = no such ref in that session. */
export declare function issueAttachmentToken(sessionId: string, attachmentId: string): Promise<string | null>;
/** Redeem a token: burn atomically, check expiry, session-scoped read.
 *  Indistinguishable null on any failure. */
export declare function redeemAttachmentToken(token: string): Promise<{
    name: string;
    contentType: string;
    content: Buffer;
} | null>;
/** The route path every minted URL points under. */
export declare const DOWNLOAD_ROUTE = "/agent/attachments";
/** Token → status + headers + body. Testable without a server. */
export declare function handleDownload(token: string): Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: Buffer;
}>;
/** Mount `GET /agent/attachments/<token>`. Outside the channels guard. */
export declare function mountDownloadRoute(webAppHandlers: {
    use(path: string, fn: (req: any, res: any, next: () => void) => void): void;
}): void;
//# sourceMappingURL=downloads.d.ts.map