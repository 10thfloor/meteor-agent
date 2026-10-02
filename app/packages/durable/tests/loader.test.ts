import fs from 'fs';
import os from 'os';
import path from 'path';
import { assert } from 'chai';
import { loadChord, loadPiAi, loadPiDurable, piDurableResolvable } from 'meteor/10thfloor:durable';
import { resolvePackageEntry } from '../server/loader';

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

  it('loads the pi-ai an app builds its models from, through a wildcard export', async function () {
    assert.isFunction((await loadPiAi('models') as any).createModels, 'createModels');
    assert.isFunction((await loadPiAi('providers/faux') as any).fauxProvider, 'fauxProvider');
  });

  it('gives every loader of a module the same instance', async function () {
    // The Session recognises StorageRejected by identity, so the storage must throw the class the harness loaded.
    const first = await loadPiDurable() as any;
    const second = await loadPiDurable() as any;
    assert.strictEqual(first.StorageRejected, second.StorageRejected);
  });

  describe('where npm keeps two copies', function () {
    let root: string;
    const scope = '@earendil-works';

    /** A package directory with an import-only exports map, as these packages publish. */
    function install(base: string, name: string, exportsMap: Record<string, unknown>) {
      const dir = path.join(base, 'node_modules', scope, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `${scope}/${name}`, exports: exportsMap }));
      return dir;
    }

    beforeEach(function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-loader-test-'));
    });

    afterEach(function () {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('takes the copy of Chord and of pi-ai that Pi Durable itself resolves', function () {
      const durable = install(root, 'pi-durable', { '.': { import: './dist/index.js' } });
      const exportsOf = { './delta': { import: './dist/delta/index.js' }, './*': { import: './dist/*.js' } };
      const shared = { chord: install(root, 'chord', exportsOf), ai: install(root, 'pi-ai', exportsOf) };

      // One copy of each, hoisted beside Pi Durable: that one.
      assert.strictEqual(
        resolvePackageEntry(`${scope}/chord`, 'delta', root),
        path.join(shared.chord, 'dist', 'delta', 'index.js'),
      );
      assert.strictEqual(resolvePackageEntry(`${scope}/pi-ai`, 'models', root), path.join(shared.ai, 'dist', 'models.js'));

      // A second copy that npm nested under Pi Durable, as it does when the app's own version does not fit Pi
      // Durable's range: that is the one the harness imports, so it is the one to load.
      const nested = { chord: install(durable, 'chord', exportsOf), ai: install(durable, 'pi-ai', exportsOf) };
      assert.strictEqual(
        resolvePackageEntry(`${scope}/chord`, 'delta', root),
        path.join(nested.chord, 'dist', 'delta', 'index.js'),
      );
      assert.strictEqual(resolvePackageEntry(`${scope}/pi-ai`, 'models', root), path.join(nested.ai, 'dist', 'models.js'));
      // Pi Durable itself is never looked for anywhere but at the top.
      assert.strictEqual(resolvePackageEntry(`${scope}/pi-durable`, undefined, root), path.join(durable, 'dist', 'index.js'));
    });

    it('finds the packages where a production bundle keeps them, and says what to install when they are missing', function () {
      const bundled = path.join(root, 'npm');
      const durable = install(bundled, 'pi-durable', { '.': { import: './dist/index.js' } });
      assert.strictEqual(
        resolvePackageEntry(`${scope}/pi-durable`, undefined, root),
        path.join(durable, 'dist', 'index.js'),
      );
      assert.throws(
        () => resolvePackageEntry(`${scope}/chord`, 'delta', root),
        /@earendil-works\/chord not found\. Install it in your app/,
      );
      assert.throws(() => resolvePackageEntry(`${scope}/pi-durable`, 'nothing', root), /does not export "\.\/nothing"/);
    });
  });
});
