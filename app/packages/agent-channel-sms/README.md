# 10thfloor:agent-channel-sms

SMS (via Twilio) as a surface for a [`10thfloor:agent`](../agent/README.md)
agent: text the number and the conversation is a real agent session — replies
by text, approval gates as **"Reply YES to approve, NO to deny"**, and the
same transcript open in the web app at the same time.

This is the channel design's stress test on purpose: no buttons, no threads,
no markup, weak identity, hard length limits. Per the channels spec, the
package is **one lens, one transport, one profile default** — Twilio's
signature scheme and wire shapes, nothing else. Bindings, receipts,
deduplicated admission, the delivery worker, the reply-menu grammar, and
account linking all live in the core. Zero npm dependencies.

## Install and register

```bash
meteor add 10thfloor:agent-channel-sms
```

```js
// server
import { Agent } from 'meteor/10thfloor:agent';
import { sms } from 'meteor/10thfloor:agent-channel-sms';

const cfg = Meteor.settings.packages['10thfloor:agent'].sms;
Agent.channel('sms', sms({
  agent: 'support',
  accountSid: cfg.accountSid,   // AC…, Twilio console dashboard
  authToken: cfg.authToken,     // ditto — also the signature key
  webhookUrl: cfg.webhookUrl,   // the EXACT public URL Twilio calls — see below
}));
```

The webhook mounts at **`/agent/channels/sms`**.

## Setting up Twilio (manual test walkthrough)

1. **Expose your dev server** over HTTPS:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

2. **Get a number**: Twilio console → Phone Numbers → Buy a number (a trial
   account works — it can text your own verified phone).

3. **Point the number at the webhook**: the number's configuration →
   Messaging → *A message comes in* → Webhook,
   `https://YOUR-TUNNEL/agent/channels/sms`, HTTP POST.

4. **Settings** — add to `settings.json`. `webhookUrl` must be the **exact**
   URL from step 3, to the character: Twilio's signature covers the full
   public URL, which a server behind a tunnel cannot learn from the request
   it receives — so it is configuration, and a scheme/host/trailing-slash
   mismatch is a 401 on every request.

   ```json
   {
     "packages": {
       "10thfloor:agent": {
         "sms": {
           "accountSid": "AC…",
           "authToken": "…",
           "webhookUrl": "https://YOUR-TUNNEL/agent/channels/sms"
         }
       }
     }
   }
   ```

5. **Run** with `meteor run --settings settings.json` and text the number.
   With the demo agent: *"what time is it"* exercises a tool call; *"refund
   my order"* parks an approval — the prompt arrives as a text ending in
   **"Reply YES to approve, or NO to deny."**, and replying `yes` (any case,
   whitespace tolerated — exact word only) decides it. Text **`link`** to get
   the one-time URL that ties this phone number to a signed-in web account.

## What the lens answers, and what it never does

- **Every inbound text** routes: SMS is 1:1 by construction, so there is no
  mention policy — and audience is always `direct`, which makes this the one
  surface where an anonymous session's web link may always be sent.
- **Conversations are keyed by the NUMBER PAIR** (your Twilio number + the
  sender), so a phone's thread is one ongoing conversation forever, and an
  app running several numbers keeps them distinct.
- **Delivery-status callbacks** (`MessageStatus` posts) are noops by design;
  Twilio never webhooks your own outbound messages, so the self-reply loop
  cannot form.
- **"YES" is not special to the lens.** Whether a reply decides a parked
  approval is the pipeline's call, made against the reply words the
  delivered prompt REGISTERED in its receipt — never a stateless keyword
  match. A "yes" with nothing pending is just a message; a "yes" aimed at
  last week's ask decides nothing (the `toolCallId` staleness rule).
- **Duplicates never run twice**: admission dedup on `MessageSid` absorbs
  Twilio's retries.
- One cosmetic wart: the webhook answers a plain `200` rather than TwiML, so
  Twilio's debugger may log a 12300 content-type notice per inbound message.
  Harmless — the message is fully processed; replies go out via the REST API,
  not the webhook response.

## Rendering

Markdown decoration is **stripped** (`**bold**` → bold, headings unhashed) and
links keep both halves — "the docs (https://…)" — because on a phone the words
and the address are each worth keeping. Long answers become a head-slice plus
the session's web URL (the `overflow` item); the default `limit: 1500` sits
under Twilio's hard 1600-character cap.

## Delivery guarantees — read this one

Admission is deduplicated by Twilio's stable message id during the core's
seven-day retention window. Outbound is receipt-backed effectively-once with
**`retry`** as the declared recovery tier, and here that declaration has
teeth: **Twilio's Messages API accepts no idempotency key**, so a crash in
the one window between a successful post and its confirmation may send a
duplicate text rather than lose one. That is the spec's tier-C reality named
honestly — if duplicates are unacceptable for your use, declare
`onUncertainDelivery: 'abandon'` and accept the opposite trade.

Identity is a phone number, and the spec's words apply verbatim: fine for
"what's my order status", never for anything privileged — SIM swap is
routine. Gate sensitive tools on a real link (`assurance`), not on the
number.

## Exports

`sms(options)` — the factory (tier 1). `smsLens`, `smsTransport`,
`verifyTwilioSignature`, `parseTwilioForm`, `toPlainText` — the pieces (tiers
2 and 3). Tests:
`meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent-channel-sms`.
