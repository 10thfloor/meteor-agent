import { assert } from 'chai';
import type { RemoteAttachment } from '../common/channel-contract';

/**
 * The remote-media fetcher (participants spec §6): the SSRF gates — host
 * allowlist on every hop, https only, cross-host auth stripping, the size
 * abort — and the note-not-throw discipline. All network-free through the
 * `_setMediaFetch` seam.
 */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** A scripted fetch: URL → response recipe. Records every call it serves. */
function scriptedFetch(routes: Record<string, {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  json?: unknown;
}>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: any, init: any) => {
    const url = String(input);
    const sent: Record<string, string> = { ...(init?.headers ?? {}) };
    calls.push({ url, headers: sent });
    const route = routes[url];
    if (!route) return { ok: false, status: 404, headers: new Map(), body: undefined } as any;
    const status = route.status ?? 200;
    const payload = route.json !== undefined
      ? Buffer.from(JSON.stringify(route.json), 'utf8')
      : Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body ?? '', 'utf8');
    const headerMap = new Map(Object.entries(route.headers ?? {}));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headerMap.get(k.toLowerCase()) ?? null },
      // No streaming body — the fetcher falls back to arrayBuffer, still
      // bounded (checked after the read).
      arrayBuffer: async () => payload.buffer.slice(
        payload.byteOffset, payload.byteOffset + payload.byteLength,
      ),
    } as any;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const remote = (over: Partial<RemoteAttachment> = {}): RemoteAttachment => ({
  name: 'file.bin', contentType: 'application/octet-stream',
  url: 'https://media.trusted.test/f1', ...over,
});

describe('remote media fetcher', () => {
  it('passes inline files through and fetches remote ones under the allowlist', async () => {
    const { resolveInboundAttachments, _setMediaFetch } = await import('../server/channels/media');
    const { impl } = scriptedFetch({
      'https://media.trusted.test/f1': { body: 'the bytes' },
    });
    const restore = _setMediaFetch(impl);
    try {
      const out = await resolveInboundAttachments(
        [
          { name: 'inline.txt', contentType: 'text/plain', size: 2, content: b64('hi') },
          remote({ name: 'fetched.bin' }),
        ],
        { hosts: ['media.trusted.test'] },
      );
      assert.lengthOf(out.notes, 0);
      assert.deepEqual(out.files.map((f) => [f.name, Buffer.from(f.content, 'base64').toString()]), [
        ['inline.txt', 'hi'],
        ['fetched.bin', 'the bytes'],
      ]);
      assert.equal(out.files[1].size, 9, 'size is the FETCHED byte count, never the claim');
    } finally {
      restore();
    }
  });

  it('refuses hosts off the allowlist and plain http — with a note naming the file, never the URL', async () => {
    const { resolveInboundAttachments, _setMediaFetch } = await import('../server/channels/media');
    const { impl, calls } = scriptedFetch({});
    const restore = _setMediaFetch(impl);
    try {
      const out = await resolveInboundAttachments(
        [
          remote({ name: 'evil.bin', url: 'https://attacker.test/f' }),
          remote({ name: 'plain.bin', url: 'http://media.trusted.test/f' }),
          remote({ name: 'internal.bin', url: 'https://169.254.169.254/latest/meta-data' }),
        ],
        { hosts: ['media.trusted.test'] },
      );
      assert.lengthOf(out.files, 0);
      assert.lengthOf(out.notes, 3);
      assert.lengthOf(calls, 0, 'a refused host is never contacted at all');
      for (const note of out.notes) {
        assert.notInclude(note, 'http', 'notes name the FILE, never the URL');
        assert.include(note, 'trusted host');
      }
    } finally {
      restore();
    }
  });

  it('skips the fetch entirely when the declared size is over the cap, and aborts a lying stream', async () => {
    const { resolveInboundAttachments, _setMediaFetch } = await import('../server/channels/media');
    const big = Buffer.alloc(2048, 7);
    const { impl, calls } = scriptedFetch({
      'https://media.trusted.test/liar': { body: big },
    });
    const restore = _setMediaFetch(impl);
    try {
      const out = await resolveInboundAttachments(
        [
          remote({ name: 'honest-big.bin', declaredSize: 10_000_000 }),
          remote({ name: 'liar.bin', url: 'https://media.trusted.test/liar', declaredSize: 100 }),
        ],
        { hosts: ['media.trusted.test'] },
        { maxFileBytes: 1024, maxFiles: 5 },
      );
      assert.lengthOf(out.files, 0);
      assert.include(out.notes[0], 'honest-big.bin');
      assert.include(out.notes[0], 'not fetched', 'an honest oversize costs nothing');
      assert.include(out.notes[1], 'liar.bin');
      assert.lengthOf(calls, 1, 'only the liar was ever contacted');
    } finally {
      restore();
    }
  });

  it('re-checks redirects per hop and strips auth crossing hosts; the indirect hop keeps it', async () => {
    const { resolveInboundAttachments, _setMediaFetch } = await import('../server/channels/media');
    const { impl, calls } = scriptedFetch({
      // Twilio's shape: the API host 302s to the CDN.
      'https://api.trusted.test/media/1': {
        status: 302, headers: { location: 'https://cdn.trusted.test/blob/1' },
      },
      'https://cdn.trusted.test/blob/1': { body: 'cdn bytes' },
      // A redirect OFF the allowlist dies at the host check.
      'https://api.trusted.test/media/2': {
        status: 302, headers: { location: 'https://attacker.test/steal' },
      },
      // WhatsApp's shape: a credentialed lookup whose JSON names the target.
      'https://api.trusted.test/lookup/3': { json: { url: 'https://cdn.trusted.test/blob/3' } },
      'https://cdn.trusted.test/blob/3': { body: 'indirect bytes' },
    });
    const restore = _setMediaFetch(impl);
    try {
      const media = {
        hosts: ['api.trusted.test', 'cdn.trusted.test'],
        request: (att: RemoteAttachment) => ({
          url: att.url ?? '', headers: { authorization: 'Bearer secret' },
        }),
        resolveIndirect: (json: unknown) => (json as any)?.url ?? null,
      };
      const out = await resolveInboundAttachments(
        [
          remote({ name: 'redirected.bin', url: 'https://api.trusted.test/media/1' }),
          remote({ name: 'hijacked.bin', url: 'https://api.trusted.test/media/2' }),
          remote({ name: 'two-hop.bin', url: 'https://api.trusted.test/lookup/3', indirect: true }),
        ],
        media,
      );
      assert.deepEqual(out.files.map((f) => f.name), ['redirected.bin', 'two-hop.bin']);
      assert.include(out.notes[0], 'hijacked.bin');

      const byUrl = Object.fromEntries(calls.map((c) => [c.url, c.headers]));
      assert.equal(byUrl['https://api.trusted.test/media/1'].authorization, 'Bearer secret');
      assert.isUndefined(
        byUrl['https://cdn.trusted.test/blob/1'].authorization,
        'a CROSS-HOST redirect strips the credential — it was for the host we asked',
      );
      assert.isUndefined(byUrl['https://attacker.test/steal'], 'the off-list redirect was never followed');
      assert.equal(
        byUrl['https://cdn.trusted.test/blob/3'].authorization, 'Bearer secret',
        'the INDIRECT hop keeps its headers — a credentialed, allowlisted provider API call',
      );
    } finally {
      restore();
    }
  });

  it('a failed fetch, a missing recipe, and the count cap are notes — never throws', async () => {
    const { resolveInboundAttachments, _setMediaFetch } = await import('../server/channels/media');
    const { impl } = scriptedFetch({
      'https://media.trusted.test/ok': { body: 'x' },
      'https://media.trusted.test/gone': { status: 404 },
    });
    const restore = _setMediaFetch(impl);
    try {
      const gone = await resolveInboundAttachments(
        [remote({ name: 'expired.jpg', url: 'https://media.trusted.test/gone' })],
        { hosts: ['media.trusted.test'] },
      );
      assert.include(gone.notes[0], 'could not be retrieved');
      assert.notInclude(gone.notes[0], 'https://', 'never the URL');

      const noRecipe = await resolveInboundAttachments([remote()], undefined);
      assert.include(noRecipe.notes[0], 'could not be retrieved', 'a miswired channel drops visibly');

      const capped = await resolveInboundAttachments(
        [1, 2, 3].map((i) => remote({ name: `f${i}.bin`, url: 'https://media.trusted.test/ok' })),
        { hosts: ['media.trusted.test'] },
        { maxFiles: 2 },
      );
      assert.lengthOf(capped.files, 2);
      assert.include(capped.notes[0], 'f3.bin');
      assert.include(capped.notes[0], 'the limit', 'past the cap nothing is even downloaded');
    } finally {
      restore();
    }
  });
});
