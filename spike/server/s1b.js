// S1b — the §8 fallback: load pi-ai at RUNTIME, outside Meteor's bundler.
// `new Function` hides the import() from Meteor's static analysis, so it is a
// native Node dynamic import resolved by Node's own algorithm (which does
// understand exports maps).
import path from 'path';
import fs from 'fs';

const nodeImport = new Function('s', 'return import(s)');

function findAppNodeModules() {
  // In dev Meteor runs from .meteor/local/build; walk up for the app's node_modules.
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-ai');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function s1bReport() {
  const detail = { cwd: process.cwd(), nodeVersion: process.version };

  // Strategy 1: bare specifier through native import()
  try {
    const m = await nodeImport('@earendil-works/pi-ai');
    detail.bareSpecifier = { ok: true, exports: Object.keys(m).length };
  } catch (e) {
    detail.bareSpecifier = { ok: false, error: e.message.split('\n')[0] };
  }

  // Strategy 2: absolute file URL, resolved by walking up to the app's node_modules
  const pkgDir = findAppNodeModules();
  detail.resolvedPkgDir = pkgDir;
  if (pkgDir) {
    try {
      const url = `file://${path.join(pkgDir, 'dist', 'index.js')}`;
      const m = await nodeImport(url);
      detail.absoluteFileUrl = {
        ok: true,
        exports: Object.keys(m).length,
        hasCalculateCost: typeof m.calculateCost === 'function',
      };
      // Does a real call work end-to-end (proving transitive typebox loaded)?
      try {
        const cost = m.calculateCost(
          { input: 1000, output: 500 },
          { cost: { input: 3, output: 15 } },
        );
        detail.functionalCall = { ok: true, cost };
      } catch (e) {
        detail.functionalCall = { ok: false, error: e.message.split('\n')[0] };
      }
    } catch (e) {
      detail.absoluteFileUrl = { ok: false, error: e.message.split('\n')[0] };
    }

    // Strategy 3: a subpath through the same mechanism
    try {
      const m = await nodeImport(`file://${path.join(pkgDir, 'dist', 'providers', 'anthropic.js')}`);
      detail.subpath = { ok: true, exports: Object.keys(m).join(', ') };
    } catch (e) {
      detail.subpath = { ok: false, error: e.message.split('\n')[0] };
    }
  }

  const ok =
    detail.bareSpecifier?.ok === true ||
    (detail.absoluteFileUrl?.ok === true && detail.subpath?.ok === true);
  return { ok, detail };
}
