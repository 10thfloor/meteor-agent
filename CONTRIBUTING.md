# Contributing

## Layout

- `app/packages/agent` — the core package (`10thfloor:agent`).
- `app/packages/agent-channel-*` — the five optional channel packages.
- `app/packages/durable` — Pi Durable on Meteor (`10thfloor:durable`):
  experimental, and independent of the core in both directions.
- `app/` — the host app: test harness, and the demo chat UI (`meteor run` it).
  It declares every package of the Release set, so the production bundle
  check covers all of them.
- `docs/superpowers/specs/` — historical design records. The source and tests
  are authoritative where a record describes an earlier release.
- `scripts/verify-build.sh` — production-bundle verification (see README).
- `release.json` — the seven-package Release set, candidate version, and
  current public documentation tag. A package's role is `core`, `channel`, or
  `runtime` (depends on neither of the others).
- `CONTEXT.md` — current domain language and Module ownership.

From `app/`, install dependencies with `meteor npm ci` and run the static gates:

```bash
npm run typecheck
npm run release:check
npm run types:check
```

`types:check` regenerates the declarations shipped by every package of the
Release set and fails if the committed output has drifted, including when
generation creates a new untracked declaration. It then compiles
`app/tests/consumer-types.ts` against those declarations alone, as a vendored
consumer receives them.

For a stable promotion, update `packageVersion`, `stableTag`, package pins, and
the documented stable links together in the PR. `release:check` permits that
future stable tag to be absent while the PR is under CI. Create the tag only
after the promotion has merged; tag CI then requires the tag to match
`packageVersion` and verifies that `stableTag` resolves.

## Running the suite

From `app/` (port 3200 — 3000 is often taken; a blocked port hangs silently),
`npm test` runs the same command as CI:

```bash
npm test
```

The package set in `release.json` is checked against the literal Meteor
descriptors, core dependency pins, MCP runtime identity, shipped declaration
entries, and this test command. Running the core alone can pass while a surface
package is broken, so CI calls this same `npm test` entry point.

Budget 3–5 minutes. The client half needs Playwright's Chromium
(`npx playwright install chromium`). Live smoke tests remain pending unless
their opt-in environment is present: pi-ai uses `ANTHROPIC_API_KEY`, and MCP
uses `MCP_LIVE_TEST=1`.

The example app carries a second, full-app suite (`app/tests/main.js` — the
Constellation learning control plane: owner gating, hardening evidence, crew
archive). CI runs it as its own job; locally:

```bash
meteor npm run test-app:once
```

A test entry point no CI job executes is coverage that does not exist — the
control-plane suite ran only on developers' machines until this job landed.

`scripts/verify-instances.mjs` is the one check that boots a production
bundle: two server processes on one MongoDB (Meteor's own `mongod`, started
and removed by the script), driven over DDP. It needs a bundle with its
`npm install` done, which `verify-build.sh` leaves behind when asked:

```bash
VERIFY_KEEP_BUNDLE=/tmp/verify-bundle ./scripts/verify-build.sh
(cd app && meteor node ../scripts/verify-instances.mjs /tmp/verify-bundle/bundle)
```

In one checkout, run the full-app suite and `verify-build.sh` **before**
`npm test`, or run `meteor npm ci` in between. `meteor test-packages` replaces
`app/node_modules/@swc/helpers` with links into its temporary test directory
and then removes that directory; the next app boot or build in the same
checkout cannot find `@swc/helpers/_/…`. CI runs each in its own checkout.

The app's own MCP server (`app/mcp/workspace-server.mjs`) is written against
the protocol with no server library, so it carries wire-format tests of its own:
raw JSON-RPC over a real subprocess's stdio, on plain `node:test`. The full-app
CI job runs them before the suite; locally:

```bash
meteor npm run test:mcp-server
```

## The npm dependency policy (pi-ai, pi-mcp, typebox)

The package has four app-level npm dependencies — `@earendil-works/pi-ai`,
`@earendil-works/pi-mcp`, `typebox`, and `marked` — and none is ever an
`Npm.depends`. The first three are server-side and subject to every rule
below; `marked` is client-only and covered by its own paragraph after the
pins.
pi-ai **reached 1.0 on 2026-10-01 after an API that moved throughout this
project** (0.73 → 0.84 renamed the scope and reshaped the streaming surface;
0.84 → 1.0 crossed four breaking releases, none of which reached the surface
this package calls — the probe notes in `server/providers/piai.ts` say which);
pi-mcp reached 1.0 the same day, three days after its first release, so its
surface is young however it is numbered; typebox is post-1.0 and its
`Compile`/`Value` surface is probed off the installed files exactly as the
other two are. The first two are genuinely optional peers (see below); typebox
is a **direct dependency** — argument validation degrades to a structural
checker without it, but it must be pinned directly rather than leaned on as a
transitive of pi-ai, because a pi-ai bump or a hoisting change could otherwise
remove it and, worse, make `defineAgentMethod` throw at registration when full
validation is expected. The package survives all three because of three rules —
keep them:

1. **Each dependency is imported by exactly one file.** pi-ai (and typebox)
   only by `server/providers/loader.ts`, reached elsewhere through
   `loadPiAi()`/`loadTypebox()`; pi-mcp only by `server/mcp/loader.ts`,
   reached elsewhere through `loadPiMcp()`. One adapter per dependency knows
   its shapes — `server/providers/piai.ts` and `server/mcp/client.ts` — and
   every shape it uses is recorded in its header comment with the `.d.ts`
   source cited. `server/mcp/loader.ts` deliberately reuses the resolver in
   `server/providers/loader.ts` (the `exports`-map walk, the dev/production
   `node_modules` search, the import → file-URL → temp-shim hedge) rather than
   copying it; only the package name and the probe notes are new.
2. **Never guess either API.** Every claim about them in this repo was read off
   the installed `dist/*.d.ts` or proved by a runtime probe. When a bump changes
   behavior, update the probe notes in the adapter header in the same commit.
   Recorded findings for pi-mcp 1.0.0, each a default the factory in
   `server/mcp/client.ts` overrides or leans on:
   - its `exports` map is import-only like pi-ai's, with a `source` condition
     beside `import` that names unbuilt TypeScript and must never be picked;
   - `StdioTransport` hands the child the host's **entire environment** unless
     `inheritEnv: false`. The factory turns that off and builds the allowlist
     the official SDK used (`mcpChildEnvironment`). Dropping this would put
     every provider key in every MCP server's hands, and nothing would fail;
   - it buffers the server's stderr unless told `stderr: 'inherit'`;
   - requests time out after 30s (the official SDK: 60s). The factory gives
     `initialize` the server's discovery budget, so a server that never answers
     is killed when the package gives up on it, and gives `tools/call` 60s;
   - `listTools()` follows `nextCursor` to the last page, and `close()` signals
     the server's whole process group, so a wrapper like `npx` cannot leave the
     real server behind.

   `tests/mcp.test.ts` holds the ones that would otherwise go wrong silently —
   the entry, the environment, the handshake deadline, paging and shutdown — by
   running the factory against a real stdio subprocess. Remove the override and
   the matching test fails.

   The package used `@modelcontextprotocol/sdk` through v0.3.0. It left because
   that package ships its client fused to a server half this code never loads —
   express, hono, ajv, zod: 84 installed packages, and three of the four
   advisories the production audit carried.
   Second recorded finding: typebox is reached through **two** of its exports
   keys now, `./value` and `./compile`, and each is cached separately by
   `loadPackage`. `typebox/compile`'s namespace is
   `{ Code, Compile, Validator, default }` (`default` IS `Compile`);
   `Compile(schema)` takes plain JSON Schema and returns a `Validator` whose
   `Check(value)` and `Errors(value)` produce the SAME ajv-shaped records
   `Value.Check`/`Value.Errors` do — which is why one `reasonFor` serves both
   and why the compiled path was a drop-in. A bump that reshapes either key
   must keep the four-rung validation ladder in `server/tools.ts` intact: an app
   validator, then compiled, then interpreted, then the safe structural subset.
   Schemas outside that subset are refused when no full checker is available.
3. **A version bump is a verification event, not a routine update.** After
   `meteor npm install @earendil-works/pi-ai@<new>` or
   `meteor npm install @earendil-works/pi-mcp@<new>`:
   - run the suite — the pi-ai adapter's mapping tests pin real field names and
     the stream tests run through pi-ai's own `fauxProvider`; the MCP loader
     tests pin pi-mcp's resolved entry (`dist/index.js`) and the two exported
     names the client needs, and the default-factory tests run it against a
     real subprocess, so a reshape or a changed default of either fails loudly
     here;
   - run the full-app suite (`meteor npm run test-app:once`) after a pi-ai bump
     — a catalog refresh can retire a model id, and "Installed model defaults"
     checks the reference app's intentional per-provider defaults
     (`app/imports/constellation/models.js`) against the installed catalog
     (1.0 replaced `deepseek-v4-flash` with `deepseek-flash`);
   - run `./scripts/verify-build.sh` — resolution is exports-map dependent and a
     packaging change can break the loader chain only in a real bundle;
   - run the live smokes: pi-ai's with an `ANTHROPIC_API_KEY`, the MCP one with
     `MCP_LIVE_TEST=1` (it spawns `npx -y @modelcontextprotocol/server-everything`,
     a third-party server built on the official SDK, which makes it the interop
     check against the reference implementation).

The app pins `^1.0.0` (pi-ai), `^1.0.0` (pi-mcp), `^1.3.7` (typebox), and
`18.0.11` (marked, exact). Do not widen any range in a commit that changes
anything else. A caret on pi-ai now floats across minors, where `^0.84.2`
floated only patches: the lockfile is what CI and the reference app run, so
rule 3 applies to every lockfile move, not only to an edit of the range. pi-ai
pins typebox exactly, so its bump usually moves typebox with it (1.0.0 took it
from 1.3.7 to 1.3.27); keep the two deduplicated to one copy. A typebox bump is
a verification event too: run the suite (the tools suite pins the full ladder
and `format` enforcement) and re-read the `Compile`/`Value` probe notes at the
top of `server/tools.ts`.

**marked is the one client-side dependency, and it follows the same spirit
with different mechanics.** It is imported by exactly one file —
`client/markdown.ts` — and used only as a lexer: its HTML renderer is never
called, the token tree is walked into an allowlisted DOM, and every content
leaf lands as a Text node. There is no loader seam because the seam exists for
Meteor's SERVER resolver; the client bundler follows the `exports` map at
build time, and a missing install fails the build loudly instead of failing an
agent at runtime. It is required (not an optional peer) for any app that loads
the client element. The pin is exact because the token shapes are the entire
contract. A marked bump is a verification event: run the client suite — the
`element.client.ts` Markdown block pins rendering, sanitization (raw HTML
inert, active URL schemes rejected), and the streaming-fence upgrade.

**Both peers are genuinely optional, and that is a property to preserve.** An
app that installs neither still runs agents: the MCP SDK is reached only by a
`{ mcp: … }` tool spec, and pi-ai only by the DEFAULT provider. There are three
ways to skip pi-ai entirely — `mockProvider`, an inline `provider:`
implementation, and `Agent.provider(name, impl)` with a config that names it as
a string. Resolution (`resolveProvider` in `server/registry.ts`) is the gate:
`piAiProvider()` is constructed only when a config names no provider at all,
and even then it loads nothing until its first stream. If you change provider
resolution, keep both halves — a named or supplied provider must never route
through the pi-ai default, and the default must stay lazy. Either regression
puts an app-level npm peer back on the critical path for every agent, which is
exactly what the loader seam exists to avoid.

## Pi Durable and Chord (`10thfloor:durable`)

`@earendil-works/pi-durable` and `@earendil-works/chord` are app-level npm
dependencies of `10thfloor:durable` only, **pinned exactly** (`1.0.0` each).
Pi Durable is experimental and says its API changes without notice. The three
rules above apply, with this package's own files:

1. **One file reaches them.** On the server, `packages/durable/server/pi.ts`,
   through `server/loader.ts`. That loader is a copy of the core's seam, kept
   apart so the package depends on nothing but the npm modules, with one rule
   of its own: Chord and pi-ai are resolved **from Pi Durable's side**, a copy
   npm nested under it first. Where npm keeps two copies, the bare name is the
   one the harness does *not* import. In the browser, `client/conversation.ts`
   imports Chord's delta module by file path
   (`@earendil-works/chord/dist/delta/index.js`), because the client bundler
   follows no `exports` map either; `client/chord-delta.d.ts` types that one
   import.
2. **Nothing is guessed.** The shapes are recorded at the top of
   `server/pi.ts`. Recorded findings, each read off the installed `dist/*.d.ts`
   or seen in a run:
   - the Session recognises `StorageRejected` by identity, so the storage must
     throw the class of the module instance the harness loaded;
   - a commit that fails with anything but `StorageRejected` poisons the
     Session. The host closes that harness and opens the storage again;
   - `Harness.close()` waits for running tool calls, and a tool that ignores
     its `abortSignal` never returns. Every close in `server/host.ts` is
     bounded for that reason;
   - a user entry (`pi.user`) carries no `data`: there is nowhere in the
     transcript to put an author;
   - no hook can refuse a model request (`beforeRequest` may throw; the
     request goes on);
   - `configure()` and `create` take extension and tool *objects* and store
     only their names, so `server/operations.ts` passes `{ name }`;
   - compaction cuts nothing from a transcript shorter than
     `settings.compaction.keepRecentTokens`. The tests set it to 1.

   And three of MongoDB's, in `server/host.ts`: `$expr` is not allowed in the
   predicate of an upsert, so taking a lease is two statements; in an update
   pipeline a string that begins with `$` is a field path, so names are
   wrapped in `$literal`; and Meteor's change-stream observer cannot serve a
   cursor with a limit, so the publication's window is a lower bound.
3. **A bump is a verification event.** After
   `meteor npm install --save-exact @earendil-works/pi-durable@<new> @earendil-works/chord@<new>`:
   - run the package suite. It runs Pi Durable's own storage conformance cases
     against `MongoStorage`, the real harness on it, and every built-in
     operation against a model that reports what it was sent;
   - run `./scripts/verify-build.sh`. Its durable probe checks that the loader
     takes the copies of Chord and pi-ai that Pi Durable itself imports, and
     runs a whole turn from the bundle;
   - run `scripts/verify-instances.mjs` on that bundle, and the full-app suite,
     whose Threads tests drive the package through a real surface;
   - re-read `dist/index.d.ts` and `dist/types.d.ts` against the notes in
     `server/pi.ts`, and update them in the same commit.

`server/mongo-storage.ts`, `server/host.ts`, `server/operations.ts` and
`server/handover.ts` import nothing at run time: the driver, the harness and
the clock are passed in. Keep it so. It is what let the cases that need a
second operating-system process (a `kill -9` in the middle of a tool call, a
SIGTERM handover) run under plain Node against these very files.

## Turn-loop invariants

When changing `server/loop.ts`, check these explicitly: assistant messages commit only at
boundaries; every session write is lease-guarded, atomic, or conditional on the
parked state; `$`-operator modifiers only (a replacement doc strips the lease);
a stop outranks everything; discard fails toward the repairable state; the
transcript is published, so raw errors never enter it. The suite encodes each
of these — run it, and when you add a mechanism, add the failure-injection test
that would have caught its absence.
