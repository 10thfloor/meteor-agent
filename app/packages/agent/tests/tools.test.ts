import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';
import { Agent } from '../server/agent';
import type { AgentMessage } from '../common/types';
import type { ProviderMessage } from '../server/providers/types';

Meteor.methods({
  'test.usesUnblock'(this: any) {
    this.unblock();
    return `unblocked:${this.userId}`;
  },
  'test.echo'(this: any, args: { q: string }) {
    return `${args.q}:${this.userId}`;
  },
});

/** Amounts the co-registered tool body actually saw, in call order. */
const ran: number[] = [];

/** ONE definition, registered once at import time — every test below reaches
 *  it either as a DDP method or as an agent tool, which is the whole point. */
const coRegistered = Agent.method('test.coRegistered', {
  description: 'Refund an order',
  args: {
    type: 'object',
    properties: { amount: { type: 'number' }, order: { type: 'string' } },
    required: ['amount'],
  },
  run(this: any, args: { amount: number }) {
    ran.push(args.amount);
    return `refunded:${args.amount}:${this.userId}`;
  },
});

/** A session `runTurn` can start from, scoped to its own id so the suite's
 *  other files keep whatever they seeded. */
const seed = async (sessionId: string, text: string) => {
  const { AgentSessions, AgentMessages, AgentDeltas } = await import('../common/collections');
  await AgentSessions.removeAsync({ _id: sessionId } as any);
  await AgentMessages.removeAsync({ sessionId });
  await AgentDeltas.removeAsync({ sessionId });
  await AgentSessions.insertAsync({
    _id: sessionId, agent: 'tools-test', userId: 'u1', phase: 'idle', model: 'mock',
    nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  await AgentMessages.insertAsync({
    _id: `${sessionId}-u`, sessionId, seq: 0, role: 'user', content: text, createdAt: new Date(),
  } as any);
};

/** Runs one tool-calling turn and hands back every request the provider saw,
 *  so a test can assert on what the MODEL was shown next. */
const runWithTool = async (
  sessionId: string, tools: any[], call: { name: string; args: unknown },
) => {
  const { mockProvider } = await import('../server/providers/mock');
  const { runTurn } = await import('../server/loop');
  const requests: ProviderMessage[][] = [];
  const provider = mockProvider((req) => {
    requests.push(req.messages);
    return requests.length === 1
      ? { toolCalls: [{ id: 'c1', name: call.name, args: call.args }] }
      : { text: 'done' };
  });
  await seed(sessionId, 'refund please');
  await runTurn(sessionId, { model: 'mock', system: '', tools, provider });
  const { AgentMessages } = await import('../common/collections');
  const msgs = await AgentMessages.find(
    { sessionId }, { sort: { seq: 1 } },
  ).fetchAsync() as AgentMessage[];
  return { requests, msgs };
};

describe('tool dispatch', () => {
  it('propagates userId into an adopted method through callAsync', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools([
      { method: 'test.usesUnblock', description: 'x', args: { type: 'object', properties: {} } },
    ]);
    const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
    assert.isTrue(r.ok);
    assert.equal(r.value, 'unblocked:u1');
  });

  it('makes the ambient invocation a real MethodInvocation — a plain object is not sufficient for direct handler calls', async () => {
    const { withInvocation } = await import('../server/tools');

    // Part 1: the ambient invocation itself (not one Meteor derives via
    // callAsync) must be a genuine DDPCommon.MethodInvocation.
    await withInvocation('u9', async () => {
      const current = (DDP as any)._CurrentMethodInvocation.get();
      assert.instanceOf(current, (DDPCommon as any).MethodInvocation);
      // `assert.instanceOf` narrows `current` to `unknown` (its second arg is
      // `any`), so read through an explicitly-`any` alias afterwards.
      const inv: any = current;
      assert.equal(typeof inv.unblock, 'function');
      assert.equal(typeof inv.setUserId, 'function');
      assert.equal(inv.userId, 'u9');
    });

    // Part 2: prove the failure mode this guards against is real. Reach a
    // method handler directly (bypassing Meteor.callAsync, which would build
    // its own invocation) and invoke it with a PLAIN OBJECT as `this`. A
    // handler that calls `this.unblock()` must throw, because a plain object
    // has no such method — this is why the ambient invocation has to be real.
    const handler = (Meteor as any).server.method_handlers['test.usesUnblock'];
    let threw = false;
    try {
      handler.call({ userId: 'u9' }, {});
    } catch (e) {
      threw = true;
    }
    assert.isTrue(threw, 'expected a plain object `this` to make the handler throw');
  });

  it('propagates userId into adopted methods', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools([
      { method: 'test.echo', description: 'x', args: { type: 'object', properties: {} } },
    ]);
    const r = await runTool(tool, { q: 'hi' }, { userId: 'u7', sessionId: 's1' });
    assert.equal(r.value, 'hi:u7');
  });

  it('runs inline tools with the invocation as this', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools([{
      name: 'inline',
      description: 'x',
      args: { type: 'object', properties: {} },
      run: async (args: any, ctx: any) => `${args.n}:${ctx.userId}`,
    }]);
    const r = await runTool(tool, { n: 5 }, { userId: 'u2', sessionId: 's1' });
    assert.equal(r.value, '5:u2');
  });

  it('converts a Meteor.Error into a structured tool error, not a throw', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools([{
      name: 'boom', description: 'x', args: { type: 'object', properties: {} },
      run: async () => { throw new Meteor.Error('nope', 'not allowed'); },
    }]);
    const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
    assert.isFalse(r.ok);
    assert.equal(r.error!.error, 'nope');
    assert.equal(r.error!.reason, 'not allowed');
  });

  it('sanitizes non-Meteor errors so stacks never reach the transcript', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools([{
      name: 'raw', description: 'x', args: { type: 'object', properties: {} },
      run: async () => { throw new Error('SECRET internal detail'); },
    }]);
    const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
    assert.isFalse(r.ok);
    assert.equal(r.error!.error, 'tool-failed');
    assert.notInclude(JSON.stringify(r.error), 'SECRET');
  });

  it('produces provider tool schemas', async () => {
    const { resolveTools, toolSchemas } = await import('../server/tools');
    const tools = resolveTools([{
      name: 'search', description: 'Find things',
      args: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      run: async () => 'ok',
    }]);
    const [schema] = toolSchemas(tools);
    assert.equal(schema.name, 'search');
    assert.equal(schema.description, 'Find things');
    assert.deepEqual((schema.parameters as any).required, ['q']);
  });
});

describe('resolveTools validation', () => {
  it('rejects a spec with both "method" and "run"', async () => {
    const { resolveTools } = await import('../server/tools');
    assert.throws(() => {
      resolveTools([{
        name: 'ambiguous',
        method: 'test.echo',
        description: 'x',
        args: { type: 'object', properties: {} },
        run: async () => 'nope',
      } as any]);
    });
  });

  it('rejects a spec with neither "method" nor "run"', async () => {
    const { resolveTools } = await import('../server/tools');
    assert.throws(() => {
      resolveTools([{
        name: 'nothing',
        description: 'x',
        args: { type: 'object', properties: {} },
      } as any]);
    });
  });

  it('rejects an inline spec that is missing "name"', async () => {
    const { resolveTools } = await import('../server/tools');
    assert.throws(() => {
      resolveTools([{
        description: 'x',
        args: { type: 'object', properties: {} },
        run: async () => 'ok',
      } as any]);
    });
  });

  it('still resolves valid specs of each of the three shapes', async () => {
    const { resolveTools } = await import('../server/tools');
    const [bareString, methodObject, inlineObject] = resolveTools([
      'test.echo',
      { method: 'test.usesUnblock', description: 'x', args: { type: 'object', properties: {} } },
      {
        name: 'inline-ok',
        description: 'x',
        args: { type: 'object', properties: {} },
        run: async () => 'ok',
      },
    ]);
    assert.equal(bareString.kind, 'adopted');
    assert.equal(bareString.method, 'test.echo');
    assert.equal(bareString.name, 'test.echo');

    assert.equal(methodObject.kind, 'adopted');
    assert.equal(methodObject.method, 'test.usesUnblock');
    assert.equal(methodObject.name, 'test.usesUnblock');

    assert.equal(inlineObject.kind, 'inline');
    assert.equal(inlineObject.name, 'inline-ok');
    assert.equal(typeof inlineObject.run, 'function');
  });

  it('carries a PREDICATE gate through on every tool kind, and defaults a missing one', async () => {
    const { resolveTools } = await import('../server/tools');
    const predicate = () => true;
    const [inline, adopted, subagent, mcp, bare] = resolveTools([
      { name: 'i', description: 'x', args: {}, run: async () => 'ok', gate: predicate },
      { method: 'test.echo', description: 'x', args: {}, gate: predicate },
      { subagent: 'researcher', description: 'x', gate: predicate },
      { mcp: { server: 'docs', tool: 'search' }, gate: predicate },
      'test.usesUnblock',
    ] as any);
    // The same function object, not a copy or a wrapper: the dispatch site
    // calls exactly what the app wrote.
    for (const tool of [inline, adopted, subagent, mcp]) {
      assert.strictEqual(tool.gate, predicate, `${tool.kind} must carry the predicate through`);
    }
    assert.equal(bare.gate, 'auto', 'a spec with no gate still defaults to auto');
  });

  it('refuses a gate that is neither a literal nor a function', async () => {
    const { resolveTools } = await import('../server/tools');
    // The failure this guard exists for: a gate is read once per dispatch, deep
    // inside a turn, so a typo would otherwise surface as a silently UNGATED
    // tool — the wrong direction to be wrong in. Refused at resolve time, where
    // it is a startup error naming the tool.
    for (const bad of ['Ask', 'auto ', true, 0, null, {}]) {
      assert.throws(
        () => resolveTools([
          { name: 'typo', description: 'x', args: {}, run: async () => 'ok', gate: bad },
        ] as any),
        /invalid "gate"/,
        `gate: ${JSON.stringify(bad)} must be refused`,
      );
    }
    // …but an omitted gate is not a typo, and `null` is not a legal way to say
    // "no gate" — `undefined` is, and it is the only one that resolves.
    assert.equal(
      resolveTools([
        { name: 'fine', description: 'x', args: {}, run: async () => 'ok', gate: undefined },
      ] as any)[0].gate,
      'auto',
    );
  });
});

describe('validateToolArgs', () => {
  // The shipped checker is MINIMAL by design (see server/tools.ts): `type`,
  // object `required`/`properties`, array `items`, and nothing else. What it
  // cannot model it accepts, so it never rejects what a fuller validator would
  // have allowed.

  it('names the missing KEY when a required field is absent', async () => {
    const { validateToolArgs } = await import('../server/tools');
    const r = await validateToolArgs(
      { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      {},
    );
    assert.isFalse(r.ok);
    assert.include((r as any).reason, 'q');
    assert.include((r as any).reason, 'required');
  });

  it('names the FIELD, never the value, when a primitive type is wrong', async () => {
    const { validateToolArgs } = await import('../server/tools');
    const r = await validateToolArgs(
      { type: 'object', properties: { amount: { type: 'number' } } },
      { amount: 'SECRET-4111111111111111' },
    );
    assert.isFalse(r.ok);
    assert.include((r as any).reason, 'amount');
    // The reason is fed back to the model and published in the tool row. It
    // must describe the shape, never repeat the data.
    assert.notInclude((r as any).reason, 'SECRET');
  });

  it('descends into nested objects and reports the dotted path', async () => {
    const { validateToolArgs } = await import('../server/tools');
    const schema = {
      type: 'object',
      properties: {
        customer: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      required: ['customer'],
    };
    assert.isTrue((await validateToolArgs(schema, { customer: { id: 'c1' } })).ok);
    const missing = await validateToolArgs(schema, { customer: {} });
    assert.isFalse(missing.ok);
    assert.include((missing as any).reason, 'customer.id');
    const wrongType = await validateToolArgs(schema, { customer: { id: 7 } });
    assert.isFalse(wrongType.ok);
    assert.include((wrongType as any).reason, 'customer.id');
  });

  it('checks array items and reports the offending index', async () => {
    const { validateToolArgs } = await import('../server/tools');
    const schema = {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
    };
    assert.isTrue((await validateToolArgs(schema, { ids: ['a', 'b'] })).ok);
    const r = await validateToolArgs(schema, { ids: ['a', 3] });
    assert.isFalse(r.ok);
    assert.include((r as any).reason, 'ids[1]');
    const notAnArray = await validateToolArgs(schema, { ids: 'a' });
    assert.isFalse(notAnArray.ok);
    assert.include((notAnArray as any).reason, 'ids');
  });

  it('accepts anything under an empty schema, and tolerates unknown keywords', async () => {
    const { validateToolArgs } = await import('../server/tools');
    assert.isTrue((await validateToolArgs({}, { whatever: [1, 2] })).ok);
    assert.isTrue((await validateToolArgs({}, undefined)).ok);
    assert.isTrue((await validateToolArgs({ type: 'object', properties: {} }, { extra: 1 })).ok);
    // A schema that is not a schema at all constrains nothing rather than
    // exploding — `Value.Check` throws on these, so the guard above it must not.
    assert.isTrue((await validateToolArgs(null, { v: 1 })).ok);
    assert.isTrue((await validateToolArgs('nonsense', { v: 1 })).ok);
    // Vendor keywords neither checker knows are ignored, not guessed at.
    assert.isTrue((await validateToolArgs(
      { type: 'object', properties: { v: { type: 'string', 'x-vendor': 'shout' } } },
      { v: 'ok' },
    )).ok);
  });
});

describe('validateToolArgs — the full checker (typebox Value.Check)', () => {
  // M4 Task 1. The DEFAULT validator now enforces the whole schema when
  // typebox is reachable through the loader seam. These assertions are the
  // reason the seam exists: every one of them passed silently under the
  // structural checker, which ignores enum, bounds, oneOf and the rest.
  const rich = {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'sub', 'mul'] },
      n: { type: 'integer', minimum: 1, maximum: 10 },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      who: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    },
    required: ['op', 'n'],
    additionalProperties: false,
  };

  it('reports the full checker as available in this app tree', async () => {
    const { fullValidationAvailable } = await import('../server/tools');
    assert.isTrue(
      fullValidationAvailable(),
      'typebox ships as a dependency of pi-ai; the loader seam must reach it',
    );
  });

  it('ACCEPTS arguments that satisfy a rich schema', async () => {
    const { validateToolArgs } = await import('../server/tools');
    assert.isTrue((await validateToolArgs(rich, { op: 'add', n: 5 })).ok);
    assert.isTrue((await validateToolArgs(
      rich, { op: 'mul', n: 10, tags: ['a'], who: 7 },
    )).ok);
  });

  it('REJECTS an out-of-enum value, naming the field and never the value', async () => {
    const { validateToolArgs } = await import('../server/tools');
    const r = await validateToolArgs(rich, { op: 'SECRET-op', n: 5 });
    assert.isFalse(r.ok, 'enum is exactly what the structural checker cannot see');
    assert.include((r as any).reason, 'op');
    assert.notInclude((r as any).reason, 'SECRET');
  });

  it('REJECTS values outside numeric bounds, both ends, and non-integers', async () => {
    const { validateToolArgs } = await import('../server/tools');
    assert.isFalse((await validateToolArgs(rich, { op: 'add', n: 0 })).ok);
    assert.isFalse((await validateToolArgs(rich, { op: 'add', n: 11 })).ok);
    assert.isFalse((await validateToolArgs(rich, { op: 'add', n: 5.5 })).ok);
    const r = await validateToolArgs(rich, { op: 'add', n: 99 });
    assert.include((r as any).reason, 'n');
  });

  it('REJECTS oneOf misses, minItems violations and unexpected fields', async () => {
    const { validateToolArgs } = await import('../server/tools');
    assert.isFalse((await validateToolArgs(rich, { op: 'add', n: 5, who: true })).ok);
    assert.isFalse((await validateToolArgs(rich, { op: 'add', n: 5, tags: [] })).ok);
    const extra = await validateToolArgs(rich, { op: 'add', n: 5, sneak: 'SECRET-value' });
    assert.isFalse(extra.ok, 'additionalProperties: false must be enforced');
    assert.include((extra as any).reason, 'sneak');
    assert.notInclude((extra as any).reason, 'SECRET');
  });

  it('ENFORCES `format` — a non-URI is rejected where the schema names format: uri', async () => {
    // The README claims `format` is enforced, not treated as a decorative
    // annotation. typebox 1.x ships its string formats registered by default,
    // so the compiled DEFAULT checker rejects a malformed value with no
    // FormatRegistry setup of our own — this pins that behaviour so a typebox
    // bump that reverts to annotation-only fails here rather than silently
    // letting bad `format: 'uri'` arguments through. Inline (not MCP-discovered)
    // schema on purpose: the claim is about the checker, not tool discovery.
    const { validateToolArgs, fullValidationAvailable } = await import('../server/tools');
    assert.isTrue(fullValidationAvailable(), 'the full checker must be in force for this claim');
    const schema = {
      type: 'object',
      properties: { u: { type: 'string', format: 'uri' } },
      required: ['u'],
    };
    assert.isTrue((await validateToolArgs(schema, { u: 'https://example.com/x' })).ok,
      'a well-formed URI must pass');
    const bad = await validateToolArgs(schema, { u: 'not a uri' });
    assert.isFalse(bad.ok, 'format: uri must reject a non-URI, not treat it as annotation');
    assert.include((bad as any).reason, 'u', 'the reason must name the field');
  });

  it('keeps the structural checker\'s reason vocabulary for paths and required', async () => {
    const { validateToolArgs } = await import('../server/tools');
    const nested = {
      type: 'object',
      properties: {
        customer: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['customer'],
    };
    const missing = await validateToolArgs(nested, { customer: {} });
    assert.include((missing as any).reason, 'customer.id');
    assert.include((missing as any).reason, 'required');
    const item = await validateToolArgs(nested, { customer: { id: 'c' }, ids: ['a', 3] });
    assert.include((item as any).reason, 'ids[1]');
  });

  it('degrades to the structural checker, with ONE warning, when typebox will not load', async () => {
    const { validateToolArgs, setTypeboxValueLoader } = await import('../server/tools');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    // The forced outage: a loader that rejects is exactly what a renamed
    // typebox export or a pruned production tree looks like at runtime.
    const restore = setTypeboxValueLoader(async () => { throw new Error('forced outage'); });
    try {
      // Rich constraints are no longer enforced — the documented narrowing.
      assert.isTrue((await validateToolArgs(rich, { op: 'nope', n: 999 })).ok);
      assert.isTrue((await validateToolArgs(rich, { op: 'add', n: 5, sneak: 1 })).ok);
      // But structure still is: this is a DEGRADE, not a disable.
      const missing = await validateToolArgs(rich, { n: 5 });
      assert.isFalse(missing.ok, 'the structural checker must still enforce required');
      assert.include((missing as any).reason, 'op');
      const wrongType = await validateToolArgs(rich, { op: 4, n: 5 });
      assert.isFalse(wrongType.ok);
      assert.include((wrongType as any).reason, 'op');

      assert.lengthOf(
        warnings.filter((w) => w.includes('10thfloor:agent')), 1,
        'one warning per outage, not one per tool call',
      );
      assert.include(warnings[0], 'typebox');
    } finally {
      restore();
      console.warn = originalWarn;
    }
  });
});

describe('Agent.method co-registration', () => {
  it('serves both callers from ONE definition: callAsync and an agent tool', async function () {
    this.timeout(30000);
    const { withInvocation } = await import('../server/tools');

    // Caller 1: the UI, straight over DDP.
    const direct = await withInvocation('u-ui', () => Meteor.callAsync(
      'test.coRegistered', { amount: 10 },
    ));
    assert.equal(direct, 'refunded:10:u-ui');

    // Caller 2: the model, through the very same handle the define returned.
    const { requests, msgs } = await runWithTool(
      's-coreg', [coRegistered], { name: 'test.coRegistered', args: { amount: 20 } },
    );
    const toolRow = msgs.find((m) => m.role === 'tool')!;
    assert.isUndefined(toolRow.error, 'the co-registered tool must have run');
    // userId flows from the session's owner through callAsync, unchanged.
    assert.include(toolRow.content!, 'refunded:20:u1');
    assert.lengthOf(requests, 2, 'the turn continues after the tool answers');
    assert.deepEqual(ran.slice(-2), [10, 20]);

    // The handle resolves as an ADOPTED tool: dispatch goes through the method,
    // which is what makes both callers one path.
    const { resolveTools } = await import('../server/tools');
    const [resolved] = resolveTools([coRegistered]);
    assert.equal(resolved.kind, 'adopted');
    assert.equal(resolved.method, 'test.coRegistered');
    assert.equal(resolved.name, 'test.coRegistered');
  });

  it('refuses a DDP caller with invalid args as Meteor.Error(invalid-args)', async () => {
    const before = ran.length;
    let caught: any;
    try {
      await Meteor.callAsync('test.coRegistered', { order: 'o1' });
    } catch (e) { caught = e; }
    assert.instanceOf(caught, Meteor.Error);
    assert.equal(caught.error, 'invalid-args');
    assert.include(caught.reason, 'amount');
    assert.equal(ran.length, before, 'the body must not run on invalid args');
  });

  it('runs a valid DDP call with this.userId intact', async () => {
    const { withInvocation } = await import('../server/tools');
    const out = await withInvocation('u-42', () => Meteor.callAsync(
      'test.coRegistered', { amount: 3, order: 'o9' },
    ));
    assert.equal(out, 'refunded:3:u-42');
  });
});

describe('inline tool argument validation', () => {
  const numeric = {
    type: 'object',
    properties: { amount: { type: 'number' } },
    required: ['amount'],
  };

  it('answers model-supplied invalid args with invalid-args, and never runs the tool', async function () {
    this.timeout(30000);
    let toolRan = false;
    const { requests, msgs } = await runWithTool('s-badargs', [{
      name: 'refund', description: 'x', args: numeric,
      run: async () => { toolRan = true; return 'refunded'; },
    }], { name: 'refund', args: { amount: 'SECRET-lots' } });

    assert.isFalse(toolRan, 'an inline tool must never see unvalidated args');
    const toolRow = msgs.find((m) => m.role === 'tool')!;
    assert.equal(toolRow.error!.error, 'invalid-args');
    assert.include(toolRow.error!.reason, 'amount');
    assert.notInclude(JSON.stringify(toolRow), 'SECRET', 'the value must not reach the transcript');

    // A failure is a RESULT, not a throw: the turn continued and the model's
    // next request carries the error so it can correct itself.
    assert.lengthOf(requests, 2);
    const seen = requests[1].find((m) => m.role === 'tool')!;
    assert.include(seen.content!, 'invalid-args');
    assert.isTrue(seen.isError, 'the provider must be told the result failed');
  });

  it('dispatches valid args normally', async function () {
    this.timeout(30000);
    let seenArgs: any;
    const { msgs } = await runWithTool('s-goodargs', [{
      name: 'refund', description: 'x', args: numeric,
      run: async (args: any) => { seenArgs = args; return { refunded: args.amount }; },
    }], { name: 'refund', args: { amount: 5 } });

    assert.deepEqual(seenArgs, { amount: 5 });
    const toolRow = msgs.find((m) => m.role === 'tool')!;
    assert.isUndefined(toolRow.error);
    assert.include(toolRow.content!, '"refunded":5');
  });

  it('degrades to running the tool, with ONE warning, when the validator is unavailable', async () => {
    const { resolveTools, runTool, setToolArgsValidator } = await import('../server/tools');
    const [tool] = resolveTools([{
      name: 'refund', description: 'x', args: numeric,
      run: async (args: any) => `ran:${args.amount}`,
    }]);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    // The seam, not a broken pi-ai: validation is a guard on top of the tool,
    // and a guard that cannot load must not take every tool call down with it.
    const restore = setToolArgsValidator(null);
    try {
      const first = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
      const second = await runTool(tool, { amount: 'nope' }, { userId: 'u1', sessionId: 's1' });
      assert.isTrue(first.ok, 'the tool must still run when validation is unavailable');
      assert.isTrue(second.ok);
      assert.equal(second.value, 'ran:nope');
      assert.lengthOf(
        warnings.filter((w) => w.includes('10thfloor:agent')), 1,
        'the warning is once per outage, not once per tool call',
      );
    } finally {
      restore();
      console.warn = originalWarn;
    }
  });

  it('leaves adopted tools to their own validation', async () => {
    // `test.echo` declares an empty schema but reads `args.q`. An adopted tool
    // is dispatched through its method, whose own check() (or co-registered
    // validation) is the guard — the harness must not second-guess it here.
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools(['test.echo']);
    const r = await runTool(tool, { q: 'hi' }, { userId: 'u3', sessionId: 's1' });
    assert.isTrue(r.ok);
    assert.equal(r.value, 'hi:u3');
  });
});

describe('toProviderMessages', () => {
  // The single boundary between what the transcript stores and what the
  // provider is sent.
  const row = (over: Partial<AgentMessage>): AgentMessage => ({
    _id: Math.random().toString(36).slice(2), sessionId: 's', seq: 0,
    role: 'user', createdAt: new Date(), ...over,
  } as AgentMessage);

  it('drops note rows and keeps everything else in order', async () => {
    const { toProviderMessages } = await import('../server/loop');
    const out = toProviderMessages([
      row({ seq: 0, role: 'user', content: 'hi' }),
      row({ seq: 1, role: 'note', kind: 'error', content: 'boom' }),
      row({ seq: 2, role: 'assistant', content: 'hello' }),
      row({ seq: 3, role: 'note', kind: 'budget', budget: 'toolCalls' }),
      row({ seq: 4, role: 'note', kind: 'compaction', summary: 's', upto: 2 }),
    ]);
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
    assert.deepEqual(out.map((m) => m.content), ['hi', 'hello']);
  });

  it('sets isError only on rows that carry an error', async () => {
    const { toProviderMessages } = await import('../server/loop');
    const out = toProviderMessages([
      row({ seq: 0, role: 'tool', toolCallId: 't1', content: '{"ok":true}' }),
      row({
        seq: 1, role: 'tool', toolCallId: 't2', content: '{"error":"denied"}',
        error: { error: 'denied', reason: 'too large' },
      }),
      row({ seq: 2, role: 'assistant', content: 'ok' }),
    ]);
    assert.isUndefined(out[0].isError, 'a successful result carries no flag');
    assert.isTrue(out[1].isError);
    assert.isUndefined(out[2].isError);
    // The error OBJECT stays behind — the detail is already in the content.
    assert.notProperty(out[1], 'error');
  });

  it('preserves roles, tool calls and tool call ids', async () => {
    const { toProviderMessages } = await import('../server/loop');
    const calls = [{ id: 't1', name: 'look', args: { q: 1 } }];
    const out = toProviderMessages([
      row({ seq: 0, role: 'user', content: 'find it' }),
      row({ seq: 1, role: 'assistant', content: 'looking', toolCalls: calls }),
      row({ seq: 2, role: 'tool', toolCallId: 't1', content: '{"found":true}' }),
    ]);
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool']);
    assert.deepEqual(out[1].toolCalls, calls);
    assert.equal(out[2].toolCallId, 't1');
    // `thinking` is not replayed and never was — no provider gets a thinking
    // block back without the signature the transcript does not store.
    assert.notProperty(out[1], 'thinking');
  });
});

describe('Agent.method fail-closed registration (final-review ruling)', () => {
  it('unenforceableKeyword finds keywords the minimal checker ignores', async () => {
    const { unenforceableKeyword } = await import('../server/tools');
    assert.isNull(unenforceableKeyword({
      type: 'object', properties: { q: { type: 'string' } }, required: ['q'],
    }));
    assert.equal(unenforceableKeyword({ type: 'object', properties: {}, enum: [1] }), 'enum');
    assert.equal(unenforceableKeyword({
      type: 'object', properties: { q: { type: 'string', pattern: '^x' } },
    }), 'pattern');
    assert.equal(unenforceableKeyword({
      type: 'array', items: { oneOf: [{ type: 'string' }] },
    }), 'oneOf');
  });

  it('Agent.method throws at define time when NO full validator is available', async () => {
    const { Agent } = await import('../server/agent');
    const { setTypeboxValueLoader } = await import('../server/tools');
    // "Accept what I can't check" is the right bias for the MODEL (it
    // retries); on a public DDP endpoint it is an unguarded argument — the
    // selector-injection surface reintroduced by the feature that promised to
    // close it. So an unenforceable schema is a startup error, not a silent gap.
    //
    // M4: the guard is now conditional, so the test has to CREATE the
    // condition — `null` removes the typebox route the app tree really has.
    const restore = setTypeboxValueLoader(null);
    let threw: any;
    try {
      Agent.method('failclosed.enum', {
        description: 'x',
        args: { type: 'object', properties: { k: { enum: ['a', 'b'] } } },
        run: async () => 'never',
      });
    } catch (e) { threw = e; } finally { restore(); }
    assert.isDefined(threw, 'registration must fail closed');
    assert.include(threw.message, 'enum');
    assert.include(threw.message, 'failclosed.enum');
    assert.include(threw.message, 'setToolArgsValidator');
    assert.include(threw.message, 'typebox', 'the message must name the fix that now exists');
    // And the method must NOT have been registered.
    assert.isUndefined((Meteor as any).server.method_handlers['failclosed.enum']);
  });

  it('Agent.method ACCEPTS a rich schema when the full validator is available', async function () {
    this.timeout(30000);
    const { Agent } = await import('../server/agent');
    const { fullValidationAvailable } = await import('../server/tools');
    assert.isTrue(fullValidationAvailable());
    // The whole point of Task 1: with typebox reachable, a schema the
    // structural checker could not enforce is no longer a registration error —
    // and the endpoint it produces really does enforce it.
    const spec = Agent.method('failclosed.rich', {
      description: 'x',
      args: {
        type: 'object',
        properties: { k: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer', maximum: 3 } },
        required: ['k'],
      },
      run: async (args: any) => `got ${args.k}`,
    });
    assert.equal(spec.method, 'failclosed.rich');

    const { withInvocation } = await import('../server/tools');
    assert.equal(
      await withInvocation('u-rich', () => Meteor.callAsync('failclosed.rich', { k: 'a' })),
      'got a',
    );
    let ddpThrew: any;
    try {
      await withInvocation('u-rich', () => Meteor.callAsync('failclosed.rich', { k: 'z' }));
    } catch (e) { ddpThrew = e; }
    assert.instanceOf(ddpThrew, Meteor.Error);
    assert.equal(ddpThrew.error, 'invalid-args');
    let boundsThrew: any;
    try {
      await withInvocation('u-rich', () => Meteor.callAsync('failclosed.rich', { k: 'a', n: 9 }));
    } catch (e) { boundsThrew = e; }
    assert.instanceOf(boundsThrew, Meteor.Error);
    assert.equal(boundsThrew.error, 'invalid-args');
  });

  it('a plain structural schema still registers fine', async () => {
    const { Agent } = await import('../server/agent');
    const spec = Agent.method('failclosed.plain', {
      description: 'x',
      args: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      run: async (args: any) => `got ${args.q}`,
    });
    assert.equal(spec.method, 'failclosed.plain');
    assert.isFunction((Meteor as any).server.method_handlers['failclosed.plain']);
  });
});
