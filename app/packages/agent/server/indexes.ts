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
import {
  MESSAGE_RESERVATIONS_NAME, UserMessageReservations,
} from './transcript';

/* Startup indexes for this package's queries. Idempotent and non-fatal:
 * a failure warns and moves on — the queries work unindexed, just slower. */
export async function ensureIndexes(): Promise<void> {
  // The one package setting the store reads: how long attachment bytes live.
  const retentionDays = Number(
    (Meteor.settings as any)?.packages?.['10thfloor:agent']?.attachments?.retentionDays ?? 0,
  ) || 0;
  const specs: Array<{
    collection: Pick<Mongo.Collection<any>, 'createIndexAsync'>;
    name: string;
    // `'text'` for the memory search ladder's middle rung.
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
    // System-intent sweep (CASE 6). partialFilter so only sessions with
    // a pending system intent are indexed.
    {
      collection: AgentSessions,
      name: NAMES.sessions,
      keys: { 'pendingSystem.at': 1 },
      options: { partialFilterExpression: { pendingSystem: { $exists: true } } },
    },
    // Human-input activation recovery. The marker closes the crash window
    // between committing a Message and queuing its Turn.
    {
      collection: AgentSessions,
      name: NAMES.sessions,
      keys: { 'pendingInput.at': 1 },
      options: { partialFilterExpression: { pendingInput: { $exists: true } } },
    },
    {
      collection: AgentSessions,
      name: NAMES.sessions,
      keys: { 'pendingInputs.at': 1 },
      options: { partialFilterExpression: { pendingInputs: { $exists: true } } },
    },
    {
      collection: UserMessageReservations,
      name: MESSAGE_RESERVATIONS_NAME,
      keys: { sessionId: 1, createdAt: 1 },
    },
    {
      collection: UserMessageReservations,
      name: MESSAGE_RESERVATIONS_NAME,
      keys: { createdAt: 1, _id: 1 },
    },
    // Membership lookups (§4.2): multikey on participants.userId.
    {
      collection: AgentSessions,
      name: NAMES.sessions,
      keys: { 'participants.userId': 1 },
      options: { sparse: true },
    },
    // ---- Channels ----
    // Fan-out: session → bindings.
    {
      collection: ChannelBindings,
      name: NAMES.channelBindings,
      keys: { sessionId: 1 },
    },
    // Linking claim-history pass.
    {
      collection: ChannelBindings,
      name: NAMES.channelBindings,
      keys: { kind: 1, externalUserId: 1 },
      options: { sparse: true },
    },
    // Egress sweep's lookback slice.
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
    {
      collection: DeliveryReceipts,
      name: NAMES.deliveryReceipts,
      keys: { sessionId: 1 },
    },
    // TTL reapers. Admissions: 7 days (replay horizon). Tokens: janitor
    // only — redemption checks expiresAt itself for millisecond precision.
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
    // Download tokens: TTL janitor only.
    {
      collection: AttachmentDownloadTokens,
      name: NAMES.attachmentTokens,
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 },
    },
    // ---- Attachments ----
    // Staged-set scans and hydration reads.
    {
      collection: AgentAttachments,
      name: NAMES.attachments,
      keys: { sessionId: 1 },
    },
    // Retention TTL. Changing retentionDays needs the old index dropped by hand.
    ...(retentionDays > 0 ? [{
      collection: AgentAttachments,
      name: NAMES.attachments,
      keys: { createdAt: 1 } as Record<string, 1 | -1>,
      options: { expireAfterSeconds: Math.round(retentionDays * 24 * 60 * 60) },
    }] : []),
    // ---- Memory ----
    // Person/agent rows: standing block + cap count.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { userId: 1, scope: 1, at: -1 },
    },
    // App pool: no userId, so needs its own index.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { scope: 1, at: -1 },
    },
    // Text index — search ladder's middle rung. Degrades to regex if refused.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { text: 'text' },
    },
    // Keyed-upsert unique index — closes the check-then-insert race.
    {
      collection: AgentMemories,
      name: NAMES.memories,
      keys: { scope: 1, userId: 1, agent: 1, key: 1 },
      options: {
        unique: true,
        partialFilterExpression: { key: { $exists: true } },
      },
    },
    // Opt-in decay.
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
      const errorKind = typeof e?.codeName === 'string'
        ? e.codeName
        : (typeof e?.name === 'string' ? e.name : 'Error');
      // Unique index failure is not just a perf issue — the race stays open.
      if (spec.options?.unique) {
        console.warn(
          `[10thfloor:agent] could not create the UNIQUE ${spec.name} index `
          + `${JSON.stringify(spec.keys)} — keyed memory saves are NOT race-safe until `
          + 'this builds. The usual cause is duplicate rows already present: remove the '
          + 'duplicate `key` rows for a given (scope, userId, agent) and restart. '
          + `Error kind: ${errorKind}`,
        );
      } else {
        console.warn(
          `[10thfloor:agent] could not create the ${spec.name} index `
          + `${JSON.stringify(spec.keys)}; the package still works, its queries are just `
          + `unindexed (grant createIndex, or create it yourself). Error kind: ${errorKind}`,
        );
      }
    }
  }
}
