import { type ChannelBinding, type ReceiptExpectation } from './collections';
import { type ChannelDef } from './registry';
import { type DeliveryItem } from '../../common/channel-contract';
/**
 * The egress worker (channels spec §6.4/§11) — `startWatcher` with the
 * collection swapped, deliberately: one worker per channel kind per process,
 * an observer for latency plus a timed sweep for everything no write signals,
 * `{ stop() }` returned, all state in closure vars.
 *
 * ONE worker, query-sliced — never an observer per conversation. A browser
 * tab's subscription dies with the tab; a Slack thread never disconnects, so
 * per-conversation observers accumulate forever. The observer here watches
 * committed MESSAGES (insert-only, so `added` is the whole story and the
 * session document's `nextSeq`/`usage` churn never wakes it) and the sweep
 * walks the kind's bindings.
 *
 * Every multi-server race resolves through an atomic conditional write — the
 * claim (all four `claimLease` branches, INCLUDING "already ours", because a
 * delivering worker is a renewing owner, not the watcher's discoverer), the
 * cursor advance (guarded on claim AND expected value), and the receipt's
 * derived `_id`. No Redis, no leader election.
 */
export interface EgressOptions {
    /** How often the sweep runs. Default 15s; tests lower it. */
    sweepMs?: number;
    /** How long a delivery claim lasts. Renewed per row; default 30s. */
    claimMs?: number;
    /**
     * How far back the sweep looks: only bindings active (any inbound event,
     * any delivery) within this window are walked. Default 24h. This is what
     * keeps a process's per-sweep cost proportional to LIVE conversations
     * rather than to every conversation ever bound — without it a single
     * workspace member could mint thousands of thread bindings that every
     * instance would then re-read every 15 seconds, forever. Fresh rows on an
     * older binding still deliver promptly: the observer fires per committed
     * message regardless of age, and its delivery bumps the binding back into
     * the window.
     */
    sweepLookbackMs?: number;
}
/** Retry policy for a receipt found mid-`sending` (§11 `retry` tier): doubling
 *  from one sweep interval, capped at an hour, and given up after
 *  `MAX_DELIVERY_ATTEMPTS`. Without it a payload the provider rejects
 *  DETERMINISTICALLY (a cut surrogate pair, a closed WhatsApp window) would be
 *  re-posted every sweep forever and wedge the conversation behind it. */
export declare const BACKOFF_BASE_MS = 15000;
export declare const BACKOFF_MAX_MS: number;
export declare const MAX_DELIVERY_ATTEMPTS = 48;
export interface EgressWorker {
    stop(): Promise<void>;
}
/** The per-binding claim — `claimLease`'s idiom on the binding row. Win iff
 *  n === 1; of N racers exactly one matches. */
export declare function claimBinding(bindingId: string, claimMs: number, serverId?: string): Promise<boolean>;
/** The cursor advance — guarded on BOTH the claim and the expected `fromSeq`,
 *  the `writeVerdict` single-winner shape: a stale worker's late write matches
 *  nothing and no-ops. Advanced only after the row is HANDLED (posted and
 *  receipted, or planned as advance-past). */
export declare function advanceCursor(bindingId: string, fromSeq: number, toSeq: number, serverId?: string): Promise<boolean>;
/**
 * The three-phase intent log (§11): reserve → post → confirm, keyed on a
 * DERIVED receipt id (`deliver:<bindingId>:<suffix>`), so "the surface shows
 * it once" holds across servers and across the observer's whole-backlog replay
 * on every boot.
 *
 * Returns `'delivered'` when the item is durably `sent` (whether by this call
 * or a previous one), `'abandoned'` when the channel's declared recovery or
 * the attempt cap gave it up, and `'deferred'` when a prior `sending` receipt
 * is still inside its backoff window — nothing was posted; a cursor-driven
 * caller stops and the next sweep retries, a one-shot caller (ingress, a tool
 * body) should treat it as not sent. Throws when the transport fails — the
 * caller stops and the next sweep retries under the same receipt.
 *
 * `item` may be a thunk; it runs only when a post actually happens. The
 * channel is the binding's own `kind` — a binding can only ever be delivered
 * through the surface that created it, so the caller names nothing twice.
 *
 * EXPORTED for tool bodies (§7's `channel.notify` shape): tool dispatch
 * re-runs on crash recovery — the package's own dispatch comment calls that
 * window "irreducible without idempotency keys carried through to the tools
 * themselves" — and this, keyed on the tool call's id, is that idempotency
 * key carried through.
 *
 * The binding parameter is a PICK on purpose (email v2 spec §9): exactly the
 * three fields the log reads — `_id` (the receipt key), `kind` (the def
 * lookup), `destination`. A proactive tool (compose) passes a SYNTHETIC
 * binding — `{ _id: 'compose:email:<toolCallId>', kind, destination }` — and
 * gets the full three-phase log with no new machinery; `opts.def` supplies
 * the transport/lens directly so the tool works with no channel registered.
 */
/** What `deliverOnce` reads from a binding — a real row satisfies it; a
 *  synthetic one is these three fields and nothing more. */
export type DeliverableBinding = Pick<ChannelBinding, '_id' | 'kind' | 'destination'>;
export declare function deliverOnce(binding: DeliverableBinding, item: DeliveryItem | (() => Promise<DeliveryItem>), suffix: string, opts?: {
    expects?: ReceiptExpectation[];
    /** The transport/lens/tier to deliver through, when the caller holds them
     *  directly (compose). Default: the registry's def for `binding.kind`. */
    def?: Pick<ChannelDef, 'transport' | 'lens' | 'onUncertainDelivery'>;
}): Promise<'delivered' | 'abandoned' | 'deferred'>;
/**
 * Deliver one binding's backlog: claim it, walk the transcript past the
 * cursor, post what the planner says to post, advance past the rest, then
 * offer the parked prompt (receipt-guarded — a prompt is session state, not a
 * seq row, so it advances no cursor and re-delivers only when a NEW ask
 * parks).
 */
export declare function deliverBinding(kind: string, bindingId: string, opts?: EgressOptions): Promise<void>;
export declare function startEgress(kind: string, opts?: EgressOptions): EgressWorker;
//# sourceMappingURL=egress.d.ts.map