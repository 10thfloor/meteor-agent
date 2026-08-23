# 10thfloor:agent-channel-email

Email as a surface for a [`10thfloor:agent`](../agent/README.md) agent, with
[Postmark](https://postmarkapp.com) as the reference provider: mail the
agent's inbound address and the conversation is a real agent session —
replies arrive threaded in your mail client, follow-ups keep the thread, and
approval gates arrive as single-use **Approve / Deny** links (or, without a
web route, as "Reply YES to approve").

Per the channels spec, this package is **one lens, one transport, one profile
default** — Postmark's JSON shapes and the webhook's Basic-auth boundary, and
nothing else. Bindings, receipts, exactly-once admission, the delivery worker,
and account linking all live in the core package. Zero npm dependencies.

## Install and register

```js
// server
import { Agent } from 'meteor/10thfloor:agent';
import { email } from 'meteor/10thfloor:agent-channel-email';

const cfg = Meteor.settings.packages['10thfloor:agent'].email;
Agent.channel('email', email({
  agent: 'support',
  serverToken: cfg.serverToken,          // Postmark Server API token
  from: 'Support <support@yourdomain.com>',
  inboundAddress: cfg.inboundAddress,    // the address people write to
  webhookUser: cfg.webhookUser,          // the Basic-auth pair in the webhook URL
  webhookPassword: cfg.webhookPassword,
  approvalUrl: (token) => Meteor.absoluteUrl(`verdict/${token}`),   // optional — see Approvals
}));
```

The webhook mounts at **`/agent/channels/email`**.

## Setting up Postmark (manual test walkthrough)

1. **Expose your dev server** over HTTPS (`cloudflared tunnel --url http://localhost:3000`).
2. **Create a Postmark server**; copy its **Server API token** (API Tokens tab).
3. **Outbound**: add a Sender Signature (or verify your domain) for the `from`
   address.
4. **Inbound**: open the server's *Inbound* stream. Set the **webhook URL** to
   `https://USER:PASS@YOUR-TUNNEL/agent/channels/email` — the `USER:PASS`
   pair is what `webhookUser`/`webhookPassword` must match. Note the stream's
   inbound address (`…@inbound.postmarkapp.com`), or point your own domain's
   MX at Postmark and use `inbound@yourdomain.com`. Either is
   `inboundAddress`.
5. **Settings** (`settings.json`):

   ```json
   {
     "packages": {
       "10thfloor:agent": {
         "email": {
           "serverToken": "…",
           "from": "Agent Demo <demo@yourdomain.com>",
           "inboundAddress": "…@inbound.postmarkapp.com",
           "webhookUser": "hook",
           "webhookPassword": "a-long-random-secret"
         }
       }
     }
   }
   ```

6. **Run** (`meteor run --settings settings.json`) and **email the inbound
   address**. The reply arrives in the same thread. Reply to it — the thread
   holds. With the demo agent, "what time is it" shows a tool call and
   "refund my order" parks an approval.

## The five decisions

- **Conversation key — the thread, recovered statelessly.** The first
  message's `Message-ID` is the root; its key is a short hash of that id. Every
  reply we send sets `Reply-To: <local>+<key>@<inbound domain>`, so a later
  reply — even from a client that drops `References` — comes back carrying the
  key as Postmark's `MailboxHash`. Fallbacks: first `References` entry, then
  `In-Reply-To`, then the message's own id (a new thread). No lookup table.
- **Identity key — the sender address**, lower-cased, and mapped to a linked
  account **only when the mail passed author-aligned DKIM** (Postmark's
  SpamAssassin `DKIM_VALID_AU`). A `From` is forgeable SMTP, so an unverified
  sender stays anonymous and a spoofed `From:` cannot inherit a linked owner's
  account. The check is fail-closed: no signal ⇒ anonymous.
- **Audience — `direct`.** Replies go to one address.
- **Interaction — `link`** when `approvalUrl` is configured (the core mints a
  single-use URL per choice at delivery; the mail carries `Approve: …` /
  `Deny: …` lines), else **`menu`** ("Reply YES to approve, NO to deny"),
  matched against the reply's stripped text.
- **Echo rule — auto-responders.** Out-of-office, bounces, mailer-daemon and
  list traffic (`Auto-Submitted`, `X-Autoreply`, `Precedence: bulk|list|…`,
  the daemon senders) are noops by design; the ping-pong loop never forms.

## Approvals

With `approvalUrl`, an approval mail contains two single-use links. Your app
answers the route by calling `redeemVerdictToken(token)` from
`meteor/10thfloor:agent` — no login required (the token *is* the capability,
addressed to the person the prompt was sent to); it decides the ask at most
once, only while that exact ask is still parked, and indistinguishably fails
otherwise. The demo app's `/verdict/<token>` page is the reference. Without
`approvalUrl`, replies of `YES` / `NO` decide the ask through the pipeline's
reply grammar.

> **Gate redemption behind a user action.** An approval mail carries both
> single-use URLs in plain text, and mail-security scanners (Defender
> SafeLinks, Proofpoint, Mimecast) *fetch and execute page JS* on links before
> the recipient reads the mail. Your `approvalUrl` target must require an
> explicit click — a Confirm button — before it calls `redeemVerdictToken`;
> redeem on page load and a scanner silently decides the ask. The demo's
> `/verdict/<token>` page does exactly this.

## Account linking

Reply (or write) with the bare word **`link`**: the agent answers with a
one-time URL to the same address. Open it signed in to the web app and the
address is linked to your account (`assurance: 'link'`) with its anonymous
history claimed. `linkUrl` on the factory is the app-side hook.

## Rendering

Plain text. Content passes through opaque (no Markdown conversion — mail
clients render `**bold**` literally, which is honest); prompts render the
tool name, its arguments, and the choices one per line. Override per the core
README's lens ladder — spread `emailLens` and replace one item.

## Delivery guarantees

Admission is exactly-once on Postmark's inbound `MessageID` (it retries failed
webhooks with the same id). Outbound is receipt-backed effectively-once with
**`retry`** as the declared recovery: Postmark's send API has no idempotency
key, so a crash in the one window between post and confirm may re-send
rather than lose a reply. The receipt key travels in an `X-Agent-Receipt`
header on every mail.

## Caveats, named

- **HTML-only mail** with an empty plain-text part is a noop (there is no
  text to send the agent). Postmark supplies `TextBody` for most mail.
- **Attachments** are ignored in v1.
- **Quoted-reply stripping** prefers Postmark's `StrippedTextReply`; the
  package's own stripper (the fallback) is conservative — a stray quoted line
  becomes part of the message rather than the message being lost.
- **Linked identity needs author-aligned DKIM.** Recognizing a *linked* sender
  relies on Postmark's inbound SpamAssassin verdict carrying `DKIM_VALID_AU`
  in `X-Spam-Tests`. If the inbound stream has spam checks off, or a sender's
  domain does not publish aligned DKIM, that sender stays anonymous — safe, but
  their linked history will not attach. Major providers sign aligned DKIM by
  default. (SMS/WhatsApp get this for free: the carrier authenticates the
  number. Email does not, so the channel gates it explicitly.)
- The webhook's Basic-auth credential is the trust boundary; Postmark also
  publishes inbound IP ranges — an allowlist at your edge is the belt to that
  suspenders.

## Exports

`email(options)` — the factory. `emailLens`, `emailTransport`,
`verifyPostmarkWebhook`, `parsePostmarkInbound`, `isFromAuthenticated`,
`threadKey`, `replyToFor`, `reSubject`, `stripQuotedReply` — the pieces, plus
the `EmailEvent` and `EmailDestination` types. Tests:
`meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent-channel-email`.
