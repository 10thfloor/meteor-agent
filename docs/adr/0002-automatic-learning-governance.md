# ADR 0002: Automatic Learning Governance

- Status: Accepted and implemented
- Date: 2026-08-31
- Scope: `10thfloor:agent`
- Supersedes in part: [ADR 0001: Agent Experience Memory](./0001-agent-experience-memory.md)

## Context

ADR 0001 made every model-authored Experience wait at an approval Gate and
allowed Practice creation only through a trusted server review path. Those are
safe defaults, but they force attended work and prevent an explicitly trusted
Agent from accumulating reviewable Experience or proposing evidence-bound ways
of working while a Mission continues.

Automatic learning must not become untraceable self-modification. The policy
that admits learning is therefore distinct from the semantic record, frozen at
the Turn seam, and visible after the fact. Constitution and Practice authority,
Experience audiences, exact evidence, and hardening rules remain unchanged.

## Decision

### 1. Learning Governance and Admission

Learning Governance is the per-Agent policy configured with
`experience.approval` and `practice`. Admission is the immutable account of how
one record became active: `reviewed`, `automatic`, or, for a trusted server
Experience, `trusted`.

The defaults remain conservative:

```ts
experience: { approval: 'ask' }
practice: {
  acquire: false,
  approval: 'ask',
  allowScopedEvidencePromotion: false,
}
```

Both approval modes are individually configurable. Unknown options and values
fail during Agent definition.

### 2. Governance is frozen per Turn

Each new Memory Frame freezes whether Experience recording is enabled, its
recall limit and admission mode, whether Practice acquisition is disabled,
reviewed, or automatic, and whether scoped evidence may be promoted. Retries,
Tool iterations, approval resume, and recovery adopt that exact policy. A config
edit affects a later Frame, never an in-flight Turn. Legacy Frames fail safe to
reviewed Experience admission and disabled Practice acquisition.

### 3. Experience admission

`experience.approval` accepts `ask` or `auto` and defaults to `ask`.

- `ask` keeps `experience_propose` behind the ordinary approval Gate. Approval
  records an Experience with `admission: 'reviewed'`; denial records nothing.
- `auto` makes the same Tool automatic. It records
  `admission: 'automatic'` with the same runtime-owned Agent, Session, trigger,
  assistant Message, Tool-call, Frame, and audience provenance.

Automatic admission changes only the Gate decision. It does not weaken schema,
audience, Frame, transcript, idempotency, or active-Identity checks.

### 4. Practice acquisition and automatic validation

`practice` is opt-in. `practice: true` means acquisition enabled, approval
`ask`, and no scoped-evidence promotion. The object form accepts exactly:

- `acquire`: expose agent-authored acquisition when frozen Experience evidence
  is available;
- `approval`: `ask` leaves the proposal as a candidate, while `auto` may
  validate it immediately as an active trial; and
- `allowScopedEvidencePromotion`: explicit standing consent to turn owner- or
  session-scoped evidence into identity-wide guidance.

The built-in `practice_propose` Tool is itself automatic because creating a
candidate does not apply it. It accepts only `key`, `trigger`, `guidance`,
`context`, and exact Experience ids from the current Frame. Agent, source,
audience, Frame, status, and transition targets are runtime-owned. Core proposal
and validation checks still require active, same-Agent, same-context evidence.

With `practice.approval: 'auto'`, an eligible candidate is immediately moved to
`validated` with `validationAdmission: 'automatic'`. If the Frame audience is
narrower than identity and `allowScopedEvidencePromotion` is false, the
candidate remains in Reviews. Automatic admission has no Interface for
hardening, retirement, rejection, or Constitution revision.

### 5. Hardening is never automatic

`validated` remains a reversible trial. Only a trusted caller may harden it by
naming one exact later active, same-Agent, same-context Experience beyond the
validation watermark. Hardening still consumes flexibility and records the
selected evidence id and audience. No automatic policy selects hardening proof.

### 6. Audit acknowledgement and correction

Automatic Experience and validated Practice records remain visibly pending
post-admission review. The public Interface is:

```ts
Agent.learning.review({ agentId, target: 'experience' | 'practice', id, source, reason? })
```

It appends a `learning-reviewed` event and records reviewer source, time, and
optional reason. It acknowledges the standing record; it does not rewrite
semantic content, change the original admission route, or make a Practice
hardened.

Corrections preserve history: retract an Experience or retire/reject a Practice,
then create a replacement revision. Admission, review, and lifecycle mutations
remain deterministic and transactionally paired with Learning Events.

### 7. Effect on model behavior

An admitted Experience becomes available to later Frames in its exact audience.
An automatically validated Practice becomes available to later Frames across
the Agent Identity. Neither changes the Memory Frame or protected prompt of the
Turn that created it. Constitution continues to outrank every Practice.

## Proof scope and limits

The audit proves which frozen policy admitted a record, its exact provenance,
and whether a person later acknowledged it. It does not prove that an
Experience is true, that a model-authored Practice is useful, or that automatic
learning is free from bias or self-reinforcement. `validated` means trial, not
truth; `hardened` retains ADR 0001's narrower structural meaning.

## Consequences

Attended review remains the default, while hosts may explicitly permit
uninterrupted learning. The cost is a larger governance and audit surface,
especially when owner- or session-scoped evidence is promoted into
identity-wide Practice. Hosts must make automatic admission and pending review
visible and preserve a deliberate correction path.
