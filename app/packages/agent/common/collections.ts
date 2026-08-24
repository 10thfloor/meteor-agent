import { Mongo } from 'meteor/mongo';
import { NAMES } from './names';
import type { AgentDelta, AgentMemory, AgentMessage, AgentSession } from './types';
import type {
  DeltasCollection, MemoriesCollection, MessagesCollection, SessionsCollection,
} from './db';

/**
 * The three collections, typed through the `db.ts` facade so every selector and
 * modifier is field-name-checked and no call site needs an `as any`. The
 * `as unknown as …` here is the ONE place per collection the driver's loose
 * types are crossed — see `db.ts` for why the facade is shaped the way it is.
 */
export const AgentSessions =
  new Mongo.Collection<AgentSession>(NAMES.sessions) as unknown as SessionsCollection;
export const AgentMessages =
  new Mongo.Collection<AgentMessage>(NAMES.messages) as unknown as MessagesCollection;
export const AgentDeltas =
  new Mongo.Collection<AgentDelta>(NAMES.deltas) as unknown as DeltasCollection;

/** Memory (memory spec). Declared HERE rather than server-side because the
 *  client bundle needs it: "what this app remembers about me" is an ordinary
 *  subscription, which is the whole point of memory being a collection. */
export const AgentMemories =
  new Mongo.Collection<AgentMemory>(NAMES.memories) as unknown as MemoriesCollection;
