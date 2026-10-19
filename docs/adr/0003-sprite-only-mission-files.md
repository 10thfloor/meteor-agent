# 0003 — Sprite-only mission file contents

Status: accepted, 2026-09-22.

## Decision

Constellation stores new file contents only in the mission's Sprite. Mongo keeps
conversation/file metadata and references, not a duplicate downloadable file.
There is one Files view of `/workspace`. Chat-linked uploads and generated results
use immutable content-addressed paths under `/workspace/attachments`.

The framework's `Agent.attachments` interface owns admission, caps, references,
hydration, download resolution, integrity checks and session-erasure fences.
The host-selected storage adapter owns byte I/O. Constellation binds that seam to
its existing environment lifecycle and native Sprites filesystem API. Other
framework consumers retain their existing default storage unless configured.

## Consequences

- The owner must enable the mission filesystem before saving new files. Storage
  does not provision implicitly or grant code execution.
- Code runs returning files must use a retained mission Sprite. Console-only
  runs may remain disposable. Selected input reads wait for the run's lease.
- Reads require the original Sprite connection. Deleting/restoring the Sprite
  affects linked file downloads as well as editable working files.
- File errors fail closed: no Mongo fallback, blind overwrite or automatic
  replay of an uncertain write. Read-back hashes verify writes before metadata
  commit. Run/recovery operations reuse their exact current environment lease.
- Existing Mongo file bodies remain readable until explicit, verified migration.
  Each body is removed only after its Sprite copy matches. Migration includes
  prior revisions/Trash without changing their metadata or chat identifiers.
- A remote write followed by failed metadata commit can leave an unreferenced
  snapshot on the Sprite. Root environment deletion is its cleanup boundary.
- Normal conversation transcripts may include file excerpts, code and command
  output; these remain conversation records, not an alternate file store.

This reuses the existing filesystem adapter and lifecycle rather than creating a
second application file manager, version store or synchronization mechanism.
