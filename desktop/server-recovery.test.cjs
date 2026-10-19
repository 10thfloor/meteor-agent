const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createServerRecovery, probeApplicationHealth, probeListenerOccupancy, stopOwnedProcess } = require('./server-recovery.cjs');

function fakeClock() {
  let time = 0; let id = 0; const tasks = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) { const key = ++id; tasks.set(key, { fn, at: time + delay }); return key; },
    clearTimer(key) { tasks.delete(key); },
    jump(ms) { time += ms; },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        tasks.delete(next[0]); time = Math.max(time, next[1].at); await next[1].fn();
      }
      time = Math.max(time, end);
    },
  };
}
function fakeChild(pid = 123) {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
}
function fixture(overrides = {}) {
  const clock = fakeClock(); const child = fakeChild(); const launches = []; const stops = []; const states = [];
  const host = { ready: false, free: true };
  const recovery = createServerRecovery({ ...clock, intervalMs: 10, unhealthyGraceMs: 120, crashGraceMs: 30,
    stableMs: 60, backoffMs: [1, 5, 15], probe: async () => host.ready, canLaunch: async () => host.free,
    launch: () => { launches.push(clock.now()); return fakeChild(124 + launches.length); },
    stop: async (target) => { stops.push(target); }, onState: (state) => states.push(state), ...overrides });
  return { recovery, clock, child, launches, stops, states, host };
}

test('healthy servers and ordinary rebuilds never restart or reload anything', async () => {
  const f = fixture(); f.host.ready = true; f.recovery.start({ process: f.child, ownsProcess: true });
  await f.clock.advance(100); f.host.ready = false;
  await f.clock.advance(110); f.host.ready = true; await f.clock.advance(30);
  assert.equal(f.recovery.snapshot().state, 'ready'); assert.deepEqual(f.launches, []); assert.deepEqual(f.stops, []);
  await f.recovery.shutdown();
});

test('strict unhealthy grace recovers a wedged owned runner with bounded backoff', async () => {
  const f = fixture(); f.recovery.start({ process: f.child, ownsProcess: true });
  await f.clock.advance(120); assert.deepEqual(f.launches, []);
  await f.clock.advance(1); assert.deepEqual(f.launches, [121]); assert.equal(f.stops[0], f.child);
  await f.clock.advance(1000);
  assert.deepEqual(f.launches, [121, 246, 381]); assert.equal(f.stops.length, 3);
  assert.equal(f.recovery.snapshot().state, 'recovery-paused');
  await f.recovery.shutdown();
});

test('recognizes a split Meteor application-crash message while its runner remains alive', async () => {
  const f = fixture(); f.recovery.start({ process: f.child, ownsProcess: true });
  await f.clock.advance(0);
  f.child.stderr.emit('data', '=> Your application is crash');
  f.child.stderr.emit('data', 'ing. Waiting for file change.');
  await f.clock.advance(30); assert.equal(f.launches.length, 0);
  await f.clock.advance(1); assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null);
  await f.recovery.shutdown();
});

test('runner exit uses crash grace and never treats a stale runner event as the replacement exiting', async () => {
  const f = fixture(); f.recovery.start({ process: f.child, ownsProcess: true }); await f.clock.advance(0);
  f.child.exitCode = 1; f.child.emit('exit', 1);
  await f.clock.advance(31); assert.equal(f.launches.length, 1);
  f.child.emit('exit', 1);
  await f.clock.advance(40); assert.equal(f.launches.length, 1);
  await f.recovery.shutdown();
});

test('an old consumed crash message cannot shorten a later normal rebuild grace', async () => {
  const f = fixture(); f.recovery.start({ process: f.child, ownsProcess: true });
  f.child.stderr.emit('data', 'Your application is crashing. Waiting for file change.');
  f.host.ready = true; await f.clock.advance(0);
  f.host.ready = false; f.child.stdout.emit('data', 'Server modified -- restarting.');
  await f.clock.advance(110); assert.equal(f.launches.length, 0);
  f.host.ready = true; await f.clock.advance(20); assert.equal(f.launches.length, 0);
  await f.recovery.shutdown();
});

test('never terminates or restarts an externally launched server', async () => {
  const f = fixture(); f.recovery.start(); await f.clock.advance(1000); await f.recovery.shutdown();
  assert.equal(f.recovery.snapshot().state, 'external-unavailable');
  assert.deepEqual(f.launches, []); assert.deepEqual(f.stops, []);
});

test('relinquishes ownership if another listener claims the port after the owned runner stops', async () => {
  const f = fixture(); f.host.free = false; f.recovery.start({ process: f.child, ownsProcess: true });
  await f.clock.advance(400); assert.equal(f.recovery.snapshot().owned, false);
  assert.deepEqual(f.launches, []); assert.deepEqual(f.stops, [f.child]);
  await f.recovery.shutdown(); assert.equal(f.stops.length, 1);
});

test('sleep and resume clear stale failures and allow a full recovery grace', async () => {
  const f = fixture(); f.recovery.start({ process: f.child, ownsProcess: true }); await f.clock.advance(110);
  f.recovery.suspend(); await f.clock.advance(1000); assert.equal(f.launches.length, 0);
  f.recovery.resume(); await f.clock.advance(119); assert.equal(f.launches.length, 0);
  f.host.ready = true; await f.clock.advance(20); assert.equal(f.launches.length, 0);
  await f.recovery.shutdown();
});

test('timer gaps also receive wake grace if platform sleep notifications were missed', async () => {
  const f = fixture(); f.recovery.start({ process: f.child, ownsProcess: true }); await f.clock.advance(110);
  f.clock.jump(1000); await f.clock.advance(0); await f.clock.advance(119); assert.equal(f.launches.length, 0);
  f.host.ready = true; await f.clock.advance(20); assert.equal(f.launches.length, 0);
  await f.recovery.shutdown();
});

test('a brief recovery does not replenish retries; sustained health does', async () => {
  const f = fixture(); f.recovery.start({ process: f.child, ownsProcess: true }); await f.clock.advance(500);
  f.host.ready = true; await f.clock.advance(20); assert.equal(f.recovery.snapshot().attempts, 3);
  f.host.ready = false; await f.clock.advance(20); assert.equal(f.recovery.snapshot().state, 'recovery-paused');
  f.host.ready = true; await f.clock.advance(80); assert.equal(f.recovery.snapshot().attempts, 0);
  await f.recovery.shutdown();
});

test('quit during a pending health probe cannot launch or leave a timer running', async () => {
  let finish; const f = fixture({ probe: () => new Promise((resolve) => { finish = resolve; }) });
  f.recovery.start({ process: f.child, ownsProcess: true }); const checking = f.clock.advance(0);
  await f.recovery.shutdown(); finish(false); await checking; await f.clock.advance(1000);
  assert.equal(f.stops.length, 1); assert.equal(f.launches.length, 0); assert.equal(f.recovery.snapshot().closed, true);
});

test('quit during restart shares the exact stop and prevents a replacement launch', async () => {
  let finish; let stopped = 0;
  const f = fixture({ stop: () => { stopped += 1; return new Promise((resolve) => { finish = resolve; }); } });
  f.recovery.start({ process: f.child, ownsProcess: true }); await f.clock.advance(120);
  const checking = f.clock.advance(1); await Promise.resolve(); await Promise.resolve();
  const quitting = f.recovery.shutdown(); finish(); await checking; await quitting;
  assert.equal(stopped, 1); assert.equal(f.launches.length, 0);
});

test('an unconfirmed process stop blocks replacement launches', async () => {
  const f = fixture({ stop: async () => { throw new Error('still alive'); } });
  f.recovery.start({ process: f.child, ownsProcess: true }); await f.clock.advance(500);
  assert.equal(f.launches.length, 0); assert.ok(f.states.includes('stop-unconfirmed'));
  await assert.rejects(f.recovery.shutdown());
});

test('an uncertain port-ownership check fails closed without an unhandled rejection or launch', async () => {
  const f = fixture({ canLaunch: async () => { throw new Error('cannot probe'); } });
  f.recovery.start({ process: f.child, ownsProcess: true }); await f.clock.advance(500);
  assert.equal(f.launches.length, 0); assert.equal(f.recovery.snapshot().state, 'recovery-paused');
  await f.recovery.shutdown();
});

function fakeHttp(statusCode, body, { hang = false } = {}) {
  return { get(_url, callback) {
    const request = Object.assign(new EventEmitter(), { destroy() {} });
    queueMicrotask(() => {
      if (hang) return;
      const response = Object.assign(new EventEmitter(), { statusCode, destroy() {} }); callback(response);
      response.emit('data', Buffer.from(body)); response.emit('end');
    });
    return request;
  } };
}
test('health requires the exact app JSON, not proxy HTML or a non-ready response', async () => {
  const url = 'http://127.0.0.1:3210/__constellation/health';
  for (const [status, body, expected] of [
    [200, '{"service":"constellation","status":"ready"}', true],
    [503, '{"service":"constellation","status":"ready"}', false],
    [200, '{"service":"constellation","status":"unavailable"}', false],
    [200, '{"service":"another-app","status":"ready"}', false],
    [200, '<html>Meteor is restarting</html>', false],
    [200, 'x'.repeat(5000), false],
  ]) assert.equal(await probeApplicationHealth(fakeHttp(status, body), url), expected);
});

test('a health request that never responds has a bounded deadline', async () => {
  const clock = fakeClock();
  const pending = probeApplicationHealth(fakeHttp(200, '', { hang: true }), 'http://127.0.0.1/health', {
    timeoutMs: 20, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  await clock.advance(20); assert.equal(await pending, false);
});

test('an established TCP listener is occupied even if it never sends HTTP', async () => {
  const clock = fakeClock(); let destroyed = 0;
  const socket = Object.assign(new EventEmitter(), { destroy() { destroyed += 1; } });
  const pending = probeListenerOccupancy({ createConnection: () => socket }, { host: '127.0.0.1', port: 3210 }, clock);
  socket.emit('connect'); assert.equal(await pending, true); assert.equal(destroyed, 1);
});

test('only ECONNREFUSED proves the local port absent; other socket errors fail closed', async () => {
  for (const code of ['ECONNREFUSED', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH']) {
    const clock = fakeClock(); let destroyed = 0;
    const socket = Object.assign(new EventEmitter(), { destroy() { destroyed += 1; } });
    const pending = probeListenerOccupancy({ createConnection: () => socket }, { host: '127.0.0.1', port: 3210 }, clock);
    socket.emit('error', Object.assign(new Error('test failure'), { code }));
    assert.equal(await pending, code !== 'ECONNREFUSED', code); assert.equal(destroyed, 1);
  }
});

test('uncertain listener deadlines, early close, and synchronous failures are occupied', async () => {
  const clock = fakeClock(); let destroyed = 0;
  const socket = Object.assign(new EventEmitter(), { destroy() { destroyed += 1; } });
  const pending = probeListenerOccupancy({ createConnection: () => socket }, {}, { ...clock, timeoutMs: 20 });
  await clock.advance(20); assert.equal(await pending, true); assert.equal(destroyed, 1);
  const closedSocket = Object.assign(new EventEmitter(), { destroy() {} });
  const closed = probeListenerOccupancy({ createConnection: () => closedSocket }, {}, clock);
  closedSocket.emit('close'); assert.equal(await closed, true);
  assert.equal(await probeListenerOccupancy({ createConnection() { throw new Error('cannot inspect'); } }, {}, clock), true);
});

test('owned POSIX shutdown targets only its recorded isolated process group', async () => {
  let alive = true; const calls = [];
  await stopOwnedProcess(fakeChild(321), { platform: 'darwin', kill: (pid, signal) => {
    calls.push([pid, signal]); if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (signal === 'SIGTERM') alive = false;
  }, sleep: async () => {} });
  assert.ok(calls.every(([pid]) => pid === -321)); assert.ok(calls.some(([, signal]) => signal === 'SIGTERM'));
  assert.ok(!calls.some(([, signal]) => signal === 'SIGKILL'));
});

test('owned shutdown escalates only after grace and refuses an unconfirmed stop', async () => {
  const signals = []; let sleeps = 0;
  await assert.rejects(stopOwnedProcess(fakeChild(321), { platform: 'darwin',
    kill: (_pid, signal) => { if (signal) signals.push(signal); }, sleep: async () => { sleeps += 1; }, graceMs: 30, forceMs: 20, pollMs: 10 }));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(sleeps, 5);
});
