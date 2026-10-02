// TEMPORARY, NOT FOR MERGE. A flight recorder for one question: what are the
// CI runner and MongoDB doing while 10thfloor:agent's contended commit test
// stalls? It prints one line a second for the whole server run, and for the
// one test it watches: what MongoDB has in progress, what the driver's
// commands cost, and what mongod logged.
//
// It changes nothing the tests can see. Every probe action is wrapped: a
// failure here prints a line and never fails a test.
import { MongoInternals } from 'meteor/mongo';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as os from 'node:os';

const TARGET = /concurrent distinct commits/;
const LINUX = process.platform === 'linux';
const say = (line: string) => console.log(`[probe] ${line}`);
const clock = (at = Date.now()) => new Date(at).toISOString().slice(11, 23);
const read = (path: string): string | null => {
  try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
};
const num = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value ?? 0);
};

// ---- parsers for /proc, exported for the plain-Node check ------------------

export function parseCpu(stat: string) {
  const fields = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields;
  return { busy: user + nice + system + irq + softirq, user: user + nice, system: system + irq + softirq, idle, iowait, steal, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

export function parsePressure(text: string | null) {
  const out: Record<string, number> = {};
  for (const line of (text ?? '').split('\n')) {
    const kind = line.split(' ')[0];
    const total = /total=(\d+)/.exec(line);
    if (kind && total) out[kind] = Number(total[1]);
  }
  return out;
}

export function parseDisks(text: string) {
  const sum = { writes: 0, sectors: 0, writeMs: 0, inFlight: 0, ioMs: 0, flushes: 0, flushMs: 0 };
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(f[2] ?? '')) continue;
    sum.writes += Number(f[7]); sum.sectors += Number(f[9]); sum.writeMs += Number(f[10]);
    sum.inFlight += Number(f[11]); sum.ioMs += Number(f[12]);
    sum.flushes += Number(f[18] ?? 0); sum.flushMs += Number(f[19] ?? 0);
  }
  return sum;
}

export function parseMem(text: string) {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  return { dirtyMb: kb('Dirty') / 1024, writebackMb: kb('Writeback') / 1024, freeMb: kb('MemAvailable') / 1024 };
}

export function parseProcStat(text: string) {
  // "pid (comm with spaces) state ppid ... utime stime": comm may hold parens.
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const rest = text.slice(close + 2).split(' ');
  return { pid: Number(text.slice(0, open - 1)), comm: text.slice(open + 1, close), ticks: Number(rest[11]) + Number(rest[12]), startTicks: Number(rest[19]) };
}

function processTicks() {
  const out = new Map<number, { comm: string; ticks: number }>();
  let names: string[] = [];
  try { names = fs.readdirSync('/proc'); } catch { return out; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const parsed = parseProcStat(read(`/proc/${name}/stat`) ?? '');
    if (parsed) out.set(parsed.pid, { comm: parsed.comm, ticks: parsed.ticks });
  }
  return out;
}

// ---- MongoDB ---------------------------------------------------------------

const { MongoClient } = (MongoInternals as any).NpmModules.mongodb.module;
const appClient = (MongoInternals as any).defaultRemoteCollectionDriver().mongo.client;
// A client of its own: what the probe asks must not queue behind the tests.
const probeClient = new MongoClient(process.env.MONGO_URL, { maxPoolSize: 5, appName: 'ci-probe' });
const admin = probeClient.db('admin');

// A canary: four times a second, one acknowledged write and one two-statement
// transaction on a collection nothing else touches. If MongoDB itself stalls,
// these stall too, whatever the tests are doing at that moment.
const canary = probeClient.db('ci_probe').collection('canary');
const canaryState = { write: 0, txn: 0, errors: 0, inFlightSince: 0, last: '' };
async function canaryOnce() {
  if (canaryState.inFlightSince) return;
  canaryState.inFlightSince = performance.now();
  try {
    let at = performance.now();
    await canary.updateOne({ _id: 'w' }, { $inc: { n: 1 } });
    canaryState.write = Math.max(canaryState.write, performance.now() - at);
    at = performance.now();
    const session = probeClient.startSession();
    try {
      await session.withTransaction(async () => {
        await canary.updateOne({ _id: 't' }, { $inc: { n: 1 } }, { session });
        await canary.updateOne({ _id: 'u' }, { $inc: { n: 1 } }, { session });
      });
    } finally {
      await session.endSession();
    }
    canaryState.txn = Math.max(canaryState.txn, performance.now() - at);
  } catch (error) {
    canaryState.errors += 1;
    canaryState.last = String((error as Error)?.message).slice(0, 80);
  } finally {
    canaryState.inFlightSince = 0;
  }
}
function canaryLine() {
  const stuck = canaryState.inFlightSince ? performance.now() - canaryState.inFlightSince : 0;
  const line = `canary write=${canaryState.write.toFixed(0)}ms txn=${canaryState.txn.toFixed(0)}ms${stuck > 300 ? ` IN-FLIGHT ${stuck.toFixed(0)}ms` : ''}${canaryState.errors ? ` errors=${canaryState.errors} (${canaryState.last})` : ''}`;
  canaryState.write = 0; canaryState.txn = 0; canaryState.errors = 0;
  return line;
}

type Status = Record<string, any>;
function pick(status: Status) {
  const wt = status.wiredTiger ?? {};
  const tickets = wt.concurrentTransactions ?? status.queues?.execution ?? {};
  const lat = status.opLatencies ?? {};
  const cmd = status.metrics?.commands ?? {};
  return {
    uptimeMs: num(status.uptimeMillis),
    syncs: num(wt.log?.['log sync operations']),
    syncUs: num(wt.log?.['log sync time duration (usecs)']),
    logBytes: num(wt.log?.['log bytes written']),
    ckptRunning: num(wt.transaction?.['transaction checkpoint currently running']) || num(wt.checkpoint?.['checkpoint currently running'] ?? 0),
    ckpts: num(wt.transaction?.['transaction checkpoints']) || num(wt.checkpoint?.checkpoints ?? 0),
    dirtyCacheMb: num(wt.cache?.['tracked dirty bytes in the cache']) / 1048576,
    wOut: num(tickets.write?.out), wTotal: num(tickets.write?.totalTickets), wQueue: num(tickets.write?.queueLength),
    wCanceled: num(tickets.write?.canceled), wQueuedUs: num(tickets.write?.totalTimeQueuedMicros),
    rOut: num(tickets.read?.out), rTotal: num(tickets.read?.totalTickets),
    started: num(status.transactions?.totalStarted), aborted: num(status.transactions?.totalAborted), committed: num(status.transactions?.totalCommitted),
    open: num(status.transactions?.currentOpen), active: num(status.transactions?.currentActive),
    conflicts: num(status.metrics?.operation?.writeConflicts),
    wLat: num(lat.writes?.latency), wOps: num(lat.writes?.ops),
    cLat: num(lat.commands?.latency), cOps: num(lat.commands?.ops),
    tLat: num(lat.transactions?.latency), tOps: num(lat.transactions?.ops),
    updates: num(cmd.update?.total), updateFails: num(cmd.update?.failed),
    aborts: num(cmd.abortTransaction?.total), commits: num(cmd.commitTransaction?.total),
    conns: num(status.connections?.current),
    lagged: status.flowControl?.isLagged ? 1 : 0, flowUs: num(status.flowControl?.timeAcquiringMicros),
    queueW: num(status.globalLock?.currentQueue?.writers), queueR: num(status.globalLock?.currentQueue?.readers),
  };
}
type Picked = ReturnType<typeof pick>;

async function serverStatus(): Promise<{ picked: Picked; ms: number } | null> {
  const started = performance.now();
  try {
    const status = await admin.command({ serverStatus: 1, repl: 0, metrics: 1, locks: 0, tcmalloc: 0, network: 0 });
    return { picked: pick(status), ms: performance.now() - started };
  } catch (error) {
    say(`serverStatus failed after ${(performance.now() - started).toFixed(0)} ms: ${(error as Error)?.message}`);
    return null;
  }
}

const per = (total: number, count: number) => (count > 0 ? total / count : 0);
function mongoLine(now: Picked, was: Picked, ms: number) {
  const d = <K extends keyof Picked>(key: K) => now[key] - was[key];
  return [
    `rt=${ms.toFixed(0)}ms`,
    `up=${(now.uptimeMs / 1000).toFixed(1)}s`,
    `sync=${d('syncs')}x${per(d('syncUs') / 1000, d('syncs')).toFixed(1)}ms`,
    `log=${(d('logBytes') / 1024).toFixed(0)}KB`,
    `ckpt=${now.ckptRunning ? 'RUNNING' : now.ckpts}`,
    `cacheDirty=${now.dirtyCacheMb.toFixed(0)}MB`,
    `tickets w=${now.wOut}/${now.wTotal} q=${now.wQueue} canceled+${d('wCanceled')} queued+${(d('wQueuedUs') / 1000).toFixed(0)}ms r=${now.rOut}/${now.rTotal}`,
    `txn +${d('started')} aborted+${d('aborted')} committed+${d('committed')} open=${now.open}`,
    `wc+${d('conflicts')}`,
    `cmds upd+${d('updates')}(fail+${d('updateFails')}) abort+${d('aborts')} commit+${d('commits')}`,
    `lat w=${per(d('wLat') / 1000, d('wOps')).toFixed(1)}ms(${d('wOps')}) c=${per(d('cLat') / 1000, d('cOps')).toFixed(1)}ms(${d('cOps')}) t=${per(d('tLat') / 1000, d('tOps')).toFixed(1)}ms(${d('tOps')})`,
    `lockq w=${now.queueW} r=${now.queueR}`,
    now.lagged ? 'FLOWCONTROL-LAGGED' : `flow+${(d('flowUs') / 1000).toFixed(0)}ms`,
    `conns=${now.conns}`,
  ].join(' ');
}

// ---- the once-a-second line -------------------------------------------------

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let lastCpu = LINUX ? parseCpu(read('/proc/stat') ?? '') : null;
let lastPsi = LINUX ? { cpu: parsePressure(read('/proc/pressure/cpu')), io: parsePressure(read('/proc/pressure/io')), memory: parsePressure(read('/proc/pressure/memory')) } : null;
let lastDisks = LINUX ? parseDisks(read('/proc/diskstats') ?? '') : null;
let lastTicks = LINUX ? processTicks() : null;
let lastNode = process.cpuUsage();
let lastAt = performance.now();
let lastMongo: Picked | null = null;
let started = Date.now();
let ticking = false;

function machineLine(seconds: number) {
  const parts: string[] = [];
  const node = process.cpuUsage();
  parts.push(`lag=${(loop.max / 1e6).toFixed(0)}ms`);
  loop.reset();
  parts.push(`node=${(((node.user - lastNode.user) + (node.system - lastNode.system)) / 1e4 / seconds).toFixed(0)}%`);
  lastNode = node;
  if (!LINUX) return parts.join(' ');
  const cpu = parseCpu(read('/proc/stat') ?? '');
  if (lastCpu) {
    const total = Math.max(cpu.total - lastCpu.total, 1);
    const pct = (key: 'user' | 'system' | 'iowait' | 'steal' | 'idle') => (((cpu[key] - lastCpu![key]) / total) * 100).toFixed(0);
    parts.push(`cpu us=${pct('user')} sy=${pct('system')} io=${pct('iowait')} st=${pct('steal')} idle=${pct('idle')}`);
  }
  lastCpu = cpu;
  const psi = { cpu: parsePressure(read('/proc/pressure/cpu')), io: parsePressure(read('/proc/pressure/io')), memory: parsePressure(read('/proc/pressure/memory')) };
  if (lastPsi) {
    const pct = (kind: 'cpu' | 'io' | 'memory', key: string) => ((((psi[kind][key] ?? 0) - (lastPsi![kind][key] ?? 0)) / (seconds * 1e6)) * 100).toFixed(0);
    parts.push(`psi cpu=${pct('cpu', 'some')} io=${pct('io', 'some')}/${pct('io', 'full')} mem=${pct('memory', 'some')}`);
  }
  lastPsi = psi;
  const mem = parseMem(read('/proc/meminfo') ?? '');
  parts.push(`dirty=${mem.dirtyMb.toFixed(0)}MB wb=${mem.writebackMb.toFixed(0)}MB avail=${mem.freeMb.toFixed(0)}MB`);
  const disks = parseDisks(read('/proc/diskstats') ?? '');
  if (lastDisks) {
    const d = (key: keyof typeof disks) => disks[key] - lastDisks![key];
    parts.push(`disk w=${d('writes')}/${(d('sectors') / 2048).toFixed(1)}MB wait=${per(d('writeMs'), d('writes')).toFixed(1)}ms util=${((d('ioMs') / (seconds * 1000)) * 100).toFixed(0)}% inflight=${disks.inFlight} flush=${d('flushes')}x${per(d('flushMs'), d('flushes')).toFixed(1)}ms`);
  }
  lastDisks = disks;
  const ticks = processTicks();
  if (lastTicks) {
    const top = [...ticks].map(([pid, now]) => ({ pid, comm: now.comm, pct: now.ticks - (lastTicks!.get(pid)?.ticks ?? now.ticks) }))
      .filter((row) => row.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 5)
      .map((row) => `${row.comm}:${(row.pct / seconds).toFixed(0)}%`);
    parts.push(`top=${top.join(',') || '-'}`);
  }
  lastTicks = ticks;
  parts.push(`load=${(read('/proc/loadavg') ?? '').split(' ').slice(0, 1).join('')}`);
  return parts.join(' ');
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = performance.now();
    const seconds = Math.max((now - lastAt) / 1000, 0.001);
    lastAt = now;
    const machine = machineLine(seconds);
    const status = await serverStatus();
    const mongo = status && lastMongo ? mongoLine(status.picked, lastMongo, status.ms) : status ? `rt=${status.ms.toFixed(0)}ms up=${(status.picked.uptimeMs / 1000).toFixed(1)}s (first sample)` : 'no status';
    if (status) lastMongo = status.picked;
    say(`${clock()} +${((Date.now() - started) / 1000).toFixed(1)}s ${watching ? 'TARGET ' : ''}${machine} | ${canaryLine()} | mongo ${mongo}`);
  } catch (error) {
    say(`tick failed: ${(error as Error)?.message}`);
  } finally {
    ticking = false;
  }
}

// ---- the watched test --------------------------------------------------------

let watching: { title: string; startedAt: number; began: number; timer: ReturnType<typeof setInterval>; commands: Map<string, { n: number; ms: number; max: number }> } | null = null;

const pools = (): any[] => {
  try { return [...(appClient.topology?.s?.servers ?? new Map()).values()].map((server: any) => server.pool); } catch { return []; }
};

function poolLine() {
  try {
    return pools().map((pool) => `total=${pool.totalConnectionCount} idle=${pool.availableConnectionCount} pending=${pool.pendingConnectionCount} out=${pool.currentCheckedOutCount} waiting=${pool.waitQueueSize}`).join('; ');
  } catch (error) {
    return `pool unreadable: ${(error as Error)?.message}`;
  }
}

// Command monitoring is fixed when a connection is made. Switch it on for the
// app's own connections, idle and in use, so the listeners below hear them;
// a connection made later is caught as it is checked out.
function arm(on: boolean) {
  for (const pool of pools()) {
    try {
      for (const connection of pool.connections ?? []) connection.monitorCommands = on;
      for (const connection of pool.checkedOut ?? []) connection.monitorCommands = on;
    } catch { /* the probe never fails a test */ }
  }
}
const armOnCheckout = () => arm(true);

const onSucceeded = (event: any) => record(event.commandName, 'ok', event.duration);
const onFailed = (event: any) => record(event.commandName, event.failure?.codeName ?? event.failure?.name ?? 'failed', event.duration);
function record(name: string, outcome: string, ms: number) {
  // A command that began before its connection was armed has no start time.
  if (!watching || !(ms >= 0 && ms < 600_000) || name === 'getMore' || name === 'hello') return;
  const key = `${name} ${outcome}`;
  const entry = watching.commands.get(key) ?? { n: 0, ms: 0, max: 0 };
  entry.n += 1; entry.ms += ms; entry.max = Math.max(entry.max, ms);
  watching.commands.set(key, entry);
}

let samples = 0;
async function inProgress() {
  const watched = watching;
  if (!watched) return;
  const at = performance.now();
  try {
    const { inprog } = await admin.command({ currentOp: 1, active: true });
    const ops = (inprog as any[]).filter((op) => op.appName !== 'ci-probe' && op.ns !== 'local.oplog.rs' && !/^(hello|isMaster|getMore)$/.test(Object.keys(op.command ?? {})[0] ?? ''));
    const waiting = ops.filter((op) => op.waitingForLock).length;
    const flow = ops.filter((op) => op.waitingForFlowControl).length;
    const slow = ops.filter((op) => num(op.microsecs_running) >= 30_000).sort((a, b) => num(b.microsecs_running) - num(a.microsecs_running)).slice(0, 5)
      .map((op) => {
        const name = Object.keys(op.command ?? {})[0] ?? op.op;
        const txn = op.transaction ? ` txn(active=${(num(op.transaction.timeActiveMicros) / 1000).toFixed(0)}ms idle=${(num(op.transaction.timeInactiveMicros) / 1000).toFixed(0)}ms)` : '';
        const wait = op.waitingForLock ? ' WAITING-FOR-LOCK' : op.waitingForFlowControl ? ' WAITING-FOR-FLOW-CONTROL' : '';
        const latch = op.waitingForLatch ? ` latch=${JSON.stringify(op.waitingForLatch).slice(0, 80)}` : '';
        const ticket = op.admissionPriority || op.queues ? ` ${JSON.stringify(op.queues ?? op.admissionPriority).slice(0, 120)}` : '';
        return `${name}@${op.ns ?? '?'} ${(num(op.microsecs_running) / 1000).toFixed(0)}ms${wait}${txn}${latch}${ticket}${op.msg ? ` msg=${String(op.msg).slice(0, 40)}` : ''} yields=${num(op.numYields)}${op.writeConflicts ? ` wc=${num(op.writeConflicts)}` : ''}`;
      });
    samples += 1;
    const pool = poolLine();
    // Say it when there is something to say, and once a second regardless.
    if (slow.length || waiting || flow || !/waiting=0/.test(pool) || samples % 4 === 0) {
      say(`${clock()} TARGET t+${((performance.now() - watched.began) / 1000).toFixed(2)}s currentOp(${(performance.now() - at).toFixed(0)}ms): active=${ops.length} lock-waiters=${waiting} flow-waiters=${flow}${slow.length ? ` | ${slow.join(' || ')}` : ''} | pool ${pool}`);
    }
  } catch (error) {
    say(`currentOp failed: ${(error as Error)?.message}`);
  }
}

async function mongodLog(sinceMs: number, untilMs: number) {
  try {
    const { log, totalLinesWritten } = await admin.command({ getLog: 'global' });
    const rows: string[] = [];
    let slow = 0;
    let other = 0;
    const byError = new Map<string, number>();
    // Routine lines of a busy test server: collections and indexes being made.
    const routine = new Set([20320, 20345, 20438, 20663, 7360101, 7360103, 3856203, 20384, 4718706, 5324200]);
    for (const line of log as string[]) {
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const at = Date.parse(entry.t?.$date ?? '');
      if (!(at >= sinceMs - 500 && at <= untilMs + 500)) continue;
      const attr = entry.attr ?? {};
      if (attr.appName === 'ci-probe') continue;
      if (entry.msg === 'Slow query') {
        slow += 1;
        const name = Object.keys(attr.command ?? {})[0] ?? attr.type;
        const key = `${name} ${attr.errName ?? 'ok'}`;
        byError.set(key, (byError.get(key) ?? 0) + 1);
        if (rows.length < 45) {
          const extra = Object.entries({
            wcWait: attr.waitForWriteConcernDurationMillis, queued: attr.queues ?? attr.totalTimeQueuedMicros, storage: attr.storage,
            locks: attr.locks && JSON.stringify(attr.locks).includes('timeAcquiringMicros') ? attr.locks : undefined,
            flow: attr.flowControl?.timeAcquiringMicros, wc: attr.writeConflicts, yields: attr.numYields, remoteOpWait: attr.remoteOpWaitMillis,
            cpuNanos: attr.cpuNanos, workingMillis: attr.workingMillis, txn: attr.parameters?.txnNumber ? 'y' : undefined,
          }).filter(([, value]) => value !== undefined && value !== 0).map(([key2, value]) => `${key2}=${JSON.stringify(value)}`).join(' ').slice(0, 330);
          rows.push(`${clock(at)} slow ${name}@${attr.ns ?? ''} ${attr.durationMillis}ms ${attr.errName ?? 'ok'} ${extra}`);
        }
      } else if (entry.c !== 'NETWORK' && entry.c !== 'ACCESS' && entry.c !== 'CONNPOOL' && entry.c !== 'INDEX' && entry.c !== '-' && !routine.has(entry.id)) {
        other += 1;
        if (other <= 40) rows.push(`${clock(at)} ${entry.c} ${entry.id} ${entry.msg} ${JSON.stringify(attr).slice(0, 260)}`);
      }
    }
    say(`mongod log, ${clock(sinceMs - 500)} to ${clock(untilMs + 500)}: ${slow} slow operations (${[...byError].map(([key, n]) => `${key} x${n}`).join(', ') || 'none'}), ${other} other lines; ${totalLinesWritten} lines written in all`);
    for (const row of rows) say(`  ${row}`);
  } catch (error) {
    say(`getLog failed: ${(error as Error)?.message}`);
  }
}

// meteortesting:mocha-core calls a hook with the hook itself as `this`, not
// mocha's context; the test it runs for is on the hook's context.
const testOf = (hook: any) => hook?.ctx?.currentTest ?? hook?.currentTest ?? null;

beforeEach(function probeBefore(this: any) {
  const title = testOf(this)?.fullTitle() ?? '';
  if (!TARGET.test(title)) return;
  try {
    appClient.on('commandSucceeded', onSucceeded);
    appClient.on('commandFailed', onFailed);
    for (const pool of pools()) pool.on('connectionCheckedOut', armOnCheckout);
    arm(true);
    watching = {
      title, startedAt: Date.now(), began: performance.now(), commands: new Map(),
      timer: setInterval(() => { void inProgress(); }, 250),
    };
    say(`${clock()} TARGET begins: "${title}" | mongod up ${lastMongo ? (lastMongo.uptimeMs / 1000).toFixed(1) : '?'}s at last sample | pool ${poolLine()}`);
    void tick();
  } catch (error) {
    say(`could not start watching: ${(error as Error)?.message}`);
  }
});

afterEach(async function probeAfter(this: any) {
  this.timeout(60_000);
  const test = testOf(this);
  if (!watching || !TARGET.test(test?.fullTitle() ?? '')) return;
  const watched = watching;
  const elapsed = performance.now() - watched.began;
  say(`${clock()} TARGET ended after ${elapsed.toFixed(0)} ms, state=${test?.state ?? 'unknown'}${test?.err ? ` error=${String(test.err.message).slice(0, 160)}` : ''}`);
  // A failed run leaves its commits retrying behind it: keep watching for
  // eight seconds more.
  if (test?.state !== 'passed' || process.env.PROBE_FORCE_AFTERMATH === '1') {
    const until = performance.now() + 8000;
    while (performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    say(`${clock()} TARGET: stopped watching ${((performance.now() - watched.began) / 1000).toFixed(1)} s after it began`);
  }
  clearInterval(watched.timer);
  watching = null;
  try {
    for (const pool of pools()) pool.off('connectionCheckedOut', armOnCheckout);
    arm(false);
    appClient.off('commandSucceeded', onSucceeded);
    appClient.off('commandFailed', onFailed);
  } catch { /* nothing to restore */ }
  const commands = [...watched.commands].sort((a, b) => b[1].ms - a[1].ms)
    .map(([key, entry]) => `${key}: n=${entry.n} avg=${(entry.ms / entry.n).toFixed(1)}ms max=${entry.max.toFixed(0)}ms total=${entry.ms.toFixed(0)}ms`);
  say(`driver commands during the target: ${commands.length ? `${[...watched.commands.values()].reduce((sum, entry) => sum + entry.n, 0)} heard` : 'none heard'}`);
  for (const line of commands) say(`  ${line}`);
  await mongodLog(watched.startedAt, Date.now());
});

// ---- start -------------------------------------------------------------------

(async () => {
  try {
    await probeClient.connect();
    const [host, build, params, opts] = await Promise.all([
      admin.command({ hostInfo: 1 }).catch(() => null),
      admin.command({ buildInfo: 1 }).catch(() => null),
      admin.command({ getParameter: 1, storageEngineConcurrencyAdjustmentAlgorithm: 1, throughputProbingInitialConcurrency: 1, maxTransactionLockRequestTimeoutMillis: 1, storageEngineConcurrentWriteTransactions: 1 }).catch(() => null),
      admin.command({ getCmdLineOpts: 1 }).catch(() => null),
    ]);
    const status = await serverStatus();
    started = Date.now();
    say(`machine: ${os.cpus().length} cpus (${os.cpus()[0]?.model}), ${(os.totalmem() / 2 ** 30).toFixed(1)} GB, ${os.platform()} ${os.release()}, node ${process.version}, pid ${process.pid}`);
    say(`mongod: ${build?.version} sees ${host?.system?.numCores} cores, ${host?.system?.memSizeMB} MB; args ${JSON.stringify(opts?.argv)}; ${JSON.stringify({ algorithm: params?.storageEngineConcurrencyAdjustmentAlgorithm, initial: params?.throughputProbingInitialConcurrency, lockTimeoutMs: params?.maxTransactionLockRequestTimeoutMillis })}; up ${status ? (status.picked.uptimeMs / 1000).toFixed(1) : '?'} s; tickets w=${status?.picked.wTotal} r=${status?.picked.rTotal}`);
    if (LINUX) {
      const dbPath = String(opts?.parsed?.storage?.dbPath ?? '');
      const mounts = (read('/proc/mounts') ?? '').split('\n').map((line) => line.split(' ')).filter((f) => f[1] && dbPath.startsWith(f[1])).sort((a, b) => b[1].length - a[1].length)[0];
      say(`disk: dbPath ${dbPath} on ${mounts ? `${mounts[0]} ${mounts[2]} (${mounts[3]})` : 'unknown mount'}`);
      const sysctl = (name: string) => (read(`/proc/sys/vm/${name}`) ?? '?').trim();
      say(`kernel: dirty_expire=${sysctl('dirty_expire_centisecs')}cs dirty_writeback=${sysctl('dirty_writeback_centisecs')}cs dirty_ratio=${sysctl('dirty_ratio')} dirty_background_ratio=${sysctl('dirty_background_ratio')} thp=${(read('/sys/kernel/mm/transparent_hugepage/enabled') ?? '?').trim()}`);
      const parent = Number(process.env.METEOR_PARENT_PID ?? 0);
      const hertz = 100;
      const boot = Number(/btime (\d+)/.exec(read('/proc/stat') ?? '')?.[1] ?? 0);
      for (const [label, pid] of [['meteor tool', parent], ['this server', process.pid]] as const) {
        const stat = pid ? parseProcStat(read(`/proc/${pid}/stat`) ?? '') : null;
        if (stat && boot) say(`${label} (pid ${pid}, ${stat.comm}) started ${clock((boot + stat.startTicks / hertz) * 1000)}`);
      }
    }
    if (status) lastMongo = status.picked;
    for (const _id of ['w', 't', 'u']) await canary.updateOne({ _id }, { $set: { n: 0 } }, { upsert: true });
    const timer = setInterval(() => { void tick(); }, 1000);
    (timer as any).unref?.();
    const canaryTimer = setInterval(() => { void canaryOnce(); }, 250);
    (canaryTimer as any).unref?.();
  } catch (error) {
    say(`probe could not start: ${(error as Error)?.stack ?? error}`);
  }
})();
