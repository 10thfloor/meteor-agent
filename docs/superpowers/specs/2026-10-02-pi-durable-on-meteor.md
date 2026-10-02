# Pi Durable on Meteor

**Status:** proposal. The storage layer (§5.1) is built and verified on the branch `pi-durable-spike`. Nothing above it is built. §8 lists the decisions that are still open.
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
cursors that any instance can observe, and accounts. This proposal is the
binding between the two: Pi Durable keeps the harness, Meteor supplies storage,
ownership, ingress and views.

### What this is not

It is not a decision to replace `10thfloor:agent`'s kernel. That question is
real and is argued in §9, but it depends on things this proposal produces
first. It is also not a fork: Pi Durable is used as published, through its
public `Storage` interface.

## 2. What was verified

Everything here ran. The tests are in `app/packages/durable/tests/`, with one
exception: the `kill -9` between two operating-system processes ran under
plain Node while the package was written. The suite holds the same two cases
with two harnesses in one process, where the first never returns from its tool.

| Claim | How it was checked |
| --- | --- |
| Pi Durable 1.0.0 runs under Meteor 3.5's Node (24.15) | A model turn with a tool call, in a Meteor server process, on pi-ai's faux provider |
| Meteor can load it despite `exports` maps | The loader seam `10thfloor:agent` uses for pi-ai resolves `pi-durable`, `pi-durable/testing`, `chord/context` and `chord/delta`, in development and from a production bundle's `npm/node_modules` |
| A MongoDB `Storage` is correct | Pi Durable's own conformance suite, all 23 cases, on Meteor's Mongo connection with Meteor's bundled driver (6.16) and `mongod` (7.0.16) |
| A commit is atomic across collections | A write made to fail after the ID, entry, task and submission rows of the same commit were written: none of them exists afterwards, and the commit consumed no sequence |
| A replaced owner cannot write | Two opens of one storage: the earlier one's next commit is refused, leaves nothing, and stays refused. Also with two harnesses, and with two operating-system processes |
| A second process finishes what the first left | `kill -9` in the middle of a tool call, then a second process opens the storage: a replay-safe tool reruns there; an unsafe one is reported to the model as interrupted, with the output it had streamed. The retried submission (same `requestId`) is found, not asked twice |
| Any instance can watch a conversation | A plain cursor observer on the storage's rows, with no access to the harness, saw a streamed answer grow through 18 to 20 partial texts, and saw the answer entry within 5 ms of the run settling. On Meteor 3.5's change-stream driver, which is its default, and on its oplog driver |
| Reads are served by indexes | Mongo's profiler over every contract read: no collection scan, no in-memory sort, and no read examining a row it does not return |
| A document read is never torn | Readers racing a writer that replaces a document's base 60 times |
| The existing suites are unaffected | The `10thfloor:agent` server suite on the same branch |

Each protection was removed once to see its test fail: the head-marker index,
the snapshot read, the ownership check.

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

### 5.1 Storage (built)

`server/mongo-storage.ts` implements the 16-method `Storage` contract. It
follows upstream's SQLite backend table for table.

- **One transaction per commit.** Reads of the batch first, then one ordered
  bulk write per collection it touches. A streaming delta commit is four
  statements.
- **Records are JSON text beside indexed columns.** A BSON string cannot hold
  a lone surrogate and a BSON field name cannot hold a NUL. JSON text keeps
  both, and `$ref`, dotted keys, `__proto__` and IDs up to 2^53, exactly. It
  is also what the SQLite backend stores.
- **Documents are bases and delta tails** in `pi_durable_revisions`. A
  current-only document keeps nothing older than its newest base.
- **A read that spans queries uses a snapshot** that starts no earlier than
  this storage's newest commit.
- **Many storages, one set of collections.** Every row has the storage key
  `s`; every index starts with it. Row `_id`s are strings, so the collections
  can be read as ordinary Meteor collections.
- **Ownership is an epoch.** `open()` increments the storage's epoch; a
  commit's first statement is a conditional update on that epoch, which is
  also where it allocates its sequence. A replaced owner gets
  `StorageOwnershipLost`. Its Session treats that as a failed commit and
  refuses everything after it, which is what a replaced owner should do.

### 5.2 Host (to build)

Who opens a storage, and when. A lease on the `pi_durable_meta` row: an
instance takes it, heartbeats it, and opens the harness; the epoch makes a
late or stuck holder harmless whatever its clock says. A sweep opens storages
whose lease lapsed while they had live tasks, which is what the watcher does
today for orphaned turns. Storages are hosted lazily and closed when idle.

### 5.3 Ingress (to build)

`submit`, steer and abort arrive as method calls on any instance. The owner
calls the harness. Another instance writes a request row that the owner
consumes, using the row's ID as the submission's `requestId`, so a retry or a
takeover in between cannot ask twice. An instance that finds no live owner
takes the lease itself.

### 5.4 Views (to build; the premise is verified)

Publications over the entry rows and over the revision rows of the
conversation's mounted documents, from any instance. The client applies the
Chord operations of each revision in order. An authorization callback decides
who may subscribe. This is the piece Pi Durable cannot offer by itself:
its clients must reach the owning process.

### 5.5 Identity (to build)

Pi Durable has no users. The author of an input goes into the entry's `data`;
tools and `beforeTool` hooks read it from the run's input. Budgets become a
wrapper around the `Models` object the harness is given, since no hook can
refuse a model request.

## 6. Decisions made in the spike

| # | Decision | Why |
| --- | --- | --- |
| 1 | **Use Pi Durable as published, through `Storage`** | The interface is small, specified, and has a conformance suite. Nothing was patched. |
| 2 | **Enforce ownership in the commit, not beside it** | A lease alone cannot stop a paused process that wakes up after its lease expired. A conditional write in the same transaction can. |
| 3 | **One storage per unit that works together, never one for the app** | One storage is one commit line and one owner. A mission is the natural unit: its agents talk to each other, and its documents are shared. It is also the unit of erasure, because entries are immutable and Pi Durable has no way to delete one conversation. |
| 4 | **JSON text for records, not BSON subdocuments** | Losslessness is a contract requirement; the conformance suite tests it. The cost is that a Minimongo selector cannot reach inside a record. A publication can parse and project. |
| 5 | **String `_id`s** | Meteor collections accept only strings and ObjectIDs. Views depend on reading these rows as collections. |
| 6 | **`w: "majority"` by default, configurable** | "Committed before shown" should survive a failover unless the operator chooses otherwise. |
| 7 | **Pin `pi-durable` and `chord` exactly** | Upstream says the API changes without notice between releases. A bump is a verification event, as for pi-ai. |
| 8 | **The driver and the two runtime values are passed in** | The file loads unchanged under plain Node and under Meteor, and names no driver version. |

## 7. Limits and risks, named

- **Experimental upstream.** One day old; "the API changes without notice".
  The `Storage` contract is the narrowest thing to depend on. Everything
  above it (tasks, extensions, hooks) is a wider surface.
- **16 MB per record.** One entry is one BSON document.
- **One commit line per storage.** See §3.
- **A waiter on a replaced owner does not settle.** Its Session is poisoned
  and its reads still work, but `wait()` there hangs. The host must close a
  harness that lost its storage; `onReport` is how it learns.
- **Erasure is per storage.** See decision 3.
- **`esbuild` comes along.** Chord depends on it for a bundler Pi Durable
  never loads: 20 MB in the bundle, and an install script that runs when a
  bundle built on one platform is installed on another.
- **No hook can refuse a model request.** Budgets need the `Models` wrapper
  of §5.5.
- **Landing in this repo's release set is not free.** `release:check` requires
  every directory under `app/packages` to be a `core` or `channel` package at
  the shared version, with generated declarations. A third role, or another
  home, is needed.

## 8. Open decisions

1. **Where the package lives.** This repo's release set with a new role, or a
   repository of its own. The storage file has no Meteor dependency at all.
2. **Whether to offer the storage upstream.** The announcement asks for help;
   a Mongo backend with their conformance suite passing is a contained
   contribution, and it would get their review.
3. **The storage unit in Constellation.** Mission (decision 3) or session tree.
4. **The kernel.** §9.

## 9. The kernel question

Should `10thfloor:agent` run on Pi Durable instead of its own loop?

**For.** The kernel is the part of this repo that is hardest to keep right.
A race was found in it on 2026-10-01: the watcher can write a false
orphan-child note while a subagent's result is being committed. Pi Durable's
ownership tree removes the class that bug belongs to. Tasks, documents and
execution environments (§4) are things an application on this package has to
build for itself today. And provider behaviour (caching, deferred responses,
overflow, retry) would be maintained by pi-ai's authors.

**Against.** It is experimental and a day old. It is a rewrite of the engine
under a package that works, with a data migration, while work in progress
sits on the old engine. And two of the package's stated
properties change: tools stop being plain Meteor methods called by a loop we
own, and the transcript stops being documents a selector can reach into.

**Recommendation.** Do not move the kernel now. Build §5.2 to §5.4 as an
additive package, put one real Constellation surface on it, and decide after
that with evidence from use. Revisit when Pi Durable drops the experimental
label or after two upstream releases, whichever comes first, by running this
package's suite against each.

## 10. Next steps

1. Decide §8.1 and §8.2.
2. Host: lease, heartbeat, lazy open and close, the lapsed-lease sweep. Tests
   with two Meteor processes.
3. Ingress: request rows, exactly-once consumption, takeover.
4. Views: publication, client collections, Chord `apply` in the browser, an
   authorization callback. A browser test that watches an answer stream from
   an instance that does not own the storage.
5. One Constellation surface on it.
