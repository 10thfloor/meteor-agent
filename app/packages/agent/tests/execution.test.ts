import { assert } from 'chai';
import {
  IsolatedExecutionError, runIsolatedExecution,
  type IsolatedExecutionProvider, type IsolatedExecutionRequest,
} from '../server/execution';

const request = (overrides: Partial<IsolatedExecutionRequest> = {}): IsolatedExecutionRequest => ({
  workspaceId: 'test-workspace', command: ['python', '-'], stdin: 'print("ok")',
  timeoutMs: 1000, maxOutputBytes: 100, ...overrides,
});
const failure = async (work: Promise<unknown>): Promise<any> => {
  try { await work; } catch (error) { return error; }
  return assert.fail('Expected execution to reject.');
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('isolated execution provider boundary', () => {
  it('passes argv/stdin, buffers both streams in order, and strips undeclared host fields', async () => {
    const chunks: string[] = [];
    let received: IsolatedExecutionRequest | undefined;
    const result = await runIsolatedExecution({
      async run(input, context) {
        received = input;
        assert.isFalse(context.signal.aborted);
        context.onOutput({ stream: 'stdout', text: 'ok' });
        context.onOutput({ stream: 'stderr', text: 'warn' });
        return { exitCode: 0 };
      },
    }, { ...request(), env: { SECRET: 'must not reach provider' } } as any, {
      onOutput: ({ stream, text }) => chunks.push(`${stream}:${text}`),
    });
    assert.deepEqual(received, request());
    assert.deepEqual(chunks, ['stdout:ok', 'stderr:warn']);
    assert.deepEqual(result, { exitCode: 0, stdout: 'ok', stderr: 'warn', outputBytes: 6, truncated: false });
  });

  it('rejects invalid limits, argv and workspaces before invoking a provider', async () => {
    let calls = 0;
    const provider = { async run() { calls += 1; return { exitCode: 0 }; } };
    for (const overrides of [
      { timeoutMs: 0 }, { timeoutMs: Infinity }, { maxOutputBytes: 0 },
      { maxOutputBytes: 16 * 1024 * 1024 + 1 }, { command: [] },
      { command: ['python', '\0'] }, { workspaceId: ' ' },
    ]) {
      assert.instanceOf(await failure(runIsolatedExecution(provider, request(overrides))), TypeError);
    }
    assert.equal(calls, 0);
  });

  it('never starts a provider when the caller was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const error = await failure(runIsolatedExecution({ async run() { calls += 1; return { exitCode: 0 }; } }, request(), { signal: controller.signal }));
    assert.instanceOf(error, IsolatedExecutionError);
    assert.equal(error.code, 'cancelled');
    assert.equal(calls, 0);
  });

  it('cancels the provider and waits for confirmed cleanup before rejecting', async () => {
    const controller = new AbortController();
    let cleaned = false;
    const work = runIsolatedExecution({
      async run(_input, context) {
        context.onOutput({ stream: 'stdout', text: 'partial' });
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        await wait(15);
        cleaned = true;
        return { exitCode: null };
      },
    }, request(), { signal: controller.signal });
    controller.abort();
    const error = await failure(work);
    assert.isTrue(cleaned, 'abort must not race ahead of remote cleanup');
    assert.equal(error.code, 'cancelled');
    assert.equal(error.result.stdout, 'partial');
  });

  it('enforces timeout cooperatively, retaining output after cleanup', async () => {
    let cleaned = false;
    const error = await failure(runIsolatedExecution({
      async run(_input, context) {
        context.onOutput({ stream: 'stderr', text: 'waiting' });
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        cleaned = true;
        return { exitCode: null };
      },
    }, request({ timeoutMs: 10 })));
    assert.isTrue(cleaned);
    assert.equal(error.code, 'timeout');
    assert.equal(error.result.stderr, 'waiting');
  });

  it('bounds combined UTF-8 output before callbacks and aborts on overflow', async () => {
    const chunks: string[] = [];
    let aborted = false;
    const error = await failure(runIsolatedExecution({
      async run(_input, context) {
        context.onOutput({ stream: 'stderr', text: 'ab' });
        context.onOutput({ stream: 'stdout', text: '💫cd' });
        aborted = context.signal.aborted;
        context.onOutput({ stream: 'stdout', text: 'ignored after cancellation' });
        return { exitCode: null };
      },
    }, request({ maxOutputBytes: 5 }), { onOutput: ({ text }) => chunks.push(text) }));
    assert.isTrue(aborted);
    assert.equal(error.code, 'output-limit');
    assert.deepEqual(chunks, ['ab']);
    assert.deepEqual(error.result, { exitCode: null, stdout: '', stderr: 'ab', outputBytes: 2, truncated: true });
  });

  it('allows output exactly at the byte limit without truncating', async () => {
    const result = await runIsolatedExecution({ async run(_input, context) {
      context.onOutput({ stream: 'stdout', text: '💫a' });
      return { exitCode: 7 };
    } }, request({ maxOutputBytes: 5 }));
    assert.equal(result.stdout, '💫a');
    assert.equal(result.outputBytes, 5);
    assert.isFalse(result.truncated);
    assert.equal(result.exitCode, 7);
  });

  it('preserves uncertain cleanup errors instead of calling the run cancelled', async () => {
    const receipt = Object.assign(new Error('Cleanup needs reconciliation.'), { code: 'cleanup-unconfirmed', cleanupPending: true });
    const error = await failure(runIsolatedExecution({ async run(_input, context) {
      context.onOutput({ stream: 'stdout', text: 'too much output' });
      assert.isTrue(context.signal.aborted);
      throw receipt;
    } }, request({ maxOutputBytes: 3 })));
    assert.strictEqual(error, receipt);
  });

  it('preserves ordinary provider errors and rejects invalid completion metadata', async () => {
    const providerError = new Error('Provider unavailable.');
    assert.strictEqual(await failure(runIsolatedExecution({ async run() { throw providerError; } }, request())), providerError);
    assert.instanceOf(await failure(runIsolatedExecution({ async run() { return { exitCode: undefined } as any; } }, request())), TypeError);
  });

  it('preserves an unconfirmed stop so a retained environment can be quarantined', async () => {
    const receipt = Object.assign(new Error('Remote stop needs reconciliation.'), { code: 'stop-unconfirmed', executionId: 'remote-42' });
    const error = await failure(runIsolatedExecution({ async run(_input, context) {
      context.onOutput({ stream: 'stdout', text: 'output limit reached' });
      assert.isTrue(context.signal.aborted);
      throw receipt;
    } }, request({ maxOutputBytes: 3 })));
    assert.strictEqual(error, receipt);
    assert.equal(error.executionId, 'remote-42');
  });

  it('cancels before rethrowing an output consumer failure', async () => {
    const callbackError = new Error('Could not persist output.');
    let cleaned = false;
    const error = await failure(runIsolatedExecution({ async run(_input, context) {
      context.onOutput({ stream: 'stdout', text: 'result' });
      assert.isTrue(context.signal.aborted);
      cleaned = true;
      return { exitCode: null };
    } }, request(), { onOutput() { throw callbackError; } }));
    assert.strictEqual(error, callbackError);
    assert.isTrue(cleaned);
  });

  it('removes cancellation listeners and ignores output after settlement', async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: any[]) => { added += 1; return (add as any)(...args); }) as any;
    controller.signal.removeEventListener = ((...args: any[]) => { removed += 1; return (remove as any)(...args); }) as any;
    let context: Parameters<IsolatedExecutionProvider['run']>[1] | undefined;
    const chunks: string[] = [];
    const result = await runIsolatedExecution({ async run(_input, ctx) { context = ctx; return { exitCode: 0 }; } }, request(), {
      signal: controller.signal, onOutput: ({ text }) => chunks.push(text),
    });
    context!.onOutput({ stream: 'stdout', text: 'late' });
    controller.abort();
    await wait(5);
    assert.equal(added, removed);
    assert.isFalse(context!.signal.aborted);
    assert.isEmpty(chunks);
    assert.equal(result.stdout, '');
  });
});
