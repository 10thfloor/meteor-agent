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

A tool is a Meteor method the model may call. Four ways to give an agent one:

```ts
tools: [
  'orders.lookup',                                  // adopt a method you already have
  { method: 'orders.lookup', description, args },   //   …with a description for the model
  { name: 'total', description, args, run, gate },  // inline: no method, runs in-process
  { subagent: 'researcher', description },          // another agent (see Subagents)
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

Each entry registers two DDP rules: per-(user, connection) so an anonymous
flood only burns its own connection's quota, and per-user for authenticated
callers so opening more connections does not multiply the allowance.

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
streams (`toolArgs` on an in-flight row), and **subagents** — a named agent
behind a tool call, running a child session with a live, persistent transcript
(see **Subagents**).

Sketched in the original design but deliberately NOT implemented (v2
candidates): a global `Agent.provider()` registry, a manual `compact()` call,
`runAs`, and a custom summarizer hook.

See `docs/superpowers/specs/` for the full design.
