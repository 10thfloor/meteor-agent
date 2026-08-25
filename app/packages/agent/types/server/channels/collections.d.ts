import { Mongo } from 'meteor/mongo';
import type { Fields, TypedCollection } from '../../common/db';
import type { ReceiptExpectation } from '../../common/channel-contract';
export type { ReceiptExpectation };
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
    _id: string;
    kind: string;
    externalUserId: string;
    userId: string;
    /** How the link was proven — see `AgentSession.channel.assurance`. An
     *  identity row always names a real account, so `'none'` never appears here:
     *  unlinked senders simply have no row. */
    assurance: 'link' | 'oidc';
    linkedAt: Date;
}
/**
 * One external CONVERSATION bound to one agent session. `_id` is DERIVED —
 * `${kind}:${conversationRef}` — the same single-winner technique as the
 * watcher's orphan-child note: two servers racing to bind the same thread
 * collide on the primary key, and the loser adopts the winner's binding
 * having created nothing (the binding is inserted BEFORE the session — see
 * `findOrCreateBinding`/`bindConversation` in ingress.ts).
 *
 * ONE SESSION MAY HOLD MANY BINDINGS — that is the point of splitting identity
 * from routing. A session reachable from Slack and SMS has two rows, each with
 * its own `deliveredSeq` cursor and its own `claim`, so each surface delivers
 * independently and at its own pace.
 */
export interface ChannelBinding {
    _id: string;
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
    /** The OPENER's identity-proof strength at bind time (`'none'` when
     *  unlinked). Recorded so repair-on-entry stamps a recreated session with
     *  the owner's assurance rather than the current sender's — in a group the
     *  two can differ. Absent on bindings created before this field existed
     *  (read as `'none'`). */
    assurance?: 'none' | 'link' | 'oidc';
    /** WHICH external identity opened this conversation — recorded at bind time
     *  so `linkIdentity`'s claim-history pass can find the anonymous bindings a
     *  newly-linked person created (`conversationRef` alone cannot: on Slack it
     *  names a thread, not a person). Absent when the first event carried no
     *  sender. */
    externalUserId?: string;
    /**
     * WHO this conversation admits beyond its owner (participants spec decision
     * 11). `'opener'` (the default, absent included) is v1's guard verbatim:
     * the owner, or — while anonymous — the recorded opener, and nobody else.
     * `'members'` additionally admits senders whose identity (or resolved
     * account) matches a roster participant. `'linked'` admits any sender with
     * a LINKED identity, auto-joining them as a member on first message (the
     * group-thread acquisition path, capped by the roster). The binding gates
     * INGRESS; the roster gates DDP — an 'opener' binding refuses a roster
     * member who is not the opener.
     */
    admits?: 'opener' | 'members' | 'linked';
    /**
     * A MEMBER binding (participants spec decision 14): a conversation that
     * reaches one non-owner participant — compose's pre-bound recipient is the
     * canonical case. Member bindings receive outward replies and overflow
     * ONLY: never prompt items, never status notes, never a capability URL —
     * and the claim-history sweep skips them, so a recipient who later links
     * can never be handed the composing session's ownership.
     */
    member?: true;
    /** The roster participant a `member: true` binding reaches — teardown's
     *  key: removing the participant deletes their bindings. */
    participant?: string;
    /** The egress high-water mark: everything at or below this seq has been
     *  HANDLED for THIS surface — posted and receipted, abandoned (the channel's
     *  declared §11 recovery tier or `MAX_DELIVERY_ATTEMPTS`), or planned as
     *  advance-past. Advanced only by the guarded conditional write in egress.ts
     *  (`advanceCursor`); a deferred row leaves it where it is. */
    deliveredSeq: number;
    /** The delivering worker's per-binding lease, `claimLease`-shaped — all four
     *  `$or` branches including "already ours", because a delivering worker is a
     *  renewing owner, not a discoverer (the opposite of the watcher's
     *  `noLiveLease`). */
    claim?: {
        serverId: string;
        until: Date;
    } | null;
    createdAt: Date;
    updatedAt: Date;
}
/** The receipt key, spelled ONCE: `deliver:<bindingId>:<suffix>`. Egress writes
 *  it; ingress reads it back to find the registered grammar of the currently
 *  parked ask — a cross-module coupling that must not be held together by two
 *  string literals agreeing. */
export declare const receiptIdFor: (bindingId: string, suffix: string) => string;
/** The suffix a delivered PROMPT uses: one receipt per ask, so a re-park of a
 *  different call is a new receipt and a re-sweep of the same one is settled. */
export declare const promptSuffix: (toolCallId: string) => string;
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
    _id: string;
    bindingId: string;
    state: 'sending' | 'sent' | 'abandoned';
    providerMessageId?: string;
    /** Present only on prompt deliveries: the reply grammar this delivery
     *  registered. The inbound side consults the receipt for the currently
     *  parked ask (`prompt:<toolCallId>`) before falling through to "this is a
     *  message". */
    expects?: ReceiptExpectation[];
    attempts: number;
    at: Date;
}
/**
 * One admitted provider event. `_id` is `${kind}:${eventId}` where `eventId`
 * is the provider's REDELIVERY-STABLE id (Slack `event_id`, Twilio
 * `MessageSid`, an email `Message-ID`), so a provider retry collides on the
 * primary key and is answered 200 without running a second turn. Rows expire
 * by TTL index (indexes.ts) — providers stop retrying long before it fires.
 */
export interface InboundSubmission {
    _id: string;
    at: Date;
}
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
    _id: string;
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
    _id: string;
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
export type IdentityQuery = Fields<ChannelIdentity> & {
    $or?: IdentityQuery[];
    $and?: IdentityQuery[];
    $nor?: IdentityQuery[];
};
export interface IdentityModifier {
    $set?: {
        [K in keyof ChannelIdentity]?: ChannelIdentity[K];
    };
    $unset?: {
        [K in keyof ChannelIdentity]?: 1 | true;
    };
}
export type BindingQuery = Fields<ChannelBinding> & {
    [k: `claim.${string}`]: unknown;
} & {
    $or?: BindingQuery[];
    $and?: BindingQuery[];
    $nor?: BindingQuery[];
};
export interface BindingModifier {
    $set?: {
        [K in keyof ChannelBinding]?: ChannelBinding[K];
    } & {
        [k: `claim.${string}`]: unknown;
    };
    $unset?: {
        [K in keyof ChannelBinding]?: 1 | true;
    } & {
        [k: `claim.${string}`]: 1 | true;
    };
}
export type ReceiptQuery = Fields<DeliveryReceipt> & {
    $or?: ReceiptQuery[];
    $and?: ReceiptQuery[];
    $nor?: ReceiptQuery[];
};
export interface ReceiptModifier {
    $set?: {
        [K in keyof DeliveryReceipt]?: DeliveryReceipt[K];
    };
    $unset?: {
        [K in keyof DeliveryReceipt]?: 1 | true;
    };
    $inc?: {
        attempts?: number;
    };
}
export type SubmissionQuery = Fields<InboundSubmission> & {
    $or?: SubmissionQuery[];
    $and?: SubmissionQuery[];
    $nor?: SubmissionQuery[];
};
export type LinkTokenQuery = Fields<ChannelLinkToken> & {
    $or?: LinkTokenQuery[];
    $and?: LinkTokenQuery[];
    $nor?: LinkTokenQuery[];
};
export type VerdictTokenQuery = Fields<ChannelVerdictToken> & {
    $or?: VerdictTokenQuery[];
    $and?: VerdictTokenQuery[];
    $nor?: VerdictTokenQuery[];
};
export declare const ChannelIdentities: TypedCollection<ChannelIdentity, string | IdentityQuery, IdentityModifier>;
export declare const ChannelBindings: TypedCollection<ChannelBinding, string | BindingQuery, BindingModifier>;
export declare const DeliveryReceipts: TypedCollection<DeliveryReceipt, string | ReceiptQuery, ReceiptModifier>;
export declare const InboundSubmissions: TypedCollection<InboundSubmission, string | SubmissionQuery, never>;
export declare const ChannelLinkTokens: TypedCollection<ChannelLinkToken, string | LinkTokenQuery, never>;
export declare const ChannelVerdictTokens: TypedCollection<ChannelVerdictToken, string | VerdictTokenQuery, never>;
/** Swallow-a-duplicate-key helper, the watcher's own idiom (`relinkOrphanChildren`):
 *  11000 on a DERIVED `_id` is the race's loser learning it lost, matched on the
 *  message too because what wraps a driver error on the way through Meteor's
 *  collection layer is not this module's to assume. */
export declare function isDuplicateKey(e: unknown): boolean;
/** Insert a row whose `_id` is DERIVED, and report which side of the race this
 *  caller is on: `true` — inserted, we won; `false` — duplicate key, someone
 *  else did, adopt theirs. Anything else is a real failure and propagates. The
 *  idiom behind every single-winner insert in the subsystem (binding, session
 *  repair, admission claim, receipt reserve, identity row), so each site reads
 *  as the decision it makes rather than as a try/catch. */
export declare function insertOrLose<T extends {
    _id: string;
}>(coll: Pick<Mongo.Collection<T>, 'insertAsync'>, doc: Mongo.OptionalId<T>): Promise<boolean>;
//# sourceMappingURL=collections.d.ts.map