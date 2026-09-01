# 10thfloor:agent by example

Every capability this package advertises, as code you can paste. The
[package README](../app/packages/agent/README.md) is the reference — it answers
"what are the options for X". This guide answers "show me X working", in the
order you would actually build it: define an agent, watch it stream, give it
tools, put a human in front of the dangerous ones, extend it, and then — last,
because it is the part you only think about once — what happens when the server
running it dies mid-sentence.

Every example here was written against the source and the package's own test
suite, and checked back against them. Where an example is lifted from a test or
from the demo app in [`app/`](../app), it says so.

## The feature table, mapped

| | Start here |
|---|---|
| **Streaming** — token deltas through a capped collection, merged client-side into one ordered cursor | [How a token reaches the browser](#how-a-token-reaches-the-browser) |
| **Durability** — Lease + heartbeat + atomic seq allocation, private Activation recovery, repair-on-entry, interrupt aborts the HTTP request | [Durability: what survives a crash](#durability-what-survives-a-crash) |
| **Providers** — pi-ai by default, or any object with a `stream()` method | [Swapping providers](#swapping-providers) |
| **Tools** — Meteor methods, inline functions, co-registered pairs, MCP servers, other agents | [Tools: five ways to give a model hands](#tools-five-ways-to-give-a-model-hands) |
| **Approval gates** — park by exiting, approve/deny from the client, timeouts, audit rows | [Approval gates](#approval-gates) |
| **Subagents** — a named agent behind a tool call, with composed budgets and a depth guard | [Subagents](#subagents) |
| **Forking** — branch a conversation at a batch-safe point | [Forking](#forking) |
| **Compaction** — the model's view shrinks, the transcript keeps everything | [Compaction](#compaction) |
| **Skills & hooks** — on-demand prompt fragments; the two extension seams | [Skills](#skills) · [Hooks](#hooks) |
| **Fact Memory** — durable propositions about people and the work, in a collection your UI can read | [Fact Memory](#fact-memory) |
| **UI** — `<agent-chat>`, one tag, themable through custom properties and `::part()` | [`<agent-chat>`](#agent-chat) |
| **Validation** — model arguments checked against full JSON Schema, fail-closed on public endpoints | [Validation](#validation) |

Two conventions throughout: every code block says where it runs (`// server`,
`// client`, `<!-- client -->`), and failure modes are shown as often as happy
paths — what the *model* reads when a gate refuses or a schema rejects is
usually the part that decides whether your agent recovers or spins.

## Defining agents, and where the model comes from

An agent is a name, a config object, and a registry entry on the server. Everything else in this
guide — streaming, tools, gates, subagents, forking — is that entry being read by a turn.

### Install

```bash
meteor add 10thfloor:agent          # not on Atmosphere yet — vendor it into packages/
meteor npm install --save @earendil-works/pi-ai typebox
meteor remove insecure autopublish
export PROVIDER_API_KEY=...          # one API-key Provider
# Or, for several Providers, unset it and set ANTHROPIC_API_KEY,
# OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, etc. independently.
```

`typebox` checks model-supplied tool arguments; it is a transitive dependency of pi-ai today, so install
it directly in case a pi-ai bump drops it. `insecure` would hand clients direct write access to the
transcript collections — the package registers a blanket client-write `deny` on its collections as a
backstop, but removing `insecure` is the fix.

### The quickstart every other page assumes

```ts
// server/agents.ts
import { Agent } from 'meteor/10thfloor:agent';
export const Support = new Agent('support', {
  model: 'anthropic/claude-sonnet-5',
  instructions: ({ userId }) => `You help user ${userId} with their orders.`,
  tools: ['orders.lookup'],                 // a Meteor method you already have
  budget: { turns: 20, spend: '$1.00' },
});
```

```js
// client
import { Meteor } from 'meteor/meteor';
import { defineAgentChat } from 'meteor/10thfloor:agent';

Meteor.startup(() => { defineAgentChat(); });
```

```html
<!-- client -->
<agent-chat agent="support"></agent-chat>
```

The `agent` attribute is the registry name the server passed to `new Agent(...)`.
The client class is a separate, reactive handle; TypeScript code that builds a
custom UI imports it as `ClientAgent`. `new Agent(name, config)` defines the
server agent in one step, and `define()` returns `this` so per-agent hooks chain
off it. Defining the same name again replaces the entry, which makes Meteor hot
reload re-running server modules harmless.

### The whole config surface

Only `model` and `instructions` are required; the comments are the real defaults.

```ts
// server
Support.define({
  model: 'anthropic/claude-sonnet-5',        // '<provider>/<model-id>' — see below
  instructions: ({ userId }) => `…`,         // string | string[] | (ctx) => string
  tools: [
    'orders.lookup',                                              // adopt a method
    { name: 'total', description: '…', gate: 'ask',
      args: { type: 'object', properties: {} }, run: async () => 0 },     // inline
    { method: 'billing.credit', description: '…', runAs: 'service-account',
      args: { type: 'object', properties: {} } },                 // adopted + identity
    { subagent: 'researcher', description: '…' },                 // another agent
    { mcp: { server: 'docs', tool: 'search' } },                  // an MCP server
  ],
  skills: [{ name: 'refunds', description: '…', content: '…' }],  // loaded on demand
  provider: piAiProvider(),                  // an impl, or an Agent.provider name; omit for pi-ai
  pricing: { input: 3, output: 15 },         // $/Mtok — FALLBACK when the provider reports no cost
  budget: { turns: 20, toolCalls: 40,        // sends refused at N+1 / tool calls per session
            spend: '$1.00',                  // dollars: 1.5 | '1.50' | '$1.50'
            approval: 3600000 },             // ms a gate:'ask' may sit unanswered
  maxIterations: 10,                         // model calls per turn
  context: { window: 200000, compactAt: 0.8, keep: 6 },   // omit the block to disable
  retry: { attempts: 3, baseMs: 500, maxDelayMs: 10000 }, // full-jitter backoff
  maxResultChars: 8000,                      // tool results truncated past this
  maxToolArgBytes: 262144,                   // per-turn tool_args delta ceiling
  canUse: (tool, { userId, sessionId }) => true,   // agent-level tool backstop
  approve: ({ userId }) => userId !== null,        // who may answer an ask-gate
  startable: true,                                 // false closes start/fork/send
});
```

That is every key `AgentConfig` has. Two things people look for and will not find: **hooks**, which
are registered rather than configured (`Support.hook(...)` for this agent, `Agent.hook(...)`
process-wide, globals first), and **gates**, which belong to an individual tool spec — `canUse` and
`approve` are the agent-level backstops.

`instructions` takes three shapes. An array is joined with a blank line; a function is called **per
turn** with the session owner's id — `null` for an anonymous capability-URL session, and `null` by
default for `ask()`:

```ts
// server
instructions: 'You are a concise assistant.',
instructions: ['You are a concise assistant.', 'Never guess an order number.'],
instructions: ({ userId }) => `You help user ${userId}.`,
```

With `skills`, a `## Skills` listing of names and descriptions plus one loader sentence is appended to
whichever shape you used; a skill's `content` is never in the prompt. See
[the README's Skills section](../app/packages/agent/README.md#skills).

**Config errors are startup errors.** Limits are parsed at `define()` time, so a typo throws where you
can see it rather than in a session that has already overspent:

```ts
// server
new Agent('support', { model: 'anthropic/claude-sonnet-5', instructions: '…',
                       budget: { spend: '1.50 USD' } });
// Error: [10thfloor:agent] budget.spend must be dollars — a number like 1.5 or a
//        string like "$1.50"; got "1.50 USD"
```

A string `turns: '20'` fails the same way (`must be a positive integer; got "20"`) because it would reach a
Mongo `$lt` filter where BSON type ordering makes a number never less-than a string — every send
refused, in production, for no visible reason. `context.*`, `retry.*`, `maxResultChars` and `skills` are
checked before registration too, so a bad config leaves no half-usable agent behind. Unless the
deployment configured a `rateLimit.sends`, every agent whose `budget` sets none of `turns`, `toolCalls`
or `spend` is named in one startup warning: nothing bounds its spend.

### The model string

The default provider reads `model` as `<pi-ai provider>/<model id>`, split on the **first** slash only:

```ts
// server
model: 'anthropic/claude-sonnet-5'
model: 'openai/gpt-5'
model: 'openrouter/moonshotai/kimi-k2'      // the nested id survives the split
```

A malformed string is a configuration error, not a transient one, so it is never retried: the turn
fails fatally, writing a `kind: 'error'` note and setting `phase: 'error'`.

```
[10thfloor:agent] model must be "<provider>/<model-id>" for the pi-ai provider
(e.g. "anthropic/claude-sonnet-5"); got "claude-sonnet-5"
```

A custom provider may give the string its own meaning — the test fixtures use `'mock'`, the demo app
uses `'demo/scripted'`. The value is copied onto the session document at start, and a fork copies the
source's rather than the registry's, so `session.model` records the model string a conversation was
opened with.

### Swapping providers

A `Provider` is one method — `stream(req)` returning an async iterable of chunks.

**Omit it** and the turn streams through pi-ai: Anthropic, OpenAI, Google, Bedrock, OpenRouter and the
rest of its catalog. pi-ai is imported lazily, on the first turn that actually streams. For a
single-key deployment, `PROVIDER_API_KEY` is passed to pi-ai explicitly for whichever Provider the
model string selects. For a multi-Provider deployment, leave that generic override unset and use
pi-ai's provider-specific environment variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`OPENAI_API_KEY`, …), so each Adapter resolves its own credential.

**Name `piAiProvider()`** when you want to wrap it — a lazy singleton, so calling it costs nothing until
a turn runs, and a wrapper is just an object that forwards the same one method:

```ts
// server
import { piAiProvider, type Provider } from 'meteor/10thfloor:agent';

const logged = (inner: Provider): Provider => ({
  async *stream(req) { console.log('[llm]', req.model); yield* inner.stream(req); },
});
Support.define({ model: 'anthropic/claude-sonnet-5', instructions: '…',
                 provider: logged(piAiProvider()) });
```

**Register a name.** `Agent.provider` is static and process-global, like `Agent.method` and
`Agent.hook`, so a config can name a server-only implementation without importing it, and a deployment
can swap backends behind one registration:

```ts
// server
import { Agent, mockProvider } from 'meteor/10thfloor:agent';

Agent.provider('canned', mockProvider(() => ({ text: 'hi' })));
Support.define({ model: 'mock', instructions: '…', provider: 'canned' });
```

Names resolve on the first **turn**, not at `define()`, because agents and providers register in
whatever order their server files load. An unknown name throws when a turn needs it rather than falling
back to pi-ai, which would bill a real provider for a config that asked for a mock. Re-registering
overwrites with one warning — that case is a dev hot reload.

```
[10thfloor:agent] Unknown provider "anthropic-eu". Register it with
Agent.provider("anthropic-eu", impl) before a turn runs. Registered: canned
```

**Use `mockProvider` for tests and demos** — no key, no network. The script is a plain function of the
request, so it branches on the transcript so far:

```ts
// server
new Agent('itest-gate', {
  model: 'mock',
  instructions: 'You are a test agent.',
  tools: [{ name: 'refund', description: 'Refund an order.', gate: 'ask',
            args: { type: 'object', properties: {} },
            run: async () => ({ refunded: true, amount: 42 }) }],
  // Branch on the HISTORY, not a call counter: a script that always returned the
  // tool call would loop until the turn budget stopped it.
  provider: mockProvider((req) => (req.messages.some((m) => m.role === 'tool')
    ? { text: 'all done' }
    : { toolCalls: [{ id: 'gate-1', name: 'refund', args: { order: 'A-1' } }] })),
});
```

It emits `text` one character per chunk, then a `done` chunk carrying `toolCalls` and `usage`
(defaulting to `{ input: 10, output: text.length }`), and ignores `req.signal` by design — there is no
HTTP request behind a scripted stream to cancel.

**Write your own** for a backend pi-ai does not cover. Any object with a `stream()` method qualifies,
and using one means the pi-ai npm peer is never loaded and never needs installing:

```ts
// server
import type { Provider } from 'meteor/10thfloor:agent';

const echo: Provider = {
  async *stream(req) {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    for (const ch of `you said: ${last?.content ?? ''}`) yield { kind: 'text', chunk: ch };
    yield { kind: 'done', usage: { input: 7, output: 3 } };
  },
};

Support.define({ model: 'echo/v1', instructions: '…', provider: echo });
```

What you are handed and what you must yield are both exported types, so you never retype them:

```ts
// server — import type { Provider, ProviderRequest, ProviderChunk } from 'meteor/10thfloor:agent'
// ProviderRequest = { model, system, signal?,
//   tools:    Array<{ name: string; description: string; parameters: unknown }>,
//   messages: Array<{ role: 'user' | 'assistant' | 'tool'; content?: string;
//               toolCalls?: Array<{ id; name; args }>; toolCallId?; isError? }> }
//
// ProviderChunk — the whole union; anything else is not a legal chunk:
//   { kind: 'text'; chunk: string } | { kind: 'thinking'; chunk: string }
//   { kind: 'tool_args'; chunk: string; contentIndex?: number }
//   { kind: 'done'; toolCalls?: Array<{ id: string; name: string; args: unknown }>;
//                   usage?: { input: number; output: number; cost?: number } }
```

- **`done.toolCalls` is what dispatch reads** — the `tool_args` chunks are display only, partial JSON.
- **`contentIndex` keeps parallel tool calls apart.** Providers interleave them, and a consumer joining
  fragments in arrival order splices one call's JSON into another's. Omit it and everything buckets
  under `0`, correct only for one call at a time.
- **`usage.cost` is dollars you priced yourself**, preferred over `pricing`; with neither, cost is zero.
- **Aborting `signal` must cancel the underlying HTTP request.** Breaking out of the consuming loop only
  stops *reading* — the response keeps arriving and the provider keeps billing it.

`tools[].parameters` is the JSON Schema from each tool spec's `args`; see
[the README's Tools section](../app/packages/agent/README.md#tools).

### A headless one-shot, no UI at all

`ask()` is the whole conversation in one call — no session to start, subscribe to or clean up.
Server-only, because there is nothing on the other end to stream to.

```ts
// server
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Support } from '/imports/agents';

Meteor.methods({
  async 'support.summarize'(orderId) {
    check(orderId, String);
    return Support.ask(`Summarize order ${orderId}.`, { userId: this.userId });
  },
});
```

It creates a throwaway session, runs one turn under the agent's real config — tools, budgets, retries,
compaction — returns the final assistant message, and deletes the session, its messages and its deltas in
a `finally` on every path. `userId` defaults to `null`, the same anonymous owner a capability-URL session
has, and is what `instructions` and every tool's `ctx.userId` see.

It rejects rather than return a half-answer, because a headless caller has no way to notice a stalled one:
`ask-parked` when the turn hit a `gate: 'ask'` tool and nobody is there to approve it, `ask-failed` when
the provider failed terminally, a budget stopped the run, or the turn produced no assistant message at all
(`e.reason` names which), and `no-agent` for a name never `define()`d. Keep ask-gated tools on interactive
agents; for agent *composition* prefer a `{ subagent }` tool spec over calling `ask` from a tool body,
since that keeps the child session and can still be approved.

### Which provider when

- **Omit `provider`** for anything talking to a real model — one env var, one model string, and
  provider-reported cost lands in `usage.cost` for free.
- **`piAiProvider()` explicitly** only to wrap it: pacing, logging, your own retry.
- **`mockProvider(script)`** for tests and for a demo that must run with no key.
- **`Agent.provider('name', impl)`** when the choice is a *deployment* decision rather than an agent
  one, or a shared config must not import server-only code.
- **Your own `stream()`** for a backend pi-ai does not cover, an internal gateway, or a fixture that has
  to misbehave on purpose. Honor `signal` and interrupts, retries and budgets all keep working.

## Streaming, and the UI you get for free

Nothing here streams over a side channel. A turn writes short-lived **delta documents** into a
capped Mongo collection, one publication ships them beside the committed transcript, and
`mergeView` folds the two into one ordered array that `Agent` mirrors into a client-only cursor.
Everything downstream — the plain-DOM renderer below, `<agent-chat>`, whatever you write instead —
reads that cursor.

### How a token reaches the browser

```
provider chunk ─▶ DeltaWriter.push (coalesce) ──60ms──▶ agent_deltas (capped, 32 MiB)
  AgentMessages ◀── commit, only when a stream ends            │
            └──────────▶ agent.session publication ◀───────────┘
                                    │
                                 minimongo ─▶ mergeView ─▶ Agent.messages(id)
```

Collection and publication names are stable and exported from both indexes as `NAMES`:
`agent_sessions`, `agent_messages`, `agent_deltas`, `agent.session`, `agent.sessions`. Each
streamed chunk becomes one `AgentDelta` row:

```ts
// server — a document in agent_deltas, written by server/deltas.ts
{ _id, sessionId, messageId, msgSeq: 12, seq: 3, kind: 'text', chunk: 'Hello, ', at: new Date() }
```

`msgSeq` is the seq the assistant message is *expected* to commit at, so an in-flight row sorts into
position before that message exists; `seq` numbers the runs within one message; `contentIndex` rides
`kind: 'tool_args'` only. The kinds written are `text`, `thinking` and `tool_args` — `DeltaKind`
also declares `tool_output`, which nothing in the package writes.

**What is O(chunk).** `DeltaWriter.push` coalesces consecutive same-kind chunks into one buffered
run and flushes on a 60 ms interval, so a run of tokens costs **one document and one Mongo round
trip**, not one per token, and the wire carries the new fragment rather than the message so far —
re-publishing the growing string would be O(n²) bytes over a response. `tool_args` is the one kind
that does not coalesce: `contentIndex` is part of the coalescing key, because parallel tool calls
arrive interleaved and merging two calls' fragments splices one call's JSON into the other's,
permanently. Hence the per-turn ceiling on argument streaming, `maxToolArgBytes`, in
[the README's Operations section](../app/packages/agent/README.md#operations).

Deltas are disposed of on every path that could strand them: the commit
(`AgentDeltas.removeAsync({ messageId })`, right after the assistant row lands), an interrupt, a
failed provider attempt, an abandoned turn (`discardTurn`, when the lease is lost at commit time),
repair-on-entry sweeping deltas whose `messageId` was never committed, and FIFO eviction from the
cap itself. The committed message is built from the loop's in-memory text, never from deltas, so a
lost tail flush costs nothing durable. `ensureCapped()` creates the collection at startup and throws
if `agent_deltas` already exists *uncapped*, telling an operator to drop it — nothing is converted
automatically.

**The publication keeps authorization live.** `agent.session` takes `(agent, sessionId)` and first
attaches an observer to the matching Session authorization row. Owners and human participants may
subscribe; an anonymous caller is authorized only while the Session remains anonymous. Claiming a
Session, removing a participant, changing its owner, starting erasure, or deleting it stops the
subscription and retracts every document it published. Only after that observer is attached does
the publication return the Session (`lease`, operations, and wake tokens stripped), its messages
sorted by `seq`, and its deltas. Messages and deltas carry no owner field, so they must remain behind
this Session-scoped authorization. An unauthorized subscription quietly becomes ready with no data.

### `mergeView` — one ordered view out of two collections

```ts
// client (or server — it is pure, in common/merge.ts)
import { mergeView } from 'meteor/10thfloor:agent';
mergeView(committedMessages, deltaDocs);   // → ViewMessage[], sorted by seq
```

Four rules, each asserted in `tests/merge.test.ts`:

- **A commit always wins.** Deltas whose `messageId` is already committed are dropped, so the
  streaming row vanishes the moment the real message lands.
- **It walks back from the highest `seq`**, stopping at the first gap. A capped collection evicts
  the *oldest* document, so a gap is always a missing head, and walking forward from 0 would render
  an empty string for any message whose start aged out. The row carries `truncatedHead: true`; a
  renderer prefixes an ellipsis instead of passing a fragment off as the whole message.
- **Order comes from the data**, not from arrival — shuffled and duplicated delivery merge alike.
- **`tool_args` accumulates per `contentIndex`**, so two calls streaming at once stay two parseable
  strings:

```js
// client
const arg = (seq, chunk, contentIndex) => ({
  _id: `d${seq}`, sessionId: 's1', messageId: 'm1', msgSeq: 10, seq,
  kind: 'tool_args', chunk, contentIndex, at: new Date(),
});
mergeView([], [arg(0, '{"city":', 0), arg(1, '{"stock":', 1), arg(2, '"Paris"}', 0)]);
// → [{ …, streaming: true, toolArgs: { 0: '{"city":"Paris"}', 1: '{"stock":' } }]
```

Those values are **partial JSON** — parse them tolerantly or ignore the field; a provider that
reports no index buckets under `0`. Once the message commits, the real `toolCalls` array supersedes
them with parsed `args`, and `toolArgs` is never the source of truth for dispatch.
`Agent.messages()` runs `mergeView` for you — call it directly only when writing your own store.

### The client `Agent`

```ts
// client
import { Agent } from 'meteor/10thfloor:agent';

const Support = new Agent('support');            // the server-side registry name
const sessionId = await Support.start({ title: 'orders' });
const handle = Support.subscribe(sessionId);     // agent.session + the merge autorun
await Support.send(sessionId, 'where is my order?');

Support.messages(sessionId).fetch();  // ViewMessage[], seq ascending, in-flight rows included
Support.status(sessionId);            // 'idle' | 'streaming' | 'calling' | 'awaiting' | …
Support.usage(sessionId);             // { input, output, cost }
await Support.interrupt(sessionId);   // phase 'stopped' — and the HTTP request is aborted
```

An in-flight row is `{ streaming: true }` and may carry `truncatedHead`, `deltaCount` and
`toolArgs`; a committed row is `{ streaming: false }`. That is the whole distinction a renderer
needs. **One instance renders one session:** `subscribe()` stops the previous subscription, replaces
the merge computation, and evicts the old session's rows — construct a second `Agent` to watch two.
**Tear down on unmount** (`useEffect(() => () => Support.stop(sessionId), [sessionId])`), since a
`Meteor.subscribe` and a `Tracker.autorun` started outside a parent computation both live until
stopped. `stop()` is idempotent — React 18 StrictMode double-fires unmounts — and its `sessionId`
argument is a **guard, not a selector**: pass it and teardown is skipped once the instance has
re-subscribed to a newer session.

### A chat UI in plain DOM, no framework

`messages()` is a real minimongo cursor, so one autorun re-rendering from `.fetch()` is the entire
data layer. This is the demo app's pre-element renderer, lightly condensed — what `<agent-chat>`
packages, and readable in full at `git show ad0dc0b:app/client/main.js`:

```html
<!-- client -->
<div id="phase">idle</div><div id="messages"></div>
<div id="approval" hidden><span id="approval-text"></span>
  <button id="approve">Approve</button><button id="deny">Deny</button></div>
<form id="composer"><input id="input" autocomplete="off"><button>Send</button></form>
<button id="stop">Stop</button>
```

```js
// client
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Agent } from 'meteor/10thfloor:agent';

const Demo = new Agent('demo');
const el = (id) => document.getElementById(id);

// textContent everywhere: a transcript is model- and user-shaped text nobody in this
// stack escaped, so one `innerHTML =` here is an XSS sink wearing a chat bubble.
function renderMessage(m) {
  const row = document.createElement('div');
  row.className = `msg ${m.role}${m.streaming ? ' streaming' : ''}`;
  if (m.role === 'note') {
    // Notes are STRUCTURED rows, never prose — the UI writes the sentence.
    // `timedOut` is checked BEFORE `approved`: the watcher's timeout writes
    // `approved: false`, and "Denied" would say a person refused when in fact
    // nobody answered at all.
    row.textContent = m.kind === 'compaction' ? '· earlier conversation compacted ·'
      : m.kind === 'approval'
        ? `${m.timedOut ? 'Timed out' : m.approved ? 'Approved' : 'Denied'}`
          + `${m.reason ? ` — ${m.reason}` : ''}`
      : m.error?.reason ?? m.kind;
  } else if (m.role === 'tool') {
    row.textContent = `⚙ ${m.content}`;
  } else {
    // `truncatedHead`: this row's start aged out of the capped collection.
    row.textContent = (m.truncatedHead ? '…' : '') + (m.content ?? '')
      + (m.toolCalls ?? []).map((c) => ` → ${c.name}(${JSON.stringify(c.args)})`).join('');
  }
  return row;
}

Meteor.startup(async () => {
  const sessionId = await Demo.start({ title: 'demo chat' });
  Demo.subscribe(sessionId);

  Tracker.autorun(() => {
    const box = el('messages');
    box.replaceChildren(...Demo.messages(sessionId).fetch().map(renderMessage));
    box.scrollTop = box.scrollHeight;
    el('phase').textContent = Demo.status(sessionId);

    const ask = Demo.pending(sessionId);            // the parked tool call, if any
    el('approval').hidden = !ask || !!ask.verdict;
    if (ask && !ask.verdict) el('approval-text').textContent =
      `The agent wants to run ${ask.name}(${JSON.stringify(ask.args)})`;
  });

  el('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el('input').value.trim();
    if (!text) return;
    el('input').value = '';
    await Demo.send(sessionId, text);
  });
  el('stop').addEventListener('click', () => Demo.interrupt(sessionId));
  el('approve').addEventListener('click', () => Demo.approve(sessionId));
  el('deny').addEventListener('click', () => Demo.deny(sessionId, 'denied from the demo UI'));
});
```

### `<agent-chat>`

Those seventy lines ship as a custom element, which **never registers itself**: a package calling
`customElements.define` at import time would squat the name in every app depending on it, and a
second definition of a name is a hard `DOMException`. `defineAgentChat` returns the constructor, is
a no-op for a tag already in the registry, and builds a fresh class for a different name —
`customElements.define` refuses one constructor for two names.

```ts
// client
import { defineAgentChat } from 'meteor/10thfloor:agent';
defineAgentChat();                 // <agent-chat>
defineAgentChat('support-chat');   // …or under your own name
```

```html
<!-- client -->
<agent-chat agent="support" placeholder="Ask about your order…">
  <h1 slot="header">Support</h1>
</agent-chat>
```

| Attribute | Meaning |
| --- | --- |
| `agent` | **Required.** The registry name a server-side `new Agent(name).define(…)` registered. Missing it renders the error note ``<agent-chat> needs an `agent` attribute naming a registered agent``. |
| `session-id` | The session to render. **Omit it and the element calls `start()` on connect.** Changing it re-subscribes cleanly. |
| `placeholder` | Composer hint; default `Message the agent…`. Applied without a re-attach. |

Re-pointing usually takes two attribute writes and attributes arrive one at a time, so the teardown
is synchronous but the **re-attach is coalesced into one microtask**: a run of synchronous writes
attaches exactly once, against the attributes as they finally stand, and the intermediate state
never gets far enough to auto-start a session nothing will render. Two properties round it out —
`el.sessionId` (null until an auto-start resolves) and `el.agentInstance` (the client `Agent`, null
while detached). Both events are `CustomEvent` with `bubbles: true, composed: true`, so they cross
the shadow boundary and you can listen on an ancestor:

| Event | `detail` | Emitted when |
| --- | --- | --- |
| `agent-chat:session` | `{ sessionId: string }` | **only** when the element started the session itself (no `session-id` attribute) |
| `agent-chat:error` | `{ error: unknown; message: string }` | every rejection it surfaces from `start` / `send` / `interrupt` / `approve` / `deny`, plus its own two local errors (no `agent` attribute; a submit before the session exists) |

The demo app uses one of each, and the comments are why:

```js
// client — app/client/main.js
const SESSION_KEY = 'agent-demo-session';

Meteor.startup(() => {
  const chat = document.querySelector('agent-chat');

  // BEFORE defining the tag: registration upgrades the element immediately, and an
  // upgrade with no session-id opens a fresh session.
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) chat.setAttribute('session-id', saved);

  // Emitted only when the element opened the session — exactly when the host has
  // an id it never chose and must remember.
  chat.addEventListener('agent-chat:session', (e) => {
    localStorage.setItem(SESSION_KEY, e.detail.sessionId);
  });

  // Self-healing across a wiped database, but ONLY on `no-session`: branch on the
  // Meteor.Error CODE, because forgetting the id on every rejection throws away a
  // live conversation the moment a rate limit hits.
  chat.addEventListener('agent-chat:error', (e) => {
    if (e.detail?.error?.error !== 'no-session') return;
    localStorage.removeItem(SESSION_KEY);
  });

  defineAgentChat();
});
```

`detail.error` is the raw rejection. The same text also renders as an error note row, and a failed
send is put back in the composer, so a user sees the failure whether or not you listen.

#### Slots and theming

There is exactly one slot, `header`, for your own title — no default slot — and slotted content
stays in the light DOM, keeping your page's CSS. The element carries its styles in a shadow root,
so restyle it through the two public seams, never by piercing. The custom properties are
`--agent-chat-accent` (`#2b7de9`), `--agent-chat-bg` (`Canvas`), `--agent-chat-fg` (`CanvasText`),
`--agent-chat-warn` (`#d97706`), `--agent-chat-danger` (`#dc2626`), `--agent-chat-radius`
(`0.75rem`) and `--agent-chat-font` (`system-ui, sans-serif`); the parts are `root`, `header`,
`phase`, `messages`, `message`, `tool-name`, `tool-content`, `tool-calls`, `approval`,
`approval-text`, `composer`, `input` and `button`. Three carry a **second token**: `phase` carries
the current phase, `message` carries the row's role plus `streaming` on an in-flight row plus a
note's `kind`, and `button` carries `send` / `stop` / `approve` / `deny`.

```css
/* client */
agent-chat {
  --agent-chat-accent: #6d28d9;
  --agent-chat-fg: #1f1235;
  --agent-chat-radius: 0.25rem;
  --agent-chat-font: 'Iowan Old Style', Georgia, serif;
  width: min(680px, 100vw); height: 100vh;
}
agent-chat h1                        { font-size: 1rem; margin: 0; }  /* slotted: your CSS */
agent-chat::part(message user)       { border-radius: 0.25rem 0.25rem 0 0.25rem; }
agent-chat::part(message note error) { font-weight: 600; }
agent-chat::part(phase awaiting)     { text-transform: uppercase; letter-spacing: 0.08em; }
agent-chat::part(tool-content)       { -webkit-line-clamp: none; }   /* unclamp tool output */
```

The defaults are the CSS system colors under `color-scheme: light dark`, so an element you never
theme still follows the OS setting. Full tables:
[the README's Theming section](../app/packages/agent/README.md#theming).

### When to stop using the element

It owns one session and repaints the whole transcript with `replaceChildren` on every delta —
deliberate, free at chat scale, and it buys zero diffing code and zero stale-node bugs. Drop to
`Agent` directly for thousands of rows, a layout it does not have, or two sessions side by side;
`client/element.ts` is ~534 lines including its CSS and is meant to be read as the worked example.
For what it does not do — `fork`, `usage`, a denial carrying a reason you collected from the user —
reach through it rather than forking it:

```js
// client
chat.agentInstance.deny(chat.sessionId, 'the amount is too large');
```

That reason reaches the **model** as the denied tool result, so it is the model's only account of
why the call did not happen.

## Tools: five ways to give a model hands

Every tool spec reaches the same dispatch code, so gates, `canUse`, budget
accounting, result truncation and the transcript row are identical whichever of
the five shapes you list:

- `'orders.lookup'` — a Meteor method you already have;
- `{ name, description, args, run }` — an inline function;
- an `Agent.method` handle — the method and the tool, co-registered;
- `{ mcp: { server, tool } }` — a tool on an MCP server;
- `{ subagent: 'researcher', description }` — another agent.

`args` is a JSON Schema: it is what the model is shown *and* what its arguments
are checked against — see **Validation**.

### 1. Adopt an existing Meteor method

Dispatch goes through `Meteor.callAsync`, so the model's path into your method
is your UI's path.

```ts
// server
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Agent } from 'meteor/10thfloor:agent';

Meteor.methods({
  async 'orders.lookup'(args) {
    check(args, { id: String });        // your own check() still runs
    this.unblock();                     // …and so does this
    return Orders.findOneAsync({ _id: args.id, userId: this.userId });
  },
});

new Agent('support', {
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You help customers with their orders.',
  tools: [{
    method: 'orders.lookup',
    description: 'Look up one of this customer\'s orders by id',
    args: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  }],
});
```

The bare string `'orders.lookup'` works too, with an empty description and
`{ type: 'object', properties: {} }` — the model then learns the tool exists and
nothing about its arguments. List one form or the other: two tools with one name
is a list a provider rejects outright.

The body runs under a real `DDPCommon.MethodInvocation` whose `userId` is the
session's owner, not a stand-in object — a handler calling `this.unblock()`
throws when `this` is a plain object, and `tests/tools.test.ts` pins both halves.
The harness does **not** re-check an adopted tool's arguments: the method's own
`check()`, or the shared schema when `Agent.method` registered it, is the guard.

### 2. Inline functions

No method, no DDP endpoint: a function the loop calls in-process. `run(args,
ctx)` gets a `ToolContext` — `{ userId, sessionId, toolCallId? }`, plus
`callerUserId` when `runAs` replaced the identity.

```ts
// server
tools: [
  { name: 'clock',                                   // the demo app's, verbatim
    description: 'The current server time',
    args: { type: 'object', properties: {} },
    run: async () => new Date().toISOString() },
  { name: 'refund',
    description: 'Refund an order',
    args: {
      type: 'object',
      properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
      required: ['orderId', 'amount'],
    },
    run: async ({ orderId, amount }, ctx) => Refunds.issueAsync(orderId, amount, ctx.userId) },
]
```

A `Meteor.Error` thrown from `run` becomes a structured `{ error, reason }` the
model reads; any other throw becomes
`{ error: 'tool-failed', reason: 'The tool failed to run.' }`, because message
and stack must never reach a published transcript.

### 3. Co-registered method + tool

`Agent.method` registers a real `Meteor.method` *and* returns a tool spec, from
one definition and one schema.

```ts
// server
export const lookup = Agent.method('orders.lookup', {
  description: 'Look up an order by id',
  args: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  run(args) {
    this.unblock();
    return Orders.findOneAsync({ _id: args.id, userId: this.userId });
  },
});

Support.define({ model, instructions, tools: [lookup] });   // the model calls it
await Meteor.callAsync('orders.lookup', { id });            // your UI calls it
```

`run`'s `this` is the method invocation, exactly as in a hand-written method.
Both callers are validated against that one schema, so there is no second
definition to drift; only the refusal differs — a DDP caller gets
`Meteor.Error('invalid-args', reason)`, the model gets an `invalid-args` tool
result. Registration is global and permanent, so a second call for one name
throws Meteor's own duplicate-method error.

### 4. MCP servers

```bash
meteor npm install --save @modelcontextprotocol/sdk
```

```ts
// server
import { Agent, mcpSdkResolvable } from 'meteor/10thfloor:agent';

if (!mcpSdkResolvable()) throw new Error('install @modelcontextprotocol/sdk');

Agent.mcpServer('docs', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-everything'],
  env: { DOCS_ROOT: '/srv/docs' },   // merged over a safe PATH/HOME subset
  timeoutMs: 15000,                  // connect + discovery deadline (the default)
  cooldownMs: 30000,                 // re-spawn suppressed this long after a failure
});

Support.define({
  model, instructions,
  tools: [
    { mcp: { server: 'docs', tool: 'search' } },     // one tool, discovered metadata
    { mcp: { server: 'docs' } },                     // every tool it publishes
    { mcp: { server: 'docs', tool: 'search' },       // …or override the wording
      name: 'docs_search', description: 'Search our docs', gate: 'ask' },
  ],
});
```

Nothing spawns at registration: the first turn that needs a server connects over
stdio, runs `tools/list` once, and caches both for the process.
`mcpSdkResolvable()` is a synchronous on-disk probe — the SDK is reachable only
through its `exports` map, which Meteor's resolver cannot follow, so the package
goes through the same loader seam pi-ai does, and a host that wants to fail its
own boot on a missing peer dependency has no other way to ask. A whole-server
spec refuses `name` and `args` (one of each cannot describe many tools); both
forms refuse `runAs`. A down server never fails a turn: a named tool stays listed
and answers `mcp-unavailable`, which the model routes around. Depth in
[the README's MCP section](../app/packages/agent/README.md#mcp-servers).

### 5. Another agent

```ts
// server
new Agent('researcher', {
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You look things up and answer in one paragraph.',
  tools: ['docs.search'],
  startable: false,             // reachable only as a subagent / Agent.ask target
});

Writer.define({
  model, instructions,
  tools: [{ subagent: 'researcher', description: 'Ask the researcher to look something up' }],
});
```

The default schema is `SUBAGENT_ARGS` —
`{ type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }` —
and `args.prompt` becomes the child's first user message. The call runs a real
child session with its own transcript, budgets and live stream; the depth guard,
the three structured failures (`subagent-parked`, `subagent-failed`,
`subagent-depth`) and the lineage fields are the
[Subagents](../app/packages/agent/README.md#subagents) topic.

### `runAs` — a tool with a fixed identity

A tool normally runs as the session's owner. `runAs` replaces that for **one
listing of one tool**, on inline and adopted specs only.

```ts
// server
tools: [
  { method: 'billing.credit', description, args, runAs: 'service-account' },
  { name: 'rates', description, args, run, runAs: null },   // anonymous
]
```

`null` is not "unset" — it is the anonymous service context (`this.userId ===
null`); omitting `runAs` is what inherits the session's user. This is privilege
escalation by construction and it is per-listing: every session of every agent
that lists the spec gets the same fixed identity, anonymous capability-URL
sessions included. Authorization does not move with it — `canUse`, the gate and
the ownership check all run against the session's real owner, before dispatch —
so `runAs` widens what a tool may do, never who may invoke it. The real owner
arrives as `ctx.callerUserId`:

```ts
// server
{ name: 'credit', description, args, runAs: 'service-account',
  async run(args, ctx) {
    if (!ctx.callerUserId) throw new Meteor.Error('not-allowed', 'sign in first');
    return Billing.creditAsync(ctx.callerUserId, args.amount);
  } }
```

### Gates — a predicate over the arguments and the caller

```ts
// server
gate: 'auto'                                   // the default: just run it
gate: 'ask'                                    // park the turn for a human
gate: ({ userId, sessionId, name, args }) =>   // …or decide per call
  (args.amount < 50 ? true : 'ask')            // sync or async
```

`true` runs it, `'ask'` parks exactly as the literal, and `false` is a tool
**result**, not a park: the model reads the refusal, routes around it, and the
rest of the batch still runs. No human is troubled and no `toolCalls` budget is
spent, because nothing was dispatched. What the model receives is

```json
{"error":"denied-by-gate","reason":"The \"refund\" tool refused this call."}
```

`ctx.userId` is the **caller's** — the session's owner. `runAs` is deliberately
not consulted: letting it answer the gate's question would be the escalation
approving itself. A predicate that throws, or returns anything else, fails
closed to that same denied result with one warning per failure kind; a `gate`
that is neither a literal nor a function throws where the tool list is resolved
— once at the top of every turn, before anything is shown to the model — rather
than resolving to a silently ungated tool (the suite walks `'Ask'`, `'auto '`,
`true`, `0`, `null` and `{}`, and requires every one to be refused).

`canUse(tool, ctx)` is the agent-wide backstop: checked before dispatch *and*
before parking (a forbidden tool never asks a human), re-checked when an approval
resumes, and refusing with
`{"error":"not-allowed","reason":"This agent may not use refund."}`.

## Validation

Model-supplied arguments are checked against the **whole** JSON Schema before an
inline or MCP tool runs: `enum`, `const`, numeric and length bounds, `pattern`,
`format`, `minItems`, `oneOf`/`anyOf`, `additionalProperties: false`, internal
`$ref` and nested `properties`/`items` are all enforced, by typebox, loaded
lazily through the loader seam.

### What the model sees when its arguments are rejected

A rejection is a **result**, never a throw — which is what makes the loop recover
instead of dying. The tool never runs, a `role: 'tool'` row is committed carrying
`error`, and the turn continues to its next iteration with that row in the
model's history, flagged `isError` and carrying the error's JSON as content:

```json
{"error":"invalid-args","reason":"missing required field \"amount\""}
```

The model is told which field it got wrong, and usually corrects on the next
call. The reason names the **field** and never echoes its value — it is fed to
the model *and* published in the transcript. Hence the vocabulary: `missing
required field "customer.id"`, `unexpected field "sneak" is not allowed by the
schema`, dotted paths for nested objects, `ids[1]` for array indices. Rejecting
`{ amount: 'SECRET-lots' }` puts no `SECRET` anywhere in the transcript.

### The ladder, and one compile per schema

Highest wins; each rung down warns exactly once, and none of them throws:

1. a validator installed with `setToolArgsValidator` — over everything below;
2. `Compile(schema).Check(args)`, one compile per schema object;
3. the interpreted `Value.Check(schema, args)` — same enforcement, slower;
4. the structural checker for schemas made entirely of `type`, object
   `required`/`properties`, and array `items`; richer schemas are refused.

Rung 2 is cached weakly on the schema object's identity, so a registered tool
compiles once per process and a rediscovered MCP schema does not pin its
predecessors. Cache hits and misses deliberately return the same public result:

```ts
// server
import { validateToolArgs } from 'meteor/10thfloor:agent';

const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
await validateToolArgs(schema, { q: 'x' });   // { ok: true }
await validateToolArgs(schema, { q: 'y' });   // { ok: true }, cached checker reused
```

Dropping from 2 to 3 costs speed only. At rung 4, a schema is accepted only when
the structural checker can enforce all of it; otherwise the tool call is
refused. `fullValidationAvailable()` reports whether a full checker is active.
`setToolArgsValidator(fn)` installs your own checker and returns a restore
function — call it *before* registering tools. Passing `null` deliberately
disables validation and is unsafe for untrusted model or DDP input.

Discovered MCP schemas are the one exception to "the whole schema": `pattern`,
`format` and `patternProperties` are stripped from a third-party `inputSchema`
before it becomes a tool's `args`, because those keywords compile
attacker-influenced regexes onto a single-threaded event loop. A property
literally *named* `format` survives — only the keyword position is stripped. An
`args` you wrote yourself is app-authored and keeps all three.

### Fail-closed validation

No tool call is allowed merely because the active checker cannot understand its
schema. `Agent.method` also refuses at registration when no full validator is
available and the schema leans on a keyword the structural checker ignores:

```ts
// server — throws at startup if neither typebox nor an installed validator is reachable
Agent.method('orders.refund', {
  description: 'Refund an order',
  args: { type: 'object', required: ['reason'],
    properties: { reason: { type: 'string', enum: ['damaged', 'late'] } } },
  run(args) { return Refunds.issueAsync(args.reason, this.userId); },
});
```

The error names the method, the offending keyword and the three fixes (install
typebox, install your own validator, simplify the schema), and the method is not
registered at all. The same guard runs at call time: if validation degraded
*after* registration, the handler throws `Meteor.Error('validation-unavailable')`
rather than let a rich keyword go unenforced on a live endpoint.

### The argument-size ceiling

`maxToolArgBytes` — default `DEFAULT_MAX_TOOL_ARG_BYTES`, exported and equal to
`256 * 1024` — is not a validation limit. It caps the bytes of `tool_args` deltas
one turn may publish while the model streams a call, which is display-stream
hygiene: `agent_deltas` is capped and shared by every session on the deployment,
so one model looping on a giant argument blob can evict every other session's
in-flight tokens. Past the ceiling a turn stops publishing partial-argument
deltas and warns once. `text` and `thinking` deltas are unaffected, and the
committed message's real `toolCalls` — the arguments dispatch actually runs on —
never travel through the delta stream at all, so a clamped turn calls exactly the
tools it was going to call with exactly the arguments it was going to use. The
only visible effect is a client's `toolArgs` preview no longer growing.

## Approval gates

A tool marked `gate: 'ask'` does not run when the model asks for it. The turn
**parks**: the assistant row carrying the `tool_use` commits, a `pending` marker
lands on the session, the phase goes to `awaiting`, the lease is released — and
the run *exits*. No process is blocked, no timer is set, no promise is held.

```ts
// server
import { Agent } from 'meteor/10thfloor:agent';

new Agent('support', {
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You help customers with their orders.',
  tools: [
    'orders.lookup',                       // an existing Meteor method, ungated
    {
      name: 'refund',
      description: 'Refund an order (requires human approval)',
      args: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      gate: 'ask',
      run: async ({ orderId }) => `Refunded ${orderId}`,
    },
  ],
  budget: { turns: 50, toolCalls: 20, approval: 10 * 60 * 1000 },
});
```

The parked state is three durable facts and nothing else:

```js
// server — the session document after the park
{
  phase: 'awaiting',
  pending: { toolCallId: 'refund-1', name: 'refund', args: { orderId: 'A-1001' },
             requestedAt: new Date() },
  // no `lease`: the turn released it on the way out
}
```

That is why a park survives a deploy: nothing in memory encodes it, so a restart
has nothing to lose. An approval arriving four hours and two releases later
starts a *fresh* `runTurn` off those same fields, and repair-on-entry reads the
deliberately-unanswered `tool_use` as a request rather than an abandoned turn.

### Answering it from the client

```ts
// client
const ask = Support.pending(sessionId);      // reactive; undefined when nothing is parked
if (ask) {
  console.log(ask.name, ask.args);           // 'refund', { orderId: 'A-1001' }
  await Support.approve(sessionId);
}

// …or refuse. `reason` is the model's ONLY account of why — write it for the model.
await Support.deny(sessionId, 'the amount is over your limit');
```

Test `runAs` with `'runAs' in ask`, never for truthiness: `null` is the anonymous
service context, an absent key means the tool runs as the session's owner. Both
calls reject `Meteor.Error('no-session')` for anyone who is not the session's
owner — another user, or an anonymous caller of a session that has one (an
anonymous capability-URL session answers its own approvals) — and `not-allowed`
when the agent's `approve` predicate refuses, which leaves the run parked and
writes no note, because a refused verdict is not history:

```ts
// server — `Approvers` is your own collection; the predicate is an app-level check
new Agent('support').define({
  model, instructions, tools,
  approve: async ({ userId }) => !!userId && !!(await Approvers.findOneAsync({ userId })),
});
```

### The audit rows

Every verdict commits one `role: 'note', kind: 'approval'` row. Structured
fields, never prose — a UI writes its own sentence:

```js
// server — three shapes, in AgentMessages
{ role: 'note', kind: 'approval', approved: true,  by: 'u1',  runAs: 'service-account' }
{ role: 'note', kind: 'approval', approved: false, by: 'u1',  reason: 'the amount is over your limit' }
{ role: 'note', kind: 'approval', approved: false, by: null,  reason: 'approval timed out', timedOut: true }
```

`timedOut` is absent — not `false` — on a human verdict, so a UI can tell "someone
said no" from "nobody answered" off the row alone. `runAs` appears only when the
approved tool had one, so the audit says *what* was authorized.

A denial is **answered**, not dropped: alongside the note, the parked call gets a
real tool row the model reads and routes around, and the turn continues to a
reply.

```js
// server
{ role: 'tool', toolCallId: 'refund-1',
  error: { error: 'denied', reason: 'the amount is over your limit' } }
```

### A request nobody answers

`budget.approval` is milliseconds, enforced by the **watcher's sweep** — every
15s, unless `startWatcher`'s `sweepMs` says otherwise — rather than by the loop:
a park runs no timer, so nothing in-turn is left to enforce it. Past the deadline
the sweep records the third note above and the turn resumes and finishes. Omit it and a parked request waits forever: the right default when
a person is expected to see it, the wrong one for an unattended run.

### Two people click Approve

The verdict write is conditional on `phase: 'awaiting'` with no verdict yet,
matched atomically, so the write breaks the tie rather than a pre-check:

```ts
// client — exactly one fulfils; the loser rejects Meteor.Error('no-pending')
await Promise.allSettled([Support.approve(sessionId), Support.approve(sessionId)]);
```

One verdict, one note, one execution of the tool. The same single-winner write
serves the watcher's timeout, so two app servers sweeping one request also
produce one denial.

Two more rules to design around. Approving one call of a batch says nothing about
the next: a mixed batch runs its auto-gated remainder, an all-gated batch **parks
again** on the following gate. And `canUse` is re-checked on the resume, so an
entitlement revoked while the request sat in someone's inbox stops the
already-approved call with a `not-allowed` result.

## Subagents

A `{ subagent }` spec puts one agent behind another's tool call.

```ts
// server
new Agent('researcher', {
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You look things up and answer in one paragraph.',
  budget: { toolCalls: 8, spend: '$0.25' },
  startable: false,          // reachable only as a subagent / Agent.ask target
});

new Agent('writer', {
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You draft answers, delegating research when you need a fact.',
  tools: [{ subagent: 'researcher', description: 'Ask the researcher to look something up' }],
  budget: { toolCalls: 5 },
});
```

The tool is named for the agent unless you pass `name`; its default schema is one
string (`SUBAGENT_ARGS`) whose `args.prompt` becomes the child's first user
message. `gate: 'ask'` works here like anywhere else, gating the *opening* of the
child session.

### The child is a real session

It streams while it runs, and persists after the call with its lineage intact:

```js
// server — after one delegation
// the parent's tool row
{ role: 'tool', toolCallId: 'call-1', content: '"Ottawa"', childSessionId: 'aB3…' }
// the child session document
{ agent: 'researcher', userId: 'u1', phase: 'idle', depth: 1,
  parent: { sessionId: 's-writer', toolCallId: 'call-1' } }
```

`childSessionId` is the durable handle. The **live** one is `activeChild` on the
parent, present for exactly as long as the dispatch is in flight:

```ts
// client
const active = Writer.session(sessionId)?.activeChild;
if (active) new Agent('researcher').subscribe(active.sessionId);   // the CHILD's agent name
```

Nothing in the client API is special-cased for a child: `agent.session`
authorizes by `userId` and the child inherits the parent's owner, so exactly the
people who can read the parent can read the child. `agent.sessions` excludes
children, so one turn's internal work never tops a conversation list.

### Budgets compose, they do not merge

The parent spends exactly one `budgetSpent.toolCalls` per subagent call — generic
dispatch accounting — while everything the child spends accrues to the child's
document under the child agent's config. A child whose own `budget.toolCalls`
trips commits a `kind: 'budget'` note in its *own* transcript, and the parent
still gets a tool result. So bound a subagent-heavy parent from two directions:
the parent's `toolCalls` caps how many consultations happen, each child agent's
`spend` caps what one may cost.

### The depth guard

`MAX_SUBAGENT_DEPTH` is `3`. A root session is depth 0, its subagent 1; the
fourth hop is refused before any document is written, as a tool result the model
can route around:

```js
// server
{ error: 'subagent-depth',
  reason: 'Subagents may nest 3 deep; calling "researcher" here would be level 4. '
        + 'Do this work yourself, or answer without it.' }
```

It bounds nesting, not fan-out — which is why `budget.toolCalls` on every agent
in a subagent graph is effectively required. A name nothing registered is refused
the same way — an `unknown-agent` result, no child. The two remaining outcomes
(`subagent-parked`, `subagent-failed`), and which of them leaves a child behind,
are tabulated in [the README's Subagents
section](../app/packages/agent/README.md#subagents).

The gate and subagent topics meet at `subagent-parked`: a child that hits its own
`gate: 'ask'` answers the parent immediately (the parent's turn must not wait on
a human it cannot reach) while the **child** stays `awaiting`. Its session is
real, so a person answers it through the ordinary `approve`/`deny` path using the
*child's* agent name and session id, and the child finishes on its own. Note that
the child agent's `budget.approval` applies, so an unattended parked child can
deny itself on that clock.

### Recovery, and Stop

A parent turn abandoned mid-batch (stolen lease, dead process) recovers by
discarding its assistant row and running again — dispatching the same subagent
call twice. A lookup that runs *before* any child is created finds the earlier one
by `(parent session, tool call id, agent, prompt)` and answers from it: a finished
child's answer is reused with no new model call, a parked child is reported with
the session id a human can already approve. It matches only an *unclaimed* child
— no tool row in the parent transcript names it — which is what a discard leaves.

`agent.interrupt` walks the `activeChild` chain and stops every descendant that
is currently *running* — Stop has to stop the work the user can see. The child
commits no assistant row, and the parent's call is still answered, because an
answered batch is what keeps the transcript resumable:

```js
// server
{ role: 'tool', toolCallId: 'ic1', childSessionId: '…',
  error: { error: 'subagent-failed',
           reason: 'The subagent "researcher" did not answer: The turn was interrupted.' } }
```

A **parked** descendant is deliberately untouched: it is a question in front of a
human, the parent already gave up on it with `subagent-parked`, and stopping it
would strand a request nobody could answer.

## Forking

A fork copies a session's transcript up to a point and hands you a new session
that continues from there. The original is untouched.

```ts
// client
const branch = await Support.fork(sessionId);                    // the whole conversation
const earlier = await Support.fork(sessionId, { atSeq: 12, title: 'What if we refunded' });
Support.subscribe(branch);
await Support.send(branch, 'try it the other way instead');
```

```ts
// server — the same call, plus a userId that scopes the lookup
const branch = await Support.fork(sessionId, { atSeq, title, userId });
```

### `atSeq` is a request, not a command

It defaults to the last message and is clamped **down** to the nearest batch-safe
cut, so a UI can pass the seq of whatever row the user clicked without knowing
anything about tool batches. "Batch-safe" means the head never ends between an
assistant's `tool_use` and the matching `tool_result`: a transcript holding one
without the other is a 400 from every provider, on every retry, forever, and a
fork born that way has no repair path.

Take one assistant with two parallel calls, both answered — seqs `0 user`,
`1 assistant(t1,t2)`, `2 tool t1`, `3 tool t2`, `4 assistant`. `atSeq: 1` and
`atSeq: 2` both cut mid-batch, so both clamp back to seq 0 and the fork holds
only the user message; `atSeq: 3` closes the batch and is taken as given, as is
`atSeq: 4`. This is the identical walk compaction uses, so "a legal place to
divide a transcript" has one definition in the package rather than two.

The same rule decides what happens to a session **awaiting an approval**: the
parked assistant's call is unanswered by construction, so the cut lands before
it. The fork is `idle`, carries no `pending`, and the source stays parked and
answerable.

### What it copies

| Carried | Not carried |
| --- | --- |
| the transcript up to the cut — new `_id`s, **original seqs**, every other field verbatim | `usage` and `budgetSpent` — zeroed; a fork costs nothing until it runs |
| compaction notes at or before the cut, so the model view stays compacted | `pending` — see above |
| the agent, the owner, and the model the source was running | `phase` and `lease` — a fork is idle and owned by no server |
| `forkedFrom: { sessionId, seq }` | `parent`, `depth`, `activeChild` |

Seqs are preserved and `nextSeq` continues from the cut, so both branches
allocate independently with no collisions. A fork is a new **root** conversation:
`agent.sessions` lists it, `agent.session` serves it with no special case, and a
fork forks by the same rules (`forkedFrom` then points at the fork it came from,
not at the original root). The title defaults to `Fork of <the source's title, or
its id>`.

Failure modes: forking a session the caller does not own rejects
`Meteor.Error('no-session')` — another user, an anonymous caller of a session
that has an owner, or the right session under the wrong agent name — and creates
nothing at all. The `agent.fork` **method** additionally rejects `not-startable`
for a `startable: false` agent, because a fork opens another
independently-drivable session; the server-side `Agent.fork` is a direct call and
makes no such check. Forking is rate-limited by the `starts` settings entry, not
one of its own.

## Compaction

A long conversation eventually stops fitting. Compaction summarizes the old part
of the transcript into one note and lets the model continue from that summary.
**The transcript keeps every message** — only the model's view restarts.

### The trigger

Before each iteration's provider call, the loop estimates what that call will
carry. Past `window * compactAt` it compacts first, so the call that would have
overflowed is the one that benefits.

```ts
// server
import { Agent } from 'meteor/10thfloor:agent';

export const Notes = new Agent('notes').define({
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You keep meeting notes.',
  // window: assumed context in tokens. compactAt: the fraction that triggers.
  // keep: how many recent messages survive. These three values ARE the defaults,
  // so `context: {}` means exactly this.
  context: { window: 200000, compactAt: 0.8, keep: 6 },
});
```

The estimate is `max(the last assistant's provider-reported usage.input,
JSON.stringify(view).length / 4)` — erring high compacts a little early, erring
low would silently never compact.

**Omit the `context` block entirely and automatic compaction is off.** Manual
`compact()` still works: you asked for it explicitly.

### What the model sees, and what the transcript keeps

```ts
// server — a window small enough to watch it happen, and no API key needed
import { Agent, mockProvider } from 'meteor/10thfloor:agent';

export const Demo = new Agent('notes-demo').define({
  model: 'mock',
  instructions: 'You keep meeting notes.',
  context: { window: 100, compactAt: 0.5, keep: 2 },
  // The summarizer's system prompt starts "You compact conversation history…",
  // which is how this script tells the two calls apart.
  provider: mockProvider((req) => ({
    text: req.system.includes('compact') ? 'SUMMARY-BRIEF' : 'final answer',
  })),
});
```

Take a session five messages deep (seqs 0-4) already past `100 * 0.5` estimated
tokens. The next turn makes **two** provider calls — the summarization, then the
think — `status(id)` reads `'compacting'` in between, and the transcript *grows*
by a note row rather than shrinking:

```js
// the kind:'compaction' note, as committed to AgentMessages
{ role: 'note', kind: 'compaction',
  seq: 5,                           // its own allocated seq: the note is a transcript row
  summary: 'SUMMARY-BRIEF',         // whatever the summarizer returned
  upto: 2,                            // seqs 0-2 summarized; keep: 2 spared seqs 3 and 4
  usage: { input: 10, output: 13 } }  // billed like any model call (mockProvider's default)
```

From here the next request opens with
`{ role: 'user', content: '[Earlier conversation, compacted]\nSUMMARY-BRIEF' }`
and then only messages past `upto`. The cut is **batch-safe** — it never
separates an assistant's `tool_use` from its `tool_result` — and the next
compaction picks up at `upto + 1`, sweeping in the tail this one spared, with
this summary folded into the new one.
In `<agent-chat>` the note renders as `· earlier conversation compacted ·`,
addressable as `::part(message note compaction)`.

### Compacting on demand

`compact()` runs that same step immediately, whatever the threshold says — a
"compact now" button, or a job trimming a long-lived session before it gets
expensive.

```ts
// client
const compacted = await new Agent('notes').compact(sessionId);   // true if a note committed
```

```ts
// server — the same call, plus an optional owner scope
const compacted = await Notes.compact(sessionId, { userId: 'u1' });
```

It resolves `false` when there was nothing worth compacting (no more than `keep`
messages past the last note, or no batch-safe cut point in them). Everything else
is the automatic path — same cut, same summarizer prompt through the same
`beforeProviderRequest` hook, same usage accrual, same silent degrade. It takes
the session's lease for the operation and releases it, leaving the session `idle`
and unleased.

### The failure modes

A refusal rejects with `busy`, `budget-exhausted`, `no-session` or `no-agent`,
and writes nothing at all — no note, no seq, no provider call. `busy` is one
code with three `reason`s, because they need three different things from the
person reading them:

- a turn is running, or the session is leased at all — another server's live
  turn, or an orphan the watcher has yet to recover — *This session is running
  a turn; compact it when it is idle.*
- the session is `awaiting` an approval — *This session is waiting on an
  approval; answer it before compacting.*
- the session is in `error` — *This session has failed; send to it again before
  compacting.*

`budget-exhausted` is separate on purpose: a compaction bills a provider round
trip, so a session at its `budget.spend` cap is refused rather than told to try
again. Gate the button on `status(id) === 'idle'`. `agent.compact` is the second
DDP method (after `agent.send`) whose every accepted call buys a model call, so
it has its own `rateLimit.compacts` knob.

**A failed summarization is silent.** No compaction note, no error note; the turn
proceeds uncompacted, the session ends `idle`, and the server logs one warning
(`compaction failed for session <id>; proceeding uncompacted`). Compaction is
bookkeeping — it must not turn a working turn into a failed one.

## Skills

A skill is a block of instructions the model loads **only when it needs it**.

```ts
// server
import { Agent } from 'meteor/10thfloor:agent';
import { REFUND_PLAYBOOK, SHIPPING_PLAYBOOK } from '/imports/playbooks';

export const Support = new Agent('support').define({
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You are a support agent.',
  skills: [
    { name: 'refunds', description: 'How to process a refund.', content: REFUND_PLAYBOOK },
    { name: 'shipping', description: 'When parcels arrive.', content: SHIPPING_PLAYBOOK },
  ],
});
```

`name` and `description` are appended to the system prompt on **every** call:
a `## Skills` heading, one `- <name> — <description>` line per skill, then the
sentence *Load a skill's full instructions with the skill tool when its
description matches the task.* Ten playbooks cost ten lines per call.

`content` is **never** in the prompt. It arrives only when the model calls the
built-in `skill` tool — added at run time for an agent that has skills, named
exactly `skill`, taking `{ name }` — and lands as an ordinary tool row whose
`content` is `JSON.stringify` of the body. Loading is idempotent, several skills
may load in one turn, each load costs one `budget.toolCalls`, and a body longer
than `maxResultChars` (default 8000) is truncated with the marker
`…[truncated N of M chars]` — raise it, or split the skill.

An unknown name is a structured result the model routes around, not a failure:

```js
{ role: 'tool',
  error: { error: 'unknown-skill',
           reason: 'No skill named "refunds-v2". Available skills: refunds, shipping.' } }
```

Names only in that reason — the descriptions are already in the prompt.

Malformed skills are refused at `define()` time, not at load time, because a
skill with no `content` lists perfectly and fails only when a model that trusted
the listing asks for it. Three refusals, with the startup error each gives you:

- duplicate `name` — *Two skills are named "refunds"; the listing would show both
  and the loader could only ever return one.*
- a `name` outside 1-64 letters, digits or hyphens — *A skill's "name" must be
  1-64 letters, digits or hyphens; got "not a name!"*
- a blank `description` or `content` — *Skill "refunds" needs a non-empty
  "content" string — the instructions the skill tool delivers.*

If your app already has a tool named `skill`, **your tool wins** and the built-in
loader is skipped with one warning — see
[the README's Skills section](../app/packages/agent/README.md#skills).

## Hooks

Two seams, and the whole extension surface: what goes **out** to the provider,
and what comes **back** from a tool.

```ts
// server
import { Agent } from 'meteor/10thfloor:agent';
import type { BeforeProviderRequestHook, AfterToolResultHook } from 'meteor/10thfloor:agent';

// (req, ctx) => ProviderRequest | void | Promise<ProviderRequest | void>
// req = { model, system, messages, tools, signal? }
// ctx = { agent, sessionId, purpose: 'think' | 'compaction' }
const stamp: BeforeProviderRequestHook = (req) => ({
  ...req, system: `${req.system}\n\nToday is ${new Date().toDateString()}.`,
});

// (result, call, ctx) => ToolResult | void | Promise<ToolResult | void>
// result = { ok, value?, error? }   call = { id, name, args }
// ctx = { agent, sessionId, userId }
const audit: AfterToolResultHook = (result, call, ctx) => {
  console.log(ctx.agent, call.name, result.ok);   // observer: no return
};

Agent.hook('beforeProviderRequest', stamp);
Agent.hook('afterToolResult', audit);
```

**Returning nothing keeps the value** — an observer needs no return statement.
Both may be `async`.

`beforeProviderRequest` runs for **every** provider request, the turn's own call
and compaction's summarization alike, once per retry attempt. The abort signal is
re-stamped *after* your hook, so rebuilding the request cannot disable the
interrupt.

`afterToolResult` runs for every tool row a turn writes: inline, adopted,
subagent and MCP dispatches, the structured refusals (`not-allowed`,
`unknown-tool`, a denied approval) that never reached a tool body, and the resume
an approval wakes — parking a call cannot dodge it. It runs **before**
`maxResultChars` truncation and before the row is written, so your replacement is
what gets stored, published and sent to the model.

### Redacting on each seam

```ts
// server — outbound: nothing card-shaped leaves the process
const CARD = /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g;

Agent.hook('beforeProviderRequest', (req, ctx) => {
  if (ctx.purpose !== 'think') return;              // leave the summarizer alone
  return {
    ...req,
    messages: req.messages.map((m) => (
      m.content ? { ...m, content: m.content.replace(CARD, '[redacted]') } : m
    )),
  };
});
```

```ts
// server — inbound: the transcript never holds the original
Agent.hook('afterToolResult', (result, call, ctx) => {
  if (!result.ok || call.name !== 'orders.lookup') return;   // a refusal has no card in it
  const order = result.value as { card?: string };
  if (!order?.card) return;
  // ctx.userId is the SESSION's owner — null for an anonymous capability-URL session.
  return {
    ...result,
    value: { ...order, card: ctx.userId ? `••••${order.card.slice(-4)}` : '[REDACTED]' },
  };
});
```

The row that lands carries the masked value and nothing else — and the seam
cannot be dodged: the same hook runs on a call that parked on `gate: 'ask'` and
resumed on an approval, and on one a `canUse` predicate refused without ever
dispatching.

### Global versus per-agent, and the order

`Agent.hook(...)` is **global** — installed into the process, like a Pi
extension. `agentInstance.hook(...)` is that agent's own, matched against
`ctx.agent`, which a **child** session reports as the child's agent, so a
subagent's hooks are the subagent's.

```ts
// server — registered interleaved, on purpose
Support.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}+A1` }));
Agent.hook('beforeProviderRequest',   (req) => ({ ...req, system: `${req.system}+G1` }));
Support.hook('beforeProviderRequest', (req) => ({ ...req, system: `${req.system}+A2` }));
Agent.hook('beforeProviderRequest',   (req) => ({ ...req, system: `${req.system}+G2` }));

// a 'support' session's provider receives:  <the agent's system prompt>+G1+G2+A1+A2
// any other agent's receives:                <its system prompt>+G1+G2
```

**Every global hook runs first, in registration order, then that agent's, in
registration order** — specificity, not privilege. It is not a security boundary
in either direction, so a redaction that must hold everywhere belongs in one
place, not in two chains arguing. The agent need not be `define()`d yet; hooks
are matched by name at run time. `Agent.clearHooks()` clears **both** scopes,
`agentInstance.clearHooks()` only that agent's — test seams, not lifecycle.

### The custom summarizer, for free

`purpose === 'compaction'` is the summarization request, and returning a
replacement swaps it wholesale. There is no bespoke summarizer option to design.

```ts
// server — keep req.tools: the compacted head still carries tool_use blocks,
// and a request carrying those with no `tools` is rejected
Agent.hook('beforeProviderRequest', (req, ctx) => {
  if (ctx.purpose !== 'compaction') return;
  return { ...req, model: 'anthropic/claude-haiku-4-5', system: 'Five bullets. Keep every order number.' };
});
```

### When a hook is wrong

A broken extension must not kill turns. Every failure below is contained to **one
warning per failure kind**, and none of them fails the turn — the first two skip
the hook and leave the value it was given standing.

- **It throws.** The request (or result) the harness built is used unchanged.
- **It returns the wrong shape.** A replacement request needs `model`, `system`
  *and* `messages` — a rebuild that drops `system` would send the model no
  instructions at all, so it is treated as malformed rather than sent. A
  replacement result needs a boolean `ok`.
- **It returns something unserializable** — a circular object, a `BigInt`, a
  throwing `toJSON`. The row records
  `{ error: 'unserializable-result', reason: 'The tool result could not be serialized.' }`,
  and the turn finishes. Every call in the batch is still answered, because an
  unanswered `tool_use` is a 400 on the next request.

```ts
// server
Agent.hook('beforeProviderRequest', () => { throw new Error('extension is broken'); });
// [10thfloor:agent] a beforeProviderRequest hook threw and was skipped;
//   the request stands: extension is broken
// The turn still streams, commits, and ends 'idle' — one warning, not one per call.

Agent.hook('beforeToolCall', () => {});   // throws NOW: Unknown hook "beforeToolCall". …
Agent.hook('afterToolResult', 'nope');    // throws NOW: … needs a function.
```

Warnings are latched per kind, not per occurrence, so "a hook threw" cannot
permanently suppress "a hook returned a malformed request". An unknown hook name
— or a non-function — throws at **registration**: a typo'd hook is a hook that
silently never runs, and you would find out when your redaction did not happen.

## Fact Memory

An agent with `memory` remembers across conversations — and because the store is a Mongo collection, your
UI can show the user exactly what it knows and let them delete it.

```ts
// server
Support.define({ ..., memory: true });
```

That is the entire opt-in. Three tools appear (`memory_save`, `memory_search`, `memory_forget`) and a
compact listing is appended to the system prompt each iteration. Leave `memory` out and nothing changes.

### What the model sees

```
## Memory
About this person (3 remembered):
- prefers email over Slack for anything billing-related
- order #8812 dispute resolved — auth hold, not a double charge [pinned]
About this work (2 remembered):
- orders table soft-deletes; filter deletedAt: null [learned by m:analyst]
Possibly relevant to the latest message: order #8812 dispute resolved
Use memory_search to recall details, memory_save to remember something new.
```

Titles only — the listing is an INDEX. Details come through `memory_search`, which is a normal tool call
with a normal transcript row, so a UI can show precisely which memories informed an answer.

The last line before the footer is the **hint**: once per turn the harness itself runs one search against
the newest message and appends matching titles. No model call, no tokens, and content never arrives this
way. `memory: { hints: false }` turns it off.

### Person Fact Memory is shared across the agents in a session

```ts
// server — support saves
await Agent.memory.save('alice', { text: 'dispute #8812 was an auth hold', by: 'm:support' });

// analyst, addressed later in the SAME session, reads the same store
```

Person memory is keyed by `userId` alone, and a turn always runs as the session owner, so every model on
the roster reads one store. This is a consequence of the participants model, not a separate feature —
see [Participants](#participants--nn-sessions).

### Work Fact Memory, and the approval that guards it

```ts
// server
Support.define({ ..., memory: { scopes: ['user', 'app'] } });
```

Now the model can propose facts about the *work* — true for every user, read in every session:

```
model → memory_save { text: "orders table soft-deletes; filter deletedAt: null", scope: "app" }
       ↓ the gate returns 'ask' for app scope, so the turn parks
human → sees "Remember for ALL users: «orders table soft-deletes…»" and clicks Approve
       ↓ the row lands, stamped by: 'm:support'
```

Personal notes run straight through; only promotion to the shared pool asks. **Deleting from the pool asks
too** — `memory_forget` takes `{ id }` and no scope, so its gate reads the row rather than the arguments.
Writing shared knowledge behind an approval while erasing it ran unattended would be asymmetric in exactly
the wrong direction.

Both are ordinary tool gates, so you can replace them — but replace the **whole tool**, not just the gate.
A tool whose name collides with a built-in wins outright and the built-in is skipped, so a fragment
carrying only `name` and `gate` does not narrow the built-in, it *displaces* it — and since it declares
none of `run`/`method`/`subagent`/`mcp`, the turn throws when it assembles its tools:

```
Error: [10thfloor:agent] Tool spec has none of "method", "run", "subagent" and "mcp"
```

Supply a complete tool instead:

```ts
// server — a complete replacement that delegates to the same core
import { Agent } from 'meteor/10thfloor:agent';

tools: [{
  name: 'memory_save',
  description: 'Remember a durable fact.',
  args: {
    type: 'object',
    properties: { text: { type: 'string' }, scope: { type: 'string', enum: ['user', 'app'] } },
    required: ['text'],
  },
  // Auto-approve work facts with no digits in them; ask otherwise.
  gate: ({ args }) => (args.scope !== 'app' ? true : (/\d/.test(args.text) ? 'ask' : true)),
  run: (args, ctx) => Agent.memory.save(ctx.userId, { ...args, by: 'app' }),
}]
```

The built-in is skipped with one warning naming which tool took the name.

### A third scope: an agent's private notes

`scope: 'agent'` is a note one agent keeps about one person, invisible to its colleagues — a calibration
detail rather than shared context:

```ts
// server
Support.define({ ..., memory: { scopes: ['user', 'agent'] } });
```

Because these rows belong to a *named* agent, anything writing one must say which. `Agent.memory` refuses
to guess, and the DDP surface refuses the scope outright — a client has no agent to name:

```ts
// server
await Agent.memory.save('alice', { text: 'prefers terse answers', scope: 'agent' },
                        { agent: 'support' });   // ← required for scope 'agent'
```

Omitting `{ agent }` throws rather than filing the note under whichever agent happened to be defined
first, which is the kind of silent misfiling that reads as data loss.

### The user's memory page

```ts
// client
Meteor.subscribe('agent.memories');
const rows = AgentMemories.find({}, { sort: { at: -1 } }).fetch();

await Meteor.callAsync('agent.memoryForget', { id });   // the delete button
await Meteor.callAsync('agent.memorySave', { text: 'call me Mac' });
```

The client surface is deliberately **narrower** than the model's. Approval gates run only inside the turn
loop, so they cannot protect a DDP call at all — which means three things are refused there outright:
app-scope writes, agent-scope writes, and deleting a work row. Otherwise any signed-in account could write
the pool that every session's prompt reads:

```
Meteor.Error('denied-scope', 'Shared work memory cannot be written from a client; …')
```

The methods are namespaced like every other method the package registers (`agent.memorySave`, not
`memory.save`) — a bare name is one a host app plausibly already owns, and `Meteor.methods` throws on a
duplicate, so the collision would be a boot failure the moment an app added `memory: true`.

Server code has no such limit, because it is not a client:

```ts
// server — seed institutional knowledge at startup
await Agent.memory.save(null, { text: 'refunds over $500 need finance sign-off', scope: 'app' });
```

### Search degrades, it never disappears

| Rung | Needs | Gives |
|---|---|---|
| your `search` fn | nothing | whatever you implement |
| `$vectorSearch` | MongoDB 8.2+ with `mongot` | semantic recall |
| `$text` | the index this package creates | keyword ranking |
| regex + recency | nothing | literal matching |

The vector rung uses MongoDB's automated embedding — the query string goes to the database and `mongot`
embeds it at search time, so there is no pipeline and no key:

```js
db.agent_memories.createSearchIndex({
  name: 'agent_memories_vector',
  type: 'vectorSearch',
  definition: {
    fields: [
      { type: 'text', path: 'text', model: 'voyage-3-large' },
      { type: 'filter', path: 'scope' },
      { type: 'filter', path: 'userId' },
      { type: 'filter', path: 'agent' },
    ],
  },
});
```

**Automated embedding needs an embedding-model key.** The `{ type: 'text', …
model: 'voyage-3-large' }` field above is *automated* embedding: mongot calls
Voyage to embed, so a deployment without that credential configured builds the
index to status `FAILED`. `createSearchIndex` still returns success — the build
is asynchronous — so check it rather than assuming:

```js
db.agent_memories.getSearchIndexes('agent_memories_vector')[0].queryable;  // must be true
```

To supply your own vectors instead, index a `vector` field
(`{ type: 'vector', path: '…', numDimensions: N, similarity: 'cosine' }`) and
install a `memory.search` function that queries it — the top rung of the ladder
exists for exactly this.

**A missing index does not error.** `$vectorSearch` against an index name that
does not exist returns an empty result set rather than throwing, which is why
readiness is probed with `$listSearchIndexes` at first use instead of inferred
from a failure. Absent, unbuilt, and no-search-node each get their own warning
naming their own remedy.

Capability is probed once and cached — but only a genuine "no such stage" answer latches. A `mongot` that
is merely slow to accept queries after a deploy is retried rather than written off for the life of the
process, and an index missing the `filter` paths above gets its own warning naming `updateSearchIndex`
instead of degrading silently. A search failure is never a turn failure — that is the point of the ladder.

Bring your own retrieval and it wins over every rung:

```ts
// server
memory: { search: async (query, { userId, scopes, limit }) => myVectorStore.query(query, limit) }
```

### The edges, named

- **Anonymous sessions write no Fact Memory.** Not personal memory (a store keyed on `null` would be one store
  shared by every anonymous visitor) and not the work pool. The gate is no guard there — `approve` is
  optional, and with none configured the approval check is skipped entirely — so the refusal lives in the
  core, on the delete path too. They still *read* work memory, and the listing says so plainly.
- **Subagent children and `Agent.ask()` throwaways get no Fact Memory** — a child's work folds back into
  its parent, which is the Fact-Memory-bearing conversation. Checked against the Session, not the config.
  Identity-enabled children and one-shots still receive Constitution and Practice through their own
  Session-owned Memory Frame; throwaway Frames are erased with their Session.
- **`by` is the model, not the speaker.** On a model-initiated save it is `m:<agent>`; the human who
  prompted it is on the message's `from`.
- **Caps refuse, they do not evict.** `max` (200) and `maxApp` (500) return a structured `memory-full` the
  model can route around — and a keyed save still updates in a full store, so corrections never jam.
- **`key` is single-winner.** A partial unique index backs it, so two concurrent saves of the same key
  resolve to one row: the loser adopts and updates rather than inserting a duplicate.
- **`pinned` is tri-state on a keyed save.** Absent leaves the flag alone, `true` sets it, `false` clears
  it — so an unpin button that reports success actually unpins.

## Durability: what survives a crash

Kill an app server mid-turn and the transcript it leaves behind is always one a
turn can legally *start* from — it ends in a `user` or a `tool` row. Nothing
half-written is committed, and everything half-streamed is disposable. That one
invariant is what makes recovery nothing more than running the turn again.

### The guarantee: commit at turn boundaries, deltas are scratch

An assistant message commits **once**, at the end of the model call that
produced it: one atomic write allocates its `seq` and accrues its usage
together, and the row itself lands immediately after. Everything the client saw
before that was a row in the capped `agent_deltas` collection, removed the
moment the committed message supersedes it.

```ts
// server
import { Agent, AgentMessages, AgentDeltas, mockProvider } from 'meteor/10thfloor:agent';

new Agent('support', {
  model: 'mock',
  instructions: 'You are a test agent.',
  provider: mockProvider(() => ({ text: 'hi there' })),
});

// after a client's send, once status(sessionId) is back to 'idle':
await AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
// [ { seq: 0, role: 'user', content: 'hello' },
//   { seq: 1, role: 'assistant', content: 'hi there', usage: {…} } ]
await AgentDeltas.find({ sessionId }).countAsync();   // 0
```

So: **never read `agent_deltas` for truth.** `ViewMessage.toolArgs` is partial
JSON that may never finish parsing — the loop keeps no in-memory buffer of it,
because the calls it dispatches come off the provider's terminal `done` chunk
already parsed. A turn that dies mid-stream costs a few evicted delta rows and a
re-run; it can never leave a half-message you have to detect.

### The lease, and the heartbeat that renews it

One session, one running turn, one server. `claimLease` is a single
`updateAsync` whose selector matches only an unleased session, an expired one,
or one already ours — atomic on one document, so exactly one of two racing
servers wins. Every write during the turn then goes through `guardedUpdate`,
which matches on `lease.serverId`: a server that lost the lease fails the guard
and abandons rather than writes.

`server/lease.ts` holds the two constants — **`LEASE_MS = 30_000`** and
**`HEARTBEAT_MS = 10_000`**, the interval `runTurn` renews on and clears in its
`finally`. One provider call plus a tool round trip routinely exceeds 30s, so
without the heartbeat, losing the lease mid-turn would be the *normal* case.
Both are read at call time, which is what makes them shrinkable for a test.
`_setLeaseTimings` is a package-internal seam (`server/lease.ts` is not
re-exported from the package index); `tests/lease.test.ts` uses it like this:

```ts
// server — inside the package's own suite
const { _setLeaseTimings } = await import('../server/lease');

const previous = _setLeaseTimings({ leaseMs: 300, heartbeatMs: 80 });
try {
  // paced to ~1s, so lease.until advances past its grant only if the beat fires
  await runTurn('hb1', { model: 'mock', system: '', tools: [], provider: paced });
} finally {
  _setLeaseTimings(previous);   // a leaked timing change corrupts every later test
}
```

**Failure mode:** a server that loses its lease mid-stream commits nothing.
The Transcript transaction fails its exact live-Lease selector, the loop calls
`discardTurn` — which also removes the deltas streamed under that `messageId` —
and returns. The server that stole the lease is redoing the turn; two assistant
rows for one question is the bug this prevents.

### Durable user commits and atomic seq allocation

`Agent.send(sessionId, text)` still has one public contract, but its private
commit path first records a reconstructable reservation. One Mongo transaction
then assigns the current `nextSeq`, increments `nextSeq` and the Turn budget,
records compact Activation evidence, inserts the user Message, and removes the
reservation. Activation re-reads that evidence and the Transcript; the Turn's
exact Lease claim chooses one runner.

The ordering matters during a crash. A standing reservation has spent nothing;
recovery can retry the whole transaction. Once it commits, Session allocation,
budget charge, wake evidence, and Message all exist together. The compact wake
evidence remains until the Transcript proves the input was answered. The browser
supplies a hidden key for Meteor's transparent method retry, so a replay converges
on the same Message; the application call remains `Agent.send(sessionId, text)`.

Turn-owned assistant, tool, note, and budget rows use the same deep Transcript
commit under an exact live Lease and root/target lifecycle operation:

```ts
// server — server/turn-state.ts, the shape every committer uses
await withSessionOperationTransaction(operation, async (mongoSession) => {
  const before = await AgentSessions.rawCollection().findOneAndUpdate(
    { _id: sessionId, 'lease.serverId': SERVER_ID, 'lease.until': { $gt: now } },
    { $inc: { nextSeq: 1, ...inc }, $set: { updatedAt: now } },
    { returnDocument: 'before', session: mongoSession },
  );
  if (before) await AgentMessages.rawCollection().insertOne(
    { ...message, sessionId, seq: before.nextSeq }, { session: mongoSession },
  );
});
```

Read-then-`$inc` was wrong, concretely: the loop used to capture `nextSeq`
before the stream and increment at commit, so a `send` landing mid-stream read
the same value and the user message landed on the seq the assistant then
committed at. `tests/loop.test.ts` pins it by injecting a real `agent.send`
between provider yields, then asserting every message owns a unique seq, that
the interjection is committed, *and* that the loop runs a second iteration to
answer it rather than stranding it.

The user-commit allocation folds the Turn-budget predicate and increment into
that same atomic Session update, so a budget of N permits exactly N accepted
sends under concurrency. A refused send leaves no sequence or Message and
throws `Meteor.Error('budget-exhausted')`.

The private commit Interface refuses text above 256 KiB of UTF-8 and a 65th
unanswered input before allocating a sequence or charging the Turn budget. The
reservation keeps the full draft out of the frequently read Session document.
Those are safety ceilings, not traffic policy: bound untrusted input at the app
or Channel edge, configure `rateLimit.sends` for DDP callers, and give the Agent
a `budget.turns`.

### Repair on entry

Cleanup at the abandoning end races the recovering server, so the recovering
server checks for itself. `repairUnansweredToolUse` runs before a turn touches
the transcript at all — after the lease is claimed and the tool list resolved,
before a single row is read. It deletes every delta in the session whose
`messageId` is not a committed message — a SIGKILL mid-stream otherwise leaves a
ghost row stuck in `streaming` at the same `msgSeq` the retry will use — then
scans the **whole** transcript for an assistant whose `tool_use` ids have no
matching `tool_result` inside that assistant's own window, and discards each
stranded turn with its partial answers. Never just the tail: parallel calls are the
default, so `[…, assistant(t1,t2), tool(t1)]` looks healthy there while `t2`
400s every provider call forever. A parked run is exempt — `phase: 'awaiting'`
or a standing `pending` is legitimate history, not an abandoned turn.

```ts
// server — tests/loop.test.ts, hand-seeding what a crash leaves behind
await AgentMessages.insertAsync({
  _id: 'a-orphan', sessionId: 's7', seq: 1, role: 'assistant', content: '',
  toolCalls: [{ id: 't-dead', name: 'lookup', args: {} }], createdAt: new Date(),
});
await AgentDeltas.insertAsync({
  _id: 'd-orphan', sessionId: 's7', messageId: 'a-orphan', msgSeq: 1, seq: 0,
  kind: 'text', chunk: 'half an answer', at: new Date(),
});
// The next turn repairs before it streams: 'a-orphan' and its delta are gone,
// and the transcript ends in one fresh, complete assistant message.
```

### Interrupt aborts the in-flight HTTP request

Breaking out of a `for await` only stops *consuming* a stream; the request keeps
arriving and the provider keeps billing. So the loop hands every provider call
an `AbortSignal` and aborts it *before* it breaks. Your provider has to pass it
on — that is the whole contract:

```ts
// server
import { Agent, type Provider } from 'meteor/10thfloor:agent';

const streamingText: Provider = {
  async *stream(req) {
    const { model, system, messages, signal } = req;
    const res = await fetch('https://api.example.com/v1/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, system, messages }),
      signal,                      // ← the interrupt. Omit it and Stop is cosmetic.
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield { kind: 'text', chunk: decoder.decode(value, { stream: true }) };
    }
    yield { kind: 'done', usage: { input: 0, output: 0 } };
  },
};

new Agent('support', { model: 'example/fast', instructions: '…', provider: streamingText });
```

`req.signal` is attached *after* the `beforeProviderRequest` hooks run and is
never handed to them — a hook that rebuilds the request wholesale must not be
able to silently disable cancellation. While streaming, the loop re-reads the
session every 250ms; `agent.interrupt` sets `phase: 'stopped'`, the check sees
it, aborts, and returns. The package's own test asserts exactly that: the
provider's `req.signal` starts un-aborted and ends aborted.

**What an interrupted turn leaves in the transcript: nothing.** No assistant
row, no note row, no recorded usage — the killed attempt's deltas are removed,
and the only durable record is `phase: 'stopped'`, which the loop's `finally`
preserves rather than idling back. An interrupt during *tool dispatch* discards
the committed assistant and its tool rows, so the transcript again ends where a
turn can legally start — a `user` or a `tool` row from before the interrupted
iteration. The next `agent.send` clears the stop and is answered normally. A
**parked** session keeps its `pending` record — the interrupt cancels the wait,
not the question — and `approve`/`deny` refuse from then on, because they
require `phase: 'awaiting'`.

### The recovery watcher and Activation

Ordinary `Agent` calls commit durable evidence and nudge the private Activation
Module. The recovery watcher covers evidence whose original process or nudge
disappeared. It starts at boot on every server unless settings or a test mode
disable it, and combines an **observer** with a **15s sweep**. The observer reacts
to durable activation markers; the sweep catches a Lease that merely *expires*,
because expiry itself writes nothing.

```ts
// server
import { startWatcher, watcher } from 'meteor/10thfloor:agent';

const w = startWatcher({ sweepMs: 5_000 });               // an extra, faster watcher
process.on('SIGTERM', () => { void watcher?.stop(); });   // the boot one, for a clean shutdown
```

```json
// settings.json — hand recovery to some other instance instead
{ "packages": { "10thfloor:agent": { "watcher": false } } }
```

`WatcherOptions` is three numbers and nothing else:

| Option | Default | What it does |
|---|---|---|
| `sweepMs` | `15_000` | sweep interval; a slow sweep skips a tick rather than overlapping |
| `verdictGraceMs` | `max(sweepMs, 1000)` | compatibility-named grace before a standing verdict, Relay, System intent, or input is recovered |
| `relinkGraceMs` | `max(sweepMs, 1000)` | how old a child session must be before the sweep will re-link it |

Four recovery classes share the watcher:

1. **Orphan claim** — an active phase (`streaming`, `calling`, `retrying`,
   `compacting`) with no live Lease. Activation re-derives the Agent and queues
   the same Turn path used after an ordinary call.
2. **Approval timeout** — a `gate: 'ask'` park older than the agent's
   `budget.approval`. Records a denied verdict (`reason: 'approval timed out'`,
   `timedOut: true`, `by: null`) through the same single-winner conditional write
   a human verdict takes, and the turn continues. An agent with no
   `budget.approval` is *skipped*, never defaulted — unset means "wait for a human".
3. **Standing activation evidence** — a verdict, Relay, System intent, or
   committed input whose immediate activation did not finish. Halted and parked
   Sessions remain decided rather than being revived.
4. **Orphaned child** — a subagent dispatch that died between creating the child
   session and committing its result. Writes one `role: 'note',
   kind: 'orphan-child'` row into the *parent* transcript carrying
   `childSessionId` and `childAgent`. A pointer and nothing else: a sweep never
   deletes session data.

Racing servers need no new coordination. Cases 1 and 3 nudge Activation, then
the Turn's exact `claimLease` decides the runner; the verdict's conditional write
decides 2; and case 4's note has a derived `_id` (`orphan-child-<childId>`), so
the loser's insert is a duplicate key it swallows. `tests/watcher.test.ts` runs
two watchers against one orphan and against one timed-out approval, and asserts
each is done exactly once.

Activation has no public import and requires no application migration. Continue
to use `Agent#send`, `#approve`, `#deny`, `#systemTurn`, and `startWatcher`.

**In production:** leave it on. Every server running one is safe, and the
warning you *will* eventually see — a session naming an agent you renamed or
retired — is skipped, warned once per process, never fatal. Reach for
`watcher: false` only to cut sweep query load on a large fleet, and then keep
exactly one instance running `startWatcher`, or unattended runs are recovered by
nothing at all.

### `ensureIndexes`

Runs at startup, after the capped-collection check and before anything serves.
Mongo creates exactly one index for you — `_id` — so the package creates the
indexes its Transcript, Activation, Lifecycle, Channel, Attachment, and Memory
queries need, listed in [the README's Operations section](../app/packages/agent/README.md#operations).
The set is idempotent, so it runs on every boot. Most creation failures warn and
continue: the query remains correct but scans more history. A failed unique
Memory-key index is called out separately because keyed saves are not race-safe
until duplicate rows are repaired and that index exists. `ensureIndexes` is
exported so a host can run the same definitions under a different connection:

```ts
import { ensureIndexes } from 'meteor/10thfloor:agent';
await ensureIndexes();
```

### A worked failure drill

Kill the demo app mid-stream and watch the watcher put it back together. Mongo
needs a life of its own so the data outlives the app you are about to kill — and
a replica set, which is what production needs anyway.

```bash
# shell 1
mkdir -p /tmp/agent-demo-db
mongod --replSet rs0 --dbpath /tmp/agent-demo-db --port 27017 &
mongosh --quiet --eval 'rs.initiate()'

# shell 2
cd meteor-agent/app
MONGO_URL='mongodb://localhost:27017/agentdemo?replicaSet=rs0' meteor run --port 3400
```

The demo's scripted provider emits one character per chunk with no delay, so a
whole reply lands in microseconds and there is no window to kill. Pace it — the
same wrapper `tests/integration.server.ts` uses to make streaming observable.
Save the file and Meteor reloads the server for you:

```js
// server — app/server/main.js, then: provider: paced(mockProvider(demoScript), 200)
function paced(inner, delayMs) {
  return {
    async *stream(req) {
      for await (const chunk of inner.stream(req)) {
        if (chunk.kind !== 'done') await new Promise((r) => setTimeout(r, delayMs));
        yield chunk;
      }
    },
  };
}
```

Open `http://localhost:3400`, send `hello`, and while tokens are still arriving:

```bash
# shell 3 — mid-stream. Expect phase 'streaming', a lease ~30s in the future,
# a serverId, and a pile of deltas.
mongosh agentdemo --quiet --eval '
  db.agent_sessions.find({}, { phase: 1, lease: 1, nextSeq: 1 }).forEach(printjson);
  print("deltas: " + db.agent_deltas.countDocuments({}))'
```

Now kill it — a `kill -9` on the app server process, not a graceful stop. The
package registers no shutdown handler of its own, so nothing gets to run the
loop's `finally`: nothing releases the lease, nothing idles the phase, exactly
as an OOM or a pod eviction would leave it. Re-run the query
and `phase` is still `streaming`, `lease.until` is heading into the past, and the
half-answer's deltas are still in the capped collection. The transcript holds one
`user` row and no assistant row.

Restart shell 2 with the same command, then watch. The ids and counts below are
illustrative; the three transitions are what to look for.

```bash
# shell 3 — phase, lease holder, assistant rows, deltas
while true; do mongosh agentdemo --quiet --eval '
  const s = db.agent_sessions.findOne({}, { phase: 1, lease: 1 });
  print(new Date().toISOString(), s.phase, s.lease ? s.lease.serverId : "-",
        db.agent_messages.countDocuments({ role: "assistant" }),
        db.agent_deltas.countDocuments({}))'; sleep 2; done

# …T10:02:04Z streaming Kx3…  0 14   ← the dead server's lease, still in the doc
# …T10:02:26Z streaming a9Qp… 0 6    ← claimed: a NEW serverId; repair swept the ghosts
# …T10:02:29Z idle      -     1 0    ← committed, deltas gone, lease released
```

Expect up to **~45 seconds**. The observer will not touch a session whose lease
has not expired yet, so recovery waits out the rest of `LEASE_MS` (≤30s) plus
one `sweepMs` tick (15s). Then `db.agent_messages.find().sort({ seq: 1 })` shows
the user row and exactly one assistant row with the complete text — never two,
and never a half.

### Mongo must support transactions

Transcript commits transactionally pair every dependent Message/reservation
insert with its Session Lifecycle guard. That is what makes erasure final even
when another server had a database write in flight. Use a replica set or sharded
cluster; Atlas qualifies, and a single-node `--replSet` is enough for
self-hosting. A standalone production `mongod` is unsupported (and would also
degrade Meteor observers to slow polling).
