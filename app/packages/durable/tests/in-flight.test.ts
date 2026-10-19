import { assert } from 'chai';
import { MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { MongoStorage } from 'meteor/10thfloor:durable';
import { loadPieces, type Pieces } from './support';

// A storage's meta row is written by every commit, by `open()` and by
// `destroy()`, so they take turns. These tests are about the turn-taking:
// what waits for what, where the waiting happens, and what is left when it is
// over. (The same with a second operating-system process, killed in the middle
// of a commit, ran under plain Node while this file was written.)

const PREFIX = 'pi_durable_';
const ROOT = 1;
const TABLES = ['ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'revisions'];

describe('MongoStorage and a commit in flight', function () {
  this.timeout(60_000);

  let pieces: Pieces;
  let context: any;
  let client: any;
  let db: any;
  let runtime: any;
  const keys: string[] = [];

  const options = (extra: Record<string, unknown> = {}) => {
    const key = `in-flight-${Random.id()}`;
    keys.push(key);
    return { client, db, key, runtime, ...extra };
  };
  const root = { type: 'conversation', value: { id: ROOT } };
  const entryWrite = (id: number, data = 'an entry') => ({
    type: 'entry', value: { id, conversationId: ROOT, kind: 'message', data },
  });
  const meta = () => db.collection(`${PREFIX}meta`);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const outcome = (work: Promise<unknown>) => work.then(() => 'resolved', (error: Error) => error.name);

  /** Everything stored under a key, table by table. */
  const stored = async (key: string) => {
    const counts: Record<string, number> = { meta: await meta().countDocuments({ _id: key }) };
    for (const name of TABLES) counts[name] = await db.collection(`${PREFIX}${name}`).countDocuments({ s: key });
    return counts;
  };
  const nothing = { meta: 0, ...Object.fromEntries(TABLES.map((name) => [name, 0])) };

  /** The operations on a storage's meta row that have been inside the server for longer than an eighth of a second. */
  const parkedOn = async (key: string) => {
    const { inprog } = await client.db('admin').command({ currentOp: 1, active: true });
    return (inprog as any[])
      .filter((op) => op.ns === `${db.databaseName}.${PREFIX}meta` && JSON.stringify(op.command ?? {}).includes(key))
      .filter((op) => Number(op.microsecs_running) > 125_000)
      .map((op) => `${Object.keys(op.command)[0]} for ${Math.round(Number(op.microsecs_running) / 1000)} ms`);
  };

  /**
   * The database, except that a bulk write to `entries` stops at a gate first. A commit that adds an entry
   * therefore stops in the middle of its transaction, with the meta row written: an owner that stalled, or died,
   * while committing.
   */
  const gated = () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let arrive!: () => void;
    const reached = new Promise<void>((resolve) => { arrive = resolve; });
    const gatedDb = {
      collection(name: string) {
        const real = db.collection(name);
        if (name !== `${PREFIX}entries`) return real;
        return new Proxy(real, {
          get(target, property) {
            const value = target[property];
            if (property !== 'bulkWrite') return typeof value === 'function' ? value.bind(target) : value;
            return async (...args: unknown[]) => {
              arrive();
              await gate;
              return value.apply(target, args);
            };
          },
        });
      },
      command: (command: Record<string, unknown>) => db.command(command),
    };
    return { db: gatedDb, open, reached };
  };

  before(async function () {
    pieces = await loadPieces();
    context = pieces.context;
    runtime = { apply: pieces.apply, StorageRejected: pieces.durable.StorageRejected };
    ({ client, db } = (MongoInternals.defaultRemoteCollectionDriver() as any).mongo);
  });

  after(async function () {
    for (const key of keys) await MongoStorage.destroy({ client, db, key });
  });

  it('makes open() wait for the commit outside the server, where it holds none of the server\'s write tickets', async function () {
    const at = options();
    const owner = await MongoStorage.open(at);
    await owner.commit([root] as any, context);
    // A transaction has written the storage's meta row and has not finished: a commit in flight.
    const holder = client.startSession();
    holder.startTransaction();
    await meta().updateOne({ _id: at.key }, { $set: { held: true } }, { session: holder });

    let opened = false;
    const opening = MongoStorage.open({ ...at, commitGraceMs: 60_000 }).then((storage) => {
      opened = true;
      return storage;
    });
    for (let sample = 0; sample < 8; sample++) {
      await sleep(100);
      assert.isFalse(opened);
      // A plain write would be in here the whole time, being retried by the server with a ticket in its hand.
      assert.deepEqual(await parkedOn(at.key), []);
    }
    await holder.commitTransaction();
    await holder.endSession();

    const next = await opening;
    assert.strictEqual((await meta().findOne({ _id: at.key })).epoch, 2);
    assert.strictEqual(await next.commit([entryWrite(await next.mintId())] as any, context), 2);
    assert.match((await outcome(owner.commit([], context))), /StorageOwnershipLost/);
  });

  it('gives up as StorageBusy when the commit outlasts the time allowed, and leaves the owner its storage', async function () {
    const at = options();
    const owner = await MongoStorage.open(at);
    await owner.commit([root] as any, context);
    const holder = client.startSession();
    holder.startTransaction();
    await meta().updateOne({ _id: at.key }, { $set: { held: true } }, { session: holder });

    const began = Date.now();
    assert.strictEqual(await outcome(MongoStorage.open({ ...at, commitGraceMs: 60_000, busyTimeoutMs: 400 })), 'StorageBusy');
    assert.isAtLeast(Date.now() - began, 400);
    await holder.abortTransaction();
    await holder.endSession();

    assert.strictEqual((await meta().findOne({ _id: at.key })).epoch, 1);
    assert.strictEqual(await owner.commit([entryWrite(await owner.mintId())] as any, context), 2);
  });

  it('takes a storage from an owner that stopped in the middle of a commit, by ending that commit', async function () {
    const at = options();
    const stalled = gated();
    const owner = await MongoStorage.open({ ...at, db: stalled.db });
    await owner.commit([root] as any, context);
    const lost = await owner.mintId();
    const unfinished = outcome(owner.commit([entryWrite(lost as number, 'from the owner that stopped')] as any, context));
    await stalled.reached;

    // Without a way to end the commit there is only waiting for the server's own limit, a minute away.
    const powerless = { collection: (name: string) => db.collection(name) };
    assert.strictEqual(
      await outcome(MongoStorage.open({ ...at, db: powerless, commitGraceMs: 200, busyTimeoutMs: 1200 })),
      'StorageBusy',
    );

    const began = Date.now();
    const next = await MongoStorage.open({ ...at, commitGraceMs: 300 });
    assert.isAtLeast(Date.now() - began, 300);
    assert.isBelow(Date.now() - began, 5000);
    // Nothing of the unfinished commit is there: not its entry, and not the ID or the sequence it had taken.
    const taken = await next.mintId();
    assert.strictEqual(taken, lost);
    assert.isUndefined(await next.entry(lost as never, context));
    assert.strictEqual(await next.commit([entryWrite(taken as number, 'from its successor')] as any, context), 2);

    // The owner comes back to life. Its commit was ended, and it has no storage to try again in.
    stalled.open();
    assert.strictEqual(await unfinished, 'StorageOwnershipLost');
    assert.strictEqual((await next.entry(taken as never, context))?.entry.data, 'from its successor');
    assert.strictEqual(await db.collection(`${PREFIX}entries`).countDocuments({ s: at.key }), 1);
  });

  it('leaves nothing behind when a storage is destroyed while a commit to it is finishing', async function () {
    const at = options();
    const slow = gated();
    const owner = await MongoStorage.open({ ...at, db: slow.db });
    await owner.commit([root] as any, context);
    const inFlight = owner.commit([entryWrite(await owner.mintId())] as any, context);
    await slow.reached;

    let destroyed = false;
    const destroying = MongoStorage.destroy(at).then(() => { destroyed = true; });
    await sleep(300);
    // It has removed nothing yet: the commit was there first.
    assert.isFalse(destroyed);
    assert.strictEqual((await stored(at.key)).conversations, 1);
    slow.open();
    assert.strictEqual(await inFlight, 2);
    await destroying;

    assert.deepEqual(await stored(at.key), nothing);
    assert.strictEqual(await outcome(owner.commit([], context)), 'StorageOwnershipLost');
    assert.deepEqual(await stored(at.key), nothing);
  });

  it('destroys a storage whose owner stopped in the middle of a commit', async function () {
    const at = options();
    const stalled = gated();
    const owner = await MongoStorage.open({ ...at, db: stalled.db });
    await owner.commit([root] as any, context);
    const unfinished = outcome(owner.commit([entryWrite(await owner.mintId())] as any, context));
    await stalled.reached;

    const began = Date.now();
    await MongoStorage.destroy({ ...at, commitGraceMs: 300 });
    assert.isBelow(Date.now() - began, 5000);
    assert.deepEqual(await stored(at.key), nothing);

    stalled.open();
    assert.strictEqual(await unfinished, 'StorageOwnershipLost');
    assert.deepEqual(await stored(at.key), nothing);
  });

  it('commits one at a time in the order asked, and a refused commit does not hold up the next', async function () {
    const at = options();
    // How many of the storage's transactions are under way at once.
    let inFlight = 0;
    let most = 0;
    const counting = {
      startSession() {
        const session = client.startSession();
        const run = session.withTransaction.bind(session);
        session.withTransaction = async (...args: unknown[]) => {
          inFlight++;
          most = Math.max(most, inFlight);
          try {
            return await run(...args);
          } finally {
            inFlight--;
          }
        };
        return session;
      },
    };
    const storage = await MongoStorage.open({ ...at, client: counting });
    const commit = (writes: unknown[]) => storage.commit(writes as any, context);
    const first = await storage.mintId();
    const second = await storage.mintId();

    // The third writes the root conversation a second time, and is refused.
    const asked = [commit([root]), commit([entryWrite(first as number)]), commit([root]), commit([entryWrite(second as number)])];
    const outcomes = await Promise.all(asked.map((one) => one.then((seq) => seq, (error: Error) => error.message)));
    assert.deepEqual(outcomes, [1, 2, 'ID 1 already belongs to conversation', 3]);
    assert.strictEqual(most, 1);
  });

  it('names its session in the meta row while it is open, and no longer once it is closed', async function () {
    const at = options();
    const slow = gated();
    const storage = await MongoStorage.open({ ...at, db: slow.db });
    await storage.commit([root] as any, context);
    assert.isDefined((await meta().findOne({ _id: at.key })).sid);
    // A reader owns nothing and names nothing.
    await (await MongoStorage.reader(at)).close(context);
    assert.isDefined((await meta().findOne({ _id: at.key })).sid);

    // Closing waits for a commit under way.
    const inFlight = storage.commit([entryWrite(await storage.mintId())] as any, context);
    await slow.reached;
    let closed = false;
    const closing = storage.close(context).then(() => { closed = true; });
    await sleep(200);
    assert.isFalse(closed);
    slow.open();
    assert.strictEqual(await inFlight, 2);
    await closing;
    assert.notProperty(await meta().findOne({ _id: at.key }), 'sid');

    // An owner that was replaced leaves the row to its successor.
    const replaced = await MongoStorage.open(at);
    const successor = await MongoStorage.open(at);
    const named = (await meta().findOne({ _id: at.key })).sid;
    await replaced.close(context);
    assert.deepEqual((await meta().findOne({ _id: at.key })).sid, named);
    await successor.close(context);
  });
});
