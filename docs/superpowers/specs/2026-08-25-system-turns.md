# System turns: work that starts without a person

**Status:** design, verified against the codebase (nine-area recon; three
draft decisions were rewritten by findings — see decisions 3, 6 and 9)
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

It is not a scheduler. Cron semantics — "06:30 local, weekly on Tuesday,
catch up after downtime" — are business facts that belong to the app that has
them. This spec ships the thing a scheduler *calls*, and nothing that decides
when to call it. See §12.

## 2. Decisions already made

| # | Decision | Why |
|---|---|---|
| 1 | **A fourth message role, `'system'`** | The role is the provenance record. Reusing `'user'` with a text marker is what the app-level workaround already does, and it is exactly the lie this spec exists to remove. `AgentMessage.role` (`common/types.ts:346`) is additive — no exhaustiveness guard exists anywhere in the package, so every switch site is found by hand, not by the compiler (§11). |
| 2 | **A `s:` participant id namespace, and no roster row** | Attribution needs an id; the roster does not need a member. `participantsBlock` renders `p.kind` verbatim into every prompt (`participants.ts:151`), `needsAttribution` counts every non-human row as a model (`:132`) — a `kind: 'system'` roster row would change the system prompt of every rostered session and silently flip `[name]: ` prefixing on 1:1 sessions. `subagent.ts:430` is the precedent: a `from.participant` outside the roster, resolved by `nameOf`'s fallback (`transcript.ts:80-82`). |
| 3 | **`from` is stamped on a system row unconditionally — roster or not** | *(Rewritten from the draft, which roster-gated it to match `sendToSession:522`.)* The byte-identical-1:1 invariant protects rows that existed before the roster did. A system row is net-new: a session with no system turns still projects byte-identically, so there is nothing to preserve. Roster-gating would drop attribution in precisely the 1:1 case scheduled work actually uses, losing the point of decision 1. Note this resolves a live contradiction: `types.ts:436` says `from` is "stamped on every new row regardless of roster"; `methods.ts:522` gates it. Both stay as they are; the system row follows the doc comment. |
| 4 | **The wire projection is a marked `user` message, decided explicitly** | No provider has a mid-conversation system message: `ProviderMessage.role` is `'user'\|'assistant'\|'tool'` (`providers/types.ts:8`), and the single system channel is `ProviderRequest.system`, which `loop.ts:536` rebuilds every iteration — routing a one-shot instruction there would make it standing and strip its position in history. The projection is the idiom the codebase has already chosen twice: a compaction note becomes `[Earlier conversation, compacted]` (`compaction.ts:62`), a colleague's row becomes `[name]: …` (`transcript.ts:98`). |
| 5 | **Its own budget dimension, `budgetSpent.systemTurns`** | Scheduled work and human work are different purses and an operator tunes them separately. Declared **optional** — `turns`/`toolCalls` are required and seeded at five insert sites (`agent.ts:124`, `methods.ts:590`, `fork.ts:154`, `subagent.ts:363`, `channels/ingress.ts:187`); a required sixth breaks all five plus ~30 fixtures and leaves every persisted session without the field. |
| 6 | **A budget refusal is a refusal, not a stop** | *(Rewritten from the draft, which reached for `commitBudgetNote`.)* `commitBudgetNote` sets `phase: 'stopped'` (`turn-state.ts:151`), which wedges the session until a human sends. Wedging a conversation because a *machine's* purse ran out is backwards. This follows `turns` instead (`methods.ts:504-511`): the bound is folded into the claim selector, a miss writes nothing at all — no seq, no row, no counter — and the caller gets a structured reason. |
| 7 | **A system turn does not reset `relay`, and does not clear `pendingRelay`** | This amends **participants decision 7**, whose rule is "a human message outranks a pending relay, at any seq". The rule is about *humans*: a person interjecting is a new instruction that supersedes a colleague hand-off. A machine's scheduled prompt is not an interjection and has no standing to cancel work the team is mid-way through. Mechanically this is a pure omission — the two clauses at `methods.ts:498` and `:500` are simply not copied. |
| 8 | **Busy sessions park a durable standing intent; they do not drop the request** | The failure this closes is the sharpest one in practice: a session parked on an approval is not `idle`, so under the app-level workaround the *next* firing is skipped and its schedule slot advanced — dropped, not deferred. `pendingSystem` is a top-level optional on `AgentSession`, sibling to `pendingRelay` (`types.ts:319`), and picked up by `SessionSet`/`SessionUnset` for free (`db.ts:102,112`) as long as no dotted sub-path is ever named. |
| 9 | **One standing intent per session. A second is refused, not queued and not overwritten** | *(Rewritten from the draft, which overwrote.)* Overwriting silently destroys scheduled work; queueing N is a job queue, which is a different feature (§13). One slot matches `pendingRelay`'s shape exactly, and a refused caller is a scheduler that will simply come back on its next tick. |
| 10 | **A human send does NOT cancel a standing intent** | The deliberate asymmetry with decision 7 and with `methods.ts:500`. A relay is cancelled by a human because the human is answering the same conversation the relay was about. A standing system intent is unrelated work that happens to share a session; dropping it because somebody typed would make scheduled work vanish at random. The human's turn runs first because it is live; the intent fires at the next idle. |
| 11 | **Idempotency is a `$ne` on the claim selector, backed by a derived `_id`** | Not a unique index: `ensureIndexes` is non-fatal by design (`indexes.ts:236-244`), so an index-backed guarantee silently disappears when the build fails — the trap that already bit memory. `lastSystemKey` in the selector is single-winner by construction and needs no index; the system row's `_id`, derived from the intent token, is the permanent backstop, which is the `orphan-child` trick (the primary key always exists). |
| 12 | **One consume path, three triggers** | The intent is written by one function and consumed by exactly one other. Immediate consumption after parking, the loop's wind-down wake, and the watcher's sweep all call the same `consumeSystemIntent`. Three copies of "allocate seq, spend budget, unset marker, write the row, start the turn" is three places to drift. |
| 13 | **The watcher gets a real index, unlike the relay case** | CASE 5 (`pendingRelay`) runs unindexed every 15s and that debt is already recorded. A new case must not inherit it. `partialFilterExpression` is required rather than `sparse` — Mongo drops a document from a *compound* sparse index only when it is missing every indexed field, and it "cannot be added later without dropping the index by name" (`indexes.ts` header), so the partial form is chosen now or the debt is permanent. |
| 14 | **Server-only, no DDP surface** | A system turn has no caller to authorize. Exposing it over DDP would hand every client a way to start turns that bypass the turn budget and the rate limiter. It is app code calling app code, like `Agent.ask`. |

## 3. What's in scope

- `startSystemTurn(sessionId, prompt, opts?)` and `Agent#systemTurn(...)`
- `role: 'system'` end to end — stored, projected, published, rendered
- `budgetSpent.systemTurns` and `budget.systemTurns`
- `pendingSystem` — the durable standing intent, its consume path, its wake
- watcher CASE 6 and its index
- the test matrix in §10

Out of scope: schedules, cron, timezones, catch-up policy, a job queue,
system-turn *tools* (a system turn uses the agent's ordinary tools).

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
      | 'budget-exhausted'   // budget.systemTurns reached (decision 6)
      | 'no-session'
      | 'no-agent' };
```

`Agent#systemTurn(sessionId, prompt, opts)` is the instance sugar, server-only
beside `ask`.

### 4.2 New fields

```ts
// On AgentSession — all optional, additive, migration-free
pendingSystem?: {
  prompt: string;
  agent?: string;          // target teammate; absent = session.agent
  source?: string;         // attribution source (decision 2)
  token: string;           // wake identity, never presence (see 4.5)
  at: Date;                // the intent's OWN age — not `updatedAt` (see 4.6)
};
lastSystemKey?: string;    // idempotency slot (decision 11)
budgetSpent: { turns: number; toolCalls: number; systemTurns?: number };

// On AgentMessage
role: 'user' | 'assistant' | 'tool' | 'note' | 'system';

// On AgentConfig['budget'] and ResolvedBudget and RunConfig['budget']
systemTurns?: number;
```

`SessionCounterPath` (`types.ts:51-57`) gains `'budgetSpent.systemTurns'`, or
`{ 'budgetSpent.systemTurns': 1 } satisfies SessionInc` does not compile. No
`common/db.ts` edit is needed **provided no dotted sub-path of `pendingSystem`
is ever named** — the whole object is set and unset, exactly as `pendingRelay`
is, because `SessionUnset` has no `pendingRelay.`-style pattern to copy.

### 4.3 Park, then consume

`startSystemTurn` is two steps, and the split is what makes it crash-safe.

**Step 1 — park (the claim).** One conditional write, single-winner:

```ts
const token = Random.id();
const claimed = await AgentSessions.rawCollection().findOneAndUpdate(
  {
    _id: sessionId,
    pendingSystem: { $exists: false },              // decision 9
    ...(opts?.key ? { lastSystemKey: { $ne: opts.key } } : {}),   // decision 11
    ...systemBudgetClause(config.budget?.systemTurns),            // see 4.4
  },
  {
    $set: {
      pendingSystem: { prompt, agent: opts?.agent, source: opts?.source, token, at: new Date() },
      ...(opts?.key ? { lastSystemKey: opts.key } : {}),
      updatedAt: new Date(),
    },
  },
  { returnDocument: 'before' },
);
```

No `relay: 0`. No `$unset: { pendingRelay: 1 }`. That omission *is* decision 7.

A `null` pre-image means one of four things, and the caller deserves to know
which, so the failure path re-reads the session once and diagnoses —
`duplicate-key`, `intent-standing`, `budget-exhausted`, or `no-session`. One
extra read, only when something was refused.

**Step 2 — consume, if the session is free.** `consumeSystemIntent(sessionId)`
is called immediately after a successful park. If the session is busy it is a
no-op and the intent stands.

### 4.4 The `$lt` trap, stated once

**Every session document that exists today has no `budgetSpent.systemTurns`
field.** Mongo's comparison operators are type-bracketed: `$lt` does not match a
missing field. A naive `{ 'budgetSpent.systemTurns': { $lt: n } }` therefore
matches *zero existing sessions* and silently refuses every system turn on every
session created before this ships. `methods.ts:478` documents that the team
already knows this shape; there is no migration for a new counter, and seeding
new inserts does not help documents already in the database.

So the clause is always written existence-tolerant:

```ts
function systemBudgetClause(limit?: number) {
  if (limit === undefined) return {};
  return { $and: [{ $or: [
    { 'budgetSpent.systemTurns': { $exists: false } },
    { 'budgetSpent.systemTurns': { $lt: limit } },
  ] }] };
}
```

Nested under `$and`, never as a bare `$or`. `noLiveLease(now)` returns an object
whose only key is `$or` and is applied by spread (`watcher.ts`); two bare `$or`s
in one selector silently destroy each other, producing a sweep that either wakes
leased sessions or never matches anything.

### 4.5 Consume — one function, three callers

```ts
async function consumeSystemIntent(sessionId: string): Promise<boolean>;
```

1. Re-read the session. Bail `false` on no session, no `pendingSystem`, a phase
   in `DECIDED_PHASES`, a live lease held elsewhere, or `isRunning(sessionId)`.
2. **One atomic write** — the claim-and-allocate, filtered on the token so two
   racing consumers resolve to one winner:

```ts
const before = await AgentSessions.rawCollection().findOneAndUpdate(
  { _id: sessionId, 'pendingSystem.token': token },
  {
    $inc: { nextSeq: 1, 'budgetSpent.systemTurns': 1 } satisfies SessionInc,
    $set: { updatedAt: new Date() },
    $unset: { pendingSystem: 1 },
  },
  { returnDocument: 'before' },
);
if (!before) return false;   // another server won; not an error
```

   This one selector names a dotted path, so `SessionQuery` gains
   `{ [k: \`pendingSystem.${string}\`]: unknown }` in `common/db.ts` — the
   `pendingRelay.` pattern already there is the template.
3. Insert the row at `before.nextSeq`, `_id` derived from the token
   (decision 11's backstop — a replayed consume cannot write a second row):

```ts
await AgentMessages.insertAsync({
  _id: systemRowId(sessionId, before.pendingSystem.token),
  sessionId, seq: before.nextSeq, role: 'system',
  content: before.pendingSystem.prompt,
  from: systemFrom(before.pendingSystem.source),   // unconditional — decision 3
  createdAt: new Date(),
});
```

4. `deferResolvedTurn(after)`, resolving the target agent from
   `pendingSystem.agent ?? session.agent`.

It cannot use `allocateSeq`: that helper is lease-guarded
(`'lease.serverId': SERVER_ID`, `turn-state.ts:108`) and the whole point of an
intent is that it is consumed from *outside* a running turn. It builds its own
`findOneAndUpdate`, exactly as `sendToSession` and `writeVerdict` both do.

### 4.6 The three triggers

**Immediate** — `startSystemTurn` calls `consumeSystemIntent` right after a
successful park. Idle session: the turn starts with no waiting.

**Wind-down** — a fourth wake kind in `loop.ts`'s outer `finally`, beside the
existing three:

```ts
const intentWake = !!(wakeable && after.pendingSystem);
```

threaded through the tail guard (`:891`), the dispatch condition (`:900`), and
the token capture (`:911-912`). The deferred re-check gets its own arm in the
if/else chain **before** the final unconditional `else`, which today assumes
"not verdict, not relay" means "tail" and would otherwise swallow an intent
wake:

```ts
} else if (intentWake) {
  if (still.pendingSystem?.token !== intentToken) return;
}
```

Identity on the token, never presence. Presence-only re-checking is the exact
defect `pending.wakeToken` was introduced to fix.

The intent branch calls `consumeSystemIntent`, **not** `runTurn`. This is the
sharpest trap the recon surfaced: the other three wakes end in a bare `wake()`
that writes nothing, because their transcript row already exists. An intent's
row does not exist yet — waking straight into `runTurn` would make a real,
billed provider call against an unchanged transcript and commit an assistant row
answering nothing.

**Sweep** — watcher CASE 6, placed after CASE 2's approval-timeout loop and
before CASE 4's relink, and shaped like CASE 2 (its own awaited loop calling a
writer) rather than like CASE 3/5 (which collect into `toWake`), for the same
reason:

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

And the index (decision 13), beside the existing phase index in `indexes.ts`:

```ts
{
  collection: AgentSessions, name: NAMES.sessions,
  keys: { pendingSystem: 1 },
  options: { partialFilterExpression: { pendingSystem: { $exists: true } } },
}
```

### 4.7 The projection

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
additive (a session with no system rows projects identically either way), and
gating it would produce *unlabelled machine input* in every 1:1 session, which is
the precise failure the projection exists to prevent.

It must never fall through to the generic build at `:130-137`. That build's
`role: m.role as ProviderMessage['role']` is an unchecked cast between
overlapping unions — it compiles happily with a literal `'system'`, and pi-ai's
`toPiAiMessage` (`piai.ts:167-207`) has no default case, so it re-labels the row
`role: 'user'` and tells the model a *person* said it. That is the exact outcome
this whole spec exists to prevent, reached silently, with no throw and no
warning. **A `default: assertNever` backstop is added to `toPiAiMessage` in the
same change**, so the next role to arrive fails loudly instead of impersonating
someone.

Everything else in this area is already inert to a system row:
`turnWindows`/`batchSafeBoundary`/`repairUnansweredToolUse` inspect only
assistant and tool rows; `findCompactionCut` and `fork.ts:60` filter on
`role !== 'note'`, so system rows compact and fork like user rows with no edit.

### 4.8 Deliberately left `role: 'user'`-only

Three predicates find only `role: 'user'` and stay that way:

- `loop.ts:787` — the mid-stream interjection probe. A system row landing
  mid-turn does **not** re-loop the running turn. This is not an oversight; it
  is the mechanical reason the standing intent exists (decision 8).
- `participants.ts:187` — `unansweredAddressee`. A system row is not an
  unanswered question, so it must not change what `resolveWakeAgent` returns.
- `loop.ts:506` — the memory-hint anchor.

And in `resolveWakeAgent`, the intent's agent clause goes **after**
`if (session.pendingRelay?.agent) return session.pendingRelay.agent;`. Placing
it before would let a system turn hijack a scheduled colleague's relay, which is
decision 7 violated from the other direction.

### 4.9 Publication

`publications.ts` projects by **exclusion** at `:68` and `:110`.
`pendingSystem.token` is a wake credential and must be added to **both** lists
the way `pendingRelay.token` was, or it ships to every subscribed browser. The
prompt text is app-authored and stays visible — a client rendering "a scheduled
review is queued" is a feature.

### 4.10 Rendering

`client/element.ts:247` gates the speaker line on `user|assistant`; the row class
comes from `m.role` (`:214-219`) with no matching stylesheet rule, so a system
row would render unstyled and unattributed. It gains `|| m.role === 'system'`, a
`.message.system` rule, and the `::part(message system)` name — consistent with
how note kinds already expose parts.

## 5. What the app side becomes

The Coast Mountain Guides routine runner is the reference consumer. Today it
carries three mitigations in its header comment for problems it cannot fix from
outside the framework. After this:

- the `Routines.updateAsync` claim write (`routines.js:202-209`) is deleted —
  the framework claims
- `lastKey` is deleted — `opts.key` replaces it
- the `session.phase !== 'idle'` skip (`:216`) is deleted — the framework parks
- `ROUTINE_MARKER` and its UI special-case are deleted — `role: 'system'` is real
- `agent.send(session._id, \`${MARKER} ${prompt}\`, { userId: ownerId })` becomes
  `startSystemTurn(session._id, prompt, { key, agent: routine.agent, source: 'routine' })`
- `startRoutines({ ownerId })` loses `ownerId` entirely — there is no identity to
  borrow

What stays: `nextFiring`, the tick, the schedule documents. That is the app's
domain and this spec does not take it (§12).

## 6. Limits and failure modes, named

**The consume→insert window.** `consumeSystemIntent` allocates the seq, spends
the budget and unsets the marker in one write, then inserts the row. A crash
*between* those leaves a spent seq and no row, and nothing retries. This is the
identical window `allocateSeq` + commit already has for relays and verdicts —
the spec deliberately matches the package's existing guarantee rather than
inventing a stronger one for one path. The window that actually mattered — park
to consume, which spans the entire time a session is busy, possibly hours — *is*
closed, by the watcher.

**Recovery latency is up to 2× `sweepMs`.** The observer will never see a
standing intent: its selector is `phase: { $in: ACTIVE_PHASES }` and `isOrphan`
returns false for `idle`. Widening it is not a safe fix — the projection exists
precisely so a healthy turn's `nextSeq` bumps do not fire `changed`. So an
intent stranded by a dead process waits one grace window plus one tick: ~30s at
defaults. In-process wind-down is the fast path; the sweep is the floor.

**`budget.systemTurns: 0` is not expressible.** `assertCountLimit` rejects
`value <= 0` and throws at startup. Consistent with `turns` and `toolCalls`; to
forbid scheduled work, do not call the primitive.

**Idempotency is one slot deep.** `lastSystemKey` dedupes a *repeated* key, not
an arbitrary key history: keys `A, B, A` on one session run three turns. For a
scheduler firing one slot at a time per session — the case this exists for — that
is exactly right, and it is what the app-level workaround already relied on. The
derived `_id` backstop makes the pathological interleaving harmless rather than
double-writing.

**A system turn cannot carry images.** `hydrateImageRefs` attaches bytes only to
tool-result rows (`attachments.ts:386`), and `ProviderMessage.images` is consumed
only by pi-ai's toolResult branch. Attachment *refs* would require widening
`transcript.ts:118`'s `role === 'user'` predicate; this spec does not, so the API
must not promise file input.

**One intent per session bounds throughput.** A session receiving scheduled work
faster than it completes turns will see refusals. That is the honest signal, and
`{ ok: false, reason: 'intent-standing' }` says so.

## 7. Security

**No DDP surface** (decision 14). A client that could start system turns would
bypass both the turn budget and the rate limiter, since neither sees this path.

**The wake token is a credential** and is excluded from both publications
(§4.9).

**`runAs` is untouched.** A system turn resolves tools exactly as any turn does;
it grants no identity and widens no authorization. A tool listed with `runAs`
behaves identically whether a person or the clock started the turn.

**Attribution cannot be forged into a person.** `systemFrom` only ever produces
an `s:` id. The `s:` namespace is disjoint from `h:`, `x:` and `m:`, and a system
participant is never `kind: 'human'` — a human-kinded roster row would be picked
up by `requireSession` (`methods.ts:62-73`) and by `pubSession`'s
`$elemMatch: { kind: 'human', userId }`, granting a real account standing on the
session. Decision 2's "no roster row at all" avoids this by construction.

## 8. Things deliberately NOT added

- **A scheduler.** §12.
- **A job queue.** Decision 9. N-deep queueing is a different feature with
  different failure modes (ordering, starvation, per-item retry); one slot plus a
  refusal is sufficient for the scheduler case and honest about it.
- **A `Phase` member.** A session running a system turn is `streaming` like any
  other. `smoke.test.ts`'s `H-DECIDED-PHASES` passing unchanged is the assertion
  that none was added by accident.
- **A system-turn rate limit.** The DDP rate limiter matches method names and
  this path has none. The session budget applies.
- **Widening the interjection probe.** §4.8.
- **System-turn-only tools.** A system turn uses the agent's configured tools.

## 9. Open questions

- **Should a system turn be legal against a subagent child session** (`parent`
  set)? Argument for refusing: a child's lifecycle belongs to its parent's
  dispatch. Argument for allowing: a long-lived child is still a session. Test
  F8 pins whichever is chosen; the draft leans refuse.
- **Should `Agent.ask`'s ephemeral sessions accept one?** They are deleted at the
  end of the call, so an intent parked on one is unreachable. Leaning refuse.
- **Does a fork inherit a spent `lastSystemKey`?** `fork.ts:169` already declines
  to copy a live relay; the same argument says decline the key, which means a
  fork may re-run a slot the source already ran. Test F2.

## 10. Test matrix

One new server suite, `tests/system-turn.test.ts`, imported from `tests/server.ts`
after `./participants.test`. Helpers are copied, not shared — that is the
convention (`waitFor`, the retrying `clean`, `seedRostered`, `finished`,
`seedSession`).

**A — attribution.** A1 system row carries `from` with an `s:` id, never the
owner, and no `role: 'user'` row appears. A2 the rosterless 1:1 case stamps `from`
(decision 3). A3 the roster is unchanged and the system id never resolves as an
addressee. A4 **every projected `req.messages[i].role` is a legal provider role**
— the test that catches the `transcript.ts:131` cast. A5 the omniscient
compaction view projects it legally. A6 a colleague's `self` view keeps it and
does not prefix it as a human. A7 `needsAttribution` is unchanged, so no `[name]:`
appears on human rows. A8 `unansweredAddressee`/`resolveWakeAgent` answer
identically before and after.

**B — the stall.** B1 idle session runs immediately. B2 streaming session parks,
and `providerCalls` does not increase. B3 consumed exactly once at next idle.
B4 an `awaiting` session keeps its park intact, and both the approved tool and the
system turn run, in seq order. B5/B6 `stopped`/`error` leave the phase standing.
B7 a second intent is refused and exactly one turn runs. B8 a human send does not
cancel it; human first, system after (decision 10). B9 the watcher sweeps a
stranded intent. B10 the watcher leaves an `awaiting` session's intent alone.
B11 two watchers consume once. B12 wind-down fires it with no watcher running.

**C — idempotency.** C1 same key twice runs once. C2 concurrent same-key resolves
to one, neither racer rejects. C3 different keys both run. C4 no key still works.
C5 a crash between park and consume leaves exactly what B9's selector matches.
C6 replay cannot double-fire. C7 key scope is per-session.

**D — budget.** D1 increments `systemTurns`, not `turns`. D2 a human send still
increments only `turns`. D3 the refusal costs nothing. D4 the two budgets are
independent in both directions. D5 N concurrent under `systemTurns: 1` yields
exactly one. **D6 a legacy session with no `systemTurns` field is not refused** —
the §4.4 trap, as a test. D7 the counter lands under the exact dotted path, so a
typo is caught. D8 a fork zeroes it.

**E — relay.** E1 `relay` is not reset (seed 3, assert 3). E2 a standing
`pendingRelay` survives with the **same token** — identity, not existence. E3 the
relay is still honored afterwards. E4 a system-started turn may itself relay,
counting 3→4. E5 the cap trips from the pre-system count, note-only, session still
answerable. E6 a human send after a system-started chain still resets to 0.
E7 `resolveWakeAgent` puts a standing relay ahead of the intent's agent.

**F — fork and recovery.** F1 a fork copies neither `pendingSystem` nor
`lastSystemKey` (added to `fork.test.ts:65`'s field loop). F3 system rows copy
verbatim with original seqs and fresh `_id`s. F4 a system row is a legal fork cut
point. F5 orphan-claim recovery of a system-started turn resumes as the right
agent. F7 a system turn against a transcript ending in an unanswered `tool_use`
repairs first.

**G — plumbing.** G1 the suite is imported in `tests/server.ts`. G2 `perf.test.ts`
asserts the new index exists. G3 `smoke.test.ts` H-DECIDED-PHASES unchanged.

## 11. The compiler will not help you

Stated plainly because it determined the shape of §10: **there is no
exhaustiveness guard anywhere in this package.** `grep -rn 'satisfies never|_exhaustive'`
over `server/`, `common/` and `client/` returns zero hits. Adding `'system'` to
`AgentMessage['role']` breaks nothing at compile time and every switch site must
be found by hand.

Three couplings *are* compiler-enforced and are load-bearing:
`SessionCounterPath` gates the `$inc`; `BUDGET_REASONS` gates
`AgentMessage['budget']`; `SessionSet`/`SessionUnset` gate the dotted paths.
Three are **not**: `resolveBudget`'s return is an explicit literal with no spread
(`registry.ts:220-226`), so adding a budget key in two places and forgetting the
third yields a cap that validates at startup and is `undefined` at every
consumer; `ResolvedBudget` and the hand-copied inline `RunConfig['budget']`
(`loop.ts:86`) already differ from each other; and the `...(roster?.length ? …)`
stamp guard is a hand-repeated convention at ~18 call sites.

## 12. Why the scheduler stays in the app

A framework cron would have to own schedule storage, timezone and DST policy,
catch-up-after-downtime policy, and the which-instance question. All four are
business facts. CMG's routines are *editable from the office view*, which is why
they live in the app's database; "06:30" means half past six in Whistler because
the mountains are outside, not because of UTC.

Multi-instance needs no coordination either way: every instance ticks, every
instance derives the same `key`, and the framework's claim makes exactly one win
— which is the same argument the watcher's header already makes for its own
cases.

An optional scheduler module layered strictly *on top of* this primitive remains
possible later. It must never be fused with it, because time is only one producer
of intents and the state-triggered producers (fire when idle, fire when a binding
appears) are the ones the cron framing would make second-class.

## 13. Next steps

Build order, each step green before the next:

1. **Types + budget** — `role: 'system'`, `SessionCounterPath`, `budgetSpent.systemTurns` (optional), `pendingSystem`, `lastSystemKey`, the three budget shapes (`AgentConfig`, `ResolvedBudget`, `RunConfig`), `SessionQuery`'s `pendingSystem.` pattern; the `$lt` existence-tolerant clause helper; unit tests D1-D7.
2. **Participants + projection** — `systemParticipantId`/`systemFrom`, the `toProviderMessages` branch, the `toPiAiMessage` `assertNever` backstop; tests A1-A8.
3. **Park + consume** — `startSystemTurn`, `consumeSystemIntent`, `Agent#systemTurn`, the diagnosing failure path; tests B1, C1-C7, D3-D5.
4. **Wake + sweep** — the fourth wake kind in `loop.ts`, watcher CASE 6, the partial index, the publication exclusions; tests B2-B12, E1-E7, F5, G2.
5. **Fork + recovery** — the `fork.ts` field exclusions; tests F1-F7.
6. **Docs** — README gains a "System turns" section with `Full design: docs/superpowers/specs/2026-08-25-system-turns.md`; participants spec decision 7 gains an in-place amendment pointer here.
7. **Consumer** — CMG's `routines.js` sheds its claim write, its `lastKey`, its phase skip, its marker and its `ownerId`; the three-wart header comment is deleted.
