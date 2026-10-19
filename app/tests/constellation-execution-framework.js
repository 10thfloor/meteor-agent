import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

if (Meteor.isServer) describe('Constellation public execution runtime', function () {
  this.timeout(15000);
  let runIsolatedExecution; let Agent; let AgentSessions; let mockProvider;
  const request = (patch = {}) => ({ workspaceId: 'test-workspace', command: ['python3', '-'], stdin: 'print(1)', timeoutMs: 1000, maxOutputBytes: 100, ...patch });
  const failure = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('Expected a rejection.'); };
  before(async () => { ({ runIsolatedExecution, Agent, AgentSessions, mockProvider } = await import('meteor/10thfloor:agent')); });

  it('passes only declared execution fields and returns separately bounded streams', async () => {
    let received;
    const result = await runIsolatedExecution({ run: async (input, context) => {
      received = input; context.onOutput({ stream: 'stdout', text: 'one' }); context.onOutput({ stream: 'stderr', text: 'two' }); return { exitCode: 0 };
    } }, { ...request(), env: { API_KEY: 'not-for-guest' }, cwd: '/Users/private' });
    assert.deepEqual(received, request()); assert.deepEqual(result, { exitCode: 0, stdout: 'one', stderr: 'two', outputBytes: 6, truncated: false });
  });
  it('never starts a cancelled request and waits for provider cleanup on cancellation', async () => {
    const cancelled = new AbortController(); cancelled.abort(); let calls = 0;
    const first = await failure(runIsolatedExecution({ run: async () => { calls += 1; return { exitCode: 0 }; } }, request(), { signal: cancelled.signal }));
    assert.strictEqual(first.code, 'cancelled'); assert.strictEqual(calls, 0);
    const controller = new AbortController(); let cleaned = false; let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const work = runIsolatedExecution({ run: async (_input, { signal, onOutput }) => {
      onOutput({ stream: 'stdout', text: 'partial' }); started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 10)); cleaned = true; return { exitCode: null };
    } }, request(), { signal: controller.signal });
    await ready; controller.abort(); const error = await failure(work);
    assert.isTrue(cleaned); assert.strictEqual(error.code, 'cancelled'); assert.strictEqual(error.result.stdout, 'partial');
  });
  it('enforces timeout and combined UTF-8 output without overstating cleanup certainty', async () => {
    let aborted = false;
    const timeout = await failure(runIsolatedExecution({ run: async (_input, { signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); aborted = true; return { exitCode: null };
    } }, request({ timeoutMs: 10 })));
    assert.isTrue(aborted); assert.strictEqual(timeout.code, 'timeout');
    const chunks = [];
    const overflow = await failure(runIsolatedExecution({ run: async (_input, context) => {
      context.onOutput({ stream: 'stderr', text: 'ab' }); context.onOutput({ stream: 'stdout', text: '💫cd' }); return { exitCode: null };
    } }, request({ maxOutputBytes: 5 }), { onOutput: ({ text }) => chunks.push(text) }));
    assert.strictEqual(overflow.code, 'output-limit'); assert.deepEqual(chunks, ['ab']); assert.isTrue(overflow.result.truncated);
    const uncertain = Object.assign(new Error('Unconfirmed cleanup'), { code: 'cleanup-unconfirmed' });
    assert.strictEqual(await failure(runIsolatedExecution({ run: async (_input, context) => {
      context.onOutput({ stream: 'stdout', text: 'overflow' }); throw uncertain;
    } }, request({ maxOutputBytes: 1 }))), uncertain);
    const retained = Object.assign(new Error('Unconfirmed stop'), { code: 'stop-unconfirmed', executionId: 'retained-42' });
    assert.strictEqual(await failure(runIsolatedExecution({ run: async (_input, context) => {
      context.onOutput({ stream: 'stdout', text: 'overflow' }); throw retained;
    } }, request({ maxOutputBytes: 1 }))), retained, 'retained files must not be deleted to satisfy cancellation');
  });
  it('delivers real inline dispatch cancellation to a tool during an Agent API turn', async () => {
    const name = `execution-signal-${Random.id()}`; const userId = `execution-owner-${Random.id()}`;
    let toolContext; let sawAbort = false; let finished = false; let release;
    const agent = new Agent(name, { model: 'mock', instructions: 'Call the isolated test tool once.',
      provider: mockProvider(() => ({ toolCalls: [{ id: 'execution-signal-call', name: 'isolated_test', args: {} }] })),
      budget: { turns: 3, toolCalls: 2, spend: 1 }, tools: [{ name: 'isolated_test', description: 'Test cancellation.', args: { type: 'object', properties: {}, additionalProperties: false },
        run: async (_args, context) => {
          toolContext = context;
          await new Promise((resolve) => { release = resolve; if (context.signal?.aborted) resolve(); else context.signal?.addEventListener('abort', resolve, { once: true }); });
          sawAbort = context.signal?.aborted === true; finished = true; return 'Stopped safely';
        } }],
    });
    const outcome = agent.ask('Run the cancellation fixture.', { userId }).then((value) => ({ value }), (error) => ({ error }));
    try {
      const until = Date.now() + 5000;
      while (!toolContext && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 15));
      assert.ok(toolContext, 'the real tool dispatch must begin'); assert.ok(toolContext.signal, 'the inline tool receives an AbortSignal');
      await AgentSessions.updateAsync(toolContext.sessionId, { $set: { phase: 'stopped', stoppedAt: new Date() } });
      const end = Date.now() + 5000;
      while (!finished && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 15));
      assert.isTrue(sawAbort, 'Stop must reach the actual tool signal');
      const result = await outcome; assert.ok(result.error, 'a stopped turn must not produce a successful reply');
      assert.isUndefined(await AgentSessions.findOneAsync(toolContext.sessionId), 'Agent.ask erases its temporary session after the tool settles');
    } finally {
      release?.(); await outcome;
      if (toolContext?.sessionId) await AgentSessions.removeAsync(toolContext.sessionId);
    }
  });
});
