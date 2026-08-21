# 10thfloor:agent-channel-whatsapp

WhatsApp (Meta's Cloud API) as a surface for a
[`10thfloor:agent`](../agent/README.md) agent: message the business number and
the conversation is a real agent session — replies into the chat, approval
gates as native **Approve / Deny reply buttons**, and the same transcript open
in the web app at the same time.

Per the channels spec, this package is **one lens, one transport, one profile
default** — the Cloud API's shapes, the `X-Hub-Signature-256` trust boundary,
and Meta's GET subscription handshake, nothing else. Bindings, receipts,
exactly-once admission, the delivery worker, and account linking all live in
the core. Zero npm dependencies.

## Install and register

```js
// server
import { Agent } from 'meteor/10thfloor:agent';
import { whatsapp } from 'meteor/10thfloor:agent-channel-whatsapp';

const cfg = Meteor.settings.packages['10thfloor:agent'].whatsapp;
Agent.channel('whatsapp', whatsapp({
  agent: 'support',
  accessToken: cfg.accessToken,   // Graph API token (System User)
  appSecret: cfg.appSecret,       // the APP secret — the signature key
  verifyToken: cfg.verifyToken,   // you invent this; the handshake checks it
}));
```

The webhook mounts at **`/agent/channels/whatsapp`**.

## Setting up the Meta app (manual test walkthrough)

1. **Expose your dev server** over HTTPS:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

2. **Create the app**: [developers.facebook.com](https://developers.facebook.com)
   → Create App → *Business* → add the **WhatsApp** product. The setup page
   gives you a **test number**, a **Phone number ID**, and a temporary
   **access token** (for production, mint a permanent System User token with
   `whatsapp_business_messaging`).

3. **App secret**: App Settings → Basic → App Secret (*Show*). This — not the
   access token — is what signs webhook deliveries.

4. **Configure the webhook**: WhatsApp → Configuration → Webhook:
   - Callback URL: `https://YOUR-TUNNEL/agent/channels/whatsapp`
   - Verify token: a string you invent (goes in settings as `verifyToken`)
   - Click *Verify and save* — Meta sends the GET handshake, the package
     echoes `hub.challenge`, the dashboard shows verified.
   - **Subscribe to the `messages` webhook field** — nothing arrives without
     this step, and it is the one everyone forgets.

5. **Settings** — add to `settings.json`:

   ```json
   {
     "packages": {
       "10thfloor:agent": {
         "whatsapp": {
           "accessToken": "EAAB…",
           "appSecret": "…",
           "verifyToken": "…"
         }
       }
     }
   }
   ```

6. **Run** with `meteor run --settings settings.json`, add the test number's
   allowed recipient (your phone, on the setup page), and message the number
   from WhatsApp. With the demo agent: *"what time is it"* exercises a tool
   call; *"refund my order"* parks an approval — it arrives as **Approve /
   Deny reply buttons**, and either button (or the web UI — first tap wins)
   decides it. Send **`link`** for the one-time URL that ties this WhatsApp
   identity to a signed-in web account.

## What the lens answers, and what it never does

- **Every inbound text and button reply** routes; the Cloud API is 1:1 (no
  groups), so audience is always `direct`.
- **Conversations are keyed by business number + `wa_id`** — one customer,
  one ongoing conversation per business number, the same both-ends key as
  the SMS channel.
- **Your own sends never loop**: outbound messages echo back as `statuses`
  entries, which are noops by design — that is this surface's echo rule.
- **Media, reactions, locations** are noops in v1 (attachments are the
  spec's named open question).
- **Duplicates never run twice**: admission dedup on the `wamid` absorbs
  Meta's webhook retries.
- **Batched deliveries process the first message.** Meta usually delivers one
  message per webhook, but can batch several after downtime; the ingress
  contract is one reading per event, so extras in one delivery are dropped
  (the customer's next message resumes normally). A multi-reading ingress is
  named future work, not a silent assumption.

## The 24-hour window — read this one

Free-form messages deliver only within 24 hours of the customer's last
message; outside it the Graph API refuses by policy (error 131047 — template
messages are the sanctioned alternative, out of scope for v1). What this
package does about it is deliberate: the refusal leaves the delivery receipt
mid-`sending`, the worker's sweep keeps retrying, and **the reply delivers
itself the next time the customer writes** and the window reopens. A late
answer waits at the door rather than being lost — know that it works this
way before pointing a slow agent at WhatsApp.

## Rendering

Text passes through untouched (WhatsApp renders `*bold*`/`_italic_` natively
and tolerates markdown-ish prose; the core never parses content and this lens
declines to). Prompts render as interactive **reply buttons** whose ids carry
the canonical token **and the exact ask** (`toolCallId`) — the staleness rule
rides the button, and the Cloud API's 256-character id cap never forces a
degrade. Long answers become a head-slice plus the session's web URL.

## Delivery guarantees

Admission is exactly-once (`wamid`). Outbound is receipt-backed
effectively-once with **`retry`** declared — the Cloud API has no idempotency
key, so a crash in the window between post and confirm may double-send rather
than lose. The trust boundary is two checks: the GET handshake by
`verifyToken`, every event POST by `X-Hub-Signature-256` under the app
secret, both compared in constant time.

## Exports

`whatsapp(options)` — the factory (tier 1). `whatsappLens`,
`whatsappTransport`, `verifyWhatsAppRequest`, `parseWhatsAppRequest`,
`isSubscriptionHandshake` — the pieces (tiers 2 and 3), plus the
`WhatsAppEvent` union `parse` produces. Tests:
`meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent-channel-whatsapp`.
