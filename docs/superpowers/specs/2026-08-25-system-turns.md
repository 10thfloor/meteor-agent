# System turns: work that starts without a person

**Status:** historical design record; implemented. Current source and tests are authoritative.
**Date:** 2026-08-25
**Package:** `10thfloor:agent` (core — no new package)
**Depends on:** `2026-08-23-participants-and-closing-the-loops.md` (built — decision 7 is amended here), `2026-08-15-meteor-agent-harness-design.md` (built)

## 1. The idea

Every entry into a turn is a human action. `agent.send`, `agent.approve`,
`agent.deny` — all of them assume a person on the other end, and
`sendToSession` writes a `role: 'user'` row attributed to the session's owner
(`methods.ts:513-525`).

There is no way to say *"start a turn because it is 6:30 in the morning"*.

An app that needs one has to lie: call `send` on a timer and let the transcript
record a machine's work as a named human's. That lie is not cosmetic. It puts a
person's identity on an action they did not take, in a record whose whole
purpose is to say who authorized what. And because the framework believes a
person spoke, three further things go wrong — the send resets the relay hop
count, it spends the human turn budget, and there is nowhere to put the request
if the session is busy, so it is simply dropped.

This spec adds the missing primitive: **a turn that starts from a non-human
origin, is attributed to no person, waits its turn behind live work, and cannot
be lost or double-fired by a crash.**

### What this is not

It is not a scheduler. Cron semantics — "06:30 local, weekly on Tuesday, catch
up after downtime" — are business facts that belong to the app that has them.
This spec ships the thing a scheduler *calls*, and nothing that decides when to
call it. See §12.

## 2. Decisions already made

| # | Decision | Why |
|---|---|---|
| 1 | **A fourth message role, `'system'`** | The role is the provenance record. Reusing `'user'` with a text marker is what the app-level workaround already does, and it is exactly the lie this spec exists to remove. `AgentMessage.role` (`common/types.ts:346`) is additive — no exhaustiveness guard exists anywhere in the package, so every switch site is found by hand, not by the compiler (§11). |
| 2 | **A `s:` participant id namespace, and no roster row** | Attribution needs an id; the roster does not need a member. `participantsBlock` renders `p.kind` verbatim into every prompt (`participants.ts:151`), `needsAttribution` counts every non-human row as a model (`:132`) — a `kind: 'system'` roster row would change the system prompt of every rostered session and silently flip `[name]: ` prefixing on 1:1 sessions. `subagent.ts:430` is the precedent: a `from.participant` outside the roster, resolved by `nameOf`'s fallback (`transcript.ts:80-82`). |
| 3 | **`from` is stamped on a system row unconditionally — roster or not** | *(Rewritten from the draft, which roster-gated it to match `sendToSession:522`.)* The byte-identical-1:1 invariant protects rows that existed before the roster did. A system row is net-new: a session with no system turns still projects byte-identically, so there is nothing to preserve. Roster-gating would drop attribution in precisely the 1:1 case scheduled work actually uses. This also resolves a live contradiction — `types.ts:427-438` says `from` is stamped "on every new row regardless of roster"; `methods.ts:522` gates it. Both stay; the system row follows the doc comment. |
| 4 | **The wire projection is a marked `user` message, decided explicitly** | No provider has a mid-conversation system message: `ProviderMessage.role` is `'user'\|'assistant'\|'tool'` (`providers/types.ts:8`), and the single system channel is `ProviderRequest.system`, which `loop.ts:536` rebuilds every iteration — routing a one-shot instruction there would make it standing and strip its position in history. The projection is the idiom the codebase has already chosen twice: a compaction note becomes `[Earlier conversation, compacted]` (`compaction.ts:62`), a colleague's row becomes `[name]: …` (`transcript.ts:98`). |
| 5 | **Its own budget dimension, `budgetSpent.systemTurns`** | Scheduled work and human work are different purses and an operator tunes them separately. Declared **optional** — `turns`/`toolCalls` are required and seeded at five insert sites (`agent.ts:124`, `methods.ts:590`, `fork.ts:154`, `subagent.ts:363`, `channels/ingress.ts:187`); a required sixth breaks all five plus ~30 fixtures and leaves every persisted session without the field. |
| 6 | **A budget refusal is a refusal, not a stop** | *(Rewritten from the draft, which reached for `commitBudgetNote`.)* `commitBudgetNote` sets `phase: 'stopped'` (`turn-state.ts:144-155`), which wedges the session until a human sends. Wedging a conversation because a *machine's* purse ran out is backwards. This follows `turns` instead (`methods.ts:504-511`): the bound is folded into the park selector, a miss writes nothing at all, and the caller gets a structured reason. |
| 7 | **A system turn does not reset `relay`, and does not clear `pendingRelay`** | This amends **participants decision 7**, whose rule is "a human message outranks a pending relay, at any seq". The rule is about *humans*: a person interjecting is a new instruction that supersedes a colleague hand-off. A machine's scheduled prompt is not an interjection and has no standing to cancel work the team is mid-way through. Mechanically a pure omission — the clauses at `methods.ts:498` and `:500` are not copied. |
| 8 | **Busy sessions park a durable standing intent; they do not drop the request** | The failure this closes is the sharpest one in practice: a session parked on an approval is not `idle`, so under the app-level workaround the *next* firing is skipped and its schedule slot advanced — dropped, not deferred. `pendingSystem` is a top-level optional on `AgentSession`, sibling to `pendingRelay` (`types.ts:319`). |
| 9 | **One standing intent per session. A second is refused — not queued, not overwritten** | Overwriting silently destroys scheduled work; queueing N is a job queue, a different feature (§8). One slot matches `pendingRelay`'s shape, and a refused caller is a scheduler that comes back on its next tick. *(The draft also leaned on this decision to justify §4.7's latch. It does not carry that weight — see the note there.)* |
| 10 | **A human send does NOT cancel a standing intent** | The deliberate asymmetry with decision 7. A relay is cancelled by a human because the human is answering the same conversation the relay was about. A standing system intent is unrelated work that happens to share a session; dropping it because somebody typed would make scheduled work vanish at random. The human's turn runs first because it is live; the intent fires at the next idle. |
| 11 | **A park is refused on a halted session, and a stale intent may be replaced** | *(Added by review — two lenses found the same hole independently.)* `WAKE_EXCLUDED` keeps the sweep off `stopped`/`error` sessions, so an intent parked into one would stand forever and, by decision 9, refuse every later firing — a permanent block from a transient failure. So: parking is refused outright with `session-halted` when the phase is `stopped` or `error` (the scheduler learns on its next tick instead of discovering months later that nothing ran), and a park may **replace** an intent older than `intentTtlMs` (default 24h). `awaiting` still parks — that is the case this feature exists for. |
| 12 | **Idempotency is a `$ne` on the park selector, backed by a key-derived `_id`** | Not a unique index: `ensureIndexes` is non-fatal by design (`indexes.ts:236-244`), so an index-backed guarantee silently disappears when the build fails — the trap that already bit memory. `lastSystemKey` in the selector is single-winner and needs no index; the system row's `_id`, derived from **the idempotency key** (not the token — a fresh token per call would make the backstop protect nothing), is the permanent guard against a repeated key ever writing a second row. |
| 13 | **One consume path, three triggers** | The intent is written by one function and consumed by exactly one other. Immediate consumption after parking, the loop's wind-down wake, and the watcher's sweep all call the same `consumeSystemIntent`. |
| 14 | **The marker is cleared by the turn's first commit, never by the consume** | *(Rewritten from the draft, which unset it in the consume's own write — the review's blocker.)* `deferResolvedTurn` is not a turn: it is `Meteor.defer(() => runTurn(...))` (`methods.ts:96-109`), and `runTurn` returns silently on `running.has(sessionId)` (`loop.ts:184`) or a lost `claimLease` (`:187`). Unsetting outside a turn therefore strands the row and the spent budget with **no crash required**, and nothing can recover it. The relay solved this already, deliberately: `pendingRelay` rides `allocateSeq`'s `$unset` on the woken turn's first commit (`turn-state.ts:94-99`, `loop.ts:713-717`) precisely so a failure anywhere before that leaves the wake standing. System turns follow it exactly. The budget `$inc` moves to that same commit, so a turn that never ran is never billed. |
| 15 | **The watcher gets a real index, keyed on what the sweep ranges over** | CASE 5 (`pendingRelay`) runs unindexed every 15s; that debt is recorded here for the first time and CASE 6 must not inherit it. Keyed `{ 'pendingSystem.at': 1 }` — keying the whole subdocument cannot serve the range predicate and would put app-authored prompt text in the index. `partialFilterExpression` rather than `sparse`: a compound sparse index drops a document only when it is missing *every* indexed field, and a partial filter "cannot be added later without dropping the index by name" (`indexes.ts` header). |
| 16 | **Server-only, no DDP surface** | A system turn has no caller to authorize. Exposing it over DDP would hand every client a way to start turns that bypass both the turn budget and the rate limiter (whose rules match method names). It is app code calling app code, like `Agent.ask`. |

## 3. What's in scope

- `startSystemTurn(sessionId, prompt, opts?)` and `Agent#systemTurn(...)`
- `role: 'system'` end to end — stored, projected, published, rendered
- `budgetSpent.systemTurns` and `budget.systemTurns`
- `pendingSystem` — the durable standing intent, its consume path, its wake
- watcher CASE 6 and its index
- the test matrix in §10

Out of scope: schedules, cron, timezones, catch-up policy, a job queue,
system-turn-only tools (a system turn uses the agent's ordinary tools).

## 4. How it works

### 4.1 The new surface

```ts
// server-only
export async function startSystemTurn(
  sessionId: string,
  prompt: string,
  opts?: {
    key?: string;      // idempotency: the same key twice runs once
    agent?: string;    // which teammate answers; defaults to session.agent
    source?: string;   // what scheduled it — becomes `s:<source>` attribution
  },
): Promise<SystemTurnResult>;

export type SystemTurnResult =
  | { ok: true; ran: true }                       // consumed immediately
  | { ok: true; ran: false; parked: true }        // standing; fires at next idle
  | { ok: false; reason:
      | 'duplicate-key'      // this key already claimed on this session
      | 'intent-standing'    // another intent already waiting (decision 9)
      | 'session-halted'     // phase is stopped or error (decision 11)
      | 'budget-exhausted'   // budget.systemTurns reached (decision 6)
      | 'no-session'
      | 'no-agent' };
```

`Agent#systemTurn(sessionId, prompt, opts)` is the instance sugar, server-only
beside `ask`. Both are exported from `server/index.ts`.

### 4.2 New fields

```ts
// On AgentSession — all optional, additive, migration-free
pendingSystem?: {
  prompt: string;
  agent?: string;          // target teammate; absent = session.agent
  source?: string;         // attribution source (decision 2)
  key?: string;            // the idempotency key, for the derived row _id
  token: string;           // wake identity, never presence (§4.6)
  at: Date;                // the intent's OWN age — not `updatedAt` (§4.6)
};
lastSystemKey?: string;    // idempotency slot (decision 12)
budgetSpent: { turns: number; toolCalls: number; systemTurns?: number };

// On AgentMessage
role: 'user' | 'assistant' | 'tool' | 'note' | 'system';

// On AgentConfig['budget'], ResolvedBudget, and RunConfig['budget']
systemTurns?: number;
```

`SessionCounterPath` (`types.ts:51-57`) gains `'budgetSpent.systemTurns'`, or
`{ 'budgetSpent.systemTurns': 1 } satisfies SessionInc` does not compile.

### 4.3 Park

`startSystemTurn` reads before it writes — the read is unavoidable and the draft
omitted it. It needs `session.agent` to resolve the config whose
`budget.systemTurns` bounds the park, and it needs the phase to answer
decision 11:

1. `const session = await AgentSessions.findOneAsync(sessionId)` → `no-session`.
2. `const config = getAgent(opts?.agent ?? session.agent)` → `no-agent`. When
   `opts.agent` names an unregistered agent this is a hard refusal, **not** the
   visible primary fallback `deferResolvedTurn` uses (`methods.ts:134-140`) — a
   scheduler naming a teammate that does not exist has a config bug, and
   silently answering as somebody else would hide it. The *budget* consulted is
   the primary's, matching how an addressed send composes (`methods.ts:544`).
3. Refuse `session-halted` if `session.phase` is `stopped` or `error`.
4. One conditional write, single-winner:

```ts
const token = Random.id();
const now = new Date();
const claimed = await AgentSessions.rawCollection().findOneAndUpdate(
  {
    _id: sessionId,
    phase: { $nin: ['stopped', 'error'] },
    ephemeral: { $ne: true },                                      // §9 resolved
    $and: [
      { $or: [                                                     // decision 9 + 11
        { pendingSystem: { $exists: false } },
        { 'pendingSystem.at': { $lt: new Date(now.getTime() - intentTtlMs) } },
      ] },
      ...systemBudgetClause(config.budget?.systemTurns),           // §4.4
    ],
    ...(opts?.key ? { lastSystemKey: { $ne: opts.key } } : {}),    // decision 12
  },
  {
    $set: {
      pendingSystem: { prompt, agent: opts?.agent, source: opts?.source,
                       key: opts?.key, token, at: now },
      ...(opts?.key ? { lastSystemKey: opts.key } : {}),
      updatedAt: now,
    },
  },
  { returnDocument: 'before' },
);
```

No `relay: 0`. No `$unset: { pendingRelay: 1 }`. That omission *is* decision 7.

A `null` pre-image means one of several things and the caller deserves to know
which, so the failure path re-reads the session once and diagnoses. One extra
read, only when something was refused.

5. On success, call `consumeSystemIntent(sessionId)`. If it returns `true` the
   result is `{ ok: true, ran: true }`; otherwise `{ ok: true, ran: false,
   parked: true }` and the intent stands.

### 4.4 The `$lt` trap, stated once

**Every session document that exists today has no `budgetSpent.systemTurns`
field.** Mongo's comparison operators are type-bracketed: `$lt` does not match a
missing field. A naive `{ 'budgetSpent.systemTurns': { $lt: n } }` therefore
matches *zero existing sessions* and silently refuses every system turn on every
session created before this ships. `methods.ts:478` documents that the team
already knows this shape; seeding new inserts does not help documents already in
the database.

So the clause is always existence-tolerant, and always returned as an **array of
clauses for an enclosing `$and`**, never as a bare `$or`:

```ts
function systemBudgetClause(limit?: number): object[] {
  if (limit === undefined) return [];
  return [{ $or: [
    { 'budgetSpent.systemTurns': { $exists: false } },
    { 'budgetSpent.systemTurns': { $lt: limit } },
  ] }];
}
```

Two bare `$or`s in one selector silently destroy each other. `noLiveLease(now)`
returns an object whose only key is `$or` and is applied by spread
(`watcher.ts`), so any query combining it with a budget bound must nest one side
under `$and` — which is why this helper returns clauses rather than a selector.

### 4.5 Consume — one function, three callers

```ts
async function consumeSystemIntent(sessionId: string): Promise<boolean>;
```

It **materializes the row and dispatches a turn. It does not clear the marker
and does not spend the budget** — those belong to the turn's first commit
(decision 14, §4.7).

1. Re-read. Bail `false` unless there is a `pendingSystem`, the phase is not in
   `DECIDED_PHASES`, no other server holds a live lease, and
   `!isRunning(sessionId)`.
2. `const rowId = systemRowId(sessionId, intent.key ?? intent.token)`. If a
   message with that `_id` already exists, the row is materialized already —
   skip to 4. This is the retry path, and it is why the `_id` is derived.
3. **One atomic write**, whose selector re-asserts every guard step 1 read so it
   cannot land on a state the read disqualified:

```ts
const before = await AgentSessions.rawCollection().findOneAndUpdate(
  {
    _id: sessionId,
    'pendingSystem.token': intent.token,
    phase: { $nin: DECIDED_PHASES },
    $and: [noLiveLease(new Date())],
  },
  { $inc: { nextSeq: 1 } satisfies SessionInc, $set: { updatedAt: new Date() } },
  { returnDocument: 'before' },
);
if (!before) return false;            // another server won; not an error
```

   then insert the row at `before.nextSeq`:

```ts
await AgentMessages.insertAsync({
  _id: rowId,
  sessionId, seq: before.nextSeq, role: 'system',
  content: intent.prompt,
  from: systemFrom(intent.source),          // unconditional — decision 3
  createdAt: new Date(),
});
```

   A duplicate-key error here means another consumer won between step 2 and now;
   catch it and continue to 4.

4. Dispatch, **naming the target explicitly**. `deferResolvedTurn` resolves from
   `session.agent` and cannot honour `opts.agent`, so this mirrors the addressed
   path at `methods.ts:145-155` instead:

```ts
const target = getAgent(intent.agent ?? session.agent);
if (!target) return false;
const primary = getAgent(session.agent);
deferTurn(sessionId, target, session.userId, intent.agent && target !== primary
  ? { agentName: intent.agent, budget: resolveBudget(primary!.budget), ...memoryOpt(primary!) }
  : undefined);
return true;
```

It cannot use `allocateSeq`: that helper is lease-guarded
(`'lease.serverId': SERVER_ID`, `turn-state.ts:108`) and the whole point of an
intent is that it is consumed from *outside* a running turn. It builds its own
`findOneAndUpdate`, exactly as `sendToSession` and `writeVerdict` both do.

### 4.6 The three triggers

**Immediate** — `startSystemTurn` calls `consumeSystemIntent` right after a
successful park.

**Wind-down** — a fourth wake kind in `loop.ts`'s outer `finally`:

```ts
const intentWake = !!(wakeable && after.pendingSystem);
```

threaded through the tail guard (`:891`), the dispatch condition (`:900`), and
the token capture (`:911-912`). The deferred re-check gets its own arm **before**
the final unconditional `else`, which today assumes "not verdict, not relay"
means "tail" and would otherwise swallow an intent wake:

```ts
} else if (intentWake) {
  if (still.pendingSystem?.token !== intentToken) return;
}
```

Identity on the token, never presence — presence-only re-checking is the exact
defect `pending.wakeToken` was introduced to fix.

The intent arm calls `consumeSystemIntent`, **not** `runTurn`. The other three
arms end in `runTurn` (`loop.ts:954`/`:961`) and write nothing themselves,
because their transcript row already exists. An intent's row does not exist yet:
waking straight into `runTurn` would make a real, billed provider call against
an unchanged transcript and commit an assistant row answering nothing.

**Sweep** — watcher CASE 6, placed after CASE 2's approval-timeout loop and
before CASE 4's relink, and shaped like CASE 2 (its own awaited loop calling a
writer) rather than like CASE 3/5, which collect into `toWake` and end in a bare
`wake()` (`watcher.ts:186`) that writes nothing:

```ts
if (stopped) return;
const intents = await AgentSessions.find({
  pendingSystem: { $exists: true },
  phase: { $nin: WAKE_EXCLUDED },
  'pendingSystem.at': { $lt: new Date(now.getTime() - verdictGraceMs) },
  ...noLiveLease(now),
}).fetchAsync();
for (const session of intents) {
  if (stopped) return;
  if (isRunning(session._id)) continue;
  await consumeSystemIntent(session._id);   // eslint-disable-line no-await-in-loop
}
```

Staleness is measured on `pendingSystem.at`, **not** `updatedAt`. `updatedAt` is
a shared clock bumped by every `allocateSeq`, every verdict and every roster
mutation, so an unrelated write would keep resetting the intent's apparent age.
CASE 4 makes exactly this distinction and uses `createdAt` for the same reason.

This `find` is typed, so `SessionQuery` (`common/db.ts:72-88`) gains
`{ [k: \`pendingSystem.${string}\`]: unknown }` — the `pendingRelay.` pattern is
the template. The raw `findOneAndUpdate`s in §4.3 and §4.5 bypass the facade and
need nothing.

And the index (decision 15), beside the existing phase index in `indexes.ts`:

```ts
{
  collection: AgentSessions, name: NAMES.sessions,
  keys: { 'pendingSystem.at': 1 },
  options: { partialFilterExpression: { pendingSystem: { $exists: true } } },
}
```

### 4.7 The first commit clears it

At turn entry, beside `consumingRelay` (`loop.ts:287`):

```ts
const consumingSystem = entry.pendingSystem !== undefined
  && (await AgentMessages.findOneAsync(
    systemRowId(sessionId, entry.pendingSystem.key ?? entry.pendingSystem.token),
  )) !== undefined;
```

*(Rewritten during the build — the draft latched on `!!entry.pendingSystem` and
argued that "decision 9 refuses a second park while one stands, so the intent
visible at entry is necessarily the one that started this turn". That is a
non-sequitur, and the test that drove it end to end caught it: decision 9 makes
the standing intent **unique**, which is not evidence that this turn was
dispatched to consume it. Any turn starting while an intent stands — an approval
resume, a plain send answering a stranded marker — would clear it and bill the
counter for a prompt no model ever saw. It destroyed the scheduled turn on
exactly the parked-approval case in decision 8, and it contradicted decision 10
outright.)*

The honest latch is the intent's **row**. `consumeSystemIntent` writes it before
it dispatches, so the row's existence is proof the intent was materialized into
this transcript — which is the condition under which a commit here is answering
it. One primary-key read, and only when a marker stands.

`allocateSeq`'s `unset` parameter (`turn-state.ts:99`) widens from
`{ pendingRelay?: 1 }` to `{ pendingRelay?: 1; pendingSystem?: 1 }`, and the
turn-final commit at `loop.ts:705-717` clears the intent and spends the budget in
the same atomic write it already uses:

```ts
const commitSeq = await allocateSeq(sessionId, {
  'usage.input': usage.input,
  'usage.output': usage.output,
  'usage.cost': accruedCost(usage, config.pricing),
  ...(consumingSystem ? { 'budgetSpent.systemTurns': 1 } : {}),
}, /* set */ …, {
  ...(!relaying && consumingRelay ? { pendingRelay: 1 } : {}),
  ...(consumingSystem ? { pendingSystem: 1 } : {}),
});
```

So a turn that never runs is never billed, and its intent is still standing for
the sweep. That is the whole of decision 14.

### 4.8 Deliberately left `role: 'user'`-only

Four predicates find only `role: 'user'`:

- `loop.ts:787` — the mid-stream interjection probe. A system row landing
  mid-turn does **not** re-loop the running turn. Not an oversight: it is the
  mechanical reason the standing intent exists (decision 8).
- `participants.ts:187` — `unansweredAddressee`. A system row is not an
  unanswered question and must not change what `resolveWakeAgent` returns.
- `loop.ts:387-399` — the turn-final addressee re-resolution. *(Found by
  review.)* On a rostered session whose tail is an unanswered colleague-addressed
  **user** row, this hands the turn off even when the turn was started by an
  intent. Left as-is deliberately: the human's addressed question is older and
  still unanswered, and decision 7's logic runs in this direction too — a
  machine's prompt does not outrank a person's pending question. Test E8 pins it.
- `loop.ts:506` — the memory-hint anchor. **Consequence, stated rather than
  discovered later:** a system turn produces no memory hint, so scheduled work
  neither writes nor benefits from recall keyed on its own prompt. Left
  user-only for now — a hint derived from a machine's own text would recall
  the machine's own prior prompts, which is noise, not memory.

In `resolveWakeAgent` the intent's agent clause goes **after** both
`pendingRelay.agent` and `unansweredAddressee`. The three-way order is: standing
relay > unanswered human addressee > standing intent. Placing it earlier would
let a system turn hijack a scheduled colleague's relay or answer over a person's
open question, which is decision 7 violated from the other direction. Test E7.

### 4.9 The projection

One branch in `toProviderMessages`, immediately after the note skip
(`transcript.ts:87`) and before the rostered branch, pushing and `continue`-ing:

```ts
if (m.role === 'system') {
  const body = (m.content ?? '').trim();
  if (!body) continue;                       // empty user rows 400 on some providers
  out.push({ role: 'user', content: `[${m.from?.name ?? 'system'}] ${body}` });
  continue;
}
```

Unconditional — never gated on `prefixing`. The human `[name]: ` prefix is gated
because a 1:1 payload must stay byte-identical; the system marker is strictly
additive, and gating it would produce *unlabelled machine input* in every 1:1
session, the precise failure the projection exists to prevent.

It must never fall through to the generic build at `:130-137`. That build's
`role: m.role as ProviderMessage['role']` is an unchecked cast between
overlapping unions — it compiles happily with a literal `'system'`, and pi-ai's
`toPiAiMessage` (`piai.ts:167-207`) has no default case, so it re-labels the row
`role: 'user'` and tells the model a *person* said it: the exact outcome this
spec exists to prevent, reached silently. **A `default: assertNever` backstop is
added to `toPiAiMessage` in the same change.**

Everything else here is already inert to a system row:
`turnWindows`/`batchSafeBoundary`/`repairUnansweredToolUse` inspect only
assistant and tool rows; `findCompactionCut` and `fork.ts:60` filter on
`role !== 'note'`, so system rows compact and fork like user rows with no edit.

### 4.10 Publication and rendering

`publications.ts` projects by **exclusion** at `:68` and `:110`.
`pendingSystem.token` is a wake credential and must be added to **both** lists
the way `pendingRelay.token` was, or it ships to every subscribed browser. The
prompt text is app-authored and stays visible — a client rendering "a scheduled
review is queued" is a feature.

`client/element.ts:247` gates the speaker line on `user|assistant`; the row class
comes from `m.role` (`:214-219`) with no matching stylesheet rule, so a system
row would render unstyled and unattributed. It gains `|| m.role === 'system'`, a
`.message.system` rule, and the `::part(message system)` name.

## 5. What the app side becomes

The Coast Mountain Guides routine runner is the reference consumer. Today it
carries three mitigations in its header comment for problems it cannot fix from
outside the framework. After this:

- the claim write at `routines.js:202-209` is **narrowed, not deleted** — drop
  the `lastKey: { $ne: key }` selector clause and the `lastKey` field, but keep
  an unconditional `$set: { lastRunAt, nextRunAt: nextFiring(...) }`. It is the
  **only writer of `nextRunAt`**; deleting it stops the schedule advancing and
  every routine re-fires on every tick forever. Advance the slot *after* a
  successful park, or gap 3's crash window simply moves to the app side.
- the `session.phase !== 'idle'` skip (`:216`) is deleted — the framework parks.
- `ROUTINE_MARKER` and its single use at `:229` are deleted; both explanatory
  paragraphs in `Routines.jsx:94-103` are rewritten (parking replaces skipping,
  and there is no longer a wart to confess). `lastOutcome` now records the
  `SystemTurnResult` reason instead of a phase string.
- `agent.send(session._id, \`${MARKER} ${prompt}\`, { userId: ownerId })` becomes
  `startSystemTurn(session._id, prompt, { key, agent: routine.agent, source: 'routine' })`.
- `ownerId` stops flowing to the **send** — that is the real deletion — but must
  keep flowing to `sessionFor` as the session's owner, or routine sessions become
  unreadable by the office view (`agent.session` authorizes by `userId`). The
  manual path `runRoutine(id, { ownerId: userId, manual: true })`
  (`server/methods.js:135`) is unchanged.

What stays: `nextFiring`, the tick, the schedule documents. That is the app's
domain and this spec does not take it (§12).

## 6. Limits and failure modes, named

**A wasted seq under a consume race.** Two servers may both pass step 1 and both
win step 3's write, since nothing in that selector changes. One loses the row
insert to the derived `_id`, and one loses `claimLease`. The cost is one
allocated `nextSeq` with no row — a gap, which the transcript already tolerates
(`discardTurn` produces them). Bounded by the number of servers, and only on a
sweep collision.

**Recovery latency is up to 2× `sweepMs`.** The observer will never see a
standing intent: its selector is `phase: { $in: ACTIVE_PHASES }` and `isOrphan`
returns false for `idle`. Widening it is not safe — the projection exists
precisely so a healthy turn's `nextSeq` bumps do not fire `changed`. So an
intent stranded by a dead process waits one grace window plus one tick: ~30s at
defaults. In-process wind-down is the fast path; the sweep is the floor.

**A halted session refuses scheduled work until a human clears it.** Decision 11
turns what would have been a silent permanent block into an explicit
`session-halted` refusal on every tick. That is a signal, not a fix: the work
still does not run until somebody sends. Deliberate — `stopped` and `error` are
states a person is meant to see.

**`budget.systemTurns: 0` is not expressible.** `assertCountLimit` rejects
`value <= 0` and throws at startup, consistent with `turns` and `toolCalls`. To
forbid scheduled work, do not call the primitive.

**Idempotency is one slot deep, plus a permanent per-key row guard.**
`lastSystemKey` dedupes a *repeated* key; keys `A, B, A` move the slot, but the
`A` row's derived `_id` still refuses a second row, so the third call parks an
intent whose consume finds the row already materialized and dispatches against
it rather than duplicating it.

**A system turn cannot carry images.** `hydrateImageRefs` attaches bytes only to
tool-result rows (`attachments.ts:386`). Attachment *refs* would require widening
`transcript.ts:118`'s `role === 'user'` predicate; this spec does not, so the API
must not promise file input.

**One intent per session bounds throughput.** A session receiving scheduled work
faster than it completes turns sees `intent-standing` refusals. That is the
honest signal.

## 7. Security

**No DDP surface** (decision 16). A client that could start system turns would
bypass both the turn budget and the rate limiter, since neither sees this path.

**The wake token is a credential** and is excluded from both publications
(§4.10).

**`runAs` is untouched.** A system turn resolves tools exactly as any turn does;
it grants no identity and widens no authorization.

**Attribution cannot be forged into a person.** `systemFrom` only ever produces
an `s:` id, disjoint from `h:`, `x:` and `m:`, and a system participant is never
`kind: 'human'` — a human-kinded roster row would be picked up by
`requireSession` (`methods.ts:62-73`) and by `pubSession`'s
`$elemMatch: { kind: 'human', userId }`, granting a real account standing on the
session. Decision 2's "no roster row at all" avoids this by construction.

## 8. Things deliberately NOT added

- **A scheduler.** §12.
- **A job queue.** Decision 9. N-deep queueing has different failure modes
  (ordering, starvation, per-item retry); one slot plus a refusal is sufficient
  and honest.
- **A `Phase` member.** A session running a system turn is `streaming` like any
  other. `smoke.test.ts`'s `H-DECIDED-PHASES` passing unchanged is the assertion
  that none was added by accident.
- **A system-turn rate limit.** The DDP limiter matches method names; this path
  has none. The session budget applies.
- **Widening the interjection probe, the tail re-resolution, or the memory
  anchor.** §4.8, each with its reason.
- **System-turn-only tools.**

## 9. Resolved on review

- **Ephemeral sessions refuse a park.** `Agent.ask`'s sessions are deleted at the
  end of the call, so an intent parked on one is unreachable. `ephemeral: { $ne: true }`
  sits in §4.3's selector.
- **Subagent children:** left legal. A child is a real session with a real
  transcript; nothing in the consume path cares about `parent`. Test F8 pins it.
- **A fork inherits neither `pendingSystem` nor `lastSystemKey`.** `fork.ts:169`
  already declines to copy a live relay and the same argument holds; a fork may
  therefore re-run a slot the source already ran, which is correct — it is a
  different conversation.

## 10. Test matrix

One new server suite, `tests/system-turn.test.ts`, imported from `tests/server.ts`
after `./participants.test`. Helpers are copied, not shared — the convention
(`waitFor`, the retrying `clean`, `seedRostered`, `finished`, `seedSession`).

**A — attribution.** A1 the row carries `from` with an `s:` id, never the owner,
and no `role: 'user'` row appears. A2 the rosterless 1:1 case stamps `from`
(decision 3). A3 the roster is unchanged and the system id never resolves as an
addressee. A4 **every projected `req.messages[i].role` is a legal provider role**
— the test that catches the `transcript.ts:131` cast. A5 the omniscient
compaction view projects it legally. A6 a colleague's `self` view keeps it
unprefixed. A7 `needsAttribution` unchanged. A8 `unansweredAddressee` unchanged.
A9 `opts.agent` actually answers, and its reply's `from` names it.

**B — the stall.** B1 idle session runs immediately. B2 streaming session parks;
`providerCalls` does not increase. B3 consumed exactly once at next idle.
B4 an `awaiting` session keeps its park intact; both the approved tool and the
system turn run, in seq order. B5/B6 `stopped`/`error` refuse the park with
`session-halted`, **and a later firing after the phase clears is not permanently
refused**. B7 a second intent is refused; exactly one turn runs. B8 a human send
does not cancel it; human first, system after. B9 the watcher sweeps a stranded
intent. B10 the watcher leaves an `awaiting` session's intent alone. B11 two
watchers consume once. B12 wind-down fires it with no watcher. B13 an intent
older than `intentTtlMs` is replaced by a new park.

**C — idempotency and the strand.** C1 same key twice runs once. C2 concurrent
same-key resolves to one, neither racer rejects. C3 different keys both run.
C4 no key still works. C5 a crash between park and consume leaves exactly what
B9's selector matches. C6 replay cannot double-fire. C7 key scope is per-session.
**C8 `deferTurn` dropping the turn (stub `runTurn`'s `running` set) leaves the
intent standing and the budget unspent, and the sweep recovers it** — the
blocker's regression test.

**D — budget.** D1 a completed system turn increments `systemTurns`, not `turns`.
D2 a human send still increments only `turns`. D3 the refusal costs nothing.
D4 the two budgets are independent in both directions. D5 N concurrent under
`systemTurns: 1` yields exactly one. **D6 a legacy session with no `systemTurns`
field is not refused** — §4.4's trap as a test. D7 the counter lands under the
exact dotted path. D8 a fork zeroes it. **D9 `defineAgent({ budget: { systemTurns: 0 } })`
throws, and `resolveBudget({ systemTurns: 3 }).systemTurns === 3`** — the
`registry.ts` triple-edit trap of §11.

**E — relay.** E1 `relay` is not reset (seed 3, assert 3). E2 a standing
`pendingRelay` survives with the **same token**. E3 the relay is still honored
afterwards. E4 a system-started turn may itself relay, counting 3→4. E5 the cap
trips from the pre-system count, note-only. E6 a human send after a
system-started chain still resets to 0. E7 `resolveWakeAgent`'s three-way order:
relay > unanswered addressee > intent. E8 a rostered session with an unanswered
colleague-addressed user tail hands off, even under a system-started turn (§4.8).

**F — fork and recovery.** F1 a fork copies neither `pendingSystem` nor
`lastSystemKey`. F3 system rows copy verbatim, original seqs, fresh `_id`s.
F4 a system row is a legal fork cut point. F5 orphan-claim recovery of a
system-started turn resumes as the right agent. F7 a system turn against a
transcript ending in an unanswered `tool_use` repairs first. F8 a subagent child
session accepts one.

**G — plumbing.** G1 the suite is imported in `tests/server.ts`. G2 `perf.test.ts`
asserts the `{ 'pendingSystem.at': 1 }` index exists. G3 `smoke.test.ts`
H-DECIDED-PHASES unchanged. G4 `startSystemTurn` and `Agent#systemTurn` are
exported from the package barrel.

## 11. The compiler will not help you

Stated plainly because it determined the shape of §10: **there is no
exhaustiveness guard anywhere in this package.** `grep -rn 'satisfies never|_exhaustive'`
over `server/`, `common/` and `client/` returns zero hits. Adding `'system'` to
`AgentMessage['role']` breaks nothing at compile time; every switch site must be
found by hand.

Two couplings *are* compiler-enforced: `SessionCounterPath` gates the `$inc`, and
`SessionQuery`/`SessionSet`/`SessionUnset` gate dotted paths through the typed
facade — but **not** through `rawCollection()`, which §4.3 and §4.5 both use.

Three are **not**, and each is a live trap:

- `resolveBudget`'s return is an explicit literal with no spread
  (`registry.ts:220-226`). A new budget key needs **three** coordinated edits —
  the `AgentConfig` type, `assertCountLimit(budget.systemTurns, 'systemTurns')`
  beside `:213`, and the returned literal — and nothing ties them together.
  Forget the third and the cap validates at startup and is `undefined` at every
  consumer. D9 exists for exactly this.
- `ResolvedBudget` and the hand-copied inline `RunConfig['budget']`
  (`loop.ts:86`) already differ from each other; both need the new key.
- `BUDGET_REASONS` looks like it gates `AgentMessage['budget']` and does not:
  `'relay'` is already in that union with no `BUDGET_REASONS` entry, written
  directly at `loop.ts:758`. Nothing in this spec depends on the gate — decision
  6 writes no budget note — but do not trust it.

Plus the `...(roster?.length ? … )` stamp guard, a hand-repeated convention at
~18 call sites, which decision 3 deliberately departs from.

## 12. Why the scheduler stays in the app

A framework cron would have to own schedule storage, timezone and DST policy,
catch-up-after-downtime policy, and the which-instance question. All four are
business facts. CMG's routines are *editable from the office view*, which is why
they live in the app's database; "06:30" means half past six in Whistler because
the mountains are outside, not because of UTC.

Multi-instance needs no coordination either way: every instance ticks, every
instance derives the same `key`, and the framework's park makes exactly one win —
the same argument the watcher's header already makes for its own cases.

An optional scheduler module layered strictly *on top of* this primitive remains
possible later. It must never be fused with it, because time is only one producer
of intents and the state-triggered producers (fire when idle, fire when a binding
appears) are the ones a cron framing would make second-class.

## 13. Next steps

Historical implementation sequence:

1. **Types + budget** — `role: 'system'`, `SessionCounterPath`,
   `budgetSpent.systemTurns` (optional), `pendingSystem`, `lastSystemKey`,
   `SessionQuery`'s `pendingSystem.` pattern; the three budget shapes
   (`AgentConfig`, `ResolvedBudget`, `RunConfig`) **and both `registry.ts`
   runtime edits** — `assertCountLimit` beside `:213` and the returned literal at
   `:220-226`; the `systemBudgetClause` helper; tests D1-D2, D6-D7, D9.
2. **Participants + projection** — `systemParticipantId`/`systemFrom`, the
   `toProviderMessages` branch, the `toPiAiMessage` `assertNever` backstop;
   tests A1-A8.
3. **Park + consume + first-commit clear** — `startSystemTurn`,
   `consumeSystemIntent`, `systemRowId`, `Agent#systemTurn`, the diagnosing
   failure path, `allocateSeq`'s widened `unset`, the `consumingSystem` latch and
   the commit-side `$inc`; the `server/index.ts` exports; tests B1, B5-B7, B13,
   C1-C4, C7-C8, D3-D5, G4.
4. **Wake + sweep** — the fourth wake kind in `loop.ts`, watcher CASE 6, the
   partial index, the publication exclusions; tests B2-B4, B8-B12, C5-C6,
   E1-E8, F5, G2.
5. **Fork + recovery** — the `fork.ts` field exclusions; tests F1-F8.
6. **Docs** — README gains a "System turns" section with
   `Full design: docs/superpowers/specs/2026-08-25-system-turns.md`; participants
   spec decision 7 gains an in-place amendment pointer here.
7. **Consumer** — CMG's `routines.js` narrows its claim write, sheds `lastKey`,
   its phase skip and its marker; `Routines.jsx`'s two paragraphs are rewritten;
   the three-wart header comment is deleted.
