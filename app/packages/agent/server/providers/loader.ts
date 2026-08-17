import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import os from 'os';

const PKG = '@earendil-works/pi-ai';

/** typebox — pi-ai's own dependency, and the full JSON-Schema checker behind
 *  `validateToolArgs`. It is `type: module`, has NO `main`, and reaches its
 *  `Value` module only through the `./value` key of its `exports` map, which
 *  is exactly the shape Meteor's resolver cannot follow. Same seam, same
 *  hedge. */
const TYPEBOX = 'typebox';

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

/** One namespace per package + export key (`@earendil-works/pi-ai|./providers/all`,
 *  `typebox|./value`, …). The `|` is a separator no package name contains. */
const cache = new Map<string, unknown>();

/**
 * The directory a package's own nested `node_modules` would live in, tried
 * after the hoisted layout. npm hoists `typebox` to the app's top level in
 * every install we have seen, but a version conflict with another dependency
 * would nest it under pi-ai instead — and a checker that vanishes because of
 * someone else's dependency tree is exactly the kind of silent degrade this
 * package refuses.
 */
const NESTED_BASES: Record<string, string[]> = {
  [TYPEBOX]: [path.join(...PKG.split('/'), 'node_modules')],
};

function findNodeModulesBase(pkg: string): string | null {
  const nested = NESTED_BASES[pkg] ?? [];
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    for (const c of CANDIDATE_DIRS) {
      const root = path.join(dir, c);
      if (fs.existsSync(path.join(root, ...pkg.split('/')))) return root;
      for (const n of nested) {
        const base = path.join(root, n);
        if (fs.existsSync(path.join(base, ...pkg.split('/')))) return base;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Pick the file a conditions object points at, preferring ESM. */
function pickCondition(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  const e = entry as Record<string, unknown> | null | undefined;
  const v = e?.import ?? e?.default ?? e?.require;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve one key of an `exports` map, honoring `*` patterns the way Node
 * does. pi-ai declares `"./providers/*": { import: "./dist/providers/*.js" }`,
 * which is the only way to reach `builtinModels()` — the built-in model
 * catalog is deliberately absent from the root entry so it can be tree-shaken.
 */
function resolveExportKey(exportsMap: unknown, key: string): string | undefined {
  if (typeof exportsMap === 'string') return key === '.' ? exportsMap : undefined;
  if (!exportsMap || typeof exportsMap !== 'object') return undefined;
  const map = exportsMap as Record<string, unknown>;

  // A conditions-only object (`{ import: "./x.js" }`) IS the "." target.
  const hasSubpaths = Object.keys(map).some((k) => k === '.' || k.startsWith('./'));
  if (!hasSubpaths) return key === '.' ? pickCondition(map) : undefined;

  if (map[key] !== undefined) return pickCondition(map[key]);

  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.length < prefix.length + suffix.length) continue;
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const wildcard = key.slice(prefix.length, key.length - suffix.length);
    const file = pickCondition(target);
    if (file) return file.replace('*', wildcard);
  }
  return undefined;
}

/**
 * Resolve a pi-ai entry file the way Node's own ESM resolver would, which
 * understands `exports` maps (Meteor's does not — the whole reason this file
 * exists). We do NOT use `createRequire(...).resolve()` here: that walks the
 * CJS resolution algorithm, which only honors the `require`/`node`/`default`
 * conditions — never `import`. pi-ai's package.json declares `type: module`
 * and an `exports["."]` with only `types`/`import` conditions (no `require`,
 * no `default`), so `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * even though a perfectly good ESM entry exists (verified empirically against
 * the installed package). Instead we read the package's own package.json and
 * pick its entry the same way the ESM resolver would: `exports[key].import`
 * (or `.default`), falling back to `main` for CJS-style packages.
 *
 * `subpath` selects a deep export, e.g. `'providers/all'`. Exported as a test
 * seam.
 */
export function resolvePackageEntry(pkg: string, subpath?: string): string {
  const base = findNodeModulesBase(pkg);
  if (!base) {
    throw new Error(
      `[10thfloor:agent] ${pkg} not found. Install it in your app: ` +
      `meteor npm install --save ${pkg}`,
    );
  }
  const pkgDir = path.join(base, ...pkg.split('/'));
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const key = subpath ? `./${subpath.replace(/^\.?\//, '')}` : '.';
  let rel = resolveExportKey(pkgJson.exports, key);
  if (!rel && key === '.') rel = pkgJson.main ?? 'index.js';
  if (!rel) {
    throw new Error(`[10thfloor:agent] ${pkg} does not export "${key}"`);
  }
  return path.join(pkgDir, rel);
}

/** pi-ai's entry. Kept as its own export: it is the name the M1/M2 tests and
 *  every comment in this package already use. */
export function resolvePiAiEntry(subpath?: string): string {
  return resolvePackageEntry(PKG, subpath);
}

/** typebox's entry — `resolveTypeboxEntry('value')` for the `Value` module. */
export function resolveTypeboxEntry(subpath?: string): string {
  return resolvePackageEntry(TYPEBOX, subpath);
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
 *
 * `subpath` loads a deep export instead of the root one — `'providers/all'`
 * for the built-in model catalog. Each key is cached separately.
 */
export async function loadPackage(pkg: string, subpath?: string): Promise<unknown> {
  const rel = subpath ? subpath.replace(/^\.?\//, '') : '';
  const key = `${pkg}|${rel ? `./${rel}` : '.'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const specifier = rel ? `${pkg}/${rel}` : pkg;
  let ns: unknown;
  try {
    ns = await import(specifier);
  } catch {
    const href = pathToFileURL(resolvePackageEntry(pkg, subpath)).href;
    try {
      ns = await import(href);
    } catch {
      ns = await shimLoad(href);
    }
  }
  cache.set(key, ns);
  return ns;
}

export function loadPiAi(subpath?: string): Promise<unknown> {
  return loadPackage(PKG, subpath);
}

/**
 * typebox through the same three-step hedge. `loadTypebox('value')` yields the
 * namespace whose `Value.Check` is the full JSON-Schema checker behind
 * `validateToolArgs` — see `server/tools.ts` for the probe that established
 * this is the ONLY route (pi-ai re-exports `Type`, never `Value`).
 */
export function loadTypebox(subpath?: string): Promise<unknown> {
  return loadPackage(TYPEBOX, subpath);
}

/**
 * SYNCHRONOUS: is typebox's `value` export present on disk?
 *
 * `Agent.method` registers methods synchronously and its fail-closed check
 * cannot await a dynamic import, so it asks this instead — pure `fs`, the same
 * resolution the async loader would perform, cached after the first answer.
 * A `true` here is a well-founded expectation, not a guarantee: if the import
 * itself later fails, `validateToolArgs` degrades to the structural checker
 * with one warning (which is exactly what that warning is for).
 */
let typeboxOnDisk: boolean | null = null;
export function typeboxValueResolvable(): boolean {
  if (typeboxOnDisk === null) {
    try {
      typeboxOnDisk = fs.existsSync(resolveTypeboxEntry('value'));
    } catch {
      typeboxOnDisk = false;
    }
  }
  return typeboxOnDisk;
}
