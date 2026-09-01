import { Mongo } from 'meteor/mongo';
import { NAMES } from '../common/names';
import type {
  AgentConstitution, AgentExperience, AgentIdentity, AgentLearningEvent,
  AgentMemoryFrame, AgentPractice,
} from '../common/learning';

const privateOptions = { _preventAutopublish: true } as any;

export const AgentIdentities = new Mongo.Collection<AgentIdentity>(
  NAMES.identities, privateOptions,
);
export const AgentConstitutions = new Mongo.Collection<AgentConstitution>(
  NAMES.constitutions, privateOptions,
);
export const AgentExperiences = new Mongo.Collection<AgentExperience>(
  NAMES.experiences, privateOptions,
);
export const AgentPractices = new Mongo.Collection<AgentPractice>(
  NAMES.practices, privateOptions,
);
export const AgentMemoryFrames = new Mongo.Collection<AgentMemoryFrame>(
  NAMES.memoryFrames, privateOptions,
);
export const AgentLearningEvents = new Mongo.Collection<AgentLearningEvent>(
  NAMES.learningEvents, privateOptions,
);
