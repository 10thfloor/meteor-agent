# Domain context

This is a Meteor-native agent harness. Its organizing idea is that a durable
Meteor Session—not a request handler or an SDK object—is the center of an
agent conversation. pi-ai is the default model Adapter; it is not the harness.

## Language and ownership

| Term | Meaning | Owning Module / Interface |
|---|---|---|
| Agent | A named, server-defined model participant and its policy. | `Agent` and the registry |
| Session | Durable conversation identity, owner, phase, budget, and lineage. | Session collections; `Agent#send`, `#fork`, `#erase` |
| Turn | One leased progression from Transcript input through provider and tool work. | Turn loop and Lease primitives |
| Transcript | Committed Messages plus temporary streaming Deltas. | Transcript/commit Implementation and publications |
| Lease | Cross-server single-writer claim for a Session Turn. | Lease Module |
| Activation | Level-triggered coordination from durable Session evidence to one eligible Turn. | Private Activation Module |
| Tool | Model-callable behavior with a schema and execution context. | Tool runtime Interface |
| Gate | Policy that parks a Tool call for a human verdict. | Tool runtime and approval methods |
| Provider Adapter | Maps the generic provider stream Interface to a model library. | `Provider`; pi-ai is the default Adapter |
| Provider Exchange | One hook-processed, cancellation-aware attempt through a Provider Adapter. | Private Provider Exchange Module |
| Participant | Human or model member of a rostered Session. | Participant Module |
| Channel | An external conversation surface such as Slack or email. | Channel registry |
| Lens | Pure translation between a Channel's wire meaning and harness meaning. | Channel contract |
| Binding | Routing from one external conversation to one Session. | Channel collections/ingress |
| Receipt | Durable record of an attempted Channel delivery. | Channel egress |
| Release | One verified snapshot of the core and five Channel packages. | `release.json` and the release check |
| Session Lifecycle | Owner-scoped recursive erasure of Session-owned data. | `Agent#erase` |
| Agent Identity | Stable continuity for one Agent across display-name, model, Team, and configuration changes. | `Agent.learning`; Agent Identity Module |
| Fact Memory | Durable propositions about a person or the work; knowledge an Agent may use, but not what defines that Agent. | Existing Memory Module and `AgentMemories` |
| Experience | Agent-owned, provenance-linked evidence of a difference between what was expected and what occurred. | `Agent.learning`; built-in Experience Tools |
| Practice | A versioned, reversible way an Agent classifies a situation or acts within it: how to be good at the work. | `Agent.learning`; Practice consolidation within the Learning Module |
| Constitution | The reviewed values, commitments, and hard constraints that express how an Agent chooses to be. | `Agent.learning`; Agent Identity Module |
| Learning Governance/Admission | The per-Agent, per-Turn policy that decides whether model-authored Experience waits for approval and whether an evidence-bound Practice proposal waits as a candidate or activates automatically as a trial. | `AgentConfig.experience` / `practice`; Memory Frame; Learning Module |
| Memory Frame | The exact Constitution, Practices, Fact Memory evidence, Experience evidence, and Learning Governance frozen for one Turn. | `Agent.learning.freezeFrame`; Turn loop |

## Architectural direction

- Keep the ordinary Interface on `Agent`; expose lower-level stores only when
  an application or Channel author genuinely needs them.
- Keep Activation private. Public Agent calls commit durable evidence; Activation
  resolves the eligible Agent, and the Turn's exact Lease claim chooses one runner.
- Preserve the deep Lens/Transport Seam. Channel differences belong in an
  Adapter, while authorization, Transcript ordering, retries, and delivery
  receipts remain shared.
- Treat provider libraries as Adapters. A supplied generic `Provider` must not
  pass through pi-ai, and the default pi-ai Adapter stays lazy.
- Keep Session Lifecycle distinct from Memory and account identity. Erasing a
  conversation preserves user/app Memory and linked Channel Identity.
- Keep Fact Memory, Experience, Practice, and Constitution logically distinct.
  Facts describe what is known; Experience records what happened; Practice
  encodes how to do the work well; Constitution encodes how the Agent chooses
  to be. Experience may shape Practice through Consolidation, while changing
  Constitution is rare, deliberate, and reviewed.
- Give every Agent stable Agent Identity. Rename, model, Team, and configuration
  changes preserve it; cloning creates a new identity rather than silently
  sharing Experience.
- Freeze a Memory Frame at the Turn seam. Retries use the same Constitution,
  Practice versions, and Learning Governance; newly admitted changes take
  effect on the next Turn. Automatic Practice admission may validate a trial,
  but hardening always requires an explicit later-evidence review.
- Keep lifecycle ownership explicit. Session erasure removes Session-owned
  Frames while retaining Agent-owned Identity, Constitution, Experience,
  Practice, and their audit history. Missing erased provenance is an expected
  audit notice, not silent corruption.
- Meteor descriptors retain literal versions for packaging. The Release Module
  checks those required mirrors rather than teaching `package.js` to import a
  build-time manifest.

Historical explorations live under `docs/superpowers/specs/`; source, tests,
this glossary, and current user documentation define the present contract.
