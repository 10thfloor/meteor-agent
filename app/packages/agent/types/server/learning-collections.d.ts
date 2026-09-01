import { Mongo } from 'meteor/mongo';
import type { AgentConstitution, AgentExperience, AgentIdentity, AgentLearningEvent, AgentMemoryFrame, AgentPractice } from '../common/learning';
export declare const AgentIdentities: Mongo.Collection<AgentIdentity, AgentIdentity>;
export declare const AgentConstitutions: Mongo.Collection<AgentConstitution, AgentConstitution>;
export declare const AgentExperiences: Mongo.Collection<AgentExperience, AgentExperience>;
export declare const AgentPractices: Mongo.Collection<AgentPractice, AgentPractice>;
export declare const AgentMemoryFrames: Mongo.Collection<AgentMemoryFrame, AgentMemoryFrame>;
export declare const AgentLearningEvents: Mongo.Collection<AgentLearningEvent, AgentLearningEvent>;
//# sourceMappingURL=learning-collections.d.ts.map