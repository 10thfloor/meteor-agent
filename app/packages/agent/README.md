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
lands in Milestone 2).

## Scope

`provider` is optional: leave it out and the agent streams through pi-ai;
supply one for a mock or a custom backend. Still deferred: budgets and cost
accounting, compaction, an automatic orphan-claim watcher (a turn abandoned by a
server restart is recovered on the next `send`, not automatically), and
`DDPRateLimiter` rules on `agent.send`.

See `docs/superpowers/specs/` for the full design.
