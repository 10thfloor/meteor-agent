# 10thfloor:agent

A Pi-based agent harness for Meteor 3.5+. The transcript is a Mongo collection,
streaming tokens are a capped collection, and tools are Meteor methods.

## Install

```bash
meteor add 10thfloor:agent
meteor npm install --save @earendil-works/pi-ai
```

## Define an agent

```ts
// imports/agents.ts — isomorphic
import { Agent } from 'meteor/10thfloor:agent';
export const Support = new Agent('support');

// server/agents.ts — server only
import { Support } from '/imports/agents';
Support.define({
  model: 'anthropic/claude-sonnet-5',
  instructions: ({ userId }) => `You help user ${userId}.`,
  tools: ['orders.lookup'],
});
```

`model` is `<provider>/<model-id>` as pi-ai names them (`anthropic/claude-sonnet-5`,
`openai/gpt-5`, `openrouter/moonshotai/kimi-k2`). With no `provider` of your own,
the turn streams through pi-ai, which reads its API key from the environment —
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and friends, resolved per provider. This
package adds no key plumbing of its own.

The full config surface:

```ts
Support.define({
  model: 'anthropic/claude-sonnet-5',
  instructions: [...],                       // string | fn(ctx) | array
  tools: ['orders.lookup', { name, description, args, run, gate: 'ask' }],
  skills: [{ name: 'refunds', description, content }],   // see Skills
  budget: { turns: 20, toolCalls: 40, spend: '$1.00',
            approval: 3600000 },             // each optional; see below
  pricing: { input: 3, output: 15 },         // $/Mtok fallback when the provider
                                             // does not report its own cost
  retry: { attempts: 3, baseMs: 500,
           maxDelayMs: 10000 },              // full-jitter backoff, capped
  context: { window: 200000, compactAt: 0.8,
             keep: 6 },                      // compaction; omit to disable
  maxIterations: 10,                         // model calls per turn
  maxResultChars: 8000,                      // tool results truncated past this
  canUse: (tool, { userId }) => true,        // agent-level tool backstop
  approve: ({ userId }) => userId !== null,  // who may answer ask-gates
  provider: mockProvider(...),               // omit for pi-ai
});
```

**Compaction** keeps long conversations inside the model's context window
without losing history: past `window * compactAt` estimated tokens, everything
older than the last `keep` messages is summarized into a `kind:'compaction'`
note and the MODEL's view restarts from that summary — the transcript keeps
every message and your UI keeps rendering all of it. The cut never separates a
tool call from its result, a failed summarization silently degrades to an
uncompacted turn, and the summarization call is billed like any other model
call.

## Tools

A tool is a Meteor method the model may call. Five ways to give an agent one:

```ts
tools: [
  'orders.lookup',                                  // adopt a method you already have
  { method: 'orders.lookup', description, args },   //   …with a description for the model
  { name: 'total', description, args, run, gate },  // inline: no method, runs in-process
  { subagent: 'researcher', description },          // another agent (see Subagents)
  { mcp: { server: 'docs', tool: 'search' } },      // an MCP server (see MCP servers)
]
```

`args` is a JSON Schema — it is what the model is shown, and what its arguments
are checked against.

**Co-registration** defines the method and the tool at once, so your UI and the
model call the same code through the same schema:

```ts
import { Agent } from 'meteor/10thfloor:agent';

// server/orders.ts
export const lookup = Agent.method('orders.lookup', {
  description: 'Look up an order by id',
  args: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  run(args) { return Orders.findOneAsync({ _id: args.id, userId: this.userId }); },
});

Support.define({ ..., tools: [lookup] });        // the model calls it
await Meteor.callAsync('orders.lookup', { id }); // your UI calls it
```

`run` gets the method invocation as `this`, so `this.userId` and
`this.unblock()` behave exactly as in a hand-written method. Arguments are
checked before it runs either way: a DDP caller gets
`Meteor.Error('invalid-args', reason)`, and the model gets an `invalid-args`
tool result naming the field it got wrong — which it usually corrects on the
next call, since a bad argument answers the call rather than failing the turn.

Inline tools are checked the same way, against the **whole** JSON Schema —
`enum`, `const`, numeric and length bounds, `pattern`, `format`, `minItems`,
`oneOf`/`anyOf`, `additionalProperties: false`, internal `$ref`, and nested
`properties`/`items` are all enforced. The checker is typebox's `Value.Check`,
loaded lazily through the same seam the pi-ai provider uses; typebox already
ships as a dependency of `@earendil-works/pi-ai`, so nothing new to install.
One upgrade note: `format` is now ENFORCED (`format: 'uri'` rejects a
non-URI), where JSON Schema treats it as annotation by default — a schema that
used `format` decoratively will start rejecting arguments that never matched
it. Unknown format names are still tolerated.

If typebox cannot be loaded, the package logs **one** warning and falls back to
a minimal structural checker — `type`, object `required`/`properties`, array
`items`, accepting anything it cannot model. Validation narrows; it never
disappears and never takes a turn down with it. `fullValidationAvailable()`
reports which of the two is in force.

An app can install its own validator instead, and it wins over both:

```ts
import { setToolArgsValidator } from 'meteor/10thfloor:agent';
setToolArgsValidator((schema, args) => (myCheck(schema, args)
  ? { ok: true } : { ok: false, reason: 'field "id" must be a string' }));
```

A `reason` is fed back to the model and stored in the published transcript, so
name the offending field — never echo its value. That is why the built-in
reasons quote paths (`field "customer.id" must be string`,
`missing required field "q"`, `unexpected field "sneak" is not allowed by the
schema`) and never the data.

`Agent.method` still fails closed at registration for a schema nothing can
enforce: if neither typebox nor an installed validator is available, a schema
using `enum`/bounds/`oneOf`/… throws at define time rather than shipping an
unguarded argument to a public DDP endpoint.

**Budgets** are the only brake on loop-initiated work. `turns` refuses the
(N+1)th `send` with `budget-exhausted`; `spend` and `toolCalls` stop a running
turn with a `role:'note', kind:'budget'` row in the transcript and
`phase:'stopped'`. Cost prefers the provider's own reported figure (pi-ai
prices cache reads/writes correctly) and falls back to your `pricing` table.
`approval` (ms) is the one the watcher enforces: a `gate: 'ask'` request nobody
answers within it is DENIED with `reason: 'approval timed out'` and the turn
continues. Omit it and a parked request waits forever.

**Provider failures** retry with exponential backoff under `phase:'retrying'`;
auth/request errors fail immediately. Either terminal failure writes a
`kind:'error'` note and sets `phase:'error'`; the next `send` clears it and
tries again. Your transcript UI should render three note kinds: `error`,
`budget`, and `approval`.

**Rate limits** come from settings — this shape in `settings.json`:

```json
{ "packages": { "10thfloor:agent": { "rateLimit": {
  "sends":      { "count": 10, "intervalMs": 60000 },
  "starts":     { "count": 5,  "intervalMs": 60000 },
  "interrupts": { "count": 30, "intervalMs": 60000 }
} } } }
```

Each entry registers two DDP rules per method it governs: per-(user,
connection) so an anonymous flood only burns its own connection's quota, and
per-user for authenticated callers so opening more connections does not
multiply the allowance. `starts` governs two methods — `agent.start` and
`agent.fork` (see **Forking**), both of which create a session.

**Recovery runs itself.** Every server starts a watcher at boot: it observes
sessions stuck in a live phase with a dead lease (a deploy, an OOM, a SIGKILL
mid-turn) and re-runs the turn, which repairs its own transcript on entry. A
15s sweep backs the observer up, because a lease can expire without any document
change to observe, and the same sweep enforces `budget.approval` and picks up a
verdict whose resume died before consuming it. Two servers racing on one session
resolve through the lease and the verdict's conditional write — one winner, no
new coordination. Turn it off with
`{ "packages": { "10thfloor:agent": { "watcher": false } } }`, or call
`startWatcher({ sweepMs })` yourself.

One operations note: on a **standalone MongoDB** (no replica set — no oplog, no
change streams) Meteor's observers fall back to ~10s polling. Recovery still
works — the sweep is what carries it — but the watcher's observer path, token
streaming, and `usage()`/`status()` reactivity all degrade to that polling
cadence. Streaming chat on standalone Mongo will feel like a teleprinter.
Run a replica set (Atlas, or a single-node `--replSet`) for production; this is
Meteor's constraint, not this package's.

### MCP servers

An [MCP](https://modelcontextprotocol.io) server is a subprocess that publishes
tools. Register one, then list its tools like any other:

```ts
import { Agent } from 'meteor/10thfloor:agent';

Agent.mcpServer('docs', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-everything'],
  env: { DOCS_ROOT: '/srv/docs' },      // merged over a safe PATH/HOME subset
});

Support.define({
  ...,
  tools: [
    { mcp: { server: 'docs', tool: 'search' } },   // one tool
    { mcp: { server: 'docs' } },                   // every tool it publishes
    { mcp: { server: 'docs', tool: 'search' },     // …with your own wording
      name: 'docs_search', description: 'Search our docs', gate: 'ask' },
  ],
});
```

`description` and `args` come from the server's own `tools/list` metadata —
that is what discovery is for. Supplying either overrides it for that tool. A
whole-server spec takes `gate` (and, if you insist, `description`) but not
`name` or `args`: one of each cannot describe many tools.

Requires the SDK as an app-level peer dependency, reached through a loader seam
exactly as pi-ai is:

```bash
meteor npm install --save @modelcontextprotocol/sdk
```

**Connections are lazy and per server.** Nothing spawns at registration. The
first turn that needs a server connects over stdio, runs `tools/list` once and
caches both for the life of the process — never one connection per tool. Call
`stopMcp()` to close them all; a `process.exit` closes them best-effort.

**A server that is down never fails a turn.** A named tool stays listed (with a
placeholder description) and answers `mcp-unavailable`, which the model reads
and routes around; a whole-server spec contributes no tools that turn and logs
one warning. Nothing about the failure is cached, so the next turn — or the
next call — reconnects. The same is true mid-session: if the child dies, the
connection is dropped and rebuilt on the next use.

**Results** map to tool rows the ordinary way: text content items concatenate,
and anything else becomes a `[image content omitted]`-style marker rather than
a base64 blob in your transcript. A server answering `isError` becomes a
structured `{ error: 'mcp-tool-failed', reason }`, and that reason is
**sanitized** — third-party error text is on its way into a published
transcript, so it is clamped to 200 characters and replaced outright by a
generic sentence if it looks like a stack trace, a path, a URL, or contains any
unbroken 24-character run (a token, a key, a secret nobody anticipated). Tool
OUTPUT is not sanitized; it is the answer, truncated by `maxResultChars` like
every other result.

**Gates, `canUse` and budgets apply unchanged.** An MCP tool is dispatched
through the same `runTool` an inline tool is, so `gate: 'ask'` parks it, a
`canUse` refusal never reaches the server, arguments are checked against the
discovered schema before the call, and each call costs one `budget.toolCalls`.

## Skills

A skill is a block of instructions the model loads **only when it needs it**.

```ts
Support.define({
  ...,
  skills: [
    { name: 'refunds',
      description: 'Rules and steps for issuing a refund.',
      content: await Assets.getTextAsync('skills/refunds.md') },
    { name: 'shipping',
      description: 'Carriers, SLAs and what to tell a customer about delays.',
      content: SHIPPING_PLAYBOOK },
  ],
});
```

**The economy is the whole point.** Every skill's `name` and `description` are
appended to the system prompt as a listing — two dozen words each, on every
model call:

```
## Skills

- refunds — Rules and steps for issuing a refund.
- shipping — Carriers, SLAs and what to tell a customer about delays.

Load a skill's full instructions with the skill tool when its description matches the task.
```

A skill's `content` is **never** in the prompt. When the model decides a
description matches the task, it calls the built-in `skill` tool with the name
and gets the body back as a tool result. Ten playbooks cost ten lines per call
instead of ten documents, and the turn that needs one pays for one.

The `skill` tool exists only for an agent that has skills — nothing is added to
an agent without them. Loading is idempotent, a model may load several in one
turn, and each load costs one `budget.toolCalls` like any other tool call. An
unknown name answers a structured `{ error: 'unknown-skill' }` listing the
available names (their descriptions are already in the prompt). A skill body
longer than `maxResultChars` is truncated like any other result — raise it, or
split the skill.

Names are 1-64 letters, digits or hyphens, unique within an agent, and all
three fields are required: a skill with no `content` lists perfectly and fails
only when a model that trusted the listing asks for it, so it is refused at
`define()` time instead.

If your app already has a tool named `skill`, **your tool wins** and the
built-in loader is skipped with one warning — an app's own tool, possibly
called from a UI, is not something a harness convenience should silently
override. Rename one of them.

## Hooks

Hooks are this package's **extension surface** — what Pi's extension API turns
into when the host process is a Meteor server. Two seams, registered globally:

```ts
import { Agent } from 'meteor/10thfloor:agent';

// Every request that leaves for the provider.
Agent.hook('beforeProviderRequest', (req, ctx) => ({
  ...req,
  system: `${req.system}\n\nToday is ${new Date().toDateString()}.`,
}));

// Every tool result that enters a transcript.
Agent.hook('afterToolResult', (result, call, ctx) => {
  if (!result.ok || call.name !== 'orders.lookup') return;      // keep it
  return { ...result, value: redactCardNumbers(result.value) }; // replace it
});
```

`beforeProviderRequest(req, ctx) => req | void` runs for **every** provider
request — the turn's own call and compaction's summarization alike — once per
retry attempt, with
`ctx = { agent, sessionId, purpose: 'think' | 'compaction' }`. The abort signal
is re-attached after your hook runs, so rebuilding the request wholesale cannot
disable the interrupt.

`afterToolResult(result, call, ctx) => result | void` runs for every tool row a
turn writes — inline, adopted, subagent and MCP dispatches, and the structured
refusals (`not-allowed`, `unknown-tool`, a denied approval) that never reached
a tool body — with `ctx = { agent, sessionId, userId }`. It runs **before**
`maxResultChars` truncation and before the row is written, so your replacement
is what gets stored, published and sent to the model.

Three rules for both:

- hooks run in **registration order**, each seeing the previous one's output;
- **returning nothing keeps the value** — an observer needs no return statement;
- a hook that **throws**, or returns the wrong shape, is skipped with one
  warning and the value it was given stands. A broken extension must not kill
  turns.

An unknown hook name throws at registration rather than silently never running.
`Agent.clearHooks()` removes them all; it is a **test seam** (call it in a
`finally`), not a lifecycle.

**The custom summarizer comes for free.** `purpose === 'compaction'` is the
compaction request, and returning a replacement swaps it wholesale — your own
system prompt, your own model, your own message selection — so there is no
bespoke summarizer option to configure:

```ts
Agent.hook('beforeProviderRequest', (req, ctx) => {
  if (ctx.purpose !== 'compaction') return;
  return { ...req, model: 'anthropic/claude-haiku-4-5', system: OUR_SUMMARIZER };
});
```

Registration is **global**, not per agent: a hook is installed into the process,
exactly as a Pi extension is, and threading a hook list through `RunConfig`
would mean every entry into a turn (a send, watcher recovery, `ask`, a
subagent's child run) had to remember to carry it — and one that forgot would
silently skip your redaction. Every `ctx` carries the agent's name, so a
per-agent hook is one `if` away; per-agent *registration* is a v3 candidate.

## Use it from the client

```ts
const sessionId = await Support.start();
Support.subscribe(sessionId);
await Support.send(sessionId, 'where is my order?');

Support.messages(sessionId).fetch();   // reactive, includes in-flight tokens
Support.status(sessionId);             // 'idle' | 'streaming' | 'calling' | …
```

An in-flight row also carries `toolArgs` when the model is streaming tool
calls: a `Record<number, string>` of the partial arguments JSON, **keyed by the
provider's content-block index**, so two tool calls streaming at once stay two
strings rather than one interleaved ruin. The values are partial JSON — render
them with a tolerant parser or ignore the field. Once the message commits, the
real `toolCalls` array supersedes it with parsed `args`; `toolArgs` is never a
source of truth for dispatch. Fragments from a provider that reports no index
collect under `0`.

A tool declared `gate: 'ask'` parks the turn instead of running: the status goes
to `'awaiting'` and `pending(sessionId)` returns the call the agent wants to
make, so you can render it and let a human decide.

```ts
const ask = Support.pending(sessionId);   // { toolCallId, name, args, … } | undefined
if (ask) await Support.approve(sessionId);
// …or refuse, with a reason the model gets to see:
await Support.deny(sessionId, 'too large');
```

Nothing waits server-side while a session is parked — no process, no timer — so
the request survives a deploy, and the verdict is what resumes the turn (give
the agent a `budget.approval` in ms if an unanswered request should deny itself
rather than wait forever). A
denial is answered, not dropped: the model sees the refusal and routes around
it. Who may answer is the session's owner by default; give the agent an
`approve(ctx)` predicate to narrow that further.

One `Agent` instance renders one session at a time: `subscribe()` repoints the
merged view at the session you pass it and evicts the previous one. Construct a
second `Agent` to watch two sessions side by side.

**Tear down on unmount.** `subscribe()` starts a subscription and a
`Tracker.autorun` that live until you stop them; `stop()` stops both and clears
the merged view. It is idempotent, and `subscribe()` works again afterwards.

```tsx
useEffect(() => () => Support.stop(sessionId), [sessionId]);
```

The `sessionId` argument is an optional guard: pass it and the teardown is
skipped if the instance has already been re-subscribed to a newer session, so a
late unmount cleanup cannot kill the live one.

## The packaged UI

Everything above is a data API, and the demo app renders it in about seventy
lines of plain DOM. Those seventy lines ship as a custom element, so the common
case is one tag:

```ts
import { defineAgentChat } from 'meteor/10thfloor:agent';
defineAgentChat();          // registers <agent-chat>
```

```html
<agent-chat agent="support" placeholder="Ask about your order…">
  <h1 slot="header">Support</h1>
</agent-chat>
```

That is a full chat: streaming assistant bubbles with a cursor, tool rows,
compaction and budget notes, the phase badge, the approval bar wired to
`approve`/`deny`, and a composer with Send and Stop.

**It is never registered for you.** A package that called
`customElements.define('agent-chat', …)` at import time would squat that name
in every app that depends on it, and a second definition of a name is a hard
`DOMException`. So `defineAgentChat(tagName = 'agent-chat')` is your call to
make; it returns the constructor, is a no-op if that tag is already registered,
and registers a fresh class if you pass a different name
(`defineAgentChat('support-chat')`).

**It works in whatever you already use.** A custom element is the same element
in a Blaze template, in JSX, in a Svelte component and in a static HTML file —
there is no `<AgentChat>` React binding to keep in step with this package,
because there is nothing to bind. Reactivity lives inside the element (one
`Tracker.autorun` over the same cursor `Agent.messages()` returns), so the host
framework never re-renders it.

### Attributes

| Attribute | Meaning |
| --- | --- |
| `agent` | **Required.** The name a server-side `new Agent(name, …)` registered. |
| `session-id` | The session to render. **Omit it and the element starts one** on connect. Changing it re-subscribes cleanly. |
| `placeholder` | Composer hint. |

### Auto-start, and remembering the session

With no `session-id`, the element calls `start()` when it connects and then
emits **`agent-chat:session`** (`detail: { sessionId }`, bubbling and composed)
so the host can persist an id it never chose:

```js
chat.addEventListener('agent-chat:session', (e) => {
  localStorage.setItem('session', e.detail.sessionId);
});
```

Give the tag a `session-id` **before** the tag is defined (or before it is
inserted) when you have a stored one — registration upgrades the element
immediately, and an upgrade with no id opens a fresh session. The demo app does
exactly this, in `app/client/main.js`.

A method rejection — a rate limit, a dropped connection, a session the server
no longer has — is shown as an error note in the transcript *and* emitted as
**`agent-chat:error`** (`detail: { error, message }`), which is how the demo
knows to forget a stale saved id. Text that failed to send is put back in the
composer rather than swallowed.

### Theming

The element carries its own styles in a shadow root, so nothing leaks in or
out. Restyle it through the two seams — never by piercing:

| Custom property | Default | Used for |
| --- | --- | --- |
| `--agent-chat-accent` | `#2b7de9` | User bubbles, buttons, the active phase |
| `--agent-chat-bg` | `Canvas` | Background of the element and its inputs |
| `--agent-chat-fg` | `CanvasText` | Text, and every mixed border/tint |
| `--agent-chat-warn` | `#d97706` | The approval bar and the `awaiting` phase |
| `--agent-chat-danger` | `#dc2626` | Error notes, the `error`/`stopped` phases |
| `--agent-chat-radius` | `0.75rem` | Bubble corners |
| `--agent-chat-font` | `system-ui, sans-serif` | Everything |

The defaults are the CSS system colors under `color-scheme: light dark`, so an
element you never theme still follows the OS light/dark setting.

| Part | Element |
| --- | --- |
| `root`, `header`, `messages`, `composer` | Layout containers |
| `phase` | The badge; also carries the phase itself (`::part(phase awaiting)`) |
| `message` | Every transcript row; also carries `user` / `assistant` / `tool` / `note`, plus `streaming` on an in-flight row and the note's `kind` (`::part(note error)`) |
| `tool-name`, `tool-content` | The two halves of a tool row — the content is line-clamped, `::part(tool-content) { -webkit-line-clamp: none }` unclamps it |
| `tool-calls` | The ` → name(args)` line under an assistant bubble |
| `approval`, `approval-text` | The bar and its sentence |
| `button` | Every button; also carries `send` / `stop` / `approve` / `deny` |
| `input` | The composer field |

```css
agent-chat { --agent-chat-accent: rebeccapurple; }
agent-chat::part(message user) { border-radius: 0.25rem; }
```

There is one `slot="header"` for your own title; anything you slot in stays in
the light DOM and keeps your page's CSS.

### When to stop using it

The element owns one session and repaints the whole list on every delta —
free at chat scale, and deliberately so: it buys zero diffing code. If you are
rendering thousands of rows, or you want a layout this does not have, drop to
`Agent` directly (["Use it from the client"](#use-it-from-the-client)) and
render it yourself. `client/element.ts` is ~450 lines including its CSS and is
meant to be read as the worked example. The pre-element version of the demo —
the same UI with no custom element at all — is in git history at
`git show ad0dc0b:app/client/main.js`, and remains the shortest proof that none
of this needs a framework.

For anything the element does not do (`fork`, `usage`, a denial with a reason
you collected from the user), reach through it:

```js
chat.agentInstance.deny(chat.sessionId, 'the amount is too large');
```

## Subagents

A `{ subagent }` tool spec puts one agent behind another's tool call. Calling it
runs a **child session** of the named agent — a real session with its own
transcript, its own budgets and its own live stream — and answers the parent's
tool call with the child's final assistant message.

```ts
new Agent('researcher', { model, instructions: 'You look things up.', tools: [...] });

Writer.define({
  model, instructions,
  tools: [{ subagent: 'researcher', description: 'Ask the researcher to look something up' }],
});
```

The default argument schema is one string:
`{ type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }`,
and `args.prompt` becomes the child's first user message. Pass your own `args`
if you want more structure — the whole argument object is then serialized as
JSON into that first message (declare a `prompt` string property to keep the
plain-prose form). `name` defaults to the agent's name; `gate: 'ask'` works
exactly as on any other tool, and gates the *opening* of the child session.

**The child persists, and streams.** WHILE the child runs, the parent
session's `activeChild` field carries `{ sessionId, toolCallId }` — that is
the live handle, present exactly as long as the dispatch is in flight. Once
the call resolves, the parent's tool row carries `childSessionId` durably:

```ts
// Live, while the parent is `calling`:
const active = Writer.session(sessionId)?.activeChild;
if (active) new Agent('researcher').subscribe(active.sessionId);

// Afterwards, from the transcript:
const call = Writer.messages(sessionId).fetch()
  .find((m) => m.role === 'tool' && m.childSessionId);
```

Nothing in the client API changes for a child. `agent.session` authorizes by
`userId`, and a child inherits the parent session's owner, so exactly the people
who can read the parent can read the child. `agent.sessions` **excludes**
children (`parent: { $exists: false }`) so a session list stays
conversation-level — one turn's internal work does not belong at the top of a
"your conversations" list.

**Three structured failures**, all of them tool results the model reads and
routes around rather than exceptions that kill a turn:

| result | when | child session |
| --- | --- | --- |
| `subagent-parked` | the child hit a `gate: 'ask'` tool | created, **left parked** |
| `subagent-failed` | the child failed terminally, or a budget stopped it | created |
| `subagent-depth` | the call would nest more than 3 deep | none |

`subagent-parked` is the same reasoning as `ask-parked`: the parent's turn must
not hang waiting for a human it cannot reach. The difference is the escape
hatch — the child's session is real and stays `awaiting`, so a person can
approve or deny it through the ordinary `agent.approve` / `agent.deny` path
(using the *child's* agent name and session id) and the child completes on its
own. The parent has already moved on. Give subagents no ask-gates if you want
the delegation to be self-contained, or build a UI that surfaces the parked
child — and note that the *child agent's* own `budget.approval` applies, so an
unattended parked child may deny itself on that clock.

The depth guard bounds NESTING, not fan-out: an agent that lists itself, or two
that list each other, cannot recurse past three hops (sessions carry `depth`,
and the fourth hop is refused before any document is written). Breadth is a
different animal — each level can still make `maxIterations × batch` calls, so
**`budget.toolCalls` on every agent in a subagent graph is effectively
required**; without it one `send` can legally fan out into hundreds of child
turns, run inline while the parent holds its lease.

**Budgets compose, they do not merge.** The parent spends exactly one
`budgetSpent.toolCalls` per subagent call, like any other tool; what the child
spends accrues to the *child's* session under the *child agent's* registry
config. The two limits that bite for a child are `toolCalls` and `spend` —
`turns` counts sends, and a child receives exactly one — so you bound a
subagent-heavy parent from two directions: the parent's `toolCalls` caps how
many consultations happen, and each child agent's `spend` caps what one may
cost.

Three operational truths to design around: **interrupting the parent does not
interrupt a running child** — the child streams to completion on its own budget
and the parent picks up afterwards; **delivery is at-least-once at the
subagent granularity** — a parent turn abandoned mid-batch (lease steal, crash)
is re-dispatched by recovery, and a subagent call in that batch runs a whole
second child; and an abandoned batch's discarded tool rows can leave a
completed child session with no durable pointer to it from any transcript.

## Forking

A fork branches a conversation: it copies a session's transcript up to a point
and hands you a **new session** that continues from there, leaving the original
exactly as it was. It is how you ask "what if we'd answered differently three
messages ago" without losing the answer you already have.

```ts
const branch = await Support.fork(sessionId);                     // the whole conversation
const earlier = await Support.fork(sessionId, { atSeq: 12 });     // up to message 12
Support.subscribe(branch);
await Support.send(branch, 'try it the other way instead');
```

Server-side it is the same call with an owner:

```ts
const branch = await Support.fork(sessionId, { atSeq, title, userId });
```

**`atSeq` is a request, not a command.** It is clamped DOWN to the nearest
batch-safe cut point, so a UI can pass the seq of whatever row the user clicked
without knowing anything about tool batches. Point it at a tool result — or at
the assistant that asked for one — and the fork begins *before* that assistant
instead: a transcript holding a `tool_use` with no matching `tool_result` is a
400 from every provider, on every retry, forever, and a fork born that way has
no repair path. This is the identical walk compaction uses to decide what it
may summarize away, so "a legal place to divide a transcript" has one
definition in this package rather than two.

The same rule decides what happens when you fork a session that is **awaiting
an approval**: the parked assistant's tool call is unanswered by construction,
so the cut lands before it. The fork gets the conversation up to the last
completed exchange, is `idle` rather than `awaiting`, and carries no pending
request — the approval belongs to the turn that parked it, and that turn is not
in the fork. The source stays parked and answerable.

What a fork carries, and what it does not:

| Carried | Not carried |
| --- | --- |
| the transcript up to the cut — new `_id`s, original `seq`s, every other field verbatim | `usage` and `budgetSpent` — **zeroed**; a fork costs nothing until it runs |
| compaction notes at or before the cut, so the model view stays compacted | `pending` — see above |
| the agent, the owner, and the model the source was running | `phase` and `lease` — a fork is idle and owned by no server |
| `forkedFrom: { sessionId, seq }` | `parent`, `depth`, `activeChild` |

A fork is a new **root** conversation, not a child: `agent.sessions` lists it
like any other, and `agent.session` serves it with no special case. That is why
it copies neither `parent` (which marks a subagent's internal work and is
excluded from listings) nor `depth` (subagent hops it never took). `forkedFrom`
is the only lineage it keeps, and it is a different relationship. Fork a fork
as often as you like — a fork is an ordinary session.

Two things to know about the copy. A copied tool row keeps its
`childSessionId`, so both transcripts point at the same finished subagent
session rather than re-running it. And forking is rate-limited by the
`starts` entry (the settings block is under **Define an agent**), not by an
entry of its own: a fork creates a session exactly as a start does, and copies a
whole transcript on top of it.

## Headless one-shots

`ask` is the whole conversation in one call — no session to start, subscribe to
or clean up. It is server-only, because there is no UI on the other end of it.

```ts
const answer: string = await Support.ask('where is my order?', { userId });
```

It creates a throwaway session, runs exactly one turn with the agent's real
config (tools, budgets, retries, compaction), returns the final assistant
message, and deletes the session and its transcript before returning. Two
rejections instead of a half-answer: `ask-parked` when the turn hits a
`gate: 'ask'` tool (nobody is there to approve it — keep ask-gated tools on
interactive agents), and `ask-failed` when the provider failed terminally or a
budget stopped the run, with `reason` naming which.

Because an agent's `ask` is a plain async function returning a string, it is
also a legal tool body — but for agent composition prefer a `{ subagent }` tool
spec (see **Subagents**): it runs the same nested turn and keeps the child
session, so the work streams live, stays readable afterwards, and can still be
approved if it parks. `ask` is for the case with nothing to watch and nothing
to keep: a cron job, a webhook, a Meteor method.

## Testing without an API key

```ts
import { mockProvider } from 'meteor/10thfloor:agent';
Support.define({ model: 'mock', instructions: '…', provider: mockProvider(() => ({ text: 'hi' })) });
```

## Verifying a production build

`meteor build` relocates your app's npm dependencies to
`programs/server/npm/node_modules`, which is not on Node's bare-specifier
resolution path — the reason this package resolves pi-ai through its own loader
rather than a plain `import`. That path is not exercised by the test suite,
which runs against a dev tree, so there is a script for it:

```bash
./scripts/verify-build.sh
```

It builds the app server-only into a temp directory, runs `npm install` inside
the bundle, and re-runs the loader's resolution chain against the real bundle
layout — reporting which of its three branches (bare import, absolute-file-URL
import, temp-dir shim) wins there and asserting pi-ai's namespace, `Type` and
`builtinModels()` all load. It needs no Mongo, no API key and no port, exits
non-zero on any failure, and cleans up after itself. Budget ~3-5 minutes;
`meteor build` is nearly all of it. Run it in CI and before a release, not as
part of `meteor test-packages`.

Your app must `meteor add 10thfloor:agent` for this to verify anything — a
bundle built without it contains no agent code, and the script fails early
saying so.

## Anonymous sessions

Sessions started without a login carry `userId: null` and behave as
capability-URLs: anyone who knows the session id has full access, and no one
can enumerate ids in bulk (`agent.sessions` publishes nothing to anonymous
callers). Two consequences to design for: an anonymous session **stays**
anonymous after the user logs in — it is not adopted by the account, and
remains reachable by anyone holding the id — and every tool runs with
`this.userId === null`, so an ownership check written as "belongs to the
caller" matches nothing. Model-supplied arguments are checked
against the tool's schema before dispatch (see **Tools**), but a check is not
an authorization: a tool reachable by an anonymous session should decide what
it will do for a caller with no user at all.

## Scope

Milestone 2 shipped the production core: the pi-ai provider (default), retry
and error surfacing, approval gates, budgets and cost accounting, and DDP rate
limits. Milestone 3 completed the working surface: compaction, an interrupt
that cancels the provider request, the orphan-claim watcher with approval
timeouts, the finished tool surface — `Agent.method()` co-registration and
validated tool arguments — plus `Agent.ask()`
for headless one-shots and agent composition, the `canUse` tool backstop,
`maxResultChars` truncation, client teardown via `stop()`, rate limiting for
`agent.interrupt`, and the production-bundle verification sweep
(see **Verifying a production build**).

Milestone 4 is closing out the remaining tiers. Shipped so far: full
JSON-Schema validation of tool arguments through typebox when it is reachable
(with a structural fallback and one warning when it is not), per-tool-call
attribution of streamed arguments so parallel tool calls arrive as separate
streams (`toolArgs` on an in-flight row), **subagents** — a named agent
behind a tool call, running a child session with a live, persistent transcript
(see **Subagents**), **session forking** at batch-safe cut points (see
**Forking**), **MCP servers** as tool sources (see **MCP servers**), **skills**
— on-demand prompt fragments listed in the prompt and loaded through a built-in
tool (see **Skills**) — and the **hook surface** (see **Hooks**).

**The extension surface is hooks, and only hooks.** `beforeProviderRequest` and
`afterToolResult` are the two seams this package offers an app for changing what
the harness does, and they replace Pi's extension API rather than reproducing
it: an extension there is a module a host process installs, and here the host
process is your Meteor server. A custom summarizer needs no option of its own —
it is `beforeProviderRequest` with `ctx.purpose === 'compaction'`.

Sketched in the original design but deliberately NOT implemented (v2
candidates): a global `Agent.provider()` registry, a manual `compact()` call,
and `runAs`.

See `docs/superpowers/specs/` for the full design.
