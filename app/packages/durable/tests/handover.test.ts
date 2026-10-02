import { assert } from 'chai';
import { instanceId } from 'meteor/10thfloor:durable';
import { handOver, handoverOnSignal } from '../server/handover';

// What a server does with its last seconds. The pieces are tested here with a
// stand-in for `process`, because the real thing would end the test run. (With
// two operating-system processes and a real SIGTERM, a worker handed its
// storage over, ended by that signal, and the survivor finished the work
// without waiting for the lease: run under plain Node while this was written.)

/** As much of `process` as `handoverOnSignal` uses, with every raised signal recorded instead of delivered. */
function fakeProcess() {
  const listeners = new Map<string, (() => void)[]>();
  const raised: string[] = [];
  const listen = (signal: string, listener: () => void) => {
    listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
  };
  return {
    raised,
    listen,
    source: {
      pid: 4242,
      once: listen,
      listenerCount: (signal: string) => listeners.get(signal)?.length ?? 0,
      kill(_pid: number, signal: string) { raised.push(signal); },
    },
    /** Deliver a signal as Node does: a `once` listener is removed before it is called. */
    deliver(signal: string) {
      const now = listeners.get(signal) ?? [];
      listeners.set(signal, []);
      for (const listener of now) listener();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('leaving in good order', function () {
  it('leaves first, then raises the signal again so that the process ends as it would have', async function () {
    const fake = fakeProcess();
    let finish!: () => void;
    const leaving = new Promise<void>((resolve) => { finish = resolve; });
    let left = 0;
    handoverOnSignal(fake.source, () => { left++; return leaving; });

    fake.deliver('SIGTERM');
    await tick();
    assert.strictEqual(left, 1);
    // Not before the leaving is done.
    assert.deepEqual(fake.raised, []);
    finish();
    await tick();
    assert.deepEqual(fake.raised, ['SIGTERM']);
  });

  it('ends at once on a second signal, and still ends when leaving fails', async function () {
    const fake = fakeProcess();
    let fail!: (error: Error) => void;
    const leaving = new Promise<void>((_, reject) => { fail = reject; });
    let left = 0;
    handoverOnSignal(fake.source, () => { left++; return leaving; });

    fake.deliver('SIGTERM');
    fake.deliver('SIGINT');
    assert.deepEqual(fake.raised, ['SIGINT']);
    assert.strictEqual(left, 1);
    fail(new Error('the database is gone'));
    await tick();
    assert.deepEqual(fake.raised, ['SIGINT', 'SIGTERM']);
  });

  it('raises nothing where the app has its own listener for the signal', async function () {
    const fake = fakeProcess();
    let appSaw = 0;
    // Not a `once` listener: it stays, as an app's shutdown handler does.
    const app = () => { appSaw++; fake.listen('SIGTERM', app); };
    fake.listen('SIGTERM', app);
    let left = 0;
    handoverOnSignal(fake.source, async () => { left++; });

    fake.deliver('SIGTERM');
    await tick();
    assert.strictEqual(left, 1);
    assert.strictEqual(appSaw, 1);
    assert.deepEqual(fake.raised, []);
  });

  it('stops the host, and gives its leases up only if that fails or takes too long', async function () {
    const calls: string[] = [];
    const host = (stop: () => Promise<void>) => ({
      stop: () => { calls.push('stop'); return stop(); },
      surrender: async () => { calls.push('surrender'); },
    });
    assert.strictEqual(await handOver(host(async () => undefined), 1000), 'stopped');
    assert.deepEqual(calls.splice(0), ['stop']);

    const began = Date.now();
    assert.strictEqual(await handOver(host(() => new Promise<void>(() => undefined)), 100), 'surrendered');
    assert.deepEqual(calls.splice(0), ['stop', 'surrender']);
    assert.isBelow(Date.now() - began, 1000);

    assert.strictEqual(await handOver(host(() => Promise.reject(new Error('no database'))), 1000), 'surrendered');
    assert.deepEqual(calls.splice(0), ['stop', 'surrender']);

    // A surrender that never answers does not hold the process either.
    const stuck = { stop: () => new Promise<void>(() => undefined), surrender: () => new Promise<void>(() => undefined) };
    const second = Date.now();
    assert.strictEqual(await handOver(stuck, 50), 'surrendered');
    assert.isBelow(Date.now() - second, 1000);
  });

  it('names processes that share a host and a port apart, where their manager numbers them', function () {
    const saved = { id: process.env.DURABLE_INSTANCE_ID, worker: process.env.NODE_APP_INSTANCE };
    try {
      delete process.env.DURABLE_INSTANCE_ID;
      delete process.env.NODE_APP_INSTANCE;
      const alone = instanceId();
      process.env.NODE_APP_INSTANCE = '3';
      assert.strictEqual(instanceId(), `${alone}|3`);
      process.env.DURABLE_INSTANCE_ID = 'web-7';
      assert.strictEqual(instanceId(), 'web-7');
    } finally {
      for (const [name, value] of [['DURABLE_INSTANCE_ID', saved.id], ['NODE_APP_INSTANCE', saved.worker]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
