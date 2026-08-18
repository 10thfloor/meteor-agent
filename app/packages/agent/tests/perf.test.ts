import { assert } from 'chai';
import type { Provider } from '../server/providers/types';

/**
 * M5 Task 4 — the perf debt.
 *
 * Two of these tests exist to PRODUCE A NUMBER as much as to assert: the
 * compiled-validation speedup and the tool_args delta pressure are both
 * recorded in `.superpowers/sdd/task-4-report.md`, and both are measured here
 * rather than in a benchmark suite so they stay honest when the code moves.
 * The assertions are deliberately loose (an order of magnitude, not a
 * threshold) — a CI box under load must not fail a correctness suite because
 * a JIT was slow to warm.
 */

const RICH = {
  type: 'object',
  properties: {
    op: { enum: ['add', 'sub', 'mul'] },
    n: { type: 'integer', minimum: 0, maximum: 100 },
    tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 8 },
    nested: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-z]+$' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  required: ['op', 'n'],
  additionalProperties: false,
};

const GOOD = { op: 'add', n: 5, tags: ['x', 'y'], nested: { id: 'abc' } };

describe('compiled-schema validation', () => {
  it('compiles a schema ONCE and reuses it for every later call', async function () {
    this.timeout(30000);
    const { validateToolArgs, _isSchemaCompiled } = await import('../server/tools');

    // A FRESH object per test: the cache is keyed on schema identity, so a
    // shared literal would make this assertion depend on test order.
    const schema = JSON.parse(JSON.stringify(RICH));
    assert.isFalse(_isSchemaCompiled(schema), 'nothing is compiled before the first call');

    assert.isTrue((await validateToolArgs(schema, GOOD)).ok);
    assert.isTrue(_isSchemaCompiled(schema), 'the first call must compile it');

    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.isTrue((await validateToolArgs(schema, GOOD)).ok);
    }
    assert.isTrue(_isSchemaCompiled(schema), 'and it must still be the same compiled checker');
  });

  it('enforces the same constraints compiled as interpreted, and names the same field',
    async function () {
      this.timeout(30000);
      const { validateToolArgs, setTypeboxCompileLoader } = await import('../server/tools');

      const cases: Array<[any, string]> = [
        [{ op: 'nope', n: 5 }, 'op'],
        [{ op: 'add', n: 999 }, 'n'],
        [{ n: 5 }, 'op'],
        [{ op: 'add', n: 5, sneak: 1 }, 'sneak'],
        [{ op: 'add', n: 5, nested: { id: 'ABC' } }, 'nested.id'],
        [{ op: 'add', n: 5, tags: [''] }, 'tags[0]'],
      ];

      // Rung 2: compiled.
      const compiled: Array<string | true> = [];
      for (const [args] of cases) {
        // eslint-disable-next-line no-await-in-loop
        const v = await validateToolArgs(JSON.parse(JSON.stringify(RICH)), args);
        compiled.push(v.ok ? true : v.reason);
      }

      // Rung 3: the interpreted checker, forced by removing the compile route.
      const restore = setTypeboxCompileLoader(null);
      const interpreted: Array<string | true> = [];
      try {
        for (const [args] of cases) {
          // eslint-disable-next-line no-await-in-loop
          const v = await validateToolArgs(JSON.parse(JSON.stringify(RICH)), args);
          interpreted.push(v.ok ? true : v.reason);
        }
      } finally { restore(); }

      cases.forEach(([, field], i) => {
        assert.notStrictEqual(compiled[i], true, `compiled must reject case ${i}`);
        assert.notStrictEqual(interpreted[i], true, `interpreted must reject case ${i}`);
        assert.include(String(compiled[i]), field, `compiled reason must name ${field}`);
      });
      // The reason vocabulary is published (it reaches the model and the
      // transcript), so the two rungs may not word it differently.
      assert.deepEqual(compiled, interpreted, 'the two rungs must agree, verbatim');
    });

  it('degrades to the interpreted checker when typebox/compile cannot load', async function () {
    this.timeout(30000);
    const { validateToolArgs, setTypeboxCompileLoader } = await import('../server/tools');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };

    const restore = setTypeboxCompileLoader(async () => { throw new Error('forced outage'); });
    try {
      // Rung 3 still enforces EVERYTHING rung 2 did — this degrade costs speed
      // only, unlike the drop to the structural checker.
      assert.isTrue((await validateToolArgs(RICH, GOOD)).ok);
      const bad = await validateToolArgs(RICH, { op: 'nope', n: 5 });
      assert.isFalse(bad.ok, 'the interpreted checker still enforces enum');

      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await validateToolArgs(RICH, GOOD);
      }
      const mine = warnings.filter((w) => w.includes('typebox/compile'));
      assert.lengthOf(mine, 1, 'one warning per outage, not one per tool call');
    } finally {
      restore();
      console.warn = originalWarn;
    }
  });

  it('falls back for ONE schema the compiler chokes on, not for the process',
    async function () {
      this.timeout(30000);
      const { validateToolArgs, setTypeboxCompileLoader, _isSchemaCompiled } =
        await import('../server/tools');
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };

      const poison = { type: 'object', properties: { p: { type: 'string' } }, poison: true };
      const healthy = JSON.parse(JSON.stringify(RICH));
      // Through the loader seam, never a bare specifier: Meteor's resolver
      // cannot follow typebox's exports map, which is the entire reason
      // `loadTypebox` exists.
      const { loadTypebox } = await import('../server/providers/loader');
      const real: any = await loadTypebox('compile');

      // A compiler that throws for exactly one schema. Everything else routes
      // to the real one, so "the rest of the process keeps its compiled
      // checkers" is an assertion and not an assumption.
      const restore = setTypeboxCompileLoader(async () => ({
        Compile: (schema: any) => {
          if (schema?.poison) throw new Error('cannot compile this one');
          return real.Compile(schema);
        },
      }));
      try {
        // The poisoned schema still VALIDATES — through Value.Check.
        assert.isTrue((await validateToolArgs(poison, { p: 'ok' })).ok);
        assert.isFalse((await validateToolArgs(poison, { p: 4 })).ok);
        assert.isFalse(_isSchemaCompiled(poison), 'it must be negative-cached, not compiled');

        assert.isTrue((await validateToolArgs(healthy, GOOD)).ok);
        assert.isTrue(_isSchemaCompiled(healthy), 'a neighbouring schema still compiles');

        // Negative-cached: the throw costs one attempt, not one per call.
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await validateToolArgs(poison, { p: 'ok' });
        }
        assert.lengthOf(
          warnings.filter((w) => w.includes('could not be compiled')), 1,
          'one warning for the schema, not one per call',
        );
      } finally {
        restore();
        console.warn = originalWarn;
      }
    });

  it('MEASURES: the compiled checker beats the interpreted one on repeat calls',
    async function () {
      this.timeout(60000);
      const { validateToolArgs, setTypeboxCompileLoader } = await import('../server/tools');
      const N = 2000;

      const time = async (): Promise<number> => {
        const schema = JSON.parse(JSON.stringify(RICH));
        await validateToolArgs(schema, GOOD);          // warm / compile
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < N; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await validateToolArgs(schema, GOOD);
        }
        return Number(process.hrtime.bigint() - t0) / 1e6;
      };

      const compiledMs = await time();
      const restore = setTypeboxCompileLoader(null);
      let interpretedMs: number;
      try { interpretedMs = await time(); } finally { restore(); }

      // eslint-disable-next-line no-console
      console.log(
        `[perf] validateToolArgs x${N}: compiled ${compiledMs.toFixed(1)}ms, `
        + `interpreted ${interpretedMs.toFixed(1)}ms `
        + `(${(interpretedMs / compiledMs).toFixed(1)}x)`,
      );
      // Loose on purpose: the probe measured 34x on the raw checkers, but this
      // path pays for a promise and a WeakMap lookup per call too. Anything at
      // or above parity proves the cache is not a pessimization; the report
      // carries the real number.
      assert.isAbove(
        interpretedMs, compiledMs,
        'compiling must not make repeat validation slower',
      );
    });
});

describe('tool_args delta pressure', () => {
  const SESSION = 's-toolargs-pressure';

  const seed = async (sessionId: string) => {
    const { AgentSessions, AgentMessages, AgentDeltas } =
      await import('../common/collections');
    await AgentSessions.removeAsync({ _id: sessionId } as any);
    await AgentMessages.removeAsync({ sessionId } as any);
    await AgentDeltas.removeAsync({ sessionId } as any);
    await AgentSessions.insertAsync({
      _id: sessionId, agent: 'perf', userId: 'u1', phase: 'idle', model: 'mock',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await AgentMessages.insertAsync({
      _id: `${sessionId}-u`, sessionId, seq: 0, role: 'user',
      content: 'go', createdAt: new Date(),
    } as any);
  };

  /** Four parallel calls, ~20 KB of arguments each, streamed in 200-byte
   *  fragments the way a real provider emits them. */
  const fourFatCalls = (): Array<{ kind: 'tool_args'; chunk: string; contentIndex: number }> => {
    const out: Array<{ kind: 'tool_args'; chunk: string; contentIndex: number }> = [];
    const body = 'x'.repeat(200);
    for (let f = 0; f < 100; f += 1) {
      for (let i = 0; i < 4; i += 1) out.push({ kind: 'tool_args', chunk: body, contentIndex: i });
    }
    return out;
  };

  it('MEASURES: what four parallel 20KB argument streams cost the delta collection',
    async function () {
      this.timeout(60000);
      const { AgentDeltas } = await import('../common/collections');
      const { runTurn } = await import('../server/loop');
      await seed(SESSION);

      let captured: any[] = [];
      const fat: Provider = {
        async *stream() {
          for (const c of fourFatCalls()) yield c as any;
          // Same capturing idiom the loop tests use: deltas are deleted at
          // commit, so snapshot after the flush interval and before 'done'.
          await new Promise((r) => { setTimeout(r, 300); });
          captured = await AgentDeltas.find({ sessionId: SESSION }).fetchAsync();
          yield { kind: 'done', usage: { input: 1, output: 1 } };
        },
      };
      await runTurn(SESSION, {
        model: 'mock', system: 'x', tools: [], provider: fat,
        // Infinity: this test measures the UNCLAMPED cost. The clamp is the
        // next test.
        maxToolArgBytes: Infinity,
      });

      const bytes = captured.reduce(
        (n, d) => n + Buffer.byteLength(String(d.chunk), 'utf8'), 0,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[perf] 4 parallel calls x ~20KB args: ${captured.length} delta docs, `
        + `${bytes} bytes of chunk payload`,
      );

      // THE FINDING, and the reason the clamp exists.
      //
      // Coalescing is what keeps a long TEXT response O(chunk): consecutive
      // same-kind chunks merge into one run, one document. Parallel tool calls
      // get none of it. The coalescing key includes `contentIndex` — it has to,
      // or one call's JSON would be concatenated into another's and the
      // boundary lost forever — and a provider streaming four calls at once
      // emits them INTERLEAVED, so no two consecutive fragments ever share an
      // index. Every fragment becomes its own document: 400 in, 400 out.
      //
      // So `tool_args` is the one delta kind whose document count scales with
      // the provider's fragment size rather than with the response, against a
      // capped collection every session on the deployment shares.
      assert.equal(captured.length, 400, 'interleaved parallel args do not coalesce');
      assert.deepEqual(
        [...new Set(captured.map((d) => d.contentIndex))].sort(), [0, 1, 2, 3],
        'four parallel calls stay four attributed streams',
      );
      assert.equal(bytes, 80_000);
      await AgentDeltas.removeAsync({ sessionId: SESSION } as any);
    });

  it('clamps tool_args past maxToolArgBytes and leaves text and thinking alone',
    async function () {
      this.timeout(30000);
      const { DeltaWriter } = await import('../server/loop');
      const { AgentDeltas } = await import('../common/collections');
      const sessionId = 's-toolargs-clamp';
      await AgentDeltas.removeAsync({ sessionId } as any);

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };

      try {
        // 5 KiB ceiling, 1 KiB chunks on four indexes.
        const writer = new DeltaWriter(sessionId, 'm-clamp', 0, 10_000, 5 * 1024);
        const kb = 'y'.repeat(1024);
        for (let f = 0; f < 10; f += 1) {
          for (let i = 0; i < 4; i += 1) writer.push('tool_args', kb, i);
        }
        writer.push('text', 'the answer survives');
        writer.push('thinking', 'so does this');
        await writer.stop();

        const docs = (await AgentDeltas.find({ sessionId } as any).fetchAsync())
          .sort((a, b) => a.seq - b.seq) as any[];
        const args = docs.filter((d) => d.kind === 'tool_args');
        const argBytes = args.reduce((n, d) => n + Buffer.byteLength(d.chunk, 'utf8'), 0);

        // The chunk that CROSSES the ceiling is written whole, so the total
        // lands within one chunk of the limit — and nowhere near the 40 KiB
        // that would have been written unclamped.
        assert.isAtLeast(argBytes, 5 * 1024);
        assert.isBelow(argBytes, 7 * 1024, 'the clamp must stop the stream, not merely slow it');

        assert.deepEqual(
          docs.filter((d) => d.kind !== 'tool_args').map((d) => [d.kind, d.chunk]),
          [['text', 'the answer survives'], ['thinking', 'so does this']],
          'text and thinking are never clamped',
        );
        // mergeView's backward walk stops the instant seq fails to decrement by
        // exactly 1, so a dropped chunk must not open a gap.
        assert.deepEqual(docs.map((d) => d.seq), docs.map((_, i) => i));

        assert.lengthOf(
          warnings.filter((w) => w.includes('maxToolArgBytes')), 1,
          'one warning per turn, not one per dropped chunk',
        );
      } finally {
        console.warn = originalWarn;
        await AgentDeltas.removeAsync({ sessionId } as any);
      }
    });

  it('does not clamp by default at the sizes a real turn produces', async function () {
    this.timeout(30000);
    const { DeltaWriter, DEFAULT_MAX_TOOL_ARG_BYTES } = await import('../server/loop');
    const { AgentDeltas } = await import('../common/collections');
    const sessionId = 's-toolargs-default';
    await AgentDeltas.removeAsync({ sessionId } as any);

    assert.equal(DEFAULT_MAX_TOOL_ARG_BYTES, 256 * 1024);
    const writer = new DeltaWriter(sessionId, 'm-default', 0, 10_000, DEFAULT_MAX_TOOL_ARG_BYTES);
    for (const c of fourFatCalls()) writer.push('tool_args', c.chunk, c.contentIndex);
    await writer.stop();

    const docs = await AgentDeltas.find({ sessionId } as any).fetchAsync();
    const bytes = docs.reduce((n, d: any) => n + Buffer.byteLength(d.chunk, 'utf8'), 0);
    // The measured turn — 400 documents, 80 KB — passes the 256 KiB default
    // untouched. The clamp is for the pathological case, not for a busy one.
    assert.equal(docs.length, 400);
    assert.equal(bytes, 80_000, 'the measured turn must pass the default ceiling untouched');
    await AgentDeltas.removeAsync({ sessionId } as any);
  });
});

describe('startup indexes', () => {
  it('creates the sweep and transcript indexes, idempotently', async function () {
    this.timeout(30000);
    const { ensureIndexes } = await import('../server/indexes');
    const { AgentMessages, AgentSessions } = await import('../common/collections');

    await ensureIndexes();
    await ensureIndexes();   // must not throw on a second boot

    const keysOf = async (coll: any): Promise<string[]> => {
      const list = await coll.rawCollection().listIndexes().toArray();
      return list.map((i: any) => JSON.stringify(i.key));
    };

    const messages = await keysOf(AgentMessages);
    assert.include(messages, JSON.stringify({ sessionId: 1, seq: 1 }));

    const sessions = await keysOf(AgentSessions);
    assert.include(sessions, JSON.stringify({ 'parent.sessionId': 1, createdAt: 1 }));
    assert.include(sessions, JSON.stringify({ phase: 1, 'lease.until': 1 }));
  });

  it('warns instead of throwing when the Mongo user may not create indexes',
    async function () {
      this.timeout(30000);
      const { ensureIndexes } = await import('../server/indexes');
      const { AgentMessages } = await import('../common/collections');

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
      const original = (AgentMessages as any).createIndexAsync;
      (AgentMessages as any).createIndexAsync = async () => {
        // What Atlas returns for a user without the createIndex action.
        throw Object.assign(new Error('not authorized on agent to execute command'), {
          code: 13,
        });
      };
      try {
        // The whole point: a package that cannot index must still boot.
        await ensureIndexes();
        assert.isAbove(
          warnings.filter((w) => w.includes('agent_messages')).length, 0,
          'the failure must be visible in the log',
        );
      } finally {
        (AgentMessages as any).createIndexAsync = original;
        console.warn = originalWarn;
      }
    });
});
