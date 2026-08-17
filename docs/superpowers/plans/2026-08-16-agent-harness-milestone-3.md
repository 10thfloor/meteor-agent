# Meteor Agent Harness — Milestone 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the spec's v1: compaction for long conversations, automatic recovery via the orphan-claim watcher, an interrupt that actually cancels the HTTP request, the tool surface finished (`Agent.method()` co-registration, validated inline args), `Agent.ask()`, client teardown — and the test debt the M2 final review triaged here.

**Architecture:** unchanged. No new collections. Compaction is a `kind:'compaction'` note row that changes what the MODEL sees, never what the transcript keeps (spec §9). The watcher is one `observeChangesAsync` observer plus one interval sweep per app server (spec §4.3). Everything else refines existing seams.

**Sources of truth:** the design spec (§4.3, §6, §9), the M3 triage table at the end of `.superpowers/sdd/progress.md`, and the M2 plan's deferral list.

## Global Constraints

- Everything from the M1/M2 plans still binds: package deps `ecmascript, typescript, mongo, ddp, check, random, tracker` + `ddp-common`, `ddp-rate-limiter` (server); pi-ai reached only through `server/providers/loader.ts`; every session write lease-guarded, atomic, or conditional-on-parked-state; `$`-operator modifiers only; structured data only in published transcripts; Meteor 3 async Mongo APIs server-side; tests split `tests/server.ts`/`tests/client.ts` with no isServer wrappers; network-free tests.
- Test command, from `app/` (port 3200; allow 10 min):
  `TEST_BROWSER_DRIVER=playwright meteor test-packages --once --port 3200 --driver-package meteortesting:mocha ./packages/agent`
- Suite starts at **122 server (+1 pending live-smoke) + 1 client**. Report ACTUAL counts per task.
- **Probe before believing.** Any task touching pi-ai's surface (abort options, typebox `Value`, injectable `fetch`) begins by reading the installed `.d.ts` and records findings in its report. The M2 rule stands: never guess pi-ai's API.
- **The loop is settled.** `server/loop.ts` carries two milestones of review-hardened invariants (boundary commits, discard-toward-repairable, window-scoped repair, atomic seqs, terminal-phase preservation, the wake self-check). Tasks extend it at named seams; a reviewer will diff for behavior changes outside the task's scope.

---

### Task 1: Interrupt cancels the request; retry polish; wake race

The M2 review's highest-value item. Today `interrupt` breaks the consuming loop but the HTTP request keeps streaming into an undrained queue; the provider bills the full response.

**Files:** `server/providers/types.ts`, `server/providers/piai.ts`, `server/providers/mock.ts`, `server/loop.ts`, `tests/piai.test.ts`, `tests/loop.test.ts`

**Interfaces produced:** `ProviderRequest.signal?: AbortSignal`; `classifyProviderError` gains `'abandon'`; `RunConfig.retry.maxDelayMs?` (default 10_000).

Requirements:

1. **Probe** `ModelsSimpleStreamOptions` in pi-ai's `.d.ts` for its abort mechanism (an `AbortSignal`/`signal` option or similar). Record the exact field. If pi-ai exposes none, the adapter attaches the signal to its `fetch`-level option if available; if neither exists, STOP and report.
2. `ProviderRequest` gains optional `signal`. The loop creates an `AbortController` per attempt; the mid-stream interrupt check calls `.abort()` in addition to breaking; the tool-loop and backoff interrupt paths abort likewise. The adapter passes the signal through the probed option. `mockProvider` ignores it (document why: scripted streams end immediately anyway).
3. `classifyProviderError` returns `'abandon'` for an abort (`e.retryable === 'abandon'` hint, `e.name === 'AbortError'`, or the adapter's `reason === 'aborted'` mapping — update the adapter hint from `false` to `'abandon'`). The loop treats `'abandon'` exactly like the interrupt path: clean up the attempt's deltas, NO error note, return; the `finally` preserves `stopped`.
4. Backoff gains full jitter (`delay = random() * min(maxDelayMs, baseMs * 2^attempt)`) — note `Math.random` is fine here (server runtime, not a workflow). 408 moves to retryable with a comment citing provider practice.
5. **Wake-identity race** (M2 final review L1+prior): the wake self-check's deferred re-run must re-read the session INSIDE its callback and proceed only if `pending.verdict` still stands; align the wake exclusion list with the `finally`'s terminal list (`'error'` included). Add the missing re-assert to the `s-stop-verdict` test.

Tests: abort is observed by the provider (a saboteur provider records `signal.aborted` after the loop interrupts — assert it flipped); an abort produces no error note and preserves `stopped`; jitter stays within `[0, cap]` across 20 samples with a tiny `baseMs`; 408 retries; wake re-check: record a verdict, let the resume consume it, force the stale wake path (the test can call the internal or simulate via timing seam) and assert no extra assistant row appears.

Commit: `feat(agent): interrupt aborts the provider request; retry jitter; wake re-check`

---

### Task 2: Compaction (§9)

**Files:** `server/loop.ts` (context assembly + compaction step), `server/registry.ts` (`context?` config), `common/types.ts` (note fields), `client/agent.ts` (no change expected — verify notes render through the merge), `tests/loop.test.ts`

**Interfaces produced:** `AgentConfig.context?: { window?: number; compactAt?: number; keep?: number }` (defaults 200_000 / 0.8 / 6); `RunConfig.context?` threaded by `deferTurn`; compaction note row `{ role:'note', kind:'compaction', summary: string, upto: number }`.

Requirements:

1. **Token estimate**: prefer the last committed assistant message's provider-reported `usage.input` (the true context size at last call); fall back to `chars/4` over the assembled messages. Exported as a pure `estimateContext(msgs, lastUsage?)` for tests.
2. **Trigger**: checked once per iteration, before the provider call and after the budget checks. When estimate > `window * compactAt`, the loop enters `phase:'compacting'` (guarded), asks the CURRENT provider for a summary of everything older than the last `keep` non-note messages (a plain request built by a pure exported `buildCompactionRequest(msgs, keep)` — system prompt instructs Goal/Progress/Decisions structure per the spec), and commits the note via `allocateSeq`. Provider failure during compaction: classify; retryable failures fall through WITHOUT compacting (the turn proceeds uncompacted — degraded, not dead); fatal failures likewise proceed uncompacted but log. Compaction never writes an error note.
3. **Context assembly**: `toProviderMessages` (or a wrapper `assembleContext`) starts from the most recent compaction note: the summary becomes a leading `user`-role message (`[Earlier conversation, compacted]\n<summary>`), followed by every non-note message after `upto`. Messages at-or-before `upto` are excluded. The transcript keeps everything; only the model's view shrinks.
4. **Boundary safety**: compaction must never split an assistant-with-toolCalls from its tool results — the cut point (`upto`) lands only after a fully-answered batch or a plain assistant/user row. Reuse the existing window machinery to find a legal cut; this is the part a reviewer will trace hardest.
5. **Interplay**: repair-on-entry, `locateBatch`, budgets, and interrupt all ignore note rows already; verify and add one regression test where a compaction note sits between an assistant and a later stranded batch.
6. `phase:'compacting'` joins the client-visible phases (types already include it); the `finally` does NOT preserve it (it is transient).

Tests: trigger fires at the threshold (tiny window in config); summary note committed with correct `upto`; next iteration's provider request contains the summary and not the compacted messages (capture via saboteur provider); cut never splits a batch (construct a transcript where the naive cut would); compaction failure → turn proceeds uncompacted; full transcript still served (message count unchanged); `estimateContext` unit tests.

Commit: `feat(agent): compaction — the model's view shrinks, the transcript keeps everything`

---

### Task 3: Orphan-claim watcher + approval timeout (§4.3)

**Files:** `server/watcher.ts` (new), `server/index.ts` (startup wiring behind settings), `server/registry.ts` (`budget.approval?: number` ms), `tests/watcher.test.ts` (new), `tests/server.ts`

**Interfaces produced:** `startWatcher(opts?): { stop(): Promise<void> }` — exported for tests, started at boot unless `Meteor.settings.packages['10thfloor:agent'].watcher === false`; `budget.approval` (ms) auto-denies a parked approval.

Requirements:

1. **Orphan claim**: one `observeChangesAsync` observer per server over sessions in active phases (`streaming`, `calling`, `retrying`, `compacting`) — plus an interval sweep (default 15s) as the belt to the observer's braces, since a lease can expire with no document change to observe. A session in an active phase whose lease is absent/expired gets `runTurn` re-run with the registry config (`getAgent(session.agent)` — sessions whose agent is no longer registered are logged and skipped, not crashed). The loop's own `claimLease`/repair machinery does the rest — the watcher only notices and calls; it must NOT duplicate any loop logic.
2. **Approval timeout**: the same sweep finds `phase:'awaiting'` sessions whose `pending.requestedAt` is older than the agent's `budget.approval` (skip if unset). Timeout = a DENIED verdict recorded exactly like `agent.deny` (single-winner conditional write, `by: null`, `reason: 'approval timed out'`, approval note with `timedOut: true`), then the standard wake. Reuse the method's `recordVerdict` internals — export a `recordTimeoutVerdict(sessionId)` from `methods.ts` or factor the shared core; do not duplicate the conditional-write logic.
3. **Multi-server safety**: two servers' sweeps racing on the same orphan resolve through `claimLease` (one wins); racing on the same timeout resolve through the verdict's single-winner write. No new coordination.
4. **Lifecycle**: `stop()` tears down observer + interval and is awaited; tests always stop watchers in `finally` (a leaked observer poisons later tests). The startup watcher is NOT running during `test-packages` unless a test starts one — gate the boot wiring on `!Meteor.isTest` if needed (check what Meteor exposes; `Meteor.isTest` exists) and record the choice.

Tests: orphaned streaming session (expired lease, live phase) is claimed and completes on wake (mock provider); observer path and sweep path each exercised (short sweep interval); approval timeout denies after T (short timeout), model sees the denial, `timedOut` on the note; two watchers racing → exactly-once (one turn, one verdict — assert via message counts); unregistered agent is skipped with a warn.

Commit: `feat(agent): orphan-claim watcher and approval timeouts — recovery without a user`

---

### Task 4: The tool surface, finished (§6)

**Files:** `server/tools.ts`, `server/agent.ts`, `server/loop.ts` (validation call + isError threading), `server/providers/types.ts` (`ProviderMessage.isError?`), `server/providers/piai.ts` (map it), `server/index.ts` (exports), `tests/tools.test.ts`, `tests/piai.test.ts`

**Interfaces produced:** `Agent.method(name, { description, args, run, gate? })` — registers a real `Meteor.method` AND returns a `ToolSpec` handle; `validateToolArgs(schema, args): { ok: true } | { ok: false; reason: string }` exported; `ProviderMessage.isError?: boolean`.

Requirements:

1. **Co-registration**: `Agent.method` (static) registers `Meteor.methods({ [name]: handler })` where the handler runs `run` with the invocation's own `this` (userId flows as normal for UI callers) — and returns an adopted-style ToolSpec so agents list the handle or the name. The registered method validates args with the same `validateToolArgs` before running (one schema, both callers, per the spec's promise).
2. **Validation**: **probe** whether pi-ai's namespace re-exports typebox's `Value` (compile/check). If yes, use it through `loadPiAi()` — server-only, lazy, with a graceful degrade if absent at runtime. If no, implement a minimal structural checker in-package (`type: object` required keys + primitive `type` checks + arrays; explicitly documented as minimal). Inline tools get their model-supplied args validated BEFORE dispatch; a failure becomes a structured tool result `{ error: 'invalid-args', reason }` fed back to the model (it usually corrects), never a throw.
3. **isError threading**: `toProviderMessages` maps a tool row's `error` presence to `isError: true`; the adapter maps it to pi-ai's `ToolResultMessage.isError`. Update the adapter's hardcoded `isError: false` and its comment.
4. README: tools section updated (co-registration example replaces the M1 "validate yourself" caveat).

Tests: co-registered method callable via `Meteor.callAsync` AND as an agent tool with one definition; invalid model args → `invalid-args` result, model's next turn sees it, tool never ran; valid args run; degrade path (validator unavailable) runs the tool with a warn (simulate by injection); isError round-trips through `toPiAiRequest` (adapter mapping test); `toProviderMessages` finally gets direct unit tests — notes filtered, isError mapped, roles preserved (closes M2 review L6).

Commit: `feat(agent): Agent.method co-registration, validated tool args, isError threading`

---

### Task 5: `Agent.ask()`, client teardown, interrupt rate limit

**Files:** `server/agent.ts`, `server/methods.ts` (nothing new — ask is server-side direct), `server/rate-limits.ts` (+`interrupts` entry), `client/agent.ts` (`stop()`), `tests/loop.test.ts` or new `tests/ask.test.ts`, `tests/capped.test.ts`, `tests/integration.client.ts` (comment re live rules)

Requirements:

1. **`Agent.ask(text, { userId? })`** (server, instance method): creates a throwaway session (`userId ?? null`), runs ONE turn inline (await `runTurn` directly — no defer), reads the final assistant message, deletes the session + messages + deltas, returns the string. Budgets/config apply from the registry. A turn ending parked (`awaiting`) or errored rejects with a structured `Meteor.Error` (`ask-parked` / `ask-failed`) — headless callers can't approve, and silence is worse than an error. Document: `ask` is also how agents compose (one agent's `ask` as another's tool) — add one composition test.
2. **Client `stop(sessionId?)`**: stops the merge computation and (optionally) the subscription handle it created; safe to call twice; documented for component unmount. (The M2-noted leak.)
3. **`rateLimit.interrupts`** entry, same two-rule shape as sends/starts (closes M2 L4).
4. Test-debt quickies that belong to these files: `mSend` clears `phase:'error'` on send (M2 L7); a comment in `integration.client.ts` warning that server-side rate-limit tests leave live rules and the client test must stay within them (M2 L5).

Commit: `feat(agent): headless Agent.ask, client teardown, interrupt rate limiting`

---

### Task 6: Verification sweep — production build and the remaining test debt

**Files:** `tests/loader.test.ts`, `tests/piai.test.ts`, `tests/capped.test.ts`, `scripts/verify-build.sh` (new, repo root), README (a "verifying a production build" note)

Requirements:

1. **Production-build verification script** (`scripts/verify-build.sh`): `meteor build --directory /tmp/agent-build --server-only` from `app/`, `npm install` in the bundle, then run `node main.js` with a `MONGO_URL` pointing at a scratch mongod and `METEOR_SETTINGS` minimal, wait for startup, and assert via `/` HTTP 200 + a marker log line that `loadPiAi()` resolved (add a startup log in dev? NO — instead the script runs a tiny node probe against the bundle's programs/server npm layout exercising `resolvePiAiEntry` + URL import directly). Keep the script self-contained and idempotent; document expected runtime (~3-5 min). This closes the "plain-import branch unverified under meteor build" item — the script's report states WHICH loader branch succeeded.
2. **Converter-level request-body test** (closes M2 L6-adjacent + M3-ledger item): using pi-ai's injectable `fetch` (probe `ProviderRequestOptions.fetch` — recorded in Task 2's M2 report), drive `piAiProvider`-shaped streaming through the real Anthropic converter with a fake fetch capturing the request body; assert the body's `system`, `messages` (including a toolResult with `is_error`), and `tools` are shaped as Anthropic expects. Network-free.
3. **Restore the `npm/node_modules` walk** in the loader no-write test (M2 T1 minor).
4. Note-row client rendering: extend the client integration test OR a server-side mergeView test asserting note rows pass through `mergeView` unharmed and sort by seq (cheapest correct option; document choice).

Commit: `test(agent): production-build verification, converter-level request bodies, remaining debt`

---

## Deferred beyond M3 (v2 backlog, unplanned)

`toolcall_delta` contentIndex correlator (parallel-call streaming fidelity); `turnWindows` O(assistants×messages) (bounded in practice by compaction); `locateBatch` unanswered-first older-stranded edge; drain-remainder lost-ack duplicate-seq (accepted, commented); polling-observer `usage()` latency (documented); subagents, Agent Skills, MCP, forking, extension API, RPC modes, UI components.

## Milestone 3 done — what works

Spec v1 complete: long conversations compact themselves without losing history; a crashed server's runs recover with no user present; approvals time out instead of parking forever; stop cancels the actual HTTP request; one tool definition serves UI and agent with validated arguments; `Agent.ask()` gives headless one-shots and agent composition; clients tear down cleanly; and a script proves the whole thing runs from a real production bundle.
