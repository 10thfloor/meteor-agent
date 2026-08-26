import {
  isRemoteAttachment,
  type ChannelAttachment, type InboundAttachment, type RemoteAttachment,
} from '../../common/channel-contract';
import { DEFAULT_ATTACHMENT_CAPS, prettySize, sanitizeAttachmentName } from '../attachments';
import type { ChannelDef } from './registry';

/* Remote-media fetcher. SSRF-guarded: https only, URL must match
 * media.hosts (redirects included). Failures become notes, never throws. */

/** Hop ceilings: redirects per fetch, and one indirect hop by contract. */
const MAX_REDIRECTS = 3;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

let mediaFetch: typeof fetch = globalThis.fetch;

/** Test seam: inject a fetch replacement. Pass null to restore. */
export function _setMediaFetch(fn: typeof fetch | null): () => void {
  const previous = mediaFetch;
  mediaFetch = fn ?? globalThis.fetch;
  return () => { mediaFetch = previous; };
}

function hostAllowed(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.includes(u.hostname);
  } catch {
    return false;
  }
}

/** Single GET: manual redirects, host re-checks, cross-host auth strip,
 *  byte ceiling. Returns bytes or a refusal token. */
async function boundedGet(
  startUrl: string, headers: Record<string, string> | undefined,
  hosts: string[], maxBytes: number, signal: AbortSignal,
): Promise<Buffer | 'untrusted-host' | 'too-large' | 'failed'> {
  let url = startUrl;
  let sendHeaders = headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!hostAllowed(url, hosts)) return 'untrusted-host';
    // eslint-disable-next-line no-await-in-loop
    const res = await mediaFetch(url, {
      redirect: 'manual',
      ...(sendHeaders ? { headers: sendHeaders } : {}),
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return 'failed';
      const next = new URL(location, url).toString();
      // Cross-host redirect: strip auth headers.
      if (new URL(next).hostname !== new URL(url).hostname) sendHeaders = undefined;
      url = next;
      continue;
    }
    if (!res.ok) return 'failed';
    const reader = res.body?.getReader?.();
    if (!reader) {
      // Non-streaming fetch (tests): bound check runs after the read.
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > maxBytes ? 'too-large' : buf;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => { /* the refusal is the answer */ });
        return 'too-large';
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  return 'failed';   // redirect chain never terminated
}

async function fetchOne(
  att: RemoteAttachment, media: NonNullable<ChannelDef['media']>,
  maxBytes: number, timeoutMs: number,
): Promise<ChannelAttachment | string> {
  const name = sanitizeAttachmentName(att.name);
  if (att.declaredSize !== undefined && att.declaredSize > maxBytes) {
    return `[file "${name}" (${prettySize(att.declaredSize)}) exceeded the ${prettySize(maxBytes)} limit and was not fetched]`;
  }
  const request = media.request
    ? media.request(att)
    : (att.url !== undefined ? { url: att.url } : null);
  if (!request) {
    return `[file "${name}" could not be retrieved]`;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let body = await boundedGet(
      request.url, request.headers, media.hosts, maxBytes, abort.signal,
    );
    if (att.indirect && Buffer.isBuffer(body)) {
      // Indirect hop: first response is JSON → resolve to real target URL,
      // fetched with same headers (both targets are allowlisted).
      let target: string | null = null;
      try {
        target = media.resolveIndirect
          ? media.resolveIndirect(JSON.parse(body.toString('utf8')))
          : null;
      } catch {
        target = null;
      }
      body = target === null
        ? 'failed'
        : await boundedGet(target, request.headers, media.hosts, maxBytes, abort.signal);
    }

    if (body === 'untrusted-host') {
      return `[file "${name}" was not kept — its source is not a trusted host for this channel]`;
    }
    if (body === 'too-large') {
      return `[file "${name}" exceeded the ${prettySize(maxBytes)} limit and was not kept]`;
    }
    if (body === 'failed') {
      return `[file "${name}" could not be retrieved]`;
    }
    return {
      name,
      contentType: att.contentType || 'application/octet-stream',
      size: body.length,
      content: body.toString('base64'),
    };
  } catch {
    // Timeouts, network failures, aborts — routine.
    return `[file "${name}" could not be retrieved]`;
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolvedInbound {
  files: ChannelAttachment[];
  notes: string[];
}

/** Resolve an event's attachments: inline pass through, remote fetch
 *  under the def's recipe. Stops at maxFiles; no media recipe → noted. */
export async function resolveInboundAttachments(
  incoming: InboundAttachment[],
  media: ChannelDef['media'],
  caps?: { maxFileBytes?: number; maxFiles?: number },
  opts?: { timeoutMs?: number },
): Promise<ResolvedInbound> {
  const maxBytes = caps?.maxFileBytes ?? DEFAULT_ATTACHMENT_CAPS.maxFileBytes;
  const maxFiles = caps?.maxFiles ?? DEFAULT_ATTACHMENT_CAPS.maxFiles;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const files: ChannelAttachment[] = [];
  const notes: string[] = [];
  for (const att of incoming) {
    if (!isRemoteAttachment(att)) {
      files.push(att);
      continue;
    }
    const name = sanitizeAttachmentName(att.name);
    if (files.length >= maxFiles) {
      notes.push(`[file "${name}" was not kept — this message already carries ${maxFiles} files, the limit]`);
      continue;
    }
    if (!media) {
      notes.push(`[file "${name}" could not be retrieved]`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const out = await fetchOne(att, media, maxBytes, timeoutMs);
    if (typeof out === 'string') notes.push(out);
    else files.push(out);
  }
  return { files, notes };
}
