import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

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
  it('gives an adopted method a real MethodInvocation, so this.unblock works', async () => {
    const { resolveTools, runTool } = await import('../server/tools');
    const [tool] = resolveTools([
      { method: 'test.usesUnblock', description: 'x', args: { type: 'object', properties: {} } },
    ]);
    const r = await runTool(tool, {}, { userId: 'u1', sessionId: 's1' });
    assert.isTrue(r.ok);
    assert.equal(r.value, 'unblocked:u1');
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
