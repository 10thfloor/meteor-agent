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
- Meteor descriptors retain literal versions for packaging. The Release Module
  checks those required mirrors rather than teaching `package.js` to import a
  build-time manifest.

Historical explorations live under `docs/superpowers/specs/`; source, tests,
this glossary, and current user documentation define the present contract.
