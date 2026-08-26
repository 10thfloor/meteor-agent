# 10thfloor:agent-channel-telegram

Telegram as a surface for a [`10thfloor:agent`](../agent/README.md) agent:
message the bot (or add it to a group) and the conversation is a real agent
session — replies delivered into the chat, approval gates as an inline
Approve/Deny keyboard, and the same transcript open in the web app at the
same time.

Per the channels spec, this package is **one lens, one transport, one profile
default** — Telegram's `secret_token` webhook auth and the Bot API's shapes,
and nothing else. Bindings, receipts, deduplicated admission, the delivery
worker, and account linking all live in the core package. Zero npm
dependencies: the Bot API is JSON over `fetch`.

## Install and register

```bash
meteor add 10thfloor:agent-channel-telegram
```

```js
// server
import { Agent } from 'meteor/10thfloor:agent';
import { telegram } from 'meteor/10thfloor:agent-channel-telegram';

const cfg = Meteor.settings.packages['10thfloor:agent'].telegram;
Agent.channel('telegram', telegram({
  agent: 'support',
  botToken: cfg.botToken,           // from @BotFather
  webhookSecret: cfg.webhookSecret, // you invent this — long and random
}));
```

The webhook mounts at **`/agent/channels/telegram`**.

## Setting up the bot (manual test walkthrough)

1. **Create the bot**: message [@BotFather](https://t.me/BotFather), send
   `/newbot`, pick a name and username. Copy the token (`123456:ABC-…`).

2. **Expose your dev server** over HTTPS:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

3. **Register the webhook**, with a secret you invent (this secret is the
   webhook's entire authentication — make it long and random):

   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://YOUR-TUNNEL/agent/channels/telegram" \
     -d "secret_token=<YOUR-SECRET>"
   ```

4. **Settings** — add to `settings.json`:

   ```json
   {
     "packages": {
       "10thfloor:agent": {
         "telegram": { "botToken": "123456:ABC-…", "webhookSecret": "…" }
       }
     }
   }
   ```

5. **Run** with `meteor run --settings settings.json`, open the bot in
   Telegram, and say something. With the demo agent: *"what time is it"*
   exercises a tool call; *"refund my order"* parks an approval — it arrives
   as an inline **Approve / Deny** keyboard, and either button (or the web
   UI — first click wins) decides it.

## What the lens answers, and what it never does

- **Private chats**: every message. **Groups**: whatever Telegram delivers —
  by default BotFather bots have *privacy mode on*, so in groups the bot only
  receives commands and @-mentions, which is the right default here; disable
  privacy mode only if you want the agent reading (and answering) an entire
  group's chatter.
- **Conversations are keyed by `chat.id`** — a private chat is ONE ongoing
  conversation however many messages flow, and a group is one shared
  conversation. Forum topics are not keyed separately in v1.
- **Echoes cannot happen**: Telegram never delivers a bot its own messages.
  Other bots (`from.is_bot`), edited messages, channel posts, and media
  without text are noops by design.
- **Duplicates never run twice**: admission dedup on `update_id` absorbs
  Telegram's webhook retries.
- **`link`**, `/link`, or `/link@YourBot` — in a PRIVATE chat only, and the bare
  gesture only ("link my account please" reaches the agent as a message) —
  answers with a one-time URL that ties this Telegram identity to a signed-in
  web account, exactly the Slack package's flow. The URL is a credential, so in
  a group `/link` is just a message: DM the bot instead.

## Rendering

Plain text, deliberately: Telegram's MarkdownV2 requires escaping that
mangles ordinary prose, so this lens opts out of `parse_mode` entirely and
passes the agent's text through untouched (the core never parses content;
conversion is per-surface opt-in, and this surface declines). Prompts render
as a message plus an inline keyboard whose `callback_data` carries the
canonical token **and the exact ask** (`toolCallId`) — the core's shared
postback codec (`encodeVerdictPostback` / `decodeVerdictPostback`, the terse
`{ t: 'a' | 'd', c }` shape) with Telegram's 64-byte cap applied, degrading to
token-only for an oversized ask id rather than ever truncating it into a
*wrong* ask.

Known wart, v1: the button's loading spinner is not answered
(`answerCallbackQuery`) — it times out harmlessly after a few seconds.

## Delivery guarantees

Admission is deduplicated by `update_id` during the core's seven-day retention
window. Outbound is receipt-backed
effectively-once with **`retry`** as the declared recovery tier — the Bot API
has no idempotency key, so a crash in the one window between post and confirm
may double-send rather than lose. The webhook's trust boundary is the
`secret_token` header (compared in constant time); Telegram offers no
per-request signature, so treat that secret like the credential it is.

## Exports

`telegram(options)` — the factory (tier 1). `telegramLens`,
`telegramTransport`, `verifyTelegramSecret`, `parseTelegramUpdate` — the
pieces (tiers 2 and 3). Tests:
`meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent-channel-telegram`.
