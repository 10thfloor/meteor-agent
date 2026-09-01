import { Mongo } from 'meteor/mongo';
import { NAMES } from '../../common/names';
import type { Fields, TypedCollection } from '../../common/db';
import type { ReceiptExpectation } from '../../common/channel-contract';

// Re-exported so receipt consumers (egress, ingress, tests) keep one import site;
// the SHAPE is the contract's — it is exactly what `expectationsFor` produces.
export type { ReceiptExpectation };

/** Channel subsystem collections. Server-only, typed via the Fields<T> facade. */

// ---- Identities (§6.1) — who is this person --------------------------------

/** External identity linked to an app account. Derived `_id` gives PK lookup
 *  on inbound and single-winner collision on racing inserts. One user may hold
 *  many rows (Slack, SMS, email) for cross-surface recognition. */
export interface ChannelIdentity {
  _id: string;                    // `${kind}:${externalUserId}`
  kind: string;
  externalUserId: string;
  userId: string;
  /** How the link was proven. `'none'` never appears — unlinked senders
   *  have no row. */
  assurance: 'link' | 'oidc';
  linkedAt: Date;
}

// ---- Bindings (§6.2) — which conversation maps to which session ------------

/** External conversation bound to an agent session. Derived `_id` gives
 *  single-winner collision; binding is inserted before the session. One session
 *  may hold many bindings so each surface delivers independently. */
export interface ChannelBinding {
  _id: string;                    // `${kind}:${conversationRef}`
  kind: string;
  conversationRef: string;
  /** Transport-opaque reply address (Slack channel+thread, E.164 pair, etc). */
  destination: unknown;
  /** `'direct'` = one recipient; `'group'` = visible to others. §8.5 uses
   *  this to restrict capability URLs to direct destinations. */
  audience: 'direct' | 'group';
  agent: string;
  sessionId: string;
  userId: string | null;
  /** Opener's identity-proof strength at bind time. Repair-on-entry uses it
   *  to stamp the owner's assurance, not the current sender's. */
  assurance?: 'none' | 'link' | 'oidc';
  /** Which external identity opened this conversation — needed so
   *  `linkIdentity` can find anonymous bindings by person, not just thread. */
  externalUserId?: string;
  /** Who this conversation admits beyond its owner (participants decision 11).
   *  `'opener'`: owner/recorded opener only. `'members'`: roster participants.
   *  `'linked'`: any linked sender, auto-joined. Gates ingress, not DDP. */
  admits?: 'opener' | 'members' | 'linked';
  /** Member binding (decision 14): reaches a non-owner participant. Receives
   *  replies and overflow only — no prompts, no capability URLs. */
  member?: true;
  /** The roster participant a `member: true` binding reaches — teardown's
   *  key: removing the participant deletes their bindings. */
  participant?: string;
  /** Random, transport-independent origin token stamped on inbound Messages.
   *  It is safe to publish with source attribution: unlike `_id` and
   *  `conversationRef`, it contains no provider address or conversation key. */
  sourceKey?: string;
  /** Egress high-water mark for this surface. Advanced only by the guarded
   *  write in `advanceCursor`; deferred rows leave it unchanged. */
  deliveredSeq: number;
  /** Delivering worker's per-binding lease (`claimLease`-shaped). */
  claim?: { serverId: string; until: Date } | null;
  /** @internal Session lifecycle fence; workers refuse a new delivery claim. */
  erasingAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Delivery receipts (§6.3) — what has actually been sent ----------------


/** Receipt key, spelled once: egress writes it, ingress reads it back to find
 *  the parked ask's grammar. */
export const receiptIdFor = (bindingId: string, suffix: string): string => `deliver:${bindingId}:${suffix}`;
/** Suffix for a delivered prompt: one receipt per ask. */
export const promptSuffix = (toolCallId: string): string => `prompt:${toolCallId}`;

/** Receipt-backed delivery log: sending → sent. Derived `_id` is
 *  per-binding so fan-out produces one receipt per surface. */
export interface DeliveryReceipt {
  _id: string;                    // `deliver:${bindingId}:${suffix}`
  bindingId: string;
  /** Owning Session. Legacy rows may lack this in storage and are removed via
   *  the binding fallback during lifecycle erasure. */
  sessionId: string;
  state: 'sending' | 'sent' | 'abandoned';
  providerMessageId?: string;
  /** Reply grammar registered by a prompt delivery. Ingress checks it for
   *  the currently parked ask before falling through to "this is a message". */
  expects?: ReceiptExpectation[];
  attempts: number;
  at: Date;
}

// ---- Inbound admissions (§11) — deduplicated during retention -------------

/** Admitted provider event. Derived `_id` from the provider's redelivery-stable
 *  id so retries collide on the PK. Rows expire by TTL index. */
export interface InboundSubmission {
  _id: string;                    // `${kind}:${eventId}`
  at: Date;
}

// ---- Link tokens (§12) — the one-time capability that proves a link --------

/** Single-use token binding an external identity to a pending link. Redeemed
 *  via `findOneAndDelete` from the authenticated side — DB-backed random token,
 *  so single-use enforcement falls out of the delete with no key management. */
export interface ChannelLinkToken {
  _id: string;                    // Random.secret()
  kind: string;
  externalUserId: string;
  expiresAt: Date;
  createdAt: Date;
}

/** Single-use URL token for a `link`-interact approval (§8.4). Same primitive
 *  as `ChannelLinkToken` but bound to a pending verdict, not an identity —
 *  separate table so the two can never be interchanged. */
export interface ChannelVerdictToken {
  _id: string;                    // Random.secret()
  agent: string;
  sessionId: string;
  /** The ask this token answers -- checked against the currently parked call. */
  toolCallId: string;
  verdict: 'approved' | 'denied';
  expiresAt: Date;
  createdAt: Date;
  /** Short redemption lease. A transient failure releases it; a crashed
   * redeemer can be superseded after `until`. */
  claim?: { id: string; until: Date };
}

// ---- Facade types ----------------------------------------------------------

// Combinators inline per type: `Fields<T> & LogicalOps<Q>` is eagerly circular
// (TS 2456); a self-reference inside an object-literal property is deferred.

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

/** True when the error is a duplicate-key, however the driver phrases it:
 *  code 11000/11001, codeName, or either message form. Load-bearing wherever
 *  a derived-`_id` insert treats "lost the race" as adoption — a phrasing
 *  this misses turns an idempotent replay into a thrown error. */
export function isDuplicateKey(e: unknown): boolean {
  const err = e as { code?: number; codeName?: string; message?: string } | null;
  if (err?.code === 11000 || err?.code === 11001) return true;
  if (err?.codeName === 'DuplicateKey') return true;
  const msg = String(err?.message ?? '');
  return msg.includes('E11000') || /duplicate key/i.test(msg);
}

/** Insert a derived-`_id` row: `true` = inserted (won), `false` = duplicate
 *  key (adopt theirs). Real failures propagate. */
export async function insertOrLose<T extends { _id: string }>(
  coll: Pick<Mongo.Collection<T>, 'insertAsync'>, doc: Mongo.OptionalId<T>,
): Promise<boolean> {
  try {
    await coll.insertAsync(doc);
    return true;
  } catch (e) {
    if (isDuplicateKey(e)) return false;
    throw e;
  }
}
