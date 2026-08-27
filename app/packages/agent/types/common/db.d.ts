import type { Mongo } from 'meteor/mongo';
import type { AgentDelta, AgentMemory, AgentMessage, AgentSession, SessionInc } from './types';
/**
 * Typed selector/modifier facades so field-name typos are compile errors
 * and dotted nested paths (`lease.serverId`) work without casts.
 */
/** Closed set of field operators the package uses. Add here when a query needs one. */
export interface FieldExpr<V> {
    $eq?: V;
    $ne?: V;
    $in?: readonly V[];
    $nin?: readonly V[];
    $gt?: V;
    $gte?: V;
    $lt?: V;
    $lte?: V;
    $exists?: boolean;
    /** Sub-selector for array elements; call sites keep the element shape honest. */
    $elemMatch?: Record<string, unknown>;
}
/** Exact value, null (matches missing/null), or an operator expression. */
export type Cond<V> = V | null | FieldExpr<V>;
/** Value-checked core of a query; makes top-level field typos compile errors. */
export type Fields<T> = {
    [K in keyof T]?: Cond<T[K]>;
};
/** Session selector: value-checked own fields + template-literal nested paths. */
export type SessionQuery = Fields<AgentSession> & {
    [k: `lease.${string}`]: unknown;
} & {
    [k: `pending.${string}`]: unknown;
} & {
    [k: `parent.${string}`]: unknown;
} & {
    [k: `activeChild.${string}`]: unknown;
} & {
    [k: `forkedFrom.${string}`]: unknown;
} & {
    [k: `usage.${string}`]: unknown;
} & {
    [k: `budgetSpent.${string}`]: unknown;
} & {
    [k: `channel.${string}`]: unknown;
} & {
    [k: `participants.${string}`]: unknown;
} & {
    [k: `pendingRelay.${string}`]: unknown;
} & {
    [k: `pendingSystem.${string}`]: unknown;
} & {
    [k: `pendingInput.${string}`]: unknown;
} & {
    [k: `pendingInputs.${string}`]: unknown;
} & {
    $or?: SessionQuery[];
    $and?: SessionQuery[];
    $nor?: SessionQuery[];
};
/** A session selector: a plain `_id` string, or a query object. */
export type SessionSelector = string | SessionQuery;
/** Session `$set`: own fields value-checked, nested counters typed as number. */
export type SessionSet = {
    [K in keyof AgentSession]?: AgentSession[K];
} & {
    [k: `lease.${string}`]: unknown;
} & {
    [k: `pending.${string}`]: unknown;
} & {
    [k: `channel.${string}`]: unknown;
} & {
    [k: `usage.${string}`]: number;
} & {
    [k: `budgetSpent.${string}`]: number;
};
/** Session `$unset`: known fields only, typos rejected. */
type SessionUnset = {
    [K in keyof AgentSession]?: 1 | true;
} & {
    [k: `lease.${string}`]: 1 | true;
} & {
    [k: `pending.${string}`]: 1 | true;
};
/** Session modifier: `$set`/`$unset`/`$inc`/`$push`/`$pull`, all field-checked. */
export interface SessionModifier {
    $set?: SessionSet;
    $unset?: SessionUnset;
    $inc?: SessionInc;
    /** Roster join (§4.1). */
    $push?: {
        participants?: import('./types').SessionParticipant;
    };
    /** The roster leave — the mirror of `$push`. */
    $pull?: {
        participants?: {
            id: string;
        };
    };
}
/** Message selector: flat fields only (no nested paths). */
export type MessageQuery = Fields<AgentMessage> & {
    $or?: MessageQuery[];
    $and?: MessageQuery[];
    $nor?: MessageQuery[];
};
/** A message selector: a plain `_id` string, or a query object. */
export type MessageSelector = string | MessageQuery;
/** No update path exists; typed for interface completeness. */
export interface MessageModifier {
    $set?: {
        [K in keyof AgentMessage]?: AgentMessage[K];
    };
    $unset?: {
        [K in keyof AgentMessage]?: 1 | true;
    };
}
/** A selector over a delta. */
export type DeltaQuery = Fields<AgentDelta> & {
    $or?: DeltaQuery[];
    $and?: DeltaQuery[];
    $nor?: DeltaQuery[];
};
/** A delta selector: a plain `_id` string, or a query object. */
export type DeltaSelector = string | DeltaQuery;
/** Deltas are insert/find/remove only. Typed for interface completeness. */
export interface DeltaModifier {
    $set?: {
        [K in keyof AgentDelta]?: AgentDelta[K];
    };
    $unset?: {
        [K in keyof AgentDelta]?: 1 | true;
    };
}
/** Memory selector: flat fields only. */
export type MemoryQuery = Fields<AgentMemory> & {
    $or?: MemoryQuery[];
    $and?: MemoryQuery[];
    $nor?: MemoryQuery[];
};
/** A memory selector: a plain `_id` string, or a query object. */
export type MemorySelector = string | MemoryQuery;
/** Only the deliberate-upsert path updates memories. */
export interface MemoryModifier {
    $set?: {
        [K in keyof AgentMemory]?: AgentMemory[K];
    };
    $unset?: {
        [K in keyof AgentMemory]?: 1 | true;
    };
}
/** Subset of find/update options the package actually uses. */
export interface FindOptions {
    sort?: Record<string, 1 | -1>;
    fields?: Record<string, 0 | 1>;
    projection?: Record<string, 0 | 1>;
    limit?: number;
    skip?: number;
}
export interface UpdateOptions {
    multi?: boolean;
    upsert?: boolean;
}
/** Collection with selector/modifier methods narrowed to per-collection types. */
export interface TypedCollection<T extends {
    _id: string;
}, Sel, Mod> extends Omit<Mongo.Collection<T>, 'find' | 'findOne' | 'findOneAsync' | 'updateAsync' | 'removeAsync'> {
    find(selector?: Sel, options?: FindOptions): Mongo.Cursor<T>;
    findOne(selector?: Sel, options?: FindOptions): T | undefined;
    findOneAsync(selector?: Sel, options?: FindOptions): Promise<T | undefined>;
    updateAsync(selector: Sel, modifier: Mod, options?: UpdateOptions): Promise<number>;
    removeAsync(selector: Sel): Promise<number>;
}
export type SessionsCollection = TypedCollection<AgentSession, SessionSelector, SessionModifier>;
export type MessagesCollection = TypedCollection<AgentMessage, MessageSelector, MessageModifier>;
export type DeltasCollection = TypedCollection<AgentDelta, DeltaSelector, DeltaModifier>;
export type MemoriesCollection = TypedCollection<AgentMemory, MemorySelector, MemoryModifier>;
export {};
//# sourceMappingURL=db.d.ts.map