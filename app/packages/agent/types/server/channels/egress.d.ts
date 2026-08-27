import type { ClientSession } from 'mongodb';
import { type ChannelBinding, type ReceiptExpectation } from './collections';
import { type ChannelDef } from './registry';
import { type DeliveryItem } from '../../common/channel-contract';
/** Egress worker: one per channel kind, observer + timed sweep.
 *  All multi-server races resolve through atomic conditional writes. */
export interface EgressOptions {
    /** How often the sweep runs. Default 15s; tests lower it. */
    sweepMs?: number;
    /** How long a delivery claim lasts. Renewed per row; default 30s. */
    claimMs?: number;
    /** How far back the sweep looks (default 24h). Bounds sweep cost to live
     *  conversations. The observer handles fresh rows on older bindings. */
    sweepLookbackMs?: number;
}
/** Retry backoff for mid-sending receipts. Caps prevent infinite re-posting. */
export declare const BACKOFF_BASE_MS = 15000;
export declare const BACKOFF_MAX_MS: number;
export declare const MAX_DELIVERY_ATTEMPTS = 48;
export interface EgressWorker {
    stop(): Promise<void>;
}
/** The per-binding claim — `claimLease`'s idiom on the binding row. Win iff
 *  n === 1; of N racers exactly one matches. */
export declare function claimBinding(bindingId: string, claimMs: number, serverId?: string): Promise<boolean>;
/** Cursor advance — guarded on claim + expected `fromSeq` (single-winner). */
export declare function advanceCursor(bindingId: string, fromSeq: number, toSeq: number, serverId?: string): Promise<boolean>;
/** What `deliverOnce` reads from a binding. Synthetic side deliveries still
 * name their originating Session so lifecycle protection stays fail-closed. */
export type DeliverableBinding = Pick<ChannelBinding, '_id' | 'kind' | 'destination' | 'sessionId'>;
export interface DeliverOnceOptions {
    expects?: ReceiptExpectation[];
    /** The transport/lens/tier to deliver through, when the caller holds them
     *  directly (compose). Default: the registry's def for `binding.kind`. */
    def?: Pick<ChannelDef, 'transport' | 'lens' | 'onUncertainDelivery'>;
    /** Idempotent Session-owned reconciliation after a confirmed delivery. It
     *  runs transactionally while the delivery's root+target lifecycle operation
     *  is still held, including when a retry finds an already-settled receipt. */
    afterDelivered?: (mongoSession: ClientSession) => Promise<void>;
}
/** Three-phase delivery: reserve → post → confirm. Receipt-keyed for
 *  idempotency. Returns delivered/abandoned/deferred. Throws on transport
 *  failure (the next sweep retries). Exported for tool-body idempotency. */
export declare function deliverOnce(binding: DeliverableBinding, item: DeliveryItem | (() => Promise<DeliveryItem>), suffix: string, opts?: DeliverOnceOptions): Promise<'delivered' | 'abandoned' | 'deferred'>;
/** Deliver one binding's backlog: claim, plan, post, advance cursor,
 *  then offer any parked prompt. */
export declare function deliverBinding(kind: string, bindingId: string, opts?: EgressOptions): Promise<void>;
export declare function startEgress(kind: string, opts?: EgressOptions): EgressWorker;
//# sourceMappingURL=egress.d.ts.map