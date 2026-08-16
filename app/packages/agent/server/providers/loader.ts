import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import os from 'os';

const PKG = '@earendil-works/pi-ai';

/**
 * Meteor cannot resolve pi-ai's transitive dep `typebox` (no `main`, exports
 * map only). We reach Node's own resolver through a one-line ESM shim: a real
 * ESM module HAS a dynamic-import callback, which Meteor's CJS server bundle
 * does not.
 *
 * Dev places app npm deps in `node_modules`; a production `meteor build` places
 * them in `npm/node_modules`. Both are searched.
 */
const CANDIDATE_DIRS = ['node_modules', path.join('npm', 'node_modules')];

let cached: unknown = null;

function findNodeModulesBase(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    for (const c of CANDIDATE_DIRS) {
      if (fs.existsSync(path.join(dir, c, ...PKG.split('/')))) return path.join(dir, c);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve pi-ai's entry file the way Node's own ESM resolver would, which
 * understands `exports` maps (Meteor's does not — the whole reason this file
 * exists). We do NOT use `createRequire(...).resolve()` here: that walks the
 * CJS resolution algorithm, which only honors the `require`/`node`/`default`
 * conditions — never `import`. pi-ai's package.json declares `type: module`
 * and an `exports["."]` with only `types`/`import` conditions (no `require`,
 * no `default`), so `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * even though a perfectly good ESM entry exists (verified empirically against
 * the installed package). Instead we read the package's own package.json and
 * pick its entry the same way the ESM resolver would: `exports["."].import`
 * (or `.default`), falling back to `main` for CJS-style packages.
 * Exported as a test seam.
 */
export function resolvePiAiEntry(): string {
  const base = findNodeModulesBase();
  if (!base) {
    throw new Error(
      `[10thfloor:agent] ${PKG} not found. Install it in your app: ` +
      `meteor npm install --save ${PKG}`,
    );
  }
  const pkgDir = path.join(base, ...PKG.split('/'));
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const rootExport = pkgJson.exports?.['.'] ?? pkgJson.exports;
  const rel =
    (typeof rootExport === 'string' ? rootExport : rootExport?.import ?? rootExport?.default ?? rootExport?.require) ??
    pkgJson.main ??
    'index.js';
  return path.join(pkgDir, rel);
}

/**
 * Import an absolute file:// URL through a genuine ESM module. The shim lives
 * in the OS temp dir — always writable, unlike node_modules on a read-only
 * container filesystem (the M1 shim's fatal flaw). Because it receives a
 * RESOLVED URL rather than a bare specifier, the shim's own location has no
 * bearing on resolution, which is what makes the temp dir usable at all.
 */
export async function shimLoad(urlHref: string): Promise<unknown> {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loader-'));
  const shimPath = path.join(shimDir, 'loader.mjs');
  fs.writeFileSync(shimPath, 'export const load = (u) => import(u);\n');
  try {
    const shim = createRequire(shimPath)(shimPath);
    return await shim.load(urlHref);
  } finally {
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

/**
 * Hedged, in order of preference:
 *  1. plain dynamic import of the bare specifier — becomes the only path the
 *     day Meteor ships `exports` support (PR #13520);
 *  2. dynamic import of the resolved file:// URL — works today in dev, no
 *     writes anywhere;
 *  3. temp-dir shim around the same URL — for a runtime whose import() is
 *     intercepted.
 * Returns the module namespace AS-IS (live bindings preserved); callers must
 * not mutate it.
 */
export async function loadPiAi(): Promise<unknown> {
  if (cached) return cached;
  try {
    cached = await import(PKG);
  } catch {
    const href = pathToFileURL(resolvePiAiEntry()).href;
    try {
      cached = await import(href);
    } catch {
      cached = await shimLoad(href);
    }
  }
  return cached;
}
