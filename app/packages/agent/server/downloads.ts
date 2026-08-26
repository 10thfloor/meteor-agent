import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import type { Fields, TypedCollection } from '../common/db';
import { AgentAttachments, sanitizeAttachmentName } from './attachments';

/* Web download surface (§7): single-use ~60s tokens, never standing URLs.
 * Served as `attachment` + `nosniff` — stored HTML/SVG must not execute. */

/** One minted download token. DENY-belted in server/index.ts. */
export interface AttachmentDownloadToken {
  _id: string;                    // Random.secret()
  sessionId: string;
  attachmentId: string;
  expiresAt: Date;
  createdAt: Date;
}

export type DownloadTokenQuery =
  & Fields<AttachmentDownloadToken>
  & { $or?: DownloadTokenQuery[]; $and?: DownloadTokenQuery[]; $nor?: DownloadTokenQuery[] };

export const AttachmentDownloadTokens =
  new Mongo.Collection<AttachmentDownloadToken>(NAMES.attachmentTokens) as unknown as
    TypedCollection<AttachmentDownloadToken, string | DownloadTokenQuery, never>;

/** Short by design: minted on click, not shareable. */
const DOWNLOAD_TOKEN_TTL_MS = 60_000;

/** Mint a download token for an attachment in an already-authorized
 *  session. Null = no such ref in that session. */
export async function issueAttachmentToken(
  sessionId: string, attachmentId: string,
): Promise<string | null> {
  const row = await AgentAttachments.findOneAsync({ _id: attachmentId, sessionId });
  if (!row) return null;
  const _id = Random.secret();
  await AttachmentDownloadTokens.insertAsync({
    _id,
    sessionId,
    attachmentId,
    expiresAt: new Date(Date.now() + DOWNLOAD_TOKEN_TTL_MS),
    createdAt: new Date(),
  });
  return _id;
}

/** Redeem a token: burn atomically, check expiry, session-scoped read.
 *  Indistinguishable null on any failure. */
export async function redeemAttachmentToken(
  token: string,
): Promise<{ name: string; contentType: string; content: Buffer } | null> {
  const doc = await AttachmentDownloadTokens.rawCollection().findOneAndDelete(
    { _id: token },
  ) as unknown as AttachmentDownloadToken | null;
  if (!doc || doc.expiresAt.getTime() < Date.now()) return null;
  const row = await AgentAttachments.findOneAsync({
    _id: doc.attachmentId, sessionId: doc.sessionId,
  });
  if (!row) return null;
  return {
    name: sanitizeAttachmentName(row.name),
    contentType: row.contentType,
    content: Buffer.from(row.content, 'base64'),
  };
}

/** The route path every minted URL points under. */
export const DOWNLOAD_ROUTE = '/agent/attachments';

/** Token → status + headers + body. Testable without a server. */
export async function handleDownload(token: string): Promise<{
  status: number;
  headers?: Record<string, string>;
  body?: Buffer;
}> {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return { status: 404 };
  const file = await redeemAttachmentToken(token);
  if (!file) return { status: 404 };
  return {
    status: 200,
    headers: {
      'content-type': file.contentType,
      'content-length': String(file.content.length),
      'content-disposition': `attachment; filename="${file.name.replace(/["\\]/g, '_')}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
    body: file.content,
  };
}

/** Mount `GET /agent/attachments/<token>`. Outside the channels guard. */
export function mountDownloadRoute(webAppHandlers: {
  use(path: string, fn: (req: any, res: any, next: () => void) => void): void;
}): void {
  webAppHandlers.use(DOWNLOAD_ROUTE, (req: any, res: any, next: () => void) => {
    const token = String(req.url ?? '').replace(/^\//, '').split('?')[0];
    if (req.method !== 'GET' || token === '') { next(); return; }
    void (async () => {
      try {
        const out = await handleDownload(token);
        res.writeHead(out.status, out.headers ?? { 'content-type': 'text/plain' });
        res.end(out.body ?? '');
      } catch (e) {
        console.error('[10thfloor:agent] attachment download failed:', e);
        try { res.writeHead(500); res.end(); } catch { /* socket gone */ }
      }
    })();
  });
}
