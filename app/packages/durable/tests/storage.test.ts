import assert from 'assert';
import { MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';
import {
  destroyMongoStorage,
  loadChord,
  MONGO_SCHEMA_VERSION,
  openMongoStorage,
} from 'meteor/10thfloor:durable';

// What the conformance suite cannot see, because the contract does not speak
// of it: reopen, ownership, storages sharing collections, read consistency
// under a concurrent commit, reclamation, and whether each read is served by
// the index made for it.

const ROOT = 1;
const PREFIX = 'pi_durable_';
const root = { type: 'conversation', value: { id: ROOT } };
const entry = (id: number, conversationId: number, extra: Record<string, unknown> = {}) =>
  ({ id, conversationId, kind: 'message', ...extra });
const task = (id: number, conversationId: number, extra: Record<string, unknown> = {}) => ({
  id,
  conversationId,
  kind: 'test.task',
  version: 1,
  input: null,
  state: { status: 'pending', checkpoint: { phase: 'ready' } },
  background: false,
  abortRequested: false,
  ...extra,
});

describe('MongoStorage', function () {
  this.timeout(120_000);

  let context: any;
  let db: any;
  const keys: string[] = [];
  const newKey = (): string => {
    const key = `storage-${Random.id()}`;
    keys.push(key);
    return key;
  };
  const rows = (name: string, filter: Record<string, unknown>) =>
    db.collection(`${PREFIX}${name}`).countDocuments(filter);
  const failure = (operation: Promise<unknown>): Promise<any> => operation.then(() => undefined, (error) => error);

  before(async function () {
    context = (await loadChord('context') as any).BACKGROUND_CONTEXT;
    db = (MongoInternals.defaultRemoteCollectionDriver() as any).mongo.db;
  });

  after(async function () {
    for (const key of keys) await destroyMongoStorage(key);
  });

  it('persists records, sequence allocation, and global ID allocation across reopen', async function () {
    const key = newKey();
    const first = await openMongoStorage(key) as any;
    assert.strictEqual(await first.commit([root], context), 1);
    const entryId = await first.mintId();
    assert.strictEqual(entryId, 2);
    assert.strictEqual(await first.commit([{ type: 'entry', value: entry(entryId, ROOT) }], context), 2);
    // Minted and never committed: the ID is free again after reopen, as in the SQLite backend.
    assert.strictEqual(await first.mintId(), 3);
    await first.close(context);

    const reopened = await openMongoStorage(key) as any;
    assert.deepStrictEqual(await reopened.conversation(ROOT, context), { id: ROOT });
    assert.deepStrictEqual(await reopened.entry(entryId, context), { entry: entry(entryId, ROOT), commitSeq: 2 });
    const nextId = await reopened.mintId();
    assert.strictEqual(nextId, 3);
    assert.strictEqual(await reopened.commit([{ type: 'entry', value: entry(nextId, ROOT) }], context), 3);
  });

  it('lets the newest open commit and fences every earlier owner out', async function () {
    const key = newKey();
    const stale = await openMongoStorage(key) as any;
    await stale.commit([root], context);
    const staleEntry = await stale.mintId();

    const current = await openMongoStorage(key) as any;
    const refused = await failure(stale.commit([{ type: 'entry', value: entry(staleEntry, ROOT) }], context));
    assert.strictEqual(refused?.name, 'StorageOwnershipLost');
    // Nothing of the refused batch exists, and it consumed no sequence.
    assert.strictEqual(await current.entry(staleEntry, context), undefined);
    const currentEntry = await current.mintId();
    assert.strictEqual(await current.commit([{ type: 'entry', value: entry(currentEntry, ROOT) }], context), 2);
    // The stale owner stays fenced; it does not recover by retrying.
    assert.match((await failure(stale.commit([], context)))?.message, /owned by a later open/);
  });

  it('gives two first opens of one key distinct epochs, so exactly one of them owns it', async function () {
    const key = newKey();
    const [a, b] = await Promise.all([openMongoStorage(key), openMongoStorage(key)]) as any[];
    const outcomes = await Promise.all([a, b].map((storage) =>
      storage.commit([root], context).then(() => 'committed', (error: Error) => error.name)));
    assert.deepStrictEqual(outcomes.sort(), ['StorageOwnershipLost', 'committed']);
  });

  it('keeps storages that share the collections apart', async function () {
    const left = newKey();
    const right = newKey();
    const a = await openMongoStorage(left) as any;
    const b = await openMongoStorage(right) as any;
    await a.commit([root, { type: 'entry', value: entry(2, ROOT, { data: 'left' }) }], context);
    await b.commit([root, { type: 'entry', value: entry(2, ROOT, { data: 'right' }) }], context);
    assert.strictEqual((await a.entry(2, context)).entry.data, 'left');
    assert.strictEqual((await b.entry(2, context)).entry.data, 'right');
    assert.strictEqual((await a.scanEntries({ conversationId: ROOT }, 10, undefined, context)).items.length, 1);

    await destroyMongoStorage(left);
    assert.strictEqual(await rows('entries', { s: left }), 0);
    assert.strictEqual(await rows('ids', { s: left }), 0);
    assert.strictEqual(await rows('meta', { _id: left }), 0);
    assert.strictEqual((await b.entry(2, context)).entry.data, 'right');
  });

  it('rolls back every collection when a write fails partway through a commit', async function () {
    const key = newKey();
    const storage = await openMongoStorage(key) as any;
    const id = 2;
    const first = await storage.commit([
      root,
      {
        type: 'document.create',
        record: { id, kind: 'notes', scope: { kind: 'session' } },
        content: { kind: 'base', version: 1, value: { n: 0 } },
      },
    ], context);
    // Revisions are written last. A row already holding the next revision's key makes that write fail, after the
    // ID, entry, task and submission rows of the same commit were written inside the transaction.
    const planted = { _id: `${key}:${id}:${first + 1}`, s: 'someone-else', d: -1, q: -1, t: 'base', v: 1, c: '{}' };
    await db.collection(`${PREFIX}revisions`).insertOne(planted);
    const batch = [
      { type: 'entry', value: entry(10, ROOT) },
      { type: 'task', value: task(11, ROOT) },
      { type: 'submission', value: { id: 12, conversationId: ROOT, requestId: 'r', type: 'input', status: 'queued' } },
      { type: 'document.change', id, content: { kind: 'delta', version: 1, ops: [['s', ['n'], 1]] } },
    ];
    assert.match((await failure(storage.commit(batch, context)))?.message, /E11000/);
    assert.strictEqual(await storage.entry(10, context), undefined);
    assert.strictEqual(await storage.task(11, context), undefined);
    assert.strictEqual(await storage.submissionByRequest(ROOT, 'r', context), undefined);
    assert.strictEqual(await rows('ids', { s: key }), 2);
    assert.deepStrictEqual((await storage.document(id, 'current', context)).value, { n: 0 });

    // The refused commit consumed no sequence: with the obstacle gone, the same batch commits as the next one.
    await db.collection(`${PREFIX}revisions`).deleteOne({ _id: planted._id });
    assert.strictEqual(await storage.commit(batch, context), first + 1);
    assert.deepStrictEqual((await storage.document(id, 'current', context)).value, { n: 1 });
    assert.strictEqual((await storage.entry(10, context)).commitSeq, first + 1);
  });

  it('leaves nothing of a batch behind when a document copy in it is rejected', async function () {
    const key = newKey();
    const storage = await openMongoStorage(key) as any;
    const child = 2;
    const source = {
      id: 3,
      kind: 'notes',
      scope: { kind: 'conversation', conversationId: ROOT },
      history: 'rewindable',
      fork: 'asOf',
    };
    await storage.commit([
      root,
      { type: 'conversation', value: { id: child } },
      { type: 'document.create', record: source, content: { kind: 'base', version: 1, value: { n: 1 } } },
    ], context);
    // The copy names a source of another kind, which only reading the source reveals.
    const rejected = await failure(storage.commit([
      { type: 'entry', value: entry(10, ROOT) },
      { type: 'task', value: task(11, ROOT) },
      {
        type: 'document.copy',
        record: { ...source, id: 12, kind: 'other', scope: { kind: 'conversation', conversationId: child } },
        source: { id: source.id, at: 'current' },
      },
    ], context));
    assert.strictEqual(rejected?.name, 'StorageRejected');
    assert.strictEqual(await storage.entry(10, context), undefined);
    assert.strictEqual(await storage.task(11, context), undefined);
    assert.strictEqual(await storage.document(12, 'current', context), undefined);
    // The IDs were not claimed either, so a later batch may use them for another table.
    await storage.commit([{ type: 'entry', value: entry(11, ROOT) }], context);
    assert.strictEqual((await storage.entry(11, context)).commitSeq, 2);
  });

  it('reads a document from one committed state while its base is being replaced', async function () {
    const key = newKey();
    const storage = await openMongoStorage(key) as any;
    const id = 2;
    await storage.commit([
      root,
      {
        type: 'document.create',
        record: { id, kind: 'live', scope: { kind: 'session' } },
        content: { kind: 'base', version: 1, value: { n: 0, m: 0 } },
      },
    ], context);
    // Writer: a new base, then a delta that brings `m` level with `n`. Every committed state has m === n or
    // m === n - 1; an old base under a new delta, or a base with no tail, would break that or throw.
    let writing = true;
    const writer = (async () => {
      for (let n = 1; n <= 60; n += 1) {
        await storage.commit(
          [{ type: 'document.change', id, content: { kind: 'base', version: 1, value: { n, m: n - 1 } } }],
          context,
        );
        await storage.commit(
          [{ type: 'document.change', id, content: { kind: 'delta', version: 1, ops: [['s', ['m'], n]] } }],
          context,
        );
      }
      writing = false;
    })();
    let reads = 0;
    const reader = async () => {
      while (writing) {
        const stored = await storage.document(id, 'current', context);
        const { n, m } = stored.value;
        assert.ok(m === n || m === n - 1, `torn read: n=${n} m=${m}`);
        assert.strictEqual(stored.deltasSinceBase, m === n && n > 0 ? 1 : 0);
        reads += 1;
      }
    };
    await Promise.all([writer, reader(), reader(), reader()]);
    assert.ok(reads > 20, `only ${reads} reads raced the writer`);
    assert.deepStrictEqual((await storage.document(id, 'current', context)).value, { n: 60, m: 60 });
  });

  it("reclaims a current-only document's revisions at a base or retirement, and keeps a rewindable one's", async function () {
    const key = newKey();
    const storage = await openMongoStorage(key) as any;
    const latest = 2;
    const rewindable = 3;
    const revisions = (d: number) => rows('revisions', { s: key, d });
    await storage.commit([
      root,
      {
        type: 'document.create',
        record: { id: latest, kind: 'latest', scope: { kind: 'session' } },
        content: { kind: 'base', version: 1, value: { n: 0 } },
      },
      {
        type: 'document.create',
        record: {
          id: rewindable,
          kind: 'rewindable',
          scope: { kind: 'conversation', conversationId: ROOT },
          history: 'rewindable',
          fork: 'asOf',
        },
        content: { kind: 'base', version: 1, value: { n: 0 } },
      },
    ], context);
    for (let n = 1; n <= 5; n += 1) {
      await storage.commit([latest, rewindable].map((id) => ({
        type: 'document.change',
        id,
        content: { kind: 'delta', version: 1, ops: [['s', ['n'], n]] },
      })), context);
    }
    assert.strictEqual(await revisions(latest), 6);
    assert.strictEqual(await revisions(rewindable), 6);
    const based = await storage.commit([latest, rewindable].map((id) => ({
      type: 'document.change',
      id,
      content: { kind: 'base', version: 1, value: { n: 100 } },
    })), context);
    assert.strictEqual(await revisions(latest), 1);
    assert.strictEqual(await revisions(rewindable), 7);
    assert.deepStrictEqual((await storage.document(rewindable, based - 1, context)).value, { n: 5 });
    await storage.commit([
      { type: 'document.retire', id: latest },
      { type: 'document.retire', id: rewindable },
    ], context);
    assert.strictEqual(await revisions(latest), 0);
    assert.strictEqual(await revisions(rewindable), 7);
  });

  it('answers every contract read from the index made for it', async function () {
    // Rows the queries below must step over without touching: a second storage in the same collections, and inside
    // this one other conversations, statuses, kinds, scopes, and documents. A read served by the wrong index
    // examines them; the profiler reports how many documents each operation examined.
    const other = await openMongoStorage(newKey()) as any;
    await other.commit([
      root,
      ...[2, 3, 4, 5, 6].map((id) => ({ type: 'entry', value: entry(id, ROOT) })),
      ...[7, 8, 9].map((id) => ({ type: 'task', value: task(id, ROOT) })),
    ], context);

    const key = newKey();
    const storage = await openMongoStorage(key) as any;
    const child = 2;
    const sibling = 3;
    const session = { kind: 'session' };
    const submission = (id: number, conversationId: number, requestId: string, status: 'queued' | 'placed') => ({
      type: 'submission',
      value: status === 'queued'
        ? { id, conversationId, requestId, type: 'input', status }
        : { id, conversationId, requestId, type: 'input', status, entry: 10 },
    });
    await storage.commit([
      root,
      { type: 'entry', value: entry(10, ROOT, { head: 10 }) },
      // Above the head, in the same conversation: a head lookup through the plain entry index would read them.
      ...[11, 12, 13, 14].map((id) => ({ type: 'entry', value: entry(id, ROOT) })),
    ], context);
    const createdAt = await storage.commit([
      {
        type: 'conversation',
        value: { id: child, parent: { conversationId: ROOT, at: 12 }, owner: { conversationId: ROOT, taskId: 30 } },
      },
      { type: 'conversation', value: { id: sibling, owner: { conversationId: child, taskId: 31 } } },
      ...[20, 21, 22].map((id) => ({ type: 'entry', value: entry(id, child) })),
      ...[23, 24].map((id) => ({ type: 'entry', value: entry(id, sibling) })),
      { type: 'task', value: task(30, ROOT) },
      { type: 'task', value: task(31, child, { kind: 'other.task' }) },
      { type: 'task', value: task(32, child, { abortRequested: true }) },
      { type: 'task', value: task(33, sibling, { background: true }) },
      { type: 'task', value: task(34, sibling, { state: { status: 'running', checkpoint: { phase: 'effect' } } }) },
      submission(40, ROOT, 'a', 'queued'),
      submission(41, ROOT, 'b', 'placed'),
      submission(42, child, 'a', 'queued'),
      ...[
        { id: 50, kind: 'notes', scope: session, key: 'a' },
        { id: 51, kind: 'notes', scope: session, key: 'b' },
        { id: 52, kind: 'plan', scope: session },
        { id: 53, kind: 'notes', scope: { kind: 'task', taskId: 30 } },
      ].map((record) => ({
        type: 'document.create',
        record,
        content: { kind: 'base', version: 1, value: { n: 0 } },
      })),
    ], context);
    for (let n = 1; n <= 4; n += 1) {
      await storage.commit([50, 51].map((id) => ({
        type: 'document.change',
        id,
        content: { kind: 'delta', version: 1, ops: [['s', ['n'], n]] },
      })), context);
    }

    const profile = async (run: () => Promise<void>): Promise<any[]> => {
      await db.command({ profile: 0 });
      await db.collection('system.profile').drop().catch(() => undefined);
      await db.command({ profile: 2 });
      try {
        await run();
      } finally {
        await db.command({ profile: 0 });
      }
      return db.collection('system.profile').find({ ns: { $regex: `\\.${PREFIX}` } }).toArray();
    };
    const unindexed = (ops: any[]) => ops
      .filter((op) => op.planSummary?.includes('COLLSCAN') || op.hasSortStage === true)
      .map((op) => ({ ns: op.ns, plan: op.planSummary, sort: op.hasSortStage, command: op.command }));
    const ids = (page: any) => page.items.map((item: any) => item.id);

    // Each of these has an index made for exactly its filter and order, so it reads no document it does not return.
    const exact = await profile(async () => {
      await storage.conversation(child, context);
      await storage.scanConversations({}, 10, undefined, context);
      await storage.scanConversations({ ownerConversationId: ROOT }, 10, undefined, context);
      await storage.scanConversations({ ownerTaskId: 31 }, 10, undefined, context);
      await storage.entry(21, context);
      await storage.entry(child, 11, context);
      assert.strictEqual((await storage.findLatestHeadMarker(child, undefined, context)).id, 10);
      assert.strictEqual((await storage.findLatestHeadMarker(ROOT, 13, context)).id, 10);
      assert.deepStrictEqual(
        ids(await storage.scanEntries({ conversationId: child }, 10, undefined, context)),
        [22, 21, 20, 12, 11, 10],
      );
      await storage.scanEntries({ conversationId: child, minEntryId: 11, maxEntryId: 21 }, 2, undefined, context);
      await storage.task(31, context);
      await storage.scanTasks({}, 10, undefined, context);
      assert.strictEqual((await storage.scanTasks({ status: 'running' }, 10, undefined, context)).items.length, 1);
      assert.strictEqual((await storage.scanTasks({ conversationId: child }, 10, undefined, context)).items.length, 2);
      assert.strictEqual((await storage.scanTasks({ kind: 'other.task' }, 10, undefined, context)).items.length, 1);
      assert.strictEqual((await storage.scanTasks({ abortRequested: true }, 10, undefined, context)).items.length, 1);
      assert.strictEqual((await storage.scanTasks({ background: true }, 10, undefined, context)).items.length, 1);
      await storage.submission(41, context);
      await storage.scanSubmissions({}, 10, undefined, context);
      assert.strictEqual((await storage.scanSubmissions({ status: 'placed' }, 10, undefined, context)).items.length, 1);
      assert.strictEqual((await storage.scanSubmissions({ conversationId: child }, 10, undefined, context)).items.length, 1);
      assert.strictEqual((await storage.submissionByRequest(child, 'a', context)).id, 42);
      assert.strictEqual((await storage.findDocument({ kind: 'notes', scope: session, key: 'b' }, 'current', context)).id, 51);
      assert.strictEqual((await storage.findDocument({ kind: 'plan', scope: session }, createdAt, context)).id, 52);
      assert.deepStrictEqual((await storage.document(51, 'current', context)).value, { n: 4 });
      assert.strictEqual((await storage.scanDocuments({ scope: session, at: 'current' }, 10, undefined, context)).items.length, 3);
      assert.strictEqual(
        (await storage.scanDocuments({ scope: session, at: createdAt, kind: 'notes' }, 10, undefined, context)).items.length,
        2,
      );
      // A commit's own reads and writes are profiled too.
      await storage.commit([
        { type: 'task', value: task(31, child, { kind: 'other.task', abortRequested: true }) },
        { type: 'entry', value: entry(60, child) },
        { type: 'document.change', id: 50, content: { kind: 'delta', version: 1, ops: [['s', ['n'], 5]] } },
        {
          type: 'document.create',
          record: { id: 61, kind: 'notes', scope: session, key: 'c' },
          content: { kind: 'base', version: 1, value: {} },
        },
      ], context);
    });
    assert.ok(exact.length > 40, `profiled only ${exact.length} operations`);
    assert.deepStrictEqual(unindexed(exact), []);
    assert.deepStrictEqual(
      exact
        .filter((op) => op.op === 'query' && (op.docsExamined ?? 0) > Math.max(op.nreturned ?? 0, 1))
        .map((op) => ({ ns: op.ns, plan: op.planSummary, examined: op.docsExamined, returned: op.nreturned, command: op.command })),
      [],
    );

    // Conjunctions pick one of those indexes and filter the rest; they still neither scan a collection nor sort.
    const conjunctions = await profile(async () => {
      await storage.scanConversations({ ownerConversationId: ROOT, ownerTaskId: 30 }, 10, undefined, context);
      await storage.scanTasks({ conversationId: child, status: 'pending', kind: 'test.task' }, 10, undefined, context);
      await storage.scanTasks({ status: 'pending', abortRequested: false, background: false }, 10, undefined, context);
      await storage.scanSubmissions({ conversationId: ROOT, status: 'queued' }, 10, undefined, context);
    });
    assert.strictEqual(conjunctions.length, 4);
    assert.deepStrictEqual(unindexed(conjunctions), []);
  });

  it('keeps keys that BSON would refuse or rewrite, in records, document values, and addresses', async function () {
    const key = newKey();
    const storage = await openMongoStorage(key) as any;
    // A tool schema's `$ref`, a dotted key, an empty key, a NUL in a key, and a value shaped like an update.
    const data = JSON.parse('{"$ref":"#/defs/x","a.b":1,"":2,"\\u0000nul":3,"$set":{"$inc":{"x.y":1}}}');
    await storage.commit([
      root,
      { type: 'entry', value: entry(2, ROOT, { kind: '$kind.with.dots', data }) },
      {
        type: 'document.create',
        record: { id: 3, kind: '$kind.with.dots', scope: { kind: 'session' }, key: 'a.b$' },
        content: { kind: 'base', version: 1, value: data },
      },
    ], context);
    await storage.commit([{
      type: 'document.change',
      id: 3,
      content: { kind: 'delta', version: 1, ops: [['s', ['$set', '$inc', 'x.y'], 2], ['s', ['new.key$'], true]] },
    }], context);

    const read = (await storage.entry(2, context)).entry;
    assert.strictEqual(read.kind, '$kind.with.dots');
    assert.deepStrictEqual(read.data, data);
    assert.deepStrictEqual(
      (await storage.document(3, 'current', context)).value,
      { ...data, $set: { $inc: { 'x.y': 2 } }, 'new.key$': true },
    );
    const address = { kind: '$kind.with.dots', scope: { kind: 'session' }, key: 'a.b$' };
    assert.strictEqual((await storage.findDocument(address, 'current', context)).id, 3);
    assert.strictEqual(await storage.findDocument({ ...address, key: 'a.b' }, 'current', context), undefined);
  });

  it('refuses a storage written by a newer schema', async function () {
    const key = newKey();
    await (await openMongoStorage(key) as any).close(context);
    await db.collection(`${PREFIX}meta`).updateOne({ _id: key }, { $set: { schema: MONGO_SCHEMA_VERSION + 1 } });
    assert.match((await failure(openMongoStorage(key)))?.message, /newer than supported/);
  });
});
