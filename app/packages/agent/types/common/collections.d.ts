import type { DeltasCollection, MemoriesCollection, MessagesCollection, SessionsCollection } from './db';
/** Collections typed through the db.ts facade — one `as unknown as` per collection. */
export declare const AgentSessions: SessionsCollection;
export declare const AgentMessages: MessagesCollection;
export declare const AgentDeltas: DeltasCollection;
/** Memory (memory spec). Declared HERE rather than server-side because the
 *  client bundle needs it: "what this app remembers about me" is an ordinary
 *  subscription, which is the whole point of memory being a collection. */
export declare const AgentMemories: MemoriesCollection;
//# sourceMappingURL=collections.d.ts.map