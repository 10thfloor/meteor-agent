# Design: a Pi-based agent harness for Meteor 3.5+

**Date:** 2026-08-15
**Status:** approved design; de-risking spikes run 2026-08-15 (§12); not yet implemented
**Package:** `10thfloor:agent` (Atmosphere, TypeScript)

---

## 1. Thesis

An agent harness needs four things: a durable transcript, a live view of that
transcript, a permissioned set of callable operations, and a loop that survives
restarts. Meteor already ships the first three as collections, publications, and
methods. This package supplies the loop and gets the rest from the framework
instead of rebuilding it.

Concretely: **the transcript is a Mongo collection, streaming is a capped
collection, tools are Meteor methods, and authorization is `this.userId`.**

The harness is for building agents *into* a Meteor application — a user talks to
an agent over DDP. It is not a coding agent that operates on Meteor codebases.

## 2. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Clean-sheet; no dependency on `durable:*` | Any Meteor 3.5 app can adopt it with stock `mongo`, `ddp`, `accounts-base`, `check` |
| 2 | `@earendil-works/pi-ai` for providers; loop written natively | Provider quirks, streaming deltas, prompt caching, reasoning tokens and cost accounting are high-churn and thankless. The loop is where Meteor-ness lives, so we own it. |
| 3 | Capped deltas collection + durable messages collection | O(chunk) on the wire instead of O(n²); cheap self-evicting writes; identical behaviour on 1 server or 12 |
| 4 | Atmosphere package, TypeScript, pi-ai as an app-level peer dependency | `meteor add` ergonomics and `api.mainModule` client/server split; keeps pi-ai's ESM exports map out of Meteor's bundler |
| 5 | API shape: agents are constructed objects, like collections | One new concept; everything downstream is `find`, `subscribe`, and a method call |

### Why pi-ai is a peer dependency, not `Npm.depends`

`Npm.depends` accepts exact versions only and duplicates transitive installs.
More importantly, `@earendil-works/pi-ai@0.84.2` is `"type": "module"` with an
`exports` map, and Meteor has not shipped `exports` support
([PR #13520](https://github.com/meteor/meteor/discussions/11727), open since
late 2024).

**Spike S1 established that a normal `import` cannot work**, and the reason is
one level deeper than expected. Meteor resolves pi-ai itself fine — it declares
`main: ./dist/index.js`, and Meteor's `main` fallback finds it. It then fails on
pi-ai's transitive dependency **`typebox`**, which declares *no* `main` at all:
only an `exports` map pointing at `./build/index.mjs`. Meteor falls back to
`main`, finds none, looks for `index.js`, and reports
`Cannot find module 'typebox'`. Because the break is in a transitive dependency,
no change to our own import style avoids it.

The app still installs pi-ai itself (`meteor npm i @earendil-works/pi-ai`) — a
production `meteor build` does carry it into the bundle (§8) — but it is reached
through a runtime loader rather than an import. See §8.

`engines: node >= 22.19.0` is satisfied — Meteor 3.5 ships Node 24.15.

## 3. Scope

**In scope for v1:** sessions, token streaming, tool calling (inline,
co-registered, adopted), approval gates, steering and interruption, usage and
cost accounting, budgets, context compaction, crash recovery and multi-server
leases, publications, the client cursor API, and a mock provider for tests.

**Deferred to v2:** subagents, Agent Skills / resource loading, MCP client and
server, session forking and branching, an extension API, RPC and print modes,
and any bundled UI components.

**Explicit non-goals:** journal-based replay determinism (that is
`durable:workflow`'s job and the reason it isn't a dependency); a terminal UI;
non-Meteor consumers.

## 4. Architecture

### 4.1 Collections

```ts
// Durable — one document per conversation.
interface AgentSession {
  _id: string;
  agent: string;                 // agent name, e.g. 'support'
  userId: string | null;
  title?: string;
  phase: Phase;
  model: string;
  usage: { input: number; output: number; cost: number };
  pending?: { toolCallId: string; name: string; args: unknown };
  lease?: { serverId: string; until: Date };
  budgetSpent: { turns: number; toolCalls: number };
  createdAt: Date;
  updatedAt: Date;
}

type Phase =
  | 'idle' | 'streaming' | 'calling' | 'awaiting'
  | 'compacting' | 'retrying' | 'stopped' | 'error';

// Durable — the committed transcript. Nothing is written here mid-stream.
interface AgentMessage {
  _id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'note';
  content?: string;
  thinking?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  toolCallId?: string;                       // role: 'tool'
  error?: { error: string; reason?: string };
  kind?: 'compaction' | 'error' | 'budget' | 'interrupted' | 'approval';
  usage?: { input: number; output: number };
  createdAt: Date;
}

// CAPPED (~32 MB, self-evicting) — in-flight tokens only.
interface AgentDelta {
  _id: string;
  sessionId: string;
  messageId: string;             // pre-allocated id of the message being built
  seq: number;
  kind: 'text' | 'thinking' | 'tool_args' | 'tool_output';
  chunk: string;
  at: Date;
}
```

The capped collection is created in `Meteor.startup` via
`db.createCollection(name, { capped: true, size })`, guarded so it is a no-op if
it already exists. Only inserts are ever issued against it — capped collections
forbid growing a document in place, and we never update one.

### 4.2 Turn lifecycle

1. Client calls `Support.send(sessionId, text)` → method `agent.send`.
2. Method authorizes, inserts the `user` message, claims the lease, and
   **returns immediately**. It does not await the turn.
3. The loop builds context from `AgentMessages` (from the most recent
   compaction boundary forward) and opens a pi-ai stream.
4. Chunks are buffered and flushed to `AgentDeltas` every ~60 ms.
5. At message end, the assistant message is inserted into `AgentMessages` under
   a lease-guarded write. Its deltas are now redundant and age out on their own.
6. Tool calls dispatch (§6), streaming their output as deltas and committing as
   `role: 'tool'`.
7. Loop until the model stops requesting tools, a budget trips, or a gate parks
   the run. Set `phase: 'idle'`, release the lease.

Because the method returns before the turn completes, the response reaches the
client reactively through the subscription rather than as a method result. This
is what makes reconnection and multi-tab work without special handling.

### 4.3 Recovery, leases, and signals

Every app server generates a `serverId` at boot (`Random.id()`) and heartbeats
`lease.until` every 10 s for runs it owns, with a 30 s lease.

Every server runs one `observeChangesAsync` watch — riding change streams in
3.5 rather than oplog tailing — over sessions that are (a) unleased or
lease-expired while not `idle`, or (b) leased to itself and carrying a signal.
Claiming is a conditional update on `lease`, so exactly one server wins.

Signals — steer, interrupt, approve, deny, compact — are writes to the session
document, picked up through that same watch. A user who reconnects onto a
different app server, or a deploy that rolls a pod mid-turn, resolves through
Mongo and nothing else. No Redis, no sticky sessions.

**Recovery is not a replay mechanism.** Because assistant messages commit only
at boundaries, an interrupted turn always leaves the transcript ending in `user`
or `tool` — the two states a turn can legally start from. A half-streamed
response existed only in the capped collection. Recovery is therefore "run the
loop again," which is the same code path as a normal turn.

**Approval gates park by exiting, not by blocking.** An `ask` gate writes
`pending`, releases the lease, sets `phase: 'awaiting'`, and ends the loop.
Approval is a signal that starts it again. A run can sit parked across a deploy
or a weekend because no process is held open, and it reuses the resume path
rather than introducing a second one.

### 4.4 Publications and the client merge

The package registers two publications:

```ts
Meteor.publish('agent.session',  function (agent: string, sessionId: string) { … });
Meteor.publish('agent.sessions', function (agent: string) { … });
```

`agent.session` authorizes against `this.userId` and returns three cursors —
the session document, its messages, and its deltas. `agent.sessions` returns
session documents only, for a conversation list.

On the client the package maintains an unnamed client-only collection
(`new Mongo.Collection(null)`) that merges committed messages with live deltas
by `messageId`. `Support.messages(sessionId)` returns a cursor over it, so
consumers get a genuine minimongo cursor — sortable, filterable, and usable
directly from Blaze, React, or Svelte with no adapter.

```
send() ─▶ method ─▶ [AgentMessages] ─▶ lease claim ─▶ loop
                                                       │
  pi-ai stream ──chunks──▶ [AgentDeltas] ──change stream──▶ pub ──▶ merged cursor
                  └─end──▶ [AgentMessages]
```

## 5. Public API

### 5.1 Construction

An agent is constructed by name isomorphically and configured on the server —
the same split as `new Mongo.Collection('tasks')` followed by a server-side
`.allow()`. This keeps tool implementations out of the client bundle.

```ts
// imports/agents.ts — isomorphic, safe to import anywhere
import { Agent } from 'meteor/10thfloor:agent';
export const Support = new Agent('support');

// server/agents.ts — server only
import { Support } from '/imports/agents';
import { Type } from 'typebox';

Support.define({
  model: 'anthropic/claude-sonnet-5',
  instructions: ({ userId }) => `You help user ${userId} with their orders.`,
  tools: ['orders.lookup', 'orders.refund'],
  budget: { turns: 20, toolCalls: 40, spend: '$1.00' },
  context: { window: 200_000, compactAt: 0.8, keep: 6 },
});
```

In a server-only file the shorthand `new Agent('support', config)` is
equivalent. Use the split form whenever client code needs the handle.

### 5.2 Configuration reference

```ts
interface AgentConfig {
  model: string;                                    // 'provider/model'
  instructions: Instr | Instr[];                    // string | (ctx) => string
  tools?: ToolSpec[];
  budget?: {
    turns?: number; toolCalls?: number;
    spend?: string | number;                        // '$1.00' or dollars
    idle?: string;                                  // '30 m' — parked-run expiry
  };
  context?: { window?: number; compactAt?: number; keep?: number };
  canUse?: (tool: string, ctx: ToolContext) => boolean | Promise<boolean>;
  runAs?: string | 'session';                       // default 'session'
  compact?: (msgs: AgentMessage[]) => Promise<string>;
  maxResultChars?: number;                          // default 8000
}
```

`instructions` accepts an array which is concatenated, so shared preamble and
per-agent specifics compose without string juggling.

### 5.3 Client surface (all reactive)

```ts
Support.subscribe(sessionId)                  // wraps Meteor.subscribe
Support.messages(sessionId)                   // Mongo.Cursor — merged transcript
Support.session(sessionId)                    // AgentSession | undefined
Support.status(sessionId)                     // Phase
Support.usage(sessionId)                      // { input, output, cost }
Support.pending(sessionId)                    // PendingApproval | undefined
Support.sessions(selector?)                   // Mongo.Cursor over the user's sessions

await Support.start({ title? })               // → sessionId
await Support.send(sessionId, text)
await Support.interrupt(sessionId)
await Support.approve(sessionId)
await Support.deny(sessionId, reason?)
await Support.compact(sessionId)
```

Everything on the write side is also available on the server, with an explicit
`{ userId }` where the invocation context can't supply one.

### 5.4 Server-only surface

```ts
Support.define(config)
await Support.ask(text, { userId })           // headless one-shot → string
Agent.method(name, def)                       // §6
Agent.provider(name, impl)                    // §8
```

### 5.5 Minimal consumer example

```tsx
function Chat({ sessionId }) {
  const { messages, phase } = useTracker(() => {
    Support.subscribe(sessionId);
    return { messages: Support.messages(sessionId).fetch(), phase: Support.status(sessionId) };
  }, [sessionId]);

  return (
    <>
      {messages.map(m => <Message key={m._id} {...m} />)}
      {phase === 'streaming' && <Cursor />}
      <Composer onSend={t => Support.send(sessionId, t)} />
    </>
  );
}
```

## 6. Tool model

The loop executes every tool inside
`DDP._CurrentMethodInvocation.withValue({ userId, isSimulation: false }, fn)`.
In Meteor 3 that environment variable is backed by `AsyncLocalStorage`, so it
survives every `await` inside the handler. The consequence is the point of the
whole design: **`this.userId` and `Meteor.userAsync()` work inside an existing,
unmodified method handler, because the agent invokes it the way DDP does.**

Spike S2 confirmed all of this on 3.5, and simplified it: a **plain object**
suffices as the invocation — no `DDPCommon.MethodInvocation` construction and no
dependency on the `ddp-common` package. `_CurrentMethodInvocation` is the
correct accessor (`_CurrentInvocation` also exists; both are objects). Context
survived timer, Mongo, microtask, and `Promise.all` awaits, unmodified sync and
async method handlers both saw the right `this.userId`, and four interleaved
concurrent runs stayed isolated with no leakage.

One caveat S2 surfaced: `Meteor.userId()` is contributed by `accounts-base`, not
by core `meteor`. The harness reads userId through the environment variable
directly so it does not hard-depend on `accounts-base`; apps that have it get
`Meteor.userId()` working inside tools for free.

Three ways a tool comes to exist:

```ts
// 1. Inline — agent-only helpers no UI ever calls.
{ name: 'search', description: '…',
  args: Type.Object({ q: Type.String() }),
  run: async ({ q }, ctx) => … }

// 2. Co-registered — one definition, two callers.
export const lookupOrder = Agent.method('orders.lookup', {
  description: 'Look up an order by id',
  args: Type.Object({ orderId: Type.String() }),
  run: async ({ orderId }) => Orders.findOneAsync(orderId),
});
// Registers a real Meteor method and returns a ToolSpec handle. UI calls
// Meteor.callAsync('orders.lookup', …); the agent lists either 'orders.lookup'
// or the returned `lookupOrder`. Same code, same validation, same rate limits.

// 3. Adopted — an existing method you don't want to touch.
{ method: 'orders.refund', description: '…',
  args: Type.Object({ orderId: Type.String() }) }
```

Schemas are TypeBox, which pi-ai already depends on, so one declaration yields
both the JSON Schema the model sees and the TypeScript argument types on `run`.

**Note on adopted methods:** `check(arg, Pattern)` executes inside the handler
body at runtime and cannot be introspected, so an adopted method's schema must
be supplied at the tool site. Its `check` calls still run — they are simply a
second, independent validation rather than the schema source.

## 7. Permissions, gates, and rate limiting

Per-tool `gate`: `'auto'` (default), `'ask'` (parks per §4.3), or a predicate
`(ctx) => boolean | 'ask'`. Agent-wide, `canUse(tool, ctx)` is the backstop.
Tools run as the session's user unless `runAs` says otherwise.

Rate limiting is Meteor's, not ours. `DDPRateLimiter.addRule` gained async
matchers in 3.5, so a per-user turn budget is a rule whose matcher performs a
database lookup — enforced at the DDP layer before the method body, with no
harness code involved.

Configuration follows the `Meteor.settings.packages['10thfloor:agent']`
convention that 3.5 itself uses for `packages.mongo.reactivity`. Provider
credentials are read server-side only and are never part of `settings.public`.

## 8. Providers and the ESM firewall

```ts
interface Provider {
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
}
Agent.provider(name, impl);
```

Exactly one server-only module reaches pi-ai. Nothing else in the package knows
it exists. Per S1 that module cannot use `import` — it uses a runtime loader.

**The loader, as validated by S1.** Three approaches were tested; only the third
works:

| Approach | Result |
|---|---|
| `import '@earendil-works/pi-ai'` (static) | ✗ `Cannot find module 'typebox'` at runtime |
| `new Function('s','return import(s)')` | ✗ `A dynamic import callback was not specified` — Meteor's server bundle is CJS, so that context has no host import callback |
| `createRequire(...)('@earendil-works/pi-ai')` | ✗ `ERR_PACKAGE_PATH_NOT_EXPORTED` — pi-ai's exports map declares only an `import` condition, no `require` |
| **`.mjs` shim required via `createRequire`** | ✓ works in dev *and* in a production bundle |

The working mechanism: write a one-line ESM shim
(`export const load = (s) => import(s);`) into a `node_modules/.agent-loader/`
directory, load it with Node's own `createRequire`, and call `load()`. Because
the shim is a genuine ESM module it *has* a dynamic-import callback, and Node's
resolver — which does understand exports maps — handles pi-ai and its whole
transitive graph, `typebox` included.

`new Function` is not used. The shim body is a fixed literal written by the
package; the specifier is always a package-controlled constant and must never
come from user input or model output.

**Locating `node_modules` differs between dev and production**, and S1 caught
this: a production `meteor build` places app npm dependencies under
`programs/server/npm/node_modules`, not `programs/server/node_modules`. The
loader walks up from `process.cwd()` checking **both** names. Verified against a
real `meteor build --server-only` bundle: 46 exports, working subpath import,
and a usable TypeBox schema
(`{"type":"object","required":["orderId"],"properties":{"orderId":{"type":"string"}}}`).

The loader runs once at startup and caches the namespace, so per-call cost is
zero.

The same seam carries `mockProvider(script)`: a deterministic scripted provider
that makes the entire harness testable with no API key and no network — and,
usefully, with no loader involved at all.

## 9. Compaction and budgets

When estimated context exceeds `context.window * context.compactAt`, the loop
enters `phase: 'compacting'`, summarizes everything older than the last
`context.keep` messages, and commits a `role: 'note', kind: 'compaction'`
message. Context assembly begins at the most recent compaction boundary.

Compaction changes only what the model sees. The full transcript stays in
`AgentMessages` and the UI keeps rendering all of it, with the compaction shown
inline as a marker.

Budgets are checked before each model call and each tool call. Tripping one
commits a `kind: 'budget'` note and sets `phase: 'stopped'`. Spend is computed
from per-turn usage against the model's pricing.

## 10. Error handling

| Failure | Behaviour |
|---|---|
| Provider 429 / 5xx / network | Backoff retry, `phase: 'retrying'`, N attempts, then an error note |
| Provider 401 / 400 | No retry — error note, `phase: 'error'` |
| Tool throws `Meteor.Error` | Becomes a tool result carrying `error`, fed back to the model, which usually recovers |
| Tool throws anything else | Sanitized before entering the transcript — the transcript is published to a client |
| Budget exceeded | `kind: 'budget'` note, `phase: 'stopped'` |
| Lease lost mid-turn | Abandon silently; the claimant redoes the turn |

**The sharpest edge in this design** is the last row: two servers driving one
run means double provider spend and duplicate messages. Every commit is
therefore a conditional write guarded on lease ownership, and a server that
loses the guard aborts rather than writes. A 30 s lease with a 10 s heartbeat
keeps the window small, but the guard — not the timing — is what makes it
correct.

## 11. Testing

- `mockProvider(script)` drives deterministic end-to-end tests with no API key.
- `meteortesting:mocha` as the driver, matching existing practice in this
  codebase.
- Server tests cover the loop, gates, budgets, compaction, and lease handoff.
- A two-server test instantiates two loop runners with distinct `serverId`s
  against one Mongo instance and asserts exactly-once commits under a forced
  lease expiry.
- Client tests cover the delta/message merge, including out-of-order delta
  arrival and eviction of a delta whose message already committed.

## 12. De-risking spikes — RUN, 2026-08-15

All four ran against a real Meteor 3.5.0 app (Node 24.15.0, MongoDB via
`meteor run`). Spike source is in `spike/` at the repo root.

| # | Spike | Result |
|---|---|---|
| S1 | Import `@earendil-works/pi-ai` from a Meteor 3.5 server module | ✗ **failed as specified** — resolved via a runtime loader instead (§8). Root cause was the transitive dep `typebox`, not pi-ai. |
| S2 | `DDP._CurrentMethodInvocation.withValue` propagates `userId` across awaits | ✓ **passed**, and simplified the design — a plain object works, no `DDPCommon` |
| S3 | Capped-collection eviction visible through `observeChangesAsync` | ✓ **passed** — 120 inserted, 107 evicted, 107 `removed` events; evictions *are* in the oplog |
| S4 | Exactly-once commit under two racing runners | ✓ **passed** — 200 iterations, 0 double claims, 0 lost claims, 0 double commits, exactly 200 messages |

**S1 changed the design** (see §2 and §8): pi-ai is reached through a runtime
`.mjs` shim loader rather than an `import`, and the loader must check both
`node_modules` and `npm/node_modules` to work in production. It did not change
decision 2 or 4 — pi-ai is still the provider layer and still an app-level peer
dependency.

**S2 simplified §6** and confirmed the tools-are-methods premise, which was the
highest-risk assumption in the design.

**S3 and S4 confirmed their sections as written**, with no changes. S3 in
particular removes the fallback-to-TTL-collection contingency.

Remaining risks, not addressed by spikes:

- pi-ai is pre-1.0 (0.84.2); its API may move. The provider seam in §8 is the
  containment.
- The loader depends on Meteor's server bundle staying CJS and on Node's
  `require()` of a local `.mjs` file. Both are stable today; a Meteor move to
  native ESM output would *simplify* this, not break it, but the loader should
  try a plain `import()` first and fall back to the shim.
- Compaction quality is model-dependent and needs tuning against real
  transcripts.
- Capped-collection sizing is a tuning problem: too small and a slow subscriber
  can miss deltas for a message still streaming. Committed messages always
  arrive, so the failure mode is a stutter rather than data loss, but the
  default size should be derived from expected concurrency.

## 13. Open items

The package name `10thfloor:agent` is a working title chosen from the existing
GitHub organization. Changing it is a one-line edit in `package.js` plus import
paths; it does not affect any decision above.
