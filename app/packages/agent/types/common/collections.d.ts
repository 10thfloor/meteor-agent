import type { DeltasCollection, MemoriesCollection, MessagesCollection, SessionsCollection } from './db';
/**
 * The three collections, typed through the `db.ts` facade so every selector and
 * modifier is field-name-checked and no call site needs an `as any`. The
 * `as unknown as …` here is the ONE place per collection the driver's loose
 * types are crossed — see `db.ts` for why the facade is shaped the way it is.
 */
export declare const AgentSessions: SessionsCollection;
export declare const AgentMessages: MessagesCollection;
export declare const AgentDeltas: DeltasCollection;
/** Memory (memory spec). Declared HERE rather than server-side because the
 *  client bundle needs it: "what this app remembers about me" is an ordinary
 *  subscription, which is the whole point of memory being a collection. */
export declare const AgentMemories: MemoriesCollection;
//# sourceMappingURL=collections.d.ts.map