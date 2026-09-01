import type { AgentConstitution, AgentExperience, AgentIdentity, AgentIdentityLifecycle, AgentMemoryFrame, AgentPractice, AgentPracticeNonHardeningStatus, AgentPracticeStatus, ExperienceAudience, ExperienceConfig, FreezeMemoryFrameInput, IdentityConfig, PracticeConfig, LearningAudit, LearningMutationResult, LearningSource, ProposePracticeInput, RecordExperienceInput, ResolvedExperience, ResolvedPractice, ReviewLearningInput } from '../common/learning';
export declare const AGENT_MEMORY_FRAME_OPEN = "<agent-memory-frame>";
export declare const AGENT_MEMORY_FRAME_CLOSE = "</agent-memory-frame>";
export declare const CURRENT_PROTECTED_LEARNING_PROMPT_VERSION: 2;
export declare function canonicalDigest(value: unknown): string;
/** Exactly one frame for this Session/Agent/trigger tuple; never Lease-derived. */
export declare function memoryFrameId(sessionId: string, agentId: string, triggerSeq: number): string;
type LearningIdentityFenceOperation = 'mutation' | 'lifecycle';
type LearningIdentityFencePhase = 'after-read' | 'before-write' | 'after-write';
type LearningIdentityFenceHook = (agentId: string, operation: LearningIdentityFenceOperation, phase: LearningIdentityFencePhase) => void | Promise<void>;
/** Internal deterministic race seam. Tests import this module directly; it is
 * deliberately absent from the package's public server exports. */
export declare function setLearningIdentityFenceHookForTests(hook: LearningIdentityFenceHook | undefined): () => void;
export declare function resolveExperienceConfig(config?: ExperienceConfig): ResolvedExperience | undefined;
/** Resolve the opt-in Agent-authored Practice acquisition policy. */
export declare function resolvePracticeConfig(config?: PracticeConfig): ResolvedPractice | undefined;
export declare function ensureAgentIdentity(input: IdentityConfig): Promise<LearningMutationResult<AgentIdentity>>;
export declare function reviseConstitution(agentIdInput: string, expectedGeneration: number, body: string, reasonInput: string, sourceInput: LearningSource): Promise<LearningMutationResult<AgentConstitution>>;
export declare function setIdentityLifecycle(agentIdInput: string, expectedGeneration: number, lifecycle: AgentIdentityLifecycle, sourceInput: LearningSource): Promise<LearningMutationResult<AgentIdentity>>;
export declare function recordExperience(input: RecordExperienceInput): Promise<LearningMutationResult<AgentExperience>>;
export declare function retractExperience(agentIdInput: string, id: string, reasonInput: string, sourceInput: LearningSource): Promise<LearningMutationResult<AgentExperience>>;
export declare function listExperiences(agentIdInput: string, opts?: {
    limit?: number;
    status?: 'active' | 'retracted';
    context?: string;
    /** Exact exposure partition; defaults to the compatibility identity scope. */
    audience?: ExperienceAudience;
}): Promise<AgentExperience[]>;
export declare function proposePractice(input: ProposePracticeInput): Promise<LearningMutationResult<AgentPractice>>;
export declare function practiceTransitionAllowed(from: AgentPracticeStatus, to: AgentPracticeStatus): boolean;
export declare function transitionPractice(agentIdInput: string, id: string, to: 'hardened', reasonInput: string, sourceInput: LearningSource, hardeningEvidenceIdInput: string): Promise<LearningMutationResult<AgentPractice>>;
export declare function transitionPractice(agentIdInput: string, id: string, to: AgentPracticeNonHardeningStatus, reasonInput: string, sourceInput: LearningSource): Promise<LearningMutationResult<AgentPractice>>;
/** Policy-only path: an automatic decision may activate a candidate as a trial,
 * but receives no interface for hardening or any other lifecycle transition. */
export declare function validatePracticeAutomatically(agentIdInput: string, id: string, frameIdInput: string, reasonInput: string, sourceInput: LearningSource): Promise<LearningMutationResult<AgentPractice>>;
/** Acknowledge an automatically admitted record without rewriting its immutable
 * admission route or semantic evidence. Corrections remain retract/retire + replacement. */
export declare function reviewLearning(input: ReviewLearningInput): Promise<LearningMutationResult<AgentExperience | AgentPractice>>;
export declare function freezeMemoryFrame(input: FreezeMemoryFrameInput): Promise<LearningMutationResult<AgentMemoryFrame>>;
/** Render only frozen Constitution/Practice layers. L1 bodies stay behind the Tool seam. */
export declare function buildProtectedLearningPrompt(frameOrId: AgentMemoryFrame | string): Promise<string>;
/** Attach the final effective Provider-request digest to a Frame's audit trail.
 * Request bytes never enter Learning persistence.
 *
 * This runs before EVERY paid provider call, so it is deliberately not a
 * transaction and never writes the shared identity document — the previous
 * shape serialized all of an agent's concurrent sessions on one `$inc`. An
 * append-only audit event with a deterministic id gives the same idempotency:
 * the unique (agentId, kind, sourceDigest) index arbitrates, a replay adopts,
 * and a same-key-different-digest insert is the conflict `mutate` detected. */
export declare function recordProviderRequestDigest(frameId: string, requestDigestInput: string, sourceInput: LearningSource): Promise<LearningMutationResult<AgentMemoryFrame>>;
export declare function auditLearningState(agentIdInput: string): Promise<LearningAudit>;
export declare function ensureLearningIndexes(): Promise<void>;
export {};
//# sourceMappingURL=learning.d.ts.map