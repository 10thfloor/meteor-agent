import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';

Meteor.methods({
  'test.usesUnblock'(this: any) {
    this.unblock();
    return `unblocked:${this.userId}`;
  },
  'test.echo'(this: any, args: { q: string }) {
    return `${args.q}:${this.userId}`;
  },
});

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
      assert.equal(typeof current.unblock, 'function');
      assert.equal(typeof current.setUserId, 'function');
      assert.equal(current.userId, 'u9');
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
});
