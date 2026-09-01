# 10thfloor:agent

A Meteor-native agent harness with pi-ai as its default model adapter. The
transcript is a Mongo collection, streaming tokens are a capped collection,
and tools are Meteor methods.

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
its collections at startup as a backstop against `insecure`, but removing it is
the correct fix.

## Define an agent

```ts
// server/agents.ts
import { Agent } from 'meteor/10thfloor:agent';
export const Support = new Agent('support', {
  model: 'anthropic/claude-sonnet-5',
  instructions: ({ userId }) => `You help user ${userId}.`,
  tools: ['orders.lookup'],
});
```

`model` is `<provider>/<model-id>` as pi-ai names them (`anthropic/claude-sonnet-5`,
`openai/gpt-5`, `openrouter/moonshotai/kimi-k2`). With no `provider` of your own,
the turn streams through pi-ai.

For a deployment using one API-key provider, set `PROVIDER_API_KEY`. The default
adapter passes it to pi-ai as an explicit key, so it overrides provider-specific
authentication and must match the provider in `model`:

```bash
export PROVIDER_API_KEY=...
```

For several providers at once, leave the generic override unset and use pi-ai's
provider-specific variables:

```bash
unset PROVIDER_API_KEY
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export OPENROUTER_API_KEY=...
```

AWS credentials for Bedrock, Google ADC, OAuth, and other non-API-key flows
continue through pi-ai's native credential resolution.

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
  canUse: (tool, { userId, args, toolCallId }) => true,
                                             // live agent-level entitlement
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

**`canUse` is the non-overridable entitlement fence.** It receives the exact
`tool`, model `args`, stable `toolCallId`, session owner, and `sessionId`. The
runtime checks it before a gate, immediately before execution after awaited
validation/setup, after an ask marker commits, and again when approval resumes.
An MCP connection may be established while setup is in flight, but a revoked
call never reaches `tools/call`; a revoked subagent never gets a child Session.
Treat the callback as a read-only, idempotent predicate because one logical
call is deliberately checked more than once.

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

If typebox cannot be loaded, the package logs **one** warning. A schema composed
only of `type`, object `required`/`properties`, and array `items` is checked by
the structural fallback; a richer schema is refused because that fallback
cannot enforce the whole contract. `fullValidationAvailable()` reports whether
a full checker is active.

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
multiply the allowance. `sends` covers both `agent.send` and the non-waking
`agent.contribute`, so note mode cannot bypass a deployment's transcript-write
ceiling. Two other entries govern two methods each: `starts` covers
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

`Agent.send(sessionId, text)` is the waking input Interface; `Agent.contribute`
is its non-waking collaboration counterpart. After a send's
authorization, the private Transcript Commit machinery records a reconstructable
reservation, then atomically allocates its sequence and Turn-budget charge,
materializes the Message, records compact wake evidence, and removes the
reservation in one transaction. Recovery retries that transaction without
spending twice; Activation's exact Lease claim still chooses the one Turn runner.

The commit Interface refuses text above 256 KiB of UTF-8 and a 65th unanswered
input before allocating a sequence or charging the Turn budget. The full input
stays outside the hot Session document and only compact wake evidence lives
there. Those are safety ceilings, not traffic policy: use `budget.turns` to
bound accepted sends per Session, `rateLimit.sends` to bound the DDP path, and
an app/channel ingress limit appropriate to untrusted payloads.

**Recovery runs itself.** Every server starts a watcher at boot. Its observer and
15s sweep find durable activation evidence: a live phase with no live Lease, or
a standing verdict, Relay, System intent, or committed input. They nudge the
private Activation Module, which re-reads the Session and Transcript, resolves
the eligible Agent, and queues a Turn. The Turn's exact Lease claim chooses one
runner; repair still happens on Turn entry.

The watcher also enforces `budget.approval` and **re-links orphaned children**.
A subagent dispatch that died between creating the child Session and committing
its result leaves a real child that no published document points at, so the
sweep writes a `role: 'note', kind: 'orphan-child'` row into the *parent*
Transcript with `childSessionId` and `childAgent`. It writes one pointer and
nothing else; a child whose parent is gone is warned about once per process and
left standing. Racing servers resolve through the exact Lease claim, the
verdict's conditional write, and the note's derived `_id`.

Activation is not an application API, and this coordination requires no app
migration. Existing `Agent` calls and `WatcherOptions` remain the public
Interface. Turn recovery off with
`{ "packages": { "10thfloor:agent": { "watcher": false } } }`, or call
`startWatcher({ sweepMs })` yourself.

### Operations

**MongoDB must support transactions.** Transcript commits transactionally pair
each dependent Message/reservation write with its Session Lifecycle fence, so a
completed erasure cannot be followed by a delayed write recreating private
data. Use a replica set or sharded cluster (Atlas qualifies; a single-node
`--replSet` is enough for self-hosting). Meteor's managed local Mongo supports
this during development. A standalone production `mongod` is unsupported.

**Indexes are created at startup.** Mongo creates exactly one index for you —
`_id` — so the package idempotently creates the indexes its own Transcript,
Activation, lifecycle, and Channel queries need on every boot. Core indexes
include:

| Collection | Key | Why |
| --- | --- | --- |
| `agent_messages` | `{ sessionId: 1, seq: 1 }` | every transcript read: the session publication, the history each turn re-reads, the compaction cut |
| `agent_sessions` | `{ 'parent.sessionId': 1, createdAt: 1 }` (sparse) | the watcher's orphan-child sweep, which scans every child ever created, every 15s |
| `agent_sessions` | `{ phase: 1, 'lease.until': 1 }` | the sweep's orphan-claim, standing-verdict and unanswered-park queries |
| `agent_sessions` | `{ 'pendingSystem.at': 1 }` (partial) | scheduled System Turn recovery |
| `agent_sessions` | `{ 'pendingInput.at': 1 }` (partial) | compatibility recovery for pre-Transcript-Commit Sessions |
| `agent_sessions` | `{ 'pendingInputs.at': 1 }` (partial) | committed-input Activation recovery |
| private reservation store | `{ sessionId: 1, createdAt: 1 }` | reconstruct an interrupted user-Message commit in order |

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
otherwise the structural checker for schemas it can enforce completely. Richer
schemas are refused, never partially accepted. Each step down warns once. See
the probe notes at the top of the validation section in `server/tools.ts`.

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
caches both until it is disconnected — never one connection per tool. Server
code can manage that lifecycle explicitly:

```ts
import {
  discoverMcpTools, disconnectMcpServer, unregisterMcpServer,
  getMcpServerStatus, stopMcp,
} from 'meteor/10thfloor:agent';

await discoverMcpTools('docs');       // connect and return the current catalog
getMcpServerStatus('docs');           // disconnected | connecting | connected | cooldown
await disconnectMcpServer('docs');    // close now; keep the registration
await unregisterMcpServer('docs');    // close now; remove the registration
await stopMcp();                      // disconnect every server; keep registrations
```

Replacing a registration, disconnecting, unregistering, and stopping all fence
off in-flight opens: a late subprocess is closed and can never repopulate the
cache. Status is deliberately coarse and never includes command arguments,
environment values, or failure text. A `process.exit` closes clients
best-effort.

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
`canUse` refusal never reaches the server's `tools/call`, arguments are checked
against the discovered schema before the call, and each call costs one
`budget.toolCalls`.

## Types

The package is TypeScript, and ships generated declarations. Point your app's
`tsconfig.json` at the entry:

```jsonc
{
  "compilerOptions": {
    "paths": {
      "meteor/10thfloor:agent": ["./packages/agent/index.d.ts"],
      "meteor/10thfloor:agent-channel-slack": ["./packages/agent-channel-slack/index.d.ts"],
      "meteor/10thfloor:agent-channel-telegram": ["./packages/agent-channel-telegram/index.d.ts"],
      "meteor/10thfloor:agent-channel-whatsapp": ["./packages/agent-channel-whatsapp/index.d.ts"],
      "meteor/10thfloor:agent-channel-sms": ["./packages/agent-channel-sms/index.d.ts"],
      "meteor/10thfloor:agent-channel-email": ["./packages/agent-channel-email/index.d.ts"]
    }
  }
}
```

That is the whole setup. `npm run types` regenerates declarations for the core
and all five channel packages from source with `tsc --emitDeclarationOnly`.
`npm run types:check` is the CI drift gate beside `tsc --noEmit`.

A `.js` app gets hover and completion from this immediately; no `checkJs`, no
conversion. `declarationMap` is on, so cmd-click lands in the real source rather
than in a `.d.ts`.

**One id, one shape.** `api.mainModule` names a different entry per
architecture, and both export a class called `Agent` with different surfaces.
TypeScript cannot model that, so the default `Agent` is the SERVER one — that is
where configs, tools, gates and hooks live. Client code imports `ClientAgent`
for the browser surface (`subscribe`, `messages`, `status`, `pending`). Keep
server-only imports in server modules; they do not exist in the client bundle.

### Typed tool arguments

`tool()` makes a tool's `run` and `describe` read their own schema:

```ts
import { tool } from 'meteor/10thfloor:agent';

tools: [
  tool({
    name: 'lookup_order',
    description: 'Look one up by reference.',
    args: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        limit: { type: 'integer' },
        status: { type: 'string', enum: ['open', 'shipped', 'cancelled'] },
      },
      required: ['ref'],
    },
    run: async ({ ref, limit, status }) => {
      //      ref: string
      //      limit: number | undefined        (not in `required`)
      //      status: 'open' | 'shipped' | 'cancelled' | undefined
    },
  }),
]
```

No second schema, no TypeBox, no `as const` — the JSON Schema you already write
is the one the runtime validator compiles AND the one the types come from.
Nullable via a type array (`{ type: ['integer', 'null'] }`) becomes
`number | null`. `enum` becomes a union. Anything the mapper does not recognise
widens to `unknown` rather than guessing.

**Additive, not a migration.** The spec types are unchanged — `args: unknown`,
`run: (args: any, …)`. A tool written without `tool()` compiles exactly as
before and sits in the same array. Wrapping is how you opt in, one tool at a
time.

Two things to know before you convert a file:

- A helper is unavoidable. TypeScript infers a type argument from a CALL, never
  from a bare object literal checked against a type, so `args` in an unwrapped
  spec is `unknown` and always will be.
- `run: async (args = {}) => …` does not compile. The default is checked against
  the argument type before the schema has been inferred. Dispatch always passes
  an object, so use per-property defaults: `async ({ limit = 10 }) => …`.

`methodTool()` is the same thing for an adopted Meteor method. Both return the
erased spec type, which is why a generic tool drops into any existing
`ToolSpec[]` without a variance error.

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
await Support.contribute(sessionId, 'Dana confirmed the deadline.'); // no model wake

Support.messages(sessionId).fetch();   // reactive, includes in-flight tokens
Support.status(sessionId);             // 'idle' | 'streaming' | 'calling' | …
```

`contribute(sessionId, text)` is human-to-crew context. It commits a
`role:'user', kind:'crew-note'` row so the next model turn can read it, but it
does **not** resolve a leading `@agent`, create Activation evidence, increment
`budget.turns`, or start a provider call. Browser retries are idempotent just
like `send`. Both browser methods stamp `message.source = { kind:'desktop' }`;
verified channel ingress stamps `{ kind:'channel', channel:<registered kind>,
origin:<opaque binding token> }`. `origin` is random — never a provider
conversation id or destination — and exists only to suppress an echo to the
exact binding that received the row. Source metadata is written only by trusted
server paths; neither browser method accepts it.

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
if (ask) await Support.approve(sessionId, ask.toolCallId);
// …or refuse, with a reason the model gets to see:
if (ask) await Support.deny(sessionId, 'too large', ask.toolCallId);
```

Pass the displayed `toolCallId`: the verdict write then matches that exact
pending call atomically, so a late click for ask A cannot approve a newly
parked ask B. The argument is optional only for compatibility with older UIs.

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

That is a full chat: streaming assistant bubbles with a cursor, concise tool
receipts, compaction and budget notes, the phase badge, the approval bar wired
to `approve`/`deny`, and a composer with Send and Stop. Exact machine records
are available only in explicit debug mode.

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
| `composer-mode` | `ask` (default) calls `send` and wakes the addressed/default agent. `note` calls `contribute`, changes the default hint/button/ARIA label, and records shared context without a wake. The `composerMode` property mirrors the attribute. |
| `verbosity` | `clean` is the default: tool calls/results become concise operational receipts, approvals use bounded human-readable argument summaries, embedded JSON-string escapes are decoded, and raw object/array payloads are hidden. `debug` restores exact assistant bytes, tool arguments, tool-result payloads, structured assistant content, and approval records. Legacy `quiet` aliases `clean`; legacy `full` aliases `debug`. It only changes what is drawn, so toggling it re-paints without touching the session. |

In clean mode, assistant prose renders as semantic GFM/CommonMark-style
Markdown (headings, lists, emphasis, code, fenced code, blockquotes, tables,
and links). The lexer output is walked into an allowlisted DOM; it is never
inserted as HTML. Raw HTML and image syntax remain inert text, and only absolute
HTTPS or `mailto:` links become hardened external anchors. User messages, Crew
notes, tools, notes, and debug-mode assistant bytes remain literal text.

Each submit enters a single in-flight state immediately: input and send button
disable, the label becomes `Sending…` or `Adding note…`, and duplicate submits
are ignored until the method settles. A rejection restores the draft and the
controls. A successful submit emits **`agent-chat:submitted`** with
`detail: { sessionId, mode }`.

Re-pointing the element usually takes two attribute writes
(`removeAttribute('session-id')`, then `setAttribute('agent', …)`), and
attributes arrive one at a time. The teardown is immediate but the **re-attach
is coalesced into one microtask**, so a run of synchronous writes re-subscribes
exactly once, against the attributes as they finally stand — the intermediate
combination never gets far enough to auto-start a session nothing will render.

### Mentions

The element renders `@handle` as a chip and completes it in the composer.

The session's own **model participants** are mentionable for free, because those
are the handles that actually address a turn — `@risk` at the start of a message
is what routes it to `risk`, and the chip is that fact made visible.

Everything else your users talk about is declared with `mentionSources`, keyed
**by the symbol**. The element owns the UI — matching, the typeahead, the
keyboard, the chips — and you own only where the records come from:

```js
chat.mentionSources = {
  '@': { collection: Customers, handle: (c) => slug(c.name), label: 'name', kind: 'customer' },
  '#': { list: () => tickets.open(), handle: 'id', label: 'title', kind: 'ticket' },
};
```

A source takes one of three forms:

| Form | Use it when |
| --- | --- |
| `collection` | A live cursor. Read inside the element's own `Tracker.autorun`, so chips repaint when the data changes with nothing to wire up. |
| `list` | An array, or a function returning one — anything static or computed. |
| `search` / `lookup` | Neither fits. Two functions: everything matching what has been typed, and one exact handle. |

For the first two, name the fields:

| Field | Meaning |
| --- | --- |
| `handle` | **Required.** What follows the symbol, and what resolves it. A field name, or a function of the record — a function is what a stored column cannot express, like a handle slugged from a display name. |
| `label` | What the chip and the typeahead show. Defaults to the handle. Field name or function. |
| `kind` | Free-form, becomes a `part` token: `::part(mention ticket)`. Model participants get `agent`. |
| `detail` | A second line in the typeahead, and the chip's tooltip. |
| `limit` | How many the typeahead offers at once. Default 8. |
| `max` | Ceiling on records read from a collection at once. Default 1000 — a guard against an unbounded publication, not a page size. |

The package never looks at a record beyond the fields you name here, so nothing
about your domain reaches it.

### A second symbol

Each symbol offers only what it names — typing `#` will not suggest a person —
and the namespaces are independent, so `@acme` and `#acme` are different
subjects rather than one overwriting the other.

`@` always carries the session's model participants, layered **under** whatever
you put there: you can add subjects to `@`, but you cannot shadow a real
addressee with an inert one of the same name.

Reach for a second symbol when the things being named are of a different
**order**, not merely a different type: `@` reaches someone who could answer,
and for a model participant it actually routes the turn, while `#` might name a
row in a price list that could never take one. Only `@` is ever parsed as an
addressee, so anything under another symbol is inert by construction.

App-supplied subjects are **inert on purpose**: they render and they complete,
but naming one schedules nothing. Only a model participant can take a turn, and
the package will not invent a routing rule for a noun it cannot see — if you
want `@acme` to *do* something, give the agent a tool that resolves the handle.

A token that matches nothing stays plain text. That is the same rule
`resolveAddressee` uses, and keeping the two in step is the point: a chip that
implied routing the parser would not perform would be a lie in the transcript.

**Addressed vs named.** Only a mention at the *start* of a message schedules a
turn. `@risk take a look` routes; `let me ask @risk about it` does not. The
element renders the two differently — the leading one carries an `addressed`
part token, the accent, and an arrow; everything else gets the quiet treatment:

```css
agent-chat::part(mention addressed) { /* the one that routed */ }
```

When a model's turn-final reply *names* another model without addressing one,
the package writes an `unrouted-mention` note into the transcript saying so. It
changes no routing — auto-addressing a buried mention would make the parse
ambiguous, which is what the one-position rule exists to avoid — it just ends
the silence. Without it a model that opens with a sentence of preamble and puts
`@risk` in the second paragraph leaves the roster idle holding an unanswered
question, and nothing anywhere says why.

Typing `@` opens the list; ↑/↓ move, Tab or Enter accepts, Escape dismisses.
**Enter completes rather than sends** while the list is open — a composer that
fires off `@pri` because someone pressed Enter to pick a name is the bug this
behaviour exists to avoid.

### Archiving a session

`agent.archive(sessionId)` shelves a conversation and `agent.unarchive` brings it
back. Archiving affects **the list and nothing else**: the session keeps its
transcript, still answers `agent.session`, and still takes a turn if a routine, an
inbound channel message, or a resuming approval addresses it. Only
`subscribeSessions()` filters it out, and `subscribeSessions(true)` asks for it
back — there is no separate archived publication.

The separation is deliberate. "Archive this chat" means *stop showing it to me*;
a package that read it as *stop the work* would silently drop a scheduled turn
nobody cancelled.

### Erasing a Session (server only)

Archiving is display state; erasure is permanent data lifecycle. Call it from
trusted server code with the owner identity made explicit:

```ts
const outcome = await Support.erase(sessionId, { userId: this.userId });
// 'erased' | 'absent'
```

Only the exact owner can erase a root Session. A roster member cannot erase the
owner's conversation, and missing, wrong-owner, wrong-agent, and child Session
ids all return the same `absent` result. `userId: null` is required explicitly
for an anonymous owner.

Erasure fences new Turns and deliveries, stops the root and its recursive
subagent descendants, waits for their Leases, then removes Messages, Deltas,
Attachments, download/verdict tokens, Channel Bindings, and their delivery
receipts. Forks are independent roots and survive. User/app Memory and
account-wide Channel Identity also survive: deleting a conversation is not an
account-wide “forget me” operation. If storage or a live Turn prevents prompt
completion, the call throws `erase-incomplete`; the Session remains inaccessible
and the recovery watcher retries the idempotent cleanup.

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
swallowed. Transcript repainting also leaves a reader's scroll position and
composer focus alone when they have moved above the tail; a **New messages**
button returns to the bottom. A reader already at the tail keeps following it.

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
| `message` | Every transcript row; also carries `user` / `assistant` / `note`, plus `operation` on a clean tool receipt, `streaming` on an in-flight row, and the note's `kind` (`::part(note error)`) |
| `markdown` | Clean assistant content boundary. Descendants expose `markdown-heading`, `markdown-paragraph`, `markdown-list`, `markdown-list-item`, `markdown-strong`, `markdown-emphasis`, `markdown-strikethrough`, `markdown-code`, `markdown-inline-code`, `markdown-code-block`, `markdown-language`, `markdown-blockquote`, `markdown-rule`, `markdown-table`, and `markdown-link`. |
| `crew-note-badge` | Visible `Crew note` label on a non-waking human contribution. Its leading `@agent` chips deliberately never carry `addressed`. |
| `new-messages` | The transcript-tail affordance; also carries `pending` while newer rows are waiting below the reader. |
| `operation`, `operations` | Clean-mode tool/delegation status, without arguments or result payloads |
| `structured-hidden` | Clean-mode replacement for a whole JSON or JSON-fenced assistant message |
| `tool-name`, `tool-content` | Debug-only halves of an exact tool row — the content is line-clamped, `::part(tool-content) { -webkit-line-clamp: none }` unclamps it |
| `tool-calls` | Debug-only ` → name(args)` line under an assistant bubble |
| `mention` | A resolved `@handle`; also carries its kind (`agent`, or whatever the app set) |
| `approval`, `approval-text` | The bar and its sentence |
| `typeahead`, `suggestion` | The mention autocomplete and its rows (`suggestion-handle`, `suggestion-detail`) |
| `button` | Every button; also carries `send` / `stop` / `approve` / `deny`; an in-flight send also carries `loading` |
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
const ask = chat.agentInstance.pending(chat.sessionId);
if (ask) chat.agentInstance.deny(
  chat.sessionId, 'the amount is too large', ask.toolCallId,
);
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

## System turns — work that starts without a person

Every other way into a turn is a human action, and a `send` writes a `role:
'user'` row attributed to the session's owner. Scheduled work has no such
person. `systemTurn` is the entry point that does not borrow one:

```ts
const r = await Conditions.systemTurn(sessionId, 'Review the week against the bulletin.', {
  key: 'morning-review@2026-08-25T06:30',   // the same key twice runs once
  source: 'routine',                        // attribution: `s:routine`
});
```

It is server-only, like `ask` — there is no caller to authorize, and a
client-reachable version would start turns that bypass both the turn budget and
the rate limiter.

Four things differ from a `send`, and each is the point:

**The transcript says a machine did it.** The row is `role: 'system'`,
attributed to an `s:<source>` participant that is not in the roster and is not a
person. The model still sees it — projected as a marked message, since no
provider has a mid-conversation system role — but your audit record no longer
claims somebody typed it.

**It waits behind live work instead of being dropped.** A busy session — most
importantly one sitting in `awaiting` on an approval — parks a durable intent
and runs it when the session next goes idle. The intent survives a deploy as
durable evidence; recovery observes it and nudges Activation.

**It spends its own purse.** `budget.systemTurns` is separate from `turns`, and
is spent when the turn commits, not when it is requested — so a turn that never
ran is never billed.

**It does not outrank the team.** A human message clears a pending relay and
resets the hop count; a system turn does neither. Scheduled work is not an
interjection, and it has no standing to cancel a hand-off the team is mid-way
through.

The result says what happened:

```ts
{ ok: true, ran: true }                  // ran immediately
{ ok: true, ran: false, parked: true }   // standing; fires at the next idle
{ ok: false, reason: 'duplicate-key' | 'intent-standing' | 'session-halted'
                   | 'budget-exhausted' | 'no-session' | 'no-agent' }
```

`session-halted` is worth handling: `stopped` and `error` are states a person is
meant to clear, so a park into one is refused rather than left standing forever.

**There is no scheduler here, deliberately.** Cron semantics — local time, DST,
catch-up after downtime, which instance ticks — are business facts, and the app
that has them should keep them. Every instance may tick; derive the same `key`
and exactly one wins.

Full design: `docs/superpowers/specs/2026-08-25-system-turns.md`

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
budget stopped the run, with `reason` naming which. `ask-failed` also withholds
an otherwise successful answer if throwaway cleanup is still pending; durable
lifecycle recovery finishes the fenced erasure rather than falsely returning
while temporary state remains.

If the Agent has an identity, `ask` also enforces its lifecycle and freezes the
same protected Constitution and applicable Practices used by an interactive
Turn. The throwaway Session, transcript, and Memory Frame are erased in
`finally`; Agent-owned Identity, Constitution, Experience, and Practice remain.
Fact Memory is deliberately excluded. When Experience recall is enabled,
`experience_search` remains available against the Frame's frozen evidence. If
`experience.approval` is `ask`, an allowed `experience_propose` reaches its Gate
and parks the headless Turn; `canUse` may instead deny it before parking. With
`auto`, the Experience can be admitted and survive throwaway erasure. Enabled
Practice acquisition may likewise leave a candidate for later review or
validate a trial for later Turns. Configure these automatic effects deliberately:
`ask` has no live reviewer.

Within the protected layer, Constitution is the higher authority. A Practice
applies only when its trigger matches and its guidance remains consistent with
the Constitution; a conflict is resolved in favor of Constitution.

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

It buys two things. Agent configs can name a server-only implementation without
importing it into every config module, and a deployment can swap its backend
behind one registration instead of editing every agent.

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
WhatsApp, SMS, or email — as two adapters over the machinery above. **Inbound** is a
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

Five surface packages ship — `10thfloor:agent-channel-slack`, `-telegram`,
`-whatsapp`, `-sms`, and `-email` — each exactly one lens, one transport and one
profile default, zero npm dependencies; each README carries provider setup.
Server-side `agent.send(sessionId, text, { userId })`,
`agent.approve(sessionId, { userId, expectedToolCallId })` and
`agent.deny(sessionId, reason, { userId, expectedToolCallId })` landed with
channels: the same core the DDP methods call, always
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
| `transport` | **Required.** `{ post(destination, payload, { idempotencyKey, signal? }), reconcile?(destination, idempotencyKey) }` — the provider call itself, supplied by the package so the core never depends on a provider SDK. `post` receives whatever `lens.out` produced, may forward the optional `AbortSignal` to its provider request, and may return `{ providerMessageId }`; `reconcile` answers "did a post under this key already land?" and its presence is what makes `onUncertainDelivery: 'reconcile'` legal. |
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
id (it powers deduplicated admission); `externalUserId` keys the identities
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
reads back as the exact canonical intent), plus two clauses against silence:
the **naming clause** (a rendered item's attachments each appear by name, so a
surface that cannot carry bytes still says the file exists) and the **display
clause** (a prompt carrying `display` shows it — above the raw args, or instead
of them on a surface with no room). It throws with a named failure on the first
violation and returns quietly when the lens holds:

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
| `attachmentNotice(attachments, escape?)` | The naming clause's floor: one `[file attached: …]` line per file, for a surface that carries no bytes. Empty string when there is nothing to name, so call sites append unconditionally. |
| `promptDisplay(display, { limit?, escape? })` | The display clause's floor: the tool's own account of a parked call, trimmed, clamped to the surface's room (never through a surrogate pair) and passed through the surface's own escaping — `describe` is app-authored but routinely interpolates the model's arguments, so it lands in live markup with the same provenance as any other model text. Empty string when the park hydrated none. |
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
committed assistant/note rows and trusted Desktop/Channel human rows
(insert-only, so `added` is the whole story), plus a 15s sweep for everything
no write signals — an expired claim, a parked prompt (a park writes the session
document, which the observer deliberately does not watch). The observer looks
up every binding for a fresh row even when that binding is older than the
sweep's lookback, so an inactive surface does not lose a live fan-out. One
worker, query-sliced, never an observer per conversation:
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
deliverOnce(binding, item | () => Promise<item>, suffix, {
  expects?, afterDelivered?, def?,
})
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

`def` is the channel-author form for a side action that already holds its
Transport, Lens, and uncertain-delivery policy instead of looking them up by
`binding.kind`. `afterDelivered` is narrower still: it reconciles
Session-owned Mongo state after confirmation while the delivery's Lifecycle
operation remains held. It runs for a newly confirmed post **and** for replay
of an already-settled receipt, may be retried by Mongo, and therefore must be
idempotent transactional database work only—no network calls or other side
effects. Use the supplied `ClientSession` on every raw Mongo write. Ordinary
tool bodies need neither option; they should use a registered binding as in the
example above.

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
| `agent_channel_bindings` | `<kind>:<conversationRef>` | Which conversation maps to which session: `destination`, `audience`, `agent`, `sessionId`, `userId`, the opener's `externalUserId` and `assurance`, random `sourceKey` (origin-only echo suppression), `deliveredSeq` (this surface's cursor), `claim` (the delivering worker's lease). One session, many bindings. Inserted **before** the session, so a lost race creates nothing. |
| `agent_delivery_receipts` | `deliver:<bindingId>:<suffix>` | The three-phase intent log: `state` (`sending` \| `sent` \| `abandoned`), `providerMessageId`, `expects` (the reply grammar a prompt delivery registered), `attempts`, `at`. |
| `agent_inbound_submissions` | `<kind>:<eventId>` | Deduplicated admission: one row per admitted provider event. TTL-reaped after a week, which defines the deduplication window. |
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
Session publications preserve `participant.identity.kind` for surface UI but
strip `participant.identity.externalUserId`; raw provider ids remain a
server-side authorization detail. Render the sanitized `displayName`, not an
external address.

**Addressing is mechanical.** A message that starts `@analyst` (or a send
with `extras.to`) runs that model's config — its prompt, tools and provider —
under the *primary's* budget: one purse per conversation. A model whose reply
leads with `@colleague` schedules that colleague's turn — a **relay**,
durable (`pendingRelay` rides the same atomic write as the commit, and Activation
recovery observes and sweeps it) and budgeted (`budget.relay`, default 4 hops,
reset by any human message; the capped reply still delivers, with a note saying
why nothing answered). Model-addressed replies are internal deliberation: the
web transcript shows them, channels skip them.

**Channels admit members by policy.** A binding's `admits` — `'opener'` (the
default, v1's guard verbatim), `'members'` (roster-matched senders, account
or channel identity), `'linked'` (auto-join for linked accounts, the
group-thread path) — gates ingress; the roster gates DDP. Member bindings
(`member: true`, compose's pre-bound recipient) receive outward replies only:
never prompts, statuses, or capability URLs, and the claim-history sweep
skips them. The composed-email loop closes on exactly this machinery — see
the email package's `onReply: 'continue'`.

Desktop-authored human rows (`send` and `contribute`) fan out to attached
Channel bindings as attributed replies (`Name: …` / `Name · crew note: …`).
Channel-originated human rows carry their binding's random `sourceKey` as an
opaque `source.origin`: they advance that exact origin silently and fan out,
once per receipt, to every other binding on the Session — including another
binding of the same Channel kind. Legacy channel rows without an origin and
source-less user rows remain silent because their origin cannot be identified
safely. Assistant egress is unchanged.

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

## Fact Memory

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

**Fact Memory follows the human, not the model.** The default scope is keyed by
`userId` alone, and a turn always runs as the session owner, so every model
participant in a session reads the *same* store. What `support` learns,
`analyst` recalls — sharing is a consequence of the participants model, not a
second feature.

**Two kinds of Fact Memory.** Person memory (`scope: 'user'`) is what the
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

Anonymous sessions write no Fact Memory — not personal memory (a store keyed on
`null` would be one store shared by every anonymous visitor) and not the work
pool (`approve` is optional, so a gate is no guard there). They still read work
memory, and the listing says so plainly. Subagent children and `Agent.ask()`
throwaways get no **Fact Memory**: a child's work folds back into its parent,
which is the Fact-Memory-bearing conversation. An identity-enabled child or
one-shot still receives its Agent-owned Constitution and applicable Practices
through a Memory Frame; that Session-owned Frame is erased with the throwaway.

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

An index provisioned without those `filter` paths rejects every search — the
package warns once naming `updateSearchIndex` and falls to `$text`, so recall
narrows rather than breaking. Capability is probed once and cached, but only a
genuine "no such stage" answer latches: a mongot that is merely slow to start
after a deploy is retried, not written off for the life of the process.

Note that vector and full-text search in MongoDB Community are **preview**
features at the time of writing — the ladder is what makes depending on them
safe.

Full design: `docs/superpowers/specs/2026-08-23-agent-memory-design.md`.

## Agent identity and experiential learning

Fact Memory stores propositions about a person or the work. Agent learning is a
separate, opt-in system for stable identity, expected-versus-observed evidence,
reviewed ways of working, and Turn causality.

```ts
Support.define({
  model,
  instructions,
  identity: {
    id: 'support-agent-v1',
    displayName: 'Support',
    aliases: ['customer-support'],
    constitution: 'Protect customer trust. State uncertainty.',
    flexibility: 4,
  },
  experience: {
    record: true,
    recall: { recent: 12 },
    scope: 'owner',
    approval: 'ask',
  },
  practice: {
    acquire: true,
    approval: 'ask',
    allowScopedEvidencePromotion: false,
  },
});
```

`identity.id` is the durable continuity key. Keep it stable when changing a
registry/display name, model, Team, instructions, or other configuration. A
clone needs a new id. `constitution` seeds immutable revision 1 only when a new
identity has no Constitution; later config drift never silently revises it.
`flexibility` defaults to 3 and limits how many Practices can be hardened at
once.

`experience` requires `identity`:

- `true` enables recording and recall of up to 4 recent Experiences;
- `{ record: false, recall: { recent: 8 } }` is recall-only;
- `{ record: true, recall: false }` records without a search Tool; and
- omitted/`false` disables Experience for that Agent.

`experience.approval` is `ask` by default. Set it to `auto` to admit a
model-authored Experience without parking the Turn; the row records
`admission: 'automatic'` and remains pending post-admission audit.

`practice` also requires `identity`. It is omitted/`false` by default.
`practice: true` enables Agent-authored candidates with approval `ask` and no
scoped-evidence promotion. The object form accepts `acquire`, `approval`, and
`allowScopedEvidencePromotion`; `approval` is independently `ask` or `auto`.

Omitting `identity` disables the identity-owned learning layers; it does not
disable independently configured Fact Memory.

`scope` selects one exact Experience audience for both recording and recall:

- `identity` (the default) uses the stable `identity.id` and intentionally
  shares Experience across every owner and Session using that identity;
- `owner` uses the authenticated Session owner's `userId` and shares only
  across that owner's Sessions; an anonymous owner safely falls back to the
  current Session; and
- `session` confines Experience to the current Session. Forks and child
  Sessions have different keys.

Audiences are exact partitions, not a union: an owner-scoped Turn does not also
recall identity- or session-scoped rows. `identity.id` is therefore the tenant
and privacy boundary for identity scope. A multi-tenant host must allocate a
tenant-distinct identity id or choose a narrower scope. `owner` means the
Session owner—not a roster participant, approver, Tool `runAs`, or model.

Object configuration is strict: Experience accepts only `record`, `recall`,
`scope`, and `approval`.
`record` must be boolean; `recall` must be `false` or an object containing only
`recent`. `recall.recent` must be an integer from 0–20; 0 is equivalent to
`recall: false`. `scope` must be `identity`, `owner`, or `session`. Unknown
options and invalid value types are startup errors. Practice accepts only the
three fields named above, with booleans for `acquire` and
`allowScopedEvidencePromotion`.

The options reserve three Tool names. An app-authored Tool with any of them is
a configuration error:

- `experience_propose` is `gate: 'ask'` by default and `gate: 'auto'` when the
  frozen `experience.approval` is `auto`. Its model arguments are
  `expectationBasis`, `expected`, `observed`, `difference`, `lesson`, `context`,
  and `confidence`. Agent, Session, trigger, committed assistant Message
  (`assistantMessageId`), Tool-call, and Frame provenance are runtime-owned
  closure fields. Audience is also runtime-owned and cannot be selected by
  model arguments. The Provider receives only a recorded/replayed receipt,
  never the durable row's audience key or internal provenance.
- `experience_search` is automatic and returns bounded active evidence from the
  current frozen Frame. Results include `expectationBasis`, which is `explicit`
  (known before the outcome), `inferred` (derived from prior state), or
  `retrospective` (reconstructed after the outcome).
- `practice_propose` is available only when acquisition is enabled and the
  Frame contains Experience evidence. It accepts a key, trigger, guidance,
  context, and exact Experience ids from that Frame. It can create a candidate
  and, under eligible automatic policy, validate it as a trial. It cannot
  harden a Practice.

### Constitution, Experience, Practice, and Frames

The operative split is: **Fact Memory is what the Agent knows; Practice is how
the Agent gets good at the job; Constitution is how the Agent chooses to be.**
Experience supplies reviewable expectation-versus-observation evidence, and a
Memory Frame proves what shaped a Turn. The records therefore have different
jobs and lifecycles:

| Record | Ownership | Mutation rule |
|---|---|---|
| Constitution | Agent | Immutable revision; identity pointer advances with generation CAS |
| Experience | Agent, with exact recall audience | Immutable evidence; `active` may become `retracted` with reason/source |
| Practice | Agent | Immutable content revision; controlled status transitions |
| Memory Frame | Session | Immutable snapshot for one Agent/Session/trigger |

A Practice candidate references exact active, same-Agent, same-context
Experience. A proposal accepts 1–50 distinct, non-empty Experience ids; invalid
or duplicate ids are rejected before evidence is queried, and the accepted list
is sorted into canonical order. The implemented transitions are `candidate →
validated → hardened → retired`, plus `candidate → rejected` and `validated →
retired|rejected`.
Validation rechecks that every proposal evidence id remains active for the same
Agent and context, then records a per-Agent Experience watermark. Hardening
requires the trusted caller to name one exact active same-Agent/same-context
Experience whose sequence is later than that watermark; the framework never
silently selects an eligible row. It consumes one flexibility unit. Retiring a
hardened Practice returns it.

With `practice.acquire`, `practice_propose` may create a candidate from exact
Experience ids in its Memory Frame. `practice.approval: 'ask'` leaves it in
Reviews. `auto` validates it immediately as a trial only when the evidence is
identity-scoped or `allowScopedEvidencePromotion` is true. The row records
`validationAdmission: 'automatic'`; automatic policy has no hardening
Interface.

Practices and Constitution remain identity-wide. Promoting owner- or
session-scoped Experience is therefore a deliberate declassification boundary.
Without explicit scoped-promotion consent, an automatic proposal remains a
candidate. An audience-partitioned hardening proof may still be selected by a
trusted caller; its exact id and audience remain in the audit record.

Retracting evidence does not silently demote a validated or hardened Practice.
`Agent.learning.audit` reports separate review-needed notices for proposal
evidence retracted after application and for retracted hardening evidence, so
host policy can choose a deliberate retirement.

Automatic Experience and validated Practice rows remain pending
post-admission audit until a trusted caller invokes `Agent.learning.review`.
The resulting `review: { at, source, reason? }` acknowledges the record without
changing `admission`, `validationAdmission`, semantic content, or status.
Corrections remain retract/retire plus a replacement revision.

Before provider work, the Turn loop freezes a Memory Frame containing the
active Constitution, applicable validated/hardened Practices, selected active
Experience digests from one persisted exact audience, Fact Memory
evidence/digest, and Learning Governance for Experience admission and Practice
acquisition. The Frame also freezes the protected-prompt renderer version;
retained byte-exact renderers keep unversioned legacy Frames verifiable, while
unknown or explicitly mismatched versions fail closed. Frames are never
backfilled when prompt wording changes. Provider retries, Tool
iterations, approval resume, and recovery adopt the same Frame. Config edits
and newly admitted Experience or Practice apply on the next trigger, never the
Turn that created them. Exact Fact Memory
prompt text stays Turn-local; recovery
re-renders it and fails closed if it no longer matches the Frame.

### Server-only `Agent.learning`

The public server Interface is:

```ts
Agent.learning.ensureIdentity(config)
Agent.learning.reviseConstitution(agentId, expectedGeneration, body, reason, source)
Agent.learning.setLifecycle(agentId, expectedGeneration, 'active' | 'archived', source)
Agent.learning.recordExperience(input)
Agent.learning.retractExperience(agentId, experienceId, reason, source)
Agent.learning.review({ agentId, target: 'experience' | 'practice', id, source, reason? })
Agent.learning.listExperiences(agentId, { limit?, status?, context?, audience? })
Agent.learning.proposePractice(input)
Agent.learning.transitionPractice(agentId, practiceRevisionId, nonHardeningStatus, reason, source)
Agent.learning.transitionPractice(agentId, practiceRevisionId, 'hardened', reason, source, hardeningEvidenceId)
Agent.learning.transitionAllowed(from, to)
Agent.learning.freezeFrame(input)
Agent.learning.protectedPrompt(frameOrId)
Agent.learning.recordProviderRequestDigest(frameId, effectiveRequestDigest, source)
Agent.learning.audit(agentId)
```

`listExperiences` exact-filters by `audience`; omission uses the compatibility
identity audience. An `experience_search` Tool constructed outside a Memory
Frame must receive an explicit resolved audience and fails closed without one.
Trusted app/system/migration `recordExperience` calls still require stable
`source.sessionId` and `source.triggerSeq`. They may set an explicit audience;
omission safely defaults to `{ scope: 'identity', key: agentId }`. Any
Frame-bound record must match that Frame's audience and source tuple.
If `freezeFrame` receives an explicit source, its `sessionId` and `triggerSeq`
must match the Frame tuple; provenance cannot rename the causal owner.

`Agent.learning.read` also provides privileged cursor factories for identities,
constitutions, experiences, practices, Frames, and audit events. They exist so a
host can build a filtered publication without importing private collections.
They enumerate all audience partitions unless the host adds an audience
selector. They are not a browser mutation API, and a host must enforce tenant
authorization and audience filtering before publishing end-user recall data.

Every mutation receives a `LearningSource` with a stable `key`. The source
identity plus canonical command digest is the idempotency contract: the same
logical command adopts prior state; reusing the key for different content
conflicts. A hardening command includes its selected `hardeningEvidenceId`, so
changing the proof while reusing a source conflicts. Mongo transactions commit
the state change and its Learning Event together. Active-identity write fences,
unique indexes, generation/status
selectors, deterministic IDs, and Experience watermarks enforce the first-form
race invariants. If archival wins the Identity fence, a concurrent learning
mutation cannot commit afterward. External model or evaluator cost can still
repeat after an ambiguous crash.

For a model-authored Experience, `frameId` is mandatory. The runtime inherits
the Frame's exact audience, rejects a supplied mismatch, and verifies that
`assistantMessageId` names a committed assistant row in the declared Session and
that the row contains the declared `toolCallId`. An exact replay can still adopt
its durable Experience after Session erasure; a new record cannot rely on
invented transcript provenance.

### Archive, Session erasure, and audit

Agent archival preserves Identity, Constitution, Experience, Practice, and
Learning Events but blocks new Turns and non-lifecycle learning mutations;
explicit lifecycle restoration remains available. Session erasure
deletes Session-owned Frames for the erased root and descendants while retaining
Agent-owned learning and Fact Memory. Audience controls exposure, not durable
ownership: a retained session-scoped Experience becomes unreachable from other
Sessions but remains available to privileged audit/history reads. A retained Experience may therefore point
to deliberately erased Session/Frame provenance. `Agent.learning.audit` reports
that as a notice; a missing Frame for a surviving Session remains an integrity
issue.

An already-running remote provider may finish after a host archives an Agent.
Hosts must re-check current lifecycle before consequential Tool work; archival
does not promise cancellation of computation already streaming elsewhere.

The package never changes Constitution automatically, never treats retracted
evidence as a silent Practice demotion, and does not claim that `hardened` means
true. See [`docs/agent-experience-primer.md`](../../../docs/agent-experience-primer.md)
and [ADR 0001](../../../docs/adr/0001-agent-experience-memory.md) plus
[ADR 0002](../../../docs/adr/0002-automatic-learning-governance.md) for the
complete contract and limitations.

## Scope and stability

The latest `v*` tag is the stable public package surface. This README follows
the current source tree, including candidate Interfaces such as `Agent#erase`;
consult the tagged README when targeting a stable release. The sections above
describe the candidate's supported entry points and their operational caveats.

The extension surface is deliberately small. Use `beforeProviderRequest` and
`afterToolResult` hooks to change provider requests or tool results; use a
custom provider for model transport; use the lens contract for a new channel.
Test loaders, cache probes, and worker internals are not public exports.

Historical decision records live under `docs/superpowers/specs/`. The current
source, generated declarations, and test suite are authoritative.
