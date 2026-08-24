# Memory: a Mongo collection the user can read

**Status:** approved design; not yet planned or built
**Date:** 2026-08-23
**Package:** `10thfloor:agent` (core — no new package)
**Depends on:** `2026-08-15-meteor-agent-harness-design.md` (built), participants model (built — decision 10 is load-bearing here)

Agents get durable recall — about the people they serve and about the work
itself — without a second database, a background pipeline, or a black box.
Memory is a Mongo collection plus co-registered tools: the model and the
user's UI call the same methods through the same schema, so "what does this
app remember about me" is a subscription and an edit button, not a support
ticket.

## 1. The idea

The harness's thesis extends one clause: **the transcript is a Mongo
collection; memory is a second one.** `AgentMemories` rows are ordinary
documents — published, editable, deletable, deny-belted. Semantic recall
comes from MongoDB's own vector search (mongot, with automated embedding),
so the operational store and the search index are the same collection and
there is no embedding pipeline to manage.

Two kinds of memory, one row shape:

- **Person memory** (`scope: 'user'`, the default): what the deployment
  knows about one human — preferences, resolved disputes, standing context.
  Keyed by `userId` alone; every agent the user talks to reads the same
  store. **Memory follows the human, not the model.**
- **Work memory** (`scope: 'app'`): what the deployment has learned about
  its own domain — "the orders table soft-deletes", "refunds over $500 need
  finance sign-off". One shared pool, readable by every agent in every
  session. Writing to it is an *approval* (§7).

A third scope, `agent`, gives an agent private per-user notes. The fourth
quadrant (agent-private, cross-user) is deliberately not built (§11).

Recall has three mechanisms, none of them hidden:

1. **The standing block** — a capped index of titles appended per-iteration
   inside `runTurn` (the participants-block idiom): the model always knows
   what it knows, at near-zero token cost.
2. **The recall tool** — `memory.search`, a `$vectorSearch` behind a
   co-registered method. Every recall is a transcript row: auditable,
   budgeted, renderable.
3. **Turn-zero hints** — the harness (never a model) runs one
   threshold-gated search on each incoming human message and appends
   matching *titles* to the standing block. One aggregation, zero tokens,
   zero provider calls.

Auto-RAG injection — embedding every send and silently stuffing top-k into
the prompt — is rejected outright: it breaks transcript legibility (context
with no row), busts the prompt cache every turn, and puts no judgment and
no budget between retrieval and context.

## 2. Decisions already made

| # | Decision | Why |
|---|---|---|
| 1 | **Memory is a Mongo collection, not a second database** | The Meteor way: same durability, same ops, same reactivity. mongot makes an external vector store unnecessary. |
| 2 | **Memory follows the human** — `scope: 'user'` is the default, keyed by `userId` alone | Sharing across roster agents *derives* from "a turn always runs as the session owner" (participants decision 10): every model participant queries the owner's store. Sharing is a consequence, not a feature. |
| 3 | **Work memory is `scope: 'app'`** — one pool, no `userId`, readable by every agent in every session | "The agent learns the job" requires facts that transcend users. The absence of `userId` on the row *is* the sharing, made explicit. |
| 4 | **Promotion to shared knowledge is an approval** — `memory.save` with `scope: 'app'` defaults to `gate: 'ask'` | The leakage risk (a user's PII saved into a pool every session reads) is governed by existing machinery: `describe` shows the approver the exact text, `budget.approval` times it out, the verdict is an audit row. Apps may loosen (`gate: true`) or tighten per risk appetite — it is an ordinary gate. |
| 5 | **Absent = absent** | No `memory` config → no tools, no block, no collection writes; behavior bit-for-bit today. The `participants?` idiom. |
| 6 | **Declaring `memory` registers the tools** | The skills precedent: declaring `skills` implies the loader. `memory.save` / `memory.search` / `memory.forget` need no `tools:` entry. |
| 7 | **Tools are co-registered methods** | The model and the user's UI call the same code through the same schema. A user-facing memory page is a subscription plus the same `memory.forget` the model calls. One `deleteMany` is data deletion. |
| 8 | **Recall is legible** | Nothing enters model context without either a visible tool row or the mechanical standing block (reconstructable from the collection at any time). No hidden injection, ever. |
| 9 | **The standing block reads the collection directly** (`findAsync`, not mongot) | Immune to mongot's change-stream indexing lag: a fact saved this turn appears in the next iteration's block, and in a colleague's next turn, immediately. |
| 10 | **Turn-zero hints are harness-mechanical** | The `resolveAddressee` posture: mechanical core, never a lens, never a model call. Query-time automated embedding means the hint is one database aggregation. Same store for every addressee → identical hints across the roster. |
| 11 | **The search ladder** — installed fn → `$vectorSearch` → `$text` → regex+recency | The typebox idiom: probe capability once, warn once, degrade gracefully; search quality narrows, never disappears, and never fails a turn. An app-installed `search` fn wins over every rung. |
| 12 | **mongot + automated embedding (Community 8.2) is the chosen vector rung** | Full vector on community edition — Atlas not required, matching "any Meteor 3.5 app with stock mongo can adopt it." Preview status is named in the README; the ladder is the safety net. |
| 13 | **Anonymous sessions have no person store** | `userId: null` person memory would be one store shared by every anonymous stranger. The block states memory is unavailable; the null rule (null matches only null) is untouched. Anonymous sessions *read* app memory (it has the same standing as `instructions`) but cannot write it — the default `approve` predicate already refuses `userId: null`. |
| 14 | **Provenance is not authorization** | Rows carry `by` (a participant id or `'app'`) — the `from`-stamping idiom. The UI and models see *who* remembered; reading is gated by scope membership only. On app rows, `by: 'm:analyst'` lets `support` recall a fact and see which colleague learned it. |
| 15 | **Caps and deliberate upsert** | `max` rows per (user, scope) — the `MAX_PARTICIPANTS` move — plus a per-row byte cap. An optional `key` gives save a deterministic identity: same key updates (insertOrLose, adopt on collision — the thread-key lesson), never duplicates. Dedup beyond that is the model's job (search before save, the tool description says so). |
| 16 | **No automatic extraction in v1** | The model saves deliberately, through a tool whose description carries the judgment ("durable facts the user would expect you to remember — never conversation summaries"). Compaction already produces exactly the artifact an extractor wants; a compaction-adjacent hook is the named future seam. |
| 17 | **Decay is opt-in per row** | `expiresAt?` with a sparse TTL index (the download-token idiom). No global forgetting policy. |
| 18 | **`memories` joins the rate-limit table; `AgentMemories` joins the deny belt** | UI-editable methods on a public DDP surface follow the established pattern; a client write to the memory store must be impossible. |

## 3. What's in scope

Core (`10thfloor:agent`): the `AgentMemories` collection, NAMES entry,
deny-belt membership, indexes (compound, `$text` fallback, sparse TTL, and
the mongot vector index definition); the `memory` config block on
`AgentConfig` with validation at `define()` time; the three co-registered
tools and their registration-on-declaration; `Agent.memory`
(save/list/forget) server API; the `agent.memories` publication (own rows +
app rows); the standing block in `runTurn`'s per-iteration assembly; the
turn-zero hint; the search ladder with startup capability probe; the
`memories` rate-limit entry; README + by-example sections including mongot
deployment notes.

**Out of scope by design:** automatic extraction (§2.16); a fourth scope
(§11); per-member stores in multi-human sessions (§11); cross-deployment
sync; memory for `Agent.ask` throwaways and subagent children (children
inherit nothing and register nothing — their transcripts fold back into the
parent, which is the memory-bearing conversation); embeddings of anything
other than `text` (no image memory); any UI beyond the publication (the
demo app gets a reference memory page, the package ships none).

## 4. The row and the collection

```ts
interface AgentMemory {
  _id: string;
  userId?: string;            // present for 'user'/'agent' rows; ABSENT for 'app' rows
  scope: 'user' | 'agent' | 'app';   // 'app' opt-in via config; row shape final
  agent?: string;             // present only for scope: 'agent'
  text: string;               // the fact — the field mongot auto-embeds
  by: string;                 // participant id ('h:…', 'm:…') or 'app' — provenance
  key?: string;               // deliberate-upsert identity (derived by caller)
  pinned?: true;              // always present in the standing block
  at: Date;
  expiresAt?: Date;           // sparse TTL — decay opt-in per row
}
```

- `userId` is **never null** — it is present (a real account id) or absent
  (`app` rows). The person-store read predicate is an equality on the
  session owner's id; the app-store predicate is `scope: 'app'`. The two
  never mix in one predicate by accident because the hint and search
  queries name them explicitly (`$or`).
- Byte cap on `text` (default 2000 chars) enforced in the method — a
  memory is a fact, not a document. Refusals are structured
  (`invalid-args` naming the limit), never silent truncation.
- Indexes: `{ userId: 1, scope: 1, at: -1 }`; a `$text` index on `text`
  (the fallback rung); sparse TTL on `expiresAt`; the mongot vector index
  on `text` with automated embedding (definition shipped in the README —
  index provisioning is deployment-side, see §9).

## 5. The API

```ts
// ── Agent.define — one optional block; object form shows all defaults ──
Support.define({
  // ...
  memory: true,                      // shorthand: all defaults
  memory: {
    hints: true,                     // turn-zero hint; false to disable, { minScore } to tune
    max: 200,                        // rows per (user, scope); app pool: 500
    index: { pinned: 5, recent: 10 },// standing-block caps (per section)
    scopes: ['user'],                // add 'agent' and/or 'app' to opt in
    search: async (q) => [...],      // app-installed rung — wins over the ladder
  },
});
```

```ts
// ── The tools (auto-registered; also plain Meteor methods) ──
memory.save    { text, scope?, key?, pinned? }   // scope 'app' → gate 'ask' by default
memory.search  { query, limit? }                 // ladder top rung; rows w/ text, by, at, scope
memory.forget  { id }                            // owner-authorized; app rows: approvers only
```

```ts
// ── Server API (the Agent.participants idiom) ──
await Agent.memory.save(userId, { text, scope?, key?, by? });  // by defaults 'app'
await Agent.memory.list(userId);        // person rows; Agent.memory.list(null) → app rows
await Agent.memory.forget(userId, id);
```

```ts
// ── The UI — same methods, one subscription ──
Meteor.subscribe('agent.memories');              // own person rows + app rows
await Meteor.callAsync('memory.forget', { id }); // the same method the model calls
```

Config validation is a `define()`-time throw (the budget idiom): a string
`max`, an unknown scope name, a non-function `search` — startup errors,
not production surprises.

## 6. Retrieval mechanics

**The standing block** is appended inside `runTurn` per iteration, from a
direct `findAsync`, capped by `index` config, two sections:

```
## Memory
About Mackenzie (7 entries): 
- prefers email over Slack for anything billing-related
- order #8812 dispute resolved 2026-08-20 — auth hold, not double charge
About this work (3 entries):
- orders table soft-deletes; filter deletedAt: null   [learned by analyst]
Matching this message: order #8812 dispute (person)
Use memory.search to recall details; memory.save to remember new facts.
```

Pinned rows always appear; the remainder is most-recent-first. The
"Matching this message" line is the turn-zero hint: one `$vectorSearch`
(`$or` of the owner's person rows and app rows) against the newest human
message's text, threshold-gated by `minScore`, titles only, rebuilt each
turn, never stored. Anonymous sessions render only the work section and a
"memory unavailable without an account" line.

**The ladder.** The search tool and the hint share one internal function:
installed `search` fn → `$vectorSearch` (probe: attempt against the
collection once at first use, cache the answer) → `$text` → regex+recency.
One startup-style warning names the active rung when it is not the top
one. A mongot outage mid-flight degrades that call (note-not-throw — the
media-fetch posture); the block, built by `findAsync`, is unaffected.

**Budgets.** Recalls and saves spend `toolCalls` like any tool. Hints cost
one aggregation, no tokens. Nothing here adds a budget kind.

## 7. Work memory and the approval flow

`memory.save { scope: 'app' }` parks under the standard gate machinery:

1. The default gate for app-scope saves is `'ask'` — a per-call predicate
   the app may override, loosen, or sharpen exactly like any tool gate.
2. `describe` renders "Remember for all users: «orders table
   soft-deletes…» (proposed by analyst)" — the approver sees the exact
   text that would be shared.
3. Approve → the row lands (`by` = proposing participant). Deny → a
   structured refusal the model routes around. Unanswered →
   `budget.approval` denies with the standard timeout note.
4. Every verdict is an audit row: institutional knowledge with a paper
   trail — which agent proposed it, in which conversation, who approved.

Person-scope saves default `gate: true` (deliberate but unprompted — the
tool description carries the judgment); apps may gate those too.

## 8. n:n and identity

- A turn runs as the session owner (participants decision 10), so every
  roster model queries the owner's person store and the shared app store —
  identical recall and identical hints, whichever agent is addressed.
- In multi-human sessions, saves land in the **owner's** store, attributed
  via `by`. A fact about member Dana is a fact the owner's relationship
  remembers. Per-member stores are future work; the row shape (userId key
  + provenance) leaves room.
- `scope: 'agent'` rows add `agent` to the key: private per (agent, user).
  Registered only when the config opts in.

## 9. Operations: mongot

The one new infrastructure ask, named honestly in the README:

- MongoDB **Community 8.2+** with the **mongot** sidecar (search binary,
  synced via change streams). Vector + full-text search there is
  **preview-labeled** by MongoDB; the ladder (§6) is the production safety
  net — a deployment without mongot runs on `$text` with one warning and
  no other difference.
- The vector index (automated-embedding definition on `text`) is created
  deployment-side; the README ships the exact `createSearchIndex` call.
- Galaxy: works today on the `$text` rung against Galaxy MongoDB; the
  vector rung lights up if/when Galaxy operates mongot. Atlas deployments
  get the vector rung via Atlas Vector Search unchanged — the ladder does
  not care which side of the wire embeds.

## 10. Rejected alternatives

| Option | Why not |
|---|---|
| Auto-RAG injection per send | Hidden context (no transcript row), per-turn prompt-cache invalidation, zero judgment or budget in the loop |
| External vector database | A second database is the anti-Meteor move; mongot removes the need |
| Automatic background extraction | Deferred; compaction already yields the artifact — hook seam named (§2.16) |
| A "librarian" memory subagent | Already expressible today via `{ subagent }`; an app pattern, not core |
| Session-scoped memory kind | The transcript *is* the session's memory; compaction distills it |
| Per-agent silos as default | Overturned: memory follows the human; `agent` scope survives as opt-in |
| Fourth scope (agent-private, cross-user) | If an agent learns the job, the roster deserves it; `by` preserves credit. YAGNI. |

## 11. Open questions

- **Per-member stores** in multi-human sessions (saves keyed to a member,
  not the owner) — deferred with room left in the row.
- **`memory.forget` on app rows** — v1 restricts to callers passing the
  agent's `approve` predicate; whether members may propose deletions
  (a "forget this" approval flow) is future.
- **Score-threshold defaults** for hints (`minScore`) need empirical
  tuning against mongot's normalized scores during the build.
- **Compaction-extraction hook** — shape reserved: an `afterCompaction`
  hook receiving the summary and a `propose(text, scope)` capability.

## 12. Philosophy check

| Tenet | Honored by |
|---|---|
| Transcript is a Mongo collection | Memory is one too — same durability, ops, reactivity |
| Tools are Meteor methods | Model and UI share one code path through one schema |
| Authorization is `this.userId` | Person store keyed by owner id; turns run as owner; null rule untouched |
| Optional and additive | `memory?` absent = bit-for-bit today |
| Degrade, never die | The search ladder; block reads survive mongot down |
| Legibility | Every recall a transcript row; the block mechanical and reconstructable |
| Budgets bound loop work | Recalls spend `toolCalls`; app-scope writes spend an approval |
| Single-winner writes | `key` upsert via insertOrLose, adopt on collision |
| User sovereignty | Subscribe, edit, delete; app knowledge carries an audit trail |
