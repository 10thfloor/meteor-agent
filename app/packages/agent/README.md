# 10thfloor:agent

A Pi-based agent harness for Meteor 3.5+. The transcript is a Mongo collection,
streaming tokens are a capped collection, and tools are Meteor methods.

## Install

The package is **not yet published to Atmosphere**. Vendor it into your app's
`packages/` directory (or add it as a git submodule / `METEOR_PACKAGE_DIRS`
entry) so that `meteor add 10thfloor:agent` resolves it locally:

```bash
meteor add 10thfloor:agent
meteor npm install --save @earendil-works/pi-ai typebox
```

`typebox` powers full argument validation. It happens to be a transitive
dependency of `@earendil-works/pi-ai` today, but install it directly so a pi-ai
bump or a hoisting change cannot remove it — see CONTRIBUTING's dependency
policy.

**Remove `insecure` and `autopublish`** from your app (`meteor remove insecure
autopublish`) — the defaults Meteor ships in every new app. `autopublish` would
push transcripts to every client, and `insecure` grants clients direct write
access to collections, which voids the method-and-publication auth model
wholesale. The package registers a blanket client-write `deny` on every one of
its collections at startup — the three transcript collections and the six
channel collections (see **Channels**) — as a backstop against `insecure`, but
removing it is the correct fix.

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
  tools: ['orders.lookup', { name, description, args, run, gate: 'ask' },
          { method: 'billing.credit', description, args,
            runAs: 'service-account' }],  // see runAs — privilege escalation
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
  maxToolArgBytes: 262144,                   // per-turn tool_args delta ceiling
                                             // (display only; see Operations)
  canUse: (tool, { userId }) => true,        // agent-level tool backstop
  approve: ({ userId }) => userId !== null,  // who may answer ask-gates
  provider: mockProvider(...),               // an impl, or 'name' registered
                                             // with Agent.provider; omit for pi-ai
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

**Compacting on demand.** `compact()` runs that same step immediately,
*whatever the threshold says* — that is the point of a manual call. It is a
"compact now" button, or a job trimming a long-lived session before it gets
expensive.

```ts
const compacted: boolean = await Support.compact(sessionId);   // client or server
```

It resolves true when a summary note was committed and false when there was
nothing worth compacting (fewer than `keep` messages past the last note). It
rejects with `busy` while a turn is running — a compaction writes to the
transcript exactly as a turn does, so it takes the session's lease for the
operation and the two never overlap; gate the button on `status(id) === 'idle'`.
The same `busy` (with its own `reason`) refuses a session that is `awaiting` an
approval or sitting in `error`: both are decisions — one a person still owes an
answer to, one a UI gates on — and bookkeeping must not overwrite either.
Everything except the threshold is the automatic path: same cut, same summarizer
prompt through the same `beforeProviderRequest` hook, same usage and cost
accrual, same silent degrade on failure. The transcript keeps every message, so
nothing vanishes from your UI. It works even for an agent with no `context`
block (compaction otherwise disabled): you asked for it explicitly.

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

**`gate`** decides whether a call happens at all, and every tool kind takes it —
inline, adopted, subagent and MCP alike, since it is read before the dispatch:

```ts
gate: 'auto'                                   // the default: just run it
gate: 'ask'                                    // park the turn for a human
gate: ({ userId, sessionId, name, args }) =>   // …or decide per call
  (args.amount < 50 ? true : 'ask')            // sync or async
```

A predicate returns `true` (run it), `'ask'` (park, exactly as the literal), or
`false` — a structured `{ error: 'denied-by-gate' }` **tool result**, not a
park: the model reads the refusal, routes around it, and the rest of the batch
still runs. Nobody is troubled, and no `toolCalls` budget is spent, because
nothing was dispatched. The predicate's `userId` is the **caller's** — the
session's owner. `runAs` is deliberately not consulted: it says what identity
the tool *body* runs under once the call is allowed, and letting it answer the
gate's question would be the escalation approving itself.

A predicate that throws, or returns anything that is not those three values,
**fails closed** to the denied result with one warning per failure kind: a gate
whose own code is broken must not run the tool, and must not kill the turn
either. A `gate` that is neither a literal nor a function throws at define time
rather than resolving to a silently ungated tool.

Gates are evaluated at **every** dispatch: approving one call of a batch says
nothing about the next one, and a batch resumed after an approval re-gates its
remainder. The one exception is the approved call itself, which is dispatched
rather than re-gated — a human has already answered the question, in writing, in
the transcript, and a predicate reading mutable state routinely gives a
different answer by the time somebody clicks Approve.

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
`properties`/`items` are all enforced. The default checker compiles each
schema once with typebox's `Compile` and reuses the compiled checker for every
later call (`Compile(schema).Check`, cached weakly on the schema object);
typebox's interpreted `Value.Check` is the fallback rung, used only when the
compiler is unreachable. Both are loaded lazily through the same seam the pi-ai
provider uses. typebox is a direct dependency of the demo app (`meteor npm
install typebox`) — see the dependency policy in CONTRIBUTING. The full ladder
is documented under Operations.

`format` is ENFORCED, not treated as a decorative annotation: `format: 'uri'`
rejects a non-URI, where bare JSON Schema treats `format` as an annotation by
default. typebox 1.x ships its string formats registered, so this needs no
setup of your own; a schema that used `format` decoratively will reject
arguments that never matched it. Unknown format names are still tolerated. The
tools suite pins this (`ENFORCES \`format\`` in `tests/tools.test.ts`) so a
typebox bump that reverted to annotation-only would fail loudly.

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
tries again. Your transcript UI should render five note kinds: `error`,
`budget`, `approval`, `compaction` (an earlier stretch of the conversation was
summarized — see *Compaction*), and `orphan-child` (a recovered subagent
session — see *Recovery runs itself*; it carries `childSessionId` and
`childAgent` rather than prose).

**Rate limits** come from settings — this shape in `settings.json`:

```json
{ "packages": { "10thfloor:agent": { "rateLimit": {
  "sends":      { "count": 10, "intervalMs": 60000 },
  "starts":     { "count": 5,  "intervalMs": 60000 },
  "interrupts": { "count": 30, "intervalMs": 60000 },
  "approvals":  { "count": 30, "intervalMs": 60000 },
  "compacts":   { "count": 5,  "intervalMs": 60000 },
  "memories":   { "count": 30, "intervalMs": 60000 }
} } } }
```

Each entry registers two DDP rules per method it governs: per-(user,
connection) so an anonymous flood only burns its own connection's quota, and
per-user for authenticated callers so opening more connections does not
multiply the allowance. Two entries govern two methods each: `starts` covers
`agent.start` and `agent.fork` (see **Forking**), both of which create a
session, and `approvals` covers `agent.approve` and `agent.deny` — the same
decision made two ways, and the one unauthenticated-reachable method that
*resumes* a turn. Given separate knobs, `deny` would be the cheap way to hammer
the path `approve` limits. `memories` covers the three memory methods together (`agent.memorySave`,
`agent.memorySearch`, `agent.memoryForget`) — one surface an operator tunes as
a unit, and giving `search` its own knob would only make the cheap methods the
way around the expensive one's limit; on a mongot deployment each search runs
an embedding inside the database. `compacts` covers `agent.compact`: besides `send` it
is the only method whose every accepted call buys a provider round trip, and no
turn budget applies to it, so an unlimited one is a cheaper `send` with
`budget.spend` as its only backstop.

**Recovery runs itself.** Every server starts a watcher at boot: it observes
sessions stuck in a live phase with a dead lease (a deploy, an OOM, a SIGKILL
mid-turn) and re-runs the turn, which repairs its own transcript on entry. A
15s sweep backs the observer up, because a lease can expire without any document
change to observe, and the same sweep enforces `budget.approval`, picks up a
verdict whose resume died before consuming it, and **re-links orphaned
children**: a subagent dispatch that died between creating the child session and
committing its result leaves a real child that no published document points at,
so the sweep writes a `role: 'note', kind: 'orphan-child'` row into the *parent*
transcript carrying `childSessionId` and `childAgent` — the handle a client
needs to find it again. One note per child, and never for a child the parent is
actively dispatching. It writes a pointer and nothing else: a sweep never
deletes session data, so a child whose parent document is gone entirely is
warned about once per process and left standing. Two servers racing on one
session resolve through the lease, the verdict's conditional write, and the
note's derived `_id` — one winner, no new coordination. Turn it off with
`{ "packages": { "10thfloor:agent": { "watcher": false } } }`, or call
`startWatcher({ sweepMs })` yourself.

### Operations

**Standalone MongoDB.** On a standalone server (no replica set — no oplog, no
change streams) Meteor's observers fall back to ~10s polling. Recovery still
works — the sweep is what carries it — but the watcher's observer path, token
streaming, and `usage()`/`status()` reactivity all degrade to that polling
cadence. Streaming chat on standalone Mongo will feel like a teleprinter.
Run a replica set (Atlas, or a single-node `--replSet`) for production; this is
Meteor's constraint, not this package's.

**Indexes are created at startup.** Mongo creates exactly one index for you —
`_id` — so the package creates the ones its own queries need, on every boot,
idempotently: these three for the transcript and the watcher, and seven more
for channels (listed under **Channels**):

| Collection | Key | Why |
| --- | --- | --- |
| `agent_messages` | `{ sessionId: 1, seq: 1 }` | every transcript read: the session publication, the history each turn re-reads, the compaction cut |
| `agent_sessions` | `{ 'parent.sessionId': 1, createdAt: 1 }` (sparse) | the watcher's orphan-child sweep, which scans every child ever created, every 15s |
| `agent_sessions` | `{ phase: 1, 'lease.until': 1 }` | the sweep's orphan-claim, standing-verdict and unanswered-park queries |

A failure to create them **warns and continues**: a locked-down Atlas user may
not hold the `createIndex` action, and a package that refused to boot over a
performance index would trade a slow deployment for no deployment. If that
warning is in your logs, create them by hand — the queries are correct
without them, just proportional to your whole history rather than to one
session. Call `ensureIndexes()` yourself if you want them made under a
different connection.

**`maxToolArgBytes` — a ceiling on published argument streaming.** While a
model streams a tool call, its partial arguments JSON is published as
`tool_args` deltas so a UI can render the call taking shape. Those deltas live
in `agent_deltas`, which is **capped (32 MiB) and shared by every session on
the deployment** — eviction is global FIFO, so one model looping on a giant
argument blob can push every other session's in-flight tokens out. Past
`maxToolArgBytes` (default 256 KiB per turn) a turn stops publishing them and
logs one warning.

`tool_args` is the one delta kind that does not coalesce. A run of text tokens
collapses into a single document; parallel tool calls arrive interleaved and
each call's fragments must stay attributed to it, so every fragment is its own
document. Measured: four parallel calls streaming ~20 KB of arguments each, in
200-byte fragments, produce **400 documents and 80,000 bytes** — comfortably
under the default, and the reason the default is not much higher.

This is **display-stream hygiene and nothing else**. `text` and `thinking`
deltas are unaffected; the committed assistant message's `toolCalls` — the
parsed arguments dispatch actually runs on — never travel through the delta
stream at all, so a clamped turn calls exactly the tools it was going to call,
with exactly the arguments it was going to use. The only visible effect is that
a client's `toolArgs` preview stops growing. Raise it for an agent whose tools
genuinely take large arguments and whose UI renders them; there is no reason to
lower it.

**Argument validation is compiled.** The default checker compiles each tool's
`args` schema once with `typebox`'s `Compile` and reuses the compiled checker
for every later call (cached weakly, keyed on the schema object, so a
rediscovered MCP schema does not pin its predecessors). The ladder degrades
one rung at a time and never throws: a validator you installed with
`setToolArgsValidator` wins over everything; otherwise the compiled checker;
otherwise the interpreted `Value.Check` (same enforcement, slower — used when
`typebox/compile` is unreachable, or for one schema the compiler chokes on);
otherwise the minimal structural checker, which enforces `type`, `required` and
nested shape only. Each step down warns once. See the probe notes at the top of
the validation section in `server/tools.ts`.

### `runAs` — a tool with a fixed identity

A tool normally runs as the session's owner: an adopted method's `this.userId`
and an inline tool's `ctx.userId` are whoever is on the other end of the chat.
`runAs` replaces that for **one listing of one tool**.

```ts
tools: [
  { method: 'billing.credit', description, args, runAs: 'service-account' },
  { name: 'rates', description, args, run, runAs: null },   // anonymous
]
```

`null` is not "unset" — it is the anonymous service context (`this.userId ===
null`), for a tool that should never act on anyone's behalf. Omitting `runAs`
is what inherits the session's user.

> **`runAs` is privilege escalation by construction.** The tool runs under a
> userId the caller never authenticated as, and it is per-LISTING, not
> per-session: **every session of every agent that lists the spec gets the same
> fixed identity** — including anonymous capability-URL sessions, where "the
> user" is whoever holds the id (see **Anonymous sessions**). A tool running as
> an admin, listed by an agent anyone can chat to, is an admin API with a
> language model in front of it.

So: keep such a tool narrow (one operation, not a query surface), gate it
(`gate: 'ask'`), fence it with `canUse`, or check inside it. Authorization does
**not** move with the identity — `canUse`, the gate and the session's ownership
check all run against the session's real owner, before dispatch — so `runAs`
widens what a tool may do and never who may invoke it. That real owner is
handed to the tool as `ctx.callerUserId`, which is what an inline tool checks
when it needs to decide for itself:

```ts
{ name: 'credit', description, args, runAs: 'service-account',
  async run(args, ctx) {
    if (!ctx.callerUserId) throw new Meteor.Error('not-allowed', 'sign in first');
    return Billing.creditAsync(ctx.callerUserId, args.amount);
  } }
```

An `Agent.method` handle takes it by spreading —
`{ ...lookup, runAs: 'service-account' }` — so the same co-registered method can
be listed with a service identity by one agent and with the session's own by
another. Your UI's direct `Meteor.callAsync` is never affected: `runAs` applies
only to calls the model makes through that listing.

**Subagent and MCP specs refuse it**, at `resolveTools`, rather than accepting
it and quietly doing nothing: a subagent's child session owns its identity (it
inherits the session's user, and the child's own tools decide from there), and
an MCP call runs in another process with no Meteor invocation to carry a userId
at all.

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
one warning. A failed open starts a **cooldown** (default 30s,
`MCP_FAILURE_COOLDOWN_MS`): the next spawn attempt within that window is
suppressed and answers `mcp-unavailable` immediately rather than paying the
connect timeout again, so one dead server cannot make every turn slow. Once the
window elapses the next turn — or the next call — reconnects. Set `cooldownMs`
on the server spec to tune the window, or `0` to disable it and retry on every
call. Re-registering a server clears its cooldown (no waiting out the window
after a config fix). The same is true mid-session: if the child dies, the
connection is dropped and rebuilt after the cooldown on the next use.

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
  turns. A replacement request needs `model`, `system` **and** `messages` — a
  rebuilt request that drops `system` would send the model no instructions at
  all, so it is treated as malformed rather than sent; a replacement result
  needs a boolean `ok`.

A tool result that cannot be serialized — a circular object, a `BigInt`, a
throwing `toJSON`, whether it came from your tool or from your hook — does not
abandon the turn. The row records a structured
`{ error: 'unserializable-result' }`, the model is told the call produced
nothing usable, and the turn finishes.

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

Registration comes in two scopes. `Agent.hook(...)` is **global** — a hook is
installed into the process, exactly as a Pi extension is — and
`agentInstance.hook(...)` is that agent's own:

```ts
Support.hook('beforeProviderRequest', (req) => ({
  ...req, system: `${req.system}\n\n${supportPlaybook()}`,
}));
```

Same seams, same three rules, same failure handling; the only difference is
scope. It runs when the session's agent is this one — and a **child** session
reports the child's agent, so a subagent's hooks are the subagent's, not its
parent's. The agent need not be `define()`d yet: hooks are matched by name at
run time, so the order your server files happen to load does not matter.

**Order: every global hook first, in registration order, then that agent's, in
registration order.** Specificity, not privilege — the same rule CSS uses: the
per-agent hook refines the process-wide policy and gets the last word, exactly
as a later global hook refines an earlier one. It is not a security boundary in
either direction (a global hook could always be overruled by a second global
hook registered after it), so a redaction that must hold everywhere belongs in
one place, not in two chains arguing.

Neither scope touches `RunConfig`: threading a hook list through it would mean
every entry into a turn (a send, watcher recovery, `ask`, a subagent's child
run) had to remember to carry it — and the one that forgot would silently skip
your redaction. `Agent.clearHooks()` clears **both** scopes;
`agentInstance.clearHooks()` clears only that agent's.

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

`pending` also carries **`runAs`** when the parked tool has one (`null` = the
anonymous service context), because an approver is authorizing an identity as
well as an action: a call that runs as `service-account` is not the same request
as one that runs as them. The key is **absent** when the tool runs as the
session's own owner, so test it with `'runAs' in ask`, never for truthiness.
`<agent-chat>` appends "— runs as \<id|anonymous\>" to the approval bar, and the
`kind: 'approval'` note records it so the audit row says *what* was authorized.

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

Re-pointing the element usually takes two attribute writes
(`removeAttribute('session-id')`, then `setAttribute('agent', …)`), and
attributes arrive one at a time. The teardown is immediate but the **re-attach
is coalesced into one microtask**, so a run of synchronous writes re-subscribes
exactly once, against the attributes as they finally stand — the intermediate
combination never gets far enough to auto-start a session nothing will render.

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
knows to forget a stale saved id. Branch on the **code** when you do that:
`detail.error` is the raw rejection, so the demo forgets its saved session only
on `detail.error.error === 'no-session'` — forgetting it on every rejection
throws away a live conversation the moment somebody clicks Send twice too
quickly. Text that failed to send is put back in the composer rather than
swallowed.

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
render it yourself. `client/element.ts` is ~534 lines including its CSS and is
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

**Making an agent subagent-only.** By default every defined agent is also a
public endpoint: a client can `agent.start` it directly and drive it, bypassing
whatever gates the parent applies before delegating. Set `startable: false` on a
specialist to close that door — `agent.start` (and `agent.fork`) then throw
`not-startable`, while the subagent-dispatch path and `Agent.ask` are unaffected
(neither goes through `agent.start`), so the agent still runs as a child and
still answers a headless one-shot.

```ts
new Agent('researcher', {
  model, instructions: 'You look things up.', tools: [...],
  startable: false,                 // reachable only as a subagent / Agent.ask target
});
```

`startable: false` is a coarse on/off switch. For finer control — start the
child only for certain callers, or only when a certain parent delegates — leave
the child startable and put a **`canUse` on the parent** that inspects its own
`ctx` (`userId`, `sessionId`) and refuses the subagent tool when the caller is
not entitled; the child then runs only through a parent that allowed it.

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

Three operational truths to design around: **interrupting the parent interrupts
its running descendants** — `agent.interrupt` walks the `activeChild` chain (to
the same three-hop depth cap) and stops every descendant currently *running*,
because Stop has to stop the work the user can see; the child honors it through
the same mid-stream check an interrupt aimed at the child directly would use, so
it commits no assistant row, and the parent's tool call is answered
`subagent-failed` with an interrupted reason — an answered batch, so the parent
transcript stays resumable with the next `send`. A **parked** descendant is
deliberately *not* touched: it is a question in front of a human, the parent
already gave up on it (`subagent-parked`) and stopping it would strand a request
nobody could answer; **a re-dispatched subagent call reuses the
child it already opened** — a parent turn abandoned mid-batch (lease steal,
crash) is re-dispatched by recovery, and the lookup that runs before any child
is created finds the earlier one by `(parent session, tool call id, agent,
prompt)` and answers from it: a finished child's answer is reused with no new
model call, a parked child is reported with the session id a human can already
approve. It matches only a child that is still *unclaimed* (no tool row in the
parent transcript names it), which is precisely the state a discard leaves
behind. Two cases still open a second child: a provider that mints a fresh call
id on the retry (nothing links the two dispatches), and a child that is still
mid-run when the parent is re-dispatched (it has no outcome to report, and the
parent may not block on work it does not own); **and a child left with no
pointer is re-linked, not lost** — when an abandoned batch's discarded tool rows
leave a child session that no transcript names, the watcher's sweep writes the
`orphan-child` note described under *Recovery runs itself*, so it is reachable
from the parent conversation again within a sweep interval.

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

## Providers

A `Provider` is one method — `stream(request)` returning an async iterable of
chunks — and it is the only thing standing between this package and a model
API. Three ways to give an agent one:

```ts
Support.define({ ..., provider: myProvider });      // an implementation
Support.define({ ..., provider: 'anthropic-eu' });  // a registered name
Support.define({ ... });                            // omit it: pi-ai
```

`Agent.provider(name, impl)` registers a name, globally, like `Agent.method`
and `Agent.hook`:

```ts
// server/providers.ts
import { Agent, mockProvider } from 'meteor/10thfloor:agent';
Agent.provider('canned', mockProvider(() => ({ text: 'hi' })));
```

It buys two things. An agent config can live in an **isomorphic** file — the
string names a server-only implementation without dragging it into the client
bundle. And a deployment swaps its backend behind one registration instead of
editing every agent.

Names resolve on the first **turn**, not at `define()`: agents and providers
register in whatever order their server files load, so an agent may name a
provider registered afterwards. An unknown name throws when a turn needs it,
saying what was asked for and what is registered — never a silent fallback to
pi-ai, which would bill a real provider for a config that asked for a mock.
Re-registering a name overwrites it with one warning (that is a dev hot reload,
and refusing it would turn an ordinary edit into a startup failure).

A custom provider is also the **third way to avoid pi-ai entirely**: with
`mockProvider`, an inline implementation, or a registered name, the npm peer is
never loaded and never needs installing.

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

**And `runAs` is the sharp edge here.** `this.userId === null` at least fails
closed — an ownership check matches nothing. A tool listed with
`runAs: 'admin'` does the opposite: it hands every anonymous holder of a
session id the identity you named, on every call, because the identity belongs
to the *listing* and not to the session (see **`runAs` — a tool with a fixed
identity**). If an agent can be reached without a login, either keep `runAs`
off its tools, or gate them and check `ctx.callerUserId` — which is `null` for
exactly these sessions.

### Production ceilings

The spend controls this package ships are all **opt-in and scoped below the
deployment**. `budget` (`turns`/`toolCalls`/`spend`) is **per session**: it
bounds one conversation, not the sum of all of them, and an agent defined with
no `budget` has no brake of its own — startup logs a warning naming every such
agent. DDP `rateLimit` entries (`sends`, `compacts`, …) are **opt-in and bucket
per connection** for anonymous callers (per user for authenticated ones), so
they cap one caller's rate, not the fleet's aggregate cost. Note the
startup warning names only the *spend* residual (no `budget`, no `sends`
limit): on a default deployment, session creation (`agent.start`/`agent.fork`)
and on-demand compaction (`agent.compact`, a provider round-trip each) are
also unbounded per caller until you configure their `rateLimit` entries or an
app-level gateway ceiling — the package cannot see your proxy, so it does not
pretend to.

None of that is a deployment-wide ceiling, and an **anonymous-reachable agent
has no per-caller identity to bound** — a capability-URL flood is N connections,
each with its own bucket and its own fresh session budget. So a production
deployment that exposes an agent without a login needs a ceiling this package
cannot provide: an **app-level per-IP or global limit** in front of `agent.send`
/ `agent.compact` (a reverse-proxy rate limit, a gateway quota, or a global
spend kill-switch), on top of per-session `budget` and the opt-in `rateLimit`
knobs. Configure a `sends` rate limit and give every agent a `budget` at
minimum; treat the aggregate ceiling as the operator's responsibility.

## Channels

A channel puts the same agent on an external surface — Slack, Telegram,
WhatsApp, SMS — as two adapters over the machinery above. **Inbound** is a
verified webhook that calls the same core the web client's `send`/`approve`/
`deny` call, with an explicit `userId`. **Outbound** is a worker that observes
committed rows and posts them to every surface bound to the session, exactly
as the web client subscribes to them. Nothing new enters the loop — no hook, no
second protocol — and the core takes no provider SDK dependency: the provider
call is supplied by a channel package.

```ts
// server
import { Agent } from 'meteor/10thfloor:agent';
import { sms } from 'meteor/10thfloor:agent-channel-sms';

const cfg = Meteor.settings.packages['10thfloor:agent'].sms;
Agent.channel('sms', sms({
  agent: 'support',
  accountSid: cfg.accountSid, authToken: cfg.authToken, webhookUrl: cfg.webhookUrl,
}));
```

Four surface packages ship — `10thfloor:agent-channel-slack`, `-telegram`,
`-whatsapp` and `-sms` — each exactly one lens, one transport and one profile
default, zero npm dependencies; each README carries the provider-side setup.
Server-side `agent.send(sessionId, text, { userId })`,
`agent.approve(sessionId, { userId })` and `agent.deny(sessionId, reason,
{ userId })` landed with channels: the same core the DDP methods call, always
scoped to `{ agent, session, userId }` — `userId: null` is the anonymous owner,
never "all sessions". The DDP rate limiter does not see this path (its rules
match method names); the session budget does, and the webhook brings its own
per-sender throttle.

### `Agent.channel(kind, def)`

Static and global like `Agent.provider`, with the same registry contract:
validated at registration so a miswired channel is a startup error rather than
a dropped delivery, overwrite-with-warning on re-registration (a dev hot
reload), `kind` a short identifier (letters, digits, `-`, `_`). A package
factory is sugar over a plain `ChannelDef`:

```ts
Agent.channel('sms', {
  agent: 'support',
  transport: smsTransport({ accountSid, authToken }),
  lens: smsLens,                                   // { out, in } — see The lens
  profile: { interact: 'menu', limit: 1500 },      // how choices are offered; payload budget
  verify: (raw) => verifyTwilioSignature(raw, authToken, webhookUrl),
  parse: (raw) => parseTwilioForm(raw.rawBody),
  statuses: ['error', 'approval'],
  onUncertainDelivery: 'retry',
  sessionUrl: (session) => Meteor.absoluteUrl(`s/${session._id}`),
  linkUrl: (token) => Meteor.absoluteUrl(`link/${token}`),
  throttle: { limit: 30, intervalMs: 60000 },
});
```

| Field | Meaning |
| --- | --- |
| `agent` | **Required.** The registered agent this surface drives. |
| `transport` | **Required.** `{ post(destination, payload, { idempotencyKey }), reconcile?(destination, idempotencyKey) }` — the provider call itself, supplied by the package so the core never depends on a provider SDK. `post` receives whatever `lens.out` produced and may return `{ providerMessageId }`; `reconcile` answers "did a post under this key already land?" and its presence is what makes `onUncertainDelivery: 'reconcile'` legal. |
| `lens` | **Required.** `{ out(item, destination), in(event) }` — see **The lens**. |
| `profile` | **Required.** `{ interact: 'native' \| 'menu' \| 'link', limit? }` — see **The lens**. |
| `verify(raw)` | **Required.** The trust boundary: does this request really come from the provider? `false` is answered 401 before anything else runs. `raw` is `{ headers, rawBody, url? }` — headers lower-cased, the body **unparsed** (signature schemes sign raw bytes; a re-serialized body never verifies), `url` the path+query as Node saw it. |
| `parse(raw)` | **Required.** Raw request → the provider event `lens.in` reads. Pure. |
| `statuses` | Which note kinds this surface delivers as `status` items. Default none — an error is worth an SMS, a compaction note is not, and the channel says which. `'approval'` is the post-verdict outcome; the ask itself is always the `prompt` item. |
| `onUncertainDelivery` | What to do with a receipt found mid-`sending` after a crash: `'reconcile'` (needs `transport.reconcile`), `'retry'` (re-post under the same idempotency key — the provider collapses it, or MAY DUPLICATE if it does not), `'abandon'` (MAY LOSE). Default `'reconcile'` when the transport can, else `'retry'`; a transport that honors no key should declare. |
| `sessionUrl(session)` | The session's web view, for overflow links. Only the app knows its routes. |
| `approvalUrl(token)` | `link`-interact channels only: a minted verdict token → the URL a prompt's choice renders as. The app's route hands the token to `redeemVerdictToken`. |
| `linkUrl(token)` | A minted linking token → the URL the surface carries in answer to a `link-request`. The app's route hands it to `redeemLinkToken` from a signed-in session. Without it link-requests are acknowledged and ignored. |
| `throttle` | Per-sender webhook throttle, in-memory per process — the brake on a flood, not an accounting system. Default `{ limit: 30, intervalMs: 60000 }`. |

`ChannelKnobs` is `Pick<ChannelDef, 'statuses' | 'onUncertainDelivery' |
'sessionUrl' | 'linkUrl' | 'throttle'>` — the knobs a package factory forwards
to the core untouched, so a package's options type extends it rather than
re-documenting what the core owns.

### The lens

One object per surface, two halves, both **pure** (no I/O): `out` renders a
delivery item into the surface's native form; `in` interprets a verified
inbound event back into a fixed set of meanings. They live together because on
a surface with no buttons, "Reply YES to approve" is a parse grammar the
outbound render created — split render from interpret and the two drift.
Purity is what lets the round-trip test run with zero provider credentials,
and what makes redelivery after a crash reproduce the same payload
(idempotence comes from receipts, not from rendering). `out` may return one
payload or several (a segmented SMS); the worker posts them in order under one
receipt.

Both vocabularies are **closed**, like the phase union — a channel cannot
invent items or intents, and a new member is a framework change made once:

```ts
// DeliveryItem — what the planner emits (DELIVERY_ITEM_KINDS asserts the set):
{ item: 'reply',    text }                                          // the turn's answer: an assistant row with no toolCalls; opaque text
{ item: 'status',   kind, reason?, approved?, timedOut?, budget? }  // a note kind the channel opted into via `statuses`
{ item: 'prompt',   name, args, runAs?, toolCallId, choices }       // the parked ask, from session.pending — never from a note
{ item: 'overflow', head, url? }                                    // a reply over profile.limit: a mechanical head-slice, plus the web link when the audience allows

// InboundReading — what lens.in returns: the intent plus the routing envelope
{ intent, eventId?, externalUserId?, conversationRef?, destination?, audience?, respond? }

// InboundIntent:
{ kind: 'message', text }
{ kind: 'verdict', verdict: 'approved' | 'denied', reason?, toolCallId? }
{ kind: 'link-request' }
{ kind: 'noop' }       // everything without a defined meaning, BY DESIGN: handshakes, echoes, edits, reactions, receipts
```

`reply` text is opaque — no markdown parser in the shared core; a lens that
wants mrkdwn or HTML converts inside its own `out`. `overflow` is a head-slice,
never a summary: the worker never calls a model. A `prompt`'s `choices` are
`{ token: 'approve' | 'deny', label, match?, url? }` — `token` is canonical,
and the grammar fields are filled per the profile before the lens sees the
item. In the envelope, `eventId` must be the provider's **redelivery-stable**
id (it powers exactly-once admission); `externalUserId` keys the identities
table and `conversationRef` the bindings table; `destination` is where replies
go, stored on the binding, opaque to the core; `audience` is `'direct'` (one
recipient) or `'group'`, defaulting to `'group'` — the safe direction, since an
anonymous session's web URL is its credential and only travels to a `direct`
destination; `respond` is for `noop` only, a body the provider expects echoed
in the 200 (Slack's URL-verification challenge). A `noop` may leave the routing
fields undefined; `link-request` is optional — a lens with no gesture for it
never emits it.

**The profile** says how choices are *offered* — not what inbound is accepted
(a typed YES on a buttons surface still lands in `in` if the lens reads it):

| `interact` | Choices render as | Come back as |
| --- | --- | --- |
| `native` | buttons whose postback carries the canonical token and the ask (`encodeVerdictPostback`) | a `verdict` intent from `in` |
| `menu` | a reply menu — "Reply YES to approve, NO to deny" (`MENU_MATCHES`), the words registered in the delivery receipt's `expects` | free text that the pipeline matches against the receipt before treating it as a `message` |
| `link` | one-time URLs, each carrying a single-use server-side token bound to that one pending verdict (`issueVerdictToken` → `approvalUrl`) | the app's route calling `redeemVerdictToken` |

`limit` is the hard payload budget; a reply over it becomes an `overflow`.

Two staleness rules make a reply safe: each registered expectation names the
exact ask it answers (`toolCallId`), and the router drops a match whose ask is
no longer the one parked — a YES aimed at last week's request cannot approve
today's different one; beneath that, the single-winner verdict write remains
the final authority.

**The one law, as a test.** `assertLensRoundTrip(lens, profile, opts?)` checks
**totality** (every item renders to a non-null payload, so no surface silently
drops an approval ask) and **round-trip** (every affordance `out` offers, `in`
reads back as the exact canonical intent). It throws with a named failure on
the first violation and returns quietly when the lens holds:

```ts
assertLensRoundTrip(smsLens, { interact: 'menu' }, {
  destination: { to: '+15550001111', from: '+15559990000' },   // what `out` accepts; default {}
  synthesize: (choice, rendered) => twilioForm({ Body: choice.match }),   // the surface's event for activating `choice`
  message: (text) => twilioForm({ Body: text }),                // a plain inbound message; must read back as one
  // items: [...]                                               // the corpus; default exemplarItems(), one per kind
});
```

`synthesize` is the half only the lens author can supply — the framework
cannot forge a provider's wire format — and it is **required** to check the
prompt round-trip. Under a `menu` profile the helper fills the prompt's choices
with `MENU_MATCHES` exactly as the planner would and accepts a `message`
reading whose text matches via `matchExpectation` — the same rule the pipeline
runs. Overriding `reply`, `status` or `overflow` in a package's lens (spread it,
replace one item) is prose-only and cannot break the contract; overriding
`prompt` can, and this is the test that catches it in CI.

Lens-author helpers, all exported from `meteor/10thfloor:agent`:

| Export | What it is |
| --- | --- |
| `headerValue(raw, name)` | The first value of a possibly-repeated header — Node hands a repeated header up as an array, and a signature check wants one string. |
| `safeEqual(a, b)` | Constant-time string equality for signature checks (server-only). |
| `encodeVerdictPostback(token, toolCallId, { maxBytes? })` / `decodeVerdictPostback(raw)` | The native-postback codec — terse JSON `{ t: 'a' \| 'd', c: toolCallId }`, shared so every surface's buttons decode the same way. Over `maxBytes` (Telegram caps `callback_data` at 64 bytes) the id is **dropped**, not cut: token-only still decides the parked ask, where a truncated id would name a wrong one. `decode` returns `null` for anything that is not a verdict postback, so a lens maps it to `noop` rather than throwing. |
| `isLinkGesture(text)`, `LINK_GESTURE` | The bare word `link` — exact after trimming, any case — that asks for an account link; the core's own group hint names it, so lenses read it rather than spelling their own. |
| `VERDICT_FOR` | `{ approve: 'approved', deny: 'denied' }` — one place for which token records which verdict. |
| `MENU_MATCHES` | `{ approve: 'YES', deny: 'NO' }` — the `menu` grammar's reply words. |
| `matchExpectation(text, expects)`, `exemplarItems()`, `DELIVERY_ITEM_KINDS` | The pipeline's matching rule, the default corpus, and the closed item list. |

### Boot

Registration is inert by itself. At startup — after indexes, never under test,
and only when at least one channel is registered — the package mounts every
channel's webhook at **`/agent/channels/<kind>`** on **every** instance,
unconditionally: inbound HTTP is load-balanced, and an unmounted route is a
provider retry storm. The body is read unparsed and capped at 1 MiB (413 past
it, before verification spends anything). The **egress worker** follows the
watcher's boot contract instead — one per kind, on by default, off per kind
for deployments that run delivery on a designated instance:

```json
{ "packages": { "10thfloor:agent": { "channels": { "sms": false } } } }
```

The workers this process started are the exported `egress` map
(`Map<kind, EgressWorker>`, each with `stop()`) — a host that wires a real
SIGTERM handler stops these alongside `watcher`. For a host that wires its own
boot, `mountChannelRoutes(handlers)`, `handleInbound(kind, raw)` (the whole
pipeline as a function over `{ headers, rawBody }`, returning `{ status,
body? }`) and `startEgress(kind, { sweepMs, claimMs, sweepLookbackMs })` are
exported.

The webhook pipeline is the same for every channel: **verify** (401) → **`lens.in`**
(a verified event the lens cannot interpret settles with a 200 and one warning —
a lens bug must not become a channel-wide outage) → **throttle** per sender
(dropped with a 200, not a 429: providers retry non-2xx and count failures
against the integration) → **claim the event id** (one insert on a derived
`_id`; a provider retry collides and is answered 200 without running twice) →
**route**: a `message` is first matched against the outstanding prompt's
registered `expects`, else sent; a `verdict` is dropped if its `toolCallId` no
longer names the parked ask, else recorded; a `link-request` answers with the
`linkUrl` on a `direct` destination and with a hint on a group one. An unlinked
sender gets an anonymous session. On a `group` surface an anonymous
conversation admits only its opener until someone links — otherwise any
member could send into it or press Approve on someone else's ask. Refusals
from the agent core (`no-session`, a budget, nothing pending) settle as 200 and
a log line; a provider retry would meet the identical refusal forever.

### Delivery

The worker is `startWatcher` with the collection swapped: one observer over
committed assistant and note rows (insert-only, so `added` is the whole story)
plus a 15s sweep for everything no write signals — an expired claim, a parked
prompt (a park writes the session document, which the observer deliberately
does not watch). One worker, query-sliced, never an observer per conversation:
a Slack thread never disconnects, so per-conversation observers would
accumulate forever. Each binding carries its own cursor (`deliveredSeq`) and
its own claim, so a downed gateway delays only itself. The worker never calls
a model.

Posting and recording the post are two writes to two systems with no shared
transaction, so outbound is **effectively**-once — the surface shows the message
once — through a three-phase receipt: reserve (`sending`) → post → confirm
(`sent`), keyed on `deliver:<bindingId>:<suffix>`. A replayed backlog on boot
finds its receipts `sent` and does nothing. A receipt found mid-`sending` is
settled per `onUncertainDelivery`; a `retry` backs off doubling from one sweep
interval, capped at an hour, and is abandoned after 48 attempts, so a payload
the provider rejects deterministically neither hammers it nor wedges the
conversation behind it.

**`deliverOnce` for tool bodies.** Replies are delivered by the worker — do
not give an agent a general "reply" tool, it would send the same text twice.
A deliberate side-action (a notice, an escalation) is a tool, and it posts
through the same receipt, keyed on the tool call's id:

```ts
import { ChannelBindings, deliverOnce } from 'meteor/10thfloor:agent';

tools: [{
  name: 'channel.notify',
  description: 'Send an out-of-band notice to this conversation.',
  args: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async run(args, ctx) {
    const bindings = await ChannelBindings.find({ sessionId: ctx.sessionId }).fetchAsync();
    for (const b of bindings) {
      await deliverOnce(b, { item: 'reply', text: args.text }, `tool:${ctx.toolCallId}`);
    }
  },
}]
```

```ts
deliverOnce(binding, item | () => Promise<item>, suffix, { expects? })
  : Promise<'delivered' | 'abandoned' | 'deferred'>
```

The channel is the binding's own `kind` — a binding can only ever be delivered
through the surface that created it. The receipt is not optional: tool dispatch
**re-runs on crash recovery**, and an unreceipted post double-fires. Nor is the
destination a tool argument: the model picks the text, never where it goes —
destinations come from the session's own bindings, and a tool that must choose
between surfaces takes an enum of those. `'delivered'` means durably `sent`
(by this call or an earlier one), `'abandoned'` that the declared recovery or
the attempt cap gave it up, `'deferred'` that a prior `sending` receipt is
still inside its backoff window and nothing was posted — a one-shot caller
treats that as not sent. A thunk `item` runs only when a post actually
happens, so a rendering's side effects (minting verdict tokens) never run on a
re-sweep that finds the receipt settled.

### Linking

An external user id is identification, not authentication. Turning it into an
app account requires proof, and the proof completes from the **authenticated**
side: an unauthenticated inbound message can request a link; it can never
assert one. Auto-linking on a matching email address, trusting a phone number
for anything privileged, or trusting the external id by itself are each an
account-takeover primitive and are deliberately absent.

```ts
resolveIdentity(kind, externalUserId)                 // → ChannelIdentity | null; null is UNLINKED, a legal state
issueLinkToken(kind, externalUserId, { ttlMs? })       // → token; single-use, random, stored server-side; 10 min default
redeemLinkToken(token, userId)                         // → ChannelIdentity | null; from the signed-in side
linkIdentity(kind, externalUserId, userId, assurance)  // → ChannelIdentity; assurance 'link' | 'oidc'
issueVerdictToken(agent, sessionId, toolCallId, verdict, { ttlMs? })   // → token; 24h default
redeemVerdictToken(token)                              // → boolean
```

`redeemLinkToken` burns the token atomically (`findOneAndDelete` — of two
racing redeems exactly one wins, across servers) and answers one
indistinguishable `null` for unknown, spent, expired, or already linked to
another account, so a probe learns nothing about which. `linkIdentity` is what
it calls, and what an OIDC flow calls directly with `'oidc'` after its own
round-trip proved both sides; it writes the identity row and **claims
history** — the anonymous bindings and sessions this external identity created
become the user's, guarded so an already-owned session is never reassigned.
A different account presenting proof for an already-linked identity is refused
with `already-linked`, never re-pointed, and an `oidc` row is never downgraded
by a later weaker proof. `redeemVerdictToken` records the verdict **as the
session's owner** (the token is the authorization, exactly as an anonymous
capability-URL approval is), refuses a token whose `toolCallId` is no longer
the parked ask, and answers one `false` for everything else. The demo app
wires linking as ``linkUrl: (token) => Meteor.absoluteUrl(`link/${token}`)``
plus one method that calls `redeemLinkToken(token, this.userId)`.

A channel-originated session carries `channel: { origin, assurance }` —
`origin` the kind, `assurance` `'none'` (unlinked, an anonymous session),
`'link'` (proved by a one-time link) or `'oidc'` (a full OAuth round-trip) —
a descriptor, not routing state, with no secrets, so it ships to the client.
Gates and tools read it to vary by surface; a gate is handed `sessionId`, not
the session, so:

```ts
import { AgentSessions } from 'meteor/10thfloor:agent';

gate: async ({ sessionId }) => {
  const session = await AgentSessions.findOneAsync(sessionId);
  return session?.channel?.assurance === 'oidc' ? true : 'ask';
}
```

### Collections

Six more, server-declared (no client stub — routing and delivery bookkeeping
are the worker's business) and denied client writes like the first three.
Every `_id` but the tokens' is **derived**, so the races resolve on the primary
key: two servers binding one conversation, admitting one event, or reserving
one delivery collide on the insert, and one wins.

| Collection | `_id` | Holds |
| --- | --- | --- |
| `agent_channel_identities` | `<kind>:<externalUserId>` | Who an external sender is: `{ kind, externalUserId, userId, assurance, linkedAt }`. One app user, many rows; no row means unlinked. |
| `agent_channel_bindings` | `<kind>:<conversationRef>` | Which conversation maps to which session: `destination`, `audience`, `agent`, `sessionId`, `userId`, the opener's `externalUserId` and `assurance`, `deliveredSeq` (this surface's cursor), `claim` (the delivering worker's lease). One session, many bindings. Inserted **before** the session, so a lost race creates nothing. |
| `agent_delivery_receipts` | `deliver:<bindingId>:<suffix>` | The three-phase intent log: `state` (`sending` \| `sent` \| `abandoned`), `providerMessageId`, `expects` (the reply grammar a prompt delivery registered), `attempts`, `at`. |
| `agent_inbound_submissions` | `<kind>:<eventId>` | Exactly-once admission: one row per admitted provider event. TTL-reaped after a week — the replay horizon for signatures that carry no timestamp. |
| `agent_channel_link_tokens` | `Random.secret()` | Single-use linking tokens, bound to one external identity. |
| `agent_channel_verdict_tokens` | `Random.secret()` | Single-use approval tokens for `link`-interact prompts, bound to one pending verdict — a separate table from link tokens so the two can never be presented for each other. |

Their indexes are created at startup alongside the three above, with the same
warn-and-continue: bindings `{ sessionId }` (the fan-out lookup per committed
row), `{ kind, externalUserId }` sparse (the claim-history pass) and `{ kind,
updatedAt }` (the sweep's lookback slice — what keeps per-sweep cost
proportional to live conversations, not history); receipts `{ bindingId }`;
and TTL reapers on submissions (`at`, 7 days) and both token tables
(`expiresAt` — the janitor only; redemption checks expiry itself, because
Mongo's TTL sweep runs on its own schedule and a token must be dead the
millisecond it expires).

## Participants — n:n sessions

A session is one human and one model until you say otherwise. Saying
otherwise is the **roster**: an optional `participants` array on the session
holding humans (account-holding or channel-identified) and models
(agent-registry names). Absent, everything behaves exactly as documented
above; present, it is the authoritative list of who may read, write, approve
and speak. One transcript, one turn at a time — n:n is membership and
attribution, not concurrency.

```js
// Server-side, owner-driven — joins are app decisions, never a DDP cap.
await Agent.participants.add(sessionId, {
  id: 'h:' + colleagueId, kind: 'human', role: 'member',
  userId: colleagueId, displayName: 'Dana',
});
await Agent.participants.add(sessionId, {
  id: 'm:analyst', kind: 'model', role: 'member', agent: 'analyst',
});
```

The first join seeds the roster with the owner and the primary model in one
single-winner write, so it is never a half-list. Members appear in each
other's `sessions()` lists, may `send`, `fork`, `compact` and answer
approvals (the agent's `approve` predicate still applies), and every message
gains a harness-stamped `from` — written from the authenticated source, never
parsed from text, so a model can never impersonate a colleague.
`Agent.participants.remove` refuses the owner (ownership transfer is a named
open question) and tears down the member's channel bindings with them.

**Addressing is mechanical.** A message that starts `@analyst` (or a send
with `extras.to`) runs that model's config — its prompt, tools and provider —
under the *primary's* budget: one purse per conversation. A model whose reply
leads with `@colleague` schedules that colleague's turn — a **relay**,
durable (`pendingRelay` rides the same atomic write as the commit, the
watcher sweeps it) and budgeted (`budget.relay`, default 4 hops, reset by any
human message; the capped reply still delivers, with a note saying why
nothing answered). Model-addressed replies are internal deliberation: the web
transcript shows them, channels skip them.

**Channels admit members by policy.** A binding's `admits` — `'opener'` (the
default, v1's guard verbatim), `'members'` (roster-matched senders, account
or channel identity), `'linked'` (auto-join for linked accounts, the
group-thread path) — gates ingress; the roster gates DDP. Member bindings
(`member: true`, compose's pre-bound recipient) receive outward replies only:
never prompts, statuses, or capability URLs, and the claim-history sweep
skips them. The composed-email loop closes on exactly this machinery — see
the email package's `onReply: 'continue'`.

**Files round out the surface.** Attachment refs on published rows render as
chips in `<agent-chat>`; a click mints a single-use ~60-second token
(`agent.attachmentToken`, authorized like the publication) and downloads
through `/agent/attachments/<token>` — attachment-disposition and nosniff,
always, so the store can never serve same-origin markup. Images reach a
vision-capable model one way only: the model calls `read_attachment`, the
provider's declared capability gates it (failing closed), the bytes ride the
tool result at request time — after the compaction estimate, strippable by
an `afterToolResult` hook, degradable when a provider refuses them.

Full design: `docs/superpowers/specs/2026-08-23-participants-and-closing-the-loops.md`.

## Memory

An agent that only knows this conversation forgets the person the moment it
ends. `memory` gives it durable recall — about the people it serves, and about
the work itself — as a Mongo collection your UI can read.

```ts
Support.define({ ..., memory: true });
```

That is the whole opt-in. Declaring it registers three model-facing tools
(`memory_save`, `memory_search`, `memory_forget`) and appends a compact
listing to the system prompt on every iteration. Omit it and nothing changes:
no tools, no listing, no writes — today's behavior, bit-for-bit.

**Memory follows the human, not the model.** The default scope is keyed by
`userId` alone, and a turn always runs as the session owner, so every model
participant in a session reads the *same* store. What `support` learns,
`analyst` recalls — sharing is a consequence of the participants model, not a
second feature.

**Two kinds of memory.** Person memory (`scope: 'user'`) is what the
deployment knows about one human. Work memory (`scope: 'app'`) is what it has
learned about its own domain — one pool, no `userId`, read by every agent in
every session:

```ts
Support.define({ ..., memory: { scopes: ['user', 'app'] } });
```

Promoting a fact to the shared pool is an **approval**. The save tool's gate is
a predicate returning `'ask'` for app scope and `'auto'` otherwise, so a human
sees the exact text before it becomes something every session reads. Deleting
from the pool asks too — the forget gate reads the row's scope, because its
arguments carry none. Replace either gate like any other if your risk appetite
differs.

**Recall is legible.** Nothing enters the model's context invisibly. The
standing listing is mechanical and reconstructable from the collection; every
actual recall is a `memory_search` tool row in the transcript, spending
`toolCalls` like any tool. The harness also runs one mechanical *hint* per
turn — a single database search against the newest message that appends
matching titles (never content) to the listing, threshold-gated by `minScore`
on rungs that report one. Set `hints: false` to turn it off.

```ts
memory: {
  hints: { minScore: 0.6 },      // false to disable; one DB search per turn
  max: 200,                      // person rows per user, per scope
  maxApp: 500,                   // the shared work pool
  index: { pinned: 5, recent: 10 },   // what the listing shows
  scopes: ['user', 'app'],       // 'user' is always implied
  search: async (q, ctx) => [],  // your own retrieval, wins over every rung
}
```

**Your UI reads the same store.** Three DDP methods and one publication make
"what does this app remember about me" an ordinary Meteor screen:

```ts
Meteor.subscribe('agent.memories');                      // own rows + the work pool
await Meteor.callAsync('agent.memoryForget', { id });    // the user's delete button
await Meteor.callAsync('agent.memorySave', { text: 'call me Mac' });
```

The client surface is deliberately **narrower** than the model's. Approval
gates run only inside the turn loop, so they cannot protect a DDP call at all:
app-scope writes, agent-scope writes, and work-row deletes are refused outright
over DDP. Shared knowledge is written by an approved agent proposal, or
server-side:

```ts
await Agent.memory.save(null, { text: 'orders table soft-deletes', scope: 'app' });
await Agent.memory.list(userId);
await Agent.memory.forget(userId, id);
// Agent-scope rows belong to one named agent, so say which:
await Agent.memory.save(userId, { text: '…', scope: 'agent' }, { agent: 'support' });
```

Anonymous sessions write nothing — not personal memory (a store keyed on
`null` would be one store shared by every anonymous visitor) and not the work
pool (`approve` is optional, so a gate is no guard there). They still read work
memory, and the listing says so plainly. Subagent children and `Agent.ask()`
throwaways get no memory at all: a child's work folds back into its parent,
which is the memory-bearing conversation.

### Search, and what your database needs

Recall runs down a ladder, and **every rung degrades rather than failing a
turn**:

| Rung | Needs | Gives |
|---|---|---|
| your `search` fn | nothing | whatever you implement |
| `$vectorSearch` | MongoDB 8.2+ with `mongot` | semantic recall |
| `$text` | the text index this package creates | keyword ranking |
| regex + recency | nothing at all | literal matching |

The vector rung uses MongoDB's **automated embedding**: the query string goes
to the database and `mongot` embeds it at search time, so there is no
embedding pipeline, no API key, and no index to keep in sync — the operational
store and the search index are the same collection.

The scope clause runs *inside* the vector stage, so the index must declare its
filter paths. Provision it exactly like this:

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

An index provisioned without those `filter` paths rejects every search — the
package warns once naming `updateSearchIndex` and falls to `$text`, so recall
narrows rather than breaking. Capability is probed once and cached, but only a
genuine "no such stage" answer latches: a mongot that is merely slow to start
after a deploy is retried, not written off for the life of the process.

Note that vector and full-text search in MongoDB Community are **preview**
features at the time of writing — the ladder is what makes depending on them
safe.

Full design: `docs/superpowers/specs/2026-08-23-agent-memory-design.md`.

## Scope

**Five milestones shipped — v1, v2, and the v3 backlog: the whole list.**

The production core (milestone 2): the pi-ai provider by default, retry with
backoff and error surfacing, approval gates, budgets and cost accounting, DDP
rate limits. The working surface (milestone 3): compaction, an interrupt that
cancels the provider request, the orphan-claim watcher with approval timeouts,
`Agent.method()` co-registration with validated tool arguments, `Agent.ask()`
for headless one-shots, the `canUse` backstop, `maxResultChars` truncation,
client teardown via `stop()`, and the production-bundle verification sweep (see
**Verifying a production build**).

Milestone 4 finished the v2 list:

- **Full JSON-Schema validation** of tool arguments through typebox when it is
  reachable, degrading to a structural checker with one warning when it is not.
- **Per-tool-call attribution** of streamed arguments, so parallel tool calls
  arrive as separate streams (`toolArgs` on an in-flight row).
- **Subagents** — a named agent behind a tool call, running a child session with
  a live, persistent transcript (see **Subagents**).
- **Session forking** at batch-safe cut points (see **Forking**).
- **MCP servers** as tool sources (see **MCP servers**).
- **Skills** — on-demand prompt fragments, listed in the prompt and loaded
  through a built-in tool (see **Skills**).
- **Hooks** — the two-seam extension surface (see **Hooks**).
- **`<agent-chat>`** — the packaged UI, one tag, no framework (see **The
  packaged UI**).
- The small candidates the reviews had been carrying: **`Agent.provider()`**
  name registry (see **Providers**), **manual `compact()`** (see **Define an
  agent**), **`runAs`** on tool specs (see **`runAs` — a tool with a fixed
  identity**), and a **rate-limit entry for approvals**.

Milestone 5 (v3) shipped on top of that list:

- **Predicate gates** — `gate` may be a function that reads the arguments and
  the caller, not only the tool name (see **Tools**).
- **Per-agent hooks** — `agentInstance.hook(...)` beside the global
  `Agent.hook(...)`, globals running first (see **Hooks**).
- **Idempotent subagent dispatch** — a recovered parent turn reuses the child
  it already created rather than running a second one (see **Subagents**).
- **Orphan re-link** — the sweep writes an `orphan-child` pointer into the
  parent transcript when a dispatch died before committing its result, so no
  child is stranded (see *Recovery runs itself*).
- **Interrupt propagation** — Stop walks the `activeChild` chain and stops the
  subagent work the user can actually see.
- **Compiled argument validation** — the default checker compiles each schema
  once with typebox's `Compile` and caches it, with `Value.Check` as the
  interpreted fallback rung (see **Operations**).
- **Startup indexes** — the transcript read and the watcher's sweeps stopped
  being collection scans.
- **A `tool_args` delta clamp** — one runaway argument stream can no longer
  evict every other session's tokens from the capped delta collection.

The sixth addition is **channels** (see **Channels**): the lens contract with
its round-trip test, the watcher-shaped egress worker, the generic webhook
pipeline, exactly-once admission, receipt-backed delivery, account linking,
and server-side `send`/`approve`/`deny` with an explicit `userId`. The core
takes no provider SDK dependency; four surface packages prove the contract,
each one lens + one transport + zero npm dependencies —
`10thfloor:agent-channel-slack`, `-telegram`, `-whatsapp` and `-sms`, the last
being the design's stress test (no buttons, no threads: approvals ride the
receipt-registered "Reply YES/NO" grammar).

The seventh addition is **participants** (see **Participants — n:n
sessions**): the roster, membership as the authorization primitive, the
trusted ingress principal for unlinked channel members, mechanical
`@`-addressing with durable budgeted relays, per-model provider projection
with attribution, the composed-email loop (`onReply: 'continue'`), chat
media ingest through the def-owned SSRF-gated fetcher, the download surface,
approval legibility (`describe` → `pending.display`), and multimodal reads
behind a provider capability gate.

**The extension surface is hooks, and only hooks.** `beforeProviderRequest` and
`afterToolResult` are the two seams this package offers an app for changing what
the harness does, and they replace Pi's extension API rather than reproducing
it: an extension there is a module a host process installs, and here the host
process is your Meteor server. A custom summarizer needs no option of its own —
it is `beforeProviderRequest` with `ctx.purpose === 'compaction'`.

**Two items from the original design are retired, not pending.** Pi's **RPC
mode** and **print mode** describe a standalone process that needs a way to be
driven and a way to answer once. Here the RPC layer *is* DDP — `agent.start` /
`agent.send` / `agent.approve` are the RPC surface, published transcripts are
the streaming half, and adding a second protocol beside them would be inventing
a worse one. Print mode *is* `Agent.ask()`: one question in, one string out, no
session left behind. They are satisfied by the architecture rather than by code,
which is why you will not find them on a backlog.

See `docs/superpowers/specs/` for the full design.
