import { Mongo } from 'meteor/mongo';
import { NAMES } from './names';
import type { AgentDelta, AgentMessage, AgentSession } from './types';

export const AgentSessions = new Mongo.Collection<AgentSession>(NAMES.sessions);
export const AgentMessages = new Mongo.Collection<AgentMessage>(NAMES.messages);
export const AgentDeltas = new Mongo.Collection<AgentDelta>(NAMES.deltas);
