# Contributing

## Layout

- `app/packages/agent` — the core package (`10thfloor:agent`).
- `app/packages/agent-channel-*` — the five optional channel packages.
- `app/` — the host app: test harness, and the demo chat UI (`meteor run` it).
- `docs/superpowers/specs/` — historical design records. The source and tests
  are authoritative where a record describes an earlier release.
- `scripts/verify-build.sh` — production-bundle verification (see README).

From `app/`, install dependencies with `meteor npm ci` and run the static gates:

```bash
npm run typecheck
npm run types:check
```

`types:check` regenerates the declarations shipped by the core and all five
channel packages and fails if the committed output has drifted.

## Running the suite

From `app/` (port 3200 — 3000 is often taken; a blocked port hangs silently),
`npm test` runs the same command as CI:

```bash
TEST_BROWSER_DRIVER=playwright meteor test-packages --once --port 3200 \
  --driver-package meteortesting:mocha \
  ./packages/agent \
  ./packages/agent-channel-slack ./packages/agent-channel-telegram \
  ./packages/agent-channel-whatsapp ./packages/agent-channel-sms \
  ./packages/agent-channel-email
```

Every package, and the same list CI runs — keep the two in step. Running the
core alone passes while a surface package is broken, which is how five lens
suites came to run only on developers' machines.

Budget 3–5 minutes. The client half needs Playwright's Chromium
(`npx playwright install chromium`). Live smoke tests remain pending unless
their opt-in environment is present: pi-ai uses `ANTHROPIC_API_KEY`, and MCP
uses `MCP_LIVE_TEST=1`.

## The npm dependency policy (pi-ai, and now the MCP SDK)

The package has three app-level npm dependencies — `@earendil-works/pi-ai`,
`@modelcontextprotocol/sdk`, and `typebox` — and none is ever an `Npm.depends`.
pi-ai is **pre-1.0 and its API has moved during this project** (0.73 → 0.84
renamed the scope and reshaped the streaming surface); the MCP SDK is post-1.0
but ships weekly; typebox is post-1.0 and its `Compile`/`Value` surface is
probed off the installed files exactly as the other two are. The first two are
genuinely optional peers (see below); typebox is a **direct dependency** —
argument validation degrades to a structural checker without it, but it must be
pinned directly rather than leaned on as a transitive of pi-ai, because a pi-ai
bump or a hoisting change could otherwise remove it and, worse, make
`defineAgentMethod` throw at registration when full validation is expected. The
package survives all three because of three rules — keep them:

1. **Each dependency is imported by exactly one file.** pi-ai (and typebox)
   only by `server/providers/loader.ts`, reached elsewhere through
   `loadPiAi()`/`loadTypebox()`; the MCP SDK only by `server/mcp/loader.ts`,
   reached elsewhere through `loadMcpSdk()`. One adapter per dependency knows
   its shapes — `server/providers/piai.ts` and `server/mcp/client.ts` — and
   every shape it uses is recorded in its header comment with the `.d.ts`
   source cited. `server/mcp/loader.ts` deliberately reuses the resolver in
   `server/providers/loader.ts` (the `exports`-map walk, the dev/production
   `node_modules` search, the import → file-URL → temp-shim hedge) rather than
   copying it; only the package name and the probe notes are new.
2. **Never guess either API.** Every claim about them in this repo was read off
   the installed `dist/*.d.ts` or proved by a runtime probe. When a bump changes
   behavior, update the probe notes in the adapter header in the same commit.
   Recorded finding worth keeping in mind: the MCP SDK is DUAL (its `exports`
   carry `require` conditions pointing at a real CJS build, unlike pi-ai's
   import-only map), so a bare `require.resolve` succeeds where it throws for
   pi-ai — that still does not make a plain import work under Meteor, whose
   resolver cannot follow an `exports` map at all. The seam stays.
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
   `meteor npm install @modelcontextprotocol/sdk@<new>`:
   - run the suite — the pi-ai adapter's mapping tests pin real field names and
     the stream tests run through pi-ai's own `fauxProvider`; the MCP loader
     tests pin the SDK's resolved entry paths (`dist/esm/client/index.js`,
     `dist/esm/client/stdio.js`) and the two exported names the client needs, so
     a reshape of either fails loudly here;
   - run `./scripts/verify-build.sh` — resolution is exports-map dependent and a
     packaging change can break the loader chain only in a real bundle;
   - run the live smokes: pi-ai's with an `ANTHROPIC_API_KEY`, the MCP one with
     `MCP_LIVE_TEST=1` (it spawns `npx -y @modelcontextprotocol/server-everything`
     and is the only test that proves the real protocol round trip).

The app pins `^0.84.2` (pi-ai), `^1.30.0` (MCP SDK), and `^1.3.7` (typebox). Do
not widen any range in a commit that changes anything else. A typebox bump is a
verification event too: run the suite (the tools suite pins the full ladder and
`format` enforcement) and re-read the `Compile`/`Value` probe notes at the top
of `server/tools.ts`.

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

## Turn-loop invariants

When changing `server/loop.ts`, check these explicitly: assistant messages commit only at
boundaries; every session write is lease-guarded, atomic, or conditional on the
parked state; `$`-operator modifiers only (a replacement doc strips the lease);
a stop outranks everything; discard fails toward the repairable state; the
transcript is published, so raw errors never enter it. The suite encodes each
of these — run it, and when you add a mechanism, add the failure-injection test
that would have caught its absence.
