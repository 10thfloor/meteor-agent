# Pi Durable on Meteor

**Status:** built, experimental. The storage, the host, request routing, the DDP surface and the client are in `app/packages/durable` and verified as §2 says. Constellation has one surface on it, Threads ([`docs/threads.md`](../../threads.md)). The kernel question (§9) is what remains, and it is to be answered from use.
**Date:** 2026-10-02
**Package:** `10thfloor:durable` (new). `10thfloor:agent` is not changed.
**Depends on:** `@earendil-works/pi-durable` 1.0.0 and `@earendil-works/chord` 1.0.0, both pinned exactly; pi-ai 1.x.

## 1. The idea

On 2026-10-01 Earendil shipped [Pi Durable](https://earendil.com/posts/pi-durable/)
beside Pi 1.0. It is a durable agent harness: conversations, model turns, tool
calls and application state are committed to storage before anything is shown,
and a process that dies mid-turn is resumed from storage by the next one. That
is the job `10thfloor:agent`'s own kernel does (`loop.ts`, `dispatch.ts`,
`transcript.ts`, `lease.ts`, `watcher.ts`, `deltas.ts`), written by the people
who write pi-ai, with a normative specification and about 700 tests.

Pi Durable is deliberately small where Meteor is strong:

- **One process owns a storage, and nothing enforces it.** Its README says so:
  "One process owns a storage at a time; there is no cross-process locking."
- **A viewer must attach to that process.** Its views are in-memory states of
  the owning harness.
- **It ships memory, SQLite and JSONL storage.** No networked database.
- **It has no notion of a user.** No identity, no permissions.

A Meteor server has an answer to each: a replica-set Mongo with transactions,
cursors that any instance can observe, and accounts. This package is the
binding between the two: Pi Durable keeps the harness, Meteor supplies storage,
ownership, ingress and views.

### What this is not

It is not a decision to replace `10thfloor:agent`'s kernel. That question is
real and is argued in §9, but it depends on use that has not happened yet. It
is also not a fork: Pi Durable is used as published, through its public
`Storage` interface and its public harness.

## 2. What was verified

Everything here ran. The tests are in `app/packages/durable/tests/` and run
in CI with the other packages. The cases that need a second operating-system
process and a real signal ran under plain Node, against the same source files,
while the package was written; the suite holds each of them with two hosts or
two harnesses in one process, and `scripts/verify-instances.mjs` runs the
central ones in CI with two server processes from a production bundle.

| Claim | How it was checked |
| --- | --- |
| Pi Durable 1.0.0 runs under Meteor 3.5's Node (24.15) | A model turn with a tool call, in a Meteor server process, on pi-ai's faux provider |
| Meteor can load it despite `exports` maps | The loader seam `10thfloor:agent` uses for pi-ai resolves `pi-durable`, `pi-durable/testing`, `chord/context`, `chord/delta` and pi-ai's wildcard exports, in development and in a production bundle |
| It works from a production bundle | `scripts/verify-build.sh` builds the reference app, checks both browser bundles for the client and Chord's delta module, checks that the loader takes the copies of Chord and pi-ai that Pi Durable itself imports, and runs a whole turn with a tool call from the bundle's `npm/node_modules` |
| A MongoDB `Storage` is correct | Pi Durable's own conformance suite, all 23 cases, on Meteor's Mongo connection with Meteor's bundled driver (6.16) and `mongod` (7.0.16) |
| A commit is atomic across collections | A write made to fail after the ID, entry, task and submission rows of the same commit were written: none of them exists afterwards, and the commit consumed no sequence |
| A replaced owner cannot write | Two opens of one storage: the earlier one's next commit is refused, leaves nothing, and stays refused. Also with two harnesses, and with two operating-system processes |
| Neither can the owner of an erased storage, into the storage that took its key | A storage destroyed and its key opened again, which gives the new owner the very epoch the old one held: the old owner's commit is refused. Also with a host that was paused, lost its storage, and woke up |
| A second process finishes what the first left | `kill -9` in the middle of a tool call, then a second process hosts the storage: a replay-safe tool reruns there; an unsafe one is reported to the model as interrupted, with the output it had streamed. The retried submission (same `requestId`) is found, not asked twice |
| One instance runs a storage at a time, and the others reach it | Two hosts on one database: a call on the one that does not host the storage is answered by the one that does; the same request asked three times, from both, is admitted once |
| Work survives its host | A host that stops answering: another takes the storage when the lease runs out and finishes the work. A host that stops in good order: another takes it at once. A host that restarts under its name: it takes its storages back at once. A commit whose outcome is unknown: the host reopens the storage and the work continues |
| Taking a storage never waits inside the server, and a host that died in the middle of a commit is not waited for | `open()` against a meta row held by an open transaction: no operation of its is inside the server for longer than an eighth of a second, sampled for a second (a plain write is, the whole time, with a write ticket in its hand); it gives up as `StorageBusy` at its limit and leaves the owner its storage. An owner stopped in the middle of a commit, in one process and as a real process killed there: the next owner has the storage within two seconds of the lease, not after the server's minute; nothing of the unfinished commit remains, and the owner's call is passed to the new host, which admits it once. `destroy()` while a commit is finishing: the commit ends first and nothing is left behind |
| A server that is told to end hands over first | A real process sent SIGTERM in the middle of a tool call, with a lease of a minute: it closed its storage, ended by that same signal, and the survivor finished the work within five seconds. With a tool that ignores its cancellation: it gave its leases up after its grace and ended; the survivor finished the work |
| Two processes given one name still work | Requests asked of the namesake go to the process that runs the storage; nothing is taken from it; the mistake is reported once |
| Two real servers share a storage | `scripts/verify-instances.mjs`: two processes from the reference app's production bundle on one MongoDB, driven over DDP. A thread made on one is watched and spoken to through the other, which passes the input on and is published the answer as delta rows; the host is killed in the middle of a tool call and the other finishes the run, with the input in the transcript once; with a lease of a minute the host is sent SIGTERM, ends by that signal, and the other has the thread half a second later. With the handover turned off, that last step fails |
| A host that dies in the middle of an answer | The next host keeps what had been committed of the answer as an entry that was cut short, asks the model again, and the submission settles with the whole answer |
| The package carries a real surface | Constellation's Threads, driven in a real browser by the reference app's own suite: a tool call and the plan it writes, input queued behind a running tool and withdrawn, stop, fork with the plan as it was at the fork point, rename, delete; and by hand, the server killed in the middle of a tool call and started again |
| A storage is erased wherever it is hosted | Asked of the instance that does not host it; every row is gone, the lease is gone, and a late notice of the finished request does not bring the storage back |
| Any instance can watch a conversation | A real browser on a DDP connection, through `DurableConversation`: an answer arriving in at least 8 growing partial texts, a tool call while it runs, queued input, abort, fork, an application document kept current, and all of it again for a storage that a different host runs than the one the browser talks to |
| The rows a viewer gets are the rows it may get | No `allow`, or anything but `true`: every method answers `not-authorized` and the publication is empty; an unknown definition answers the same; a client cannot write a raw entry, choose an agent, or name an operation; a `view` that turns false ends a live subscription |
| Each built-in operation does what it says | `create`, `fork`, `submit`, `abort`, `withdraw`, `reset`, `compact`, `configure`: each against the real harness, with a model that reports what it was sent, so a reset or a changed instruction is seen from the model's side |
| Reads are served by indexes | Mongo's profiler over every contract read and the publication's own query: no collection scan, no in-memory sort, and no read examining a row it does not return |
| A document read is never torn | Readers racing a writer that replaces a document's base 60 times |
| Meteor's observers see transactional writes | A cursor observer on the storage's rows saw a streamed answer grow, on Meteor 3.5's change-stream driver (its default) and on its oplog driver |
| The existing suites are unaffected | The `10thfloor:agent` and channel suites on the same branch |

Each protection was removed once to see its test fail: the head-marker index,
the snapshot read, the ownership check, the storage-life check, the reopen
after a failed commit, the re-check before opening for a request, the
process-run in the lease, the stopped-host rule, both halves of giving leases
up, the transaction around the meta row (a plain write parks in the server),
the ending of a dead owner's session (the takeover waits a minute), the fence
before destroying (the finishing commit's rows remain), one commit at a time,
and the clearing of the session name on close.

## 3. What a commit costs

Median per commit under the real harness, inside a Meteor server, on the local
single-node replica set `meteor` starts. One run on one laptop
(`tests/bench.test.ts`, `DURABLE_BENCH=1`):

| Backend | Streaming delta commit | One tool turn (14 commits) |
| --- | --- | --- |
| Pi Durable memory | 0.1 ms | 48 ms |
| Pi Durable SQLite, local file | 0.3 ms | 40 ms |
| MongoStorage, `w: 1` | 3.0 ms | 95 ms |
| MongoStorage, `w: "majority"` (default) | 8.6 ms | 179 ms |

The default waits for the journal, which is most of the cost: a bare
one-statement majority transaction takes about 6 ms on the same machine, and a
round trip 0.3 ms. The harness commits a streaming answer at most ten times a
second, so a streamed answer took the same 2.8 s of wall time on every backend.

One storage commits through one line. By arithmetic, not measurement: at
10 ms a commit that is about a hundred commits a second, or roughly ten
answers streaming at once in one storage. That is the reason for decision 3
below.

## 4. Pi Durable in terms of what we already have

| Ours | Pi Durable's |
| --- | --- |
| `agent_messages`, one row per message, `seq` per session | Entries: immutable records, one global ID order, visible through fork ancestry |
| `agent_deltas`, capped and shared by every session, global FIFO eviction | The conversation's `pi.live` document: deltas of one conversation, replaced by a base when nothing runs |
| Turn lease, watcher sweep every 15 s | A storage has one owner; `resume()` continues every unfinished task from its checkpoint |
| Parked approval | A `beforeTool` hook that stores its decision in a task memo |
| Subagent with `activeChild` marker and orphan sweep | A conversation owned by the tool call that created it; abort and idleness follow the ownership tree |
| System turns, pulses | Tasks with timers that survive restarts; background tasks |
| `pendingInputs`, relay | The inbox: steer, follow-up, write; `requestId` makes a submission exactly-once |
| Compaction at a cut | A compaction task that summarizes in the background and is placed at a turn boundary |
| Fork | Fork at an entry; each document says what a fork starts with |
| `beforeProviderRequest`, `afterToolResult` | `beforeRequest`, `afterResponse`, `onYield`, `afterTools`, `beforeTool`, `afterTool`, `beforeCompact` |

What Pi Durable has no counterpart for, and this repo keeps: identity and
permissions (`runAs`, participants), budgets and ceilings, channels, Fact
Memory and the learning system, the MCP client, attachments, the client and
the packaged element.

What it has that we do not:

- **Tasks.** `defineTask` gives application code the machinery the built-in
  turns run on: versioned phases, a checkpoint per step, child tasks, waiting
  on other tasks, an abort handler that undoes a task's own effects.
- **Documents.** Typed application state committed in the same atomic commit
  as the transcript, with a declared behaviour on fork.
- **Execution environments.** An environment built per conversation, so the
  harness can run on one machine and its tools on another.
- **Reload.** An extension replaced while conversations run.

## 5. Design

Five files carry it. Three of them import nothing at run time (the driver,
the harness and the clock are passed in), so they load unchanged under plain
Node, which is where the two-process cases ran.

### 5.1 Storage (`server/mongo-storage.ts`)

Implements the 16-method `Storage` contract. It follows upstream's SQLite
backend table for table.

- **One transaction per commit.** Reads of the batch first, then one ordered
  bulk write per collection it touches. A streaming delta commit is four
  statements.
- **Records are JSON text beside indexed columns.** A BSON string cannot hold
  a lone surrogate and a BSON field name cannot hold a NUL. JSON text keeps
  both, and `$ref`, dotted keys, `__proto__` and IDs up to 2^53, exactly. It
  is also what the SQLite backend stores.
- **Documents are bases and delta tails** in `pi_durable_revisions`. A
  current-only document keeps nothing older than its newest base. The rows
  that make up a document's present value are marked, so a publication selects
  them with one indexed equality.
- **A read that spans queries uses a snapshot** that starts no earlier than
  this storage's newest commit.
- **Many storages, one set of collections.** Every row has the storage key
  `s`; every index starts with it. Row `_id`s are strings, so the collections
  can be read as ordinary Meteor collections.
- **Ownership is an epoch, within a life.** `open()` increments the storage's
  epoch; a commit's first statement is a conditional update on that epoch,
  which is also where it allocates its sequence. A replaced owner gets
  `StorageOwnershipLost`. Its Session treats that as a failed commit and
  refuses everything after it, which is what a replaced owner should do. A
  storage also carries a random `life`, drawn when it is created and checked
  with the epoch: a key that was destroyed and opened again counts its epochs
  from one, and the epoch alone would let the old storage's owner in.
- **A reader owns nothing.** `MongoStorage.reader()` serves every read of the
  contract without taking the epoch.
- **Nothing waits inside the server.** Commits, `open()` and `destroy()` all
  write the meta row, so they take turns; and MongoDB makes a plain write
  that meets a row an open transaction has written wait by retrying it inside
  the server, with one of the server's write tickets held the whole time. A
  server with four cores has four, and a transaction whose client died stays
  open for a minute or more: a few storages taken over from a host that died
  while committing would hold every ticket and stop every write to the
  database. (This is how `10thfloor:agent`'s contended commit test fails on
  CI, as found while this was built.) So every write to the meta row is a
  transaction of its own, refused at once while the row is held, and the
  waiting is in the process: `open()` and `destroy()` try again with a growing
  pause, for `busyTimeoutMs` (2 minutes) at most. A commit takes milliseconds;
  one that holds the row past `commitGraceMs` (2 seconds) is a dead or
  stalled owner's. The meta row names the server session the owner commits in
  (one session per open storage; its commits run one at a time in it), and
  `killSessions` ends that session, and the commit with it. `close()` clears
  the name before it gives the session back, so a later `open()` never ends a
  stranger's session with a recycled identifier. `destroy()` takes the
  storage this way before it removes anything, so a commit in flight either
  finishes first or is ended, and none can begin after.

### 5.2 Host (`server/host.ts`)

Who runs a storage, and when.

- **A lease per storage**, in `pi_durable_leases`, written and compared on the
  database's clock. An instance takes it, opens the storage (which takes the
  epoch) and a harness over it, and renews it every third of its length. The
  lease is about liveness. Safety is the epoch: an instance that wakes up
  after losing its lease cannot commit, whatever its clock says.
- **Lazy, and let go.** A storage is opened by the first instance asked about
  it and closed 30 seconds after its last live task and its last local caller
  have gone. An idle storage has no lease and costs no instance anything.
- **A sweep** every 5 seconds takes storages whose lease ran out and storages
  with a request nobody has claimed.
- **Three ways to change hands.** A host that dies loses its lease after at
  most 30 seconds. A host that stops in good order leaves its busy storages'
  leases already run out, so the next sweep takes them. A host that restarts
  under its name takes its storages back at once: a lease names the instance
  and the process run, and a starting process treats its name's leases as its
  own last run's. A host that died in the middle of a commit is not waited
  for: the storage's `open()` ends that commit after `commitGraceMs` (§5.1).
- **A commit whose outcome is unknown** poisons the Session, by Pi Durable's
  own rule. The host closes that harness and opens the storage again, with a
  growing delay if it keeps failing; tasks resume from their checkpoints.
- **Closing is bounded.** A harness whose tool ignores its cancellation never
  closes. After `closeMs` it is left behind in memory, where it cannot commit
  once the storage is opened again or destroyed.
- **Leaving** (`server/handover.ts`). A production server that receives
  SIGTERM or SIGINT stops its host, within `shutdownMs`; if that does not
  finish in time it gives its leases up as they are. Then it raises the signal
  again, so it ends as it would have. From the signal on, the instance opens
  nothing: what it is asked goes to the others. Not installed under the
  `meteor` tool, whose runner expects a killed app to be gone at once.

### 5.3 Requests (`server/host.ts`, `server/operations.ts`)

Any instance may be asked to do something to any storage.

- If it hosts the storage, or nobody does, it does the work itself.
- Otherwise it writes a request row. The host hears of it by change stream
  (the sweep is the fallback), claims it, runs it, and records the result.
  The caller waits for the row to be answered. If the host has gone, the
  caller's instance takes the storage and consumes the row itself.
- A request carries its ID into the operation. For `submit` that ID is the
  submission's `requestId`, so a retry or a takeover in between cannot ask
  twice. Other operations run at least once.
- A claim names the process run that made it. A claim by any run but the
  current host's is a claim by a host that is no longer one, and is taken
  over.
- Erasure is the one operation the host does itself: it closes the storage,
  deletes every row, marks the request done, and only then lets the lease go.
  In another order there would be a moment with an unfinished request and no
  lease, which a sweep takes for a storage that needs a host.

The built-in operations are thin calls on Pi Durable's own Harness and
Conversation: `root`, `create`, `fork`, `submit`, `abort`, `withdraw`,
`reset`, `compact`, `configure`. An app adds its own by name.

### 5.4 Views (`server/publications.ts`, `client/conversation.ts`)

One publication, three cursors, no harness: the conversation's row and its
fork ancestors', the entries visible through that ancestry from a lower bound,
and the rows of the present value of the documents the definition publishes.
It works on every instance and keeps working while a storage changes hands.

The window is a lower bound and not a limit, because Meteor's change-stream
observer cannot serve a cursor with a limit, and a conversation only grows
upward.

The client keeps each document's rows by commit sequence and applies deltas
in order with Chord's `applyImmutable`; a row that arrives out of order marks
the value for a rebuild from its newest base. A streamed answer is delta rows
of `pi.live`: one small row per update, whatever the answer's length.

### 5.5 Identity (`server/durable.ts`, `server/methods.ts`)

Pi Durable has no users, and a user entry has no field for an author.

- **`allow(userId, action, { key, conversationId })`** gates all eight DDP
  methods and the publication. Absent, or anything but `true`, refuses. A
  live subscription's `view` is asked again every 30 seconds.
- **`agent({ key, userId, action })`** decides what a conversation created by
  a client runs with. A client sends input only: no raw entries, no agent
  choices, no operations, no erasure.
- **Authorship is the app's to record.** The `requestId` of an input is the
  handle: a submission's record keeps it and, once placed, the ID of the entry
  it became.
- **Budgets are the app's too.** No Pi Durable hook can refuse a model
  request; the way to cap spending is to wrap the `Models` object the harness
  is given.

## 6. Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | **Use Pi Durable as published, through `Storage`** | The interface is small, specified, and has a conformance suite. Nothing was patched. |
| 2 | **Enforce ownership in the commit, not beside it** | A lease alone cannot stop a paused process that wakes up after its lease expired. A conditional write in the same transaction can. |
| 3 | **One storage per unit that works together, never one for the app** | One storage is one commit line and one owner. A mission is the natural unit: its agents talk to each other, and its documents are shared. It is also the unit of erasure, because entries are immutable and Pi Durable has no way to delete one conversation. |
| 4 | **JSON text for records, not BSON subdocuments** | Losslessness is a contract requirement; the conformance suite tests it. The cost is that a Minimongo selector cannot reach inside a record. The client parses each entry once. |
| 5 | **String `_id`s** | Meteor collections accept only strings and ObjectIDs. Views depend on reading these rows as collections. |
| 6 | **`w: "majority"` by default, configurable** | "Committed before shown" should survive a failover unless the operator chooses otherwise. |
| 7 | **Pin `pi-durable` and `chord` exactly** | Upstream says the API changes without notice between releases. A bump is a verification event, as for pi-ai. |
| 8 | **The driver and the runtime values are passed in** | The storage, the host and the handover load unchanged under plain Node and under Meteor, and name no driver version. |
| 9 | **The package lives in this repo's release set, in a role of its own** | `runtime`, beside `core` and `channel`: it shares the version, the declaration checks and the test command, and depends on neither of the others. |
| 10 | **Requests are rows, not method calls between instances** | Instances share nothing but Mongo. A row survives the instance that wrote it and the instance that was to answer it. |
| 11 | **A lease names the process run as well as the instance** | With the name alone, two processes given one name take a storage from each other at every request. With the run, they are two instances, and the name only decides what a starting process may take back. |
| 12 | **Chord and pi-ai are loaded as Pi Durable resolves them** | A copy npm nested under Pi Durable first, the shared one otherwise. npm nests a copy when the app's own version does not fit Pi Durable's range; the shared one is then another version, and what it hands out need not be what the harness expects. |

## 7. Limits and risks, named

- **Experimental upstream.** "The API changes without notice". The `Storage`
  contract is the narrowest thing to depend on. Everything above it (tasks,
  extensions, hooks) is a wider surface.
- **16 MB per record.** One entry is one BSON document.
- **One commit line per storage.** See §3.
- **Erasure is per storage.** See decision 3. For up to a minute after an
  erasure, another instance may still go by the fork ancestry it remembers of
  the old storage's conversations.
- **A tool that ignores its cancellation cannot be stopped.** Its harness is
  left behind in memory when its storage is closed, and the call runs on
  until it returns.
- **`with()` is local.** A harness cannot cross processes. Code that must work
  from any instance is an operation.
- **An operation other than `submit` runs at least once.** It is given the
  request's ID to make itself idempotent with.
- **Requests wait at most 30 seconds for a host.** A deployment where no
  instance can host a storage answers `RequestExpired`.
- **Ending a dead host's commit needs `killSessions`.** MongoDB allows it for
  a user's own sessions, which these are. Where it is refused, a storage whose
  host died in the middle of a commit resumes when MongoDB's own transaction
  limit ends the commit: a minute, and up to half a minute more. Nothing is
  lost.
- **`esbuild` comes along.** Chord depends on it for a bundler Pi Durable
  never loads: about 10 MB installed, with a platform binary and an install
  script that runs when a bundle built on one platform is installed on
  another.
- **No hook can refuse a model request.** See §5.5.
- **The browser pays for Chord's delta module.** The client needs one function
  of it, `applyImmutable`, and Meteor's bundler takes the module whole: 48 KB
  minified in the reference app's bundle, beside 15 KB for the package's own
  client.
- **A cut-short answer does not say why.** A partial answer left by a host
  that died and one stopped by a person are the same entry (`aborted`).

## 8. Open decisions

1. **Whether to offer the storage upstream.** The announcement asks for help;
   a Mongo backend with their conformance suite passing is a contained
   contribution, and it would get their review. Nothing has been sent.
2. **The kernel.** §9.

Settled since the first draft: the storage unit in Constellation. A thread is
one storage, as decision 3 says a unit that works together should be; its
forks are conversations of that storage.

## 9. The kernel question

Should `10thfloor:agent` run on Pi Durable instead of its own loop?

**For.** The kernel is the part of this repo that is hardest to keep right.
A race was found in it on 2026-10-01: the watcher can write a false
orphan-child note while a subagent's result is being committed. Pi Durable's
ownership tree removes the class that bug belongs to. Tasks, documents and
execution environments (§4) are things an application on this package has to
build for itself today. And provider behaviour (caching, deferred responses,
overflow, retry) would be maintained by pi-ai's authors.

**Against.** It is experimental and days old. It is a rewrite of the engine
under a package that works, with a data migration, while work in progress
sits on the old engine. And two of the package's stated
properties change: tools stop being plain Meteor methods called by a loop we
own, and the transcript stops being documents a selector can reach into.

**Recommendation.** Do not move the kernel now. Constellation has one real
surface on `10thfloor:durable`; decide with evidence from using it. Revisit
when Pi Durable drops the experimental label or after two upstream releases,
whichever comes first, by running this package's suite against each.

What using Threads should show, either way: whether tasks and documents make
the things a Mission needs (approvals, a crew, budgets) simpler to build than
they were on the loop; what it costs that a transcript is no longer documents
a selector can reach into; and whether upstream's pace of change is one this
repo can follow.

## 10. Next steps

1. Use Threads.
2. Decide §8.1.
3. The kernel, from use.
