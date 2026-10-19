// Local-process supervision only. Never retries an application method, reloads
// a renderer, or adopts a process that another application started.
function createServerRecovery({
  probe, launch, stop, canLaunch = async () => true, onState = () => {}, onOutput = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  intervalMs = 5000, unhealthyGraceMs = 120000, crashGraceMs = 30000,
  stableMs = 60000, backoffMs = [1000, 5000, 15000],
}) {
  let child = null; let owned = false; let started = false; let closed = false; let suspended = false;
  let timer = null; let checking = false; let failureSince = null; let healthySince = null;
  let crashSeen = false; let deferUntil = 0; let nextAttemptAt = null; let attempts = 0;
  let lastCheckAt = null; let state = 'idle'; let detach = () => {};
  const stopping = new WeakMap();
  function report(value) { if (state !== value) { state = value; onState(value, { owned, attempts }); } }
  function stopOnce(target) {
    if (!target) return Promise.resolve();
    if (!stopping.has(target)) stopping.set(target, Promise.resolve().then(() => stop(target)));
    return stopping.get(target);
  }
  function adopt(next) {
    detach(); child = next; crashSeen = false;
    let tail = '';
    const output = (stream) => (chunk) => {
      onOutput(stream, chunk);
      if (closed || child !== next) return;
      tail = (tail + String(chunk)).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').slice(-4096);
      if (/application is crashing[\s\S]{0,120}waiting for file change/i.test(tail)) { crashSeen = true; tail = ''; }
    };
    const stdout = output('stdout'); const stderr = output('stderr');
    const exited = () => { if (!closed && child === next) crashSeen = true; };
    next.stdout?.on('data', stdout); next.stderr?.on('data', stderr);
    next.on('exit', exited); next.on('error', exited);
    detach = () => {
      next.stdout?.removeListener('data', stdout); next.stderr?.removeListener('data', stderr);
      next.removeListener('exit', exited); next.removeListener('error', exited);
      // A late process error must not become an unhandled EventEmitter error.
      next.on('error', () => {});
    };
  }
  function schedule(delay = intervalMs) {
    if (closed || suspended || !started || timer !== null) return;
    timer = setTimer(() => { timer = null; return check(); }, delay);
    timer?.unref?.();
  }
  async function check() {
    if (closed || suspended || checking || !started) return;
    checking = true;
    try {
      const began = now();
      // Also tolerate sleep when the platform did not deliver suspend/resume.
      if (lastCheckAt !== null && began - lastCheckAt > intervalMs * 4) {
        failureSince = null; nextAttemptAt = null; deferUntil = began + unhealthyGraceMs;
      }
      lastCheckAt = began;
      let ready = false;
      try { ready = await probe(); } catch {}
      if (closed || suspended) return;
      const time = now();
      if (ready) {
        failureSince = null; nextAttemptAt = null; crashSeen = false;
        healthySince ??= time;
        if (time - healthySince >= stableMs) attempts = 0;
        report('ready'); return;
      }
      healthySince = null; failureSince ??= time;
      if (!owned) { report('external-unavailable'); return; }
      if (attempts >= backoffMs.length) { report('recovery-paused'); return; }
      const eligibleAt = Math.max(deferUntil, failureSince + (crashSeen ? crashGraceMs : unhealthyGraceMs));
      if (time < eligibleAt) { report('waiting'); return; }
      nextAttemptAt ??= time + backoffMs[attempts];
      if (time < nextAttemptAt) { report('waiting'); return; }
      attempts += 1; nextAttemptAt = null; report('restarting');
      const previous = child;
      try { await stopOnce(previous); } catch { report('stop-unconfirmed'); attempts = backoffMs.length; return; }
      if (closed || suspended) return;
      detach(); child = null;
      // The old process is confirmed gone. An external listener that claimed
      // the port meanwhile is not ours; do not launch against or terminate it.
      let available = false;
      try { available = await canLaunch(); }
      catch { attempts = backoffMs.length; report('recovery-paused'); return; }
      if (!available) { owned = false; report('external-unavailable'); return; }
      if (closed || suspended) return;
      try { adopt(launch()); }
      catch { child = null; crashSeen = true; }
      failureSince = now(); healthySince = null;
      report('waiting');
    } finally {
      checking = false;
      const delay = nextAttemptAt === null ? intervalMs : Math.min(intervalMs, Math.max(1, nextAttemptAt - now()));
      schedule(delay);
    }
  }
  return {
    start({ process: initial = null, ownsProcess = false } = {}) {
      if (started || closed) throw new Error('Server recovery has already started.');
      started = true; owned = ownsProcess;
      if (owned && initial) adopt(initial);
      schedule(0);
    },
    suspend() {
      suspended = true; failureSince = null; healthySince = null; nextAttemptAt = null;
      if (timer !== null) clearTimer(timer); timer = null;
    },
    resume() {
      if (closed) return;
      suspended = false; failureSince = null; healthySince = null; nextAttemptAt = null;
      deferUntil = now() + unhealthyGraceMs; lastCheckAt = null;
      schedule(0);
    },
    async shutdown() {
      if (!closed) {
        closed = true; if (timer !== null) clearTimer(timer); timer = null; detach();
      }
      if (owned) await stopOnce(child);
    },
    snapshot() { return { state, owned, attempts, closed, suspended }; },
  };
}

// A successful request must identify the application, not Meteor's development
// proxy (which can serve HTML while the application process is dead).
function probeApplicationHealth(http, url, { timeoutMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let done = false; let timer;
    const finish = (value) => { if (done) return; done = true; clearTimer(timer); resolve(value); };
    const request = http.get(url, (response) => {
      let body = ''; let size = 0;
      response.on('error', () => finish(false));
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4096) { finish(false); response.destroy(); request.destroy(); return; }
        body += chunk;
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          finish(response.statusCode === 200 && value.service === 'constellation' && value.status === 'ready');
        } catch { finish(false); }
      });
    });
    request.on('error', () => finish(false));
    timer = setTimer(() => { finish(false); request.destroy(); }, timeoutMs);
    timer.unref?.();
  });
}

// HTTP responsiveness is not port ownership. An existing listener may accept
// TCP and stall before sending headers. Only an explicit refusal proves this
// local port absent; timeouts, permissions, resets and other uncertainty are
// treated as occupied, both at startup and before any replacement launch.
function probeListenerOccupancy(net, address, { timeoutMs = 800, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let done = false; let socket; let timer;
    const finish = (occupied) => {
      if (done) return;
      done = true; clearTimer(timer); socket?.destroy(); resolve(occupied);
    };
    timer = setTimer(() => finish(true), timeoutMs); timer?.unref?.();
    try {
      socket = net.createConnection(address);
      socket.once('connect', () => finish(true));
      socket.once('error', (error) => finish(error?.code !== 'ECONNREFUSED'));
      socket.once('close', () => finish(true));
      socket.unref?.();
    } catch { finish(true); }
  });
}

// Each launched Meteor runner has its own POSIX process group. Kill only that
// recorded group, including the runner's children, never a port/name match.
async function stopOwnedProcess(child, {
  platform = process.platform, kill = process.kill.bind(process),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  graceMs = 8000, forceMs = 5000, pollMs = 100,
} = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
  const group = platform !== 'win32';
  const alive = () => {
    if (!group) return child.exitCode === null && child.signalCode === null;
    try { kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const signal = (name) => {
    try { if (group) kill(-child.pid, name); else child.kill(name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const wait = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += pollMs) { if (!alive()) return true; await sleep(pollMs); }
    return !alive();
  };
  if (!alive()) return;
  signal('SIGTERM');
  if (await wait(graceMs)) return;
  signal('SIGKILL');
  if (!await wait(forceMs)) throw new Error('Owned Meteor process did not stop.');
}

module.exports = { createServerRecovery, probeApplicationHealth, probeListenerOccupancy, stopOwnedProcess };
