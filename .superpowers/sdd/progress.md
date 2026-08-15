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
