import { assert } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Random } from 'meteor/random';
import { destroyMongoStorage, loadChord, loadPiDurable, openMongoStorage } from 'meteor/10thfloor:durable';
import { loadPackage } from '../server/loader';

// What a commit costs on each backend, measured under the real harness: one
// streamed answer, then one tool turn. This is where the table in the README
// comes from. It asserts nothing about speed, so it is skipped unless asked:
//
//   DURABLE_BENCH=1 MOCHA_GREP='commit costs' TEST_CLIENT=0 meteor test-packages --once \
//     --port 3200 --driver-package meteortesting:mocha ./packages/durable

const PI_AI = '@earendil-works/pi-ai';
const enabled = process.env.DURABLE_BENCH === '1';

type Sample = { kind: string; ms: number };

/** Forward everything to `storage`, timing each commit and naming it by what it writes. */
function timed(storage: any, samples: Sample[]): any {
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property !== 'commit') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (writes: { type: string }[], commitContext: unknown) => {
        const types = new Set(writes.map((write) => write.type));
        const kind = types.size === 1 && types.has('document.change')
          ? 'streaming delta'
          : types.has('entry') ? 'entry' : 'other';
        const started = performance.now();
        try {
          return await target.commit(writes, commitContext);
        } finally {
          samples.push({ kind, ms: performance.now() - started });
        }
      };
    },
  });
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

(enabled ? describe : describe.skip)('MongoStorage commit costs (DURABLE_BENCH=1)', function () {
  this.timeout(300_000);

  it('measures a streamed answer and a tool turn on memory, SQLite and Mongo', async function () {
    const durable = await loadPiDurable() as any;
    const sqlite = await loadPiDurable('storage/sqlite/node') as any;
    const context = (await loadChord('context') as any).BACKGROUND_CONTEXT;
    const Type = (await loadPackage(PI_AI) as any).Type;
    const createModels = (await loadPackage(PI_AI, 'models') as any).createModels;
    const faux = await loadPackage(PI_AI, 'providers/faux') as any;

    const run = async (name: string, storage: any) => {
      const samples: Sample[] = [];
      // About 150 tokens a second: a fast model. The harness commits the partial answer at most every 100 ms.
      const provider = faux.fauxProvider({ tokensPerSecond: 150 });
      const models = createModels();
      models.setProvider(provider.provider);
      provider.setResponses([
        faux.fauxAssistantMessage(Array.from({ length: 220 }, (_, index) => `word${index}`).join(' ')),
        faux.fauxAssistantMessage([faux.fauxToolCall('lookup', { q: 'x' })], { stopReason: 'toolUse' }),
        faux.fauxAssistantMessage('Done.'),
      ]);
      const registry = durable.createRegistry();
      registry.install(durable.defineExtension({
        name: 'bench',
        tools: [durable.defineTool({
          name: 'lookup',
          description: 'Look something up',
          parameters: Type.Object({ q: Type.String() }),
          execute: async () => ({ content: [{ type: 'text', text: 'found' }] }),
        })],
      }));
      const harness = await durable.Harness.open(timed(storage, samples), { models, registry }, context);
      const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });

      const streamStart = performance.now();
      await (await root.submit({ type: 'input', content: 'Write an essay.' }, context)).wait(context);
      const streamMs = performance.now() - streamStart;
      const streamCommits = samples.length;
      const turnStart = performance.now();
      await (await root.submit({ type: 'input', content: 'Look it up.' }, context)).wait(context);
      const turnMs = performance.now() - turnStart;
      await harness.close(context);

      const line = (kind: string) => {
        const values = samples.filter((sample) => sample.kind === kind).map((sample) => sample.ms);
        return `n=${values.length} p50=${percentile(values, 50).toFixed(1)}ms p95=${percentile(values, 95).toFixed(1)}ms`;
      };
      console.log([
        `[10thfloor:durable] ${name}`,
        `  streamed answer: ${streamMs.toFixed(0)} ms wall, ${streamCommits} commits`,
        `  tool turn:       ${turnMs.toFixed(0)} ms wall, ${samples.length - streamCommits} commits`,
        `  streaming delta commits: ${line('streaming delta')}`,
        `  commits with an entry:   ${line('entry')}`,
        `  other commits:           ${line('other')}`,
      ].join('\n'));
      assert.isAbove(samples.length, 20);
    };

    await run('memory', new durable.MemoryStorage());

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-bench-'));
    try {
      await run('sqlite (node:sqlite, local file)', await sqlite.openNodeSqliteStorage(path.join(directory, 'bench.sqlite')));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    const key = `bench-${Random.id()}`;
    try {
      // Once without measuring, so index creation is not counted.
      await (await openMongoStorage(`${key}-warm`) as any).close(context);
      await run('mongo, w:1', await openMongoStorage(`${key}-w1`, { writeConcern: { w: 1 } }));
      await run('mongo, w:majority (default)', await openMongoStorage(key));
    } finally {
      for (const suffix of ['', '-w1', '-warm']) await destroyMongoStorage(`${key}${suffix}`);
    }
  });
});
