import type { AgentConstitution, AgentExperience, AgentPractice, LearningMutationResult, LearningSource } from '../common/learning';
/** Deterministic app-side idempotency source. Meteor may transparently replay
 *  a method after reconnect; binding the key to the requested command lets an
 *  identical replay adopt its first result, while reuse for different content
 *  fails inside the Learning Module. `namespace` is the host's stable prefix
 *  (its keys must not collide with another host's or with model sources). */
export declare function hostLearningSource(namespace: string, action: string, agentId: string, command: unknown): LearningSource;
/** Input contract shared by hosts and `governedLearningReview`. Exported so a
 *  host method can refuse a malformed target before doing authorization work. */
export declare function assertLearningReviewTarget(target: unknown): asserts target is 'experience' | 'practice';
/** Input contract shared by hosts and `governedPracticeTransition`: hardening
 *  needs its exact proof Experience, and nothing else may carry one. */
export declare function assertPracticeTransitionEvidence(status: unknown, hardeningEvidenceId: unknown): void;
/** Revise an Agent's Constitution on behalf of an authorized host caller.
 *  Generation CAS loss is an expected editing outcome, so it surfaces as a
 *  structured code clients can branch on — never as message text to match. */
export declare function governedConstitutionRevise(namespace: string, agentIdInput: unknown, expectedGenerationInput: unknown, bodyInput: unknown, reasonInput: unknown): Promise<LearningMutationResult<AgentConstitution>>;
/** Retract one Experience with a durable reason, for an authorized host caller. */
export declare function governedExperienceRetract(namespace: string, agentIdInput: unknown, experienceIdInput: unknown, reasonInput: unknown): Promise<LearningMutationResult<AgentExperience>>;
/** Acknowledge an automatically admitted record on behalf of the reviewing
 *  person; `actorId` is the host principal accountable for the review. */
export declare function governedLearningReview(namespace: string, agentIdInput: unknown, target: unknown, targetIdInput: unknown, actorIdInput: unknown): Promise<LearningMutationResult<AgentExperience | AgentPractice>>;
export interface GovernedPracticeProposal {
    key?: unknown;
    trigger?: unknown;
    guidance?: unknown;
    context?: unknown;
    evidenceIds?: unknown;
    /** Distinguishes a deliberate later proposal with identical content from
     *  transparent DDP replay of the original method invocation. */
    commandId?: unknown;
}
/** Propose a Practice on behalf of an authorized host caller. Content rules
 *  (evidence, sizes, live-revision backpressure) stay in the Learning Module. */
export declare function governedPracticePropose(namespace: string, agentIdInput: unknown, proposalInput: unknown): Promise<LearningMutationResult<AgentPractice>>;
/** Transition a Practice's lifecycle for an authorized host caller. Governance
 *  refusals from the Learning Module (candidate limits, live revisions, review
 *  backlogs) pass through untouched as their structured Meteor.Error codes. */
export declare function governedPracticeTransition(namespace: string, agentIdInput: unknown, practiceIdInput: unknown, statusInput: unknown, reasonInput: unknown, hardeningEvidenceId?: unknown): Promise<LearningMutationResult<AgentPractice>>;
/** Per-collection field allowlists (plus ordering and caps) for publishing
 *  learning state to a browser. Internal bookkeeping — event ids, watermarks,
 *  raw digest inputs — stays server-side. */
export declare const LEARNING_PUBLICATION_VIEWS: {
    readonly identities: {
        readonly fields: {
            readonly generation: 1;
            readonly experienceSeq: 1;
            readonly currentName: 1;
            readonly aliases: 1;
            readonly displayName: 1;
            readonly lifecycle: 1;
            readonly constitutionVersionId: 1;
            readonly flexibility: 1;
            readonly createdAt: 1;
            readonly updatedAt: 1;
        };
    };
    readonly constitutions: {
        readonly fields: {
            readonly agentId: 1;
            readonly revision: 1;
            readonly content: 1;
            readonly reason: 1;
            readonly digest: 1;
            readonly 'source.kind': 1;
            readonly 'source.sessionId': 1;
            readonly 'source.triggerSeq': 1;
            readonly createdAt: 1;
        };
        readonly sort: {
            readonly revision: -1;
        };
        readonly limit: 200;
    };
    readonly experiences: {
        readonly fields: {
            readonly agentId: 1;
            readonly sequence: 1;
            readonly expectationBasis: 1;
            readonly expected: 1;
            readonly observed: 1;
            readonly difference: 1;
            readonly lesson: 1;
            readonly context: 1;
            readonly confidence: 1;
            readonly status: 1;
            readonly audience: 1;
            readonly admission: 1;
            readonly 'review.at': 1;
            readonly 'review.reason': 1;
            readonly 'review.source.kind': 1;
            readonly 'review.source.actorId': 1;
            readonly 'source.kind': 1;
            readonly 'source.sessionId': 1;
            readonly 'source.triggerSeq': 1;
            readonly frameId: 1;
            readonly createdAt: 1;
            readonly retractedAt: 1;
            readonly retractionReason: 1;
        };
        readonly sort: {
            readonly sequence: -1;
        };
        readonly limit: 500;
    };
    readonly practices: {
        readonly fields: {
            readonly practiceId: 1;
            readonly agentId: 1;
            readonly key: 1;
            readonly revision: 1;
            readonly trigger: 1;
            readonly guidance: 1;
            readonly context: 1;
            readonly evidenceIds: 1;
            readonly status: 1;
            readonly frameId: 1;
            readonly validationAdmission: 1;
            readonly 'source.kind': 1;
            readonly 'source.sessionId': 1;
            readonly 'source.triggerSeq': 1;
            readonly 'transitionSource.kind': 1;
            readonly 'transitionSource.actorId': 1;
            readonly 'review.at': 1;
            readonly 'review.reason': 1;
            readonly 'review.source.kind': 1;
            readonly 'review.source.actorId': 1;
            readonly createdAt: 1;
            readonly updatedAt: 1;
            readonly transitionReason: 1;
            readonly validatedAt: 1;
            readonly validationWatermark: 1;
            readonly hardenedAt: 1;
            readonly hardenedEvidenceId: 1;
            readonly retiredAt: 1;
            readonly rejectedAt: 1;
        };
        readonly sort: {
            readonly updatedAt: -1;
        };
        readonly limit: 500;
    };
    readonly frames: {
        readonly fields: {
            readonly agentId: 1;
            readonly sessionId: 1;
            readonly triggerSeq: 1;
            readonly digest: 1;
            readonly createdAt: 1;
            readonly context: 1;
            readonly audience: 1;
            readonly protectedPromptVersion: 1;
            readonly protectedPromptDigest: 1;
            readonly learningPolicy: 1;
            readonly 'constitution.id': 1;
            readonly 'constitution.revision': 1;
            readonly 'constitution.digest': 1;
            readonly 'practices.id': 1;
            readonly 'practices.practiceId': 1;
            readonly 'practices.revision': 1;
            readonly 'practices.status': 1;
            readonly 'practices.digest': 1;
            readonly 'experiences.id': 1;
            readonly 'experiences.digest': 1;
            readonly 'factMemory.promptDigest': 1;
            readonly 'factMemory.evidence.id': 1;
            readonly 'factMemory.evidence.scope': 1;
            readonly 'factMemory.evidence.digest': 1;
        };
        readonly sort: {
            readonly createdAt: -1;
        };
        readonly limit: 100;
    };
};
/** The slice of a Meteor publication context this module drives. Kept
 *  structural so tests can call publication handlers directly. */
export interface LearningSubscription {
    added(collection: string, id: string, fields: Record<string, unknown>): void;
    changed(collection: string, id: string, fields: Record<string, unknown>): void;
    removed(collection: string, id: string): void;
    onStop(callback: () => void): void;
}
export interface LearningPublisher {
    /** Start streaming every learning view for one Agent; idempotent per id.
     *  Rejects when a view observer cannot start (learning unavailable). */
    addAgent(agentId: string): Promise<void>;
    /** True once the subscription stopped; hosts gate ready()/error() on it. */
    readonly stopped: boolean;
}
/** Stream the reviewed learning views — allowlists applied — for the Agent
 *  identities a host names. The host keeps authorization and the reactive
 *  choice of which agentIds this subscriber may see; this owns observer
 *  lifecycle so a stopped subscription never receives another callback. */
export declare function createLearningPublisher(sub: LearningSubscription): LearningPublisher;
//# sourceMappingURL=learning-governance.d.ts.map