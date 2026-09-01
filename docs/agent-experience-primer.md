# Agent Experience: a first-form primer

`meteor-agent` now ships a first form of stable Agent identity and experiential
learning. The practical rule is simple: knowing a fact, observing an outcome,
forming a habit, and changing an Agent's commitments are different operations.
They do not share one mutable memory bucket.

## The five records

In one line: **Fact Memory is what the Agent knows. Practice is how the Agent
gets good at the job. Constitution is how the Agent chooses to be.** Experience
is the evidence bridge from outcome to reviewed competence; the Memory Frame
is the receipt, not another kind of memory.

| Record | Question | Rule |
|---|---|---|
| Fact Memory | What is known about a person or the work? | Mutable durable propositions, scoped to user, Agent, or app |
| Constitution | Who does this Agent choose to be? | Immutable revisions; one active identity pointer |
| Experience | What differed from expectation? | Append-first Agent-owned evidence with provenance |
| Practice | How should this Agent handle a recurring context? | Immutable revisions with a controlled lifecycle |
| Memory Frame | What exact state shaped this Turn? | Session-owned snapshot, frozen once per trigger |

The shorthand is L0 for identity/Constitution, L1 for Experience, and L2 for
Practice. It is useful design vocabulary, not a claim that every nuance of
Bateson's learning levels maps one-to-one onto software state.

## Enable it on an Agent

Learning is opt-in. Give the Agent a stable identity, then configure Experience
and, optionally, Agent-authored Practice acquisition:

```ts
new Agent('support', {
  model: 'anthropic/claude-sonnet-5',
  instructions: 'Help with support work.',
  identity: {
    id: 'support-agent-v1',
    displayName: 'Support',
    constitution: 'Protect customer trust. State uncertainty. Require evidence.',
    flexibility: 4,
  },
  experience: {
    record: true,
    recall: { recent: 12 },
    scope: 'owner',
    approval: 'ask',
  },
  practice: {
    acquire: true,
    approval: 'ask',
    allowScopedEvidencePromotion: false,
  },
});
```

`experience: true` enables recording and recall of up to 4 recent Experiences.
Recording adds `experience_propose`; recall adds `experience_search`.
`experience: { record: false, recall: { recent: 8 } }` is recall-only, and
`recall: false` disables search. Experience requires `identity`; omitting both
disables the identity-owned learning layers. Independently configured Fact
Memory remains available.

`experience.approval` is independently `ask` (the default) or `auto`.
`practice: true` enables acquisition with approval `ask` and no scoped-evidence
promotion. Its object form accepts `acquire`, `approval`, and
`allowScopedEvidencePromotion`. Practice acquisition needs recalled Experience
in the current Frame before its Tool can be useful.

Object configuration is strict. Experience accepts only `record`, `recall`,
`scope`, and `approval`; `recent` must be an integer from 0–20. Practice accepts
only the three fields above. Unknown options and invalid types fail at Agent
definition instead of silently selecting another governance policy.

The configured identity `id` is the continuity key. Keep it stable across a
rename, model change, Team move, or instructions edit. A clone needs a new `id`.
Two simultaneously registered Agents cannot use the same identity id. It is
also the tenant/privacy boundary when `scope` is `identity`.

### Experience audience

Each Turn resolves `scope` once and persists an exact `{ scope, key }` audience
on both its Memory Frame and every Frame-bound Experience:

| Config scope | Persisted key | Visibility |
|---|---|---|
| `identity` (default) | stable Agent Identity id | Every owner and Session using that identity |
| `owner` | authenticated Session owner's `userId` | That owner's Sessions only |
| `session` | Session id | That Session only |

An anonymous Session configured with `owner` falls back to its Session id and
persists `session` scope; it never writes an empty owner key. `owner` means the
Session owner, not another participant, approver, Tool `runAs`, or model.
Forks and child Sessions have their own Session keys.

Selection is an exact match, never a union. An owner-scoped Turn does not also
see identity- or session-scoped evidence. `identity` is deliberately broad,
including anonymous Sessions, so multi-tenant hosts must allocate
tenant-distinct identity ids or choose a narrower scope. A config change affects
the next trigger; recovery keeps the already frozen Frame and audience.

## Constitution: deliberate commitments

A Constitution is immutable. `Agent.learning.reviseConstitution` creates and
activates a new revision in one transaction:

```ts
const result = await Agent.learning.reviseConstitution(
  agentId,
  identity.generation,
  'Protect customer trust. Verify irreversible actions.',
  'Require verification before consequential work',
  { kind: 'app', key: 'constitution-review:2026-08-31:7' },
);
```

The generation is a compare-and-set token. If another revision or lifecycle
change won first, the command fails instead of overwriting its result. The host
decides who may review and invoke this command; the package has no universal
review-role model. Experience never rewrites Constitution automatically.

Constitution text can shape model behavior, but cannot grant a Tool, bypass
`canUse`, answer an approval Gate, or change Session ownership.

## Experience: expectation versus observation

An Experience is a structured claim with expected and observed outcomes, their
material difference, a lesson, a stable context mark, confidence, and source
provenance. It is not a transcript summary or an instruction.

Every Experience declares how its expectation arose:

| Basis | Meaning |
|---|---|
| `explicit` | The expectation was stated before the outcome |
| `inferred` | The expectation is inferred from prior state or behavior |
| `retrospective` | The expectation was reconstructed after seeing the outcome |

This distinction does not ban hindsight; it makes hindsight reviewable.

When the model calls `experience_propose` and `canUse` permits it, the policy
frozen in the Turn's Memory Frame decides admission. With
`experience.approval: 'ask'`, the ordinary Gate parks the Turn; approval records
the Experience with `admission: 'reviewed'`, while denial records nothing. With
`auto`, the Tool runs without parking and records `admission: 'automatic'`,
pending later audit. A `canUse` refusal still happens before either route and
creates no Experience.

The model supplies only semantic fields. The runtime supplies Agent, Session,
trigger, committed assistant Message (`assistantMessageId`), Tool-call, Memory
Frame, admission route, and exact audience. None is present in the model Tool
schema. Its result is only a success/replay receipt; raw audience keys and
internal provenance are never sent back to the provider.

The durable row is deterministic for the full Agent, Session, assistant
Message, and Tool-call source. A retry with the same source and command adopts
the existing row. Reusing that
source with different content is a conflict, not an overwrite. Content remains
immutable; retraction changes `active` to `retracted` and records who, when, and
why. Retracted rows remain in history but are excluded from new evidence work.
An automatically admitted row can be acknowledged later with
`Agent.learning.review({ agentId, target: 'experience', id, source, reason? })`.
Its `review` records time, source, and optional reason without changing the
original admission route or semantic evidence. Correcting content means
retracting it and recording a replacement, not editing history in place.

For model-authored records, the runtime proves that the declared assistant
Message is a committed assistant row in the same Session and that it contains
the declared Tool call. A matching Frame is mandatory, and a caller-supplied
audience mismatch is rejected. Exact replay adoption does not depend on the transcript
still existing after supported Session erasure.

`experience_search` searches only the active evidence frozen into the current
Turn's Frame and returns `expectationBasis` with the evidence. A mid-Turn
retraction affects the next Frame, not the already frozen Tool surface.
Server code constructing search outside a Frame must provide an explicit
resolved audience; absence fails closed rather than falling back to all rows for
the Agent. `listExperiences` also exact-filters an audience and defaults to
identity scope only for framework compatibility.

Trusted app, system, and migration calls may create Experience explicitly, but
their stable source must still include `sessionId` and `triggerSeq`. Their
omitted audience defaults to `{ scope: 'identity', key: agentId }`; a
Frame-bound call must match the Frame audience and source tuple.

## Practice: governed ways of working

A Practice has a stable key, trigger, guidance, context, and exact Experience
evidence. Its states are:

| Status | Used in a new Turn? | Next states |
|---|---:|---|
| candidate | No | validated, rejected |
| validated | Yes, as a trial | hardened, retired, rejected |
| hardened | Yes | retired |
| retired | No | none |
| rejected | No | none |

Proposal requires 1–50 distinct, stable Experience ids. Every id must resolve to
active evidence owned by the same Agent with the same context mark; malformed,
duplicate, and over-limit lists are rejected before lookup. Validation rechecks
that every proposal evidence id is still active and belongs to the same Agent
and context, then records the Agent's current Experience sequence as a
watermark. Hardening requires the trusted reviewer to name one exact active
same-Agent/same-context Experience whose sequence is later than that watermark;
the framework never silently chooses an eligible row. The transition consumes
one unit of the identity's configured flexibility. Retiring a hardened Practice
returns that unit.

When `practice.acquire` is enabled and the Frame contains recalled Experience,
the built-in `practice_propose` Tool may create a candidate. It accepts only a
key, trigger, guidance, context, and exact Experience ids from that Frame;
Agent, source, Frame, status, and transitions remain runtime-owned. The Tool is
automatic because an inert candidate does not affect model behavior.

With `practice.approval: 'ask'`, a model proposal remains a candidate in
Reviews. With `auto`, eligible evidence immediately moves the candidate to
`validated` with `validationAdmission: 'automatic'`. It never becomes hardened
automatically. Proposal and validation remain separate durable events, and
validation still rechecks evidence before recording its watermark.

Practice and Constitution are identity-wide, not audience-partitioned. Using
owner- or session-scoped Experience as Practice evidence deliberately
declassifies guidance to the whole identity. Automatic validation therefore
requires `practice.allowScopedEvidencePromotion: true`; otherwise the candidate
waits in Reviews even when Practice approval is `auto`. Identity-scoped
evidence needs no extra promotion consent. A hardening transition may later
select audience-partitioned evidence deliberately; its exact id and audience
remain in the audit record.

Retracting evidence does not silently demote a validated or hardened Practice.
`Agent.learning.audit(agentId)` reports one review-needed notice when proposal
evidence is retracted after application, and another when the later hardening
evidence is retracted. The host can then retire the Practice deliberately;
history is not rewritten behind the reviewer.

An automatically validated Practice is visibly pending post-admission audit.
`Agent.learning.review({ agentId, target: 'practice', id, source, reason? })`
acknowledges it without changing its guidance, `validationAdmission`, status,
or hardening state. Corrections use retirement or rejection followed by a new
immutable revision.

## Memory Frame: one Turn, one causal snapshot

Before paid provider work, the Turn loop creates or adopts a Memory Frame for
`sessionId + agentId + triggerSeq`. The Frame freezes:

- the active Constitution revision;
- validated and hardened Practice revisions;
- selected active Experience identifiers and digests;
- the exact Experience audience used for selection;
- the Experience admission and Practice acquisition policy;
- selected Fact Memory identifiers, scopes, and digests; and
- the protected learning-prompt renderer version and digest.

Provider retries, Tool iterations, approval resume, and crash recovery reuse
that Frame. A governance edit, Constitution revision, Practice transition,
Experience admission/retraction, or Fact Memory change applies on a later
trigger. An Experience recorded or Practice validated during a Turn cannot
rewrite that Turn's protected inputs.

The protected renderer is versioned because its exact whitespace and guidance
are part of what the Frame proves. New Frames freeze version 2. Older Frames
without a version are not migrated or mutated; their stored digest selects the
retained byte-exact legacy renderer (version 1 first, then the short-lived
unversioned version 2 format). Explicit and unknown versions never fall back:
any mismatch fails closed. A renderer wording change therefore needs a new
version rather than silently invalidating prior Turns.

Fact Memory prompt bytes remain Turn-local for privacy. The Frame stores their
digest and evidence references. Recovery re-renders the Fact block and fails
closed if it no longer matches. Constitution and Practice text is protected
after provider hooks run, but this proves only what the Adapter received—not
that a model understood or obeyed it.

`Agent.ask()` uses this identity seam too. It lifecycle-checks the Identity and
freezes a protected Constitution/Practice snapshot before provider work. When
Experience recall is enabled, `experience_search` remains available against the
evidence frozen into that Frame. Its throwaway Session, transcript, and Frame
are erased in `finally`, while the Agent-owned Identity and learning history
remain. Fact Memory is excluded from one-shots. With
`experience.approval: 'ask'`, an allowed `experience_propose` call reaches its
Gate and the headless Turn ends as `ask-parked`; `canUse` may instead deny it
before parking. With `auto`, the Experience may be admitted and survive the
throwaway Session. Enabled Practice acquisition follows the same frozen policy:
a candidate may survive for review or activate as a future-Turn trial. These
effects must be enabled deliberately because `Agent.ask()` has no live reviewer.

An answer is returned only after throwaway erasure completes. If cleanup is
fenced but still pending, `Agent.ask()` fails closed and lifecycle recovery
finishes the erasure. It does not return an answer while temporary Session or
Frame state remains.

Constitution outranks Practice inside the protected prompt. A Practice applies
only when its trigger matches and it is consistent with the Constitution; any
conflict is resolved in favor of the Constitution.

## The server Interface

`Agent.learning` is server-only and exposes:

- `ensureIdentity`, `reviseConstitution`, and `setLifecycle`;
- `recordExperience`, `retractExperience`, `listExperiences`, and
  `review({ agentId, target, id, source, reason? })`;
- `proposePractice`, `transitionPractice`, and `transitionAllowed`;
- `freezeFrame`, `protectedPrompt`, and `recordProviderRequestDigest`;
- `audit`; and
- scoped `read` cursor factories for host publications.

Every mutation needs a stable `LearningSource.key`. Source identity and a
canonical command digest form the idempotency contract: same source plus same
command adopts prior state; same source plus different command conflicts.
Mutations and their `AgentLearningEvent` commit together.
For hardening, the selected `hardeningEvidenceId` is part of that command:
`transitionPractice(agentId, practiceRevisionId, 'hardened', reason, source,
hardeningEvidenceId)`. Other transitions retain the five-argument form. Reusing
one source with a different selected proof is therefore a conflict.
An explicit `freezeFrame` source must name the same Session and trigger as the
Frame tuple, so audit provenance cannot disagree with the causal snapshot.

The read cursor factories do not make the collections a browser API. Learning
collections are private and denied as a client-write surface. A host may expose
a filtered publication and authorized methods, as Constellation does. Those
cursor factories are privileged enumeration surfaces across audience
partitions; hosts must authorize and audience-filter any end-user publication.

## Archive and erase mean different things

Archiving an Agent changes its identity lifecycle to `archived`. It blocks new
Turns and all non-lifecycle learning mutations while retaining Identity,
Constitution, Experience, Practice, and audit history. An explicit lifecycle
restoration is the exception: it reactivates the same identity.

Erasing a Session removes the root conversation, descendant Sessions, and their
Session-owned Memory Frames. Forks survive because they are new roots. Agent-
owned learning and Fact Memory survive. Consequently, a retained Experience can
refer to a Session or Frame that was intentionally erased. The audit reports
`Session-erased Frame provenance` as a notice; it does not mislabel expected
privacy erasure as corruption. A missing Frame for a Session that still exists
is an integrity issue.

Audience limits recall, not durable ownership. A session-scoped Experience may
survive after its Session is erased, but no different Session can recall it.
Privileged audit/history code can still enumerate it.

In Constellation, an Agent archive fence lands before roster and assignment
cleanup. No new consequential Tool action can pass the host's current lifecycle
check afterward. An already-streaming provider response may still finish; the
app does not claim it can retract remote computation already in flight.

## Constellation's control panel

Constellation subscribes to a filtered `constellation.learning` publication for
Agents in the local workspace. Directory → Agents provides:

- Profile, Constitution, Experience, Practices, and Frames tabs;
- active Constitution text, versions, reasons, and history;
- Experience provenance, expectation-basis labels, confidence, and retraction;
- automatic-admission state and post-admission audit acknowledgement;
- Practice evidence, proposal, validation, hardening, retirement, and rejection;
- latest Frame and learning counts; and
- an aggregated Reviews queue for candidate Practices and recent learning.

Agent removal is archival: the confirmation explains that identity and history
are preserved. These DDP affordances belong to the Constellation host, not to
the package's universal browser API. Current Constellation ownership is one
local singleton workspace claimed by one Meteor account; organization and Team
authorization remain future host work.

The host contract is the filtered `constellation.learning` publication plus
`constellation.constitutionRevise(agentId, expectedGeneration, body, reason)`,
`constellation.experienceRetract(agentId, experienceId, reason)`,
`constellation.learningReview(agentId, target, targetId)`,
`constellation.practicePropose(agentId, proposal)`, and
`constellation.practiceTransition(agentId, practiceRevisionId, status, reason,
hardeningEvidenceId?)`.
All methods re-check local workspace ownership and active Agent lifecycle on the
server; the browser never sends a `LearningSource` or writes a collection.

## What the guarantees do—and do not—mean

Transactions, unique indexes, deterministic IDs, generation/status selectors,
Experience watermarks, active-Identity write fences, and durable audit events
make visible learning state idempotent across enumerated retries and races. If
archival wins its Identity write, a concurrent learning mutation cannot commit
after it. External model or evaluator cost
may repeat after an ambiguous crash. Correctness indexes are startup
requirements rather than optional optimization.

The framework does not prove that an Experience is true, that its basis is
classified correctly, that evidence is unbiased, that a Practice is safe, or
that a model obeys protected text. `hardened` means the declared validation
rules were met and the trusted reviewer selected one eligible later Experience.
It does not mean universally correct.

The decision records are
[ADR 0001: Agent Experience Memory](./adr/0001-agent-experience-memory.md) and
[ADR 0002: Automatic Learning Governance](./adr/0002-automatic-learning-governance.md).
