import { Mongo } from 'meteor/mongo';
import type { AgentMessage } from '../common/types';
import type { RecordExperienceInput } from '../common/learning';
export type ObservationExperienceDraft = Pick<RecordExperienceInput, 'expectationBasis' | 'expected' | 'observed' | 'difference' | 'lesson' | 'context' | 'confidence'>;
export interface AgentObservation {
    _id: string;
    sessionId: string;
    agentId: string;
    frameId: string;
    triggerSeq: number;
    throughSeq: number;
    summary: string;
    digest: string;
    sources: Array<{
        id: string;
        seq: number;
        role: string;
        digest: string;
    }>;
    status: 'recorded' | 'candidate' | 'admitting' | 'admitted' | 'dismissed';
    candidate?: ObservationExperienceDraft;
    experienceId?: string;
    admission?: 'automatic' | 'reviewed';
    reviewedBy?: string;
    processing?: boolean;
    processingUntil?: Date;
    processingToken?: string;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
}
export declare const AgentObservations: Mongo.Collection<AgentObservation, AgentObservation>;
export type ObservationResolver = (input: {
    agentId: string;
    sessionId: string;
    messages: AgentMessage[];
    priorSummary?: string;
    /** Dedicated background trace: resolver model/token spans can attach here. */
    traceId?: string;
    signal?: AbortSignal;
}) => Promise<{
    summary: string;
    experience?: ObservationExperienceDraft;
}>;
export type ObservationPolicy = (input: {
    agentId: string;
    sessionId: string;
}) => boolean | Promise<boolean>;
/** Host-owned summarization adapter. It may use a model or a deterministic
 * domain extractor. Returned learning is always a candidate subject to the
 * exact Turn's frozen admission policy. */
export declare function setObservationResolver(next?: ObservationResolver): void;
/** Automatic reflection is off until the host supplies an explicit per-agent
 * policy. Manual Reflect remains a separate user-authorized action. */
export declare function setObservationPolicy(next?: ObservationPolicy): void;
/** A completed answer remains immediately available while optional reflection
 * works under its own lifecycle lease. Safe errors stay with the observation. */
export declare function queueObservationReflection(observationId: string): void;
/** Deterministic capture is deliberately an extract of evidence, not a claim
 * that every conversational reply is a lesson. Explicit reflection can ask a
 * host resolver to propose meaning afterwards. */
export declare function captureObservations(input: {
    sessionId: string;
    agentId: string;
    frameId: string;
    throughSeq: number;
    /** Runtime-proven input history plus the final reply. Excludes a human
     * interjection that landed while the model was streaming its answer. */
    sourceMessageIds?: string[];
}): Promise<AgentObservation>;
/** Explicit, host-authorized reflection. Supplying a draft is useful for a
 * human editing an observation; otherwise the registered resolver produces a
 * source-bound summary/candidate. Reviewed policy leaves a candidate for UI
 * approval; automatic policy writes an auditable Experience immediately. */
export declare function reflectObservation(observationId: string, options?: {
    draft?: ObservationExperienceDraft;
}): Promise<AgentObservation>;
/** Public review door. A principal is required for reviewed admission;
 * automatic admission is available only under the frozen frame policy. */
export declare function admitObservationExperience(observationId: string, options: {
    actorId?: string;
    automatic?: boolean;
}): Promise<AgentObservation>;
export declare function dismissObservation(observationId: string, actorId: string): Promise<void>;
export declare function listSessionObservations(sessionId: string): Promise<AgentObservation[]>;
/** Exact original transcript rows; host must authorize their conversation. */
export declare function readObservationSources(observationId: string): Promise<AgentMessage[]>;
export declare function ensureObservationIndexes(): Promise<void>;
//# sourceMappingURL=observations.d.ts.map