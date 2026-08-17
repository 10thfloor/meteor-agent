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

A tool is a Meteor method the model may call. Three ways to give an agent one:

```ts
tools: [
  'orders.lookup',                                  // adopt a method you already have
  { method: 'orders.lookup', description, args },   //   …with a description for the model
  { name: 'total', description, args, run, gate },  // inline: no method, runs in-process
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

Inline tools are checked the same way. The shipped checker is deliberately
minimal — `type`, object `required`/`properties`, and array `items` — and
accepts anything it cannot model, so it only ever rejects arguments that are
structurally wrong. A tool that needs more should adopt a real method and keep
its own `check()`, or the app can install a full JSON Schema validator:

```ts
import { setToolArgsValidator } from 'meteor/10thfloor:agent';
setToolArgsValidator((schema, args) => (myCheck(schema, args)
  ? { ok: true } : { ok: false, reason: 'field "id" must be a string' }));
```

A `reason` is fed back to the model and stored in the published transcript, so
name the offending field — never echo its value.

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

## Use it from the client

```ts
const sessionId = await Support.start();
Support.subscribe(sessionId);
await Support.send(sessionId, 'where is my order?');

Support.messages(sessionId).fetch();   // reactive, includes in-flight tokens
Support.status(sessionId);             // 'idle' | 'streaming' | 'calling' | …
```

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

## Headless one-shots, and composing agents

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
also a legal tool body — which is how agents compose:

```ts
const Researcher = new Agent('researcher', { model, instructions, tools: [] });

Writer.define({
  model, instructions,
  tools: [{
    name: 'research', description: 'Ask the researcher', args: schema,
    run: ({ topic }, ctx) => Researcher.ask(topic, { userId: ctx.userId }),
  }],
});
```

The inner run is a session of its own, so the outer agent's `toolCalls` budget
limits how often the specialist is consulted and the specialist's own budget
limits what each consultation may spend.

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
caller" matches nothing. Model-supplied arguments are structurally checked
against the tool's schema before dispatch (see **Tools**), but a check is not
an authorization: a tool reachable by an anonymous session should decide what
it will do for a caller with no user at all.

## Scope

Milestone 2 shipped the production core: the pi-ai provider (default), retry
and error surfacing, approval gates, budgets and cost accounting, and DDP rate
limits. Milestone 3 completed the working surface: compaction, an interrupt
that cancels the provider request, the orphan-claim watcher with approval
timeouts, the finished tool surface — `Agent.method()` co-registration and
validated tool arguments (a minimal structural checker: a co-registered schema
leaning on `$ref`/`oneOf`/`enum`/bounds is REJECTED at registration unless a
full validator is installed via `setToolArgsValidator`) — plus `Agent.ask()`
for headless one-shots and agent composition, the `canUse` tool backstop,
`maxResultChars` truncation, client teardown via `stop()`, rate limiting for
`agent.interrupt`, and the production-bundle verification sweep
(see **Verifying a production build**).

Sketched in the original design but deliberately NOT implemented (v2
candidates): a global `Agent.provider()` registry, a manual `compact()` call,
`runAs`, and a custom summarizer hook.

See `docs/superpowers/specs/` for the full design.
