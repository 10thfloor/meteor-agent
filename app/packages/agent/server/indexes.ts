import type { Mongo } from 'meteor/mongo';
import { AgentMessages, AgentSessions } from '../common/collections';
import {
  ChannelBindings, ChannelLinkTokens, ChannelVerdictTokens,
  DeliveryReceipts, InboundSubmissions,
} from './channels/collections';
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
  const specs: Array<{
    collection: Pick<Mongo.Collection<any>, 'createIndexAsync'>;
    name: string;
    keys: Record<string, 1 | -1>;
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
    // ---- Channels (channels spec §6) ----------------------------------------
    // The fan-out lookup: a committed row → every binding of its session
    // (the egress observer runs it per insert), and the notify-tool shape.
    {
      collection: ChannelBindings,
      name: NAMES.channelBindings,
      keys: { sessionId: 1 },
    },
    // The linking claim-history pass (`{ kind, externalUserId, userId: null }`).
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
  ];

  for (const spec of specs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await spec.collection.createIndexAsync(spec.keys, spec.options ?? {});
    } catch (e: any) {
      console.warn(
        `[10thfloor:agent] could not create the ${spec.name} index `
        + `${JSON.stringify(spec.keys)}; the package still works, its queries are just `
        + `unindexed (grant createIndex, or create it yourself): ${e?.message ?? e}`,
      );
    }
  }
}
