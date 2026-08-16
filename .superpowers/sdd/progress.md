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
