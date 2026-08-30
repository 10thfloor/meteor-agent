#!/usr/bin/env bash
#
# verify-build.sh — production-build verification for 10thfloor:agent.
#
# WHAT IT PROVES
#   `meteor test-packages` runs the harness out of the app's dev `node_modules`.
#   Production is a different world: `meteor build` relocates the app's npm
#   dependencies to `programs/server/npm/node_modules`, which is NOT on Node's
#   bare-specifier resolution path, and the package's own code is compiled into
#   Meteor's CJS bundle where `import()` of an `exports`-map package cannot work.
#   `server/providers/loader.ts` exists entirely because of that gap. This script
#   builds the app for production and re-runs the loader's resolution chain
#   against the REAL bundle layout, reporting which of its three hedged branches
#   actually wins there.
#
#   Checks, in order:
#     1. the app declares `10thfloor:agent`, so the bundle really carries it;
#     2. `meteor build --directory <tmp> --server-only` succeeds;
#     3. the built bundle contains the compiled package AND the loader's own
#        source markers (a drift guard: the probe below mirrors that file, so a
#        loader that no longer ships as described must fail loudly here);
#     4. `npm install` inside `programs/server` — the documented deploy step;
#     5. a probe run with cwd = `programs/server` (the server's own cwd at boot)
#        walks `findNodeModulesBase()`, resolves pi-ai's `exports` map for both
#        the root entry and the `providers/*` wildcard, then tries each loader
#        branch — bare import, absolute-file-URL import, temp-dir shim — and
#        asserts pi-ai's namespace loads, `Type` builds a schema, and
#        `builtinModels()` returns a usable model — then repeats the whole
#        chain for `typebox/value`, the full JSON-Schema checker behind
#        `validateToolArgs`, and checks a rich schema in both directions.
#
# WHAT IT DOES NOT NEED
#   No Mongo, no app boot, no listening port (so it cannot collide with anything
#   already holding 3000/3200), no API key, no network beyond whatever `npm
#   install` fetches for the bundle's own dependencies. The loader chain is a
#   pure function of the built directory layout, so plain Node exercises it.
#
# USAGE       ./scripts/verify-build.sh
# RUNTIME     ~3-5 minutes, dominated by `meteor build` (a cold Meteor build can
#             exceed that; the npm install and the probe take seconds).
# EXIT        0 = every check passed; non-zero = a failed check, with the reason
#             on stderr. Idempotent: everything is written under a fresh mktemp
#             directory that is removed on exit, success or failure. Nothing in
#             the repo is modified.
#
# NOT part of `meteor test-packages`: it needs a full production build, which is
# minutes, not milliseconds. Operators and CI run it; the test suite does not.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
PKG_NAME='10thfloor:agent'

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

command -v meteor >/dev/null 2>&1 || fail "meteor is not on PATH"
[ -d "$APP_DIR" ] || fail "no app directory at $APP_DIR"

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-verify-build.XXXXXX")"
cleanup() { rm -rf "$BUILD_DIR"; }
# EXIT alone does not fire when the shell is signalled, and a killed run must
# not leave a multi-hundred-megabyte bundle behind.
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

step "Preconditions"
if ! grep -qE "^[[:space:]]*${PKG_NAME}([[:space:]@#]|$)" "$APP_DIR/.meteor/packages"; then
  fail "$APP_DIR/.meteor/packages does not list $PKG_NAME.
      Without it, 'meteor build' produces a bundle with no agent code at all and
      this script would verify nothing. Add it:  (cd app && meteor add $PKG_NAME)"
fi
echo "app declares $PKG_NAME"
echo "build dir: $BUILD_DIR"

step "meteor build --directory --server-only (this is the slow part)"
( cd "$APP_DIR" && meteor build --directory "$BUILD_DIR" --server-only )

SERVER_DIR="$BUILD_DIR/bundle/programs/server"
[ -d "$SERVER_DIR" ] || fail "no $SERVER_DIR in the build output"

step "Bundle contents"
BUNDLED_PKG="$SERVER_DIR/packages/10thfloor_agent.js"
[ -f "$BUNDLED_PKG" ] || fail "the bundle carries no compiled $PKG_NAME ($BUNDLED_PKG)"
echo "compiled package: $(du -h "$BUNDLED_PKG" | cut -f1) $BUNDLED_PKG"

# Drift guard. The probe below is a port of server/providers/loader.ts; these
# markers assert the shipped bundle still contains the code it is a port OF.
for marker in resolvePiAiEntry shimLoad CANDIDATE_DIRS '@earendil-works/pi-ai' typeboxValueResolvable; do
  grep -qF -- "$marker" "$BUNDLED_PKG" \
    || fail "loader marker '$marker' missing from the bundle — server/providers/loader.ts
      has changed shape and the probe in this script no longer mirrors it."
done
echo "loader markers present (resolvePiAiEntry, shimLoad, CANDIDATE_DIRS, pi-ai)"

[ -d "$SERVER_DIR/npm/node_modules/@earendil-works/pi-ai" ] \
  || fail "pi-ai is not in the bundle at programs/server/npm/node_modules"
echo "pi-ai present at programs/server/npm/node_modules"

step "npm install inside the bundle (programs/server)"
NPM_LOG="$BUILD_DIR/npm-install.log"
if ! ( cd "$SERVER_DIR" && meteor npm install --no-audit --no-fund ) >"$NPM_LOG" 2>&1; then
  tail -40 "$NPM_LOG" >&2
  fail "npm install failed inside the bundle (full log was $NPM_LOG)"
fi
grep -E 'added|changed|up to date' "$NPM_LOG" | tail -2 || true

step "Loader-chain probe (cwd = programs/server, no Mongo, no boot, no port)"
cat >"$SERVER_DIR/agent-loader-probe.mjs" <<'PROBE_EOF'
/*
 * A port of packages/agent/server/providers/loader.ts, run as a REAL ESM module
 * against the built bundle. The package's own copy is compiled into Meteor's CJS
 * bundle and is not loadable without booting the app (which would need Mongo),
 * so the chain is reproduced here verbatim and the calling script asserts the
 * bundle still contains the source it mirrors. Every branch is attempted
 * independently so the report can say which ones work in production, not merely
 * that one did.
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const PKG = '@earendil-works/pi-ai';
const TYPEBOX = 'typebox';
const CANDIDATE_DIRS = ['node_modules', path.join('npm', 'node_modules')];
const NESTED_BASES = { [TYPEBOX]: [path.join(...PKG.split('/'), 'node_modules')] };

function findNodeModulesBase(pkg = PKG) {
  const nested = NESTED_BASES[pkg] ?? [];
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    for (const c of CANDIDATE_DIRS) {
      const root = path.join(dir, c);
      if (fs.existsSync(path.join(root, ...pkg.split('/')))) return root;
      for (const n of nested) {
        const b = path.join(root, n);
        if (fs.existsSync(path.join(b, ...pkg.split('/')))) return b;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function pickCondition(entry) {
  if (typeof entry === 'string') return entry;
  const v = entry?.import ?? entry?.default ?? entry?.require;
  return typeof v === 'string' ? v : undefined;
}

function resolveExportKey(map, key) {
  if (typeof map === 'string') return key === '.' ? map : undefined;
  if (!map || typeof map !== 'object') return undefined;
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

function resolvePackageEntry(pkg, subpath) {
  const base = findNodeModulesBase(pkg);
  if (!base) throw new Error(`${pkg} not found walking up from ${process.cwd()}`);
  const pkgDir = path.join(base, ...pkg.split('/'));
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const key = subpath ? `./${subpath.replace(/^\.?\//, '')}` : '.';
  let rel = resolveExportKey(pkgJson.exports, key);
  if (!rel && key === '.') rel = pkgJson.main ?? 'index.js';
  if (!rel) throw new Error(`${pkg} does not export "${key}"`);
  return path.join(pkgDir, rel);
}

const resolvePiAiEntry = (subpath) => resolvePackageEntry(PKG, subpath);

async function shimLoad(urlHref) {
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

const die = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

console.log(`cwd                   : ${process.cwd()}`);
console.log(`node                  : ${process.version}`);

const base = findNodeModulesBase();
if (!base) die('findNodeModulesBase() found no pi-ai in the built bundle');
console.log(`node_modules base     : ${base}`);
const prodLayout = base.endsWith(path.join('npm', 'node_modules'));
console.log(`layout                : ${prodLayout ? 'production (npm/node_modules)' : 'DEV (plain node_modules)'}`);
if (!prodLayout) {
  die('resolved a dev-layout node_modules; this probe is not exercising the production path');
}

const rootEntry = resolvePiAiEntry();
const allEntry = resolvePiAiEntry('providers/all');
const openAICompletionsEntry = resolvePiAiEntry('api/openai-completions.lazy');
if (!path.isAbsolute(rootEntry)) die(`root entry is not absolute: ${rootEntry}`);
if (!fs.existsSync(rootEntry)) die(`root entry does not exist: ${rootEntry}`);
if (!fs.existsSync(allEntry)) die(`providers/all entry does not exist: ${allEntry}`);
if (!fs.existsSync(openAICompletionsEntry)) {
  die(`api/openai-completions.lazy entry does not exist: ${openAICompletionsEntry}`);
}
const rel = (p) => path.relative(base, p);
console.log(`exports "."           : ${rel(rootEntry)}`);
console.log(`exports providers/*   : ${rel(allEntry)}`);
console.log(`exports api/*         : ${rel(openAICompletionsEntry)}`);

const outcomes = [];
async function attempt(label, fn) {
  try {
    const ns = await fn();
    outcomes.push({ label, ok: true, ns });
    return ns;
  } catch (e) {
    outcomes.push({ label, ok: false, why: String(e?.code || e?.message || e).slice(0, 140) });
    return null;
  }
}

const rootUrl = pathToFileURL(rootEntry).href;
// Attempted in the loader's own preference order.
await attempt('1 bare import', () => import(PKG));
await attempt('2 URL import', () => import(rootUrl));
await attempt('3 temp shim', () => shimLoad(rootUrl));
const nsAll = await attempt('  providers/all (URL)', () => import(pathToFileURL(allEntry).href));
const nsOpenAICompletions = await attempt(
  '  openai-completions.lazy',
  () => import(pathToFileURL(openAICompletionsEntry).href),
);

for (const o of outcomes) {
  console.log(`branch ${o.label.padEnd(22)} ${o.ok ? 'ok' : `fail  (${o.why})`}`);
}

// The loader takes the FIRST branch that works, so the winner is the first ok
// among the three numbered ones (the providers/all attempt is a separate check).
const winner = outcomes.find((o) => o.ok && /^\d/.test(o.label));
if (!winner) die('no loader branch resolved pi-ai in the production bundle');

const ns = winner.ns;
if (typeof ns.Type?.Object !== 'function') die('pi-ai namespace has no usable Type (typebox did not load)');
const schema = ns.Type.Object({ orderId: ns.Type.String() });
if (schema.type !== 'object' || schema.required?.[0] !== 'orderId') {
  die(`Type produced an unexpected schema: ${JSON.stringify(schema)}`);
}
console.log(`Type.Object()         : ok (${JSON.stringify(schema.required)})`);

if (!nsAll || typeof nsAll.builtinModels !== 'function') die('providers/all did not expose builtinModels()');
const model = nsAll.builtinModels().getModel('anthropic', 'claude-sonnet-5');
if (!model) die('builtinModels() has no anthropic/claude-sonnet-5');
console.log(`builtinModels()       : anthropic/claude-sonnet-5 -> api=${model.api}`);

if (!nsOpenAICompletions || typeof nsOpenAICompletions.openAICompletionsApi !== 'function') {
  die('api/openai-completions.lazy did not expose openAICompletionsApi()');
}
const openAICompletionsApi = nsOpenAICompletions.openAICompletionsApi();
if (typeof openAICompletionsApi?.stream !== 'function'
    || typeof openAICompletionsApi?.streamSimple !== 'function') {
  die('openAICompletionsApi() did not produce usable ProviderStreams');
}
console.log('openAICompletionsApi(): usable lazy ProviderStreams');

/*
 * M4: the same chain against typebox's `./value` export, which is what
 * `validateToolArgs` uses for full JSON-Schema checking. This matters MORE in
 * production than pi-ai does: if typebox is missing here, validation silently
 * narrows to the structural checker and `Agent.method` starts refusing rich
 * schemas at boot — a failure that dev never reproduces, because dev's
 * node_modules always has it.
 */
const valueEntry = resolvePackageEntry(TYPEBOX, 'value');
if (!fs.existsSync(valueEntry)) die(`typebox/value entry does not exist: ${valueEntry}`);
console.log(`typebox base          : ${findNodeModulesBase(TYPEBOX)}`);
console.log(`typebox "./value"     : ${valueEntry}`);

const valueUrl = pathToFileURL(valueEntry).href;
const tbOutcomes = [];
for (const [label, fn] of [
  ['1 bare import', () => import(`${TYPEBOX}/value`)],
  ['2 URL import', () => import(valueUrl)],
  ['3 temp shim', () => shimLoad(valueUrl)],
]) {
  try { tbOutcomes.push({ label, ok: true, ns: await fn() }); } catch (e) {
    tbOutcomes.push({ label, ok: false, why: String(e?.code || e?.message || e).slice(0, 140) });
  }
}
for (const o of tbOutcomes) {
  console.log(`typebox branch ${o.label.padEnd(15)} ${o.ok ? 'ok' : `fail  (${o.why})`}`);
}
const tbWinner = tbOutcomes.find((o) => o.ok);
if (!tbWinner) die('no loader branch resolved typebox/value in the production bundle');
const V = tbWinner.ns.Value ?? tbWinner.ns;
if (typeof V.Check !== 'function' || typeof V.Errors !== 'function') {
  die('typebox/value exposes no Check/Errors');
}
// The exact capability the default validator claims: plain JSON Schema, rich
// keywords, both directions.
const rich = { type: 'object', properties: { op: { type: 'string', enum: ['a', 'b'] } }, required: ['op'] };
if (!V.Check(rich, { op: 'a' })) die('Value.Check rejected a valid rich-schema argument');
if (V.Check(rich, { op: 'z' })) die('Value.Check accepted an out-of-enum argument');
console.log(`Value.Check(enum)     : ok (accepts "a", rejects "z")`);

console.log(`WINNING LOADER BRANCH : ${winner.label.trim()}  (typebox: ${tbWinner.label.trim()})`);
PROBE_EOF

# `meteor node` is Meteor's own dev-bundle Node — the version the bundle is
# built for, and the one a `meteor`-managed deploy runs it under.
( cd "$SERVER_DIR" && meteor node agent-loader-probe.mjs )

step "PASS — the production bundle carries the agent and its loader chain resolves pi-ai"
