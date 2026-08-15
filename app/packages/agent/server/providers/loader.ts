import path from 'path';
import fs from 'fs';

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

async function shimLoad(specifier: string): Promise<unknown> {
  const base = findNodeModulesBase();
  if (!base) {
    throw new Error(
      `[10thfloor:agent] ${PKG} not found. Install it in your app: ` +
      `meteor npm install --save ${PKG}`,
    );
  }
  const shimDir = path.join(base, '.agent-loader');
  const shimPath = path.join(shimDir, 'loader.mjs');
  if (!fs.existsSync(shimPath)) {
    fs.mkdirSync(shimDir, { recursive: true });
    // Fixed literal. The specifier is always a package-controlled constant and
    // must never come from user input or model output.
    fs.writeFileSync(shimPath, 'export const load = (s) => import(s);\n');
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createRequire } = require('module');
  const shim = createRequire(shimPath)(shimPath);
  return shim.load(specifier);
}

/** Hedged: plain import first, so the shim disappears once Meteor ships
 *  `exports` support (PR #13520). Falls back to the shim on any failure. */
export async function loadPiAi(): Promise<unknown> {
  if (cached) return cached;
  let ns: unknown;
  try {
    ns = await import(PKG);
  } catch {
    ns = await shimLoad(PKG);
  }
  // Both paths resolve through a dynamic import(), which yields a Module
  // Namespace Exotic Object (Symbol.toStringTag === 'Module', not 'Object').
  // Copy its own enumerable bindings into a plain object so consumers get an
  // ordinary namespace rather than a foreign exotic type.
  cached = { ...(ns as Record<string, unknown>) };
  return cached;
}
