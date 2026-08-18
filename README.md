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
<!-- client: the whole chat UI, if you want it -->
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

That cursor updates token by token as the model streams, works identically in
Blaze, React, and Svelte, and needs no client-side AI library at all. The
demo app's first chat UI was ~70 lines of plain DOM.

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
  itself and reruns; a half-streamed response ages out of a capped collection
  on its own.
- **Humans stay in the loop without holding a process open.** A tool marked
  `gate: 'ask'` *parks* the run — no timer, no waiting promise — and survives
  deploys until someone approves, denies, or a timeout does. Approval is a
  single-winner conditional write; two racing approvers get one winner.
- **Cost has brakes.** Turn, tool-call, and dollar budgets are enforced
  before the spend they govern; provider-reported cost is preferred over
  price-table math; DDP rate limits guard every entry point.

## What's in the box

| | |
|---|---|
| **Streaming** | Token deltas through a capped collection — O(chunk) on the wire, merged client-side into one ordered cursor |
| **Durability** | Lease + heartbeat + atomic seq allocation; repair-on-entry; an orphan-claim watcher; interrupt actually aborts the HTTP request |
| **Providers** | [pi-ai](https://github.com/earendil-works/pi) by default (Anthropic, OpenAI, Google, Bedrock, OpenRouter…) — or any object with a `stream()` method, including the bundled deterministic mock |
| **Tools** | Adopted Meteor methods, inline functions, co-registered method+tool pairs, **MCP servers**, and other agents |
| **Approval gates** | Park-by-exiting, approve/deny from the client, timeouts, audit rows in the transcript |
| **Subagents** | A named agent behind a tool call: real child sessions with live transcripts, composed budgets, a depth guard |
| **Forking** | Branch any conversation at a batch-safe point and diverge |
| **Compaction** | Long conversations summarize themselves; the model's view shrinks, the transcript keeps everything |
| **Skills & hooks** | On-demand prompt fragments; `beforeProviderRequest` / `afterToolResult` as the extension surface |
| **UI** | `<agent-chat>` — one tag, shadow DOM, themable via CSS custom properties and `::part()` |
| **Validation** | Model-supplied tool arguments checked against full JSON Schema (typebox), fail-closed on public endpoints |

## Quick start

```bash
meteor add 10thfloor:agent            # (not yet on Atmosphere — see Status)
meteor npm install --save @earendil-works/pi-ai
export ANTHROPIC_API_KEY=sk-...       # or OPENAI_API_KEY, etc.
```

Define an agent on the server, drop `<agent-chat>` on a page (after calling
`defineAgentChat()`), and you have a streaming, tool-using, human-gated agent.
The **[package README](app/packages/agent/README.md)** is the full API
reference — config surface, tools, budgets, gates, subagents, MCP, skills,
hooks, theming, and the operational notes that matter in production.

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

Five documents' worth of design reasoning — the lease model, the repair
invariants, the approval-gate semantics, why the merge walks backward — live
in [`docs/superpowers/specs/`](docs/superpowers/specs/), and every mechanism
was built against failure-injection tests (lease steals mid-stream, crashes
between a tool call and its result, racing approvers, jittered retries). The
review history that shaped the invariants is preserved in the milestone plans
alongside the spec.

## Project layout

```
app/packages/agent/   the package (this is what ships)
app/                  host app: test harness + the demo chat
docs/superpowers/     design spec + per-milestone implementation plans
scripts/verify-build.sh   proves the loader against a real production bundle
```

Development workflow, the test command, and the npm-dependency policy
(pi-ai is pre-1.0; every claim about it is probed, never guessed) are in
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

CI runs the full suite plus a production-bundle verification on every push.

Honest caveats: the package is **not yet published to Atmosphere** (install
from this repo until then), and the live-provider smoke test is the one test
that needs a real API key — everything else is verified network-free. A whole-
repo code review and a dedicated security review close the milestone; their
findings and the remaining v4 candidates are tracked in the repo.

## License

[MIT](LICENSE)
