import path from 'path';
import fs from 'fs';
import { assert } from 'chai';
import { loadPiAi, shimLoad } from '../server/providers/loader';
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

describe('pi-ai loader shim fallback', () => {
  it('shimLoad resolves pi-ai through the createRequire shim, exposing a usable Type', async function () {
    this.timeout(20000);
    const piai: any = await shimLoad('@earendil-works/pi-ai');
    const schema = piai.Type.Object({ x: piai.Type.String() });
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['x']);
  });

  it('writes the shim file to disk under .agent-loader in the node_modules base', async function () {
    this.timeout(20000);
    await shimLoad('@earendil-works/pi-ai');
    let dir = process.cwd();
    let shimPath: string | null = null;
    for (let i = 0; i < 8; i += 1) {
      for (const c of ['node_modules', path.join('npm', 'node_modules')]) {
        const candidate = path.join(dir, c, '.agent-loader', 'loader.mjs');
        if (fs.existsSync(candidate)) {
          shimPath = candidate;
          break;
        }
      }
      if (shimPath) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    assert.isNotNull(shimPath, 'expected loader.mjs to exist under a .agent-loader directory');
  });

  it('rejects for a package that does not exist', async function () {
    this.timeout(20000);
    let threw = false;
    try {
      await shimLoad('@nonexistent-scope/definitely-not-real');
    } catch {
      threw = true;
    }
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
