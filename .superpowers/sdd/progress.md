# Milestone 1 progress ledger

Plan: docs/superpowers/plans/2026-08-15-agent-harness-milestone-1.md
Branch: milestone-1-harness
Pre-flight: tracker added to allowlist; tests split by architecture (both approved by user).

Task 1: complete (commits d451d00..490e6aa, review clean — spec OK, quality approved)
  Minor: package.js references README.md, created in Task 8.
Task 2: complete (commits 3d67cba..65b69b4, review clean — spec OK, quality approved)
  Minor: merge tests exercise only kind:thinking; tool_args/tool_output not covered (structurally safe — join() filters by kind).
Task 3: complete (commits 65b69b4..e301cc9, 2 Important findings fixed, re-review clean)
  Minor: shimLoad is exported as a test seam — re-examine surface once the loader is wired into
    production code (Meteor permits deep imports by path; the "not public API" comment is not enforced).
  Minor: node_modules/.agent-loader/loader.mjs is never cleaned up; shim-on-disk test is env-dependent.
  Minor: the plain-import() try branch has not been verified under a production `meteor build`.
  NOTE: plan bug found — brief's assert.isObject cannot pass against its own loader code
    (ESM namespace stringifies [object Module]). Assertion fixed rather than the semantics.
Task 4: complete (commits e301cc9..949c471, 1 CRITICAL + 1 Important fixed, re-review clean)
  CRITICAL was an IDOR authored in the plan: agent.session returned 3 cursors, only the session
    scoped by userId -> messages+deltas leaked to any caller with a sessionId. Spec section 4.4 patched.
  Minor: agent.session authorization is checked at subscribe time only, not reactively (standard Meteor idiom).
  Minor: tests/capped.test.ts:14 uses literal 'agent_deltas' instead of NAMES.deltas.
Task 5: complete (commits d6b27d1..081c5f1, 1 Important + 1 Minor fixed, re-review clean, 42 passing)
  NOTE refining S2b: Meteor.callAsync ALWAYS builds its own fresh MethodInvocation, so the adopted
    path would tolerate a plain-object ambient value. The real DDPCommon.MethodInvocation is required
    for DIRECT handler invocation only. Now guarded by an explicit ambient-invocation test.
  Minor: 'resolves valid specs' test asserts name/kind but not gate.
Task 6: complete (commits 081c5f1..b2f49d3, review clean first pass, 46 passing)
  Minor: guardedUpdate trusts callers to pass a $-operator modifier, not a replacement doc.
    Ownership filter still holds, but a replacement would strip lease itself. Relevant to Task 7.
  Minor: lease.test 3rd case is named "lost the lease" but tests "never held it".
  Minor: {lease:{$exists:false}} and {lease:null} are redundant disjuncts (harmless).
Task 7: complete (commits b2f49d3..63fd2b8, 3 fix passes, 56 passing)
  Fixed across passes: C1 unanswered-tool_use recovery (full-scan repair + discard toward repairable
    state + per-turn-window detection), I2 holdsLease pre-flight, I3 heartbeat now wired,
    I4 DeltaWriter seq race + coalescing, I5 orphan delta cleanup, I6 vacuous test replaced (3 real
    lease-steal tests, each verified failing pre-fix), in-process re-entrancy Set, stopped-phase preserved.
  SPEC IMPACT: "recovery is just run the loop again" was FALSE on the tool path as specced —
    spec section 4.2/4.3 need the repair-on-entry mechanism documented (patch before merge).
  Residual minors for final review:
    - discardTurn delete-order has no failure-injection test (reordering would pass suite)
    - DeltaWriter.drain() drops detached batch remainder if an insert throws mid-batch (seq gap truncates render)
    - maxIterations exhaustion is silent (no budget note; M2 has the note kinds)
    - provider throw escapes with phase idle, no error note (deliberate M2 scope)
    - usage.cost / budgetSpent.turns never written (M2 budget machinery)
    - awaiting/pending repair-guard becomes load-bearing when M2 gating lands (crash while awaiting
      with a genuinely stranded assistant would block repair permanently)
    - second concurrent runTurn silently dropped (Task 8 send needs to consider)
    - heartbeat / running-Set / stopped-preservation untested
Task 8: complete (commits 63fd2b8..HEAD, 1 Critical + 2 Important fixed INLINE by controller, 60+1 passing)
  CRITICAL: anonymous sessions were enumerable via agent.sessions (null matches every anon caller)
    -> pubSessions now publishes nothing to anonymous callers; capability-URL model documented in spec 4.4.
  Important: duplicate seq under concurrent send — reviewer's mSend-only fix was insufficient (loop
    inserts at a seq captured pre-stream); BOTH sides now allocate atomically via findOneAndUpdate.
  Important: interrupt() now actually interrupts — phase re-read mid-stream (interruptCheckMs) and
    before each tool dispatch; partial discarded, stop preserved.
  Minors fixed: whole-doc view upsert, Tracker.nonreactive writes, non-empty prefix guard, unused export.
  Spec sections 4.3 and 4.4 updated (repair-on-entry, atomic seq, interrupt, anon enumeration).
Final whole-branch review: MERGE AFTER MUST-FIXES -> all 4 must-fixes done inline (62+1 passing):
  I1 crash-orphan delta sweep in repair-on-entry (+ crash-variant test)
  I2 mid-turn send now ANSWERED via extra iteration (+ assertion upgraded)
  I3 phase ownership: send clears stopped->idle; loop refuses to run while stopped stands
  I4 deltas removed at commit (2 tests reworked to capture mid-stream)
  + methods authorization test (send/interrupt vs other-user/anon/wrong-agent)
  + README: anonymous capability-URL semantics, inline tool args unvalidated
Filed-for-M2 (from final review): loader writes into node_modules at runtime (read-only container FS);
  plain-import branch unverified under meteor build; discardTurn order + DeltaWriter drain error-path
  untested; heartbeat untested; gate:'ask' accepted-and-ignored (should reject in M1... left as-is);
  lease.serverId published to client; tool_args chunks discarded; findOneAndUpdate reactivity under
  polling observers unverified.

== MILESTONE 2 (branch milestone-2-production, plan 2026-08-15-agent-harness-milestone-2.md) ==
M2 Task 1: complete (2a8e3ce..5429bbc, review clean, 63+1 passing; implementer report lost to machine sleep, controller verified suite directly)
  NOTE plan bug: brief's createRequire().resolve(PKG) throws ERR_PACKAGE_PATH_NOT_EXPORTED (pi-ai
    exports only import/types conditions). Implementer read exports map manually — correct deviation.
  Minor: no-write test no longer walks npm/node_modules variant; shim safety comment dropped.
M2 Task 2: complete (5429bbc..HEAD, review Approved-with-issues, 81+1 passing, 1 pending live-smoke)
  Probe found real API: Models.streamSimple(model, context) via builtinModels() under providers/all
    subpath; loader gained subpath param (Map-keyed cache). Brief's presumed API was wrong as expected.
  Fixed inline post-review: model-identity stamping on replayed assistant messages (isSameMode l/
    foreign-id rewrite), catalog cache no longer caches rejections.
  Carried to Task 3: use error `status`/pi-ai retryability; stream-throw delta cleanup (already in plan).
  Carried to Task 5: pi-ai reports cacheRead/cacheWrite + its own computed usage.cost — widen usage
    plumbing and prefer provider-reported cost over pricing math.
  M3 ledger: AbortSignal so interrupt cancels the HTTP request; toolcall_delta contentIndex correlator;
    ProviderMessage isError flag for tool results; converter-level request-body test via injectable fetch.
M2 Task 3: complete (26c462e..74235ba, 1 HIGH + 2 MEDIUM fixed, re-review clean, 89+1 passing)
  HIGH was interrupt-erasure: retry branch overwrote phase:'stopped' with 'retrying' (guardedUpdate
    filters on lease only, never phase) and committed a cancelled message. Now: a stop outranks retry.
  MEDIUM: writer.stop() rejection classified as provider failure -> double provider charge on a Mongo
    blip. MEDIUM: behaviors 2/6 untested -> 4 tests added.
  Notes for M3: no jitter/cap on backoff (thundering herd); 408 pinned fatal (arguably retryable);
    'abandon' as a third error classification once AbortSignal lands; note-row client rendering untested.
M2 Task 4: complete (cc599f8..faea374, work spanned 3 sleep-interrupted implementers + controller
  assembly + 2 High/3 Medium/4 Low fix pass, re-review Approved, 106+1 passing)
  The predicted cross-agent-seam bug was real: locateBatch first-match vs repair's windows (H1).
  M3 ledger: resumed-flag reopens H2 for a SECOND gate in one run (wake bound should be verdict
    identity, not a boolean); locateBatch unanswered-first can pick an older stranded turn (prefer
    newest-carrying); turnWindows skips nothing (O(assistants x messages) per entry); s-stop-verdict
    second half doesn't re-assert single execution after settle.
M2 Task 5: complete (faea374..HEAD, review found 1 Medium TOCTOU on turn budget — fixed inline as
  atomic $lt filter, 113+1 passing)
  Documented trade-offs kept: zero-reported-cost treated as unpriced (pricing fallback may charge a
  genuinely-free call — overcharge, trips EARLIER, not a brake erosion); resume path's human-approved
  call exceeds toolCalls budget by at most one.
M2 Task 6: complete (dd6b264..de01c85 + controller fix, review 1 Medium fixed inline, 122+1 passing)
  Medium: per-(userId,connectionId) bucketing let an authenticated attacker multiply the limit by
    opening N connections -> added a second authenticated-only per-user rule per entry (2 rules/entry).
  Low kept: `sends: null` silently skipped; findAllMatchingRulesAsync is young/undocumented API.
M2 Task 7: complete (43b484d, 122+1 passing; delete-order falsified against reordered code and
  restored; heartbeat + drain-remainder now enforced by tests). NOT separately reviewed — the final
  whole-branch review is instructed to give its diff per-task scrutiny.
M2 final whole-branch review: MERGE AFTER MUST-FIXES -> applied inline:
  README rewritten (config surface, budgets, error phases, rateLimit settings shape; stale Scope fixed)
  retry threaded to AgentConfig/deferTurn; adapter's two config throws hinted retryable:false
  budget.turns/toolCalls validated as positive integers at define time
M3 backlog additions from final review: spurious extra turn from the wake self-check (merge with
  verdict-identity item); wake/finally terminal lists disagree ('error'); rateLimit.interrupts entry;
  toProviderMessages has zero coverage (three note kinds now flow past it); mSend error-clear untested;
  rate-limit tests leave live rules (client test fits under them by luck — comment it); rate limits
  proven to register, never to throttle; drain-remainder comment assumes failed insert never landed
  (lost-ack duplicate seq truncates in-flight render transiently).
Suite at M2 close: 122 server (+1 pending live-smoke) + 1 client, 0 failures.

== MILESTONE 3 (branch milestone-3-spec-v1, plan 2026-08-16-agent-harness-milestone-3.md) ==
M3 Task 1: complete (a15a894..2d54621, 129+1 passing). Tests by interrupted subagent, implementation
  INLINE by controller after repeated 529s; per-task review NOT yet done (529s) — final review must
  scrutinize this diff. Self-checked: no stale backoff floor assertion; 408 pin updated to retryable.
  Probe: ProviderRequestOptions.signal (types.d.ts:50) reaches streamSimple via third arg.
  Residual for Task 3: a resume that fails before consuming its verdict leaves it unconsumed with no
  wake — the watcher sweep should notice standing verdicts on idle sessions.
  Note: abort() fires only at the mid-stream check; the other two detection points have no live request.
M3 Task 2: complete INLINE (compaction, 136+1 passing; review pending — 529s on subagents).
  Model view restarts from the newest compaction note; transcript untouched; cut never splits a
  tool batch (walk-back off tool rows); failed compaction degrades to an uncompacted turn silently;
  summarization usage/cost accrues in the note's atomic allocateSeq.
M3 Task 3: complete (7a5d633, 143+1 verified by controller; agent's report lost to machine sleep).
  writeVerdict factored as the shared single-winner core; recordTimeoutVerdict (by:null, timedOut);
  watcher = observer + 15s sweep (orphans, approval timeouts, unconsumed verdicts); boot-gated on
  settings watcher:false and test mode. Review still owed (with Tasks 1-2) at final review.
M3 Task 4: complete (c4dabf1, 159+1). Minimal structural validator (probe: pi-ai re-exports only
  typebox Type; its validateToolArguments coerces input and echoes raw args — unusable). Validation
  lives in runTool (one guard covers all dispatch paths). isError threaded end to end.
  FINAL-REVIEW DECISION NEEDED: minimal checker accepts $ref/oneOf/unions unconditionally — "validated"
  != "JSON Schema validated"; documented, escape hatch via setToolArgsValidator.
  Controller fixed inline: retrying-phase sampler flake (Math.random pinned for the window).
M3 Task 5: complete (b13d927, 170+1). ask() with finally-cleanup; client stop() asserted inside the
  live round trip (rate-limit budget documented in integration.client.ts); rateLimit.interrupts.
  Noted: ask has no wall-clock timeout (maxIterations+budgets are the brake); a crash mid-ask leaves
  a throwaway session the watcher sweeps once — single path where a throwaway outlives its call.
M3 Task 6: complete (177+1 server, 1 client). verify-build.sh: production bundle proves branch 1
  (bare import) FAILS with ERR_MODULE_NOT_FOUND and branch 2 (file:// URL) wins; branch 3 (temp shim)
  also verified live. FINDING: app never had `10thfloor:agent` in .meteor/packages, so every prior
  `meteor build` shipped zero agent code — added, script now fails early without it.
  FINDING (real bug): pi-ai's Usage is required on a replayed AssistantMessage and its context
  estimator derefs it unguarded (utils/estimate.js:4 via api/simple-options.js:6) — every turn after
  the first threw before the HTTP call on the real Anthropic path; toPiAiRequest now stamps a zero
  usage (zero so pi-ai falls back to its char estimate rather than a fabricated window).
  createPiAiProvider gained an options seam (signal written last, loop keeps cancellation).
  FINAL-REVIEW DECISION NEEDED: the probe is a hand-kept PORT of loader.ts, guarded only by a marker
  grep — logic drift in loader.ts would not be caught.
M3 Task 6: complete (233d557, 177+1). Production-build script found: (1) package absent from
  app/.meteor/packages — all prior builds shipped no agent code; (2) adapter crash on turn 2 of any
  real Anthropic session (pi-ai estimator dereferences usage on replayed AssistantMessages) — zero-
  usage stamp fix, threading REAL transcript usage is a noted follow-up. Bare import FAILS in
  production bundles (ERR_MODULE_NOT_FOUND); file:// URL branch is the production path; shim verified.
  Probe script is a hand-kept port of loader.ts guarded by marker grep — drift risk noted.
M3 final whole-branch review: MERGE AFTER MUST-FIXES -> all applied inline (185+1 passing):
  H1 window-based compaction cut (interjected-user batch split closed, reverse-order cascade)
  H2 compaction request carries tool schemas (tools:[] with tool blocks = Anthropic 400)
  H3 interrupt during compaction: phase-conditional compacting/streaming writes + abortable
    summarization with its own phase poll
  M4 ruling applied: Agent.method fails CLOSED at registration on unenforceable schema keywords
  Landed from completeness table: canUse backstop (before gates), maxResultChars (default 8000),
    retry.maxDelayMs on the public type, context/retry/maxResultChars define-time validation
  I5-I8: README config surface + compaction section; watcher warn-once; client test try/finally;
    ask.test clean() drains stragglers until quiescent
  Spec §5/§7 patched to the SHIPPED surface (Agent.provider, manual compact(), runAs, custom
    summarizer, predicate gates -> explicitly v2 candidates; budget.idle -> approval ms)
  Accepted debt (noted, not fixed): watcher race test proves running-Set not claimLease (retitle owed);
    two console.warn patches installed pre-try; assert.throws without matchers x3; observer projection
    includes lease (extra findOne per heartbeat); post-compaction consecutive user rows unverified
    against live Anthropic; wake residual (verdict consumed while approve-defer queued) -> v2 token.
Post-M3 flake chip: retrying-phase test. Chip predated the Math.random pin (f9e6a8c) but its
  preferred observer approach was tested and REJECTED empirically: test-env mongod is standalone ->
  Meteor observer falls back to the POLLING driver, which coalesces transient phases (saw [idle],
  3/3 failures). Shipped instead: _setBackoff test seam in loop.ts (mirrors _setLeaseTimings),
  deterministic full-cap delay for this one test, global Math.random patch removed. 3/3 green.
  NOTE for ops docs: on standalone Mongo (no replica set) the watcher's observer path degrades to
  ~10s polling too — the sweep interval is what carries it. Worth a README line in v2.

== POST-M3: TIER COMPLETION (goal: complete the remaining tiers) ==
Tier 1 progress: GitHub repo created (10thfloor/meteor-agent, private) + CI green on first run
  (suite job + verify-build job, ubuntu). CONTRIBUTING.md with the pi-ai upgrade policy. Demo chat
  UI (vanilla JS + Tracker over the reactive cursor) live-verified in the browser: streaming chat,
  clock tool round trip, refund approval gate (park -> approve -> tool ran -> resumed), all against
  the real app on :3400. Fixed during verification: @swc/helpers pinned back to 0.5.17 (0.5.23's
  exports map rejects Meteor's .js-suffixed helper imports); .approval[hidden] CSS specificity bug;
  demo script answeredTool must check the LAST message, not .some().
BLOCKED on user: live smoke (no ANTHROPIC_API_KEY in env), Atmosphere publish (meteor not logged in).

== MILESTONE 4 (branch milestone-4-v2, plan 2026-08-17-agent-harness-milestone-4.md) ==
Task 1 DONE: full-schema validation via typebox + parallel tool-arg attribution. Suite 204 server
  (+1 pending) + 1 client, from 185. Probe: pi-ai re-exports typebox's `Type` ONLY (index.d.ts:1-2,
  46 root exports, no `Value`); the route is typebox's own `exports["./value"]` through a
  generalized loader seam (loadPackage/loadTypebox/typeboxValueResolvable). Value.Check takes plain
  JSON Schema and enforces enum/bounds/pattern/format/oneOf/anyOf/const/minItems/additionalProperties/
  $ref both directions. Degrades to the structural checker with ONE warn; setToolArgsValidator still
  wins. Agent.method's fail-closed guard now fires only when NO full validator is available.
  Attribution: ProviderChunk tool_args + AgentDelta gained contentIndex?; DeltaWriter coalesces per
  index; mergeView exposes `toolArgs?: Record<number, string>` on in-flight rows. verify-build.sh
  now proves the typebox chain in a real production bundle (URL-import branch wins). Full report:
  .superpowers/sdd/task-1-report.md
M4 Task 1: complete (aacc34d..HEAD, review Approved-with-issues, all fixed inline, 204+1 passing)
  Typebox route: typebox's own exports["./value"] via generalized loader (pi-ai re-exports Type only).
  Review fixes applied: ViewMessage.createdAt restored (silent type regression); runtime fail-closed
  guard in co-registered methods (resolve-succeeds/import-fails window); per-kind warn latch;
  propertyNames/additionalProperties name clamping in published reasons; README format-enforcement note.
  CORRECTION: zeroUsage (turn-2 live-path crash fix) was M3 close-out work (233d557), NOT a Task 1
  discovery — Task 1's report re-described it. My interim summary misattributed it.
  Carry: no compiled-schema cache (typebox/compile) — note for hot loops; tool_args deltas add capped-
  store pressure; DeltaWriter.push could assert kind for contentIndex.
M4 Task 2: complete (22a089b..HEAD, review 3 Medium + 4 Low, fixed/documented inline, 218+1 passing)
  Code fix: activeChild live handle on the parent session (set guarded before the child runs, cleared
  in a finally) — the documented "watch the child live" path previously had no door. +2 tests (child's
  own toolCalls budget enforced; activeChild visible mid-stream and cleared after).
  Documented honestly instead of fixed: at-least-once includes whole subagent runs on abandoned
  batches (orphaned children possible); depth bounds nesting not fan-out (budget.toolCalls effectively
  required across a subagent graph); parent interrupt does not stop a running child; child's own
  budget.approval can auto-deny a parked child; turns is inert for children.
  Carry to v3 ledger: idempotency keys for subagent dispatch (the at-least-once double-child);
  re-linking orphaned children; parent-interrupt propagation to children.
M4 Task 3: complete (session forking, 228+1 passing + 1 client, from 218). agent.fork method +
  Agent.fork server/client APIs; new server/fork.ts. The compaction batch-safety walk is factored
  out as loop.ts `batchSafeBoundary(eligible, boundary)` and shared verbatim — findCompactionCut is
  behavior-identical (its 4 pre-existing assertions unchanged). Two generalizations inside it,
  inert for compaction and load-bearing for fork: boundarySeq() is Infinity when the head is the
  whole list, and lastAnswerSeq is Infinity for an UNANSWERED batch — which is what makes forking an
  awaiting session cut before the parked assistant with no special case.
  Lineage decisions implemented + commented: parent/depth/activeChild/pending NOT copied (a fork is
  a new ROOT conversation; forkedFrom is a different relationship), lease/phase fresh, usage and
  budgetSpent ZEROED, nextSeq = cut+1, compaction notes at-or-before the cut ARE copied (verified by
  capturing the fork's first provider request), copied tool rows keep childSessionId.
  Copy is rawCollection().insertMany in chunks of 500 (no hooks exist here); session document is
  written LAST so a half-copied transcript is unreachable rather than visibly corrupt.
  Rate limits: mFork rides the existing `starts` entry (session creation), so a starts entry now
  adds 4 rules — two existing applyRateLimits count assertions updated (4->6, 6->8) plus a new test
  asserting a real agent.fork invocation matches. Full report: .superpowers/sdd/task-3-report.md
  Carry: fork of a huge transcript is O(n) docs in one method call (only rateLimit.starts bounds it);
  the copy is not transactional, so a crash mid-copy leaks inert orphan message rows nothing reaps.
M4 Task 3 (forking): complete (6234f0a, review Approved; 2 Lows fixed in 7867439 — note-drop semantics
  pinned+documented, divergence comment, nextSeq justification). Info kept: copied childSessionId
  points at source's children (correct: same userId audience); child's parent still names the source.
M4 Task 4 (MCP): complete (c5743e2 + fixes 7867439, 249+2+1 passing). 3 Mediums fixed: 15s discovery
  deadline + 30s failure cooldown (cooldown != poisoned cache — success clears), expansion moved
  inside claimLease + concurrent; env probe note corrected (SDK 1.30.0 merges getDefaultEnvironment
  itself — our merge is insurance); whole-server resume misreport -> pending.mcpServer carries the
  origin, down-at-resume now says mcp-unavailable. Lows: missing-name warn, dead export removed,
  separate MCP warn latch, server-map snapshot in the test seam.
  Ledger: watcher.test.ts 1-run flake noted by two agents (untouched files) — watch it.
M4 Task 5 (skills + hooks): complete (5d95cac, 260+2 passing + 1 client, from 249 — +11). Skills:
  config `skills:[{name,description,content}]`, validated at define time (name /^[a-z0-9-]{1,64}$/i,
  unique, non-empty description+content); buildSystemPrompt appends a `## Skills` listing (names +
  descriptions ONLY) plus one instruction sentence; built-in inline `skill` tool built at run time,
  unknown name -> Meteor.Error('unknown-skill') listing available NAMES only. Collision policy: the
  loader is appended AFTER expandMcpTools (MCP names are unknown before discovery), and an app tool
  named `skill` WINS with one latched warn — documented + tested.
  Hooks: new server/hooks.ts. Global registration (Agent.hook / Agent.clearHooks test seam), unknown
  name throws at registration, registration order, void=keep / object=replace behind a minimal shape
  check, throw-or-junk = skipped with one warn per KIND. beforeProviderRequest runs at BOTH provider
  call sites (think, per attempt; and maybeCompact's summarizer) with ctx.purpose — the summarizer
  hook falls out for free, traced in a test. afterToolResult runs at all THREE tool-row sites
  (canUse refusal, streamed dispatch, parked resume), before truncation and the row write — a
  stronger invariant than "after every dispatch", chosen so a redaction hook cannot be dodged.
  Decisions: hooks NOT in RunConfig (four turn entries would each have to remember them; global
  matches Pi's extension model — per-agent = v3), agent name for ctx read off the SESSION document
  (a child reports the child agent), and `signal` is re-stamped AFTER the hooks so a rebuilt request
  cannot disable the interrupt. Full report: .superpowers/sdd/task-5-report.md
  Carry: skill bodies obey maxResultChars (no special case); canUse can deny `skill` while the
  prompt listing stands.
M4 Task 7 (small candidates + docs close-out): complete. Suite 275 server (+2 pending) + 5 client,
  from 260 — +15 (12 in a new tests/candidates.test.ts, 3 approvals rate-limit tests in capped).
  Agent.provider(name, impl): AgentConfig.provider is Provider|string, resolved in buildRunConfig
  (NOT define — file load order would decide correctness, same reasoning resolveTools gives for
  subagent names); unknown name THROWS naming it + listing the registered (no silent pi-ai fallback:
  that bills a real provider for a config that asked for a mock); shape checked eagerly; re-register
  overwrites with one warn (hot reload). Third documented way to avoid the pi-ai peer entirely.
  Manual compact: maybeCompact split at the threshold seam -> compactNow(sessionId, agent, config,
  history, schemas, interruptCheckMs) holds everything from findCompactionCut down, unchanged (the
  4 existing compaction tests pass untouched). compactSession() takes the LEASE + the in-process
  running Set (claimLease succeeds on "already ours", so the lease alone would not stop a deferred
  turn in this process), heartbeats, and restores the phase with runTurn's exact terminal rule ->
  an idle session ends idle+unleased, nothing for the watcher to claim. Refuses 'busy' when leased
  (incl. EXPIRED — that is the watcher's orphan) or running, before spending a model call. loop.ts
  stays Meteor-free: returns 'compacted'|'nothing'|'busy'|'gone'; agent.compact method + Agent.compact
  + client compact() map it. Works with context absent (defaults) — the caller asked explicitly.
  runAs: inline+adopted only; withInvocation userId AND ctx.userId move together; presence-not-
  truthiness everywhere (null = anonymous service context; a present-but-undefined value resolves to
  null, the fail-safe direction); ToolContext.callerUserId carries the session's real owner in, which
  is what "check ctx inside the tool" means; authorization (canUse/gate/ownership) does NOT move.
  Subagent + MCP specs rejected at resolveTools with the reason.
  rateLimit.approvals: one entry, agent.approve + agent.deny, 4 rules (starts' shape).
  Docs: README Scope rewritten as "what v2 means now" (bulleted M4 inventory) + RPC/print RETIRED in
  writing (RPC mode IS DDP, print mode IS Agent.ask()); new ## Providers section; ### runAs section
  with the escalation warning + a cross-referenced paragraph in Anonymous sessions; compact-on-demand
  block; approvals in the rate-limit example. CONTRIBUTING: both peers genuinely optional, the three
  pi-ai escapes with Agent.provider as the third, the two resolveProvider properties to preserve;
  stale "one pending test" line corrected to two live smokes.
  Ledger closed: DeltaWriter.push now scopes contentIndex to tool_args — DROPPED not thrown (the
  value comes off a ProviderChunk; a third-party provider must not abandon turns), one piai.test
  assertion re-pinned from the incidental old behavior. Standalone-Mongo README line: already there.
  v3 backlog consolidated (14 items) in .superpowers/sdd/task-7-report.md — new one from this task:
  no rateLimit entry for agent.compact.
M4 Tasks 5-7: complete (c09eb2b, 302e75f, 54aa46b; first-reviewed in the final whole-branch review).
M4 final review: MERGE AFTER MUST-FIXES -> all applied (b865638): compact refuses awaiting/error
  (H1 was: manual compact destroyed a parked approval and the next send DELETED the parked turn);
  afterToolResult tested at all three sites; element no-innerHTML XSS test; rateLimit.compacts;
  canUse-row error guard. 282 (+2 pending) server + 6 client, 0 failures.
  v3 backlog consolidated in task-7 report + final review triage (idempotency keys, child re-link,
  parent-interrupt propagation, per-agent hooks, compiled-schema cache, watcher flake tracking,
  runAs-on-pending render, toolResultContent stringify guard, demo error branch, attribute churn).

== MILESTONE 5 (branch milestone-5-v3, plan 2026-08-17-agent-harness-milestone-5.md) ==
M5 Task 1 (loop robustness residuals): complete. Suite 287 (+2 pending) server + 6 client, from
  282 — +5, three consecutive clean runs.
  Subagent idempotency: the key is (parent.sessionId, parent.toolCallId, agent) + UNCLAIMED (no
  role:'tool' row in the parent naming the child) + the child's seq-0 prompt matching
  subagentPrompt(args), newest first. The parent's assistant messageId was rejected as a key
  component: discardTurn DELETES that row and the retry re-creates it with a new _id, so it can
  never match in the one case the lookup exists for. UNCLAIMED is the recency bound and the discard
  supplies it free — a child becomes reusable exactly when its call becomes re-dispatchable, and a
  healthy older turn's child never does. reuse-if-terminal (readTurnOutcome, no new child, no model
  call) / park-if-parked (subagent-parked naming the EXISTING childSessionId) / otherwise fresh.
  Lease liveness deliberately NOT read: live and orphaned both mean "no outcome to report and not
  ours to wait on", so phase alone decides; the orphan is Task 2's re-link to reach. Residual: a
  provider reusing one call id across two turns of one session, same agent, byte-identical args,
  earlier child left unclaimed -> a stale answer to an identical question. ACTIVE_PHASES moved to
  common/types.ts (one definition, watcher re-exports).
  Wake token: writeVerdict stamps pending.wakeToken with the verdict in the same atomic write; the
  wind-down self-check captures it and the deferred callback proceeds only on identity. Absent
  token degrades to the old boolean, which is why the two existing wake tests needed NO seam change.
  toolResultContent now returns {content, error} and substitutes a structured unserializable-result
  on a stringify throw (one warn per error name); all three row sites updated.
  isProviderRequest requires system:string — a rebuilt request without it sends the model no
  instructions at all and no provider reports it.
  WATCHER FLAKE ROOT CAUSE (measured, not theorized): a TEST race. Four Mongo round trips separate
  the assistant-row insert from the finally's phase-idle + releaseLease; the tests polled on the row
  count and asserted the terminal state immediately. A 12-run probe caught phase=streaming +
  lease held 12/12. Fixed by a shared finished(sessionId, n) predicate (row count AND idle AND no
  lease) on all five waits. No production change. Report: .superpowers/sdd/task-1-report.md
M5 Task 2 (lifecycle and lineage): complete (44ca698). 293 (+2 pending) server + 6 client, from
  287. Orphan-child re-link (watcher case 4, three batched queries per sweep, derived _id for
  cross-server idempotence) + parent-interrupt propagation down the activeChild chain.
  Flagged for Task 4: the sweep's child-scan is a collection scan on every session ever created.
  Report: .superpowers/sdd/task-2-report.md
M5 Task 3 (gates, hooks, surfaced identity): complete (64af3a3). 305 (+2 pending) server + 7
  client, from 293. Predicate gates on every tool kind (fail CLOSED, caller's identity not runAs's,
  evaluated at the shared dispatch site so approving one call says nothing about the next);
  per-agent hooks (globals first, then the agent's); runAs on `pending` and in the approval bar;
  element attribute-churn batching. Report: .superpowers/sdd/task-3-report.md
M5 Task 4 (perf debt + docs sweep): complete. Suite 315 (+2 pending) server + 7 client, from 305 —
  +10, all in a new tests/perf.test.ts, three consecutive clean runs.
  COMPILED VALIDATION. typebox/compile is a real exports key through the same loader seam;
  namespace {Code, Compile, Validator, default} with default === Compile; Compile(schema) takes
  ONE arg and accepts plain JSON Schema. The brief's open question answered: a compiled Validator
  DOES carry Errors, returning the SAME ajv-shaped records Value.Errors does — so reasonFor needed
  no change and the failure path does not re-run the interpreter. Errors is still feature-probed
  with Value.Errors behind it (failure path only). WeakMap keyed on the schema OBJECT (weak so
  rediscovered MCP schemas do not pin their predecessors; identity because a registered tool's
  args IS stable and hashing per call gives the win back); a null entry is a NEGATIVE cache so a
  schema the compiler throws on costs one attempt, not one per call, and its neighbours stay
  compiled. Ladder, each rung warning once and none throwing: app validator > Compile >
  Value.Check > structural. MEASURED: validateToolArgs x2000 = 3.3ms compiled vs 33.3ms
  interpreted, ~10x through the public entry point (34x on the raw checkers in an isolated probe;
  one Compile costs 0.47ms, so it pays for itself by the tenth call). The suite asserts only
  interpreted > compiled — a correctness suite must not fail on a slow JIT — and pins that the two
  rungs produce BYTE-IDENTICAL reasons across six rejection cases, because the reason is published.
  TOOL_ARGS PRESSURE, and the finding: 4 parallel calls x ~20KB args in 200-byte fragments =
  400 delta docs, 80,000 bytes. The doc count is the finding — coalescing does NOTHING for
  tool_args, because contentIndex is part of the coalescing key (it must be, or one call's JSON
  concatenates into another's) and parallel calls arrive INTERLEAVED, so no two consecutive
  fragments share an index. tool_args is the one delta kind whose doc count scales with the
  provider's fragment size rather than with the response, against a 32MiB capped collection every
  session shares with global FIFO eviction. Clamp: maxToolArgBytes on AgentConfig -> buildRunConfig
  -> RunConfig -> DeltaWriter, default 256KiB/turn. Checked BEFORE coalescing (a dropped chunk must
  not sneak in by appending to the buffered run) and before seq is assigned (a gap would silently
  truncate mergeView's backward walk); the chunk that CROSSES the ceiling is written whole, so the
  decision is monotone. One warn per turn. DISPLAY-STREAM HYGIENE ONLY, said in every doc site:
  text/thinking untouched, and the committed message's toolCalls never travel through DeltaWriter
  at all, so a clamped turn calls exactly the tools with exactly the arguments it would have.
  INDEXES (new server/indexes.ts, called from startup after ensureCapped): agent_messages
  {sessionId, seq} — verified absent, listIndexes on a fresh collection returns _id_ only, so every
  turn's history re-read was a COLLSCAN; agent_sessions {'parent.sessionId', createdAt} sparse —
  Task 2's flagged sweep scan; agent_sessions {phase, 'lease.until'} — the sweep's other three
  queries. createIndexAsync, idempotent, and failures WARN not throw (a locked-down Atlas user
  lacking createIndex must not stop the package booting) — tested both ways, including a stubbed
  code:13 not-authorized. Honest caveat recorded in the file: `sparse` on a COMPOUND index only
  omits docs missing EVERY key and every session has createdAt, so it buys nothing today;
  partialFilterExpression is the keyword that would, and it cannot be added without an index drop.
  DOCS: root README Status now lists the nine shipped v3 items instead of a backlog line (and the
  caveat points at the audits); package README gained maxToolArgBytes in the config surface and a
  new ### Operations subsection (index table, the clamp with its 400-doc measurement and the
  display-only guarantee, the validation ladder) that adopts the old standalone-Mongo note;
  predicate gates VERIFIED already documented by Task 3, no change needed; CONTRIBUTING rule 2
  gained the typebox/compile probe notes + the instruction to keep the four-rung ladder.
  Report: .superpowers/sdd/task-4-report.md
V4 SPACE (consolidated, for the audits to triage against):
  1. Retention policy for parentless children — the sweep warns once and leaves them standing
     forever, by design; nothing ever decides what happens to them.
  2. A per-DELTA-DOCUMENT clamp beside the per-turn one: the turn ceiling does not bound a single
     pathological fragment, and one 256KB tool_args chunk is written whole before it engages.
  3. partialFilterExpression on the parent index (see the sparse caveat above) — needs a drop.
  4. A rateLimit entry for agent.compact (carried from M4 Task 7).
  5. Subagent idempotency residual (M5 Task 1): one call id reused across two turns of one session,
     same agent, byte-identical args, earlier child unclaimed -> a stale answer.
  6. tool_args fragments for one index that straddle a flush tick become two docs where one would
     do. Minor next to the interleaving finding, which coalescing cannot help at all.
  7. No standing guard on compiled-vs-interpreted divergence: six rejection cases are pinned,
     nothing detects a future typebox release disagreeing on a seventh.

== M5 AUDITS + FIXES ==
Code review (cold-eyes) + Security review (attack-surface) both run. Verdicts: code "careful code,
poor safety net" — 1 Critical (no type-check in CI), 3 High; security 0 Critical, 3 High, 8 Medium
(+ strong positive findings confirming auth model / sanitization / runAs containment are sound).
Security wave (cafadbc + 69a5ed3): deny-rules (safety vs insecure, moved before first await),
startable agents (+fork guard), uncapped-agent startup warn, canUse on approval-resume, compact
budget check, MCP name-shadow + schema pattern/format strip + reason clamp, wakeToken projection,
error.reason clamp. Code/tooling wave (f506a7f): tsconfig + @types/meteor shim + CI typecheck job
(tsc --noEmit CLEAN), typebox as direct peer, DECIDED_PHASES dedup (6 sites), docs drift (7 items;
format-enforcement CONFIRMED+tested).
CONTROLLER FIX on the Critical: the delivered type gate did NOT catch the audit's headline typo
(`$inc: {'budgetSpent.toolCall'}` — Mongo keys are strings under `as any`/rawCollection). Added
SessionCounterPath/SessionInc union; narrowed allocateSeq + `satisfies SessionInc` on 5 raw
findOneAndUpdate sites. VERIFIED: the exact typo is now TS2353. CI comment corrected to state the
real reach (counter paths yes; arbitrary string modifier paths still unchecked = the as-any burndown).
DEFERRED to v4: loop.ts 2113-line file split (maintainability, risky post-audit); the as-any burndown;
security Mediums M7 watcher-scan-growth (has index now, unbounded set remains), M8 hook fail-open
opt-in, M6 length caps (partial: clamps added, no check-time text ceiling); parentless-child retention.
Suite: 334 (+2 pending) server + 7 client.
