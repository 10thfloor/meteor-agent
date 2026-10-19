# Code execution with Sprites

Constellation stays local. When explicitly enabled, its `run_code` tool sends code and selected input attachments to a remote Fly.io Sprite. Python, JavaScript, and shell scripts can return console output and files to the mission. Sprites is optional; it is not required for ordinary conversations, plans, or Jev decisions.

## Start here

1. Open **Capabilities → Code → Connect Sprites**.
2. Paste a Sprites token, enable code runs, and choose **Save connection**. Alternatively launch the app with `SPRITES_TOKEN` in its shell environment. Saved credentials take precedence and use the existing encrypted desktop credential store; the token is never published to the client or given to agents.
3. Leave **Allowed websites** blank to block ordinary website traffic. Add exact domains only when needed; list subdomains individually. Under **Connected APIs**, review any separate Sprites organization grants and explicitly allow the displayed permissions before running code. This does not grant access to files on your computer.
4. Under **Code permissions**, choose **Ask every time** for the agents that need to execute code. This is the single permission editor, and changes apply to all missions. The agent’s **Tools → View in Capabilities** links here and provides a return to its unsaved settings. New agents start **Off**. **Allowed** skips the per-run approval, but not mission membership or connection limits.
5. Ask that agent to use `run_code`. For a first test: “Use Python to calculate the sum of 1 through 100. Write the answer to result.txt and return the file. No internet access is needed.”
6. Approve the proposed tool call in the mission. A live chat card shows the real execution stage and elapsed time, with **View run** and **Stop run** controls. Finished runs become compact receipts; failures keep a visible explanation. **View run** selects that exact attempt in **Code runs**, with source, output, and files kept out of the chat. Connection loss pauses the live indicator until status is confirmed; reconnecting never restarts code.

Use the persistent **Files**, **Code runs**, and **Services** tabs beside **Chat** for the current mission. Selecting a run keeps its compact list visible beside the details. Search and filters narrow the list, and **Next** reaches older attempts; history is no longer limited to the latest 100 runs.

For workspace-wide history, open **Capabilities → Code → View code runs**. It starts at **All missions** and labels each run with its mission; use the **Mission** filter to narrow the list. It never silently selects the last mission you visited. Mission tabs remain scoped to the selected mission.

Connection testing is read-only; it does not allocate a Sprite. Running code can incur Sprites charges. Those charges are separate from the mission’s model-spend limit. This version does not present a dollar estimate: execution duration alone is not accurate CPU, memory, or storage billing data.

## Execution and files

By default, console-only tool calls receive a disposable remote workspace, deleted after execution. Returning files requires the owner to enable a retained mission filesystem first. This is a shared working directory for that mission, not a separate computer for every agent, nor an organization-wide filesystem.

- Disposable scripts run from `/workspace/main.py`, `main.js`, or `main.sh`. Persistent runs use distinct run directories so source and imported inputs do not overwrite earlier runs.
- Only attachment IDs explicitly selected in the tool call are uploaded. Inputs must belong to the current conversation or its root mission. An input manifest maps attachment IDs and original names to their actual input paths. In a retained environment, previously saved files and dependencies are also available to every authorized agent.
- Scripts write returned files under `/workspace/outputs/`. The tool’s `outputPaths` list selects files to save as immutable snapshots under `/workspace/attachments` in the same Sprite. Mongo holds references only. A result links to its originating run; deleting the Sprite also deletes these files.
- No host directory is mounted. No shell environment, Sprites token, model key, or other app credential is copied into the guest. Guest-produced artifacts remain untrusted files; they are not executed on the local machine.
- Ordinary website traffic is denied first, then permitted for configured domains. Network, fixed 1 GiB memory, and standard no-new-privileges policies must match readback before code starts. Sprites' API gateway is a separate permission surface, not covered by the website allowlist.
- Defaults: 60 seconds including preparation/file transfer, 20 runs per mission, 64 KB combined output, and 5 MB of inputs / returned artifacts. Settings enforce upper bounds. A run that reaches its output or time limit is stopped.

### Where files live

All new file contents live on the mission Sprite. Metadata for chat-linked files and results can be listed without a connection, but downloads require the original Sprite. Existing Mongo bodies remain available until the owner chooses **Move existing files to Sprite**; every copy is verified before its database contents are removed. Older edits, revisions and Trash are included. See [Mission files](mission-files.md).

**Files** is the live `/workspace` filesystem, shared by the UI, file tools and code runs. Create folders/files, upload, edit text, rename, move, copy and download through native Sprites filesystem APIs. Delete requires confirmation. Managed snapshots under `/workspace/attachments` are read-only; copy them to a working folder to edit. Files not selected as run results remain normal workspace files. Browsing can wake the remote Sprite and incur usage.

## Enable the mission filesystem

Use **Enable mission filesystem** in a new mission’s optional preflight or Files tab. This explicitly provisions a Sprite before any code run. Alternatively, open **Mission settings → Configure filesystem**, turn on **Mission filesystem**, choose agents, and select **Enable filesystem**. Opening settings alone never provisions anything. First-time quick enable selects the current mission crew; existing explicit grants are preserved. New crew members do not automatically receive access to an existing environment.

Filesystem access does not grant code execution. Agent file tools require their **Mission files** capability, mission membership and filesystem access. File changes follow mission approvals; deletion always requires exact human approval. Code runs still require the separate workspace-level code permission. **Manage code permissions** takes you to that central editor and back without discarding settings drafts.

- Use **Files** in the mission to browse and manage workspace files.
- Use **Code runs** for the source, output, and exported results of each attempt.
- Use **Save points** to save a named filesystem state or restore an earlier one. Restoration requires confirmation and first saves the current state as a safety point. At the 50-point limit, save/restore pause until there is room for that safety point; this refusal does not quarantine the environment. Delete an older point where supported. If individual deletion is unavailable, the app does not silently discard receipts or delete the environment to make room. Refresh checks provider availability and checkpoint health.
- **Browse files** on a mounted save point opens its older `/workspace` files without restoring. Download a file, or **Restore a copy** to save an immutable copy in the current Sprite. This never overwrites current working files. Sprites documents a five-checkpoint read-only history, but a newly created point may not yet be mounted under its exact ID. Missing mounts are reported explicitly; Constellation never guesses that the `active` mount represents a requested point. Healthy unmounted points remain eligible for whole-environment restore.
- **Delete save point** requests remote deletion after confirmation and removes the local receipt only after inventory readback confirms absence. Current checkpoints cannot be deleted. Some Sprites runtimes do not implement the documented deletion route: if the provider returns 404/405 while the point still exists, Constellation reports deletion as unavailable and disables individual deletion for that environment without quarantining it. Restore and file recovery remain available. This limitation was observed in the September 21 live test; deletion must not be advertised as proven on this account.
- Choose **Keep until I delete it** to retain work after completion, or **Delete when mission completes** to remove the remote environment on completion/archive. Retained disk and save points can incur Sprites storage charges even when no code is running.
- Switching back to disposable runs does not erase the existing environment. Use **Delete environment** to explicitly remove its files, including chat-linked uploads, returned results and save points. Chat history and file metadata remain in Meteor, but file contents do not.

Constellation's tracked operations are serialized per mission environment. A later run waits for the preceding tracked run. This is an application coordination rule, not isolation from services or other guest processes. Different missions do not share environments. There is no cross-agent secrecy within a shared environment: access includes all existing files, packages, retained inputs, and local management APIs.

Save points restore the Sprite’s filesystem, not Constellation’s state. They do not undo chat messages, tool approvals, agent constitutions, experiences, practices, run receipts, or actions already performed outside Sprites. Agent memory remains authoritative in Meteor. Save points are not a replacement for source control or an off-provider backup.

## Run a service

Open the mission's **Services** tab to configure a named HTTP service: its command, arguments, working directory and port. Saving a configuration does not start it. Choose **Start**, then **Open** when ready. The current UI supports owner-managed HTTP services; agents do not automatically create service configurations in this release.

A service can stay running after a code run or chat turn finishes. **Stop** controls that service; stopping a foreground code run is a different operation. **Delete** stops the service and removes its configuration, not the working project files. Deleting the whole environment is the separate destructive action.

**Open** obtains an authenticated private browser link; Sprites organization sign-in may be required. There is no public-publishing option or token in the URL. A previously obtained or bookmarked URL may wake/restart its HTTP service and incur usage independently of the app. This is why the feature is named **Services**, while opening the app in a browser is an action rather than a separate “Previews” destination.

## Stop, recovery, and deletion

### Connection recovery

The desktop app checks the local server separately from Sprites. Its readiness check verifies that the application and database respond; a development-proxy page does not count as a healthy server. If its own server stops responding, the desktop app allows time for rebuilds or waking from sleep, then makes up to three restart attempts. It keeps the window open and reuses the original launch credentials. A server started outside the desktop app is never terminated or adopted.

After a local reconnect, Constellation can recheck a previously tested Sprites connection. Temporary provider/network failures receive bounded, read-only retries; rejected or unavailable credentials require attention. The check reads account and connector metadata without creating or waking a Sprite, changing permissions, or retrying code and file operations. Unsaved connection settings remain in the form. Interrupted work still requires an explicit decision to retry.

Stopping a mission or a code run requests real remote termination, not merely disconnection. For disposable runs the adapter deletes the exact run’s Sprite. For a retained environment it stops the recorded remote execution group and preserves disk. Revoking execution access or changing the domain allowlist also interrupts active work. Unconfirmed stopping blocks reuse and is shown as **Needs attention**; it does not silently delete a retained environment.

Persistent `run_code` execution is intended for foreground scripts. A process-group stop does not stop detached processes or Sprite-managed services. Use **Services → Stop** for a managed service. Code permission is trust in that entire remote environment: the guest management socket can manage services, tasks and checkpoints. Human restore confirmations govern the app's UI flow; they are not a security boundary against guest code. Only use trusted code/dependencies. Deleting the environment is the separate destructive operation that removes the whole Sprite.

Each job is durable and keyed to its tool call. An interrupted or uncertain job is never automatically re-executed. Startup recovery reconciles unfinished work and attempts cleanup. Provisioning uncertainty retains a cleanup receipt through a settling interval because an immediate “not found” can race a delayed creation.

Agents with code-history access can use **inspect_code_run** to read the exact mission run's recorded status/output/artifacts without waking or executing a Sprite. Unknown results stay unknown. Humans can use **Check environment** from that run's details. Historical-file helpers also record their exact remote session before starting, and unconfirmed stopping blocks unsafe reuse.

## Connected APIs and workflow guidance

**Connected APIs → Review access** reads sanitized organization permission metadata only. Constellation does not modify organization-wide connector policies. Label-based grants are conservatively included because retained Sprites may be relabeled outside the app. Grants with unrelated Sprite-name prefixes are excluded. New or changed grants require explicit owner approval of the fresh permission fingerprint; unknown inventory blocks code and service starts. The inventory is checked when a run is reserved and again at dispatch, including queued runs.

These are admission checks, not a new provider firewall. Every in-app service opening performs a fresh check; the UI does not retain a reusable URL. Changes made externally while a run/service is already active remain controlled by Sprites organization policy. Existing external/bookmarked private service links may wake services independently of the app. Manage/revoke those grants in Sprites; keep them narrow. Gateway model, Jev and other charges are not automatically included in Constellation's model/decision totals. Do not use gateways to bypass mission approvals or budgets.

**Capabilities → Skills → Code workspace** is an optional, initially unassigned workflow skill adapted from Superfly's Sprites guidance. It teaches mission-scoped execution, result verification, save-point safety, private services, and inspection instead of replay. Assign it to code-enabled crew members as needed; it grants no execution or organization permissions.

If removal cannot be confirmed, a cleanup receipt remains available; charges may continue until the remote workspace is removed. Token replacement is blocked while active work, retained environments, or pending cleanup depends on the existing token. External revocation of that token can require manual cleanup in the Sprites account. Deleting a mission scrubs job content and requests removal of its environment; only the minimal receipt needed to clean up an unresolved remote workspace remains. Erasing a child conversation does not delete its parent mission’s shared environment.

## Framework / app boundary

`meteor-agent` exports `runIsolatedExecution(provider, request, options)`, bounded UTF-8 output, structured interruption errors, and a live `ToolContext.signal`. Shared tool dispatch supplies cancellation for normal calls and approved continuations on Stop, erasure, or lease loss. This is cooperative cancellation for existing inline tools, not a blanket sandbox for Meteor methods or MCP servers.

Constellation owns credential storage, owner/crew/mission policy, approvals, run budgets, durable jobs, environment lifecycle, save-point receipts, artifacts, and UI. The Sprites adapter owns provisioning, enforced network/resource policy, WebSocket execution, filesystem/checkpoint transport, and confirmed stopping/teardown. The SDK is pinned and loaded through native Node ESM to avoid Meteor’s CommonJS rewriting. Persistent execution uses the documented WebSocket session protocol to record its remote execution ID before releasing user code. Node 24+ is required by the SDK.

### Mission work methods

These owner-authorized Meteor methods are under `constellation.execution`. Lists and recorded run details are local; file content reads and explicit migration contact Sprites.

| Method | Input | Result |
| --- | --- | --- |
| `historyPage` | Optional `missionId`, literal title `search`, exact `agent`, exact `status`, opaque `cursor`, `limit` (1–100; default 50) | `{ rows, nextCursor }`; metadata-only run rows with mission title, dates, status and file references. No source, stdout, stderr, input content or credentials. |
| `getRun` | Exact root `missionId` and `jobId` | Authorized run details, including recorded source/output; works for attempts older than the live subscription window. |
| `missionFiles` | Exact root `missionId`, optional `cursor` and `limit` | `{ rows, nextCursor, migration: { remaining } }`; file references, origin, agent and originating run when known. No file bytes. |
| `readMissionFile` | Exact root `missionId` and `attachmentId` | `{ name, contentType, size, content }`; `content` is bounded base64, maximum 10 MB decoded. |
| `migrateMissionFiles` | Exact root `missionId`, optional `limit` (1–25; default 10) | `{ migrated, remaining, failures, complete }`; verified old byte records moved to Sprite. |

Lists use descending creation date and ID as a stable tie-breaker. Cursors are signed and bound to the owner, collection, mission and filters; changing scope requires a fresh first page. Restarting the server invalidates outstanding cursors, so the client must refresh on `execution-invalid-cursor`. New records inserted at the top do not duplicate previously paged rows.

Every run/file is checked against the owner's live mission ancestry. Erased, erasing, orphaned, foreign-owner, ephemeral and staged file sources are excluded. Descendant discovery is indexed and bounded at 2,048 conversations and eight levels, beyond the framework's current three-level delegation limit. Unsupported larger/deeper trees fail explicitly rather than presenting an incomplete file inventory as complete. Metadata pages are bounded separately from file bytes. The older `history` method remains for compatibility; new list UIs use paginated metadata and request full detail only when selecting a run.

## Verification

September 23 connection recovery: **453 server + 482 browser + 21 desktop tests passed (956 total)**. Type checking, desktop syntax, and whitespace checks also passed. The live desktop was restarted with its original OS-protected credential store and shell-provided model key. Application/database readiness returned healthy, the saved Sprites credential passed a read-only connection/inventory check, and a brief local disconnect/reconnect triggered a successful automatic recheck. No Sprite was created, no code/file operation was replayed, and permissions were unchanged. Desktop crash, rebuild, sleep/resume, ownership and retry-limit behavior were verified with injected process/timer tests, not by crashing the user's database.

Local fixture tests cover validation, authorization, duplicate calls, budgets, cancellation, credential redaction, connector approvals, lost creation responses, cleanup, output limits, artifacts, checkpoint health/recovery/deletion, private service lifecycle, native SDK loading, dialog context, subscriptions, and stale UI completions. They do not contact Sprites or use a model. Account-specific provider behavior must also be verified with a credentialed smoke run; do not confuse fixture success with live proof.

September 21 mission-work redesign: **316 server + 353 browser tests passed (669 total)**, with zero failures. Type checking and whitespace checks also passed. Coverage includes cursor paging and expiry recovery, stable live rows, exact older-run selection, safe file viewers, durable files without Sprites, authorization and read bounds, service lifecycle controls, stale responses, keyboard navigation, preserved drafts, and compact chat receipts. The local Electron app was reopened and checked using existing saved results: HTML displayed safely as source, run details stayed beside the table, Services showed the correct environment setup hint, and completed/stopped chat receipts measured about 69 pixels high. This pass created no new Sprite or paid model run.

The chat UI was also verified with two paid model-driven, disposable Sprite runs in the existing smoke-test mission: a 20-second Python wait completed with its expected output, and a second foreground wait was stopped through the new chat card. The latter recorded `cancelled`, only the start output, and `cleanupPending: false`. The running card used its real execution status and elapsed timer; **View run** selected the exact recorded attempt. Neither run accessed the network or created user files. Temporary navigation drafts were discarded, permissions stayed unchanged, and no test Sprite remains allocated. Test messages and run receipts remain in the local mission.

### Live adapter verification — September 21, 2026

Isolated, randomly named temporary Sprites were created using the saved credential without changing any existing mission or agent permissions. Verified: connector inventory, all three policy readbacks, exact-session foreground execution, artifact download, process-group Stop preserving files, persistence across runs, checkpoint creation/restore, historical file recovery from a versioned read-only mount, private service configuration/local HTTP content, service Stop/Delete, and complete temporary-Sprite deletion. The adapter was corrected for real non-TTY `session_info` ownership semantics and informational WebSocket `debug` frames; neither frame leaks into chat.

Observed limitations: a newly created checkpoint was not mounted under its version ID until a later environment state, and the local checkpoint-delete route returned 404 even though inventory still contained the point. Missing historical mounts fail explicitly; deletion is not reported as success. Browser organization-sign-in for the private preview URL was not exercised: privacy configuration and in-Sprite HTTP content were verified, not the end-to-end browser login flow. This adapter test did not exercise a paid model or create Constellation mission data.

### Live persistence smoke test

With a connected Sprites account and one approved agent:

1. Enable retained files for a fresh test mission, grant that agent access, and leave retention at **Until I delete the environment**.
2. Ask the agent to write `1` to `/workspace/counter.txt` using Python. Verify the file is available in **Files** after the run finishes.
3. Save a point named **Counter at one**.
4. In a new turn, ask the same agent to read the existing counter, increment it, and print the result. Expect `2`, with the same mission environment and a separate code-run receipt.
5. Restore **Counter at one**. Verify a safety save point was added, the counter is `1`, and both chat turns and run receipts are unchanged.
6. Run a foreground script that waits, then use **Stop run**. The counter must still be downloadable; Stop must not delete the Sprite.
7. Download anything needed, then explicitly **Delete environment** to end retained storage. Verify chat history remains but the deleted Sprite's file downloads are unavailable.

This test incurs provider/model usage. Do not substitute a simulated result for these checks when validating a real account.

Provider references: [Sprites](https://fly.io/sprites/), [networking](https://docs.sprites.dev/concepts/networking/), [API](https://sprites.dev/api), [official SDK](https://github.com/superfly/sprites-js).
