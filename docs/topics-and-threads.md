# Topics and threads

A Mission holds several conversations. Each has a **#topic** name, and any message
in a topic can start a **thread**. They all share the Mission's crew, files, plans,
decisions, settings and spending alerts.

(The **Threads** button in the rail is a different feature, an experiment built on
`10thfloor:durable`; see [Threads](threads.md).)

## Topics

Every Mission starts with **#general**, the conversation it has always had, under the
same id. **Add topic** under a Mission in the list, or in the topic menu next to the
Mission's title, adds another. Names are lowercase letters, numbers and dashes;
what you type is turned into one ("Pricing Tiers" becomes `#pricing-tiers`), and a
name can't be used twice in one Mission.

The topic menu (the `#topic` chip beside the title) renames or archives the open
topic and brings back archived ones. Archiving stops the topic's work and takes it
off the list; its conversation is kept. #general can't be renamed or archived.

Each topic is its own agent session. Agents in different topics work at the same
time, and stopping one topic stops only that topic. Pausing, completing or archiving
the Mission stops every topic, and reactivating it brings them all back. Mission
health adds up the turns, tool calls and spending of every topic and thread.

## The Mission list

Missions are sections with their topics under them.

| You see | It means |
| --- | --- |
| A bold topic | Something new since you last looked (remembered on this device) |
| A moving dot | An agent is working there |
| A number | Approvals waiting there; on a Mission row, the total |
| A dot on a folded Mission | Something unread inside it |

Clicking a Mission opens the topic you last had open there. The arrow folds it; a
folded Mission still shows the topic you are in. Search matches Mission titles,
objectives and topic names.

| Keys | Do |
| --- | --- |
| Up, Down, Home, End | Move through the list |
| Right, Left | Unfold or fold a Mission, or move between a Mission and its topics |
| Enter | Open |
| Option-Down, Option-Up | Next or previous topic, from anywhere outside a text field |
| Option-Shift-Down, Option-Shift-Up | Next or previous unread topic |
| Command-K, then `#name` | Jump to any topic |

## Threads

**Reply in thread** on a message (shown when you point at it) opens its thread in
the right-hand pane. The message has a summary under it from then on: how many
replies, who replied, and when, or that an agent is working.

A thread is a branch of its topic at that message. An agent answering in a thread
sees the topic up to that message and the thread itself, not what was said in the
topic afterwards. Threads run at the same time as their topic and each other.

The **Ask** menu above the composer has a second choice, remembered per topic:

- **Reply in this topic**: the answer comes in the chat, as before.
- **Reply in thread**: your message stays in the topic, and the answer starts a
  thread under it, which opens beside the chat. The topic's own agent knows the
  message was answered there.

In a thread, **Also send to #topic** under the composer copies that message into
the topic as well, without waking an agent there.

## Reviews

**Reviews**, beside Chat, Files, Code runs and Services, lists what the crew
learned on this Mission and what waits for you: practices to approve and
learning to acknowledge, from any of its topics, threads or delegated work. The
tab shows a count while something waits. **All reviews** opens the workspace list,
which is also in the Memory view and the command menu.

## Where it lives

| File | What it is |
| --- | --- |
| `app/imports/constellation/topics.js` | Topic names, and telling a Mission from its topics and threads |
| `app/server/mission-topics.js` | Topic methods, the topic publication, any session to its Mission, and keeping the crew the same everywhere |
| `app/client/mission-tree.js`, `.css` | The Mission list |
| `app/client/topic-menu.js` | The topic chip and menu |
| `app/client/thread-panel.js`, `.css` | Thread summaries and the thread pane |
| `app/client/mission-recipients.js` | Reply in this topic / Reply in thread |
| `app/packages/agent` | Threads themselves: `Agent#thread`, `send({ replyIn, alsoToParent })`, `agent.threads`, `<agent-chat threadable from-seq>` |
| `app/tests/constellation-topics.js` | Server and browser tests |
