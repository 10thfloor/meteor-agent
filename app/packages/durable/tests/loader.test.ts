import { assert } from 'chai';
import { loadChord, loadPiDurable, piDurableResolvable } from 'meteor/10thfloor:durable';

// Meteor's resolver cannot follow an `exports` map, and all three of these
// packages publish their entry points only through one. The seam must find
// them inside a running Meteor server.
describe('pi-durable loader seam', function () {
  this.timeout(30_000);

  it('reports the packages as installed', function () {
    assert.isTrue(piDurableResolvable());
  });

  it('loads the harness, the storage conformance suite, and the Chord modules the storage needs', async function () {
    const durable = await loadPiDurable() as any;
    assert.isFunction(durable.Harness?.open, 'Harness.open');
    assert.isFunction(durable.createRegistry, 'createRegistry');
    assert.isFunction(durable.MemoryStorage, 'MemoryStorage');
    assert.isFunction(durable.StorageRejected, 'StorageRejected');
    assert.strictEqual(durable.ROOT_CONVERSATION_ID, 1);

    const testing = await loadPiDurable('testing') as any;
    assert.isFunction(testing.createStorageConformance, 'createStorageConformance');

    const context = await loadChord('context') as any;
    assert.isOk(context.BACKGROUND_CONTEXT, 'BACKGROUND_CONTEXT');
    const delta = await loadChord('delta') as any;
    assert.deepEqual(delta.apply({ n: 1 }, [['s', ['n'], 2]]), { n: 2 });
  });

  it('gives every loader of a module the same instance', async function () {
    // The Session recognises StorageRejected by identity, so the storage must throw the class the harness loaded.
    const first = await loadPiDurable() as any;
    const second = await loadPiDurable() as any;
    assert.strictEqual(first.StorageRejected, second.StorageRejected);
  });
});
