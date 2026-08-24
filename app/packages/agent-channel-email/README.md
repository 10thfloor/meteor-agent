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

## Attachments

Real work product travels both ways (the email v2 spec,
`docs/superpowers/specs/2026-08-23-email-attachments-and-compose.md`):

- **Inbound** — files on a mail are admitted under caps (defaults: 5 MB/file,
  5 files, 6 MB/message), stored server-side, and ride the user's message as
  metadata refs; every rejected file becomes a visible bracket note in the
  message ("fail closed, never silently"). An **attachment-only mail is a
  message** — someone answering "can you check this?" with just the file.
  The model sees name/type/size/id lines and reads content through the
  shipped tool — list it like any other spec:

  ```js
  tools: [Agent.attachments.readTool, /* … */]
  ```

  Text-like files return text (capped at 64 KB); binary files return a
  structured refusal the model can still *forward*. File content is data from
  the sender, never instructions.

  Tune or disable per channel: `email({ …, attachments: { maxFileBytes, maxFiles,
  maxTotalBytes } })`, or `attachments: false` for v1's ignore-them behavior.
  Deployments that admit strangers' mail should set the store-wide retention
  (`settings.packages['10thfloor:agent'].attachments.retentionDays`): caps
  bound a message, TTL bounds a stranger's patience.

- **Outbound** — a tool body creates a file and stages it for the reply:

  ```js
  const ref = await Agent.attachments.create({
    sessionId: ctx.sessionId, name: 'summary.csv', contentType: 'text/csv',
    content: csvText,                  // or { base64 } for binary
    attach: true, toolCallId: ctx.toolCallId,   // idempotent across crash re-runs
  });
  ```

  The turn-final reply claims every staged file and the mail carries real
  Postmark attachments. Bytes hydrate only when a post actually happens; a
  file pruned by retention before delivery becomes a bracket note, never a
  silent loss. Chat surfaces (Slack/SMS/…) can't carry bytes yet — they name
  each file in text instead; no surface may silently vanish one (the lens
  law's naming clause).

- **The webhook body ceiling** is raised to 50 MB for this channel
  (`maxInboundBytes`) because Postmark delivers attachments base64'd inside
  the webhook JSON, up to 35 MB cumulative. Admission caps decide what is
  *kept*.

## Compose — emailing someone new

Replying happens by itself; **composing is a deliberate act** the model takes
through a tool, with the recipient validated by *your* code:

```js
import { composeEmailTool } from 'meteor/10thfloor:agent-channel-email';

tools: [
  composeEmailTool({
    serverToken: cfg.serverToken,       // the same thin transport
    from: 'Agent <agent@ourdomain.com>',
    inboundAddress: cfg.inboundAddress,
    recipients: (to) => to.endsWith('@ourco.com'),   // REQUIRED — no permissive default
    // gate: 'ask' is the DEFAULT: every compose parks for approval
  }),
]
```

- `recipients` is required: `'linked'` (the session owner's linked addresses —
  "email it to me"), an allowlist array, or a predicate run in trusted code.
  The model *proposes* `to`; a refusal comes back structured and it routes
  around it. A policy that throws refuses (fail closed).
- Args: `{ to, subject, body, attachments?: string[] }` — the last being
  attachment **ids** from this conversation, session-scoped.
- **Effectively-once**: the send is receipt-logged under the tool call's id,
  so a crash-recovery re-run of the tool reports the settled send instead of
  mailing twice.
- **A reply to composed mail opens a fresh conversation** by default —
  `Reply-To` is the plain inbound address (no thread key) and the mail is
  stamped `Auto-Submitted: auto-generated`. `onReply: 'continue'` closes the
  loop instead — see below.
- Compose is **not a reply path**: the person you are already talking to gets
  the turn's answer automatically; composing to them delivers twice. The tool
  description says so to the model.

### `onReply: 'continue'` — the composed loop

With `onReply: 'continue'` (and `kind` naming the registered email channel,
default `'email'`), a successful send **joins the recipient to the
conversation** (participants spec §5): the mail's `Reply-To` carries a thread
key derived from *session + recipient* — a crash re-run or a second compose
to the same address lands in the same conversation — and the send pre-binds
that key to the composing session as a **member binding**, with the recipient
on the session's roster.

What that means, plainly:

- **Their replies continue this session**, attributed
  (`from: dana@ourco.com`), admitted through the roster regardless of DKIM —
  an unverified reply is one attributed, powerless message; verification
  still gates account *linking*, exactly as before.
- **Your future replies are delivered to them too** — including the one the
  model writes right after composing (its snapshot cursor starts them at the
  composed message, never the session's backlog). Joining someone is what
  the default `gate: 'ask'` approval is consenting to, and the approval
  prompt says so.
- **They get outward replies only**: never approval prompts, status notes,
  or capability URLs — and if they later link an account, linking updates
  their roster row without ever handing them the session.
- Refused, structured, where a correspondence cannot live: throwaway
  (`Agent.ask`) sessions, subagent children, and when the `kind` channel is
  not registered (the reply needs a webhook to arrive through).
- The first reply also teaches the binding its threading root
  (`In-Reply-To`/`References` on everything after), so the exchange threads
  properly in the recipient's mail client.

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

- **HTML-only mail** with an empty plain-text part and no attachments is a
  noop (there is nothing to send the agent). Postmark supplies `TextBody` for
  most mail.
- **Inline images** (`ContentID` attachments — signature logos) are skipped
  inbound and never emitted outbound. HTML bodies are not produced.
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

`email(options)` — the factory. `composeEmailTool(options)` — the proactive
compose tool. `emailLens`, `emailTransport`, `verifyPostmarkWebhook`,
`parsePostmarkInbound`, `isFromAuthenticated`, `threadKey`, `replyToFor`,
`reSubject`, `stripQuotedReply` — the pieces, plus the `EmailEvent`,
`EmailDestination`, `ComposeEmailToolOptions` and `ComposeRecipientsPolicy`
types. Tests:
`meteor test-packages --once --driver-package meteortesting:mocha ./packages/agent-channel-email`.
