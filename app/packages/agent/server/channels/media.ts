import {
  isRemoteAttachment,
  type ChannelAttachment, type InboundAttachment, type RemoteAttachment,
} from '../../common/channel-contract';
import { DEFAULT_ATTACHMENT_CAPS, prettySize, sanitizeAttachmentName } from '../attachments';
import type { ChannelDef } from './registry';

/**
 * The remote-media fetcher (participants spec §6): resolve a lens's
 * `RemoteAttachment` references into the bytes admission stores — under the
 * channel def's own recipe, because this is an SSRF surface and is treated as
 * one:
 *
 *   - https only, and every fetched URL — the first, the indirect hop, every
 *     redirect target — must exact-match the channel-authored `media.hosts`
 *     allowlist. The webhook can make us fetch only from hosts the channel
 *     already trusts.
 *   - redirects are followed MANUALLY (at most 3), re-checked per hop, and
 *     auth headers are STRIPPED on a cross-host redirect (Twilio's 302 to its
 *     CDN is the canonical case). The INDIRECT hop is different on purpose:
 *     it is a credentialed, allowlisted provider API call (WhatsApp's
 *     lookaside URL rejects unauthenticated GETs), so it keeps its headers —
 *     both targets are allowlisted, which is what makes the asymmetry safe.
 *   - the read is STREAMED and aborts past `maxFileBytes` — a lying
 *     `declaredSize` costs the provider the file, not us the memory — under a
 *     per-fetch timeout.
 *   - a failure is a NOTE, never a throw: expired WhatsApp URLs (~5 minutes)
 *     and deleted Slack files are routine, and a throw past the admission
 *     claim would release it and 500 into the provider's retry storm. The
 *     message still delivers; the note names the FILE, never the URL or the
 *     headers.
 */

/** Hop ceilings: redirects per fetch, and one indirect hop by contract. */
const MAX_REDIRECTS = 3;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

let mediaFetch: typeof fetch = globalThis.fetch;

/** TEST SEAM, the `_setBackoff` shape: the fetcher's I/O, injectable so the
 *  whole resolution path runs network-free. Pass null to restore. */
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

/** One GET with manual redirects, host re-checks, cross-host auth stripping,
 *  a byte ceiling on the streamed read, and a shared timeout. Returns the
 *  bytes or a refusal token the caller turns into a note. */
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
      // Cross-host redirect: the credential was for the host we asked, not
      // wherever it forwards us. Same-host keeps them (auth-gated hops).
      if (new URL(next).hostname !== new URL(url).hostname) sendHeaders = undefined;
      url = next;
      continue;
    }
    if (!res.ok) return 'failed';
    const reader = res.body?.getReader?.();
    if (!reader) {
      // A fetch impl without streaming (tests): fall back to arrayBuffer,
      // still bounded — the check just runs after the read.
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
      // The indirect hop: the first response is JSON the def's resolver turns
      // into the real target — fetched with the SAME headers (see the module
      // note for why this differs from redirects), re-checked against the
      // same allowlist inside boundedGet.
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
    // Timeouts, network failures, aborts — all the same routine fact.
    return `[file "${name}" could not be retrieved]`;
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolvedInbound {
  /** Inline files passed through plus remote files fetched — what admission
   *  stores, in the event's order. */
  files: ChannelAttachment[];
  /** One bracket line per file that could not be resolved — joined into the
   *  message text beside admission's own notes. */
  notes: string[];
}

/**
 * Resolve an event's attachments — inline ones pass through untouched; remote
 * ones fetch under the def's recipe. Fetching stops once `maxFiles` files are
 * in hand (admission would drop the rest anyway — no reason to download what
 * cannot be kept); the un-fetched remainder gets admission's own over-count
 * note phrasing, so the transcript reads one way however the file was lost.
 *
 * A channel whose lens emits remote attachments but whose def carries no
 * `media` recipe notes every file as unretrievable — a miswiring made visible
 * in the transcript rather than a silent drop.
 */
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
