# ADR 0001: Agent Experience Memory

- Status: Accepted and implemented (first form)
- Date: 2026-08-31
- Scope: `10thfloor:agent`
- Superseded in part by: [ADR 0002: Automatic Learning Governance](./0002-automatic-learning-governance.md)

ADR 0002 supersedes this record's always-ask Experience rule and its prohibition
on model-authored or automatically validated Practice proposals. The remainder
of this decision, including immutable evidence, scoped recall, exact provenance,
closed Practice transitions, deliberate hardening, and Memory Frame causality,
remains in force. The original wording below is retained as decision history.

## Context

An Agent needs continuity that survives changes to its display name, model,
Team, and runtime configuration. One mutable prompt or the existing Fact Memory
store cannot represent that continuity without confusing distinct kinds of
state:

- Fact Memory records propositions about a person or the work.
- Experience records a marked difference between what an Agent expected and
  what occurred.
- Practice records a versioned way of interpreting or acting in a recurring
  context.
- Constitution records the values, commitments, and hard constraints by which
  an Agent chooses to act.

Combining them would let ordinary recall rewrite Agent identity, turn one
episode into a habit without review, and obscure which state shaped a Turn.
The implementation therefore uses separate collections behind one server-only
`Agent.learning` Interface and freezes their Turn-time inputs in a Memory Frame.

The product shorthand is: Fact Memory is what the Agent knows; Practice is how
the Agent gets good at the job; Constitution is how the Agent chooses to be.
Experience is evidence, and the Memory Frame is the causal receipt.

## Decision

### 1. Stable Agent Identity

An identity is configured with `AgentConfig.identity` and has a durable `id`.
The registry name is a handle; display name, model, Team, instructions, and
ordinary configuration are attributes around that identity.

- Rename and configuration changes preserve the identity when `id` is stable.
- Cloning requires a new `id`; Constitution, Experience, and Practice are not
  silently shared.
- The process registry rejects two different Agent names using the same
  identity id; same-name hot redefinition remains supported.
- `generation` is the compare-and-set token for Constitution-head and lifecycle
  changes.
- `experienceSeq` is a per-Agent monotonic evidence sequence.
- Lifecycle is `active` or `archived`. Archived identities cannot start a new
  Turn or accept non-lifecycle learning mutations; explicit lifecycle
  restoration remains available.

The package does not infer identity continuity from a display name. The host is
responsible for persisting and reusing the configured `id`.

### 2. Constitution

A Constitution is an immutable, content-addressed revision. The first form has
one deliberate command, `Agent.learning.reviseConstitution(...)`, that creates
a new revision and advances the identity pointer in the same transaction.

- The caller supplies the expected identity generation, body, reason, and a
  stable `LearningSource`.
- A stale generation loses with `identity-generation-conflict`.
- Revising an old row in place is not supported.
- Host policy owns who may invoke the command and what review precedes it. The
  package does not ship a universal review-role model or a separate proposal
  store.
- There is no automatic Constitution rewrite from Experience or Practice.

A Constitution cannot grant Tool access, bypass `canUse`, answer a Gate, change
a Session owner, or expand the authority of its caller.

### 3. Experience

Experience is Agent-owned episodic evidence. Its immutable semantic fields are
`expectationBasis`, `expected`, `observed`, `difference`, `lesson`, `context`,
and `confidence`.

`expectationBasis` makes hindsight visible:

- `explicit`: the expectation existed before the outcome;
- `inferred`: the expectation is inferred from prior state or behavior; and
- `retrospective`: the expectation was reconstructed after the outcome.

The built-in `experience_propose` Tool is enabled by `AgentConfig.experience`.
It is always `gate: 'ask'`. Agent identity, Session, trigger, Tool-call identity,
committed assistant Message identity, Frame provenance, and audience are closed
over by the runtime rather than accepted from model arguments. The companion `experience_search` Tool returns bounded active
evidence, including `expectationBasis`, and treats returned records as evidence,
not instructions.

- Model-proposed Experience has a deterministic identity derived from Agent and
  its full Session/assistant-Message/Tool-call source.
- Replaying the same source and command adopts the existing state.
- Reusing a stable source key with different command content is a conflict.
- A denied or unapproved proposal creates no Experience.
- Experience status moves one way from `active` to `retracted`; retraction
  preserves the row and adds source, reason, and time.

Experience remains durably owned by an Agent, but every row also persists one
exact exposure audience. `AgentConfig.experience.scope` is strict and resolves
at Frame creation:

| Scope | Audience key | Recall boundary |
|---|---|---|
| `identity` (default) | stable Agent Identity id | all owners/Sessions using that identity |
| `owner` | authenticated Session owner `userId` | that owner's Sessions |
| `session` | Session id | that Session only |

Configured owner scope falls back to session scope/key for an anonymous
Session; owner/null is never persisted. Owner means the Session owner, not a
participant, approver, Tool `runAs`, or model. Fork and child Sessions have
distinct session keys. Selection is an exact audience match, not a union.
`identity.id` is consequently the tenant/privacy boundary for identity scope;
multi-tenant hosts must allocate tenant-distinct identity ids or use a narrower
scope.

Model records require a matching Agent/Session/trigger Frame and inherit its
audience. A supplied mismatch is rejected. Exact replay may adopt the standing
immutable row after supported Frame/transcript erasure. Trusted app, system,
and migration creation remains supported, but still requires deterministic
`sessionId` and `triggerSeq` source provenance; audience omission uses the
documented identity default. A Frame-bound call must match both its audience
and source tuple.

The provider-visible proposal result is a narrow recorded/replayed receipt.
The durable row's raw audience key and runtime-owned provenance do not cross
back into model context.

### 4. Practice

A Practice revision freezes `key`, `trigger`, `guidance`, `context`, and exact
Experience `evidenceIds`. The implemented lifecycle is closed:

```text
candidate -> validated -> hardened -> retired
         \-> rejected
validated -> retired
validated -> rejected
```

- `candidate` is visible but never applied.
- `validated` is applied as a trial.
- `hardened` is applied after a trusted reviewer selects an exact later active
  same-Agent/same-context Experience.
- `retired` and `rejected` are excluded from new Frames.

Proposal requires active, same-Agent, same-context evidence. Validation rechecks
that every proposal evidence id remains active for that Agent and context, then
records a per-Agent Experience watermark. Hardening requires an Experience
id supplied by the trusted caller. The selected row must remain active, belong
to the same Agent/context, and have a sequence greater than that watermark; the
framework never silently chooses among eligible rows. Hardening consumes one
unit of identity flexibility, and retiring a hardened Practice returns that
unit. Practice content is immutable; a later approach is a new revision.

Practice and Constitution remain identity-wide. Proposing, validating, or
hardening a Practice from owner/session-scoped evidence is therefore an
explicit trusted declassification boundary: only the server mutation/review
Interface may perform it, exact evidence ids and source provenance are retained,
the selected hardening evidence audience is recorded in the audit event, and no
model-callable or automatic promotion path exists.

Retracting evidence does not silently demote a validated or hardened Practice.
The audit reports retracted proposal evidence after application and retracted
hardening evidence as separate review-needed notices, so a person or host
policy can decide whether to retire it.

### 5. Memory Frame

A Memory Frame is the immutable Turn-time causality record for one
`sessionId + agentId + triggerSeq`. It freezes:

- the active Constitution revision and digest;
- applicable validated and hardened Practice revisions;
- selected active Experience identifiers and digests;
- the exact persisted Experience audience used for selection;
- Fact Memory evidence identifiers, scopes, and digests;
- the protected learning-prompt renderer version; and
- digests of the protected learning prompt and exact Turn-local Fact Memory
  prompt.

The first runner creates the Frame before paid provider work. Provider retries,
Tool iterations, approval resume, and crash recovery adopt the same Frame.
Changes to Constitution, Practice, Experience, or Fact Memory take effect on a
later trigger. This includes an Experience scope config change: recovery keeps
the original Frame audience and a later trigger resolves the new one. Exact
Fact Memory prompt text is not copied into the durable
Frame; recovery re-renders it and fails closed if its evidence or digest changed.

*Amendment (2026-09-01).* "Its evidence changed" means the FROZEN evidence:
recovery fetches the frame's evidence rows by id and fails closed only when a
frozen row was edited or erased. Rows added since the freeze — including the
Turn's own auto-gated `memory_save`, or another session's — are not this
frame's causes and do not void a parked approval; a store read failure is
transient and leaves the park and its recorded verdict intact for retry. A
park additionally persists its exact Frame id, so an approval resume adopts
the anchored Frame rather than re-deriving the trigger, and the
provider-request audit event is an append-only insert (deterministic id, no
transaction, no identity write) so concurrent sessions of one Agent no longer
serialize on the identity document.

Three accepted tradeoffs, named so they are decisions rather than surprises:
evidence integrity covers each frozen row's id, scope, and text — a pin
toggle or `by` edit changes presentation, not the causes, and does not void a
park; the append-only audit event tolerates the narrow window where an
archive commits between its lifecycle read and the insert (the event is a
record of a call already in flight); and a user message that lands while a
turn is PARKED is answered by the resumed turn under its anchored Frame — the
model sees and addresses it, at the cost of that one reply spanning a second
trigger, where the alternative was answering it twice.

Protected-prompt rendering is part of the immutable causal record, not current
presentation code. New Frames record renderer version 2 in their payload and
digest. Unversioned Frames remain immutable: their stored prompt digest selects
one of the retained byte-exact legacy renderers, checking version 1 before the
brief transitional unversioned version 2 format. An explicit version is always
strict, an unknown version fails closed, and old Frames are never backfilled or
rewritten when a renderer changes.

Protected Constitution and Practice text is finalized after provider hooks.
Hooks cannot silently remove it. This proves which protected bytes were sent;
it does not prove that the model understood or obeyed them.

Constitution is authoritative over Practice. The protected prompt applies a
Practice only when its trigger matches and the guidance remains consistent
with the Constitution; any conflict resolves in favor of Constitution.

`Agent.ask()` follows the same identity lifecycle and protected-frame seam.
Its Session-owned Frame and transcript are erased with the throwaway Session;
Agent-owned identity state remains. Fact Memory is intentionally absent. When
Experience recall is enabled, search remains available over the Frame's frozen
evidence. An authorized model proposal that reaches its approval Gate cannot
complete headlessly; `canUse` may instead deny it before the Turn parks. A
successful answer is returned only after throwaway erasure completes; pending
cleanup fails closed while lifecycle recovery finishes the durable fence.

### 6. Ownership, archival, and erasure

Identity, Constitution, Experience, Practice, and Learning Events are owned by
the Agent identity. Memory Frames are owned by the Session whose Turn they
describe.

- Archiving an Agent preserves its Agent-owned learning and audit history while
  preventing new Turns and non-lifecycle mutations. Explicit lifecycle
  restoration remains available.
- Session erasure recursively deletes Frames for the erased root and child
  Sessions, together with other Session-owned data.
- Session erasure retains Agent-owned learning and Fact Memory. A surviving
  Experience may therefore retain a Session identifier or `frameId` whose
  Session/Frame was deliberately erased.
- Audience controls exposure, not durable ownership. A surviving
  session-scoped Experience cannot be recalled by another Session but remains
  available to privileged audit/history reads.
- `Agent.learning.audit(agentId)` reports that expected loss as a notice, not an
  integrity failure. A missing Frame for a surviving Session remains an issue.

In Constellation, archival fences the Agent before reference cleanup, then
removes it from Mission rosters, Skill/MCP assignments, and Pulse execution.
An already-streaming provider response may still complete, but `canUse` checks
the current Mission/Agent lifecycle before a consequential Tool side effect can
start. The framework does not claim remote provider cancellation after archival.

### 7. Persistence, retries, and audit

Learning mutations use Mongo transactions, deterministic identifiers, unique
indexes, active-Identity write fences, generation/status selectors, canonical
command digests, and a same-transaction `AgentLearningEvent`.

The guarantees are about visible durable state:

- retrying the same logical source and command does not duplicate state;
- reusing an idempotency source with different content conflicts;
- one Memory Frame exists per Session/Agent/trigger tuple;
- an explicit Frame source must match that Session/trigger tuple;
- stale generations and invalid Practice transitions cannot commit;
- hardening cannot commit without one exact eligible later Experience id, and
  changing that id while reusing the same mutation source is a command conflict;
- an archive that wins the Identity write fence prevents a concurrent learning
  mutation from committing afterward;
- Experience sequence and hardening watermark establish ordering without wall
  clocks; and
- mutation and audit event commit together.

External provider or evaluator cost may repeat after an ambiguous crash. A
retry is not a promise that external computation ran exactly once. Correctness
indexes are startup requirements; failure to create them fails startup rather
than degrading mutation safety.

### 8. Interface and trust boundary

`Agent.learning` is server-only. It exposes commands, audit, prompt/frame
helpers, and scoped read cursor factories. The collections are private,
excluded from autopublish, and not a browser write surface.

Turn search uses only the frozen Frame ids/digests under its exact audience.
Search constructed outside a Frame must receive an explicit resolved audience
and otherwise fails closed. `listExperiences` exact-filters its audience (with
identity default retained for compatibility). Raw read cursor factories are
privileged, cross-audience enumeration surfaces; hosts must enforce tenant
authorization and audience filtering before publishing end-user recall data.

Constellation deliberately adds owner-authorized DDP methods and a filtered
read-only publication for its control panel. That host is currently a local
singleton workspace claimed by one Meteor account; it is not yet the proposed
multi-organization authorization model.

Browser callers, model output, Provider Adapters, MCP servers, Channels, and
ordinary Session participants remain untrusted for raw learning-state mutation.
Database administrators and arbitrary code importing private collections are
outside this guarantee.

## Proof scope and limits

Tests support the structural contract: closed transitions, one-winner
compare-and-set behavior, replay adoption, per-Agent isolation, Frame freezing,
exact owner/Session audience isolation, Session erasure semantics, and audit
linkage. They do not prove:

- that an Experience is true, complete, or unbiased;
- that an expectation was classified correctly;
- that a Practice is useful or generally safe;
- that evidence is independent or unpoisoned;
- that a model follows Constitution or Practice; or
- that behavior survives model or provider drift.

`hardened` means the implemented validation and later-evidence rules were met.
It does not mean proven true.

## Consequences

The design makes Agent continuity, learning provenance, and Turn causality
inspectable and recoverable. Its cost is additional durable state, strict index
requirements, one-Turn delay before new learning applies, explicit review work,
and a host policy burden for Constitution and Practice administration.

Rejected alternatives remain: one mutable Fact Memory bucket, direct ungated
model writes, immediate candidate application, rebuilding learning state on
every provider attempt, and treating hardened Practice as truth.
