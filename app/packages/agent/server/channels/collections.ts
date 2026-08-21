import { Mongo } from 'meteor/mongo';
import { NAMES } from '../../common/names';
import type { Cond, Fields, TypedCollection } from '../../common/db';

/**
 * The channel subsystem's collections (channels spec §6): identity, routing,
 * delivery, admission, and linking. SERVER-DECLARED, deliberately — no client
 * ever subscribes to these (routing state and delivery bookkeeping are the
 * worker's business, not a UI's), so they have no client stub at all. They are
 * still denied client writes in `server/index.ts` alongside the original
 * three: a DDP client can invoke a collection's low-level mutation methods by
 * NAME without a stub, so "server-declared" alone is not the lockout.
 *
 * Typed through the same facade idiom as `common/db.ts` — the mapped
 * `Fields<T>` core plus template-literal signatures for exactly the dotted
 * paths the subsystem queries — so a field-name typo in a claim or a cursor
 * guard is a compile error, not a silently dead conditional write.
 */

// ---- Identities (§6.1) — who is this person --------------------------------

/**
 * One EXTERNAL identity linked to one app account. `_id` is DERIVED —
 * `${kind}:${externalUserId}` — so the reverse lookup on every inbound message
 * is a primary-key read, and two servers racing to link the same identity
 * collide on the insert (one wins, the loser adopts).
 *
 * One app user may hold many rows — Slack, SMS and email all pointing at the
 * same `userId` — which is what makes an agent recognize a person across
 * surfaces. No row means the sender is unlinked and gets an anonymous session.
 */
export interface ChannelIdentity {
  _id: string;                    // `${kind}:${externalUserId}`
  kind: string;
  externalUserId: string;
  userId: string;
  /** How the link was proven — see `AgentSession.channel.assurance`. An
   *  identity row always names a real account, so `'none'` never appears here:
   *  unlinked senders simply have no row. */
  assurance: 'link' | 'oidc';
  linkedAt: Date;
}

// ---- Bindings (§6.2) — which conversation maps to which session ------------

/**
 * One external CONVERSATION bound to one agent session. `_id` is DERIVED —
 * `${kind}:${conversationRef}` — the same single-winner technique as the
 * watcher's orphan-child note: two servers racing to bind the same thread
 * collide on the primary key, and the loser adopts the winner's binding
 * having created nothing (the binding is inserted BEFORE the session — see
 * `upsertBinding` in ingress.ts).
 *
 * ONE SESSION MAY HOLD MANY BINDINGS — that is the point of splitting identity
 * from routing. A session reachable from Slack and SMS has two rows, each with
 * its own `deliveredSeq` cursor and its own `claim`, so each surface delivers
 * independently and at its own pace.
 */
export interface ChannelBinding {
  _id: string;                    // `${kind}:${conversationRef}`
  kind: string;
  conversationRef: string;
  /** Where replies go — the transport's addressing, opaque to the core
   *  (a Slack channel+thread, an E.164 pair, an email address + thread ids). */
  destination: unknown;
  /** `'direct'` = exactly one recipient (a DM, a phone number, a mailbox);
   *  `'group'` = anyone else can see it. Set at bind time; §8.5's rule — an
   *  anonymous session's capability URL may only be sent to a `direct`
   *  destination — reads it. */
  audience: 'direct' | 'group';
  agent: string;
  sessionId: string;
  userId: string | null;
  /** WHICH external identity opened this conversation — recorded at bind time
   *  so `linkIdentity`'s claim-history pass can find the anonymous bindings a
   *  newly-linked person created (`conversationRef` alone cannot: on Slack it
   *  names a thread, not a person). Absent when the first event carried no
   *  sender. */
  externalUserId?: string;
  /** The egress high-water mark: everything at or below this seq has been
   *  handled for THIS surface. Advanced only by the guarded conditional write
   *  in egress.ts, only after a confirmed post. */
  deliveredSeq: number;
  /** The delivering worker's per-binding lease, `claimLease`-shaped — all four
   *  `$or` branches including "already ours", because a delivering worker is a
   *  renewing owner, not a discoverer (the opposite of the watcher's
   *  `noLiveLease`). */
  claim?: { serverId: string; until: Date } | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Delivery receipts (§6.3) — what has actually been sent ----------------

/** One choice a delivered prompt offered, and the exact ask it answers.
 *  `match` is the reply token the surface's grammar registered (a keyword, a
 *  postback value); `toolCallId` names the parked call, so a stale YES aimed at
 *  last week's ask can never decide today's different one (§8.3). */
export interface ReceiptExpectation {
  match: string;
  verdict: 'approved' | 'denied';
  toolCallId: string;
}

/**
 * The three-phase intent log that makes outbound delivery EFFECTIVELY-once
 * (§11): reserve (`sending`) → post → confirm (`sent`). A crash between post
 * and confirm leaves the one genuinely ambiguous state, and recovery follows
 * the channel's declared `onUncertainDelivery` tier.
 *
 * `_id` is DERIVED from the BINDING and the message — `deliver:<bindingId>:<msgId>`
 * — never the message alone: with fan-out, the same reply going to Slack and
 * SMS is two deliveries and needs two receipts. `providerMessageId` doubles as
 * the durable correspondence between our rows and the surface's — the table
 * production chat bridges are missing when they misattach reactions and edits.
 */
export interface DeliveryReceipt {
  _id: string;                    // `deliver:${bindingId}:${suffix}`
  bindingId: string;
  state: 'sending' | 'sent' | 'abandoned';
  providerMessageId?: string;
  /** Present only on prompt deliveries: the reply grammar this delivery
   *  registered. The inbound side consults the binding's latest outstanding
   *  one before falling through to "this is a message". */
  expects?: ReceiptExpectation[];
  attempts: number;
  at: Date;
}

// ---- Inbound admissions (§11) — exactly-once on the way in -----------------

/**
 * One admitted provider event. `_id` is `${kind}:${eventId}` where `eventId`
 * is the provider's REDELIVERY-STABLE id (Slack `event_id`, Twilio
 * `MessageSid`, an email `Message-ID`), so a provider retry collides on the
 * primary key and is answered 200 without running a second turn. Rows expire
 * by TTL index (indexes.ts) — providers stop retrying long before it fires.
 */
export interface InboundSubmission {
  _id: string;                    // `${kind}:${eventId}`
  at: Date;
}

// ---- Link tokens (§12) — the one-time capability that proves a link --------

/**
 * A single-use, short-lived token binding ONE external identity to a pending
 * link. Redemption is a `findOneAndDelete` — atomic, so of two racing redeems
 * exactly one wins — completed from the AUTHENTICATED side: the signed-in web
 * user presents the token, never the unauthenticated inbound message.
 *
 * A DB-backed random token rather than a signed one: same properties
 * (unguessable, single-use, expiring, bound to its subject) with no key
 * management, and single-use enforcement falls out of the delete.
 */
export interface ChannelLinkToken {
  _id: string;                    // Random.secret()
  kind: string;
  externalUserId: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The `link`-interact approval capability (§8.4): one choice of one delivered
 * prompt as a single-use URL token. The SAME primitive as `ChannelLinkToken`
 * with a DIFFERENT subject — a linking token is bound to an external identity,
 * a verdict token to one pending verdict — and they live in separate tables
 * precisely so they can never be presented for each other (§8.4: "never
 * interchangeable").
 */
export interface ChannelVerdictToken {
  _id: string;                    // Random.secret()
  agent: string;
  sessionId: string;
  /** The exact ask this token answers — redemption checks it against the
   *  CURRENTLY parked call, the same staleness rule the receipt's `expects`
   *  carries (§8.3). */
  toolCallId: string;
  verdict: 'approved' | 'denied';
  expiresAt: Date;
  createdAt: Date;
}

// ---- Facade types ----------------------------------------------------------

// The `$or`/`$and`/`$nor` combinators are written inline per type rather than
// through a shared generic: `type Q = Fields<T> & LogicalOps<Q>` is an eagerly
// circular alias TypeScript rejects (2456), while a self-reference inside an
// object-literal property position is deferred and legal — the exact shape
// `common/db.ts` uses for `SessionQuery`.

export type IdentityQuery =
  & Fields<ChannelIdentity>
  & { $or?: IdentityQuery[]; $and?: IdentityQuery[]; $nor?: IdentityQuery[] };
export interface IdentityModifier {
  $set?: { [K in keyof ChannelIdentity]?: ChannelIdentity[K] };
  $unset?: { [K in keyof ChannelIdentity]?: 1 | true };
}

export type BindingQuery =
  & Fields<ChannelBinding>
  & { [k: `claim.${string}`]: unknown }
  & { $or?: BindingQuery[]; $and?: BindingQuery[]; $nor?: BindingQuery[] };
export interface BindingModifier {
  $set?:
    & { [K in keyof ChannelBinding]?: ChannelBinding[K] }
    & { [k: `claim.${string}`]: unknown };
  $unset?:
    & { [K in keyof ChannelBinding]?: 1 | true }
    & { [k: `claim.${string}`]: 1 | true };
}

export type ReceiptQuery =
  & Fields<DeliveryReceipt>
  & { $or?: ReceiptQuery[]; $and?: ReceiptQuery[]; $nor?: ReceiptQuery[] };
export interface ReceiptModifier {
  $set?: { [K in keyof DeliveryReceipt]?: DeliveryReceipt[K] };
  $unset?: { [K in keyof DeliveryReceipt]?: 1 | true };
  $inc?: { attempts?: number };
}

export type SubmissionQuery =
  & Fields<InboundSubmission>
  & { $or?: SubmissionQuery[]; $and?: SubmissionQuery[]; $nor?: SubmissionQuery[] };
export type LinkTokenQuery =
  & Fields<ChannelLinkToken>
  & { $or?: LinkTokenQuery[]; $and?: LinkTokenQuery[]; $nor?: LinkTokenQuery[] };
export type VerdictTokenQuery =
  & Fields<ChannelVerdictToken>
  & { $or?: VerdictTokenQuery[]; $and?: VerdictTokenQuery[]; $nor?: VerdictTokenQuery[] };

// `Cond` is re-exported by db.ts for exactly this kind of consumer; referencing
// it keeps the import list honest about what the facade types are built from.
export type { Cond };

// ---- The collections -------------------------------------------------------

export const ChannelIdentities =
  new Mongo.Collection<ChannelIdentity>(NAMES.channelIdentities) as unknown as
    TypedCollection<ChannelIdentity, string | IdentityQuery, IdentityModifier>;
export const ChannelBindings =
  new Mongo.Collection<ChannelBinding>(NAMES.channelBindings) as unknown as
    TypedCollection<ChannelBinding, string | BindingQuery, BindingModifier>;
export const DeliveryReceipts =
  new Mongo.Collection<DeliveryReceipt>(NAMES.deliveryReceipts) as unknown as
    TypedCollection<DeliveryReceipt, string | ReceiptQuery, ReceiptModifier>;
export const InboundSubmissions =
  new Mongo.Collection<InboundSubmission>(NAMES.inboundSubmissions) as unknown as
    TypedCollection<InboundSubmission, string | SubmissionQuery, never>;
export const ChannelLinkTokens =
  new Mongo.Collection<ChannelLinkToken>(NAMES.channelLinkTokens) as unknown as
    TypedCollection<ChannelLinkToken, string | LinkTokenQuery, never>;
export const ChannelVerdictTokens =
  new Mongo.Collection<ChannelVerdictToken>(NAMES.channelVerdictTokens) as unknown as
    TypedCollection<ChannelVerdictToken, string | VerdictTokenQuery, never>;

/** Swallow-a-duplicate-key helper, the watcher's own idiom (`relinkOrphanChildren`):
 *  11000 on a DERIVED `_id` is the race's loser learning it lost, matched on the
 *  message too because what wraps a driver error on the way through Meteor's
 *  collection layer is not this module's to assume. */
export function isDuplicateKey(e: unknown): boolean {
  const err = e as { code?: number; message?: string } | null;
  return err?.code === 11000 || /duplicate key/i.test(String(err?.message ?? ''));
}
