import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import type { Fields, TypedCollection } from '../common/db';
import { AgentAttachments, sanitizeAttachmentName } from './attachments';
import {
  beginSessionMutationOperation, withSessionOperationTransaction,
} from './session-operations';

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
  const operation = await beginSessionMutationOperation(sessionId);
  if (!operation) return null;
  try {
    const _id = Random.secret();
    let issued = false;
    await withSessionOperationTransaction(operation, async (mongoSession) => {
      const row = await AgentAttachments.rawCollection().findOne(
        { _id: attachmentId, sessionId }, { session: mongoSession },
      );
      if (!row) return;
      await AttachmentDownloadTokens.rawCollection().insertOne({
        _id,
        sessionId,
        attachmentId,
        expiresAt: new Date(Date.now() + DOWNLOAD_TOKEN_TTL_MS),
        createdAt: new Date(),
      }, { session: mongoSession });
      issued = true;
    });
    return issued ? _id : null;
  } finally {
    await operation.close();
  }
}

type DownloadedAttachment = { name: string; contentType: string; content: Buffer };

/** Burn a token and hold its Session operation until the caller finishes
 * disclosing the bytes. Indistinguishable null on any failure. */
async function openAttachmentDownload(token: string): Promise<{
  file: DownloadedAttachment;
  signal: AbortSignal;
  assertActive(): Promise<void>;
  close(): Promise<void>;
} | null> {
  const doc = await AttachmentDownloadTokens.rawCollection().findOneAndDelete(
    { _id: token },
  ) as unknown as AttachmentDownloadToken | null;
  if (!doc || doc.expiresAt.getTime() < Date.now()) return null;
  const operation = await beginSessionMutationOperation(doc.sessionId);
  if (!operation) return null;
  let transferred = false;
  try {
    const row = await AgentAttachments.findOneAsync({
      _id: doc.attachmentId, sessionId: doc.sessionId,
    });
    if (!row) return null;
    await operation.assertActive();
    const opened = {
      file: {
        name: sanitizeAttachmentName(row.name),
        contentType: row.contentType,
        content: Buffer.from(row.content, 'base64'),
      },
      signal: operation.signal,
      assertActive: () => operation.assertActive(),
      close: () => operation.close(),
    };
    transferred = true;
    return opened;
  } finally {
    // Once returned, the caller owns the operation through response completion.
    // Every failed lookup/conversion path must release it here instead.
    if (!transferred) await operation.close();
  }
}

/** @internal Buffer-oriented test helper. The mounted HTTP route holds the
 * lifecycle operation through the actual response completion instead. */
export async function redeemAttachmentToken(
  token: string,
): Promise<DownloadedAttachment | null> {
  const opened = await openAttachmentDownload(token);
  if (!opened) return null;
  try {
    return opened.file;
  } finally {
    await opened.close();
  }
}

/** The route path every minted URL points under. */
export const DOWNLOAD_ROUTE = '/agent/attachments';

/** @internal Token → status + headers + body. Testable without a server. */
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
        if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('');
          return;
        }
        const opened = await openAttachmentDownload(token);
        if (!opened) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('');
          return;
        }
        const abortResponse = () => { res.destroy?.(); };
        const operationSignal = opened.signal;
        operationSignal.addEventListener('abort', abortResponse, { once: true });
        try {
          await opened.assertActive();
          const file = opened.file;
          res.writeHead(200, {
            'content-type': file.contentType,
            'content-length': String(file.content.length),
            'content-disposition': `attachment; filename="${file.name.replace(/["\\]/g, '_')}"`,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
          });
          await new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            res.once?.('finish', done);
            res.once?.('close', done);
            res.end(file.content, done);
          });
        } finally {
          operationSignal.removeEventListener('abort', abortResponse);
          await opened.close();
        }
      } catch {
        console.error('[10thfloor:agent] attachment download failed');
        try { res.writeHead(500); res.end(); } catch { /* socket gone */ }
      }
    })();
  });
}
