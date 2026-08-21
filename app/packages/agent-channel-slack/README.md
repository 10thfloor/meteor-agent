# 10thfloor:agent-channel-slack

Slack as a surface for a [`10thfloor:agent`](../agent/README.md) agent: DM the
bot or @-mention it in a channel, and the conversation is a real agent session
— streamed replies delivered into the thread, approval gates as Approve/Deny
buttons, and the same transcript open in the web app at the same time.

Per the channels spec, this package is **one lens, one transport, one profile
default** — Slack's signing scheme and payload shapes, and nothing else.
Bindings, receipts, exactly-once admission, the delivery worker, and account
linking all live in the core package.

## Install and register

```js
// server
import { Agent } from 'meteor/10thfloor:agent';
import { slack } from 'meteor/10thfloor:agent-channel-slack';

const cfg = Meteor.settings.packages['10thfloor:agent'].slack;
Agent.channel('slack', slack({
  agent: 'support',
  botToken: cfg.botToken,          // xoxb-…  (OAuth & Permissions)
  signingSecret: cfg.signingSecret, // Basic Information → Signing Secret
}));
```

The webhook mounts at **`/agent/channels/slack`**. That's the whole
integration on the Meteor side.

## Setting up the Slack app (manual test walkthrough)

1. **Expose your dev server.** Slack must reach you over HTTPS:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

   (or `ngrok http 3000`). Note the public URL.

2. **Create the Slack app** at [api.slack.com/apps](https://api.slack.com/apps)
   → *Create New App* → *From a manifest*, with:

   ```yaml
   display_information:
     name: Agent Demo
   features:
     bot_user:
       display_name: agent-demo
       always_online: true
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - chat:write
         - im:history
   settings:
     event_subscriptions:
       request_url: https://YOUR-TUNNEL/agent/channels/slack
       bot_events:
         - app_mention
         - message.im
     interactivity:
       is_enabled: true
       request_url: https://YOUR-TUNNEL/agent/channels/slack
   ```

   Both URLs are the same endpoint — the package tells events and button
   clicks apart by their wire shape.

3. **Install the app to your workspace** (Install App page). Copy the **Bot
   User OAuth Token** (`xoxb-…`) and, from Basic Information, the **Signing
   Secret**.

4. **Settings** — e.g. `settings.json`:

   ```json
   {
     "packages": {
       "10thfloor:agent": {
         "slack": {
           "botToken": "xoxb-…",
           "signingSecret": "…"
         }
       }
     }
   }
   ```

5. **Run** with the settings file:

   ```bash
   meteor run --settings settings.json
   ```

   When you save the request URL in step 2, Slack sends a signed
   `url_verification` — the package answers the challenge and the URL shows
   *Verified*. (Register the channel before startup completes; the demo app's
   `server/main.js` shows the shape.)

6. **Talk to it.** DM the bot, or @-mention it in a channel it's been invited
   to. With the demo agent: say something with *"time"* in it to watch a tool
   call, or *"refund"* to park an approval — the ask arrives in Slack as
   Approve/Deny buttons, and either button (or the web UI — first click wins)
   decides it.

## Account linking

DM the bot the bare word **`link`** and it answers with a one-time URL
(minted through the core's linking tokens, delivered on the same surface).
Open it while signed in to the web app: the Slack identity is linked to that
account, the anonymous conversations it created are claimed, and from the next
message the agent runs as you on both surfaces. Wiring on the app side is a
`linkUrl` option plus one method that calls `redeemLinkToken` — the demo app's
`server/main.js` and `client/main.js` are the reference. Only the exact word
triggers it; "link my account please" reaches the agent as an ordinary
message.

## What the lens answers, and what it never does

- **DMs**: every message. **Channels**: only when @-mentioned — un-mentioned
  chatter is a `noop` by design, so a thread follow-up needs a fresh mention.
  Subscribe to exactly `message.im` + `app_mention` and the events match the
  policy.
- **Its own posts, never.** Bot messages and subtyped events (edits, joins)
  are dropped — that drop is what closes the self-reply loop.
- **Duplicates, never**: Slack's 3-second retry redelivers events; admission
  dedup on `event_id` means a retry never runs a second turn.

## Rendering

Replies pass through a **minimal** Markdown→mrkdwn conversion (bold, links,
headings — the constructs the two dialects disagree on); `_italics_`,
`` `code` `` and fences already coincide. Prompts render as a section plus
Approve/Deny buttons whose values carry the canonical token **and the exact
ask** (`toolCallId`), so a click on last week's message can never decide this
week's different request. Override any of it per the core README's lens
ladder — spread `slackLens` and replace one item.

## Delivery guarantees

Admission is exactly-once (`event_id`). Outbound is receipt-backed
effectively-once with **`retry`** as the declared recovery for a crash between
post and confirm: each delivery carries its receipt key in message metadata,
but metadata read-back on the thread-replies endpoint is unverified (the
spec's §11 caveat), so this package does not ship a `reconcile` yet. In plain
terms: a server crash in that one window may double-post rather than lose the
message.

## Exports

`slack(options)` — the factory (tier 1). `slackLens`, `slackTransport`,
`verifySlackSignature`, `parseSlackRequest`, `toMrkdwn` — the pieces (tiers 2
and 3), plus the `SlackEvent` union `parse` produces. Tests:
`meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent-channel-slack`.
