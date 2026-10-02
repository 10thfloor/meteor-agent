# 10thfloor:durable

[Pi Durable](https://earendil.com/posts/pi-durable/) on Meteor: a MongoDB
storage backend for `@earendil-works/pi-durable`, opened on the Mongo
connection your Meteor server already has.

**Status: a spike.** Pi Durable itself is experimental and says its API
changes without notice. This package holds the storage layer and nothing
above it yet: no leases, no methods, no publications. The plan for those is in
[`docs/superpowers/specs/2026-10-02-pi-durable-on-meteor.md`](../../../docs/superpowers/specs/2026-10-02-pi-durable-on-meteor.md).

## Install

```bash
meteor add 10thfloor:durable
meteor npm install --save --save-exact @earendil-works/pi-durable @earendil-works/chord @earendil-works/pi-ai
```

Pin the first two exactly. Mongo must support transactions: a replica set, as
`meteor run` starts and as `10thfloor:agent` already requires.

## Use

```ts
import { loadChord, loadPiDurable, openMongoStorage } from 'meteor/10thfloor:durable';

const { Harness, createRegistry } = await loadPiDurable() as any;
const { BACKGROUND_CONTEXT: context } = await loadChord('context') as any;

// One storage is one Pi Durable Session: its conversations, tasks and documents.
const storage = await openMongoStorage('mission:42');
const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
harness.resume(); // continue whatever the last owner left unfinished

const root = await harness.root(context, { agent: { model: { provider: 'anthropic', modelId: '…' } } });
const submission = await root.submit({ type: 'input', content: 'Hello', requestId: 'msg-1' }, context);
await submission.wait(context);
```

`loadPiDurable()` and `loadChord()` exist because Meteor's resolver does not
follow `exports` maps, and these packages publish their entry points only
through one. It is the same seam `10thfloor:agent` uses for pi-ai.

## What the storage does

It implements Pi Durable's `Storage` contract and passes the package's own
conformance suite. It follows the upstream SQLite backend table for table:

- One Mongo transaction is one Session commit. Either every record and
  document write of a commit is stored, or none is.
- Records are stored as JSON text beside the few columns the contract's scans
  need, so nothing is lost to BSON: a key named `__proto__` or `$ref`, a lone
  surrogate, and an ID near 2^53 all survive.
- Documents are bases plus ordered Chord delta tails. A current-only document
  keeps nothing older than its newest base; a rewindable one keeps everything.

Two things are Mongo's own:

- **Many storages share the collections.** Every row carries the storage key
  and every index starts with it. `destroyMongoStorage(key)` removes one
  storage and nothing else.
- **Ownership is enforced.** Pi Durable assumes one process owns a storage at
  a time and does no locking. Here `openMongoStorage(key)` takes the storage's
  epoch, and every commit checks that epoch inside its transaction. An owner
  that was replaced gets `StorageOwnershipLost` and can never write again; it
  can still read. Deciding who may open a key, and when, is not this
  package's job yet.

Because the rows are in Mongo, any server instance can watch a conversation
with an ordinary cursor: entries arrive as they are committed, and a streamed
answer arrives as delta rows of the conversation's `pi.live` document. Pi
Durable on its own can only show a conversation to clients attached to the one
process that owns the storage.

## What a commit costs

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
so a streamed answer took the same 2.8 s of wall time on every backend. Pass
`{ writeConcern: { w: 1 } }` to `openMongoStorage` to trade failover safety
for speed, as the SQLite backend does with `synchronous = NORMAL`.

To measure it on your own deployment:

```bash
DURABLE_BENCH=1 MOCHA_GREP='commit costs' TEST_CLIENT=0 meteor test-packages --once \
  --port 3200 --driver-package meteortesting:mocha ./packages/durable
```

## Limits

- One record is one BSON document: 16 MB at most.
- All conversations of one storage commit through one line, one commit at a
  time. Use one storage per unit that works together (a mission), not one for
  the whole app.
- Chord depends on `esbuild`, which adds a 10 MB platform binary and an
  install script to the bundle. Pi Durable never loads it.

## Tests

```bash
TEST_CLIENT=0 meteor test-packages --once --port 3200 --driver-package meteortesting:mocha ./packages/durable
```

They need no API key and no network: the model is pi-ai's faux provider.
