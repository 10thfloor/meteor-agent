# Memory: a Mongo collection the user can read

**Status:** approved design, verified against the codebase (65 findings,
19 synthesized amendments folded in — the blockers rewrote decision 7);
building
**Date:** 2026-08-23
**Package:** `10thfloor:agent` (core — no new package)
**Depends on:** `2026-08-15-meteor-agent-harness-design.md` (built), participants model (built — decision 10 is load-bearing here)

Agents get durable recall — about the people they serve and about the work
itself — without a second database, a background pipeline, or a black box.
Memory is a Mongo collection plus a shared server core that both the model
and the user's UI reach, so "what does this app remember about me" is a
subscription and an edit button, not a support ticket.

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
2. **The recall tool** — `memory_search`, a `$vectorSearch` behind an
   inline tool. Every recall is a transcript row: auditable, budgeted,
   renderable.
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
| 4 | **Promotion to shared knowledge is an approval** — `memory_save` with `scope: 'app'` gates `'ask'` | The leakage risk (a user's PII saved into a pool every session reads) is governed by existing machinery: `describe` shows the approver the exact text, `budget.approval` times it out, the verdict is an audit row. The default gate is a PREDICATE reading `args.scope` — `'ask'` for app scope, `'auto'` otherwise — and an app may replace it. (`gate: true` is a define-time throw in this package; the loosened literal is `'auto'`.) |
| 5 | **Absent = absent** | No `memory` config → no tools, no block, no collection writes; behavior bit-for-bit today. The `participants?` idiom. |
| 6 | **Declaring `memory` registers the tools** | The skills precedent: declaring `skills` implies the loader. The model-facing tools need no `tools:` entry — `withMemoryTools` appends them after `expandMcpTools`, mirroring `withSkillTool`, with the same collision policy (the app's tool wins, one warning) and the same define-time name reservation as `SKILL_TOOL_NAME`. |
| 7 | **Two surfaces, one core** — model-facing INLINE tools and UI-facing DDP methods, both calling one shared server core | *(Amended after spec verification — the original "co-registered methods" mechanism is structurally impossible: an adopted method body receives only the Meteor invocation and args, so it can reach neither `sessionId`, the running agent name, the resolved memory config, nor the `by` stamp.)* The MODEL calls per-agent inline tools built at tool-assembly time, closing over the resolved config and `modelParticipantId(selfAgent)` and receiving `ToolContext`. The UI calls three global DDP methods. Both funnel into `saveMemory` / `searchMemory` / `forgetMemory` in `server/memory.ts`, which own every rule. "One code path" holds where it matters — the core — and the user-sovereignty story is unchanged: a memory page is a subscription plus the same core the model reaches. |
| 7a | **The DDP surface is NARROWER than the model surface** | Gates run only in the loop's dispatch path (`evaluateGate` has exactly one call site, `dispatch.ts`), so a DDP `memory.save { scope: 'app' }` would bypass the §7 approval entirely — a signed-in client writing shared knowledge unapproved. The method bodies therefore refuse `scope: 'app'` writes and app-row `forget` outright: **shared knowledge is written only through an approved model proposal or `Agent.memory` server-side**. Person/agent rows are freely DDP-writable by their owner. |
| 7b | **Global method registration is latched** | `Meteor.methods` throws on duplicate names and `defineAgent` is re-entrant, so "one registration per declaring agent" would crash the second memory-declaring agent (and any test defining two). One module-level latch registers the three methods at the first memory-declaring `define()`; everything per-agent resolves inside the bodies at call time. |
| 8 | **Recall is legible** | Nothing enters model context without either a visible tool row or the mechanical standing block (reconstructable from the collection at any time). No hidden injection, ever. |
| 9 | **The standing block reads the collection directly** (`findAsync`, not mongot) | Immune to mongot's change-stream indexing lag: a fact saved this turn appears in the next iteration's block, and in a colleague's next turn, immediately. |
| 10 | **Turn-zero hints are harness-mechanical** | The `resolveAddressee` posture: mechanical core, never a lens, never a model call. Query-time automated embedding means the hint is one database aggregation. Same store for every addressee → identical hints across the roster. |
| 11 | **The search ladder** — installed fn → `$vectorSearch` → `$text` → regex+recency | The typebox idiom: probe capability once, warn once, degrade gracefully; search quality narrows, never disappears, and never fails a turn. An app-installed `search` fn wins over every rung. |
| 12 | **mongot + automated embedding (Community 8.2) is the chosen vector rung** | Full vector on community edition — Atlas not required, matching "any Meteor 3.5 app with stock mongo can adopt it." Preview status is named in the README; the ladder is the safety net. |
| 13 | **Anonymous sessions WRITE nothing — person or app** | `userId: null` person memory would be one store shared by every anonymous stranger. Anonymous sessions *read* app memory (it has the same standing as `instructions`) and write neither scope. *(Amended after branch review. The first draft said they "cannot write it — the default `approve` predicate already refuses `userId: null`." **There is no default `approve` predicate**: `config.approve` is optional and the approval check is skipped entirely when it is absent, so an anonymous capability-URL holder could propose an app-scope save and approve it themselves. The refusal lives in the CORE now — on the delete path too — where it does not depend on a gate an app may never have configured. A deliberate consequence: channel sessions created before linking carry `userId: null`, so an unlinked participant can no longer get shared knowledge written or removed.)* |
| 14 | **Provenance is not authorization** | Rows carry `by` (a participant id or `'app'`) — the `from`-stamping idiom. The UI and models see *who* remembered; reading is gated by scope membership only. On app rows, `by: 'm:analyst'` lets `support` recall a fact and see which colleague learned it. **On a model-initiated save `by` is the MODEL's participant id, full stop** — the speaking member's id lives on the message `from` and never reaches a tool body (the TurnAnchor carries the owner only). Member attribution waits for per-member stores. |
| 19 | **Memory config follows the PRIMARY, not the addressee** | `buildRunConfig` composes the addressee's model/prompt/tools but takes the primary's *budget* — memory joins budget on that side of the line. Without this, an addressed turn to a memory-silent colleague would get no block, no hint and no tools, and §8's "identical recall whichever agent is addressed" would be false. The resolved bundle is threaded through `buildRunConfig` opts from the primary on every turn. |
| 20 | **Children and throwaways are excluded by SESSION, not config** | Tools are built from config alone, so the suppression check reads the session document: a session carrying `parent` (subagent child) or `ephemeral` (`Agent.ask`) gets no memory tools and no block. |
| 15 | **Caps and deliberate upsert** | `max` rows per (user, scope) — the `MAX_PARTICIPANTS` move — plus a per-row byte cap. An optional `key` gives save a deterministic identity: same key updates (insertOrLose, adopt on collision — the thread-key lesson), never duplicates. Dedup beyond that is the model's job (search before save, the tool description says so). The cap is checked against the config of the agent whose turn is saving; two agents with different `max` over one store is a named, accepted looseness (the cap bounds growth, it is not a quota). |
| 16 | **No automatic extraction in v1** | The model saves deliberately, through a tool whose description carries the judgment ("durable facts the user would expect you to remember — never conversation summaries"). Compaction already produces exactly the artifact an extractor wants; a compaction-adjacent hook is the named future seam. |
| 17 | **Decay is opt-in per row** | `expiresAt?` with a sparse TTL index (the download-token idiom). No global forgetting policy. |
| 18 | **`memories` joins the rate-limit table; `AgentMemories` joins the deny belt** | UI-editable methods on a public DDP surface follow the established pattern; a client write to the memory store must be impossible. |

## 3. What's in scope

Core (`10thfloor:agent`). The new collection completes the FULL package
checklist — the `downloads.ts` precedent, every item required: row type in
`common/types.ts`; Selector/Modifier + typed facade in `common/db.ts`;
declaration in `common/collections.ts` (the client bundle needs it for the
subscription); `NAMES` entries (collection + three method names); export and
`denyAllClientWrites` membership in `server/index.ts`; entries in
`server/indexes.ts`; a hand-added import in `tests/server.ts`; per-test
`removeAsync({})` resets.

Beyond the collection: the `memory` config block on `AgentConfig` with
`define()`-time validation and unknown-key rejection; resolved `memory?` on
`RunConfig`, threaded by `buildRunConfig` from the primary (decision 19);
`server/memory.ts` (the shared core + the search ladder + the probe and warn
latch + the `_setMemorySearch` test seam); `withMemoryTools` in
`server/tools.ts` plus the three reserved names; the latched DDP method
registration with its narrower policy (decision 7a); `Agent.memory`
(save/list/forget) server API; the `agent.memories` publication; the
standing block and hint in `runTurn`; the `memories` rate-limit entry;
README + by-example sections including mongot deployment notes.

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
- Indexes: `{ userId: 1, scope: 1, at: -1 }` for person/agent rows; **`{ scope: 1, at: -1 }`** for the app pool (app rows have no `userId`, so the compound index cannot serve the work section, the 500-row cap count, or the publication's app clause); a `$text` index on `text` (the fallback rung — `indexes.ts`'s spec key type widens to `1 | -1 | 'text'`, and its existing non-fatal warn-on-failure loop covers deployments that cannot create it); sparse TTL on `expiresAt`; the mongot vector index on `text` with automated embedding (definition shipped in the README — index provisioning is deployment-side, see §9).

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
// ── MODEL-FACING: inline tools, appended by withMemoryTools after
//    expandMcpTools. Provider-safe names (no dots — Anthropic's
//    ^[a-zA-Z0-9_-]{1,64}$). Each closes over the resolved config and the
//    running model's participant id; each receives ToolContext. ──
memory_save    { text, scope?, key?, pinned? }   // gate predicate: 'ask' when scope==='app'
memory_search  { query, limit? }                 // ladder top rung
memory_forget  { id }
```

```ts
// ── UI-FACING: three global DDP methods, registered ONCE behind a latch at
//    the first memory-declaring define(). NARROWER than the model surface
//    (decision 7a): app-scope writes and app-row forgets are refused here,
//    because gates do not run on the DDP path. ──
'memory.save'    { text, scope?, key?, pinned? }  // scope 'app' → Meteor.Error('denied-scope')
'memory.search'  { query, limit? }
'memory.forget'  { id }                           // app rows → Meteor.Error('denied-scope')
```

```ts
// ── THE SHARED CORE (server/memory.ts) — every rule lives here; both
//    surfaces above are thin adapters that supply `by` and the config. ──
saveMemory(args, { by, config, userId, agent })   // caps, byte cap, key upsert
searchMemory(query, { userId, agent, config, limit })  // the ladder
forgetMemory(id, { userId, allowApp })
listMemories({ userId, agent, config })           // the standing block's read
```

```ts
// ── Server API (the Agent.participants idiom) — the app's own way in,
//    unrestricted because it is server code, not a client. ──
await Agent.memory.save(userId, { text, scope?, key?, by? });  // by defaults 'app'
await Agent.memory.list(userId);        // person rows; Agent.memory.list(null) → app rows
await Agent.memory.forget(userId, id);
```

```ts
// ── The UI — one subscription, the DDP caps above ──
Meteor.subscribe('agent.memories');              // own person rows + app rows
await Meteor.callAsync('memory.forget', { id });
```

**Threading.** The resolved bundle joins `RunConfig` as `memory?` and is
threaded through `buildRunConfig`'s opts **from the primary's config on
every turn** (decision 19), beside `budget`. A hand-built test `RunConfig`
with no `memory` gets no block, no hint and no tools — the natural test
default.

**Name reservation.** The three model-facing names are reserved at
`define()` time against the agent's own tools, the way `SKILL_TOOL_NAME`
is; a collision at assembly time follows `withSkillTool`'s policy — the
app's tool wins, with one warning.

Config validation is a `define()`-time throw (the budget idiom): a string
`max`, an unknown scope name, a non-function `search` — startup errors, not
production surprises. `resolveMemory` **rejects unknown keys** (`memory: {
hint: false }` must not silently leave hints on): `[10thfloor:agent] memory
has an unknown key "hint"; expected hints/max/index/scopes/search`. Asserts:
`max` and `index.pinned`/`index.recent` positive integers (the
`assertCountLimit` idiom); `minScore` a finite number in [0,1]; `scopes` a
non-empty subset of `['user','agent','app']` — `'user'` is implied and
always present, so `scopes: ['app']` resolves to `['user','app']` rather
than throwing.

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

Up to `index.pinned` pinned rows (most-recent-first among pinned) always
precede the recent section; **overflow pinned rows do not consume recent
slots**, and the entry-count line signals that more exist. The remainder is
most-recent-first.

**Hint cadence, precisely.** System assembly happens per retry-ATTEMPT
inside the per-iteration loop, so "one aggregation per turn" and
"per-iteration assembly" cannot both be naive. The hint is computed **once
per (turn, newest-user-seq)**: a local cache keyed by the newest user row's
seq, recomputed only when that seq changes (the interjection `continue`
path, or a compaction re-read), and reused verbatim across every iteration
and retry attempt of the turn. The cheap standing-block `findAsync` stays
per-iteration; the embedding aggregation does not. Multi-iteration turns
re-render the same hint line.

The hint itself is one `$vectorSearch` (`$or` of the owner's person rows and
app rows) against the newest human message's text, threshold-gated by
`minScore`, titles only, never stored. Anonymous sessions render only the
work section and a "memory unavailable without an account" line; sessions
carrying `parent` or `ephemeral` render no block at all (decision 20).

**The ladder.** The search tool and the hint share one internal function:
installed `search` fn → `$vectorSearch` (probe: attempt once at first use,
cache the answer in module state) → `$text` → regex+recency. One warning at
FIRST USE names the active rung when it is not the top one, latched by
message prefix (the `warnedGateKinds` idiom) with a `_setMemorySearch` test
seam that resets both the latch and the probe cache and returns a restore
fn — `tests/server.ts` runs every suite in one process.

The **regex rung is specified, not hand-waved**: escape regex
metacharacters (a local `escapeRegExp` — the package has none), split the
query into tokens, `$or` of case-insensitive per-token `$regex` matches,
sorted `at: -1`. Unescaped user text (`order #8812 (dispute`) would
otherwise throw inside the hint path and break "never fails a turn".

A mongot outage mid-flight degrades that call (note-not-throw — the
media-fetch posture); the block, built by `findAsync`, is unaffected.

**Budgets.** Recalls and saves spend `toolCalls` like any tool. Hints cost
one aggregation, no tokens. Nothing here adds a budget kind.

## 7. Work memory and the approval flow

`memory.save { scope: 'app' }` parks under the standard gate machinery:

1. The default gate for app-scope saves is `'ask'` — a per-call predicate
   the app may override, loosen, or sharpen exactly like any tool gate.
2. `describe` renders "Remember for all users: «orders table
   soft-deletes…»" — the approver sees the exact text that would be
   shared. It carries the SCOPE and TEXT only: `describe`'s ctx is
   `{ userId, sessionId }` and it runs before `pending.agent` is written,
   so the proposing agent is not reachable there. The approval UI composes
   "(proposed by analyst)" from `pending.agent`, which IS written at park
   time — no contract change. The inline specs carry `describe` directly,
   so no change to the adopted-method options shape is needed.
3. Approve → the row lands (`by` = proposing participant). Deny → a
   structured refusal the model routes around. Unanswered →
   `budget.approval` denies with the standard timeout note.
4. Every verdict is an audit row: institutional knowledge with a paper
   trail — which agent proposed it, in which conversation, who approved.

Person-scope saves resolve `'auto'` (deliberate but unprompted — the tool
description carries the judgment); apps may replace the whole predicate.

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

## 10a. Build deviations (recorded after branch review)

Fourteen defects were confirmed against the built branch; three were
blockers. The design survived — none touched the data model, the scope
design, the ladder, or the approval flow — but four of them changed a rule
the spec had stated, and those are recorded here rather than silently fixed:

1. **Decision 13 was factually wrong** about a default `approve` predicate;
   the anonymous refusal moved into the core (see the amended row).
2. **`$vectorSearch` scoping is a pre-filter, not a post-`$match`.** The
   spec's §6 pipeline ranked the whole collection and filtered afterwards,
   which returns a handful of the right rows — or none — once a store holds
   more than one account's worth. The scope clause now rides the stage's
   `filter`, and the README's index definition declares `scope`, `userId`
   and `agent` as filter fields. The `$match` stays as a belt.
3. **The tool-name collision policy is PER NAME.** All-or-nothing dropped
   three tools when one collided while the standing block kept advertising
   them — an unknown-tool error on every turn that tried to remember.
4. **`memory_forget` has its own gate.** It takes `{ id }` and no scope, so
   the save gate's `args.scope` read resolved `'auto'` for every delete:
   writing to the shared pool asked, erasing from it did not. The forget
   gate reads the ROW's scope, and `allowApp` now follows the agent's own
   scopes rather than being passed unconditionally.

The rest were implementation defects against rules the spec already
stated correctly: pinned overflow eating recent slots (§6), `minScore`
validated but never applied (§6), `pinned: false` silently no-op, unmarked
truncation in `describe` (§7), a transient mongot failure latching the
vector rung off permanently (§2.11), an installed `search` fn's rows not
re-scoped, keyed saves racing without a unique index (§2.15), agent-scope
writes resolving to whichever agent was defined first, unnamespaced DDP
method names, and a publication limit below the caps it serves.

## 11. Open questions

- **Per-member stores** in multi-human sessions (saves keyed to a member,
  not the owner) — deferred with room left in the row.
- **Forgetting app rows** — v1 refuses it on the DDP surface entirely
  (decision 7a); the model may call `memory_forget` on an app row only
  through the same gate its save went through. Whether members may
  *propose* deletions (a "forget this" approval flow) is future.
- **Score-threshold defaults** for hints (`minScore`) need empirical
  tuning against mongot's normalized scores during the build.
- **Compaction-extraction hook** — shape reserved: an `afterCompaction`
  hook receiving the summary and a `propose(text, scope)` capability.

## 12. Philosophy check

| Tenet | Honored by |
|---|---|
| Transcript is a Mongo collection | Memory is one too — same durability, ops, reactivity |
| Tools are Meteor methods | Both surfaces funnel into one shared core; the UI's are real DDP methods |
| Authorization is `this.userId` | Person store keyed by owner id; turns run as owner; null rule untouched |
| Optional and additive | `memory?` absent = bit-for-bit today |
| Degrade, never die | The search ladder; block reads survive mongot down |
| Legibility | Every recall a transcript row; the block mechanical and reconstructable |
| Budgets bound loop work | Recalls spend `toolCalls`; app-scope writes spend an approval |
| Single-winner writes | `key` upsert via insertOrLose, adopt on collision |
| User sovereignty | Subscribe, edit, delete; app knowledge carries an audit trail |
