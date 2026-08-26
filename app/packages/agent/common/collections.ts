import { Mongo } from 'meteor/mongo';
import { NAMES } from './names';
import type { AgentDelta, AgentMemory, AgentMessage, AgentSession } from './types';
import type {
  DeltasCollection, MemoriesCollection, MessagesCollection, SessionsCollection,
} from './db';

/** Collections typed through the db.ts facade — one `as unknown as` per collection. */
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
