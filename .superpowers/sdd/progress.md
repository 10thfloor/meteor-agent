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
