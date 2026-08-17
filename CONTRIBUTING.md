# Contributing

## Layout

- `app/packages/agent` — the package (`10thfloor:agent`). Everything shippable
  lives here.
- `app/` — the host app: test harness, and the demo chat UI (`meteor run` it).
- `docs/superpowers/` — the design spec and the per-milestone plans, including
  the review history that shaped the invariants. Read the spec's §4.3/§6/§9/§10
  before touching `server/loop.ts`.
- `scripts/verify-build.sh` — production-bundle verification (see README).
- `spike/` — throwaway probe app from the design phase. Not the product.

## Running the suite

From `app/` (port 3200 — 3000 is often taken; a blocked port hangs silently):

```bash
TEST_BROWSER_DRIVER=playwright meteor test-packages --once --port 3200 \
  --driver-package meteortesting:mocha ./packages/agent
```

Budget 2–4 minutes. The client half needs Playwright's Chromium
(`npx playwright install chromium`). The one `pending` test is the live smoke;
it un-skips itself when `ANTHROPIC_API_KEY` is set.

## The npm dependency policy (pi-ai, and now the MCP SDK)

The package has exactly two app-level npm peers — `@earendil-works/pi-ai` and
`@modelcontextprotocol/sdk` — and neither is ever an `Npm.depends`. pi-ai is
**pre-1.0 and its API has moved during this project** (0.73 → 0.84 renamed the
scope and reshaped the streaming surface); the MCP SDK is post-1.0 but ships
weekly. The package survives both because of three rules — keep them:

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

The app pins `^0.84.2` and `^1.30.0`. Do not widen either range in a commit that
changes anything else.

## Invariants that reviews keep re-proving

If you change `server/loop.ts`, the review history says you will break one of
these unless you check it explicitly: assistant messages commit only at
boundaries; every session write is lease-guarded, atomic, or conditional on the
parked state; `$`-operator modifiers only (a replacement doc strips the lease);
a stop outranks everything; discard fails toward the repairable state; the
transcript is published, so raw errors never enter it. The suite encodes each
of these — run it, and when you add a mechanism, add the failure-injection test
that would have caught its absence.
