// App-scoped adaptation of Superfly's Sprites workflow, not organization admin access.
export const SPRITES_WORKFLOW_SKILL = Object.freeze({
  name: 'Code workspace', slug: 'code-workspace', enabled: true, agents: [],
  description: 'Use mission code runs, saved files, save points, and private services safely.',
  content: `Use this skill when a mission needs code, file transformations, tests, or an application preview.

Work only in the mission's remote Sprite through the tools Constellation exposes. Never request the owner's Sprites token or copy app credentials into the environment. Code access controls the entire remote environment, including files, packages, services and checkpoints; it does not grant host-computer access. Shared environments are not a secrecy boundary between permitted crew members.

Before work: establish the requested outcome, inspect existing files, choose the smallest operation, and select only required mission attachments. File contents live only in the mission Sprite; Mongo holds references, not file bytes. Disposable runs return console output only. To save or return files, the owner must enable Mission filesystem and grant this agent access. The owner can enable it from the new mission preflight, Files tab or mission settings, before any code run. Use the input manifest to locate selected attachments, not guessed paths.

Use list_mission_files, read_mission_file and manage_mission_files for ordinary file tasks instead of a code run. These tools use the same Sprite /workspace shown in Files. Read current text and its hash before editing. Delete always requires human confirmation, including for folders and their contents; never substitute run_code to bypass that review. Chat-linked uploads and returned results are immutable snapshots under /workspace/attachments in that same Sprite. Never modify those snapshots; copy into a working folder to edit. Downloads need the Sprite connection; deleting the environment also deletes those files. File access and permission to execute code are separate.

Use run_code for bounded foreground Python, JavaScript, or shell work. Return requested files from /workspace/outputs. Verify exit status, inspect results, and report what you actually checked. Use inspect_code_run to inspect a recorded run; an unknown outcome must never be automatically replayed.

Before risky changes, ask the owner to create a named save point in the mission's Files tab. Save points cover the environment filesystem, not chats, approvals, agent memory or actions outside the Sprite. Prefer browsing a save point and recovering one file over restoring the whole environment. Use Git for code history. Never delete or restore checkpoints behind the owner's back.

For an HTTP server, ask the owner to configure and start it in this mission's Services tab. Provide its working directory, command, arguments and port. Do not hide daemons or keepalive tasks inside run_code. Stop run stops the tracked command, not every service. Do not publish a public URL or widen account permissions.

Ordinary websites and Sprites connected APIs have separate permissions. Request only needed domains. Do not use a gateway to bypass action approvals, Jev controls or mission spending limits. Keep external writes within the user's explicit authorization. Model and connector charges inside a Sprite are separate from Constellation's tracked model budget.

Keep the user informed of running work, saved results, uncertain outcomes and required owner actions. Do not dump raw infrastructure traces into chat unless debug traces are enabled.`,
});
