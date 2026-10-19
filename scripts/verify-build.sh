#!/usr/bin/env bash
#
# verify-build.sh — production-build verification for 10thfloor:agent and
# 10thfloor:durable.
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
#        `validateToolArgs`, and checks a rich schema in both directions — and
#        once more for `@earendil-works/pi-mcp`, the MCP client library;
#     6. the same for `10thfloor:durable`: its compiled package and loader
#        markers, Pi Durable and Chord in the relocated tree, and both browser
#        bundles carrying its client and Chord's delta module (the client
#        imports that by file path, which only a real build proves). Its probe
#        resolves Chord and pi-ai from Pi Durable's side — a copy nested under
#        it first — and checks that against Node's own lookup from Pi Durable's
#        entry file: the loader must hand the app the very copies the harness
#        imports, and where npm keeps two, the bare name is the wrong one.
#        Then it runs a whole model turn with a tool call on Pi Durable's
#        memory storage with pi-ai's faux provider, which shows the three
#        packages load and work together from this layout.
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
# KEEPING IT  VERIFY_KEEP_BUNDLE=<empty or absent directory> builds there and
#             leaves the bundle, with its npm install done, for a check that
#             goes on to boot it:
#               meteor node scripts/verify-instances.mjs <directory>/bundle
#             The directory is then the caller's to remove.
#
# NOT part of `meteor test-packages`: it needs a full production build, which is
# minutes, not milliseconds. Operators and CI run it; the test suite does not.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
PKG_NAME='10thfloor:agent'
DURABLE_NAME='10thfloor:durable'

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

command -v meteor >/dev/null 2>&1 || fail "meteor is not on PATH"
[ -d "$APP_DIR" ] || fail "no app directory at $APP_DIR"

if [ -n "${VERIFY_KEEP_BUNDLE:-}" ]; then
  # Built where the caller says, and left there: see KEEPING IT above.
  BUILD_DIR="$VERIFY_KEEP_BUNDLE"
  mkdir -p "$BUILD_DIR"
  [ -z "$(ls -A "$BUILD_DIR")" ] || fail "VERIFY_KEEP_BUNDLE names a directory that is not empty: $BUILD_DIR"
  cleanup() { :; }
else
  BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-verify-build.XXXXXX")"
  cleanup() { rm -rf "$BUILD_DIR"; }
fi
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
if ! grep -qE "^[[:space:]]*${DURABLE_NAME}([[:space:]@#]|$)" "$APP_DIR/.meteor/packages"; then
  fail "$APP_DIR/.meteor/packages does not list $DURABLE_NAME.
      Without it the bundle carries none of that package and its checks below
      would verify nothing. Add it:  (cd app && meteor add $DURABLE_NAME)"
fi
echo "app declares $DURABLE_NAME"
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
for marker in resolvePiAiEntry shimLoad CANDIDATE_DIRS '@earendil-works/pi-ai' typeboxValueResolvable \
  resolvePiMcpEntry '@earendil-works/pi-mcp'; do
  grep -qF -- "$marker" "$BUNDLED_PKG" \
    || fail "loader marker '$marker' missing from the bundle — server/providers/loader.ts
      or server/mcp/loader.ts has changed shape and the probe in this script no
      longer mirrors it."
done
echo "loader markers present (resolvePiAiEntry, shimLoad, CANDIDATE_DIRS, pi-ai, pi-mcp)"

for pkg in pi-ai pi-mcp pi-durable chord; do
  [ -d "$SERVER_DIR/npm/node_modules/@earendil-works/$pkg" ] \
    || fail "$pkg is not in the bundle at programs/server/npm/node_modules"
  echo "$pkg present at programs/server/npm/node_modules"
done

BUNDLED_DURABLE="$SERVER_DIR/packages/10thfloor_durable.js"
[ -f "$BUNDLED_DURABLE" ] || fail "the bundle carries no compiled $DURABLE_NAME ($BUNDLED_DURABLE)"
echo "compiled package: $(du -h "$BUNDLED_DURABLE" | cut -f1) $BUNDLED_DURABLE"

# The same drift guard for packages/durable/server/loader.ts, which the second
# probe below is a port of.
for marker in resolvePackageEntry shimLoad RESOLVED_FROM CANDIDATE_DIRS \
  '@earendil-works/pi-durable' '@earendil-works/chord'; do
  grep -qF -- "$marker" "$BUNDLED_DURABLE" \
    || fail "loader marker '$marker' missing from the bundle — packages/durable/server/loader.ts
      has changed shape and the durable probe in this script no longer mirrors it."
done
echo "durable loader markers present (resolvePackageEntry, shimLoad, RESOLVED_FROM, pi-durable, chord)"

# The browser half. The client reaches Chord's delta module by file path,
# because the browser bundler follows no exports map either; whether that
# survives a production build, its minifier, and the legacy target is something
# only a production build shows. The markers are string literals, which a
# minifier keeps: the publication's name, and an error message of Chord's.
for arch in web.browser web.browser.legacy; do
  CLIENT_JS="$(find "$BUILD_DIR/bundle/programs/$arch" -maxdepth 1 -name '*.js' | head -1)"
  [ -n "$CLIENT_JS" ] || fail "no client bundle for $arch in the build output"
  grep -qF -- 'durable.conversation' "$CLIENT_JS" \
    || fail "the $arch bundle carries no $DURABLE_NAME client"
  grep -qF -- 'unknown op verb' "$CLIENT_JS" \
    || fail "the $arch bundle carries no Chord delta module: the client's import of
      @earendil-works/chord/dist/delta/index.js did not survive the build"
  echo "$arch bundle carries the durable client and Chord's delta module"
done

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

/*
 * The MCP client library through the same chain. pi-mcp is ESM-only, its
 * exports map carries a `source` condition beside `import`, and it brings one
 * dependency of its own (cross-spawn) that has to resolve from the relocated
 * tree too — importing the entry proves all three at once. An app that never
 * registers an MCP server never loads this, so nothing else in a deployment
 * would notice it missing until the first tool call.
 */
const MCP = '@earendil-works/pi-mcp';
const mcpEntry = resolvePackageEntry(MCP);
if (!fs.existsSync(mcpEntry)) die(`pi-mcp entry does not exist: ${mcpEntry}`);
if (!mcpEntry.endsWith(path.join('dist', 'index.js'))) {
  die(`pi-mcp resolved to an entry other than its built one: ${mcpEntry}`);
}
console.log(`pi-mcp "."            : ${path.relative(findNodeModulesBase(MCP), mcpEntry)}`);

const mcpUrl = pathToFileURL(mcpEntry).href;
const mcpOutcomes = [];
for (const [label, fn] of [
  ['1 bare import', () => import(MCP)],
  ['2 URL import', () => import(mcpUrl)],
  ['3 temp shim', () => shimLoad(mcpUrl)],
]) {
  try { mcpOutcomes.push({ label, ok: true, ns: await fn() }); } catch (e) {
    mcpOutcomes.push({ label, ok: false, why: String(e?.code || e?.message || e).slice(0, 140) });
  }
}
for (const o of mcpOutcomes) {
  console.log(`pi-mcp branch ${o.label.padEnd(16)} ${o.ok ? 'ok' : `fail  (${o.why})`}`);
}
const mcpWinner = mcpOutcomes.find((o) => o.ok);
if (!mcpWinner) die('no loader branch resolved pi-mcp in the production bundle');
if (typeof mcpWinner.ns.McpClient !== 'function'
    || typeof mcpWinner.ns.StdioTransport !== 'function') {
  die('pi-mcp exposes no McpClient/StdioTransport');
}
console.log('McpClient/StdioTransport: load, with their own dependency resolved');

console.log(`WINNING LOADER BRANCH : ${winner.label.trim()}  (typebox: ${tbWinner.label.trim()}, pi-mcp: ${mcpWinner.label.trim()})`);
PROBE_EOF

# `meteor node` is Meteor's own dev-bundle Node — the version the bundle is
# built for, and the one a `meteor`-managed deploy runs it under.
( cd "$SERVER_DIR" && meteor node agent-loader-probe.mjs )

step "Durable probe (cwd = programs/server): the loader chain, then a whole turn on Pi Durable"
cat >"$SERVER_DIR/durable-loader-probe.mjs" <<'DURABLE_PROBE_EOF'
/*
 * A port of packages/durable/server/loader.ts, run as a real ESM module against
 * the built bundle, for the same reason as the probe above. That loader differs
 * from the agent's in one rule: Chord and pi-ai are resolved from Pi Durable's
 * side, a copy nested under it first. The rule is checked here against Node's
 * own algorithm, and then the three packages are made to work together.
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const DURABLE = '@earendil-works/pi-durable';
const CHORD = '@earendil-works/chord';
const PI_AI = '@earendil-works/pi-ai';
const CANDIDATE_DIRS = ['node_modules', path.join('npm', 'node_modules')];
const RESOLVED_FROM = { [CHORD]: DURABLE, [PI_AI]: DURABLE };

function findNodeModulesBase(pkg, from = process.cwd()) {
  const dependent = RESOLVED_FROM[pkg];
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    for (const c of CANDIDATE_DIRS) {
      const root = path.join(dir, c);
      if (dependent !== undefined) {
        const nested = path.join(root, ...dependent.split('/'), 'node_modules');
        if (fs.existsSync(path.join(nested, ...pkg.split('/')))) return nested;
      }
      if (fs.existsSync(path.join(root, ...pkg.split('/')))) return root;
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

async function shimLoad(urlHref) {
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

const die = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

const base = findNodeModulesBase(DURABLE);
if (!base) die('findNodeModulesBase() found no pi-durable in the built bundle');
if (!base.endsWith(path.join('npm', 'node_modules'))) {
  die(`resolved a dev-layout node_modules (${base}); this probe is not exercising the production path`);
}
console.log(`node_modules base     : ${base}`);

/*
 * What Node itself does when a file of Pi Durable imports a bare name: look in
 * `node_modules` of each directory from that file upward. Written out here
 * without reference to the rule above, so that the two can disagree.
 */
function asNodeResolves(pkg, fromFile) {
  for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...pkg.split('/'));
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

const durableEntry = resolvePackageEntry(DURABLE);
for (const pkg of [CHORD, PI_AI]) {
  const ours = fs.realpathSync(path.join(findNodeModulesBase(pkg), ...pkg.split('/')));
  const nodes = asNodeResolves(pkg, durableEntry);
  if (ours !== nodes) die(`${pkg}: the loader takes ${ours}, but Pi Durable itself imports ${nodes}`);
  const nested = ours.includes(path.join('pi-durable', 'node_modules'));
  console.log(`${pkg.padEnd(22)}: ${nested ? 'nested under pi-durable' : 'shared copy'}, the one Pi Durable imports`);
}

const wanted = [
  [DURABLE, undefined], [DURABLE, 'testing'], [CHORD, 'context'], [CHORD, 'delta'],
  [PI_AI, undefined], [PI_AI, 'models'], [PI_AI, 'providers/faux'],
];
const entries = new Map();
for (const [pkg, subpath] of wanted) {
  const entry = resolvePackageEntry(pkg, subpath);
  if (!fs.existsSync(entry)) die(`${pkg}${subpath ? `/${subpath}` : ''} resolved to a file that does not exist: ${entry}`);
  entries.set(`${pkg}|${subpath ?? ''}`, entry);
  console.log(`exports ${`${pkg.split('/')[1]}${subpath ? `/${subpath}` : ''}`.padEnd(22)}: ${path.relative(base, entry)}`);
}

// Every branch of the loader, for Pi Durable itself. The first that works is the one the package takes.
const durableUrl = pathToFileURL(durableEntry).href;
const outcomes = [];
for (const [label, fn] of [
  ['1 bare import', () => import(DURABLE)],
  ['2 URL import', () => import(durableUrl)],
  ['3 temp shim', () => shimLoad(durableUrl)],
]) {
  try { outcomes.push({ label, ok: true, ns: await fn() }); } catch (e) {
    outcomes.push({ label, ok: false, why: String(e?.code || e?.message || e).slice(0, 140) });
  }
}
for (const o of outcomes) console.log(`pi-durable branch ${o.label.padEnd(14)} ${o.ok ? 'ok' : `fail  (${o.why})`}`);
const winner = outcomes.find((o) => o.ok);
if (!winner) die('no loader branch resolved pi-durable in the production bundle');
const durable = winner.ns;
if (typeof durable.Harness?.open !== 'function') die('pi-durable exposes no Harness.open');
for (const name of ['MemoryStorage', 'StorageRejected', 'createRegistry', 'defineExtension', 'defineTool']) {
  if (typeof durable[name] !== 'function') die(`pi-durable exposes no ${name}`);
}

// Chord and pi-ai go by path only; the bare name could mean another copy.
const byPath = async (pkg, subpath) => {
  const href = pathToFileURL(entries.get(`${pkg}|${subpath ?? ''}`)).href;
  try { return await import(href); } catch { return shimLoad(href); }
};
const testing = await byPath(DURABLE, 'testing');
if (typeof testing.createStorageConformance !== 'function') die('pi-durable/testing exposes no createStorageConformance');
const context = (await byPath(CHORD, 'context')).BACKGROUND_CONTEXT;
if (!context) die('chord/context exposes no BACKGROUND_CONTEXT');
const { apply, applyImmutable } = await byPath(CHORD, 'delta');
if (typeof apply !== 'function' || typeof applyImmutable !== 'function') die('chord/delta exposes no apply/applyImmutable');
const before = { n: 1 };
if (applyImmutable(before, [['s', ['n'], 2]]).n !== 2 || before.n !== 1) die('applyImmutable does not apply a set, or mutates its input');
const { Type } = await byPath(PI_AI);
const { createModels } = await byPath(PI_AI, 'models');
const faux = await byPath(PI_AI, 'providers/faux');
if (typeof Type?.Object !== 'function' || typeof createModels !== 'function' || typeof faux.fauxProvider !== 'function') {
  die('pi-ai exposes no Type/createModels/fauxProvider');
}
console.log('namespaces            : pi-durable, pi-durable/testing, chord/context, chord/delta, pi-ai, pi-ai/models, pi-ai/providers/faux');

/*
 * One whole turn: input, a model request, a tool call, its result, the answer.
 * Every commit goes through Chord's documents and the request through pi-ai's
 * catalog, so the three packages have to load and fit together from here.
 * (Whether they are the same copies is the comparison above; two copies of one
 * version pass a turn.)
 */
const provider = faux.fauxProvider();
const models = createModels();
models.setProvider(provider.provider);
provider.setResponses([
  faux.fauxAssistantMessage([faux.fauxToolCall('add', { a: 2, b: 3 })], { stopReason: 'toolUse' }),
  faux.fauxAssistantMessage('It is 5.'),
]);
const registry = durable.createRegistry();
registry.install(durable.defineExtension({
  name: 'math',
  tools: [durable.defineTool({
    name: 'add',
    description: 'Add two numbers',
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    replay: 'safe',
    execute: async (args) => ({ content: [{ type: 'text', text: String(args.a + args.b) }] }),
  })],
}));
const textOf = (message) => (typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).flatMap((part) => (part?.type === 'text' ? [part.text] : [])).join(''));

const turn = (async () => {
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  const submission = await root.submit({ type: 'input', content: 'What is 2 + 3?' }, context);
  const settled = await submission.wait(context);
  const page = await root.entries({}, 20, undefined, context);
  await harness.close(context);
  return { settled, entries: [...page.items].reverse() };
})();
const result = await Promise.race([
  turn,
  new Promise((resolve) => setTimeout(() => resolve(null), 30_000)),
]);
if (result === null) die('the turn did not finish in 30 s');
if (result.settled.status !== 'done') die(`the submission settled as ${JSON.stringify(result.settled)}`);
const kinds = result.entries.map((entry) => entry.kind).filter((kind) => kind !== 'pi.system');
if (JSON.stringify(kinds) !== JSON.stringify(['pi.user', 'pi.assistant', 'pi.tool-result', 'pi.assistant'])) {
  die(`unexpected transcript: ${JSON.stringify(kinds)}`);
}
const toolResult = textOf(result.entries.find((entry) => entry.kind === 'pi.tool-result')?.model?.[0]);
const answer = textOf(result.entries[result.entries.length - 1].model?.[0]);
if (toolResult !== '5' || answer !== 'It is 5.') die(`unexpected turn: tool said ${JSON.stringify(toolResult)}, model said ${JSON.stringify(answer)}`);
console.log(`a whole turn          : ok (tool result "${toolResult}", answer "${answer}")`);
console.log(`WINNING LOADER BRANCH : ${winner.label.trim()}`);
process.exit(0);
DURABLE_PROBE_EOF

( cd "$SERVER_DIR" && meteor node durable-loader-probe.mjs )

step "PASS — the production bundle carries both packages; their loader chains resolve pi-ai, typebox, pi-mcp, pi-durable and chord; a Pi Durable turn runs from it"
