# Meteor Agent Harness — Milestone 5 Implementation Plan (v3: the backlog, then the audit)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Drain the triaged v3 backlog (correctness residuals, lifecycle gaps, the gate/hook feature remainders, perf debt), then subject the whole repo to a fresh code review and a dedicated security review, fixing what they find.

**Sources:** the M4 final-review triage table and Task-7 v3 consolidation in `.superpowers/sdd/progress.md`; the spec's §7 (predicate gates were specced for v1 and never shipped).

## Global Constraints

All M1–M4 constraints bind unchanged. Suite starts at **282 (+2 pending) server + 6 client**. Test command, port, timings unchanged. Probe-before-believing for typebox/compile and any SDK surface.

---

### Task 1: Loop robustness residuals

1. **Subagent idempotency keys.** A parent turn abandoned mid-batch re-dispatches on recovery and runs a whole second child (documented at-least-once). Fix: before creating a child, look for an EXISTING child session with `parent: { sessionId, toolCallId }` matching this exact call (toolCallId is unique per assistant message batch — verify against id reuse across turns: scope the lookup by parent.sessionId + toolCallId + the assistant messageId... decide the minimal sufficient key and defend it). Found and finished → reuse its outcome (readTurnOutcome) instead of re-running; found and running/parked → return the appropriate result. This closes the double-child without a new collection.
2. **Wake turn-generation token.** The residual race: a verdict consumed while a wake defer is queued. Add `wakeToken` (Random.id) written with the verdict; the deferred wake re-reads and proceeds only if the token it captured still stands. Replaces the boolean re-check with identity.
3. **`toolResultContent` stringify guard.** A hook returning `{ok:true, value:<circular|BigInt>}` throws outside the hook runner and abandons the turn. Wrap; on failure, substitute a structured `{error:'unserializable-result'}` row and warn (per-kind latch).
4. **`isProviderRequest` requires `system`** (string) alongside model/messages.
5. **Watcher flake.** Investigate the one-run `watcher.test.ts` flake two agents hit ("lease expires with no document change" timing). Find the race in the TEST (or the watcher), fix it, run the suite 3× to confirm.

### Task 2: Lifecycle and lineage

1. **Orphaned-child re-link.** The watcher's sweep gains a case: a CHILD session older than one sweep whose parent transcript contains no tool row carrying its id and whose parent's `activeChild` does not name it — write a structured `role:'note', kind:'orphan-child'` row into the PARENT transcript (atomic raw seq, like verdict notes) carrying `childSessionId` + the child agent name, restoring client reachability. Idempotent (one note per child — check before write).
2. **Parent-interrupt propagation.** `mInterrupt` walks `activeChild` links (depth-capped at the subagent max) and sets `stopped` on each running descendant, so Stop stops the work the user sees. The child's turn honors it via the existing mid-stream checks. Update the README sentence that documents the old behavior.

### Task 3: Gates, hooks, and surfaced identity

1. **Predicate gates** (spec §7, finally): `gate?: 'auto' | 'ask' | ((ctx) => boolean | 'ask' | Promise<...>)` — ctx `{ userId, sessionId, name, args }`. `false` → structured `{error:'denied-by-gate'}` result (model routes around); `'ask'` → park; `true` → run. Evaluated at dispatch; a throwing predicate fails CLOSED to a denied result with a warn. Applies to every tool kind (subagent/MCP included — the gate runs before dispatch, no identity issues).
2. **Per-agent hooks:** `agentInstance.hook(name, fn)` — same seams, scoped to that agent via ctx; global `Agent.hook` still runs for all (global first, then per-agent; document order).
3. **`runAs` surfaced to approvers:** `pending` gains `runAs` when the parked tool has one; `<agent-chat>` renders "runs as <id|anonymous>" in the approval bar.
4. **Element polish:** attribute-churn microtask batching (no orphan auto-starts); demo's error handler branches on `no-session` only.

### Task 4: Perf debt + docs

1. **Compiled-schema cache:** `typebox/compile` through the loader seam; WeakMap keyed on the schema object; fallback to `Value.Check` when compile is unavailable; the degrade ladder documented. Bench note (not a benchmark suite — one measured number in the report).
2. **tool_args pressure:** measure delta doc count/bytes for a large parallel-call turn (test-observed, numbers in the report); add a per-turn `tool_args` byte clamp (default generous, config `maxToolArgBytes?`) so a pathological stream cannot evict every other session's deltas; README ops note updated.
3. README/CONTRIBUTING sweep for everything above; ledger consolidation.

### Task 5: The audit (after all fixes merge to the branch)

1. **Fresh whole-repo CODE review** — an agent with no session history reading the package cold: architecture coherence, API consistency, dead code, docs-vs-code drift, test quality. Not a re-review of past diffs — a review of what a new maintainer inherits.
2. **Dedicated SECURITY review** — attack-surface driven: every DDP method and publication enumerated with its auth; capability-URL semantics; runAs escalation paths; hook and MCP injection surfaces; transcript hygiene (what can reach a published row); rate-limit coverage map; DoS vectors (fork size, subagent fan-out, compaction, MCP spawn); dependency surface (loader seams, shim writes).
3. Fix everything Critical/High immediately; triage the rest with the user's eyes on it in the final summary.

## Done means

The triage table's v3 column is empty or explicitly retired; both audits have run; their Critical/High findings are fixed; the branch is merged.
