# Multi-Agent Slack Threads with 10thfloor:agent

A hands-on guide to building n humans × n models conversations in Slack using the participants model.

---

## What We're Building

By the end of this tutorial you'll have a Slack workspace where users can talk to **multiple AI agents in the same thread** — a support agent that handles customer questions and an analyst agent that digs into data. Users mention `@support` or `@analyst` to direct their question, and the agents can hand work to each other with `@`-relays.

One Slack thread, multiple humans, multiple models, all durable and attributed.

**Prerequisites:**
- A Meteor 3.5+ app with `10thfloor:agent` installed
- A Slack workspace you control (you'll need a bot token and signing secret)
- `10thfloor:agent-channel-slack` added to your app

```bash
meteor add 10thfloor:agent 10thfloor:agent-channel-slack
meteor npm install --save @earendil-works/pi-ai typebox
```

---

## Module 1 — Define Your Agents

First things first — let's register the two agents. Each one gets its own model, instructions, and toolset. The agent name is how Slack users will `@`-mention them, so keep it short and clear.

```ts
// imports/agents.ts — isomorphic (both client and server will import this)
import { Agent } from 'meteor/10thfloor:agent';

export const Support = new Agent('support');
export const Analyst = new Agent('analyst');
```

Now the server-side definitions where the real config lives:

```ts
// server/agents.ts
import { Support, Analyst } from '/imports/agents';

Support.define({
  model: 'anthropic/claude-sonnet-5',
  instructions: ({ userId }) =>
    `You are a customer support agent. Be friendly, concise, and helpful.
     When a question requires data analysis, hand it to your colleague
     by starting your reply with @analyst.`,
  tools: ['orders.lookup', 'orders.refund'],
  budget: { turns: 20, toolCalls: 40, relay: 4 },
});

Analyst.define({
  model: 'anthropic/claude-sonnet-5',
  instructions: ({ userId }) =>
    `You are a data analyst. You answer questions with numbers and evidence.
     When the user needs a direct action (refund, cancellation, etc),
     hand it to @support — you observe, you don't act.`,
  tools: ['analytics.query', 'analytics.chart'],
  budget: { turns: 20, toolCalls: 40, relay: 4 },
});
```

The `relay` budget is key here — it caps how many times agents can hand work back and forth before a human has to say something. Default is 4, which is plenty for a support-then-analysis round trip without letting two chatty agents loop forever.

---

## Module 2 — Wire Up Slack

The Slack channel package handles webhook verification, message parsing, and delivery. You register one channel per bot token, and name the primary agent it's attached to.

```ts
// server/channels.ts
import { Agent } from 'meteor/10thfloor:agent';
import { slack } from 'meteor/10thfloor:agent-channel-slack';

Agent.channel('slack', slack({
  agent: 'support',                     // the primary — gets unaddressed messages
  botToken: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
}));
```

**Two things to notice:**

1. We set `agent: 'support'` — that means when someone sends a message without `@`-mentioning a specific agent, the support agent answers. It's the default.

2. The bot token and signing secret come from your Slack app's config page. Never hardcode these — environment variables or Meteor settings.

### Slack App Setup

Head to [api.slack.com/apps](https://api.slack.com/apps), create an app, and configure:

**Event Subscriptions** — Point the request URL at your Meteor server:
```
https://your-app.example.com/channels/slack/events
```

Subscribe to these bot events:
- `message.im` — direct messages to your bot
- `app_mention` — when someone `@`-mentions your bot in a channel

**OAuth Scopes** — Your bot needs:
- `chat:write` — send messages
- `files:read` — download shared files (for media ingest)

**Install to workspace**, grab the bot token (`xoxb-...`), and copy your signing secret from Basic Information.

---

## Module 3 — How Sessions Start

When a user DMs the bot or mentions it in a channel thread, the harness creates a session automatically. Here's what happens under the hood:

1. Slack posts the event to your webhook
2. The channel verifies the signature (HMAC-SHA256, 5-minute replay window)
3. The lens parses the event into an `InboundReading`
4. Ingress finds or creates a session based on the conversation key

**Conversation keys** work like this:
- **DMs** key by `team:channel` — one ongoing session per user
- **Channel threads** key by `team:channel:threadTs` — each thread is its own session

This means every Slack thread is a separate, durable conversation with its own transcript, participants, and state.

---

## Module 4 — Adding the Second Agent

A brand new session is a classic 1:1 pair — one human, one model. The roster doesn't even exist yet (it's an optional field). The moment you add a second participant, the roster materializes with the original pair plus your new member.

You have two ways to bring the analyst agent into a conversation:

### Option A — Programmatic join (a tool does it)

Give the support agent a tool that adds colleagues to the conversation:

```ts
// server/tools.ts
import { Agent } from 'meteor/10thfloor:agent';

Agent.method('team.invite', {
  description: 'Invite another agent into this conversation',
  args: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        enum: ['analyst'],
        description: 'Which agent to invite',
      },
    },
    required: ['agent'],
  },
  async run({ agent }) {
    const sessionId = this.sessionId;
    const agentName = agent;

    const participantId = await Agent.participants.add(sessionId, {
      id: `m:${agentName}`,
      kind: 'model',
      role: 'member',
      agent: agentName,
    }, { by: `m:support` });

    if (!participantId) {
      return { error: 'Could not add — session full or not found' };
    }
    return { joined: agentName };
  },
});

// Add it to support's toolset
Support.define({
  // ...existing config...
  tools: ['orders.lookup', 'orders.refund', 'team.invite'],
});
```

With this, the support agent can decide on its own when to bring in the analyst. Once the tool runs, the analyst is on the roster and can be `@`-mentioned.

### Option B — Pre-register both at session start

If you always want both agents available, use the `afterStart` hook to seed the roster on every new session:

```ts
// server/hooks.ts
import { Agent } from 'meteor/10thfloor:agent';

Support.on('afterStart', async ({ sessionId }) => {
  await Agent.participants.add(sessionId, {
    id: 'm:analyst',
    kind: 'model',
    role: 'member',
    agent: 'analyst',
  }, { by: 'm:support' });
});
```

Now every conversation starts with both agents ready to go.

---

## Module 5 — Addressing: Who Gets the Question?

Here's where it gets fun. Once a session has multiple model participants, addressing controls who answers.

### The `@`-mention rule

A user types in Slack:

```
@analyst what were our top 5 products last month?
```

The harness sees that leading `@analyst`, matches it against the roster's model participants, and routes the turn to the analyst agent. The analyst's config (model, instructions, tools) runs the turn, but the budget comes from the primary (support) — one purse per conversation.

**No `@`-mention?** The primary agent answers. That's the `agent: 'support'` you set in the channel config. Unaddressed messages always go to the default.

### What each agent sees

This is important to get right mentally. When the analyst takes a turn, its provider view shows:

- Its own prior responses as `assistant` rows (the normal way)
- The support agent's final responses as attributed `user` rows — like `[support]: I've processed the refund.`
- The support agent's tool calls, thinking, and working? **Dropped.** Each agent sees colleagues' spoken conclusions, not their scratch work.
- Human messages show up with names when there are 2+ humans or 2+ models — like `[Alex]: what about last quarter?`

This keeps each agent's context window clean. The full transcript lives in Mongo — your web UI renders everything — but each model's view is filtered to what's useful.

---

## Module 6 — Relays: Agents Handing Off to Each Other

A relay is when one agent's reply starts with `@colleague` — it schedules the colleague's turn automatically. No human intervention needed.

Here's a typical flow:

```
User:      Hey, I want to return order #4521
Support:   Let me look that up. [calls orders.lookup]
Support:   Order #4521 is a pair of headphones from March 12.
           @analyst can you check if this customer has a return pattern?
Analyst:   Looking at their history... 2 returns in the last 6 months,
           both within policy. No unusual pattern.
           @support looks clean — go ahead with the return.
Support:   All good — I'll process that refund now.
           [calls orders.refund]
Support:   Done! Your refund of $89.99 will appear in 3-5 business days.
```

**What happened under the hood:**

1. Support's reply committed with a leading `@analyst`
2. The harness wrote a durable `pendingRelay` on the session — `{ agent: 'analyst', seq: <commitSeq> }`
3. The analyst's turn fired, consumed the relay, and ran with the analyst's config
4. The analyst replied with `@support`, scheduling another relay back
5. Support's turn fired and finished the job
6. The relay counter went 1 → 2. Each human message resets it to 0.

**The relay budget** (`budget.relay`, default 4) caps how many hops happen before requiring a human message. When the cap is hit, the model's reply still commits and delivers to Slack, but no relay is scheduled. The conversation just waits for the user.

This is a note, not a hard stop — the session stays `idle`, not `stopped`. The user's next message resets the counter and everything continues.

### Relays are durable

If your server crashes mid-relay, the watcher picks it up. `pendingRelay` is written atomically with the committing turn's message allocation — same Mongo update, same document. The watcher's sweep finds sessions in `idle` phase with a standing `pendingRelay` and fires the deferred turn. No relay is ever lost to a restart.

### Relay messages stay off Slack

A relay-addressed turn (where `to` names a model participant) is internal deliberation. The channel planner skips it — Slack users see the final outward reply, not every intermediate `@analyst` hand-off. This keeps the thread clean.

---

## Module 7 — Adding Human Participants

The same roster that holds model participants holds humans. You can add Slack users to the roster so they're recognized when they join the thread.

```ts
await Agent.participants.add(sessionId, {
  id: `x:slack:${slackUserId}`,
  kind: 'human',
  role: 'member',
  identity: { kind: 'slack', externalUserId: slackUserId },
  displayName: 'Dana',
}, { by: `h:${ownerId}` });
```

### How admission works

When a new person jumps into a Slack thread, the channel's `admits` setting controls what happens:

```ts
Agent.channel('slack', slack({
  agent: 'support',
  botToken: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  admits: 'members',        // only roster members can participate
  // admits: 'opener',      // default — only the person who started the thread
  // admits: 'linked',      // anyone with a linked account auto-joins
}));
```

**`'opener'`** (default) — Only the user who started the thread can send messages. Everyone else gets a silent 200 (no error, no response — Slack doesn't even know it was ignored).

**`'members'`** — Anyone on the roster can participate. You control who's on the roster with `Agent.participants.add`. A Slack user whose identity matches a roster row is admitted and their message is attributed with `from`.

**`'linked'`** — Anyone with a linked account auto-joins the roster when they first message the thread (up to the 16-participant cap). This is the open-door policy for group threads.

### The via principal

When a Slack user who isn't the session owner sends a message, the channel ingress can't hand them a `userId` (they don't have a Meteor account — they have a Slack identity). Instead, it passes a **`via`** — a verified identity that the harness uses for one-shot authorization:

```ts
// This happens internally — you don't write this code.
// The channel ingress does it for you.
sendToSession(agent, sessionId, text, null, {
  via: { kind: 'slack', externalUserId: 'U024BE7LH' },
});
```

The `via` matches against the roster's `identity` field. It grants standing to send a message — nothing more. No DDP capability, no approval authority, no subscription access. The member speaks through the channel, and the channel vouches for who they are.

---

## Module 8 — The System Prompt: What Agents Know

When a session has a roster, the harness appends a participants block to the system prompt on every iteration. You don't write this — it's automatic:

```
You are 'analyst'. In this conversation:
Alex (human, owner), Dana (human, member), support (model), analyst (model).
Address a model colleague by starting your reply with @name.
```

This block is rebuilt every iteration from the live session document, so mid-turn roster changes (a compose join, a new member admitted) are visible at the next model call. Your static `instructions` config stays static — the harness layers the participants context on top.

If the session has no roster (classic 1:1), no block is appended. The system prompt is byte-identical to what it was before participants existed.

---

## Module 9 — A Full Example: Support Desk

Let's put it all together. Here's a complete setup for a two-agent support desk on Slack.

```ts
// imports/agents.ts
import { Agent } from 'meteor/10thfloor:agent';

export const Support = new Agent('support');
export const Analyst = new Agent('analyst');
```

```ts
// server/agents.ts
import { Support, Analyst } from '/imports/agents';

Support.define({
  model: 'anthropic/claude-sonnet-5',
  instructions: `You are a customer support agent for Moonbeam Electronics.
    You help customers with orders, returns, and product questions.

    You have a colleague — analyst — who can pull up data, run queries,
    and spot trends. When a question needs data work, hand it off:
    start your reply with @analyst and describe what you need.

    Always tell the customer what's happening. Don't just silently
    hand off — say "Let me check with our data team" first.`,
  tools: [
    'orders.lookup',
    'orders.refund',
    {
      name: 'invite_analyst',
      description: 'Add the analyst agent to this conversation for data questions',
      args: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const id = await Agent.participants.add(this.sessionId, {
          id: 'm:analyst',
          kind: 'model',
          role: 'member',
          agent: 'analyst',
        }, { by: 'm:support' });
        return id ? { joined: 'analyst' } : { note: 'analyst already present' };
      },
    },
  ],
  budget: { turns: 30, toolCalls: 60, relay: 4, approval: 300000 },
});

Analyst.define({
  model: 'anthropic/claude-sonnet-5',
  instructions: `You are a data analyst for Moonbeam Electronics.
    You answer questions with numbers, charts, and evidence.
    You never take actions (refunds, cancellations) — that's support's job.
    When you've answered the data question, hand back to @support
    with a summary of what you found.`,
  tools: ['analytics.query', 'analytics.chart'],
  budget: { turns: 30, toolCalls: 60, relay: 4 },
});
```

```ts
// server/channels.ts
import { Agent } from 'meteor/10thfloor:agent';
import { slack } from 'meteor/10thfloor:agent-channel-slack';

Agent.channel('slack', slack({
  agent: 'support',
  botToken: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  admits: 'linked',   // any linked Slack user can jump into a thread
}));
```

```ts
// server/main.ts — make sure everything loads
import './agents';
import './channels';
```

### What a Slack thread looks like

```
[Alex]       Hey, I got charged twice for order #8812

[Support]    Let me look that up for you.
             Order #8812: Bluetooth speaker, $49.99, placed June 3.
             I see a single charge on our end — let me get our data
             team to double-check.
             @analyst can you verify the charge history for order #8812?

[Analyst]    Checking the payment records...
             Order #8812 shows one successful charge of $49.99 on June 3
             at 14:22 UTC. There's a second auth hold from 14:21 that
             was voided — this sometimes shows as a pending charge on
             the customer's statement for 3-5 business days.
             @support it's an auth hold, not a double charge.

[Support]    Good news — you weren't charged twice! Your bank placed a
             temporary authorization hold that should disappear within
             3-5 business days. If it's still showing after that, let
             me know and I'll look into it further.
```

Alex sees a clean, natural conversation. Behind the scenes: three turns, two relays, one session, full attribution in the transcript.

---

## Module 10 — Removing Participants

Sometimes you need to remove an agent or a human from a conversation:

```ts
await Agent.participants.remove(sessionId, 'm:analyst');
```

What this does:
- Removes the roster row
- Deletes any `member: true` channel bindings for that participant (so they stop receiving messages)
- The channel stops admitting their identity on the next inbound event

What this **doesn't** do:
- You can't remove the owner. Ownership transfer isn't supported — if you try, it throws.
- It doesn't rewrite history. The transcript still shows everything they said while they were present.

---

## Module 11 — Media in Slack Threads

When a Slack user shares a file in a thread, the harness fetches it automatically. The channel's `media` config handles the credentials:

- Host allowlist: `files.slack.com` only (SSRF protection)
- Auth: the bot token as a Bearer header
- Size gate: files over the per-file cap get a note instead of a fetch
- Failed fetches (deleted files, expired URLs): a note in the transcript, never a crash

The agent sees the file as an attachment ref in the transcript. If the agent's model supports images (`Provider.capabilities.imageInput`), the agent can read image files using the `read_attachment` tool — the harness hydrates the bytes at request time, not upfront.

```
[Alex]       Here's a screenshot of the double charge [screenshot.png]

[Support]    Let me take a look at that screenshot.
             [calls read_attachment for screenshot.png]
             I can see both charges on your statement...
```

---

## Module 12 — What to Know About the Roster

A few important details about how the participants model works:

**The cap is 16.** That's `MAX_PARTICIPANTS`. Enough for any reasonable multi-agent setup. Trying to add beyond 16 returns `null`.

**Seeding is single-winner.** The first `participants.add` call on a rosterless session materializes the roster with the owner and primary model, then adds your participant. Two racing first-adds won't duplicate the seed — it's a guarded Mongo write.

**The roster is authoritative when present.** No roster = classic 1:1 (today's behavior, unchanged). Present roster = the complete list of who may participate. There's no in-between.

**Attribution only appears when it disambiguates.** A 1:1 session's provider payload is byte-identical to before participants existed. The moment a second human or second model joins, the entire history re-renders with `[name]:` prefixes — a one-time prompt cache invalidation, accepted by design.

**Turns always run as the session owner.** Tools, `instructions`, `canUse` — they all see `session.userId`, the owner's identity. The `from` field on the message tells you who actually triggered the turn, but the run identity is always the owner. This prevents a split where a member-triggered turn runs instructions as the member but tools as the owner.

**Compaction is omniscient.** When the transcript gets long enough to compact, the summarizer sees everyone's speech (all models, all humans, full attribution). Individual model views drop colleagues' tool calls, but the summary preserves the complete picture. Compaction always bills under the primary agent's config.

---

## Quick Reference

### API Surface

```ts
// Add a participant
await Agent.participants.add(sessionId, {
  id: 'm:analyst',           // m:<agent> for models, h:<userId> for humans,
                              // x:<kind>:<extId> for channel identities
  kind: 'model',             // 'model' | 'human'
  role: 'member',            // 'owner' | 'member' (owner is set at seed time)
  agent: 'analyst',          // models only — the registered agent name
  displayName: 'analyst',    // what appears in attribution
}, { by: 'm:support' });     // who added them

// Remove a participant
await Agent.participants.remove(sessionId, 'm:analyst');

// List the roster
const roster = await Agent.participants.list(sessionId);
```

### Addressing

| User types | What happens |
|---|---|
| `@analyst what's the trend?` | Analyst agent takes the turn |
| `@support process the refund` | Support agent takes the turn |
| `Just a regular message` | Primary agent (support) takes the turn |

### Relay flow

| Step | What happens |
|---|---|
| Model replies with `@colleague ...` | `pendingRelay` written atomically with the commit |
| Colleague's turn fires | Relay consumed at first commit |
| Human sends a message | Relay counter resets to 0, any pending relay cancelled |
| Relay counter hits `budget.relay` | Reply delivers but no relay scheduled |

### Channel admission

| `admits` setting | Who can send messages |
|---|---|
| `'opener'` (default) | Only the session starter |
| `'members'` | Anyone on the roster |
| `'linked'` | Anyone with a linked account (auto-joins up to cap) |

---

That's it. Two agents, one Slack thread, full attribution, durable relays, and a clean separation of concerns. The participants model generalizes to any number of agents and humans — the Slack channel is just one surface. The same roster powers email compose loops, SMS threads, and the web UI.
