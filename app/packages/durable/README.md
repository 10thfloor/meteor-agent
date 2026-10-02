# 10thfloor:durable

[Pi Durable](https://earendil.com/posts/pi-durable/) on Meteor.

Pi Durable is a durable agent harness: conversations, model turns, tool calls
and application state are committed to storage before anything is shown, and a
process that dies mid-turn is resumed from storage by the next one. It leaves
four things to whoever hosts it, and a Meteor app already has an answer to each:

| Pi Durable leaves open | This package |
| --- | --- |
| Storage on a networked database | A MongoDB `Storage` on the connection your server already has, passing Pi Durable's own conformance suite |
| Which process runs a storage ("one process owns a storage at a time; there is no cross-process locking") | A lease per storage. Any server instance hosts it; when that instance stops or dies, another resumes the work |
| How a request reaches that process | Call from any instance. The call is done here, or handed to the instance that hosts the storage |
| How a client watches a conversation without attaching to that process | A publication over the stored rows, from any instance, and a reactive client |

**Status: experimental.** Pi Durable says its API changes without notice, and
so may this package's. It is not on Atmosphere and not in a tagged release yet:
vendor `app/packages/durable` from `main`. It does not replace
`10thfloor:agent`; the two do not depend on each other. The design record is
[`docs/superpowers/specs/2026-10-02-pi-durable-on-meteor.md`](../../../docs/superpowers/specs/2026-10-02-pi-durable-on-meteor.md).

## Install

```bash
meteor add 10thfloor:durable
meteor npm install --save --save-exact @earendil-works/pi-durable@1.0.0 @earendil-works/chord@1.0.0
meteor npm install --save @earendil-works/pi-ai
```

Pin the first two exactly. Mongo must be a replica set, as `meteor run` starts
and as `10thfloor:agent` already requires: commits are transactions.

## Define a family of storages

```ts
// server/missions.ts
import { Durable, loadPiAi, loadPiDurable } from 'meteor/10thfloor:durable';

const { createRegistry } = await loadPiDurable() as any;
const { builtinModels } = await loadPiAi('providers/all') as any;
const models = builtinModels();
const registry = createRegistry(); // install your extensions and tools here

export const Missions = new Durable('missions', {
  // What a harness over one storage runs with: Pi Durable's HarnessOptions, without the storage.
  harness: (key) => ({ models, registry }),
  // The agent a conversation created by a client starts with. A client never chooses its own.
  agent: () => ({ model: { provider: 'anthropic', modelId: 'claude-sonnet-5' } }),
  // Who may do what over DDP. Absent, or anything but `true`: refused.
  allow: (userId, action, { key }) => userId !== null && ownsMission(userId, key),
});
```

One `key` is one storage: one Pi Durable Session, with its conversations,
tasks and documents, one commit line, and one owner at a time. Use a key per
unit that works together, such as a mission; never one for the whole app.

`loadPiDurable()`, `loadChord()` and `loadPiAi()` exist because Meteor's
resolver does not follow `exports` maps, and these packages publish their
entry points only through one. `loadPiAi()` gives you the pi-ai that Pi Durable
itself runs on, which is the one to build `models` from.

## From the server

Every method below works on every server instance, whichever one hosts the
storage.

```ts
const conversationId = await Missions.root('m42');           // created on first use
const { submissionId } = await Missions.submit('m42', conversationId, 'Why did the deploy fail?');
const record = await Missions.settled('m42', submissionId);  // answered, or failed

// Or all three at once:
const { status, text } = await Missions.ask('m42', 'Why did the deploy fail?');
```

| Method | Does |
| --- | --- |
| `root(key, agent?)` | The root conversation's ID, creating it on first use |
| `create(key, agent?)` | A new conversation in the storage |
| `fork(key, conversationId, at, agent?)` | A fork at the entry `at` |
| `submit(key, conversationId, draft)` | Hands over user input (a string, or `{ type: 'input', content, whenBusy?, requestId? }`) or a passive entry write. Resolves once it is durably admitted |
| `settled(key, submissionId, { timeoutMs? })` | The submission's record once it is `done` or `unanswered` |
| `ask(key, content, options?)` | `submit`, `settled`, and the answer's text |
| `abort(key, conversationId, { background?, waitMs? })` | Stops the current work. `idle` says whether it had stopped when this returned |
| `withdraw(key, submissionId, conversationId?)` | Withdraws a queued submission |
| `reset(key, conversationId, handoff?)` | Starts a new context. Older entries stay |
| `compact(key, conversationId, instructions?)` | Summarizes older entries now |
| `configure(key, conversationId, agent)` | Changes what a conversation runs with |
| `reader(key)` | A read-only storage: every read of Pi Durable's storage contract, no ownership |
| `call(key, op, args, { requestId? })` | Runs an operation of your own on the hosting instance (below) |
| `with(key, (harness) => …)` | The harness itself, on the instance that hosts the storage |
| `owner(key)`, `hosted()` | Which instance holds the lease; which keys this instance has open |
| `destroy(key)` | Erases the storage, wherever it is hosted |

A `requestId` makes a submission exactly-once: submit it again after a lost
connection, or from another instance, and the same submission is returned.

### Your own operations

A harness cannot be handed across processes, so `with()` rejects with
`HostedElsewhere` when another live instance has the storage. Code that must
work from any instance is registered as an operation and called by name:

```ts
const { defineDoc } = await loadPiDurable() as any;
const Todos = defineDoc({
  kind: 'app.todos', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ items: [] }),
});

export const Missions = new Durable('missions', {
  harness: () => ({ models, registry }),
  documents: ['pi.live', 'pi.inbox', 'pi.usage', 'app.todos'], // viewers receive the list too
  operations: {
    // Arguments and result are JSON: the call may cross from one instance to another.
    async addTodo({ item }, { harness, context }) {
      const root = await harness.root(context);
      await root.commit(async (tx) => { (await tx.doc(Todos, root.id)).items.push(item); }, context);
      return harness.snapshot(Todos, root.id, context);
    },
  },
});

const todos = await Missions.call('m42', 'addTodo', { item: 'write the runbook' });
```

In the browser, `chat.document('app.todos')` is that list, kept current.

An operation is given `{ harness, key, requestId, context }`. It runs at least
once: if its host dies after doing the work and before recording the result,
the next host runs it again with the same `requestId`. Pass that on wherever a
repeat must not happen twice, as the built-in `submit` does. An error it throws
reaches the caller with its name and message. The names of the built-in
operations (`root`, `submit`, …) are taken.

## From the browser

```ts
import { DurableConversation } from 'meteor/10thfloor:durable';

const chat = new DurableConversation({ host: 'missions', key: 'm42' });

Tracker.autorun(() => {
  render({
    entries: chat.entries(),        // Pi Durable entry records, oldest first
    answer: chat.streamingText(),   // the answer being generated, so far
    tools: chat.tools(),            // the current round of tool calls
    busy: chat.busy(),
    usage: chat.usage(),
  });
});

await chat.submit('Why did the deploy fail?');
await chat.submit('Look at the migration first', { whenBusy: 'steer' });
await chat.abort();
const forkId = await chat.fork(entryId);
```

Every read is reactive. `entries()` is everything the conversation can see,
through its fork ancestors; `active()` is what the model still sees, from the
newest reset or compaction on. `document(kind, key?)` is the present value of
any document the definition publishes; `live()`, `inbox()` and `usage()` are
Pi Durable's own. `DurableConversation.root(host, key)` and `.create(host,
key)` make conversations; `history(n)` widens the window; `stop()` ends the
subscription.

A streamed answer is not re-sent as it grows. Pi Durable commits it as small
delta operations on the conversation's `pi.live` document, each stored as one
row; the publication sends the rows and the client applies them. An answer of
any length costs one small row per update.

### What a client can and cannot do

The DDP surface is deliberately smaller than the server's:

- Eight methods: `durable.root`, `create`, `fork`, `submit`, `abort`,
  `withdraw`, `reset`, `compact`. Each takes one object naming the definition
  and the key, and each asks `allow(userId, action, { key, conversationId })`
  first. No `allow`, or anything but `true`: `not-authorized`. A definition
  that does not exist answers the same.
- A client sends user input only: text, or text and image parts. It cannot
  write raw entries, choose a model, tools or instructions (those come from
  `agent`), call your operations, or erase a storage.
- One publication, `durable.conversation`, gated by the action `view`. It is
  asked again every 30 seconds while a subscription lives, so a `view` that
  turns false ends the subscription. A viewer receives the conversation's
  entries except `pi.system` (the system prompt and tool declarations), from
  its newest 200 on, and the documents `pi.live`, `pi.inbox` and `pi.usage`.
  `documents` and `hiddenEntries` on the definition change that; `pi.agent`,
  which holds the instructions, is not published unless you add it.
- Client writes to the published collections are denied.

Errors a client can act on are `not-authorized`, `conversation-not-found`,
`conversation-busy` (a submit with `whenBusy: 'reject'`), and `unavailable`
(no server took the request in time; try again).

Pi Durable has no notion of a user, and a user entry carries no author. If
your app needs to know who said what, record `requestId → userId` yourself
when you accept the input; a submission's record keeps the `requestId` and,
once placed, the ID of the entry it became.

## Several server instances

Nothing below needs configuration. It is what happens.

- **Hosting.** The first instance asked about a storage takes its lease, opens
  it, and runs its harness. It renews the lease while there is work and gives
  it up 30 seconds after the storage goes quiet.
- **Requests.** A call on another instance is written as a request row. The
  host hears of it by change stream and answers it; the caller waits for the
  answer. If the host has gone, the caller's instance takes the storage and
  does the work itself.
- **A host that dies.** Its lease runs out within 30 seconds, another instance
  takes the storage at its next look (every 5 seconds), and Pi Durable resumes
  each unfinished task from its checkpoint: a replay-safe tool runs again, an
  unsafe one is reported to the model as interrupted.
- **A host that is told to stop.** A production server that receives SIGTERM
  or SIGINT closes its storages first and leaves the ones with work for the
  next instance, which takes them at its next look. Then it ends as it would
  have. It spends at most `shutdownMs` on this (5 seconds; `0` turns it off).
  `shutdown()` does the same from a shutdown path of your own.
- **A host that restarts.** A server that comes back under the same instance
  name takes its storages back at once.
- **Safety does not depend on any of that.** A lease says who should run a
  storage; it cannot stop a process that was paused and wakes up late. Every
  commit checks, inside its transaction, that its storage has not been opened
  by anyone since. A replaced owner cannot write, whatever it believes.
- **Reading never needs the host.** The publication and `reader()` use the
  stored rows, so a conversation can be watched on every instance, and stays
  watchable while its storage changes hands.

An instance is named by its host name and port (and PM2's `NODE_APP_INSTANCE`
where several processes share a port). Processes that run at the same time
need different names: a process that starts takes over whatever is leased to
its name. Two with one name still work, and the package says so in the log.
Set `DURABLE_INSTANCE_ID` where the default does not tell your processes
apart.

## Settings

```json
{
  "packages": {
    "10thfloor:durable": {
      "instanceId": "web-1",
      "leaseMs": 30000,
      "sweepMs": 5000,
      "idleMs": 30000,
      "requestMs": 30000,
      "closeMs": 3000,
      "shutdownMs": 5000,
      "writeConcern": { "w": "majority" },
      "rateLimit": {
        "submits": { "count": 30, "intervalMs": 60000 },
        "creates": { "count": 10, "intervalMs": 60000 },
        "controls": { "count": 60, "intervalMs": 60000 }
      }
    }
  }
}
```

All optional; the values shown are the defaults, except `instanceId` and
`rateLimit`, which have none. No rate limit is applied unless you set one, and
each `submit` may buy a model request: set `submits`.

Pi Durable has no budgets, and none of its hooks can refuse a model request.
To cap spending, wrap the `Models` object you return from `harness`.

## The storage

`MongoStorage` implements Pi Durable's 16-method `Storage` contract and
follows the upstream SQLite backend table for table.

- One Mongo transaction is one Session commit. Either every record and
  document write of a commit is stored, or none is.
- Records are stored as JSON text beside the few columns the contract's scans
  need, so nothing is lost to BSON: a key named `__proto__` or `$ref`, a lone
  surrogate, and an ID near 2^53 all survive.
- Documents are bases plus ordered Chord delta tails. A current-only document
  keeps nothing older than its newest base; a rewindable one keeps everything.
- Many storages share the collections (`pi_durable_*`). Every row carries its
  storage key and every index starts with it.
- Ownership is an epoch. Opening a storage takes its epoch, and every commit
  checks it. A replaced owner gets `StorageOwnershipLost` and can never write
  again; it can still read. So does the owner of a storage that was destroyed,
  even when its key is in use again.

`openMongoStorage(key)`, `readMongoStorage(key)` and `destroyMongoStorage(key)`
are that layer alone, for a storage only one process ever opens: no lease, no
host, no methods.

### What a commit costs

Measured under the real harness inside a Meteor server, on the local
single-node replica set `meteor` starts (`mongod` 7.0.16). Median per commit,
one run on one laptop:

| Backend | Streaming delta commit | One tool turn (14 commits) |
| --- | --- | --- |
| Pi Durable memory | 0.1 ms | 48 ms |
| Pi Durable SQLite, local file | 0.3 ms | 40 ms |
| MongoStorage, `w: 1` | 3.0 ms | 95 ms |
| MongoStorage, `w: "majority"` (default) | 8.6 ms | 179 ms |

The default waits for the commit to be journaled, which is most of its cost
(a bare one-statement majority transaction takes about 6 ms on the same
machine). The harness commits a streaming answer at most ten times a second,
so a streamed answer took the same 2.8 s of wall time on every backend. Set
`writeConcern` to `{ "w": 1 }` to trade failover safety for speed, as the
SQLite backend does with `synchronous = NORMAL`.

To measure it on your own deployment:

```bash
DURABLE_BENCH=1 MOCHA_GREP='commit costs' TEST_CLIENT=0 meteor test-packages --once \
  --port 3200 --driver-package meteortesting:mocha ./packages/durable
```

## Limits

- **Experimental upstream.** A bump of `pi-durable` or `chord` is a
  verification event: run this package's suite, which includes Pi Durable's
  own storage conformance cases.
- **One commit line per storage.** All conversations of one storage commit
  one at a time: at 10 ms a commit, about a hundred commits a second, or
  roughly ten answers streaming at once. That is the reason for one storage
  per mission.
- **Erasure is per storage.** Entries are immutable, and Pi Durable cannot
  delete one conversation. `destroy(key)` deletes the whole storage. The key
  can be used again: whatever is left of the old storage's owner cannot write
  into the new one. For up to a minute, another instance may still go by the
  fork ancestry it remembers of the old storage's conversations.
- **A tool that ignores its cancellation cannot be stopped.** `abort` answers
  `{ idle: false }` after `waitMs`. Closing such a storage (to hand it over,
  or to erase it) waits `closeMs` and then leaves its harness behind in
  memory, where it can no longer commit; the tool call itself runs on until
  it returns. Write tools that honor `abortSignal`.
- **One record is one BSON document:** 16 MB at most.
- **`with()` is local.** See "Your own operations".
- **The browser pays for Chord's delta module.** The client needs one function
  of it and Meteor's bundler takes the module whole: about 48 KB minified,
  beside 15 KB for this package's own client.
- **`esbuild` comes along.** Chord depends on it for a bundler that Pi Durable
  never loads: about 10 MB installed, with a platform binary and an install
  script.
- **Type-checking with `skipLibCheck: false`** reaches `@google/genai`'s
  declarations through pi-ai's, and those import an optional peer
  (`@modelcontextprotocol/sdk`). Install it, or declare the module; this
  repo's `app/tests/consumer-ambient.d.ts` is the three lines.

## Tests

```bash
TEST_BROWSER_DRIVER=playwright meteor test-packages --once --port 3200 \
  --driver-package meteortesting:mocha ./packages/durable
```

They need no API key and no network: the model is pi-ai's faux provider. The
server half runs Pi Durable's conformance suite against `MongoStorage`, the
harness on it, and several hosts on one database (takeover, handover, restart,
requests, erasure). The browser half drives `DurableConversation` in headless
Chromium, including against a storage that another host runs.

Two real server processes are a separate check, because they need a built
app. `scripts/verify-instances.mjs` boots this repository's production bundle
twice on one MongoDB and speaks DDP to both: input routed to the instance that
hosts a thread, takeover after that instance is killed in the middle of a tool
call, and handover when it is sent SIGTERM with a lease of a minute.

## A surface built on it

Constellation's **Threads** view is this package in use: a definition with
tools, a plan document, a scripted offline model and a spending limit, an
index of threads beside the storages, and a browser layer on
`DurableConversation`. See [`docs/threads.md`](../../../docs/threads.md) and
`app/server/constellation-durable.js`.
