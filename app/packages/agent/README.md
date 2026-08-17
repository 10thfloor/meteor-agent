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
  budget: { turns: 20, toolCalls: 40, spend: '$1.00' },  // each optional; see below
  pricing: { input: 3, output: 15 },         // $/Mtok fallback when the provider
                                             // does not report its own cost
  retry: { attempts: 3, baseMs: 500 },       // provider retry with backoff
  approve: ({ userId }) => userId !== null,  // who may answer ask-gates
  provider: mockProvider(...),               // omit for pi-ai
});
```

**Budgets** are the only brake on loop-initiated work. `turns` refuses the
(N+1)th `send` with `budget-exhausted`; `spend` and `toolCalls` stop a running
turn with a `role:'note', kind:'budget'` row in the transcript and
`phase:'stopped'`. Cost prefers the provider's own reported figure (pi-ai
prices cache reads/writes correctly) and falls back to your `pricing` table.

**Provider failures** retry with exponential backoff under `phase:'retrying'`;
auth/request errors fail immediately. Either terminal failure writes a
`kind:'error'` note and sets `phase:'error'`; the next `send` clears it and
tries again. Your transcript UI should render three note kinds: `error`,
`budget`, and `approval`.

**Rate limits** come from settings — this shape in `settings.json`:

```json
{ "packages": { "10thfloor:agent": { "rateLimit": {
  "sends":  { "count": 10, "intervalMs": 60000 },
  "starts": { "count": 5,  "intervalMs": 60000 }
} } } }
```

Each entry registers two DDP rules: per-(user, connection) so an anonymous
flood only burns its own connection's quota, and per-user for authenticated
callers so opening more connections does not multiply the allowance.

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
the request survives a deploy, and the verdict is what resumes the turn. A
denial is answered, not dropped: the model sees the refusal and routes around
it. Who may answer is the session's owner by default; give the agent an
`approve(ctx)` predicate to narrow that further.

One `Agent` instance renders one session at a time: `subscribe()` repoints the
merged view at the session you pass it and evicts the previous one. Construct a
second `Agent` to watch two sessions side by side.

## Testing without an API key

```ts
import { mockProvider } from 'meteor/10thfloor:agent';
Support.define({ model: 'mock', instructions: '…', provider: mockProvider(() => ({ text: 'hi' })) });
```

## Anonymous sessions

Sessions started without a login carry `userId: null` and behave as
capability-URLs: anyone who knows the session id has full access, and no one
can enumerate ids in bulk (`agent.sessions` publishes nothing to anonymous
callers). Two consequences to design for: an anonymous session **stays**
anonymous after the user logs in — it is not adopted by the account, and
remains reachable by anyone holding the id — and inline tools receive
model-supplied arguments unvalidated (adopted Meteor methods keep their own
`check()` calls; validate inline tool args yourself until TypeBox validation
lands in Milestone 3).

## Scope

Milestone 2 shipped the production core: the pi-ai provider (default), retry
and error surfacing, approval gates, budgets and cost accounting, and DDP rate
limits. Still deferred to Milestone 3: compaction, an automatic orphan-claim
watcher (a turn abandoned by a server restart is recovered on the next `send`,
not automatically), TypeBox validation of inline tool args, `Agent.method()`
co-registration, and `Agent.ask()`.

See `docs/superpowers/specs/` for the full design.
