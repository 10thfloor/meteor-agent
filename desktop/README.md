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
