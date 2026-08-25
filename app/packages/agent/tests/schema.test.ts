import { assert } from 'chai';
import { tool, methodTool, resolveTools, type ToolSpec } from '../server/tools';
import type { FromSchema } from '../common/schema';

// Most assertions here are compile-time: `@ts-expect-error` and `Exactly<>`
// fail the build if inference breaks. The mocha cases check run-time identity
// and erasure. The backwards-compat guarantee: an unwrapped tool still gets
// `args: unknown` / `run: (args: any, …)` and compiles unchanged.

// Compile-time equality. Two-sided so `any` can't slip through.
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<T extends true>(_ok?: T): void { /* compile-time only */ }

/* ── test schema ───────────────────────────────────────────────────────── */
const ARGS = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    count: { type: 'integer' },
    flag: { type: 'boolean' },
    nullable: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['ready', 'stretch', 'gap'] },
    note: { type: 'string' },
  },
  required: ['id', 'count', 'nullable', 'verdict'],
  additionalProperties: false,
} as const;

type Args = FromSchema<typeof ARGS>;

/* ── compile-time assertions ───────────────────────────────────────────── */
assertType<Exactly<Args['id'], string>>();
assertType<Exactly<Args['count'], number>>();
assertType<Exactly<Args['nullable'], string | null>>();
assertType<Exactly<Args['verdict'], 'ready' | 'stretch' | 'gap'>>();
// Not in `required`, so optional — and therefore possibly undefined.
assertType<Exactly<Args['note'], string | undefined>>();
assertType<Exactly<Args['tags'], string[] | undefined>>();
assertType<Exactly<Args['flag'], boolean | undefined>>();

/* ── unrecognised schemas widen to `unknown` / `never` ─────────────────── */
assertType<Exactly<FromSchema<{ type: 'not-a-json-schema-type' }>, never>>();
assertType<Exactly<FromSchema<unknown>, unknown>>();

describe('typed tool arguments', () => {
  it('infers every argument from the schema, inside run', async () => {
    let seen: unknown = null;

    const t = tool({
      name: 'typed',
      description: 'x',
      args: ARGS,
      run: async (args, ctx) => {
        // Each annotation is an assertion: a wrong inference fails the build.
        const id: string = args.id;
        const count: number = args.count;
        const nullable: string | null = args.nullable;
        const verdict: 'ready' | 'stretch' | 'gap' = args.verdict;
        const note: string | undefined = args.note;
        const tags: string[] | undefined = args.tags;
        const userId: string | null = ctx.userId;
        const sessionId: string = ctx.sessionId;

        // @ts-expect-error `id` is a string, not a number
        const wrongType: number = args.id;
        // @ts-expect-error there is no such property in the schema
        args.notDeclared;
        // @ts-expect-error `note` is optional, so it may be undefined
        const notOptional: string = args.note;
        // @ts-expect-error 'nope' is not one of the enum members
        const wrongMember: 'ready' | 'stretch' | 'gap' = 'nope';

        seen = { id, count, nullable, verdict, note, tags, userId, sessionId, wrongType, notOptional, wrongMember };
        return seen;
      },
      describe: async (args) => `describe sees ${args.id}`,
    });

    // The helper returns the spec unchanged.
    assert.equal(t.name, 'typed');
    assert.equal(t.args, ARGS);
    const out = await (t.run as any)(
      { id: 'a', count: 1, nullable: null, verdict: 'ready' },
      { userId: 'u', sessionId: 's' },
    );
    assert.equal((out as any).id, 'a');
    assert.isNull((out as any).nullable);
  });

  it('is erased at the boundary, so a typed tool sits in a plain ToolSpec[]', () => {
    // `tool()` returns the erased `InlineTool` type, so it drops into any
    // `ToolSpec[]`. If this stops compiling, the erasure broke.
    const typed = tool({
      name: 'a', description: 'x',
      args: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } as const,
      run: async (args) => args.q,
    });
    const adopted = methodTool({
      method: 'some.method', description: 'x',
      args: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } as const,
      run: undefined as never,
    } as any);

    const specs: ToolSpec[] = [typed, adopted, 'a.plain.method'];
    assert.lengthOf(specs, 3);

    const resolved = resolveTools([typed]);
    assert.equal(resolved[0].name, 'a');
    assert.equal(resolved[0].kind, 'inline');
    assert.equal(resolved[0].gate, 'auto');
  });

  it('leaves an unwrapped spec exactly as it was — args unknown, run any', async () => {
    // An unwrapped tool — `args: unknown`, `run: (args: any)` — must keep
    // compiling with no helper.
    const legacy: ToolSpec = {
      name: 'legacy',
      description: 'x',
      args: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      run: async (args) => args.slug,      // `any` — unchecked, exactly as before
    };
    const resolved = resolveTools([legacy]);
    assert.equal(resolved[0].name, 'legacy');
    assert.equal(await resolved[0].run!({ slug: 'x' }, { userId: null, sessionId: 's' }), 'x');
  });
});
