import { assert } from 'chai';
import { MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { DurableHost, MongoStorage, OPERATIONS } from 'meteor/10thfloor:durable';
import { AGENT, hang, harnessOptions, loadPieces, type Pieces, type Slow, textOf, until } from './support';

// Several server instances on one database: who runs a storage, how work
// reaches it, and what happens when the instance running it stops, dies, or
// loses a commit. Each `DurableHost` here stands for one instance. They share
// nothing but Mongo, which is all that real instances share. (The same cases
// with a second operating-system process, killed with SIGKILL in the middle
// of a tool call, were run under plain Node while this file was written.)

type HostOptions = { slow?: Slow; errors?: unknown[]; client?: any } & Record<string, any>;

describe('DurableHost', function () {
  this.timeout(60_000);

  let pieces: Pieces;
  let mongo: { client: any; db: any };
  const started: DurableHost[] = [];
  const scenes: string[] = [];

  /** Keys and instance names of one test, so that hosts of other tests, and the package's own, never touch them. */
  function scene() {
    const prefix = `${Random.id(8)}/`;
    scenes.push(`${prefix}mission`);
    const host = (name: string, options: HostOptions = {}) => {
      const { slow, errors, client, ...rest } = options;
      const made = new DurableHost({
        client: client ?? mongo.client,
        db: mongo.db,
        runtime: { apply: pieces.apply, StorageRejected: pieces.durable.StorageRejected },
        Harness: pieces.durable.Harness,
        context: pieces.context,
        instanceId: `${prefix}${name}`,
        accepts: (key) => key.startsWith(prefix),
        harness: () => harnessOptions(pieces, { slow }) as any,
        operations: () => OPERATIONS,
        leaseMs: 900,
        heartbeatMs: 150,
        sweepMs: 100,
        idleMs: 200,
        requestMs: 4000,
        onError: (error, where) => errors?.push({ where, error }),
        ...rest,
      });
      started.push(made);
      return made;
    };
    return { prefix, key: `${prefix}mission`, host };
  }

  /** The root conversation's transcript as any instance reads it, oldest first, without the system prompt entries. */
  async function transcript(host: DurableHost, key: string): Promise<string[]> {
    const reader = await host.reader(key);
    const page = await reader.scanEntries({ conversationId: 1 as never }, 100, undefined, pieces.context);
    return [...page.items]
      .reverse()
      .filter((entry) => entry.kind !== 'pi.system')
      .map((entry) => `${entry.kind}:${textOf(entry.model?.[0])}`);
  }

  async function say(host: DurableHost, key: string, content: string): Promise<number> {
    const { conversationId } = await host.call<{ conversationId: number }>(key, 'root', { agent: AGENT });
    return (await host.call<{ submissionId: number }>(key, 'submit', { conversationId, draft: { type: 'input', content } })).submissionId;
  }

  const done = async (host: DurableHost, key: string, id: number, timeoutMs = 8000) =>
    assert.strictEqual((await host.settled(key, id as never, { timeoutMs })).status, 'done');

  const rejection = (work: Promise<unknown>): Promise<any> => work.then(() => undefined, (error) => error);

  before(async function () {
    pieces = await loadPieces();
    mongo = (MongoInternals.defaultRemoteCollectionDriver() as any).mongo;
  });

  afterEach(async function () {
    for (const host of started.splice(0)) await host.stop().catch(() => undefined);
    // Leave nothing of this run in the test database.
    for (const key of scenes.splice(0)) {
      await MongoStorage.destroy({ ...mongo, key });
      await mongo.db.collection('pi_durable_leases').deleteOne({ _id: key });
      await mongo.db.collection('pi_durable_requests').deleteMany({ s: key });
    }
  });

  it('hosts a storage on first use, answers, and lets it go when it has been idle', async function () {
    const { key, host } = scene();
    const a = host('a');
    await a.start();

    const first = await say(a, key, 'hello');
    assert.deepEqual(a.hosted(), [key]);
    assert.strictEqual(await a.owner(key), a.instanceId);
    await done(a, key, first);
    assert.deepEqual(await transcript(a, key), ['pi.user:hello', 'pi.assistant:echo: hello']);

    // Idle: closed, and the lease given up rather than left to run out.
    await until(() => a.hosted().length === 0);
    await until(async () => (await mongo.db.collection('pi_durable_leases').findOne({ _id: key })) === null, 2000);
    assert.isUndefined(await a.owner(key));

    // The next call opens it again, with everything it had.
    await done(a, key, await say(a, key, 'again'));
    assert.deepEqual(await transcript(a, key), [
      'pi.user:hello', 'pi.assistant:echo: hello', 'pi.user:again', 'pi.assistant:echo: again',
    ]);
  });

  it('sends a call to the instance that hosts the storage, and reads from any instance', async function () {
    const { key, host } = scene();
    // Long idle time: the storage stays with `a` for the whole test.
    const a = host('a', { idleMs: 60_000 });
    const b = host('b', { idleMs: 60_000 });
    await a.start();
    await b.start();
    await say(a, key, 'from a');

    const viaB = await say(b, key, 'from b');
    assert.deepEqual(b.hosted(), []);
    assert.deepEqual(a.hosted(), [key]);
    assert.strictEqual(await b.owner(key), a.instanceId);
    // `b` waits for the answer and reads the transcript without the harness.
    await done(b, key, viaB);
    assert.deepEqual(await transcript(b, key), [
      'pi.user:from a', 'pi.assistant:echo: from a', 'pi.user:from b', 'pi.assistant:echo: from b',
    ]);

    // The harness itself cannot cross processes.
    const refused = await rejection(b.with(key, () => 'unreachable'));
    assert.strictEqual(refused?.name, 'HostedElsewhere');
    assert.strictEqual(refused?.owner, a.instanceId);
    assert.strictEqual(await a.with(key, async (harness: any) => (await harness.root(pieces.context)).id), 1);

    // An operation's own error comes back as it was thrown.
    const missing = await rejection(b.call(key, 'submit', { conversationId: 999, draft: { type: 'input', content: 'nobody' } }));
    assert.strictEqual(missing?.name, 'ConversationNotFound');
  });

  it('takes keys and instance names that begin with a dollar sign as names', async function () {
    // Leases and requests are written with update pipelines, where an unquoted "$name" is a field path.
    const prefix = `$${Random.id(8)}/`;
    const key = `${prefix}$mission`;
    scenes.push(key);
    const make = (name: string) => {
      const made = new DurableHost({
        ...mongo,
        runtime: { apply: pieces.apply, StorageRejected: pieces.durable.StorageRejected },
        Harness: pieces.durable.Harness,
        context: pieces.context,
        instanceId: `${prefix}${name}`,
        accepts: (candidate) => candidate.startsWith(prefix),
        harness: () => harnessOptions(pieces) as any,
        operations: () => OPERATIONS,
        leaseMs: 900,
        heartbeatMs: 150,
        sweepMs: 100,
        idleMs: 60_000,
        requestMs: 4000,
      });
      started.push(made);
      return made;
    };
    const a = make('$a');
    const b = make('$b');
    await a.start();
    await b.start();
    await say(a, key, '$first');
    assert.strictEqual(await b.owner(key), a.instanceId);
    const viaB = await say(b, key, '$second');
    assert.deepEqual(b.hosted(), []);
    await done(b, key, viaB);
    assert.deepEqual(await transcript(b, key), [
      'pi.user:$first', 'pi.assistant:echo: $first', 'pi.user:$second', 'pi.assistant:echo: $second',
    ]);
  });

  it('admits a request once however often it is asked, from whichever instance', async function () {
    const { key, host } = scene();
    const a = host('a', { idleMs: 60_000 });
    const b = host('b', { idleMs: 60_000 });
    await a.start();
    await b.start();
    await a.call(key, 'root', { agent: AGENT });

    const draft = { type: 'input', content: 'only once', requestId: 'client-message-1' };
    const ids = await Promise.all([
      b.call<{ submissionId: number }>(key, 'submit', { conversationId: 1, draft }),
      b.call<{ submissionId: number }>(key, 'submit', { conversationId: 1, draft }),
      a.call<{ submissionId: number }>(key, 'submit', { conversationId: 1, draft }),
    ]);
    assert.strictEqual(new Set(ids.map((result) => result.submissionId)).size, 1);
    const settled = await a.settled(key, ids[0].submissionId as never, { timeoutMs: 5000 });
    assert.strictEqual(settled.status, 'done');
    assert.strictEqual(settled.requestId, 'client-message-1');
    assert.deepEqual(await transcript(a, key), ['pi.user:only once', 'pi.assistant:echo: only once']);
  });

  it('takes over a storage whose host stopped answering, and finishes its work', async function () {
    const { key, host } = scene();
    let reached!: () => void;
    const inTool = new Promise<void>((resolve) => { reached = resolve; });
    const a = host('a', { slow: (_job, signal) => { reached(); return hang(signal); } });
    // Long idle time: once `b` has the storage, it still has it when the test looks.
    const b = host('b', { idleMs: 60_000, slow: async (job) => `${job} finished by b` });
    await a.start();
    const submission = await say(a, key, 'work 1');
    await inTool;
    let zombie: any;
    await a.with(key, (harness) => { zombie = harness; });

    // `a` dies as a process does: nothing closed, nothing released. Its lease is still live.
    a.abandon();
    assert.strictEqual(await b.owner(key), a.instanceId);
    const died = Date.now();
    await b.start();

    await done(b, key, submission);
    // Not before the lease ran out: `b` waited its turn.
    assert.isAbove(Date.now() - died, 500);
    assert.strictEqual(await b.owner(key), b.instanceId);
    assert.deepEqual(await transcript(b, key), [
      'pi.user:work 1',
      'pi.assistant:',
      'pi.tool-result:work 1 finished by b',
      'pi.assistant:tool said: work 1 finished by b',
    ]);

    // What is left of `a` in memory cannot write to the storage it lost.
    const root = await zombie.root(pieces.context);
    assert.instanceOf(await rejection(root.submit({ type: 'input', content: 'still here?' }, pieces.context)), Error);
    assert.lengthOf(await transcript(b, key), 4);
    await zombie.close(pieces.context).catch(() => undefined);
  });

  it('hands its unfinished storages over at once when it stops', async function () {
    const { key, host } = scene();
    let reached!: () => void;
    const inTool = new Promise<void>((resolve) => { reached = resolve; });
    // A lease of a minute: anything that happens in this test is not the lease running out.
    const a = host('a', { leaseMs: 60_000, slow: (_job, signal) => { reached(); return hang(signal); } });
    const b = host('b', { leaseMs: 60_000, idleMs: 60_000, slow: async (job) => `${job} finished by b` });
    await a.start();
    await b.start();
    const submission = await say(a, key, 'work 2');
    await inTool;

    await a.stop();
    await done(b, key, submission, 5000);
    assert.strictEqual(await b.owner(key), b.instanceId);
    const lines = await transcript(b, key);
    assert.strictEqual(lines[lines.length - 1], 'pi.assistant:tool said: work 2 finished by b');
  });

  it('resumes its own storages at once when it restarts under the same name', async function () {
    const { key, host, prefix } = scene();
    let reached!: () => void;
    const inTool = new Promise<void>((resolve) => { reached = resolve; });
    const before = host('a', { leaseMs: 60_000, slow: (_job, signal) => { reached(); return hang(signal); } });
    await before.start();
    const submission = await say(before, key, 'work 3');
    await inTool;
    before.abandon();

    // The same instance, started again: its lease is live and is its own.
    const after = host('a', { leaseMs: 60_000, slow: async (job) => `${job} finished after restart` });
    assert.strictEqual(after.instanceId, `${prefix}a`);
    await after.start();
    await done(after, key, submission, 5000);
    const lines = await transcript(after, key);
    assert.strictEqual(lines[lines.length - 1], 'pi.assistant:tool said: work 3 finished after restart');
  });

  it('lets an instance that cannot host a storage reach one that can', async function () {
    const { key, host } = scene();
    const front = host('front', { accepts: () => false });
    const worker = host('worker', { idleMs: 60_000 });
    await front.start();
    await worker.start();

    const submission = await say(front, key, 'through the front');
    assert.deepEqual(front.hosted(), []);
    assert.deepEqual(worker.hosted(), [key]);
    await done(front, key, submission, 5000);
    assert.deepEqual(await transcript(front, key), ['pi.user:through the front', 'pi.assistant:echo: through the front']);
  });

  it('gives up on a request that no instance took, and nobody does it later', async function () {
    const { key, host } = scene();
    const front = host('front', { accepts: () => false, requestMs: 300 });
    await front.start();
    assert.strictEqual((await rejection(front.call(key, 'root', {})))?.name, 'RequestExpired');
    const rows = await mongo.db.collection('pi_durable_requests').find({ s: key }).toArray();
    assert.deepEqual(rows.map((row: any) => row.state), ['expired']);

    // An instance that could have hosted it arrives too late: the request is not revived.
    const late = host('late');
    await late.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(late.hosted(), []);
    assert.isUndefined(await (await late.reader(key)).conversation(1 as never, pieces.context));
  });

  it('reopens a storage after a commit whose outcome is unknown, and its work continues', async function () {
    const { key, host } = scene();
    // A client whose next commit transaction fails as a lost connection would: no answer either way.
    const fault = { commits: 0 };
    const flaky = new Proxy(mongo.client, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'startSession') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const session = value.apply(target, args);
          return new Proxy(session, {
            get(inner, name, innerReceiver) {
              const member = Reflect.get(inner, name, innerReceiver);
              if (name !== 'withTransaction') return typeof member === 'function' ? member.bind(inner) : member;
              return async (run: unknown, options?: { writeConcern?: unknown }) => {
                // Only commits carry a write concern; snapshot reads do not.
                if (options?.writeConcern !== undefined && fault.commits > 0) {
                  fault.commits -= 1;
                  throw new Error('injected: connection lost during commit');
                }
                return member.call(inner, run, options);
              };
            },
          });
        };
      },
    });
    const errors: { where: string; error: any }[] = [];
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const a = host('a', {
      client: flaky,
      idleMs: 60_000,
      // No sweep comes to the rescue within this test: the host reopens the storage itself.
      sweepMs: 60_000,
      errors,
      slow: async (job) => {
        runs += 1;
        if (runs === 1) await gate;
        return `${job} done on run ${runs}`;
      },
    });
    await a.start();
    const submission = await say(a, key, 'work 4');
    await until(() => runs === 1);

    // The commit of the tool's result is the one that fails.
    fault.commits = 1;
    release();
    await done(a, key, submission);
    assert.include(errors.map(({ error }) => error.message), 'injected: connection lost during commit');
    // The tool is replay-safe, so the reopened storage ran it again from its checkpoint.
    assert.strictEqual(runs, 2);
    const lines = await transcript(a, key);
    assert.strictEqual(lines[lines.length - 1], 'pi.assistant:tool said: work 4 done on run 2');
    assert.deepEqual(a.hosted(), [key]);
  });

  it('erases a storage wherever it is hosted, and a later use of the key starts from nothing', async function () {
    const { key, host } = scene();
    const a = host('a', { idleMs: 60_000 });
    const b = host('b', { idleMs: 60_000 });
    await a.start();
    await b.start();
    await done(a, key, await say(a, key, 'remember me'));
    const count = async () => {
      const names = ['ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'revisions'];
      const rows = await Promise.all(names.map((name) => mongo.db.collection(`pi_durable_${name}`).countDocuments({ s: key })));
      return rows.reduce((sum: number, n: number) => sum + n, 0) + await mongo.db.collection('pi_durable_meta').countDocuments({ _id: key });
    };
    assert.isAbove(await count(), 8);

    // Asked of the instance that does not host it; the one that does closes it and deletes it.
    await b.destroy(key);
    assert.deepEqual(a.hosted(), []);
    assert.strictEqual(await count(), 0);
    // The lease is the last thing its host lets go of, a moment after it has answered.
    const lease = () => mongo.db.collection('pi_durable_leases').findOne({ _id: key });
    await until(async () => (await lease()) === null, 2000);
    // And nothing brings the storage back: no sweep takes the finished request for unfinished work.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(await count(), 0);
    assert.isNull(await lease());

    // A notice of that request can still be on its way to an instance, by change stream, after all of this. Acting
    // on it must not open the storage: there is no request waiting any more. (The private entry point is called
    // directly, because a late notice cannot be arranged from outside.)
    assert.deepEqual(await (b as any).host(key, 'requests'), { elsewhere: true, owner: undefined });
    assert.deepEqual(b.hosted(), []);
    assert.strictEqual(await count(), 0);
    assert.isNull(await lease());

    await done(b, key, await say(b, key, 'fresh'), 5000);
    assert.deepEqual(await transcript(b, key), ['pi.user:fresh', 'pi.assistant:echo: fresh']);
  });

  it('passes on what it is asked once it was told to stop, and opens nothing', async function () {
    const { key, host } = scene();
    const a = host('a', { idleMs: 60_000 });
    const b = host('b', { idleMs: 60_000 });
    await a.start();
    await b.start();
    await done(a, key, await say(a, key, 'before the stop'));
    assert.deepEqual(a.hosted(), [key]);

    await a.stop();
    assert.isNull(await mongo.db.collection('pi_durable_leases').findOne({ _id: key }));

    // A call that reaches the stopped instance, as one does while a server shuts down: it takes no lease to leave
    // with. The work is done by the instance that stays.
    const after = await say(a, key, 'after the stop');
    assert.deepEqual(a.hosted(), []);
    assert.deepEqual(b.hosted(), [key]);
    assert.strictEqual(await a.owner(key), b.instanceId);
    await done(a, key, after);
    assert.deepEqual(await transcript(a, key), [
      'pi.user:before the stop', 'pi.assistant:echo: before the stop',
      'pi.user:after the stop', 'pi.assistant:echo: after the stop',
    ]);
    assert.strictEqual((await rejection(a.with(key, () => 'unreachable'))).name, 'HostedElsewhere');

    // So does a host that is made after its process was told to end, and so never starts.
    const late = host('late', { idleMs: 60_000 });
    await late.stop();
    const viaLate = await say(late, key, 'from a late host');
    assert.deepEqual(late.hosted(), []);
    await done(late, key, viaLate, 5000);
    const lines = await transcript(late, key);
    assert.strictEqual(lines[lines.length - 1], 'pi.assistant:echo: from a late host');
  });

  it('gives its leases up at once when it cannot wait for its storages to close', async function () {
    const { key, host, prefix } = scene();
    const idleKey = `${prefix}quiet`;
    scenes.push(idleKey);
    let reached!: () => void;
    const inTool = new Promise<void>((resolve) => { reached = resolve; });
    // A tool that ignores its cancellation. A lease of a minute: nothing here is the lease running out.
    const a = host('a', {
      leaseMs: 60_000,
      idleMs: 60_000,
      slow: () => { reached(); return new Promise<string>(() => undefined); },
    });
    const b = host('b', { leaseMs: 60_000, idleMs: 60_000, slow: async (job) => `${job} finished by b` });
    await a.start();
    await b.start();
    await done(a, idleKey, await say(a, idleKey, 'nothing to finish'));
    const submission = await say(a, key, 'work 7');
    await inTool;
    assert.sameMembers(a.hosted(), [key, idleKey]);

    await a.surrender();
    // The storage with work is taken by the instance that stays, without waiting for the lease.
    await done(b, key, submission, 5000);
    assert.strictEqual(await b.owner(key), b.instanceId);
    const lines = await transcript(b, key);
    assert.strictEqual(lines[lines.length - 1], 'pi.assistant:tool said: work 7 finished by b');
    // The one without is simply free: nobody has to open it to find that out.
    assert.isNull(await mongo.db.collection('pi_durable_leases').findOne({ _id: idleKey }));
    assert.deepEqual(b.hosted(), [key]);
  });

  it('hands a storage over when it stops, even one whose tool will not stop', async function () {
    const { key, host } = scene();
    let reached!: () => void;
    const inTool = new Promise<void>((resolve) => { reached = resolve; });
    const errors: any[] = [];
    const a = host('a', {
      leaseMs: 60_000,
      closeMs: 200,
      errors,
      slow: () => { reached(); return new Promise<string>(() => undefined); },
    });
    const b = host('b', { leaseMs: 60_000, idleMs: 60_000, slow: async (job) => `${job} finished by b` });
    await a.start();
    await b.start();
    const submission = await say(a, key, 'work 11');
    await inTool;

    // Closing waits for the tool, which never comes back. The stop does not wait with it.
    const began = Date.now();
    await a.stop();
    assert.isBelow(Date.now() - began, 2000);
    assert.include(
      errors.map(({ error }) => error.message),
      `Storage ${JSON.stringify(key)} did not close within 200 ms and was left behind`,
    );
    await done(b, key, submission, 5000);
    assert.strictEqual(await b.owner(key), b.instanceId);
    const lines = await transcript(b, key);
    assert.strictEqual(lines[lines.length - 1], 'pi.assistant:tool said: work 11 finished by b');
  });

  it('erases a storage whose tool will not stop, and keeps what is left of it out of the key\'s next storage', async function () {
    const { key, host } = scene();
    let reached!: () => void;
    const inTool = new Promise<void>((resolve) => { reached = resolve; });
    let finish!: (text: string) => void;
    // A tool that ignores its cancellation and comes back only when the test lets it.
    const a = host('a', {
      idleMs: 60_000,
      closeMs: 200,
      slow: () => { reached(); return new Promise<string>((resolve) => { finish = resolve; }); },
    });
    await a.start();
    await say(a, key, 'work 12');
    await inTool;

    const began = Date.now();
    await a.destroy(key);
    assert.isBelow(Date.now() - began, 2000);
    assert.deepEqual(a.hosted(), []);
    assert.strictEqual(await mongo.db.collection('pi_durable_entries').countDocuments({ s: key }), 0);

    // The key is used again while the old harness is still in memory, waiting for its tool.
    await done(a, key, await say(a, key, 'fresh'), 5000);
    // Now the old tool comes back, and its harness goes to record the result.
    finish('too late');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await transcript(a, key), ['pi.user:fresh', 'pi.assistant:echo: fresh']);
    assert.strictEqual(await mongo.db.collection('pi_durable_tasks').countDocuments({ s: key, r: /work 12/ }), 0);
  });

  it('keeps a host that lost a storage out of the storage that later took its key', async function () {
    const { key, host } = scene();
    const a = host('a', { idleMs: 60_000 });
    const b = host('b', { idleMs: 60_000 });
    await a.start();
    await done(a, key, await say(a, key, 'before'), 5000);
    let zombie: any;
    await a.with(key, (harness) => { zombie = harness; });
    // `a` stops as a paused process does: nothing closed, its harness still in memory.
    a.abandon();
    await b.start();

    // Erased by the instance that is left, once the lease of `a` has run out, and then used again. The new
    // storage counts its epochs from one: its owner holds the very epoch `a` held in the old one.
    await b.destroy(key);
    await done(b, key, await say(b, key, 'fresh'), 5000);
    assert.strictEqual((await mongo.db.collection('pi_durable_meta').findOne({ _id: key })).epoch, 1);

    // The paused process wakes up and writes.
    const root = await zombie.root(pieces.context);
    const refused = await rejection(root.submit({ type: 'input', content: 'from the storage that is gone' }, pieces.context));
    assert.instanceOf(refused, Error);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await transcript(b, key), ['pi.user:fresh', 'pi.assistant:echo: fresh']);
    await zombie.close(pieces.context).catch(() => undefined);
  });

  it('works beside a running process that was given the same name, and says so', async function () {
    const { key, host } = scene();
    const errors: any[] = [];
    const first = host('twin', { idleMs: 60_000, leaseMs: 60_000 });
    const second = host('twin', { idleMs: 60_000, leaseMs: 60_000, errors });
    assert.strictEqual(second.instanceId, first.instanceId);
    await first.start();
    await second.start();
    // Both have finished starting: neither is looking for what an earlier run of its name left.
    await until(() => !(first as any).adopting && !(second as any).adopting);

    await say(first, key, 'from the first');
    const epoch = async () => (await mongo.db.collection('pi_durable_meta').findOne({ _id: key }))?.epoch;
    const opened = await epoch();

    // Asked of the namesake: it does not take the storage from the process that runs it.
    const viaSecond = await say(second, key, 'from the second');
    assert.deepEqual(second.hosted(), []);
    assert.deepEqual(first.hosted(), [key]);
    assert.strictEqual(await epoch(), opened);
    await done(second, key, viaSecond, 5000);
    assert.deepEqual(await transcript(second, key), [
      'pi.user:from the first', 'pi.assistant:echo: from the first',
      'pi.user:from the second', 'pi.assistant:echo: from the second',
    ]);
    await say(second, key, 'and again');
    // Said once, however often it happens.
    const said = errors.filter(({ where }) => where === 'instance name');
    assert.lengthOf(said, 1);
    assert.include(said[0].error.message, "uses this instance's name");
  });

  it('takes over what a running namesake holds when it starts, and the namesake lets go', async function () {
    const { key, host } = scene();
    let reached!: () => void;
    const inTool = new Promise<void>((resolve) => { reached = resolve; });
    const first = host('twin', {
      leaseMs: 60_000,
      idleMs: 60_000,
      slow: (_job, signal) => { reached(); return hang(signal); },
    });
    await first.start();
    const submission = await say(first, key, 'work 8');
    await inTool;

    // A second process under the same name cannot tell a running namesake from its own last run.
    const second = host('twin', { leaseMs: 60_000, idleMs: 60_000, slow: async (job) => `${job} finished by the newcomer` });
    await second.start();
    await done(second, key, submission, 5000);
    const lines = await transcript(second, key);
    assert.strictEqual(lines[lines.length - 1], 'pi.assistant:tool said: work 8 finished by the newcomer');
    // The first finds out at its next renewal or commit, stops running the storage, and from then on asks the other.
    await until(() => first.hosted().length === 0);
    const later = await say(first, key, 'who has it now');
    assert.deepEqual(first.hosted(), []);
    assert.deepEqual(second.hosted(), [key]);
    await done(first, key, later, 5000);
  });
});
