# Constellation desktop showcase

Constellation is the local Electron example for meteor-agent rc1. The desktop
process starts the Meteor example app on `127.0.0.1:3210`, waits for it to be
ready, and opens a security-isolated Electron window.

```bash
npm install
npm run desktop
```

Use `npm run desktop:offline` to force the deterministic local provider even
when your shell already contains a model API key.

No model key is required. Without `ANTHROPIC_API_KEY` or `PROVIDER_API_KEY`,
the app uses meteor-agent's deterministic streaming provider so subagents,
tool calls, approval gates, attachments, memory, forks, and system turns still
work. Set either key before launching to use the live pi-ai adapter.

Open **Crew → Configure** to edit Atlas or any specialist. Agent identity,
role, instructions, model, budgets, and capabilities are persisted locally.
Specialists can be added, disabled, or removed; each save re-registers the
runtime definition and synchronizes the active mission roster.

Use **Pulse** to create, edit, pause, run, and remove interval or cron-driven
system turns. **Skills** provides reusable instruction CRUD with per-agent
assignments. **Channels** configures Slack, Telegram, WhatsApp, SMS, and email;
credentials are write-only in the UI and encrypted with an Electron-managed
OS-protected key. Provider webhooks use local callback URLs, so external
delivery requires a tunnel or another route to this machine.

The renderer has no Node.js access. Electron uses context isolation, renderer
sandboxing, a narrow preload bridge, denied permissions, and blocks navigation
outside the local Meteor origin.

## Local server recovery

The window checks `/__constellation/health`, which confirms the application and
its database are ready. Meteor's development proxy serving a page is not enough.
If Electron started the server, sustained failures trigger a bounded restart:
two minutes for an unresponsive server, or 30 seconds after Meteor reports an
application crash or its runner exits. Ordinary rebuilds and brief outages have
time to settle. Waking the computer grants a fresh two-minute grace period.
Initial startup still has a two-minute deadline: a first launch that never
becomes healthy reports a startup error and quits instead of leaving an empty
window waiting through all automatic retries.

Recovery preserves the Electron window and its in-memory drafts. It reuses the
original launch environment and credential key; it does not reload the page,
resend messages, approve tools, or replay file operations. The existing Meteor
connection reconnects normally. Interrupted agent work still follows the app's
recovery rules; restarting the server does not certify a remote run's outcome.

At most three restarts are attempted, with 1-, 5-, and 15-second backoff after
each failure grace. Retries reset only after one minute of healthy responses.
If automatic recovery pauses, quit Constellation normally, then run
`npm run desktop` from the same shell environment. Do not remove local data or
credentials. A server that was already running before Electron opened is never
terminated or restarted by this recovery mechanism; restart that server from
the terminal or service that originally launched it.
Port ownership is checked separately with a bounded TCP probe: a connected
listener is occupied even if HTTP hangs. Only an explicit connection refusal
allows a new launch; timeout and other uncertain probe failures fail closed.

On macOS/Linux, each owned Meteor runner has an isolated process group. Recovery
and quitting stop only that recorded group, never processes selected by a port
or a broad name match. Windows uses the recorded child process only. If stopping
cannot be confirmed, no replacement is launched. Diagnostics are written to the
launch terminal; credentials are not included in recovery messages.

Test recovery without restarting a real app or contacting Sprites:

```bash
node --test desktop/server-recovery.test.cjs
node --check desktop/main.cjs
```
