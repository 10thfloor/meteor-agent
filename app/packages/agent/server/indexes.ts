import { Meteor } from 'meteor/meteor';
import type { Mongo } from 'meteor/mongo';
import { AgentMemories, AgentMessages, AgentSessions } from '../common/collections';
import {
  ChannelBindings, ChannelLinkTokens, ChannelVerdictTokens,
  DeliveryReceipts, InboundSubmissions,
} from './channels/collections';
import { AgentAttachments } from './attachments';
import { AttachmentDownloadTokens } from './downloads';
import { NAMES } from '../common/names';

/**
 * The indexes this package's own queries need, created at startup.
 *
 * Mongo creates exactly ONE index for you — `_id` — and nothing else, however
 * obvious the access pattern. Every query below was previously a COLLSCAN, and
 * two of them run on a timer forever:
 *
 *  - `agent_messages { sessionId, seq }` — the workhorse, and the one whose
 *    absence hurts first. Every transcript read (`mergeView`'s history, the
 *    `agent.session` publication, `readHistory` on every single turn, the
 *    compaction cut) sorts one session's rows by `seq`, and this is the index
 *    that makes that a range scan instead of a scan of every message on the
 *    deployment. Verified absent before this change: `listIndexes` on a freshly
 *    created `agent_messages` returns `_id_` and nothing more — a compound key
 *    is never implied by a field name.
 *  - `agent_sessions { 'parent.sessionId', createdAt }` — the orphan-child
 *    sweep's candidate scan (`server/watcher.ts`, case 4), which runs every 15
 *    seconds against EVERY session ever created, forever, to discover that
 *    nothing is wrong. Task 2 flagged it when it landed; this is that debt.
 *  - `agent_sessions { phase, 'lease.until' }` — the sweep's other three
 *    queries (orphan claim, standing verdict, unanswered park) all lead with
 *    `phase` and two of them add a `lease.until` bound.
 *
 * `sparse` on the parent index is deliberate but MODEST: Mongo drops a document
 * from a compound sparse index only when it is missing EVERY indexed field, and
 * every session has `createdAt` — so the index still holds a row per session and
 * the flag buys nothing today. It is kept because it is free, it is correct if
 * the key ever narrows to `parent.sessionId` alone, and a `partialFilterExpression`
 * — the keyword that WOULD exclude parentless sessions — cannot be added later
 * without dropping the index by name. Recorded here rather than discovered later.
 *
 * IDEMPOTENT AND NON-FATAL. `createIndex` on an index that already exists with
 * the same spec is a no-op, so this runs on every boot of every server. A
 * failure only WARNS: a locked-down Atlas user (or a read-only secondary
 * connection) may lack `createIndex`, and a package that refuses to boot
 * because it could not create a performance index would be trading a slow
 * deployment for no deployment. The queries are all still correct without them.
 */
export async function ensureIndexes(): Promise<void> {
  // The one package setting the store reads: how long attachment bytes live.
  const retentionDays = Number(
    (Meteor.settings as any)?.packages?.['10thfloor:agent']?.attachments?.retentionDays ?? 0,
  ) || 0;
  const specs: Array<{
    collection: Pick<Mongo.Collection<any>, 'createIndexAsync'>;
    name: string;
    // `'text'` joins the union for the memory fallback rung — a text index
    // is the ladder's middle rung and the driver takes it on the same call.
    keys: Record<string, 1 | -1 | 'text'>;
    options?: Record<string, unknown>;
  }> = [
    {
      collection: AgentMessages,
      name: NAMES.messages,
      keys: { sessionId: 1, seq: 1 },
    },
    {
      collection: AgentSessions,
      name: NAMES.sessions,
      keys: { 'parent.sessionId': 1, createdAt: 1 },
      options: { sparse: true },
    },
    {
      collection: AgentSessions,
      name: NAMES.sessions,
      keys: { phase: 1, 'lease.until': 1 },
    },
    // The system-intent sweep (CASE 6). Keyed on `pendingSystem.at` — the
    // field the query RANGES over — rather than on `pendingSystem` itself,
    // which could not serve the bound and would put app-authored prompt text
    // in the index key.
    //
    // `partialFilterExpression`, not `sparse`: this must stay a single-key
    // index for sparsity to mean anything (Mongo drops a document from a
    // COMPOUND sparse index only when it is missing every indexed field, and
    // every session has the rest), and a partial filter cannot be added later
    // without dropping the index by name. Without it, CASE 6 scans every live
    // session every sweep, forever — the debt CASE 5's unindexed `pendingRelay`
    // query already carries, recorded here so this one does not inherit it.
    {
      collection: AgentSessions,
      name: NAMES.sessions,
      keys: { 'pendingSystem.at': 1 },
      options: { partialFilterExpression: { pendingSystem: { $exists: true } } },
    },
    // The membership clause (participants spec §4.2): `pubSessions`' $or and
    // every roster-aware requireSession carry
    // `participants.$elemMatch.userId`, and a multikey index on the path is
    // what keeps a member's conversation list from scanning every session.
    // Sparse buys nothing today (see the header) but is free and correct.
    {
      collection: AgentSessions,
      name: NAMES.sessions,
      keys: { 'participants.userId': 1 },
      options: { sparse: true },
    },
    // ---- Channels (channels spec §6) ----------------------------------------
    // The fan-out lookup: a committed row → every binding of its session
    // (the egress observer runs it per insert), and the notify-tool shape.
    {
      collection: ChannelBindings,
      name: NAMES.channelBindings,
      keys: { sessionId: 1 },
    },
    // The linking claim-history pass (`{ kind, externalUserId, userId: null }`).
    // `sparse` is the header's MODEST case again: `kind` is always present, so the
    // flag drops nothing today; kept for the same reasons as the parent index.
    {
      collection: ChannelBindings,
      name: NAMES.channelBindings,
      keys: { kind: 1, externalUserId: 1 },
      options: { sparse: true },
    },
    // The egress sweep's lookback slice (`{ kind, updatedAt: { $gt } }`) —
    // what bounds per-sweep cost to live conversations (egress.ts
    // `sweepLookbackMs`).
    {
      collection: ChannelBindings,
      name: NAMES.channelBindings,
      keys: { kind: 1, updatedAt: 1 },
    },
    {
      collection: DeliveryReceipts,
      name: NAMES.deliveryReceipts,
      keys: { bindingId: 1 },
    },
    // TTL reapers. Admissions are kept a week: that is the replay horizon for
    // providers whose signatures carry no timestamp (Twilio; WhatsApp's
    // message timestamp is inside the signed body but Meta legitimately
    // redelivers old payloads after an outage, so the lens does not refuse on
    // age) — a captured signed request can be replayed at most once it is
    // older than this, and the rows are tiny. Tokens carry their own expiry
    // and the TTL is only the janitor — redemption checks `expiresAt` itself,
    // because Mongo's TTL sweep runs on its own schedule and a token must be
    // dead the millisecond it expires, not within a minute of it.
    {
      collection: InboundSubmissions,
      name: NAMES.inboundSubmissions,
      keys: { at: 1 },
      options: { expireAfterSeconds: 7 * 24 * 60 * 60 },
    },
    {
      collection: ChannelLinkTokens,
      name: NAMES.channelLinkTokens,
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 },
    },
    {
      collection: ChannelVerdictTokens,
      name: NAMES.channelVerdictTokens,
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 },
    },
    // Download tokens (participants spec §7): ~60s single-use capabilities;
    // redemption checks `expiresAt` itself — this TTL is only the janitor.
    {
      collection: AttachmentDownloadTokens,
      name: NAMES.attachmentTokens,
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 },
    },
    // ---- Attachments (email v2 spec §5) -------------------------------------
    // The staged-set scan (`{ sessionId, staged: true }`) at every create-with-
    // attach and every turn-final claim, and the hydration reads — all lead
    // with sessionId.
    {
      collection: AgentAttachments,
      name: NAMES.attachments,
      keys: { sessionId: 1 },
    },
    // Retention, when configured: caps bound a MESSAGE, TTL bounds a
    // STRANGER'S PATIENCE — deployments that admit anonymous mail should set
    // `attachments.retentionDays` so an unlinked sender's files do not occupy
    // the store forever (§12). Unset = keep forever. NOTE: changing the value
    // later needs the old index dropped by hand (`createIndex` cannot alter
    // `expireAfterSeconds` in place) — the warning below names the failure.
    ...(retentionDays > 0 ? [{
      collection: AgentAttachments,
      name: NAMES.attachments,
      keys: { createdAt: 1 } as Record<string, 1 | -1>,
      options: { expireAfterSeconds: Math.round(retentionDays * 24 * 60 * 60) },
    }] : []),
    // ---- Memory (memory spec §4) ----
    // Person/agent rows: the standing block's read and the per-(user, scope)
    // cap count both come in on this one.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { userId: 1, scope: 1, at: -1 },
    },
    // The APP pool needs its own: app rows carry no `userId`, so the compound
    // index above cannot serve the work section, the pool's cap count, or the
    // publication's app clause — all three would collection-scan without this.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { scope: 1, at: -1 },
    },
    // The ladder's middle rung. Non-fatal if the deployment refuses it (the
    // loop below warns and moves on) — search then degrades to the regex rung,
    // which is exactly what the ladder exists to make survivable.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { text: 'text' },
    },
    // The keyed-upsert identity, UNIQUE and partial. Check-then-insert alone
    // is a race: the user edits a fact on the memory page while an in-flight
    // turn saves the same `key`, both read "no existing row", both insert, and
    // the key that exists to guarantee one row has produced two. The index is
    // what makes the write single-winner; `saveMemory` catches the duplicate
    // and converts the loss into the update it meant to do.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { scope: 1, userId: 1, agent: 1, key: 1 },
      options: {
        unique: true,
        partialFilterExpression: { key: { $exists: true } },
      },
    },
    // Opt-in decay: sparse, so rows without `expiresAt` are simply not in it.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { expiresAt: 1 },
      options: { sparse: true, expireAfterSeconds: 0 },
    },
  ];

  for (const spec of specs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await spec.collection.createIndexAsync(spec.keys, spec.options ?? {});
    } catch (e: any) {
      // A UNIQUE index failing is not the same class of problem as a missing
      // performance index, and must not share its reassuring wording: the
      // keyed-save race is only closed BY the index, so a build that fails
      // (the usual cause: duplicate keyed rows already in the collection)
      // leaves `saveMemory`'s adopt-on-collision branch unreachable and the
      // race exactly where it was — silently, behind a line that says the
      // package "still works".
      if (spec.options?.unique) {
        console.warn(
          `[10thfloor:agent] could not create the UNIQUE ${spec.name} index `
          + `${JSON.stringify(spec.keys)} — keyed memory saves are NOT race-safe until `
          + 'this builds. The usual cause is duplicate rows already present: remove the '
          + 'duplicate `key` rows for a given (scope, userId, agent) and restart. '
          + `Error: ${e?.message ?? e}`,
        );
      } else {
        console.warn(
          `[10thfloor:agent] could not create the ${spec.name} index `
          + `${JSON.stringify(spec.keys)}; the package still works, its queries are just `
          + `unindexed (grant createIndex, or create it yourself): ${e?.message ?? e}`,
        );
      }
    }
  }
}
