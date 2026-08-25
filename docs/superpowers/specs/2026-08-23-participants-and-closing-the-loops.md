# Participants: n:n sessions, and closing the loops

**Status:** built (2026-08-23, all eight steps; deviations recorded in §14)
**Date:** 2026-08-23
**Depends on:** `2026-08-20-channels-multi-surface-delivery.md` (built), `2026-08-23-email-attachments-and-compose.md` (built)

This spec answers the question both prior specs deliberately left open — group
ownership — and generalizes it: a session becomes a conversation among **n
humans and n models**, with per-message attribution, mechanical turn-taking,
and membership as the authorization primitive. On top of that model, the five
deferred gaps close: the composed-email loop, chat-surface media ingest, a web
download surface, approval legibility, and multimodal reads.

An earlier draft of this spec was adversarially reviewed against the codebase
(72 findings); the mechanics below are the post-review design. Where a
finding forced a decision the first draft dodged, the decision is recorded
with its reason.

## 1. The idea

Today a session has exactly one human and one model, by construction:
`AgentSession.userId` is a scalar, every authorization in the package is an
equality match on it, a message row records no author, and the channel
ingress guard admits only the conversation's opener. The channels spec called
this "a security posture, not a feature" — single-human v1, group
conversations an open question (§15 there).

The generalization is membership. A session gains an optional roster of
**participants** — humans (account-holding or channel-identified) and models
(agent-registry names). Absent roster = the classic pair, today's behavior.
Present roster = the authoritative list of who may read, write, approve, and
speak. Messages gain a `from` (stamped by the harness from the authenticated
source, never by a model) and an optional `to` (mechanical addressing). The
transcript stays one linear history — n:n means *membership and
attribution*, not concurrency: the session lease still serializes turns. The
full transcript is a WEB affordance; a channel-surface member receives the
agent's outward replies, not a mirror of everyone's speech (§7.4).

Everything else in this spec is a consumer of that model:

- **The composed loop closes** because "the recipient's reply continues the
  composing session" is just "the recipient is a participant" plus a
  pre-bound conversation key.
- **Chat media ingest** lands because group chat surfaces stop being
  one-person conversations with silent bystanders.
- **Downloads, approval legibility, multimodal reads** ride along — they
  touch the same rows and stores and are specified here so the build is one
  coherent motion.

## 2. Decisions already made

| # | Decision | Why |
|---|---|---|
| 1 | **Participants ride on the session document, not a new collection** | Every authorization is already a `findOneAsync` on `AgentSessions`; membership must be checked in that same read. Bindings earned a separate collection with per-row worker state; participants are small bounded facts (cap 16). |
| 2 | **Absent roster = classic pair; present roster = complete** | `participants` is optional and additive (the `channel`/`parent` idiom). Materialization is its own single-winner write (§4.1); the array is either absent or authoritative. `from` is stamped on ROSTERED rows only — a rosterless session's rows stay bit-for-bit today's, and the projection's fixed defaults (assistant/tool → primary, user → owner) attribute pre-roster history exactly as an always-stamp would have, so the extra bytes bought nothing. *(Build deviation from the reviewed draft, recorded here.)* |
| 3 | **The scalar owner stays** | `session.userId` remains the anchor: the capability-URL model, `pubSessions`' fast path, claim-history's rewrite target, and the seed of the roster. Ownership is a *role* inside the roster, not a parallel system. |
| 4 | **Attribution is stamped by the harness from the authenticated source** | `from` is written by trusted code only: the DDP method (caller's `userId`), ingress (the verified sender's channel identity), the loop (the model that ran the turn), and DISPATCH (tool rows carry the running model's participant — the projection needs it to drop a colleague's working). A model can never set its own `from`; a webhook body can never claim to be the owner. |
| 5 | **Addressing is mechanical: a leading `@name` token, or an explicit `to`** | No model call ever decides routing. A leading `@<agent-name>` matching a MODEL participant is parsed by core (never a lens) and stamps `to`. The default addressee is the primary model — which is why 1:1 sessions behave as today. Humans are not schedulable: `to` naming a human is recorded but schedules nothing (a "waiting on Dana" park is an open question, §12). |
| 6 | **Turn identity is durable state, not an argument** | Which model owns a turn is recorded where every wake path can read it: `pending.agent` at park time (the `pending.mcpServer` idiom), `session.pendingRelay` at relay-schedule time, and re-resolution from the unanswered tail at wake time (§4.3). `recordVerdict`, the approval-timeout path, and the watcher all resolve the recorded addressee — never blindly `session.agent`. Without this, every recovery path resumes an addressed turn as the wrong model (reviewer blockers 3/23/63). |
| 7 | **Relays are durable and budgeted** | A model's committed reply whose leading `@name` addresses another model schedules that model's turn — a RELAY. The schedule is durable: `session.pendingRelay = { agent, seq }` is written in the same update as the turn-final commit, consumed by the addressee's turn, cancelled by any later human message, swept by a new watcher case (`phase: 'idle', pendingRelay: { $exists: true }`) — the standing-verdict wake pattern, because a bare `deferTurn` from inside a committing turn lands in exactly the non-durable-wake race the loop already documents for verdicts. `session.relay` counts hops, resets on any human message, caps at `budget.relay` (default 4); the capped relay commits and delivers but schedules nothing — a note-only budget row, NOT `commitBudgetNote` (which stops the session). *(Amended by `2026-08-25-system-turns.md` decision 7: "cancelled by any later human message" and "resets on any human message" are about HUMANS specifically. A system turn — a non-human origin — cancels neither the marker nor the hop count, because a machine's scheduled prompt is not an interjection and has no standing to supersede a hand-off in flight.)* |
| 8 | **A colleague's turn appears as its spoken outcome, not its working** | In model M's provider view: M's own rows keep their roles; another model's TURN-FINAL assistant rows (no toolCalls, non-empty text) become attributed `user` rows (`[analyst]: …`); another model's toolCall-bearing assistant rows, tool rows, thinking, and empty rows DROP. Feeding a provider a colleague's tool calls would be invalid; an empty `[analyst]: ` user row is a 400 on some providers. |
| 9 | **Attribution prefixes appear only when they disambiguate** | Human rows gain `[name]: ` only when the roster holds ≥2 humans or ≥2 models. A 1:1 session's provider payload stays byte-identical to today. The moment a roster crosses the threshold (the compose join is the flagship case) the WHOLE history re-renders prefixed — a one-time full prompt-cache invalidation, accepted and named. Rows written before the roster existed carry no `from` and project with fixed defaults: assistant → the primary model, user → the owner. |
| 10 | **A turn always RUNS as the session owner** | Tools, gates, `canUse`, and `instructions` see `session.userId` — one identity per session, whoever triggered the turn. The triggering participant appears in `from` (and the approval note), never in the run identity. Without this, a member-triggered turn would run instructions as the member but tools as the owner — a split the first draft never resolved. `deferTurn` therefore takes the owner, not the caller. |
| 11 | **Channel admission has one precedence order** | For an inbound message: (1) the sender resolves to the binding's owner → admitted (today's path, untouched); (2) else the sender matches the roster — by `userId` or by channel identity — and the binding says `admits: 'members'` → admitted AS that participant; (3) else the anonymous-opener guard (today's, verbatim); (4) else `admits: 'linked'` and the sender has a linked identity → auto-joined as a member (the group-thread acquisition path, capped at 16); (5) else settled with 200. `admits` defaults to `'opener'` — decision 9 of the first draft survives as the default posture. |
| 12 | **Channel-identified members act through a trusted ingress principal — never through a userId** | `sendToSession` and `recordVerdict` gain a server-only `via: { kind, externalUserId }` (the `extras.attachments` seam: unreachable from DDP). Authorization gains a third branch: a roster row whose `identity` equals the verified `via`. The null rule is UNCHANGED — `userId: null` still matches only the null owner; an unlinked member has no DDP capability at all, and their standing exists only while ingress vouches for the sender. This is the mechanism the whole composed loop stands on (reviewer blockers 0/14/50/61). |
| 13 | **Channels receive the conversation's outward speech, not its internal deliberation** | An assistant row whose `to` names a MODEL participant is working conversation: the web transcript shows it; the planner skips it for channel delivery. A relay-addressed turn-final commit also does NOT claim staged attachments — they stay staged for the eventual outward reply. |
| 14 | **Member bindings never receive prompts, statuses, or capability URLs** | The parked-approval prompt, status notes, and the overflow `sessionUrl` deliver only to non-member bindings (today's set). A member binding (`member: true`, §5) gets replies and overflow text. Otherwise a composed-to outsider would be mailed live Approve/Deny verdict URLs that record as the OWNER, and an anonymous session would mail its capability URL to the person it just emailed (reviewer blockers 8/16/17). |
| 15 | **Compose closes its loop by minting the key it used to withhold** | `onReply: 'continue'` derives the thread key from `sessionId + recipient` — NOT from the toolCallId alone (only unique within one provider response; the v2 deviation-3 lesson) — pre-binds the conversation to the composing session, and adds the recipient as a participant. One recipient, one binding, however many composes; crash re-runs collide and adopt. `'fresh'` (v2 decision 8) remains the default. |
| 16 | **Remote media is fetched by core under a def-owned recipe** | Lenses stay pure AND credential-free — they cannot carry tokens (they are module constants) and must not fetch. The lens emits a `RemoteAttachment` (name, type, declared size, `url` or provider `ref`); the channel DEF — factory-built, closing over its secrets — supplies `media: { hosts, request?, resolveIndirect? }`; CORE performs the size-gated fetch. The allowlist is authored by the channel, never derived from the event. |
| 17 | **Images enter model context only through `read_attachment`** | v2's decision 3 survives multimodality: an image is *offered* as a ref line and *read* by choice. The read stamps the ref on its tool row; a separate async hydration step — in the loop, after the compaction estimate, never on the summarizer path — attaches bytes at request time. The capability gate is a new optional `Provider.capabilities.imageInput(model)`; unknown answers fail closed. |
| 18 | **A download is a minted, single-use capability — never a standing URL** | The web UI mints a token per click via a DDP method that authorizes exactly like the publication (roster-aware), then GETs `/agent/attachments/<token>`. Owned and anonymous sessions use the identical flow. Serving is `Content-Disposition: attachment` + `nosniff`, always. The token collection joins the deny-all client-write belt — without that, a forged client insert is an exfiltration primitive. |
| 19 | **Approval legibility is a tool-authored `describe`, hydrated at park time** | Tool specs gain `describe?(args, ctx)`; dispatch calls it when parking (try/catch, length-capped) into `pending.display`. `describe` survives `resolveTools`' projection onto `ResolvedTool` (it would otherwise be silently dropped). The prompt item, the email lens, and the web approval bar prefer it. |
| 20 | **Forks and subagent children carry the roster** | A fork copies `participants` verbatim (and resets `relay`); it stays owned by the source owner — "a fork never changes hands" holds, and a member who forks gets a session they can still read *because the roster came along*. A subagent child copies the parent's HUMAN participants (its own model is its only model), preserving the publication's invariant that a child authorizes exactly the people the parent authorizes. `Agent.ask` throwaways never have rosters, and `onReply: 'continue'` is refused inside them (and inside subagent children) — a continued conversation must not point at a session that is about to be deleted. |

## 3. What's in scope

**Core (`10thfloor:agent`):** the participant types, seeding, and roster cap;
the membership rewrite of the SIX authorization sites (`requireSession`, the
two publications, `Agent.compact`'s selector, `forkSessionById`'s selector,
claim-history's guard) plus the `via` principal; `from`/`to` on message rows
and `from` on tool rows and deltas; `@`-addressing, `pendingRelay`, the relay
budget, and the unanswered-tail re-resolution at wake; per-model provider
projection, the omniscient compaction projection, and the participants block
appended per-iteration in the loop; `Agent.participants`
(add/remove/list) and the remove semantics (§4.6); binding `admits` +
`member` fields and the admission precedence in ingress; link-time roster
reconciliation; the remote-media fetcher and its SSRF gates; the lens-law
media extension; `AttachmentDownloadTokens` (deny-belt, NAMES, TTL), the
mint method, the route, and the UI chips (`prettySize` moves to `common/`);
`describe` on tool specs and `ResolvedTool`, `pending.display`, and
`pending.agent`; `Provider.capabilities`, `ProviderMessage.images`, the
result-attachment collector through `afterToolResult` at BOTH dispatch
insert sites, request-time hydration, and the strip-and-degrade retry.

**Email (`10thfloor:agent-channel-email`):** `onReply: 'continue' | 'fresh'`
and `kind` on compose; the pre-bind (§5); destination adoption on inbound
(threading headers); compose's `describe`.

**Chat channels (slack/sms/whatsapp/telegram):** inbound media translation to
`RemoteAttachment`; the `media` recipe per factory; the file-only-message
fix; Telegram's `caption` and largest-`PhotoSize` rules; Slack's
`file_share` unlock with the bot-guard invariant.

**Out of scope by design:** OUTBOUND media on chat surfaces (the naming
clause still renders files as text lines there); concurrent turns;
model-chosen destinations (§7 of the channels spec stands); cross-surface
mirroring of participant speech (§7.4); per-participant transcript
visibility; presence/typing; unlinking and data-deletion; localization; HTML
mail; ownership transfer (§12).

## 4. The participant model — mechanics

### 4.1 Types, seeding, and the cap

```ts
// On AgentSession — all optional, additive, migration-free
participants?: SessionParticipant[];
relay?: number;                        // model-relay hops since the last human message
pendingRelay?: { agent: string; seq: number };  // durable relay wake (decision 7)

interface SessionParticipant {
  /** Derived, stable, collision-is-the-guard:
   *  humans:  'h:<userId>' (account) | 'x:<kind>:<externalUserId>' (channel identity)
   *  models:  'm:<agentName>'
   *  The anonymous owner seeds as 'h:anon'. Channel identity components are
   *  NORMALIZED exactly as the channel's lens normalizes them (email:
   *  lowercase) — an exact-match world must write exact matches. */
  id: string;
  kind: 'human' | 'model';
  role: 'owner' | 'member';
  userId?: string | null;              // humans: linked account, null if none
  identity?: { kind: string; externalUserId: string };
  assurance?: 'none' | 'link' | 'oidc';
  agent?: string;                      // models: the registry name
  displayName: string;                 // display-string discipline applies
  addedBy?: string;
  joinedAt: Date;
}
```

On `AgentMessage`: `from?: { participant: string; name: string }` and
`to?: string`, both additive; tool rows carry `from` too (decision 4).
`AgentDelta` gains the running participant so the streaming row can be
attributed before it commits.

**Seeding is single-winner** (a reviewer-found race: two racing first-joins
would each seed): materialization is one guarded write — `$set` of the seed
(owner human + primary model) filtered on `participants: { $exists: false }`
— and the loser retries as a plain join. Joins are per-id guarded pushes
(`'participants.id': { $ne: id }` + `$push`). Roster cap: 16.

### 4.2 Membership is the authorization

`requireSession` grows two branches beyond today's equality: (a) a human
roster row with the caller's `userId`; (b) — for trusted callers only — a
roster row whose `identity` equals a verified `via: { kind, externalUserId }`
that ingress passed (decision 12). The DDP caps never accept `via`. The same
membership predicate lands in `pubSession`, `pubSessions` (via `$or` with an
index on `'participants.userId'`), `Agent.compact`'s selector, and
`forkSessionById`'s selector. Claim-history's sweep is narrowed: it skips
`member: true` bindings entirely, and additionally `$set`s `userId` +
`assurance` on roster rows whose `identity` matches the newly linked
identity — a linked member gains DDP standing without ever being handed the
session's ownership.

The anonymous rule is unchanged: `userId: null` matches only the null owner.

Approvals: any human member who passes `requireSession` (a DDP capability —
so account members, plus the anonymous owner) may answer, subject to the
agent's `approve` predicate. Channel-identified members cannot answer:
prompts never reach their bindings (decision 14), and `via` is accepted by
`sendToSession` only — `recordVerdict` takes `via` in signature for future
use but refuses it in v3. The approval note gains `byParticipant?: string`
alongside `by`.

### 4.3 Turn-taking

`sendToSession` resolves the addressee mechanically: explicit `extras.to`,
else a leading `@<token>` matching a model participant's agent name (parsed
once, before the insert; the token stays in the text), else the primary. The
send-path turn-budget filter always reads the PRIMARY's config; the
addressed turn's `RunConfig` is composed: **model / system / tools /
provider / retry / context from the addressee's registry entry; budget from
the primary's** — one purse per conversation (a reviewer finding: the first
draft said "one purse" while handing `deferTurn` the addressee's budget).

**Wake resolution is re-derived, not trusted.** `deferTurn` resolves which
agent runs from durable state at wake time: `pending.agent` when resuming a
park; `pendingRelay.agent` when consuming a relay; else the newest
unanswered user row's resolved addressee; else the primary. The loop's
post-release self-check (the verdict-wake pattern) re-reads the session
after `releaseLease` and defers again if an unanswered addressed row or a
`pendingRelay` survived the wind-down — this is what makes an addressed
send that landed during a live turn, or a relay scheduled by the committing
turn, durable across the running-set/lease race the loop already documents.
The watcher gains the matching sweep case (`phase: 'idle', pendingRelay:
{ $exists: true }`), and its orphan-recovery, `recordVerdict`, and the
approval-timeout path all resolve the recorded addressee instead of
`session.agent`.

**Interjections re-resolve.** Today the loop `continue`s when a user row
interjects at the turn-final boundary. With a roster present, the loop
first resolves the interjected row's addressee: if it is not the running
model, the turn ENDS (the self-check wakes the right config); a human
interjection also clears `pendingRelay` — a human message outranks a
pending relay, at any seq.

Parking stamps `pending.agent` (the addressee whose gate parked). Hooks run
under the agent whose turn it is — named, because per-agent hook matching
otherwise silently runs the primary's chain on an addressee's turn.

The system-prompt participants block is appended INSIDE `runTurn`, per
iteration, from the session document the loop re-reads anyway —
`buildSystemPrompt` stays session-blind and `RunConfig.system` stays static
(a reviewer finding: the roster mutates mid-turn; a defer-time prompt is
stale by design). Format: "You are 'analyst'. In this conversation:
Mackenzie (human, owner), support (model). Address a model colleague by
starting your reply with @name."

### 4.4 The provider view

`toProviderMessages(msgs, view?)` stays synchronous and byte-free. `view`
carries the running model's participant id and the roster; rules are
decisions 8–9. Rows with no `from` project with the fixed defaults
(assistant → primary, user → owner). No `view` = today's projection,
byte-identical.

**Compaction uses a third projection**: an omniscient, all-attributed view —
every row prefixed with its speaker, all models' turn-final rows visible
(working still dropped) — because any single participant's view discards
exactly what a summary must fold in, and the summarizer is not a
participant. Group-session summaries are asked to preserve speaker
attribution; pre-roster summaries are frozen text and stay unattributed
(named, accepted). Compaction — automatic or explicit — always runs and
bills under the PRIMARY agent's config, whichever participant's turn
triggered it.

### 4.5 Relay hygiene

A relay-addressed turn-final commit does not claim staged attachments
(decision 13). The relay-cap note is note-only — phase stays `idle`, the
session is not stopped. `session.relay` resets to 0 inside `sendToSession`'s
atomic update for human messages.

### 4.6 Leaving

`Agent.participants.remove(sessionId, participantId, { by })`: refused for
`role: 'owner'` (ownership transfer is an open question); removes the roster
row and DELETES the member's `member: true` bindings — egress consults only
bindings, so removal without teardown would keep mailing the departed member
forever. A live web subscription is revoked on reconnect (named, accepted —
the publication authorizes at subscribe time). Ingress stops admitting the
identity on its next event because admission reads the roster.

## 5. Closing the composed loop

`composeEmailTool` gains `onReply?: 'fresh' | 'continue'` (default
`'fresh'`) and `kind?: string` (default `'email'` — the registered channel
kind whose webhook will carry the reply; kinds are app-chosen strings and
the first draft's hardcoded `'email'` broke under any other registration).
`'continue'` requires that kind to be registered, and is refused —
structured, model-routable — in throwaway (`Agent.ask`) and subagent-child
sessions. The recipient address is NORMALIZED (trim, lowercase) before any
derived write.

With `'continue'`, the tool body:

1. **Mints the thread key**: `threadKey('compose:' + sessionId + ':' + to)`
   — deterministic per (session, recipient), so a crash-recovery re-run AND
   a second compose to the same address collide into the SAME binding
   (adopt), never a duplicate delivery stream. Per-toolCall derivation was a
   reviewer blocker: tool-call ids are only unique within one provider
   response (the v2 deviation-3 lesson, relearned).
2. **Sends** with `destination.replyKey = key` — `Reply-To` becomes
   `local+<key>@domain`; the reply comes back carrying the key as Postmark's
   `MailboxHash` through the wholly-unchanged lens.
3. **On a successful (`sent`) outcome only** — pre-binds and joins:
   - `ChannelBindings` insert (insertOrLose, adopt on collision):
     `_id: '<kind>:<key>'`, the composing `sessionId`, `agent` = the
     session's agent, **`userId` = the composing session's owner** (so the
     claim-history sweep's `userId: null` filter can never grab it),
     `externalUserId` = the normalized recipient, `audience: 'direct'`,
     `admits: 'members'`, **`member: true`** (excluded from prompts,
     statuses, and capability URLs — decision 14), **`deliveredSeq` = the
     session's current head, snapshotted before the send** (a binding born
     at 0 would mail the recipient the session's entire backlog within one
     sweep), destination `{ to, subject, replyKey: key }`.
   - Roster join: `{ id: 'x:<kind>:<to>', kind: 'human', role: 'member',
     identity, assurance: 'none', displayName: to, addedBy: 'm:<agent>' }`,
     seeding first if needed (§4.1).
   An abandoned or refused send performs neither — no phantom participants.
   The crash window between send-success and pre-bind is closed by the
   dispatch re-run: `deliverOnce` reads the settled receipt and the re-run
   completes steps 3's idempotent writes.
4. **Destination adoption**: when an admitted inbound event's binding
   destination lacks `rootMessageId`, ingress merges the reading's
   `rootMessageId` (and re-subjected subject) into it — one guarded `$set`
   in the adopt branch. Without this, every agent reply after the first
   ships with no `In-Reply-To`/`References` and the thread shatters in the
   recipient's mail client.

The reply routes to the pre-bound conversation; the sender matches the
roster row by identity; ingress passes `via`; `sendToSession` admits and
stamps `from`; the composing session continues.

**Verification posture, named:** member admission on email accepts an
identity match regardless of `senderVerified` — most legitimate mail lacks
author-aligned DKIM, and requiring it would silently strand most replies.
The tradeoff is stated plainly: an actor who can both spoof the recipient's
`From` and knows the reply key (which travels in the thread's headers) can
inject a *message* — attributed, visible, `assurance: 'none'`, and carrying
no approval or DDP authority whatsoever (decisions 12/14). Verified DKIM
still gates account RESOLUTION exactly as today.

**Named loudly:** `'continue'` turns the session into a group conversation.
Every subsequent outward reply is delivered to every binding, including the
recipient's email. The `gate: 'ask'` approval is the consent moment, the
tool description says so, and §8's `describe` shows the approver the actual
recipient. What the recipient does NOT get: prompts, statuses, capability
URLs (decision 14), or the session's prior history (`deliveredSeq` snapshot;
they do read from seq 0 on the WEB only if they later link an account and
are thereby a roster member with DDP standing).

## 6. Chat media ingest

### 6.1 The contract

```ts
// InboundReading.attachments widens:
attachments?: Array<ChannelAttachment | RemoteAttachment>;

interface RemoteAttachment {
  name: string;
  contentType: string;
  declaredSize?: number;    // the provider's claim — checked BEFORE fetching
  url?: string;             // https only — for providers whose event carries one
  ref?: string;             // for providers whose fetch needs credentials to
                            // even name the resource (Telegram file ids)
  indirect?: true;          // the first fetch returns JSON naming the real target
}

// On ChannelDef — factory-built, closes over the channel's secrets:
media?: {
  hosts: string[];                                   // exact-match https allowlist
  request?: (att: RemoteAttachment) => { url: string; headers?: Record<string, string> };
  resolveIndirect?: (json: unknown) => string | null; // extract/construct hop-2 URL
};
```

The lens stays pure AND secret-free (it is a module constant — it cannot
carry a token, a reviewer finding the first draft missed). The def's
`request` builds the credentialed fetch (default: `att.url`, no headers);
`resolveIndirect` extracts — or CONSTRUCTS, Telegram's token-in-path case —
the second URL from the first response's JSON.

### 6.2 Core admission, per remote file, in order

Count cap → `declaredSize` vs the per-file cap (over → note, no fetch) →
`request()` → host allowlist check → size-gated streaming fetch (abort past
`maxFileBytes + 1`; per-fetch timeout ~20s) → if `indirect`:
`resolveIndirect` → host check again → second fetch, SAME headers (the
indirect hop is a credentialed, allowlisted provider API call — unlike
REDIRECTS, which re-check the host and strip auth cross-host; the asymmetry
is deliberate and safe because both targets are allowlisted) → bytes →
base64 → the existing `admitInboundAttachments`.

**A failed fetch is a note, never a throw** — expired WhatsApp URLs (~5
min) and deleted Slack files are routine, and a throw past the admission
claim releases it and 500s into the provider's retry storm. The message
still delivers with `[file "x" could not be retrieved]`. Total fetch time
may exceed a chat provider's ack deadline; the admission claim absorbs the
duplicate retries (named, accepted). Refusal notes name the FILE, never the
URL or headers.

### 6.3 Per-channel translations

- **Slack**: `files[]` → `url_private_download` + Bearer via `request`;
  hosts `['files.slack.com']`. The echo guard becomes
  `bot_id || (subtype && subtype !== 'file_share')` — bot-authored file
  shares STAY noops (the surviving belt is `bot_id`, and a test pins it).
- **SMS/Twilio**: `NumMedia`/`MediaUrl<i>`/`MediaContentType<i>`; no auth by
  default (Basic only when the account enforces media auth — a factory
  option); hosts `['api.twilio.com', 'media.twiliocdn.com']`, named as a
  maintenance liability (the CDN host is not contractual).
- **WhatsApp**: media id → lens emits `url:
  'https://graph.facebook.com/<ver>/<id>'`, `indirect: true`; `request`
  adds the Bearer; `resolveIndirect` returns `json.url`; hosts
  `['graph.facebook.com', 'lookaside.fbsbx.com']`.
- **Telegram**: lens emits `ref: file_id`, `indirect: true`; `request`
  builds the `getFile` call (token-in-URL); `resolveIndirect` constructs
  `file/bot<token>/<result.file_path>`; hosts `['api.telegram.org']`;
  message text is `caption ?? text`; a photo maps to ONE attachment — the
  largest `PhotoSize`, not the whole thumbnail array.
- All four adopt email's sharpened guard: empty text WITH files is a
  message, not a noop.

### 6.4 The law grows again

`assertLensRoundTrip` gains a media exemplar: `RoundTripOptions` accepts a
`mediaMessage` synthesizer; the helper asserts the reading is a `message`
whose attachments carry each file's name and contentType, and that a
file-only event reads as a message. Without law coverage, all four
translations would ship on the only seam the contract leaves untested.

## 7. The web download surface — and what surfaces see

### 7.1 Tokens

`AttachmentDownloadTokens` (`Random.secret()` id, `sessionId`,
`attachmentId`, `expiresAt` ~60s, TTL `expireAfterSeconds: 0` in
indexes.ts, a NAMES entry, and membership in `denyAllClientWrites` — the
full link-token idiom; omitting the deny belt would let a client insert a
forged token naming any session's attachment).

### 7.2 Mint and serve

DDP method `agent.attachmentToken(agent, sessionId, attachmentId)` —
authorized by `requireSession` (roster-aware, anonymous capability
included), verifies the ref exists in that session, mints, returns the
token. `GET /agent/attachments/<token>` redeems (`findOneAndDelete`,
expiry in code), reads the store session-scoped, and streams decoded bytes
with `Content-Disposition: attachment; filename="<sanitized>"`,
`X-Content-Type-Options: nosniff`, sanitized content type. Never inline.
Unknown/spent/expired: one indistinguishable 404. The route mounts in a NEW
startup call outside the channels guard (channel routes mount only when
channels exist) and not under test — route tests drive the handler
directly, the `handleInbound` pattern.

### 7.3 UI

`renderRow` renders a chip per ref — name, `prettySize` (which moves to
`common/`; the client cannot import server code) — click mints and
navigates. Click-minted, single-use, 60s: nothing mail-scanner-shaped
applies and no URL outlives its download.

### 7.4 What a channel member sees — named honestly

Channel delivery remains: turn-final outward replies (+ overflow). A
channel-surface member does NOT receive other participants' speech — no
cross-surface mirroring in v3 (deliberately not built, §11). The "one
shared history" is the transcript itself, readable in full by members with
DDP standing on the web. The consent framing in §10 is written against
this: joining grants *transcript standing*, delivery stays outward speech.

## 8. Approval legibility

Tool specs gain `describe?: (args, ctx) => string | Promise<string>`.
`resolveTools` carries it onto `ResolvedTool` (it would otherwise be
projected away — a reviewer catch); dispatch calls it when parking, in a
try/catch with a length cap, into `pending.display` (which joins the
`pending` type; the publication already ships pending minus wakeToken).
`promptItem` copies it; the email lens renders it above the clamped args
JSON; the web approval bar prefers it. Compose's `describe`: recipient,
subject, body head, each attachment as `name (size)` — resolved
session-scoped at park time. Stale-by-approval-time is accepted: `run`
still re-validates policy, refs, and caps after the verdict, exactly as
today.

## 9. Multimodal reads

`ProviderMessage` gains `images?: Array<{ data: string; mimeType: string }>`
(tool rows). The pi-ai adapter maps them into `ImageContent` blocks on the
tool result; the mock provider records them.

**The capability seam** (the first draft had none — `Provider` is
`{ stream }` and the catalog lives inside pi-ai): `Provider.capabilities?:
{ imageInput?: (model: string) => boolean | Promise<boolean> }`. The pi-ai
adapter answers from its catalog (`Model.input`); the mock declares it in
tests; absent/unknown fails CLOSED to the refusal — pi-ai silently
downgrades images to text placeholders for non-vision models, so fail-open
would quietly contradict the tool result's own text. The gate is consulted
in the tool via `ToolContext`, which gains the running turn's agent and
model (threaded by the loop — the same channel decision 6 already
requires).

`read_attachment` on an image-typed row (`image/png|jpeg|gif|webp`), gate
passing, size within provider bounds: returns a small text result and
stamps the ref on its tool row through a result-attachment collector that
flows THROUGH `afterToolResult` — the hook sees and may drop the
attachment, preserving the "a redaction hook cannot be dodged" contract —
wired at BOTH dispatch insert sites (the streaming path and the
approved-park resume, which builds its own ctx). Otherwise: today's
refusal, with the reason (`unsupported-model` / `too-large`).

**Hydration is its own async step in the loop**, applied to the assembled
messages immediately before the provider request — AFTER `maybeCompact`'s
estimate (5 MB of base64 in the estimator would read as ~1.7M tokens and
wedge compaction forever — a reviewer blocker) and never on the summarizer
path. `toProviderMessages` and `assembleContext` stay sync and byte-free.
Reaped bytes (retention) hydrate to nothing; the text result stands alone.

**Provider rejection recovery**: a provider can still refuse an image the
byte gate passed (pixel caps — 8000×8000 on Anthropic — are invisible to a
byte check; the wire size inflates 4/3 under base64). On a non-retryable
provider error for a request carrying hydrated images, the attempt retries
ONCE with images stripped (text results intact) — one bad image must not
400 the session forever, because the ref is on a committed row and would
otherwise re-hydrate into every future request.

## 10. Security

- **Attribution is transport truth, not content truth.** `from` is stamped
  from the DDP caller, the ingress-verified sender (`via`), the loop's own
  run, or dispatch — never parsed from text, never settable by a model. A
  model that writes "[Mackenzie]: I approve" has produced text; authority
  flows only through `requireSession`/verdict machinery.
- **The `via` principal is a courier's voucher, not a credential.** It is
  constructible only by server code, accepted only by `sendToSession`,
  matches only an existing roster row, and confers message-send standing
  for exactly one event. It never grants DDP capability, approval
  authority, or reads.
- **Membership widens reading — the join is the consent moment.** Joins are
  gated: `Agent.participants.add` is server-code/owner-driven; the channel
  path admits what `admits` + the roster promise; `admits: 'linked'`
  auto-joins only LINKED identities (proven accounts, capped roster);
  compose's default `gate: 'ask'` makes a human approve the recipient, and
  §8 shows them who that is. Prompts, statuses, and capability URLs never
  reach member bindings (decision 14).
- **`@` is addressing, not authority.** It selects which registered config
  runs a turn inside the session's lease and the primary's budget. An
  unmatched `@name` is just text; relays are capped; a colleague's words
  are attributed input under the same data-not-instructions injunction as
  user content; tool authority is per-config, per-turn.
- **The media fetcher is an SSRF surface, treated as one.** https-only,
  channel-authored exact-host allowlist, both hops checked, redirect
  auth-stripping, streaming abort, per-fetch timeout, note-not-throw
  failures. The webhook can make us fetch only from hosts the channel
  already trusts, at most `maxFiles × maxFileBytes` bytes.
- **Download tokens are the verdict-token discipline, shorter-lived** —
  and deny-belted, so the client cannot mint its own.
- **Image bytes go only to the provider**, on the request path, hydrated
  after estimation, strippable by hooks, refusable by the gate, and
  droppable on provider rejection. They never land on rows, in the
  publication, or in logs.
- **Compose's spoofing window is named, not hidden** (§5): reply-key +
  From-spoof = one attributed, powerless message into a session that chose
  to admit that correspondent. The alternative — DKIM-gated admission —
  silently strands most legitimate human replies; chosen and stated.

## 11. Things deliberately NOT added

- **No new collection for participants** — roster is session state.
- **No concurrency** — one lease, one turn, one linear transcript.
- **No model-chosen destinations** — addressing picks a colleague's
  config, never a transport target.
- **No text parsing beyond one leading token.**
- **No per-participant transcript visibility** — join = full standing;
  finer scoping is a future spec.
- **No cross-surface mirroring of participant speech** — channels carry
  outward replies; the full history is the web's (§7.4).
- **No channel-member approvals** — prompts stay off member bindings;
  verdict standing needs DDP membership.
- **No presence, typing, or read-state.**
- **No outbound chat media** — the naming clause still speaks for files on
  chat surfaces.
- **No standing download URLs** — minted, burned, expired.
- **No image generation, no non-image binary rendering** — reads only.
- **No roster mutation by models** — compose's policy-gated,
  approval-defaulted recipient is the one exception.

## 12. Open questions

- **Ownership transfer.** Remove refuses the owner; a session whose owner
  should hand off (or whose owner account is deleted) has no story.
- **Partial visibility** — a `sinceSeq` per participant; cheap to store,
  expensive to honor everywhere.
- **Per-model budgets** — one purse is right until cost profiles diverge.
- **Human-addressed turns** — "waiting on Dana" as a real parked state.
- **Roster-aware rate limiting** — per-sender throttles multiply in group
  sessions; the turn budget bounds spend, fairness is unspecified.
- **Cross-surface mirroring** — if channel members should someday see each
  other's speech, it needs an anti-echo design of its own.
- **Outbound chat media**; **unlinking and deletion** — inherited, now
  with more parties.

## 13. Next steps

Build order, each step green before the next:

1. **Participants core** — types, seeding (single-winner), the six-site
   membership rewrite + `via`, `from`/`to` (rows, tool rows, deltas),
   `@`-addressing, `pendingRelay` + relay budget + watcher case + wake
   re-resolution + interjection re-resolve, run-as-owner, composed
   RunConfig (addressee × primary budget), `pending.agent`, per-iteration
   participants block, provider projections (view + omniscient),
   `Agent.participants` with remove semantics; tests incl. the
   byte-identical-1:1 assertion and the wrong-model-resume regressions.
2. **Channel membership** — binding `admits`/`member`, the admission
   precedence, `via` plumbing, link-time roster reconciliation,
   member-binding delivery policy (no prompts/statuses/URLs); tests.
3. **The composed loop** — compose `onReply`/`kind`, key mint
   (session+recipient), send-then-bind ordering, pre-bind field discipline
   (owner userId, deliveredSeq snapshot, member flag), destination
   adoption, throwaway/subagent refusal, normalization; email tests.
4. **Chat media** — `RemoteAttachment`, `ChannelDef.media`, the fetcher
   (hosts, hops, redirects, timeout, note-not-throw), four lens
   translations with their named quirks, the law's media exemplar;
   mocked-fetch tests.
5. **Downloads** — token collection (deny-belt, NAMES, TTL), mint method,
   route (own mount), chips, `prettySize` to common; tests.
6. **Approval legibility** — `describe` through `ResolvedTool`,
   `pending.display`, renderings, compose's describe; tests.
7. **Multimodal reads** — `Provider.capabilities`, `ProviderMessage.images`,
   ToolContext threading, the collector through `afterToolResult` (both
   sites), loop hydration after estimate, strip-and-degrade retry; tests
   on the mock with a declared capability.
8. **Docs** — READMEs; both prior specs' open questions gain pointers
   here; v2 decision 8's supersession recorded there and here.

## 14. Build deviations

Recorded as built, where the code taught the spec something:

1. **`from` stamps rostered rows only** (decision 2, amended in place): the
   projection's fixed defaults attribute pre-roster history exactly as an
   always-stamp would have, so the extra bytes bought nothing and 1:1 rows
   stay bit-for-bit.
2. **The media law checks count + content type, not names** (§6.4): Twilio's
   MMS form fields carry no filename, and a lens cannot preserve what the
   provider never transmits — mechanical names are the honest translation.
   The law's corpus is also ONE file, because several surfaces deliver one
   media per message; multi-file translation is each package's own test.
3. **`admits` is also a `ChannelDef` knob** — the channel-level default new
   bindings are stamped with; the binding field remains the authority.
4. **Destination adoption is a channel-authored hook**
   (`ChannelDef.adoptDestination`), not a core `$set`: the destination is
   opaque to the core, and only the channel knows which of its fields may be
   learned from an inbound event.
5. **`RemoteAttachment` gained `ref`** beside `url`, and the indirect
   resolver lives on the def (`media.resolveIndirect`): Telegram needs the
   bot token to even NAME the resource, so the lens emits the bare file id
   and the factory — which owns the token — builds both hops.
6. **`session.ephemeral`** marks `Agent.ask` throwaways so compose's
   `'continue'` refusal has a fact to read; the alternative was a heuristic.
7. **The compose thread key is per (session, recipient)**, with the SEND
   still receipted per tool call: repeat composes share one conversation and
   one binding rather than multiplying delivery streams.
