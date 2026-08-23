# Email v2: attachments, and compose as a tool

**Date:** 2026-08-23
**Status:** built — 2026-08-23, all five build-order steps green (493 package tests across the six packages). Answers the channels spec's §15 open question ("Attachments and media") at the framework level, with email as the proving surface. Companion to `2026-08-20-channels-multi-surface-delivery.md`; section references of the form §N point there.

> **Deviations from the plan as written, recorded:** (1) the five shipped lenses' naming-clause lines (step 3's last item) landed with step 1, because the law + file-bearing exemplar would otherwise fail every lens's round-trip test between steps; (2) a `maxInboundBytes` per-channel webhook body ceiling was added (registry + mount + email default 50 MB) — §11 assumed the 35 MB Postmark inbound payload parses, but the shared 1 MB mount cap would have 413'd it before the lens ever ran; (3) the derived attachment id hashes `sessionId` along with `toolCallId + name`, because tool-call ids are only unique within one provider response; (4) `Agent.ask`'s throwaway cleanup also removes the session's attachment rows; (5) a fork's copied rows keep refs that deliberately do NOT hydrate in the fork — a ref is a capability only inside its own conversation (§12); the fork shows honest not-found on read.
**Packages:** `10thfloor:agent` (contract, store, loop, one shipped tool), `10thfloor:agent-channel-email` (lens both ways, compose tool)

---

## 1. The idea

The email channel v1 is a courier of text. A real email surface carries **work product**: someone mails the agent a CSV and asks a question about it; the agent produces a report and mails it back as a file. Today both halves are missing — inbound `Attachments` are dropped by the parse, and the lens only ever emits `{ Subject, TextBody }`. The README names it honestly ("Attachments are ignored in v1"), and the channels spec names it as its one framework-level open question (§15).

This spec closes both halves, and while doing so draws the line v1 deliberately blurred past:

- **A channel is reactive.** It replies where it was spoken to. The worker delivers the turn's answer to the session's own bindings; the model never picks a destination (§7). Attachments extend *what a reply can carry*, not where it can go.
- **Composing to someone new is a deliberate act — a tool.** "Email the summary to dana@ourco.com" is not a reply; it is a side-action the model chooses, with a recipient. That is exactly the shape §7 already governs: a tool whose sensitive parameter is validated by trusted app code and gated for approval, posting through the same receipted, thin transport.

Three parts, then: **attachments ride the existing vocabulary** (additive, no new item kind), **compose is a tool built on the transport** (not a bend in the channel model), and **the transport stays a thin provider shim** (attachments are payload fields; addressing still wins last; nothing Postmark-shaped leaks inward).

## 2. Decisions already made

| # | Decision | Why |
|---|---|---|
| 1 | **No new delivery item kind.** Attachments are a sidecar field on `reply` and `overflow` | A file almost never travels alone — email sends body + files as ONE message. A separate `file` item would post two mails for one answer. The vocabulary stays brutally small (§8.2, the Rasa lesson). |
| 2 | **Refs on message rows; bytes in a side store** | Transcript rows are read constantly by the loop, the web client, and the planner; a 5 MB base64 string on a row would ride every one of those reads. `AgentMessage` gains `attachments?: AttachmentRef[]` — metadata only, additive, migration-free, the `channel`/`parent` idiom. Bytes live in one new collection. |
| 3 | **The model handles refs, never bytes** | File content never enters context unread: the model sees `name / type / size / id` lines and chooses to read via a tool. No base64 in prompts in either direction; outbound the model names refs to files trusted code already holds. |
| 4 | **Hydration is a thunk on the POST path** | `deliverOnce` already resolves items lazily, exactly so side-effectful rendering (verdict-token minting) runs only when a post actually happens (egress.ts). Loading bytes is the same kind of work and uses the same seam. The planner and the lens stay pure. |
| 5 | **Bytes are base64 strings end to end** | Postmark emits base64 inbound and demands it outbound; the contract is isomorphic (no `Buffer`); Mongo stores a 6.7 MB string in one document without ceremony. Decoding to binary and back would buy nothing but a dependency on Node globals in the wrong module. |
| 6 | **Compose depends on the transport, not on the channel registration** | The reactive channel and the proactive tool are independent consumers of one thin shim. An app can register either without the other. This is the tool/channel line, drawn structurally. |
| 7 | **The recipient is a policy decision made by app code** | §7's rule survives contact with compose: the model *proposes* `to`; an app-authored `recipients` policy validates it in trusted code, and the tool gates `'ask'` by default. A tool argument is still not an authorization boundary. |
| 8 | **A reply to a composed mail opens a fresh conversation** | Routing it into the composer's session would admit a second human into a single-owner session — §3/§15's group-ownership question, which this spec refuses to answer by accident. V2 composed mail replies-to the plain inbound address; the recipient's answer starts their own thread, the normal inbound path, zero new machinery. **Superseded on opt-in** by the participants spec (§5 there): `onReply: 'continue'` mints the key and pre-binds; `'fresh'` — this decision — remains the default. |
| 9 | **Every lens must account for attachments; only email carries them** | The round-trip law grows one clause: a rendered item's attachments must each appear by NAME in the payload — as a real provider attachment or as a textual notice ("file attached: report.csv — view on the web"). Degrade per item, downward from the full row (§8.5); never silently vanish a file. |

## 3. What's in scope

**Core (`10thfloor:agent`):** the two contract types and the widened `reply`/`overflow` items; the `AgentAttachments` store with caps and optional retention; `attachments?` on `AgentMessage` and on `InboundReading`; ingress admission of inbound files; the model-view metadata block in the loop; `Agent.attachments.create` and the shipped `readTool`; ref hydration in `deliverBinding`; the round-trip law extension; the one-line naming clause in the four shipped chat lenses.

**Email (`10thfloor:agent-channel-email`):** `lens.in` parsing Postmark `Attachments[]`; `lens.out` rendering the Postmark `Attachments` field on `reply`/`overflow`; `composeEmailTool`.

**Out of scope by design:** HTML bodies and inline `cid:` images (inbound entries carrying a `ContentID` are skipped — that is where signature logos live); content *extraction* (parsing xlsx/PDF is an app tool's job — in the flagship story the spreadsheet is produced and consumed by tools; the channel only carries it); media ingest for the chat channels (MMS, Slack uploads arrive as provider-hosted URLs, not webhook bytes — they ride this same contract later, see §14); an external blob store; virus scanning (a deployment-edge concern, named in §12); serving attachments over the web.

## 4. The contract changes

Two types, two widened items, one widened envelope — all in `common/channel-contract.ts` (types) and `common/types.ts` (the row), all additive:

```ts
/** A file riding a MESSAGE ROW: metadata only — bytes live in the store.
 *  `id` is the store key; `size` is the decoded byte count. */
export interface AttachmentRef { id: string; name: string; contentType: string; size: number }

/** A file riding a DELIVERY ITEM at render time: hydrated, base64 `content`.
 *  A lens never fetches — by the time `out` sees the item, the bytes are in it. */
export interface ChannelAttachment { name: string; contentType: string; size: number; content: string }
```

```ts
| { item: 'reply';    text: string; attachments?: ChannelAttachment[] }
| { item: 'overflow'; head: string; url?: string; attachments?: ChannelAttachment[] }
```

`overflow` keeps its files: the *text* overflowed, not the work product — a truncated cover note must not cost the recipient the report. `status` and `prompt` stay file-free.

`InboundReading` gains `attachments?: ChannelAttachment[]` — the lens passes through what the provider delivered (already base64 from Postmark), minus inline-`ContentID` entries. **Caps are not the lens's job**: admission policy is core policy (§6); the lens translates.

`AgentMessage` gains `attachments?: AttachmentRef[]`, legal on `user` rows (inbound files) and `assistant` rows (staged outbound files).

## 5. The store

One new collection, following the receipts idiom — server-only, derived ids where a writer can race:

```js
// AgentAttachments
{
  _id: 'att…',                    // random; DERIVED from toolCallId+name for tool-created rows (see §8)
  sessionId: 'abc123',            // the scope — every read and every hydration checks it
  name: 'report.csv',             // a display string, never a path (§12)
  contentType: 'text/csv',
  size: 18432,                    // decoded bytes
  content: 'UEsDBBQABgAIA…',      // base64
  origin: 'inbound' | 'tool',
  staged: true,                   // present only while awaiting the turn-final flush (§8)
  createdAt: Date,
}
```

**Caps, enforced at write time** (admission for `inbound`, `create` for `tool`), defaults chosen under Postmark's outbound ceiling — 10 MB total per send *including base64*, which inflates 4/3:

| Knob | Default | Why this number |
|---|---|---|
| `maxFileBytes` | 5 MB | One file at 5 MB is ~6.7 MB encoded — clears the 10 MB wire cap with body headroom, and one Mongo document holds it without drama (16 MB ceiling). |
| `maxFiles` (per message) | 5 | A mail, not a filesystem sync. |
| `maxTotalBytes` (per message) | 6 MB | ~8 MB encoded + bodies < 10 MB. Inbound, Postmark itself allows up to 35 MB cumulative — we accept less, on purpose. |
| `retentionDays` | unset | When set, a TTL index on `createdAt` prunes the store. Recommended for deployments that admit anonymous mail: caps bound a message, TTL bounds a stranger's patience (§12). |

Per-channel inbound caps join `ChannelKnobs` (`attachments?: false | { maxFileBytes?, maxFiles?, maxTotalBytes? }`; `false` restores v1's ignore-them behavior); the store-wide `retentionDays` is a package setting.

## 6. Inbound — a file arrives

The pipeline (§9) is unchanged; two steps learn about files.

**The email lens** maps `b.Attachments[]` → `ChannelAttachment[]`: `Name → name`, `ContentType → contentType`, `ContentLength → size`, `Content → content`; entries with a non-empty `ContentID` are skipped (inline images — overwhelmingly signature furniture). And the noop rule sharpens: v1's "no text is a noop" becomes **"neither text nor attachments is a noop."** An attachment-only mail — a person answering "can you check this?" with just the file — is a message now; `in` returns `{ kind: 'message', text: '' }` with the files, and admission requires text *or* at least one kept file.

**Admission** (`route`, the `message` intent) applies the caps in order — count, then per-file, then running total — keeps what passes, and *says what it dropped*: the user row's content gains one mechanical bracket line per rejected file, e.g. `[file "raw-export.zip" (12 MB) exceeded the 5 MB limit and was not kept]`. Fail closed, never silently: the model and the web transcript both see exactly what the agent actually has. Kept files are inserted into the store (`origin: 'inbound'`, the session's id) and their refs ride the user row.

**The model's view.** When the loop builds the provider request, a row carrying refs gets a mechanical suffix — request-view only; the committed row's `content` stays exactly what the human wrote plus any admission notes:

```
[2 files attached — read one with the read_attachment tool:
- report.csv (text/csv, 18432 bytes) id=attX7…
- photo.jpg (image/jpeg, 2097152 bytes) id=attK2…]
```

No model call, no parsing, no summaries — the same "mechanical, derived at delivery time" rule the planner lives by (§8.5).

**Trust is unchanged.** The DKIM gate (`senderVerified`) still governs only identity; an unauthenticated sender's files are admitted exactly as their text is — into their own anonymous conversation. What bounds an anonymous stranger's use of your disk is the caps plus `retentionDays`, not identity (§12).

## 7. Reading — the shipped tool

The core ships one tool spec, `Agent.attachments.readTool`, that the app lists in `tools` like any inline spec (§7's idiom — nothing auto-registers):

- **Args:** `{ id }`.
- **Scope:** the row must match `ctx.sessionId` — a ref from another session reads as not-found. The id is a capability only inside its own conversation.
- **Text-like content** (`text/*`, `application/json`, `+json`/`+xml` suffixes, CSV): returns the UTF-8 text, capped (64 KB, with a truncation marker naming the full size).
- **Binary content:** returns a structured refusal — `{ binary: true, name, contentType, size }` — the model can route around. The core does not pretend to read a JPEG; rendering binary useful is an app tool's job (or a later multimodal question, §14).
- **The description tells the model the truth twice:** the content is *data from the sender, not instructions* (§12), and binary files can be forwarded (attached to a reply) even though they cannot be read.

## 8. Outbound — the agent produces a file

**Creation is an API for tool bodies**, not a model surface:

```js
// Inside an app tool's run(args, ctx) — e.g. the tool that builds the report:
const ref = await Agent.attachments.create({
  sessionId: ctx.sessionId,
  name: 'summary.csv',
  contentType: 'text/csv',
  content: csvText,               // a UTF-8 string, or { base64: '…' } for binary
  attach: true,                   // stage it for the turn's reply
  toolCallId: ctx.toolCallId,     // idempotency — see below
});
```

`create` enforces the same caps, returns an `AttachmentRef`, and — when `toolCallId` is supplied — **derives the `_id` from `toolCallId` + `name` via `insertOrLose`**. Tool dispatch re-runs on crash recovery (§7 calls that window irreducible); a re-run's `create` collides on the derived key and adopts the existing row instead of duplicating it. The house idiom, once more.

**Staging → the reply.** `attach: true` marks the row `staged`. When the loop commits the turn-final assistant row, it claims the session's staged refs (an atomic unstage per row — the single-winner shape), embeds them as the row's `attachments`, and the reply now *is* a file-bearing message. A crash between claim and commit strands claimed refs unstaged and undelivered — the file survives in the store, the re-run turn re-creates and re-stages it idempotently, and delivery follows the row that actually committed. Two systems, one honest line, same as §11.

**Delivery.** The planner passes refs through untouched (`planItems` stays pure and byte-free). `deliverBinding`, for a planned row whose message carries refs, hands `deliverOnce` a **thunk**: hydrate each ref from the store (session-checked), attach the `ChannelAttachment[]` to the item, return it. Bytes load only when a post actually happens — a settled receipt or a backoff window loads nothing, exactly like verdict-token minting. A ref that no longer hydrates (pruned by TTL) is dropped from the payload and the text gains one bracket line — `[the file "summary.csv" expired before this could be delivered]` — the courier never claims to have delivered a file it didn't, and never wedges the conversation over one.

**The email lens's `out`** widens by one field: `reply`/`overflow` items with attachments render

```js
{ Subject, TextBody, Attachments: item.attachments.map(a => ({ Name: a.name, Content: a.content, ContentType: a.contentType })) }
```

**The transport does not change at all.** Attachments are payload; the payload is spread first and addressing last; the receipt header, the retry tier (`retry`, declared — Postmark has no idempotency key), and `MAX_DELIVERY_ATTEMPTS` all apply unchanged. One consequence is worth stating: since this channel's uncertain-delivery recovery is `retry`, a crash in the post-confirm window can re-send a mail — now *with its attachment*. That was always the declared trade (§11 tier C); the payload just got heavier.

**The other shipped lenses** (Slack, Telegram, WhatsApp, SMS) satisfy the new law with the naming clause: attachments render as a text line naming each file, plus the session's web link when the audience rules allow one (§8.5). Carrying real bytes to those surfaces is future work per surface (§14); naming them is the floor, and the floor is mandatory.

## 9. Compose — the tool

The email package exports a tool factory. It is the §7 side-action pattern with the one parameter §7 forbids — a destination — handled the only acceptable way: **validated by app-authored policy, gated by default.**

```js
import { composeEmailTool } from 'meteor/10thfloor:agent-channel-email';

tools: [
  composeEmailTool({
    serverToken: cfg.serverToken,          // the same thin transport the channel uses
    from: 'Agent <agent@ourdomain.com>',
    inboundAddress: cfg.inboundAddress,
    recipients: (to, session) =>            // TRUSTED CODE decides; the model only proposes
      to.endsWith('@ourco.com'),            //   — or an explicit allowlist array, or 'linked'
    // gate: 'ask' is the DEFAULT — omit it and every compose parks for approval
  }),
]
```

- **Args:** `{ to, subject, body, attachments?: string[] }` — the last being *ref ids*, session-scoped, hydrated by the tool body. The model supplies prose and refs to files trusted code already holds; it never supplies bytes, and its `to` is a proposal the policy can refuse (a structured refusal the model routes around).
- **`recipients` is required.** There is no permissive default — an unconfigured compose tool that mails anyone the model names would be §7's prompt-injection hole, shipped. `'linked'` (addresses in `ChannelIdentities` belonging to the session's owner) covers "email it to me."
- **Gate `'ask'` by default.** The parked prompt shows the approver `to`, `subject`, `body`, and the ref ids through the existing prompt rendering — approve the exact mail or deny it.
- **Effectively-once through the existing three-phase log.** `deliverOnce` reads exactly three things from its binding: `_id` (the receipt key), `kind` (the def lookup), `destination`. Its parameter narrows to that pick-type, it accepts an explicit `def` (defaulting to the registry lookup, so the tool works with no channel registered), and compose passes a synthetic `{ _id: `compose:email:${ctx.toolCallId}`, kind: 'email', destination }`. The receipt id derives from the tool call — §7's "idempotency key carried through to the tool itself," verbatim, and the dispatch re-run window is closed the same way `channel.notify` closes it.
- **Threading, decision 8:** `destination` is `{ to, subject, replyKey: '' }` — no thread key, `Reply-To` is the plain inbound address, and the transport stamps `Auto-Submitted: auto-generated` (a mail that opens a correspondence) rather than `auto-replied` (both suppress auto-responder ping-pong, and our own `isAutomated` drops any echo). A reply from the recipient arrives as ordinary new inbound: their own conversation, their own identity rules. Routing that reply *into the composer's session* is the group-ownership question (§15 there, §14 here) and stays open on purpose.

**What compose is not:** a general reply path. The worker still delivers the turn's answer to the session's bindings automatically; a compose aimed at the person you are already talking to is the §7 double-delivery trap wearing a stamp. The tool description says so.

## 10. The law grows one clause

`exemplarItems()` gains a file-bearing reply (name, small base64 body). `assertLensRoundTrip` adds the **naming check** to totality: for every rendered item that carried attachments, each attachment's `name` must appear in the rendered payload — `JSON.stringify(payload).includes(name)` — which is satisfied equally by a real provider attachment (email: the `Name` field) and by a textual notice (SMS: "file attached: report.csv"). What it forbids is silence: no lens may render a file-bearing item and drop the file without a trace. Existing lens tests keep passing until a lens meets a file — then the law makes it decide, visibly.

The email package's own tests add: parse of a Postmark inbound with attachments (kept, inline-skipped, over-cap noted); render of `reply` + `Attachments`; the attachment-only-mail admission; compose's synthetic-binding receipt id; `create`'s idempotent collision on the derived id.

## 11. Limits and failure modes, named

- **Postmark outbound:** 10 MB total per send including base64'd attachments; `TextBody`/`HtmlBody` 5 MB each. Our defaults (§5) keep worst-case wire size ~2 MB under the ceiling; a payload rejected anyway (caps raised carelessly) is a deterministic provider rejection — the existing backoff-and-abandon machinery (`MAX_DELIVERY_ATTEMPTS`) is the answer, and the conversation does not wedge.
- **Postmark inbound:** up to 35 MB cumulative attachments arrive in the webhook JSON. The webhook body is parsed regardless; caps decide what is *kept*. Note the memory shape: a 35 MB JSON parse per event is Postmark's ceiling, not ours to change from below.
- **Mongo:** one document per file; the 5 MB cap keeps every document comfortably under the 16 MB ceiling. The store is a seam — swapping it for GridFS or S3 later changes `create`/hydrate, not the contract.
- **The 1 MB Postmark *activity* limit** (their dashboard stores only messages ≤ 1 MB whole) means large sends won't be inspectable in Postmark's UI. Cosmetic, named so nobody debugs it as a loss.

## 12. Security

- **File content is data, never instructions.** A mailed document is attacker-controlled text; `read_attachment` results carry the same standing as message text, the tool description says so to the model, and nothing in the core ever parses, executes, or renders a file.
- **The model handles refs and prose only.** Bytes never enter or leave the model; outbound content exists only because a trusted tool body wrote it; hydration and reads are `sessionId`-scoped, so a ref is a capability only inside its own conversation.
- **Recipients are policy, gated.** Compose's `to` is validated in app code and parked for approval by default. The reactive channel remains structurally unable to address anyone but its binding (§6 decision 6 stands untouched).
- **Names are display strings.** Control characters stripped, length-capped; never a path — the store is a collection, not a filesystem, so `../` has nothing to traverse.
- **Base64 is checked at the door** (decode-validity and decoded-size against the declared size) so garbage can't occupy the store under a small `ContentLength`.
- **Anonymous storage pressure is bounded** by the per-message caps and `retentionDays`, not by identity — the DKIM gate still gates only linking. Deployments that admit strangers' mail should set retention; the README will say so.
- **Nothing is served.** No download route exists in v2; bytes leave the store only inside an outbound mail to a destination the binding or the policy chose. A web download surface is a capability-URL design of its own (§14).
- **Virus scanning is deliberately absent** — it belongs at the deployment edge (Postmark scans inbound; your mail gateway scans outbound). The spec's job is to not pretend otherwise.

## 13. Things deliberately NOT added

- **No new delivery item kind** — attachments are sidecar fields; the vocabulary stays four items.
- **No bytes on transcript rows, in prompts, or in tool args** — refs everywhere the model or a hot read path lives.
- **No content extraction in the core** — no spreadsheet parser, no PDF text, no OCR. App tools produce and consume work product; the surface carries it.
- **No HTML mail, no inline images** — `ContentID` entries are skipped inbound and never emitted outbound.
- **No new receipt machinery** — compose rides `deliverOnce` with a synthetic binding; the three-phase log, tiers, and backoff are untouched.
- **No auto-registered tools** — `readTool` and `composeEmailTool` are specs the app lists, like every §7 tool.
- **No compose without a recipient policy** — a required option, not a default.
- **No second storage system** — one Mongo collection now; the seam is two functions if scale ever demands more.

## 14. Open questions

**All five answered** by `2026-08-23-participants-and-closing-the-loops.md`
(built) — the participants spec, whose roster/membership model is the
group-ownership answer this section was waiting on:

- ~~**Closing the composed loop.**~~ **Answered** (§5 there): `onReply:
  'continue'` mints the thread key decision 8 withheld (derived from session
  + recipient), pre-binds member-shaped, and joins the recipient to the
  roster. Decision 8's `'fresh'` remains the default; the supersession is
  opt-in, exactly as this section predicted.
- ~~**Media on the chat channels.**~~ **Answered** (§6 there): the lens
  envelope grew its lazy variant (`RemoteAttachment` — URL or provider ref,
  declared size, an indirect hop) and CORE fetches under a channel-authored
  host allowlist with the size check before the download. All four chat
  lenses translate.
- ~~**A web download surface.**~~ **Answered** (§7 there): a click-minted,
  single-use ~60s token through a roster-aware DDP method, served with
  attachment-disposition + nosniff — one flow for owned and anonymous
  sessions, so the URL-is-credential rule never meets a standing URL.
- ~~**Approval legibility for compose.**~~ **Answered** (§8 there): tool
  specs grew `describe(args, ctx)`, hydrated into `pending.display` at park
  time; compose's shows names and sizes.
- ~~**Multimodal reads.**~~ **Answered** (§9 there): a
  `Provider.capabilities.imageInput` gate (pi-ai answers from its catalog,
  failing closed), image blocks on tool results, request-time hydration —
  and this store is indeed where the image comes from.

## 15. Next steps

Build order, each step green before the next:

1. **Contract + store** — types, collection, caps, `create` (with derived-id idempotency), the law's naming clause + exemplar; unit tests.
2. **Inbound** — email lens parse, admission caps + bracket notes, model-view suffix, `readTool`; the attachment-only-mail case.
3. **Outbound** — staging flush on the turn-final commit, hydration thunk in `deliverBinding`, email `out` rendering, expired-ref note; the four chat lenses' naming lines.
4. **Compose** — `deliverOnce`'s pick-type + explicit-def widening, the tool factory, policy + gate; receipt-id test.
5. **Docs** — README's caveat line flips to the real rules; channels spec §15 gains a pointer here.

Postmark facts this spec relies on: outbound 10 MB/send including base64 (support article 1056), inbound `Attachments[]` of `{Name, Content(base64), ContentType, ContentLength, ContentID}` with a 35 MB cumulative cap (inbound parse guide) — both verified 2026-08-23.
