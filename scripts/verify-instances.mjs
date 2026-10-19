/*
 * verify-instances.mjs — two real server processes, one database.
 *
 * WHAT IT PROVES
 *   `10thfloor:durable` says any server instance can host a storage, that the
 *   others reach it, and that work survives its host. The package suite shows
 *   that with several hosts inside one process. This script shows it with what
 *   a deployment has: two operating-system processes started from a production
 *   bundle, sharing nothing but MongoDB, and a client on a DDP connection.
 *
 *   In order:
 *     1. both instances boot from the bundle and serve HTTP;
 *     2. a thread made on instance A is hosted by A; a client connected to B
 *        watches an answer arrive there as delta rows and speaks in the thread,
 *        and A still hosts it afterwards: B passed the input on;
 *     3. A is killed (SIGKILL) in the middle of a tool call. B takes the thread
 *        when A's lease runs out and finishes the run; the input is in the
 *        transcript once;
 *     4. with a lease of a minute, the host is told to end (SIGTERM) in the
 *        middle of a tool call. It ends by that signal, and the other instance
 *        has the thread within seconds: a handover, not an expiry.
 *
 * WHAT IT NEEDS
 *   A built bundle with `npm install` done in programs/server (what
 *   verify-build.sh leaves under VERIFY_KEEP_BUNDLE), and Meteor's own Node,
 *   which is how it finds Meteor's own mongod:
 *
 *     meteor node scripts/verify-instances.mjs <bundle directory>
 *
 *   No API key and no network: the app runs with CONSTELLATION_OFFLINE=1, on
 *   its scripted model. Ports are chosen free at run time; the database lives
 *   in a temporary directory that is removed on exit.
 *
 * It talks DDP itself, over Node's WebSocket, so that it depends on nothing
 * the bundle does not carry.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(bundle, 'main.js'))) {
  console.error('usage: meteor node scripts/verify-instances.mjs <bundle directory containing main.js>');
  process.exit(2);
}
const mongod = path.join(path.dirname(process.execPath), '..', 'mongodb', 'bin', 'mongod');
if (!fs.existsSync(mongod)) {
  console.error(`FAIL: no mongod beside this Node (${mongod}). Run this script with "meteor node".`);
  process.exit(2);
}
const driverEntry = path.join(bundle, 'programs', 'server', 'npm', 'node_modules', 'meteor', 'npm-mongo', 'node_modules', 'mongodb');
if (!fs.existsSync(driverEntry)) {
  console.error(`FAIL: the bundle has no Mongo driver at ${driverEntry}. Run "meteor npm install" in programs/server first.`);
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-instances-'));
const children = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`\n=== ${text}`);
const note = (label, value) => console.log(`${label.padEnd(26)}: ${value}`);

class Failure extends Error {}
const check = (condition, message) => {
  if (!condition) throw new Failure(message);
};

async function until(probe, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Failure(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await sleep(50);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const listening = (port) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

function start(name, command, args, options) {
  const log = fs.createWriteStream(path.join(work, `${name}.log`));
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.add(child);
  child.exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    children.delete(child);
    resolve({ code, signal });
  }));
  child.logName = name;
  return child;
}

const logTail = (name, lines = 25) => {
  try {
    return fs.readFileSync(path.join(work, `${name}.log`), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
};

// ── DDP, as much of it as this needs ─────────────────────────────────────────

class Ddp {
  constructor(port) {
    this.port = port;
    this.nextId = 1;
    this.calls = new Map();
    this.subscriptions = new Map();
    /** Collection name → document ID → fields, as the server has published them. */
    this.collections = new Map();
    /** Every `added` message, in order: what went by, not only what is there now. */
    this.added = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${this.port}/websocket`);
      this.socket = socket;
      socket.addEventListener('open', () => socket.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] })));
      socket.addEventListener('error', () => reject(new Failure(`no DDP connection to port ${this.port}`)));
      socket.addEventListener('close', () => {
        for (const { reject: fail } of this.calls.values()) fail(new Failure(`connection to port ${this.port} closed`));
        this.calls.clear();
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        switch (message.msg) {
          case 'connected': resolve(this); break;
          case 'failed': reject(new Failure('DDP version refused')); break;
          case 'ping': socket.send(JSON.stringify({ msg: 'pong', id: message.id })); break;
          case 'result': {
            const pending = this.calls.get(message.id);
            this.calls.delete(message.id);
            if (!pending) break;
            if (message.error) pending.reject(Object.assign(new Error(message.error.reason ?? message.error.message ?? 'method failed'), { error: message.error.error }));
            else pending.resolve(message.result);
            break;
          }
          case 'ready':
            for (const id of message.subs) this.subscriptions.get(id)?.resolve();
            break;
          case 'nosub':
            this.subscriptions.get(message.id)?.reject(new Failure(`subscription refused: ${JSON.stringify(message.error ?? null)}`));
            break;
          case 'added': {
            const documents = this.collection(message.collection);
            documents.set(message.id, { ...(message.fields ?? {}) });
            this.added.push({ collection: message.collection, id: message.id, fields: message.fields ?? {} });
            break;
          }
          case 'changed': {
            const document = this.collection(message.collection).get(message.id);
            if (!document) break;
            Object.assign(document, message.fields ?? {});
            for (const field of message.cleared ?? []) delete document[field];
            break;
          }
          case 'removed':
            this.collection(message.collection).delete(message.id);
            break;
          default:
        }
      });
    });
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  call(method, ...params) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ msg: 'method', method, params, id }));
    });
  }

  subscribe(name, ...params) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.subscriptions.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ msg: 'sub', id, name, params }));
    });
  }

  close() {
    try { this.socket?.close(); } catch { /* already gone */ }
  }
}

const textOf = (message) => {
  if (!message || message.role === 'system') return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).flatMap((part) => (part?.type === 'text' ? [part.text] : [])).join('');
};

/** The transcript a client has been published for one conversation of a storage, oldest first. */
function transcript(client, storage, conversationId = 1) {
  return [...client.collection('pi_durable_entries').values()]
    .filter((row) => row.s === storage && row.c === conversationId)
    .sort((left, right) => left.id - right.id)
    .map((row) => JSON.parse(row.r))
    .filter((entry) => entry.kind !== 'pi.system')
    .map((entry) => {
      const message = entry.model?.[0];
      const calls = (Array.isArray(message?.content) ? message.content : []).filter((part) => part?.type === 'toolCall');
      return { kind: entry.kind, text: textOf(message), calls: calls.map((call) => call.name) };
    });
}

// ── The run ──────────────────────────────────────────────────────────────────

let failed = false;
let mongoClient;

async function cleanup() {
  await mongoClient?.close().catch(() => undefined);
  for (const child of [...children]) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => child.exited));
  fs.rmSync(work, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
}

try {
  step('MongoDB: a one-member replica set of its own');
  const mongoPort = await freePort();
  const dbpath = path.join(work, 'db');
  fs.mkdirSync(dbpath);
  const database = start('mongod', mongod, [
    '--replSet', 'verify', '--port', String(mongoPort), '--dbpath', dbpath, '--bind_ip', '127.0.0.1', '--nounixsocket',
  ]);
  await Promise.race([
    until(() => listening(mongoPort), 'mongod to listen', 60_000),
    database.exited.then(() => { throw new Failure(`mongod exited:\n${logTail('mongod')}`); }),
  ]);
  const { MongoClient } = (await import(pathToFileURL(path.join(driverEntry, 'lib', 'index.js')).href)).default;
  const direct = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`);
  await direct.connect();
  await direct.db('admin').command({ replSetInitiate: { _id: 'verify', members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } });
  await until(async () => (await direct.db('admin').command({ hello: 1 })).isWritablePrimary === true, 'a primary', 60_000);
  await direct.close();
  const mongoUrl = `mongodb://127.0.0.1:${mongoPort}/constellation?replicaSet=verify`;
  mongoClient = new MongoClient(mongoUrl);
  await mongoClient.connect();
  const db = mongoClient.db('constellation');
  const leaseOf = async (storage) => (await db.collection('pi_durable_leases').findOne({ _id: storage }))?.owner;
  note('mongod', `port ${mongoPort}, replica set "verify"`);

  /** One server process from the bundle. `tuning` is the durable package's settings. */
  async function instance(name, tuning) {
    const port = await freePort();
    const child = start(`instance-${name}-${port}`, process.execPath, ['main.js'], {
      cwd: bundle,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
        NODE_ENV: 'production',
        PORT: String(port),
        ROOT_URL: `http://localhost:${port}`,
        MONGO_URL: mongoUrl,
        CONSTELLATION_OFFLINE: '1',
        DURABLE_INSTANCE_ID: name,
        METEOR_SETTINGS: JSON.stringify({ packages: { '10thfloor:durable': tuning } }),
      },
    });
    child.port = port;
    child.instance = name;
    await Promise.race([
      until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/`)).status === 200;
        } catch {
          return false;
        }
      }, `instance ${name} to serve`, 90_000),
      child.exited.then(({ code, signal }) => {
        throw new Failure(`instance ${name} exited (code ${code}, signal ${signal}) before serving:\n${logTail(child.logName)}`);
      }),
    ]);
    return child;
  }

  const username = `verify-${randomBytes(4).toString('hex')}`;
  const password = { digest: createHash('sha256').update(randomBytes(16).toString('hex')).digest('hex'), algorithm: 'sha-256' };
  let token;
  /** A logged-in DDP connection to an instance. The first one makes the account; the rest resume its login. */
  async function client(server) {
    const ddp = await new Ddp(server.port).connect();
    if (token === undefined) {
      ({ token } = await ddp.call('createUser', { username, password }));
      await ddp.call('constellation.bootstrap');
    } else {
      await ddp.call('login', { resume: token });
    }
    return ddp;
  }
  const say = (ddp, threadId, text) => ddp.call('constellation.durableThreadSay', {
    threadId, conversationId: 1, text, requestId: randomBytes(9).toString('hex'),
  });
  const watch = async (ddp, threadId) => {
    await ddp.subscribe('durable.conversation', { host: 'threads', key: threadId, conversationId: 1 });
    return `threads/${threadId}`;
  };
  const answered = (ddp, storage, text, timeoutMs) => until(
    () => transcript(ddp, storage).some((entry) => entry.kind === 'pi.assistant' && entry.text.includes(text)),
    `the answer "${text}"`, timeoutMs,
  );
  const toolStarted = (ddp, storage, tool) => until(
    () => transcript(ddp, storage).some((entry) => entry.kind === 'pi.assistant' && entry.calls.includes(tool)),
    `the call of ${tool}`,
  );

  // A short lease, so that a dead host is replaced within the run; storages stay open while the run looks at them.
  const quick = { leaseMs: 3000, sweepMs: 500, idleMs: 120_000 };

  step('1. Two instances boot from the bundle');
  let a = await instance('a', quick);
  let b = await instance('b', quick);
  note('instance a', `port ${a.port}, pid ${a.pid}`);
  note('instance b', `port ${b.port}, pid ${b.pid}`);

  step('2. A thread hosted by A, watched and spoken to through B');
  let onA = await client(a);
  let onB = await client(b);
  const first = (await onA.call('constellation.durableThreadCreate', 'Two instances')).threadId;
  const storage = await watch(onB, first);
  check(await leaseOf(storage) === 'a', `A made the thread, yet its lease is ${await leaseOf(storage)}'s`);
  await say(onB, first, 'tell me what this is');
  await answered(onB, storage, 'scripted model');
  const deltas = onB.added.filter((row) => row.collection === 'pi_durable_revisions'
    && row.fields.s === storage && row.fields.t === 'delta' && row.fields.k === JSON.stringify('pi.live')).length;
  check(deltas >= 2, `B was published ${deltas} delta rows of the answer; it should have arrived in pieces`);
  check(await leaseOf(storage) === 'a', 'B took the thread over instead of passing the input on');
  note('hosted by', 'a, before and after B spoke');
  note('answer on B', `arrived as ${deltas} delta rows, then the entry`);

  step('3. The host is killed in the middle of a tool call');
  await say(onB, first, 'wait 6');
  await toolStarted(onB, storage, 'wait');
  await sleep(1200);
  const killedAt = Date.now();
  a.kill('SIGKILL');
  note('A exit', JSON.stringify(await a.exited));
  await answered(onB, storage, 'Waited 6 seconds.', 60_000);
  const recovered = Date.now() - killedAt;
  check(await leaseOf(storage) === 'b', `after A died the lease is ${await leaseOf(storage)}'s, not b's`);
  const afterKill = transcript(onB, storage);
  check(afterKill.filter((entry) => entry.kind === 'pi.user' && entry.text === 'wait 6').length === 1, 'the input is in the transcript more than once');
  check(afterKill.filter((entry) => entry.text.includes('Waited 6 seconds.') && entry.kind === 'pi.assistant').length === 1, 'the run was answered more than once');
  note('B finished the run', `${(recovered / 1000).toFixed(1)} s after the kill (lease 3 s, tool 6 s)`);

  step('4. The host is told to end in the middle of a tool call, with a lease of a minute');
  onA.close();
  onB.close();
  b.kill('SIGKILL');
  await b.exited;
  // A lease that could not run out within this run: whatever changes hands here was handed over.
  const patient = { leaseMs: 60_000, sweepMs: 500, idleMs: 120_000, shutdownMs: 5000 };
  a = await instance('a', patient);
  b = await instance('b', patient);
  onA = await client(a);
  onB = await client(b);
  const second = (await onA.call('constellation.durableThreadCreate', 'Told to end')).threadId;
  const handed = await watch(onB, second);
  check(await leaseOf(handed) === 'a', `A made the thread, yet its lease is ${await leaseOf(handed)}'s`);
  await say(onB, second, 'wait 6');
  await toolStarted(onB, handed, 'wait');
  await sleep(1200);
  const toldAt = Date.now();
  a.kill('SIGTERM');
  const ending = await Promise.race([a.exited, sleep(15_000).then(() => null)]);
  check(ending !== null, 'A was told to end and was still running 15 s later');
  check(ending.signal === 'SIGTERM', `A should end by the signal it was sent; it ended with ${JSON.stringify(ending)}`);
  const exitedAfter = Date.now() - toldAt;
  await until(async () => await leaseOf(handed) === 'b', 'B to take the thread', 20_000);
  const takenAfter = Date.now() - toldAt;
  check(takenAfter < 20_000, `B took ${takenAfter} ms: that is the lease running out, not a handover`);
  await answered(onB, handed, 'Waited 6 seconds.', 60_000);
  note('A ended', `by SIGTERM, ${(exitedAfter / 1000).toFixed(1)} s after it was sent`);
  note('B had the thread', `${(takenAfter / 1000).toFixed(1)} s after the signal (lease 60 s)`);
  note('B finished the run', `${((Date.now() - toldAt) / 1000).toFixed(1)} s after the signal`);

  onA.close();
  onB.close();
  step('PASS — two instances from the bundle share threads: routed input, takeover after a kill, handover on SIGTERM');
} catch (error) {
  failed = true;
  console.error(`\nFAIL: ${error instanceof Failure ? error.message : error?.stack ?? error}`);
  for (const name of fs.readdirSync(work).filter((file) => file.startsWith('instance-') && file.endsWith('.log'))) {
    console.error(`\n--- ${name} (last lines)\n${logTail(name.slice(0, -4), 15)}`);
  }
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
