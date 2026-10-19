# Threads

Threads is Constellation's surface on
[`10thfloor:durable`](../app/packages/durable/README.md), the package that
runs Earendil's Pi Durable harness on Meteor. It is experimental, and it is
there to be used: the question it exists to answer is whether this is a better
foundation for an agent than the loop `10thfloor:agent` has today.

Open it from the **Threads** button in the rail, under Channels. It is a layer
over the workspace: your Mission is untouched underneath, and choosing any
view closes it.

## What a thread is

One thread is one Pi Durable storage. It holds a root conversation, the forks
you make from it, a plan the agent keeps, and a record of what was spent.
Every model turn, tool call and plan change is committed to MongoDB before it
appears on screen.

It is not a Mission. It has no crew, no approvals, no Fact Memory and no
channels; those are `10thfloor:agent`'s. A thread is one agent, three small
tools, and the machinery under test.

| You can | How |
| --- | --- |
| Talk | Type and press Enter. The answer streams as it is committed |
| Add to work in progress | While the agent is busy: **Steer** adds your message to the current work, **Queue** holds it until the answer is done. A queued message can be withdrawn |
| Stop | **Stop** cancels the current run |
| Fork | **Fork from here** under any answer starts a branch that sees the conversation up to that point, with the plan as it was there. Switch with **Branch** |
| Change the model | **Model** lists what the workspace's catalog offers; it applies from the next request |
| Start over, keep the record | **New context** hides everything before it from the model. Nothing is deleted |
| Make room | **Summarize** compacts earlier messages when there are enough of them |
| Delete | **Delete**, twice. It removes the whole thread; Pi Durable cannot delete one message |

The agent's tools are `update_plan` (the plan beside the conversation),
`wait` (so there is something to interrupt) and `current_time`.

## Things worth trying

- **Kill it in the middle.** Say `wait 25`, quit the app while the tool runs,
  and start it again. The thread finishes the wait and answers. Nothing was
  held in memory that mattered.
- **Fork and compare.** Ask for a plan, fork from the answer, and take the
  fork somewhere else. Each branch keeps its own plan and its own spend.
- **Talk over it.** Start something long and steer it, or queue a follow-up
  and withdraw it.

Offline (`npm run desktop:offline`) threads run on a scripted model that needs
no key: `plan: first, second, third`, `wait 10` and `what time is it?` each
run a tool; anything else gets the same canned reply.

## Limits

- **Spending.** Pi Durable has no budgets. A thread takes no more input once
  its branches together have spent `CONSTELLATION_DURABLE_SPEND_LIMIT` dollars
  (default 2), and a run already under way ends at its next tool round once
  its own conversation has spent that much. A run that calls no tools is one
  model request, and finishes.
- **No command-palette entry, and the layer does not reopen by itself after a
  restart.** The thread you had open is remembered.
- **Markdown** in answers is rendered from a short list of elements; raw HTML
  is shown as text.

## Where it lives

| File | What it is |
| --- | --- |
| `app/server/constellation-durable.js` | The `Durable` definition, the tools, the scripted model, the spending guard, and the app's methods |
| `app/client/durable-threads.js`, `.css` | The layer |
| `app/client/durable-markdown.js` | Markdown as inert DOM |
| `app/imports/constellation/durable.js` | What both sides share |
| `app/tests/constellation-durable.js` | Server and browser tests |
| `scripts/verify-instances.mjs` | Two server processes from a production bundle sharing threads |

The app keeps one row per thread beside the storage
(`constellation_durable_threads`): its owner, title, model and conversations.
Speaking, creating and forking go through the app's own methods, which check
that row and the spending limit. Watching, stopping, withdrawing, resetting
and summarizing go through the package's methods, gated by the same row.
