# Mission files

The mission has one editable filesystem: its retained Sprite `/workspace`.
The Files tab and agent file tools act on that same tree. Files written by code
or a running service appear there; changes in Files are available to subsequent
code runs. Enable the mission filesystem and select the agents allowed to use it
in the mission environment settings.

Sprites are the only persistent store for new file contents in Constellation.
Mongo holds metadata, chat references, filenames, byte counts, hashes and Sprite
locators, never a fallback file body. The single **Files** view shows `/workspace`.
Chat-linked files, generated briefs, selected code results and recovered copies
are immutable snapshots under `/workspace/attachments`; copy them into a working
folder before editing. Ordinary workspace files remain editable.

Enable the mission filesystem before saving a brief, accepting a new chat file
or running code with `outputPaths`. Console-only runs can remain disposable.
Downloads and file input reads require access to the original Sprite. Turning
sharing off preserves existing files; deleting its environment deletes these
snapshots too. Restoring a save point can remove files created after that point.
There is no automatic local backup.

## Files and recovery

The Files view uses clickable folder breadcrumbs and a compact **New** menu for
files and folders. Item actions live in each row’s **⋯** menu; renaming stays
inline. A file opens a preview beside the list (or replaces it at narrow widths),
and closing it preserves the current folder. Move/copy use a focused destination
picker, and deletion always presents an explicit confirmation. Mission filesystem
settings and save points remain separate from file actions.

Create folders, upload or create files, edit text, rename, move, copy and delete
inside the mission Sprite. Saving text requires the content hash returned by the
latest read. Preflight checks detect files that already changed and destinations
that already exist. App operations are serialized, but a process or service
inside the Sprite can still change a file between a check and the native API
write; these checks are not an atomic compare-and-swap guarantee.

Deletion is permanent, including a deleted folder’s contents. The UI requires
confirmation and agent deletion always requires approval. Use Sprite save points
before risky work. Save-point browsing is read-only; it uses the provider’s
checkpoint history rather than a second Constellation version database.

The provider uses Sprites’ native filesystem API. App preflight rejects paths
outside `/workspace`, visible symlinks, special files, the workspace root and
protected Constellation directories. The native API does not supply atomic
no-follow checks: a guest process can race metadata checks. The workspace view
is not an additional security sandbox against software already running inside
the Sprite. Operations use the existing environment lease. A lost remote
response is not automatically replayed: check the recorded outcome and reconcile
the environment first.

## Agent tools

The agent’s **Mission files** switch and mission crew membership control tool
access. Workspace access also requires the mission filesystem to be enabled
and the agent to be included in its allowed agents.

| Tool | Purpose |
| --- | --- |
| `list_mission_files` | Browse the mission workspace or read-only attachments |
| `read_mission_file` | Read a workspace file and its hash, or an attachment |
| `manage_mission_files` | Create, edit, organize or delete workspace files |

The tools derive the mission from the calling conversation. Models cannot
choose another owner or mission. Changes follow mission approval settings;
deletion always asks. Authorization and the exact approval are checked again
before a mutation. File content is data, never permission to perform actions.

`run_code` already shares the retained workspace. Chat-linked files may
also be explicitly selected as inputs using `inputAttachmentIds`; the manifest
maps those IDs to the run’s input paths. New attachments are saved directly to
the mission Sprite; only explicitly selected inputs are copied into the run.

## Storage boundary

The framework exposes `Agent.attachments.configureStorage(adapter)`,
`readContent(row)` and `migrateContent({ id, sessionId })`. Constellation installs
its Sprite adapter at startup. Other framework consumers keep the default Mongo
adapter unless they explicitly configure external storage.

The adapter derives owner and root mission from the attachment's session. It
never provisions a Sprite or grants code access. Writes use deterministic
content-addressed paths and read-back/hash verification before Mongo metadata
is committed. External storage failures never write file contents to Mongo.
Run exports and checkpoint recovery reuse their exact live environment lease;
they cannot nest another lease or bypass cancellation, erasure or revocation.
Download, image hydration, attachment tools, code inputs and email delivery all
resolve content through the same framework boundary.

## Compatibility with the retired saved-file manager

The former Mongo-backed editable file tree is retired. Normal browsing no longer
creates catalogs, imports attachments into a tree, writes file versions or
offers Mongo file-management methods. Existing development contents are preserved;
the one-time migration controls are not part of the product UI. Browsing never
migrates or provisions anything. The server migration utility remains available
for deliberate developer maintenance, not normal mission use.

A live legacy file with its own saved content remains readable through the
compatibility API with its former folder path. This includes files created
there and edits that differ from the original attachment. The original and its
preserved copy are separate downloads; neither replaces the other. For example,
a four-byte original result and a seven-byte edited copy remain independently
available. Unedited catalog imports are not duplicated in the list.

Read a preserved copy with `readMissionFile({ missionId, legacyEntryId })`.
Read the original with `readMissionFile({ missionId, attachmentId })`.
Listing uses distinct `legacy:` IDs and supports paging and literal name search.
Migration processes bounded batches, includes older revisions and retired Trash,
and verifies each Sprite copy before atomically unsetting the original Mongo
content. Failed or interrupted copies retain their original contents. IDs and
chat references remain unchanged; the old tree/revision records become metadata
only. A restart or repeated migration verifies/reuses the same remote copies.

Legacy revisions and retired Trash are not exposed as another editing or
recovery UI. Their contents are included in migration rather than discarded.
The existing mission/conversation privacy-erasure lifecycle still removes
associated metadata; root erasure deletes its Sprite through the established
cleanup workflow. Unreferenced snapshots from an interrupted metadata commit
remain on that Sprite until its deletion; they are never copied back to Mongo.

## Boundaries

This is not access to the desktop filesystem. Reads, uploads, directory sizes,
text editing and model excerpts are bounded. HTML and SVG are displayed as
source, never executed in the file viewer. Neither files nor services become
public merely by appearing in a mission.

Normal chat/tool transcripts can contain quoted text, file excerpts, source code
or command output. Those conversation records remain in Mongo; they are not a
second file store. Existing legacy byte records remain until verified migration.

## Verification

September 22 storage transition: **418 server + 387 browser tests passed (805
total)**, with zero app failures. Type checking and whitespace checks passed.
The framework's 17 external-storage tests passed. The full framework/channel
run passed 921 server and 30 browser tests, with one unrelated approval
stop/resume timing assertion failing (it passes when run alone) and one pending
test; that code was left unchanged. Electron verification confirmed the single
Files view and the distinct preserved/original files without migrating them.

Coverage includes native filesystem API
requests, explicit provisioning without code permission, deletion approval,
permission revocation, uncertain outcomes, completion/erasure races, preserved
legacy edits, dirty drafts, optional mission preflight, external-storage
hydration/downloads, fail-closed writes, content-addressed replay, verified
migration of originals/revisions/Trash, and run-lease cancellation. Tests use
simulated Sprites; the storage transition does not automatically migrate the
user's existing data or make a live cloud operation.
