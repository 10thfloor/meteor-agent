/** A deliberately narrow migration: the admission replay window grew from
 * two days to seven days. Existing indexes must not be dropped or rebuilt.
 * https://www.mongodb.com/docs/manual/core/index-ttl/#change-the-expireafterseconds-value-for-a-ttl-index
 */
export declare const INBOUND_REPLAY_TTL_SECONDS: number;
interface IndexDescription {
    name?: unknown;
    key?: unknown;
    expireAfterSeconds?: unknown;
    [key: string]: unknown;
}
export interface InboundTtlCollection {
    collectionName: string;
    listIndexes(): {
        toArray(): Promise<IndexDescription[]>;
    };
    createIndex(keys: {
        at: 1;
    }, options: {
        expireAfterSeconds: number;
    }): Promise<unknown>;
}
export interface InboundTtlDatabase {
    command(command: Record<string, unknown>): Promise<unknown>;
}
export interface InboundTtlResult {
    status: 'created' | 'unchanged' | 'migrated';
    indexName: string;
    expireAfterSeconds: number;
}
/** Injectable raw-driver adapter avoids Meteor createIndexAsync logging an
 * expected option conflict before callers can handle it. Only the known
 * 172800 -> 604800 transition is automatic; no TTL is ever shortened here.
 */
export declare function ensureInboundReplayTtl(collection: InboundTtlCollection, database: InboundTtlDatabase): Promise<InboundTtlResult>;
export {};
//# sourceMappingURL=inbound-ttl.d.ts.map