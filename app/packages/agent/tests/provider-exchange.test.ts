import { assert } from 'chai';
import type { Provider, ProviderRequest } from '../server/providers/types';

const seedSession = async (sessionId: string): Promise<void> => {
  const { AgentSessions } = await import('../common/collections');
  const { SERVER_ID } = await import('../server/lease');
  await AgentSessions.removeAsync({});
  await AgentSessions.insertAsync({
    _id: sessionId,
    agent: 'exchange-agent',
    userId: 'u1',
    phase: 'streaming',
    model: 'mock',
    nextSeq: 0,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    lease: { serverId: SERVER_ID, until: new Date(Date.now() + 30_000) },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
};

const REQUEST: Omit<ProviderRequest, 'signal'> = {
  model: 'mock', system: 'system', messages: [], tools: [],
};

describe('Provider Exchange Module Interface', () => {
  it('runs hooks first and re-stamps the harness AbortSignal afterward', async () => {
    const { Agent } = await import('../server/agent');
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-signal');
    const foreign = new AbortController();
    let seen: ProviderRequest | undefined;
    const provider: Provider = {
      async *stream(request) {
        seen = request;
        yield { kind: 'text', chunk: 'ok' };
      },
    };

    try {
      Agent.hook('beforeProviderRequest', (request) => ({
        ...request,
        system: 'hooked',
        signal: foreign.signal,
      }));
      const chunks: string[] = [];
      const result = await runProviderExchange({
        sessionId: 'exchange-signal', provider, request: REQUEST,
        context: { agent: 'exchange-agent', sessionId: 'exchange-signal', purpose: 'think' },
        onChunk(chunk) { if (chunk.kind === 'text') chunks.push(chunk.chunk); },
      });
      assert.deepEqual(result, { kind: 'complete' });
      assert.equal(seen?.system, 'hooked');
      assert.isDefined(seen?.signal);
      assert.notStrictEqual(seen?.signal, foreign.signal, 'hooks cannot own cancellation');
      assert.deepEqual(chunks, ['ok']);
    } finally {
      Agent.clearHooks();
    }
  });

  it('aborts a Provider stalled before its first chunk when the Session stops', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-stall');
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const provider: Provider = {
      async *stream(request) {
        signal = request.signal;
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
        yield { kind: 'text', chunk: 'unreachable' };
      },
    };

    const pending = runProviderExchange({
      sessionId: 'exchange-stall', provider, request: REQUEST,
      context: { agent: 'exchange-agent', sessionId: 'exchange-stall', purpose: 'think' },
      interruptCheckMs: 5,
      onChunk() { assert.fail('a stopped exchange must emit no chunk'); },
    });
    await started;
    await AgentSessions.updateAsync('exchange-stall', {
      $set: { phase: 'stopped', updatedAt: new Date() },
    } as any);
    assert.deepEqual(await pending, { kind: 'interrupted' });
    assert.isTrue(signal?.aborted, 'the Adapter receives the abort, not only a consumer break');
  });

  it('drops a late chunk from a Provider that ignores cancellation', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-late-chunk');
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const provider: Provider = {
      async *stream(request) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener('abort', () => resolve(), { once: true });
          markStarted();
        });
        // Deliberately violate the Adapter contract: cancellation happened,
        // but one more chunk is yielded anyway.
        yield { kind: 'text', chunk: 'must-not-publish' };
      },
    };
    const chunks: string[] = [];
    const pending = runProviderExchange({
      sessionId: 'exchange-late-chunk', provider, request: REQUEST,
      context: { agent: 'exchange-agent', sessionId: 'exchange-late-chunk', purpose: 'think' },
      interruptCheckMs: 5,
      onChunk(chunk) { if (chunk.kind === 'text') chunks.push(chunk.chunk); },
    });
    await started;
    await AgentSessions.updateAsync('exchange-late-chunk', {
      $set: { phase: 'stopped', updatedAt: new Date() },
    } as any);
    assert.deepEqual(await pending, { kind: 'interrupted' });
    assert.deepEqual(chunks, [], 'late Adapter output never reaches Deltas or caller state');
  });

  it('does not run hooks or the Provider after exact Lease authority is already gone', async () => {
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-expired');
    await AgentSessions.updateAsync('exchange-expired', {
      $set: { 'lease.until': new Date(0) },
    } as any);
    let hookCalls = 0;
    let providerCalls = 0;
    const provider: Provider = {
      async *stream() {
        providerCalls += 1;
        yield { kind: 'text', chunk: 'unreachable' };
      },
    };

    try {
      Agent.hook('beforeProviderRequest', () => { hookCalls += 1; });
      const result = await runProviderExchange({
        sessionId: 'exchange-expired', provider, request: REQUEST,
        context: { agent: 'exchange-agent', sessionId: 'exchange-expired', purpose: 'think' },
        onChunk() { assert.fail('an unauthorized exchange must emit no chunk'); },
      });
      assert.deepEqual(result, { kind: 'interrupted' });
      assert.equal(hookCalls, 0);
      assert.equal(providerCalls, 0);
    } finally {
      Agent.clearHooks();
    }
  });

  it('fails closed before hooks and paid work when authority cannot be read', async () => {
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-read-failure');
    const original = AgentSessions.findOneAsync;
    let hookCalls = 0;
    let providerCalls = 0;

    try {
      (AgentSessions as any).findOneAsync = async (selector: unknown, options?: unknown) => {
        if ((selector as { _id?: string })?._id === 'exchange-read-failure') {
          throw new Error('PRIVATE database diagnostic');
        }
        return (original as any).call(AgentSessions, selector, options);
      };
      Agent.hook('beforeProviderRequest', () => { hookCalls += 1; });
      const result = await runProviderExchange({
        sessionId: 'exchange-read-failure',
        provider: {
          async *stream() {
            providerCalls += 1;
            yield { kind: 'text', chunk: 'unreachable' };
          },
        },
        request: REQUEST,
        context: {
          agent: 'exchange-agent', sessionId: 'exchange-read-failure', purpose: 'think',
        },
        onChunk() { assert.fail('a failed authority read must emit no chunk'); },
      });
      assert.deepEqual(result, { kind: 'interrupted' });
      assert.equal(hookCalls, 0);
      assert.equal(providerCalls, 0);
    } finally {
      (AgentSessions as any).findOneAsync = original;
      Agent.clearHooks();
    }
  });

  it('rechecks authority after hooks before starting paid work', async () => {
    const { AgentSessions } = await import('../common/collections');
    const { Agent } = await import('../server/agent');
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-hook-expiry');
    let providerCalls = 0;

    try {
      Agent.hook('beforeProviderRequest', async () => {
        await AgentSessions.updateAsync('exchange-hook-expiry', {
          $set: { 'lease.until': new Date(0) },
        } as any);
      });
      const result = await runProviderExchange({
        sessionId: 'exchange-hook-expiry',
        provider: {
          async *stream() {
            providerCalls += 1;
            yield { kind: 'text', chunk: 'unreachable' };
          },
        },
        request: REQUEST,
        context: { agent: 'exchange-agent', sessionId: 'exchange-hook-expiry', purpose: 'think' },
        interruptCheckMs: 60_000,
        onChunk() { assert.fail('an exchange without current authority must emit no chunk'); },
      });
      assert.deepEqual(result, { kind: 'interrupted' });
      assert.equal(providerCalls, 0);
    } finally {
      Agent.clearHooks();
    }
  });

  it('aborts a stalled Provider when another server takes the Lease', async function () {
    this.timeout(30000);
    const { AgentSessions } = await import('../common/collections');
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-stolen');
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const provider: Provider = {
      async *stream(request) {
        signal = request.signal;
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
        yield { kind: 'text', chunk: 'unreachable' };
      },
    };

    const pending = runProviderExchange({
      sessionId: 'exchange-stolen', provider, request: REQUEST,
      context: { agent: 'exchange-agent', sessionId: 'exchange-stolen', purpose: 'think' },
      interruptCheckMs: 5,
      onChunk() { assert.fail('a stolen exchange must emit no chunk'); },
    });
    await started;
    await AgentSessions.updateAsync('exchange-stolen', {
      $set: { lease: { serverId: 'another-server', until: new Date(Date.now() + 30_000) } },
    } as any);
    assert.deepEqual(await pending, { kind: 'interrupted' });
    assert.isTrue(signal?.aborted);
  });

  it('observes a stop after the final chunk before reporting completion', async () => {
    const { AgentSessions } = await import('../common/collections');
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-final');
    const chunks: string[] = [];
    const provider: Provider = {
      async *stream() {
        yield { kind: 'text', chunk: 'last' };
        await AgentSessions.updateAsync('exchange-final', {
          $set: { phase: 'stopped', updatedAt: new Date() },
        } as any);
      },
    };

    const result = await runProviderExchange({
      sessionId: 'exchange-final', provider, request: REQUEST,
      context: { agent: 'exchange-agent', sessionId: 'exchange-final', purpose: 'compaction' },
      interruptCheckMs: 60_000,
      onChunk(chunk) { if (chunk.kind === 'text') chunks.push(chunk.chunk); },
    });
    assert.deepEqual(chunks, ['last']);
    assert.deepEqual(result, { kind: 'interrupted' });
  });

  it('returns even falsy Provider failures as failures', async () => {
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-falsy');
    const provider: Provider = {
      async *stream() { throw undefined; },
    };
    const result = await runProviderExchange({
      sessionId: 'exchange-falsy', provider, request: REQUEST,
      context: { agent: 'exchange-agent', sessionId: 'exchange-falsy', purpose: 'think' },
      onChunk() {},
    });
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.isUndefined(result.error);
  });

  it('normalizes malformed Provider usage before it can reach durable arithmetic', async () => {
    const { runProviderExchange } = await import('../server/provider-exchange');
    await seedSession('exchange-usage');
    const provider: Provider = {
      async *stream() {
        yield {
          kind: 'done',
          usage: { input: -7, output: Number.NaN, cost: Number.POSITIVE_INFINITY },
        };
      },
    };
    let usage: { input: number; output: number; cost?: number } | undefined;
    const result = await runProviderExchange({
      sessionId: 'exchange-usage', provider, request: REQUEST,
      context: { agent: 'exchange-agent', sessionId: 'exchange-usage', purpose: 'think' },
      onChunk(chunk) { if (chunk.kind === 'done') usage = chunk.usage; },
    });
    assert.deepEqual(result, { kind: 'complete' });
    assert.deepEqual(usage, { input: 0, output: 0 });
  });
});
