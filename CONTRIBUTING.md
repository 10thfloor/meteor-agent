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

## The pi-ai dependency policy

`@earendil-works/pi-ai` is **pre-1.0 and its API has moved during this
project** (0.73 → 0.84 renamed the scope and reshaped the streaming surface).
The package survives this because of three rules — keep them:

1. **pi-ai is imported by exactly one file**, `server/providers/loader.ts`,
   and reached everywhere else through `loadPiAi()`. The adapter
   (`server/providers/piai.ts`) is the only other file that knows pi-ai's
   shapes, and every shape it uses is recorded in its header comment with the
   `.d.ts` source cited.
2. **Never guess pi-ai's API.** Every claim about it in this repo was read off
   the installed `dist/*.d.ts` or proved by a runtime probe. When a bump
   changes behavior, update the probe notes in the adapter header in the same
   commit.
3. **A version bump is a verification event, not a routine update.** After
   `meteor npm install @earendil-works/pi-ai@<new>`:
   - run the suite — the adapter's mapping tests pin real field names and the
     stream tests run through pi-ai's own `fauxProvider`, so a reshape fails
     loudly here;
   - run `./scripts/verify-build.sh` — resolution is exports-map dependent and
     a packaging change in pi-ai can break the loader chain only in a real
     bundle;
   - run the live smoke with a key if the streaming surface changed at all.

The app pins `^0.84.2`. Do not widen that range in a commit that changes
anything else.

## Invariants that reviews keep re-proving

If you change `server/loop.ts`, the review history says you will break one of
these unless you check it explicitly: assistant messages commit only at
boundaries; every session write is lease-guarded, atomic, or conditional on the
parked state; `$`-operator modifiers only (a replacement doc strips the lease);
a stop outranks everything; discard fails toward the repairable state; the
transcript is published, so raw errors never enter it. The suite encodes each
of these — run it, and when you add a mechanism, add the failure-injection test
that would have caught its absence.
