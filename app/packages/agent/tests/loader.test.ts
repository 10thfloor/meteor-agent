import { assert } from 'chai';
import { loadPiAi } from '../server/providers/loader';
import { mockProvider } from '../server/providers/mock';
import type { ProviderChunk } from '../server/providers/types';

describe('pi-ai loader', () => {
  it('loads the pi-ai namespace despite the typebox exports map', async function () {
    this.timeout(20000);
    const piai: any = await loadPiAi();
    assert.isDefined(piai);
    assert.isAbove(Object.keys(piai).length, 10);
  });

  it('exposes a usable TypeBox Type through pi-ai', async function () {
    this.timeout(20000);
    const piai: any = await loadPiAi();
    const schema = piai.Type.Object({ orderId: piai.Type.String() });
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['orderId']);
  });

  it('caches the namespace across calls', async function () {
    this.timeout(20000);
    const a = await loadPiAi();
    const b = await loadPiAi();
    assert.strictEqual(a, b);
  });
});

describe('pi-ai loader v2 (no node_modules writes)', () => {
  it('resolves the pi-ai entry to an absolute file path', async function () {
    this.timeout(20000);
    const { resolvePiAiEntry } = await import('../server/providers/loader');
    const entry = resolvePiAiEntry();
    assert.isTrue(entry.startsWith('/'), `expected absolute path, got ${entry}`);
    assert.include(entry, '@earendil-works');
  });

  it('shimLoad imports a resolved file URL and yields a usable namespace', async function () {
    this.timeout(20000);
    const { resolvePiAiEntry, shimLoad } = await import('../server/providers/loader');
    const { pathToFileURL } = await import('url');
    const ns: any = await shimLoad(pathToFileURL(resolvePiAiEntry()).href);
    const schema = ns.Type.Object({ x: ns.Type.String() });
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['x']);
  });

  it('never writes inside node_modules', async function () {
    this.timeout(20000);
    const fs = await import('fs');
    const path = await import('path');
    const { loadPiAi, resolvePiAiEntry, shimLoad } = await import('../server/providers/loader');
    const { pathToFileURL } = await import('url');
    // Exercise every load path, then assert the M1 shim dir does not exist.
    await loadPiAi();
    await shimLoad(pathToFileURL(resolvePiAiEntry()).href);
    // Both layouts the loader itself searches (CANDIDATE_DIRS): dev puts app
    // npm deps in `node_modules`, a production `meteor build` puts them in
    // `npm/node_modules`. Checking only the dev one would let the M1 bug —
    // writing a shim package INTO node_modules, fatal on a read-only container
    // filesystem — come back unnoticed in the layout that actually ships.
    const candidates = ['node_modules', path.join('npm', 'node_modules')];
    let dir = process.cwd();
    for (let i = 0; i < 8; i += 1) {
      for (const c of candidates) {
        const candidate = path.join(dir, c, '.agent-loader');
        assert.isFalse(fs.existsSync(candidate), `stale shim dir at ${candidate}`);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  });

  it('rejects on an unresolvable entry', async function () {
    this.timeout(20000);
    const { shimLoad } = await import('../server/providers/loader');
    let threw = false;
    try { await shimLoad('file:///nonexistent/definitely-not-real.mjs'); }
    catch { threw = true; }
    assert.isTrue(threw);
  });
});

describe('mockProvider', () => {
  it('streams text one chunk at a time then a done chunk', async () => {
    const p = mockProvider(() => ({ text: 'hi' }));
    const chunks: ProviderChunk[] = [];
    for await (const c of p.stream({ model: 'm', system: '', messages: [], tools: [] })) {
      chunks.push(c);
    }
    assert.deepEqual(chunks.map((c) => c.kind), ['text', 'text', 'done']);
    assert.equal(
      chunks.filter((c) => c.kind === 'text').map((c: any) => c.chunk).join(''),
      'hi',
    );
  });

  it('passes tool calls through the done chunk', async () => {
    const p = mockProvider(() => ({ toolCalls: [{ id: 't1', name: 'lookup', args: { q: 1 } }] }));
    const out: ProviderChunk[] = [];
    for await (const c of p.stream({ model: 'm', system: '', messages: [], tools: [] })) out.push(c);
    const done: any = out[out.length - 1];
    assert.equal(done.toolCalls[0].name, 'lookup');
  });
});
