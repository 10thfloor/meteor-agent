import type { SessionModifier } from '../common/db';
/** Identity of this app server process, regenerated on every boot. */
export declare const SERVER_ID: string;
export declare let LEASE_MS: number;
export declare let HEARTBEAT_MS: number;
/** Test seam: shrink lease/heartbeat timings. Returns previous values
 *  so a `finally` can restore them. */
export declare function _setLeaseTimings({ leaseMs, heartbeatMs }: {
    leaseMs?: number;
    heartbeatMs?: number;
}): {
    leaseMs: number;
    heartbeatMs: number;
};
/** Claim a run. Succeeds if unleased, expired, or already ours. Atomic on a
 *  single document, so exactly one racing server wins. */
export declare function claimLease(sessionId: string, serverId?: string): Promise<boolean>;
export declare function heartbeat(sessionId: string, serverId?: string): Promise<boolean>;
export declare function releaseLease(sessionId: string, serverId?: string): Promise<void>;
export declare function holdsLease(sessionId: string, serverId?: string): Promise<boolean>;
/** Every write during a turn goes through this. A server that lost the lease
 *  fails the guard and must abandon rather than write. */
export declare function guardedUpdate(sessionId: string, serverId: string, modifier: SessionModifier): Promise<boolean>;
//# sourceMappingURL=lease.d.ts.map