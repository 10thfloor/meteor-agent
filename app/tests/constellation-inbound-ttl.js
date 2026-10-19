import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';

if (Meteor.isServer) describe('Admission replay retention migration', function () {
  this.timeout(20_000);
  let ensureTtl;
  let target;
  before(async () => {
    // This module is pure: importing it does not create duplicate package
    // collections or start another worker in the full-app test process.
    const helper = await import('meteor/10thfloor:agent/server/inbound-ttl.ts');
    ensureTtl = helper.ensureInboundReplayTtl;
    target = helper.INBOUND_REPLAY_TTL_SECONDS;
  });
  const failure = (code) => Object.assign(new Error(`Injected ${code}`), { code });
  const rejected = async (promise) => {
    let error;
    try { await promise; } catch (caught) { error = caught; }
    assert.isDefined(error, 'Expected the unsafe or unavailable migration to fail');
    return error;
  };
  function fixture(initial = []) {
    let indexes = structuredClone(initial);
    const calls = [];
    const collection = { collectionName: 'isolated_admission_probe',
      listIndexes: () => ({ toArray: async () => { calls.push('read'); return structuredClone(indexes); } }),
      createIndex: async (key, options) => { calls.push('create'); indexes.push({ v: 2, key, name: 'at_1', ...options }); return 'at_1'; } };
    const database = { command: async (command) => {
      calls.push(command);
      const found = indexes.find((index) => index.name === command.index.name);
      found.expireAfterSeconds = command.index.expireAfterSeconds;
      return { ok: 1 };
    } };
    return { collection, database, calls, indexes: () => structuredClone(indexes),
      replace: (value) => { indexes = structuredClone(value); } };
  }
  const legacy = () => ({ v: 2, key: { at: 1 }, name: 'saved_admission_ttl', hidden: true, expireAfterSeconds: 172800 });

  it('creates the seven-day TTL on first boot and leaves the correct policy unchanged on repeat', async () => {
    const f = fixture();
    const read = f.collection.listIndexes;
    let first = true;
    f.collection.listIndexes = () => ({ toArray: async () => {
      if (first) { first = false; throw failure(26); }
      return read().toArray();
    } });
    assert.equal((await ensureTtl(f.collection, f.database)).status, 'created');
    assert.equal((await ensureTtl(f.collection, f.database)).status, 'unchanged');
    assert.equal(f.indexes()[0].expireAfterSeconds, 604800);
    assert.equal(f.calls.filter((call) => call === 'create').length, 1);
    assert.isFalse(f.calls.some((call) => typeof call === 'object'));
  });

  it('changes only the known legacy TTL by observed name, preserving every other index option', async () => {
    const before = legacy();
    const f = fixture([before]);
    assert.equal((await ensureTtl(f.collection, f.database)).status, 'migrated');
    assert.deepEqual(f.calls.filter((call) => typeof call === 'object'), [{ collMod: 'isolated_admission_probe',
      index: { name: before.name, expireAfterSeconds: 604800 } }]);
    assert.deepEqual(f.indexes(), [{ ...before, expireAfterSeconds: target }]);
    assert.equal((await ensureTtl(f.collection, f.database)).status, 'unchanged');
    assert.notInclude(f.calls, 'create');
  });

  it('refuses automatic shortening, non-TTL conversion, ambiguous indexes and custom coverage options', async () => {
    const noTtl = legacy(); delete noTtl.expireAfterSeconds;
    const cases = [[{ ...legacy(), expireAfterSeconds: 14 * 86400 }], [{ ...legacy(), expireAfterSeconds: 86400 }], [noTtl],
      [{ ...legacy(), unique: true }], [{ ...legacy(), sparse: true }],
      [{ ...legacy(), partialFilterExpression: { kind: 'email' } }], [{ ...legacy(), collation: { locale: 'en' } }],
      [legacy(), { ...legacy(), name: 'other_at_index' }], [{ ...legacy(), key: { other: 1 }, name: 'at_1' }]];
    for (const indexes of cases) {
      const f = fixture(indexes);
      const error = await rejected(ensureTtl(f.collection, f.database));
      assert.equal(error.codeName, 'InboundReplayTTLNeedsReview');
      assert.deepEqual(f.indexes(), indexes);
      assert.deepEqual(f.calls, ['read']);
    }
  });

  it('does not interpret read failures as absence or use destructive fallbacks after permission failure', async () => {
    for (const code of [13, 89]) {
      const f = fixture([legacy()]);
      const error = failure(code);
      f.collection.listIndexes = () => ({ toArray: async () => { throw error; } });
      assert.strictEqual(await rejected(ensureTtl(f.collection, f.database)), error);
      assert.isEmpty(f.calls);
    }
    const f = fixture([legacy()]);
    const denied = failure(13);
    f.database.command = async () => { throw denied; };
    assert.strictEqual(await rejected(ensureTtl(f.collection, f.database)), denied);
    assert.deepEqual(f.indexes(), [legacy()]);
    assert.notInclude(f.calls, 'create');
  });

  it('verifies the post-migration metadata and rejects an unconfirmed or altered result', async () => {
    for (const altered of [legacy(), { ...legacy(), hidden: false, expireAfterSeconds: target }]) {
      const f = fixture([legacy()]);
      f.database.command = async () => { f.replace([altered]); return { ok: 1 }; };
      assert.equal((await rejected(ensureTtl(f.collection, f.database))).codeName, 'InboundReplayTTLNeedsReview');
      assert.notInclude(f.calls, 'create');
    }
  });

  it('adopts a concurrent compatible index creator without repeating arbitrary failed writes', async () => {
    const f = fixture();
    let creates = 0;
    f.collection.createIndex = async () => { creates += 1; f.replace([legacy()]); throw failure(85); };
    assert.equal((await ensureTtl(f.collection, f.database)).status, 'migrated');
    assert.equal(creates, 1);
    const network = fixture();
    const timeout = failure(89);
    network.collection.createIndex = async () => { throw timeout; };
    assert.strictEqual(await rejected(ensureTtl(network.collection, network.database)), timeout);
    assert.deepEqual(network.calls, ['read']);
  });

  it('migrates a real Mongo index in place without changing records or other metadata', async () => {
    const database = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
    const name = `agent_admission_ttl_probe_${Random.id().toLowerCase()}`;
    const collection = database.collection(name);
    try {
      await collection.createIndex({ at: 1 }, { name: 'legacy_retention', expireAfterSeconds: 172800, hidden: true });
      const sentinel = { _id: 'receipt', at: new Date(), sessionId: 'probe-session', state: 'completed', audit: { kept: true } };
      await collection.insertOne(sentinel);
      const before = await collection.listIndexes().toArray();
      assert.equal((await ensureTtl(collection, database)).status, 'migrated');
      const after = await collection.listIndexes().toArray();
      assert.deepEqual(after, before.map((index) => index.name === 'legacy_retention' ? { ...index, expireAfterSeconds: target } : index));
      assert.deepEqual(await collection.findOne({ _id: 'receipt' }), sentinel);
      assert.equal((await ensureTtl(collection, database)).status, 'unchanged');
      assert.equal(await collection.countDocuments(), 1);
    } finally {
      // Only this test-created, random-named probe collection is removed.
      try { await collection.drop(); } catch (error) { if (error.code !== 26) throw error; }
    }
  });
});
