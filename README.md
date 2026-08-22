# meteor-agent

**An AI agent harness that works the Meteor way.** The transcript is a Mongo
collection. Streaming tokens are a capped collection. Tools are Meteor
methods. Authorization is `this.userId`. If you know Meteor, you already know
most of this package — the part you don't know is the part it does for you.

```ts
// server
import { Agent } from 'meteor/10thfloor:agent';

new Agent('support', {
  model: 'anthropic/claude-sonnet-5',
  instructions: ({ userId }) => `You help user ${userId} with their orders.`,
  tools: ['orders.lookup', 'orders.refund'],   // your existing Meteor methods
  budget: { turns: 20, spend: '$1.00' },
});
```

```html
<!-- client -->
<agent-chat agent="support"></agent-chat>
```

Or skip the element and build your own UI on a plain reactive cursor:

```ts
const Support = new Agent('support');
const sessionId = await Support.start();
Support.subscribe(sessionId);
await Support.send(sessionId, 'where is my order?');

Support.messages(sessionId).fetch();  // minimongo cursor — streaming tokens
Support.status(sessionId);            // 'idle' | 'streaming' | 'awaiting' | …
```

That cursor updates token by token, works in Blaze, React, and Svelte, and
needs no client-side AI library at all.

## Quick start

```bash
meteor add 10thfloor:agent            # (not yet on Atmosphere — see Status)
meteor npm install --save @earendil-works/pi-ai typebox
meteor remove insecure autopublish
export ANTHROPIC_API_KEY=sk-...       # or OPENAI_API_KEY, etc.
```

Define an agent on the server, drop `<agent-chat>` on a page (after calling
`defineAgentChat()`), and you have a streaming, tool-using, human-gated agent.

### Try the demo

```bash
git clone https://github.com/10thfloor/meteor-agent && cd meteor-agent/app
meteor npm install
meteor run --port 3400
```

No API key needed — a scripted provider streams canned responses and
exercises the tool and approval paths (`"what time is it?"`, `"refund my
order"`). Set `ANTHROPIC_API_KEY` and restart to talk to a real model.

### Test without spending a cent

```ts
import { mockProvider } from 'meteor/10thfloor:agent';
Support.define({ model: 'mock', instructions: '…',
  provider: mockProvider(() => ({ text: 'hi' })) });
```

The package's own 322-test suite runs entirely network-free.

## Why this exists

Every agent framework rebuilds the same four things: a durable transcript, a
live view of it, a permissioned set of operations the model may call, and a
loop that survives restarts. Meteor already ships the first three as
collections, publications, and methods. This package supplies the loop —
and inherits the rest from the framework instead of reinventing it.

The consequences are the interesting part:

- **Your methods are your tools.** A tool listed as `'orders.refund'` runs
  your existing method through a real `MethodInvocation` — `this.userId`,
  `this.unblock()`, and its own `check()` calls all work untouched. One
  implementation serves your UI and your agent.
- **Crashes are boring.** Assistant messages commit only at turn boundaries,
  every write is guarded by a per-session lease, and a watcher on every app
  server claims orphaned runs. Kill a pod mid-stream and the turn repairs
  itself and reruns.
- **Humans stay in the loop without holding a process open.** A tool marked
  `gate: 'ask'` *parks* the run — no timer, no waiting promise — and survives
  deploys until someone approves, denies, or a timeout does.
- **Cost has brakes.** Turn, tool-call, and dollar budgets are enforced
  before the spend they govern; provider-reported cost is preferred over
  price-table math; DDP rate limits guard every entry point.

## Streaming

Tokens arrive through a Mongo publication, not a side channel. The client
merges committed messages and in-flight deltas into one reactive cursor that
updates token by token.

```ts
// client
const Support = new Agent('support');
const sessionId = await Support.start();
Support.subscribe(sessionId);
await Support.send(sessionId, 'where is my order?');

Support.messages(sessionId).fetch();  // reactive cursor — streaming tokens included
Support.status(sessionId);            // 'idle' | 'streaming' | 'calling' | 'awaiting'
await Support.interrupt(sessionId);   // aborts the HTTP request, not just the UI
```

## Tools — five kinds

### Your existing Meteor methods

```ts
// server
tools: ['orders.lookup']
```

The method runs under a real `MethodInvocation` — `this.userId`, `this.unblock()`,
and its own `check()` calls all work untouched.

### Inline functions

```ts
// server
tools: [{
  name: 'clock',
  description: 'The current server time',
  args: { type: 'object', properties: {} },
  run: async () => new Date().toISOString(),
}]
```

### Co-registered method + tool

One definition, one schema, two callers — the model and your UI.

```ts
// server
const lookup = Agent.method('orders.lookup', {
  description: 'Look up an order by id',
  args: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  run(args) { return Orders.findOneAsync({ _id: args.id, userId: this.userId }); },
});

Support.define({ model, instructions, tools: [lookup] });
await Meteor.callAsync('orders.lookup', { id });   // your UI calls the same thing
```

### MCP servers

```ts
// server
Agent.mcpServer('docs', {
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'],
});

Support.define({ model, instructions,
  tools: [{ mcp: { server: 'docs', tool: 'search' } }],
});
```

### Other agents

```ts
// server
tools: [{ subagent: 'researcher', description: 'Look something up' }]
```

### `runAs` — a tool with a fixed identity

A tool normally runs as the session's owner. `runAs` replaces that for one
tool, while authorization stays with the real user.

```ts
// server
tools: [{
  method: 'billing.credit', description: 'Issue a credit',
  args: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
  runAs: 'service-account',
}]
```

The real caller arrives as `ctx.callerUserId` — so the tool can act with
elevated privileges while still knowing who asked.

## Budgets

Turn, tool-call, and dollar limits are enforced before the spend they govern.
A send past the turn limit is refused; a tool call past the cap is never
dispatched.

```ts
// server
Support.define({
  model, instructions, tools,
  budget: {
    turns: 20,            // sends refused at 21
    toolCalls: 40,        // per session
    spend: '$1.00',       // provider-reported cost preferred over price-table math
    approval: 3600000,    // ms a gate:'ask' may sit unanswered
  },
});
```

An agent whose budget sets none of `turns`, `toolCalls`, or `spend` is named
in a startup warning — nothing bounds its spend.

## Approval gates

Any tool can require human approval before it runs. The turn parks — no timer,
no waiting promise — and survives deploys until someone answers.

```ts
// server
tools: [{
  name: 'refund', description: 'Refund an order',
  args: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  gate: 'ask',
  run: async (args) => Refunds.issueAsync(args.orderId),
}]
```

Or decide per call:

```ts
// server
gate: ({ args }) => args.amount < 50 ? true : 'ask'
```

```ts
// client
await Support.approve(sessionId);
await Support.deny(sessionId, 'the amount is too large');
```

Two people clicking Approve at the same time? One wins — atomic conditional
write. A timeout nobody answers? The watcher denies it automatically.

## Subagents

Put one agent behind another's tool call. The child gets its own session,
transcript, live stream, and budgets.

```ts
// server
new Agent('researcher', {
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You look things up and answer in one paragraph.',
  budget: { toolCalls: 8, spend: '$0.25' },
  startable: false,
});

new Agent('writer', {
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You draft answers, delegating research when you need a fact.',
  tools: [{ subagent: 'researcher', description: 'Ask the researcher' }],
});
```

```ts
// client — subscribe to the child's live stream while it runs
const active = Writer.session(sessionId)?.activeChild;
if (active) new Agent('researcher').subscribe(active.sessionId);
```

Nesting is depth-guarded (3 levels). Fan-out is bounded by `budget.toolCalls`.

## Forking

Branch any conversation and diverge. The original is untouched.

```ts
// client
const branch = await Support.fork(sessionId);
const earlier = await Support.fork(sessionId, { atSeq: 12, title: 'What if' });
Support.subscribe(branch);
await Support.send(branch, 'try it the other way');
```

`atSeq` is clamped to the nearest safe cut — you can pass whatever seq the user
clicked without knowing anything about tool batches.

## Compaction

Long conversations summarize themselves. The model's context window shrinks,
but the full transcript is preserved for humans and audits.

```ts
// server
Support.define({
  model, instructions, tools,
  context: { window: 200000, compactAt: 0.8, keep: 6 },
});
```

When the transcript exceeds 80% of the window, everything before the last 6
messages is summarized into a single row. Swap the summarizer with a hook if
you want a cheaper model or a different prompt.

## Skills

On-demand prompt fragments the model can load when it needs them, rather than
stuffing everything into the system prompt.

```ts
// server
Support.define({
  model, instructions,
  skills: [
    { name: 'refunds', description: 'The refund policy and steps', content: '…' },
    { name: 'escalation', description: 'When and how to escalate', content: '…' },
  ],
});
```

The model sees a `## Skills` listing and a `skill` tool. It calls the tool to
load the content it needs for the current question.

## Hooks

Two extension seams: what goes out to the provider, and what comes back from a
tool.

```ts
// server
Agent.hook('beforeProviderRequest', (req, ctx) => {
  return { ...req, system: `${req.system}\n\nToday is ${new Date().toDateString()}.` };
});

Agent.hook('afterToolResult', (result, call, ctx) => {
  if (call.name !== 'orders.lookup' || !result.ok) return;
  const order = result.value;
  return { ...result, value: { ...order, card: `••••${order.card.slice(-4)}` } };
});
```

Per-agent hooks scope to one agent:

```ts
// server
Support.hook('beforeProviderRequest', (req, ctx) => {
  if (ctx.purpose === 'compaction') return { ...req, model: 'anthropic/claude-haiku-4-5' };
});
```

Global hooks run first; per-agent hooks run after. A broken hook is skipped
with a warning — it never kills a turn.

## Durability

Kill the server mid-stream. The assistant message was never committed — only
deltas were, and they are scratch. The lease expires, the watcher claims the
orphan, and a new server re-runs the turn from the last committed row. One
assistant row lands, never two, never a half.

```
provider streaming ──▶ kill -9 ──▶ lease expires (≤30s) ──▶ watcher claims
  ──▶ new serverId, re-runs turn ──▶ committed, idle
```

No application code required. The watcher starts at boot on every server.

## Validation

Model-supplied tool arguments are checked against the JSON Schema you already
wrote in `args`. Invalid arguments are refused as a tool result the model reads
and retries — no exception, no crash.

```ts
// server
tools: [{
  name: 'transfer',
  description: 'Transfer funds',
  args: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      amount: { type: 'number', minimum: 0 },
    },
    required: ['to', 'amount'],
  },
  gate: 'ask',
  run: async (args, ctx) => Transfers.executeAsync(args, ctx.userId),
}]
```

Schemas are compiled once per process (typebox). If the compiler is unavailable,
validation degrades gracefully: a documented ladder from compiled check to
`typeof` probe to pass-through, each logged.

## Providers

The default talks to any model [pi-ai](https://github.com/earendil-works/pi)
supports — Anthropic, OpenAI, Google, Bedrock, OpenRouter — with one env var
and one model string.

```ts
// server — no provider needed; env ANTHROPIC_API_KEY is enough
Support.define({ model: 'anthropic/claude-sonnet-5', instructions: '…' });
```

Swap to a mock for tests and demos — no key, no network, full suite:

```ts
// server
import { mockProvider } from 'meteor/10thfloor:agent';

Support.define({
  model: 'mock', instructions: '…',
  provider: mockProvider(() => ({ text: 'hi there' })),
});
```

Or write your own — any object with a `stream()` method:

```ts
// server
const echo = {
  async *stream(req) {
    const last = [...req.messages].reverse().find(m => m.role === 'user');
    for (const ch of `you said: ${last?.content ?? ''}`) yield { kind: 'text', chunk: ch };
    yield { kind: 'done', usage: { input: 7, output: 3 } };
  },
};
```

## Headless: no UI at all

`ask()` is the whole conversation in one call — throwaway session, one turn,
cleanup in `finally`.

```ts
// server
Meteor.methods({
  async 'support.summarize'(orderId) {
    check(orderId, String);
    return Support.ask(`Summarize order ${orderId}.`, { userId: this.userId });
  },
});
```

## `<agent-chat>`

A custom element that never registers itself — call `defineAgentChat()` to
opt in. Shadow DOM, themable through CSS custom properties and `::part()`.

```ts
// client
import { defineAgentChat } from 'meteor/10thfloor:agent';
defineAgentChat();
```

```html
<agent-chat agent="support" placeholder="Ask about your order…">
  <h1 slot="header">Support</h1>
</agent-chat>
```

```css
agent-chat {
  --agent-chat-accent: #6d28d9;
  --agent-chat-font: 'Iowan Old Style', Georgia, serif;
}
agent-chat::part(message user) { border-radius: 0.25rem; }
agent-chat::part(phase awaiting) { text-transform: uppercase; }
```

Session persistence, error recovery, and the approval prompt are built in.
Drop to `Agent` directly for layouts it does not have or two sessions side by
side.

## Channels

The same agent, reachable from Slack, SMS, or email. A channel is two adapters
over the machinery above — a verified webhook in, a delivery worker out — plus
a **lens**: one object that renders outbound items into the surface's native
form and interprets inbound events back into a fixed set of meanings.

```ts
// server
import { sms } from 'meteor/10thfloor:agent-channel-sms';

const cfg = Meteor.settings.packages['10thfloor:agent'].sms;
Agent.channel('sms', sms({
  agent: 'support',
  accountSid: cfg.accountSid,   // AC…
  authToken: cfg.authToken,     // also the signature key
  webhookUrl: cfg.webhookUrl,   // the EXACT public URL Twilio calls
}));
```

The factory is sugar over a plain channel definition — the same pieces you
would write for a surface of your own:

```ts
Agent.channel('sms', {
  agent: 'support',
  transport: smsTransport({ accountSid, authToken }),
  lens: smsLens,                              // { out, in } — two halves, one object
  profile: { interact: 'menu', limit: 1500 }, // choices render as "Reply YES / NO"
  verify: (raw) => verifyTwilioSignature(raw, authToken, webhookUrl),
  parse: (raw) => parseTwilioForm(raw.rawBody),
  statuses: ['error', 'approval'],
});
```

(where `accountSid`, `authToken`, `webhookUrl` are the same three settings
values). The webhook mounts at `/agent/channels/sms`; the worker delivers every
committed reply to every surface bound to the session. One conversation can be
live in Slack, mirrored over SMS, and open in the web app at once — each
surface tracks its own cursor, so a downed gateway delays only itself.

Four surfaces ship today, each a package of exactly one lens, one transport,
and one profile — **Slack** (threads, buttons, mrkdwn), **Telegram** (inline
keyboards, secret-token webhooks), **WhatsApp** (reply buttons, the signed
Cloud API, the 24-hour window handled honestly), and **SMS via Twilio** (the
reply-menu grammar: "Reply YES to approve"). The same parked approval renders
as buttons on three of them and as reply words on the fourth, and any surface
decides it — first answer wins.

What you inherit without writing it: **exactly-once admission** (a provider
retry never runs a second turn), **effectively-once delivery** (a three-phase
receipt log — a redeploy re-sends nothing), **approvals over any surface**
(buttons where the surface has them, "Reply YES to approve" where it doesn't,
single-use links where replies are awkward — same single-winner verdict
either way), and **account linking with assurance levels**, so a gate can say
"auto-approve for OAuth-proven users, ask otherwise" in a few lines:

```ts
gate: async ({ sessionId }) => {
  const session = await AgentSessions.findOneAsync(sessionId);
  return session?.channel?.assurance === 'oidc' ? true : 'ask';
}
```

A new surface is a few dozen lines — two functions and one shipped property
test (`assertLensRoundTrip`) that proves every affordance you render reads
back as the meaning you meant. The design is
[`2026-08-20-channels-multi-surface-delivery.md`](docs/superpowers/specs/2026-08-20-channels-multi-surface-delivery.md).

## Further reading

The **[package README](app/packages/agent/README.md)** is the full API
reference — config surface, tools, budgets, gates, subagents, MCP, skills,
hooks, theming, channels, and the operational notes that matter in production.
**[by-example.md](docs/by-example.md)** covers the same ground as working
code — including a failure drill that kills the server mid-stream and watches
the transcript put itself back together.

## Requirements

- **Meteor 3.5+** (change streams, async DDP rate limiters, Node 24)
- **MongoDB as a replica set in production** — on standalone Mongo, Meteor's
  observers fall back to ~10s polling and streaming feels like a teleprinter.
  This is Meteor's constraint, not this package's; Atlas or a single-node
  `--replSet` is fine.
- `@earendil-works/pi-ai` as an app dependency (unless you bring your own
  provider), `@modelcontextprotocol/sdk` only if you use MCP tools.

## How it holds together

```
send() ─▶ method (authorize, atomic seq) ─▶ lease claim ─▶ turn loop
                                                             │
   provider stream ──chunks──▶ [capped deltas] ──publication──▶ merged cursor
                     └──done──▶ [messages]  (committed at boundaries only)
```

The design reasoning — the lease model, the repair invariants, the
approval-gate semantics, why the merge walks backward — lives in the design
spec ([`docs/superpowers/specs/`](docs/superpowers/specs/)), and the five
milestone plans that built on it are in
[`docs/superpowers/plans/`](docs/superpowers/plans/).

## Project layout

```
app/packages/agent/                   the package (this is what ships)
app/packages/agent-channel-slack/     Slack surface     ┐
app/packages/agent-channel-telegram/  Telegram surface  │ one lens, one
app/packages/agent-channel-whatsapp/  WhatsApp surface  │ transport each
app/packages/agent-channel-sms/       SMS (Twilio)      ┘
app/                                  host app: test harness + the demo chat
docs/superpowers/                     design spec + per-milestone implementation plans
scripts/verify-build.sh               proves the loader against a real production bundle
```

Development workflow, the test command, and the npm-dependency policy are in
**[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Status

Five milestones shipped: the spec's v1 (streaming, tools, gates, budgets,
compaction, recovery), the v2 features (subagents, forking, MCP, skills,
hooks, the element), and the v3 backlog:

- **predicate gates** — `gate` may be a function, so authorization can read
  the arguments and the caller instead of only the tool's name;
- **per-agent hooks** — `agentInstance.hook(...)` beside the global
  `Agent.hook(...)`, globals first;
- **idempotent subagent dispatch** — a recovered parent turn reuses the child
  it already created instead of running a second one;
- **orphan re-link** — the sweep writes a pointer into the parent transcript
  when a dispatch died before committing its result, so no child is stranded;
- **interrupt propagation** — Stop walks the `activeChild` chain and stops the
  work the user can actually see;
- **wake tokens** — a deferred wake proceeds only if the verdict it captured
  still stands;
- **compiled argument validation** — one compiled JSON-Schema checker per tool
  schema, cached for the process, with a documented degrade ladder;
- **startup indexes** — the transcript read and the watcher's sweeps stopped
  being collection scans;
- **a `tool_args` delta clamp** — one runaway argument stream can no longer
  evict every other session's tokens from the capped delta collection.

The sixth addition is **channels** — multi-surface delivery per the
[channels spec](docs/superpowers/specs/2026-08-20-channels-multi-surface-delivery.md):
the lens contract with its round-trip test, the watcher-shaped egress worker,
the generic webhook pipeline, exactly-once admission, receipt-backed delivery,
and account linking. Server-side `agent.send/approve/deny({ userId })` landed
with it. The core takes no provider SDK dependency; four surface packages
prove the contract, each one lens + one transport + zero npm dependencies:
**[Slack](app/packages/agent-channel-slack/README.md)**,
**[Telegram](app/packages/agent-channel-telegram/README.md)**,
**[WhatsApp](app/packages/agent-channel-whatsapp/README.md)**, and
**[SMS/Twilio](app/packages/agent-channel-sms/README.md)** — the last being
the design's stress test (no buttons, no threads: approvals ride the
receipt-registered "Reply YES/NO" grammar).

CI runs the full suite plus a production-bundle verification on every push.

Honest caveats: the package is **not yet published to Atmosphere** (install
from this repo until then), and the live-provider smoke test is the one test
that needs a real API key — everything else is verified network-free.

## License

[MIT](LICENSE)
