import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import type { Fields, TypedCollection } from '../common/db';
import { AgentAttachments, sanitizeAttachmentName } from './attachments';

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

/** Short by design: the chip mints on CLICK, so the token is a fetch handle,
 *  not a share handle — nothing mail-scanner-shaped ever sees one, and a
 *  leaked link is dead within the minute. */
const DOWNLOAD_TOKEN_TTL_MS = 60_000;

/**
 * Mint a download token for a ref in an ALREADY-AUTHORIZED session. The
 * AUTHORIZATION lives at the caller (`agent.attachmentToken` in methods.ts
 * runs `requireSession` — owner, account member, the anonymous capability —
 * before minting), keeping this module a leaf; the session-scoped existence
 * check here is what makes a ref a capability only inside its own
 * conversation, and the token inherits exactly that scope. Null = no such
 * ref in that session.
 */
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

/**
 * Redeem a token: burned atomically (`findOneAndDelete` — of two racing GETs
 * exactly one serves), expiry checked in code (the TTL index is only the
 * janitor), then a SESSION-SCOPED store read. Unknown, spent, expired, and
 * reaped-attachment all return null — one indistinguishable 404, so a probe
 * learns nothing about which.
 */
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

/**
 * The HTTP half, testable without a server (the `handleInbound` pattern):
 * token → status + headers + body. `Content-Disposition: attachment` and
 * `nosniff` are unconditional — the store must never become a same-origin
 * XSS host — and the filename is quoted-sanitized on top of the store's own
 * display-string discipline.
 */
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

/**
 * Mount `GET /agent/attachments/<token>` — its OWN startup call, outside the
 * channels guard (the channel routes mount only when channels exist, and a
 * web app with no channel still downloads its files), and not under test:
 * route tests drive `handleDownload` directly.
 */
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
