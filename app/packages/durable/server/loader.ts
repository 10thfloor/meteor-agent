import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import os from 'os';

// Pi Durable, Chord and pi-ai publish their entry points only through
// `exports` maps, which Meteor's resolver does not follow. This is the same
// seam `10thfloor:agent` uses for pi-ai (server/providers/loader.ts), kept
// here so this package depends on nothing but the npm modules themselves.

/** Dev uses `node_modules`; production `meteor build` uses `npm/node_modules`. */
const CANDIDATE_DIRS = ['node_modules', path.join('npm', 'node_modules')];

/** One namespace per package + export key. The `|` is a separator no package name contains. */
const cache = new Map<string, unknown>();

function findNodeModulesBase(pkg: string): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    for (const c of CANDIDATE_DIRS) {
      const root = path.join(dir, c);
      if (fs.existsSync(path.join(root, ...pkg.split('/')))) return root;
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

/** Resolve one key of an exports map, including `*` wildcard patterns. */
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

/** Resolve a package entry through its exports map (Meteor's resolver can't). */
export function resolvePackageEntry(pkg: string, subpath?: string): string {
  const base = findNodeModulesBase(pkg);
  if (!base) {
    throw new Error(
      `[10thfloor:durable] ${pkg} not found. Install it in your app: ` +
      `meteor npm install --save ${pkg}`,
    );
  }
  const pkgDir = path.join(base, ...pkg.split('/'));
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const key = subpath ? `./${subpath.replace(/^\.?\//, '')}` : '.';
  let rel = resolveExportKey(pkgJson.exports, key);
  if (!rel && key === '.') rel = pkgJson.main ?? 'index.js';
  if (!rel) {
    throw new Error(`[10thfloor:durable] ${pkg} does not export "${key}"`);
  }
  return path.join(pkgDir, rel);
}

/** Import a file:// URL through a temp ESM shim (Meteor's CJS bundle has no
 *  dynamic import). Shim lives in tmpdir so it works on read-only filesystems. */
async function shimLoad(urlHref: string): Promise<unknown> {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-loader-'));
  const shimPath = path.join(shimDir, 'loader.mjs');
  fs.writeFileSync(shimPath, 'export const load = (u) => import(u);\n');
  try {
    const shim = createRequire(shimPath)(shimPath);
    return await shim.load(urlHref);
  } finally {
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

/** Three-step hedge: bare import → file:// URL → temp shim. Cached per subpath. */
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
