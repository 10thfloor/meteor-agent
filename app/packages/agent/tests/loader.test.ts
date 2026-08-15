import { assert } from 'chai';
import { loadPiAi } from '../server/providers/loader';
import { mockProvider } from '../server/providers/mock';
import type { ProviderChunk } from '../server/providers/types';

describe('pi-ai loader', () => {
  it('loads the pi-ai namespace despite the typebox exports map', async function () {
    this.timeout(20000);
    const piai: any = await loadPiAi();
    assert.isObject(piai);
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
