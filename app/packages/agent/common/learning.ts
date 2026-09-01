/** Public contracts for the Agent Learning Module. The Mongo collections and
 * mutation implementation remain server-private. */

export type AgentIdentityLifecycle = 'active' | 'archived';
export type AgentExperienceStatus = 'active' | 'retracted';
export type AgentPracticeStatus =
  | 'candidate' | 'validated' | 'hardened' | 'retired' | 'rejected';
/** Practice targets that do not require a separately selected hardening proof. */
export type AgentPracticeNonHardeningStatus = Exclude<AgentPracticeStatus, 'hardened'>;
export type ExperienceConfidence = number;
export type ExperienceExpectationBasis = 'explicit' | 'inferred' | 'retrospective';
export type ExperienceScope = 'identity' | 'owner' | 'session';
/** Whether a model-authored learning mutation waits for review before activation. */
export type LearningApprovalMode = 'ask' | 'auto';
/** Immutable account of how a learning record became active. */
export type LearningAdmission = 'reviewed' | 'automatic' | 'trusted';

/** Later acknowledgement of an automatically admitted record; not semantic content. */
export interface LearningAuditReview {
  at: Date;
  source: LearningSource;
  reason?: string;
}

/** The exact privacy/recall partition for one Experience and Memory Frame. */
export interface ExperienceAudience {
  scope: ExperienceScope;
  /** Identity id, authenticated owner id, or Session id according to `scope`. */
  key: string;
}

export interface LearningSource {
  kind: 'app' | 'model' | 'system' | 'migration';
  /** Stable for one logical mutation and reused on retry. */
  key: string;
  sessionId?: string;
  /** Session-local trigger provenance. Never use this as an Agent watermark. */
  triggerSeq?: number;
  toolCallId?: string;
  assistantMessageId?: string;
  /** Optional host principal responsible for a trusted app-side decision. */
  actorId?: string;
}

export type ExperienceSource = LearningSource & {
  sessionId: string;
  triggerSeq: number;
} & (
  | { kind: 'model'; toolCallId: string; assistantMessageId: string }
  | { kind: 'app' | 'system' | 'migration' }
);

export interface AgentIdentity {
  _id: string;
  /** CAS token for identity/configuration changes. */
  generation: number;
  /**
   * Internal monotone write token used to serialize active-only Learning
   * mutations with lifecycle changes. Optional for pre-fence stored rows.
   */
  learningWriteSeq?: number;
  /** Monotone per-Agent Experience sequence, independent of Sessions. */
  experienceSeq: number;
  currentName: string;
  aliases: string[];
  displayName: string;
  lifecycle: AgentIdentityLifecycle;
  constitutionVersionId?: string;
  flexibility: { capacity: number; available: number };
  createdAt: Date;
  updatedAt: Date;
}

/** An immutable Constitution version. A new revision creates a new document. */
export interface AgentConstitution {
  _id: string;
  agentId: string;
  revision: number;
  content: string;
  reason: string;
  digest: string;
  source: LearningSource;
  createdAt: Date;
}

/** Evidence of a material difference between expectation and observation. */
export interface AgentExperience {
  _id: string;
  agentId: string;
  /** Monotone within Agent Identity, allocated atomically on first insert. */
  sequence: number;
  /** Whether the expectation existed before the outcome or was reconstructed. */
  expectationBasis: ExperienceExpectationBasis;
  expected: string;
  observed: string;
  difference: string;
  lesson: string;
  context: string;
  confidence: ExperienceConfidence;
  status: AgentExperienceStatus;
  /** Exact-match exposure boundary. Durable ownership remains with the Agent. */
  audience: ExperienceAudience;
  source: ExperienceSource;
  frameId?: string;
  /** How this Experience became active. Missing only on legacy rows. */
  admission?: LearningAdmission;
  /** Monotonic post-admission audit acknowledgement; semantic evidence stays immutable. */
  review?: LearningAuditReview;
  digest: string;
  createdAt: Date;
  retractedAt?: Date;
  retractedBy?: LearningSource;
  retractionReason?: string;
}

/** Content and revision are immutable. Only status and transition metadata move. */
export interface AgentPractice {
  _id: string;
  practiceId: string;
  agentId: string;
  key: string;
  revision: number;
  /** When the Practice is relevant; the model decides applicability per Turn. */
  trigger: string;
  /** How to act when the trigger applies. */
  guidance: string;
  /** Evidence-class context mark used only for validation/hardening. */
  context: string;
  evidenceIds: string[];
  source: LearningSource;
  /** Model proposals retain the exact frozen evidence surface that authorized them. */
  frameId?: string;
  digest: string;
  status: AgentPracticeStatus;
  createdAt: Date;
  updatedAt: Date;
  transitionSource?: LearningSource;
  transitionReason?: string;
  validatedAt?: Date;
  /** Per-Agent Experience sequence at validation time. */
  validationWatermark?: number;
  /** How this Practice became an active trial. Missing only on legacy rows. */
  validationAdmission?: Exclude<LearningAdmission, 'trusted'>;
  review?: LearningAuditReview;
  hardenedAt?: Date;
  /** Exact later Experience selected by the trusted hardening reviewer. */
  hardenedEvidenceId?: string;
  retiredAt?: Date;
  rejectedAt?: Date;
}

export interface FrozenConstitution {
  id: string;
  revision: number;
  digest: string;
  content: string;
}

export interface FrozenPractice {
  id: string;
  practiceId: string;
  revision: number;
  status: 'validated' | 'hardened';
  digest: string;
  trigger: string;
  guidance: string;
}

export interface FrozenExperienceEvidence {
  id: string;
  digest: string;
}

export interface FrozenFactEvidence {
  id: string;
  digest: string;
  scope: 'user' | 'agent' | 'app';
}

/** Governance selected at the Turn seam. Config edits affect only later Frames. */
export interface FrozenLearningPolicy {
  experienceRecording: boolean;
  experienceRecallLimit: number;
  experienceAdmission: 'reviewed' | 'automatic';
  practiceAcquisition: 'disabled' | 'reviewed' | 'automatic';
  allowScopedEvidencePromotion: boolean;
}

/** Byte format used to render the protected Constitution/Practice prompt. */
export type ProtectedLearningPromptVersion = 1 | 2;

/** The immutable Learning inputs frozen for one Session/Agent/trigger tuple. */
export interface AgentMemoryFrame {
  _id: string;
  sessionId: string;
  agentId: string;
  triggerSeq: number;
  /** Summary of the Turn trigger; not an Experience/Practice context selector. */
  context: string;
  /** Immutable exact-match partition used to select and search Experience. */
  audience: ExperienceAudience;
  constitution?: FrozenConstitution;
  practices: FrozenPractice[];
  experiences: FrozenExperienceEvidence[];
  /** Missing on legacy Frames, which fail safe to reviewed/disabled behavior. */
  learningPolicy?: FrozenLearningPolicy;
  factMemory: {
    evidence: FrozenFactEvidence[];
    /** Digest only: exact Fact prompt bytes stay Turn-local for erasure/privacy. */
    promptDigest: string;
  };
  /**
   * Frozen protected-prompt byte format. Missing on legacy Frames; their
   * stored prompt digest selects a retained legacy renderer.
   */
  protectedPromptVersion?: ProtectedLearningPromptVersion;
  /** Digest of the exact Constitution/Practice learning prompt bytes. */
  protectedPromptDigest: string;
  digest: string;
  createdAt: Date;
}

export type AgentLearningEventKind =
  | 'identity-created'
  | 'identity-updated'
  | 'constitution-revised'
  | 'identity-lifecycle-changed'
  | 'experience-recorded'
  | 'experience-retracted'
  | 'practice-proposed'
  | 'practice-transitioned'
  | 'learning-reviewed'
  | 'memory-frame-frozen'
  | 'provider-requested';

export interface AgentLearningEvent {
  _id: string;
  agentId: string;
  kind: AgentLearningEventKind;
  targetType: 'identity' | 'constitution' | 'experience' | 'practice' | 'memory-frame';
  targetId: string;
  from?: string;
  to?: string;
  source: LearningSource;
  /** Full canonical source identity; indexed with Agent + kind. */
  sourceDigest: string;
  /** Canonical digest of the full command, used to reject idempotency-key reuse. */
  commandDigest: string;
  reason?: string;
  at: Date;
  details?: Record<string, unknown>;
}

export interface IdentityConfig {
  id: string;
  name: string;
  displayName?: string;
  aliases?: string[];
  flexibility?: number;
  /** Optional immutable revision 1, created atomically with a new Identity. */
  constitution?: string;
}

export type ExperienceConfig = boolean | {
  record?: boolean;
  recall?: false | { recent?: number };
  /** Exact Experience partition. Defaults to `identity`. */
  scope?: ExperienceScope;
  /** Model proposals wait by default. `auto` records immediately, pending audit. */
  approval?: LearningApprovalMode;
};

export interface ResolvedExperience {
  record: boolean;
  recall: false | { recent: number };
  scope: ExperienceScope;
  /** Missing only on callers compiled against the pre-governance resolved shape. */
  approval?: LearningApprovalMode;
}

/** Agent-authored Practice acquisition. Candidates never apply until validated. */
export type PracticeConfig = boolean | {
  acquire?: boolean;
  /** `auto` validates a new candidate as a trial; it never hardens it. */
  approval?: LearningApprovalMode;
  /** Explicit consent to promote owner/chat evidence into identity-wide guidance. */
  allowScopedEvidencePromotion?: boolean;
};

export interface ResolvedPractice {
  acquire: boolean;
  approval: LearningApprovalMode;
  allowScopedEvidencePromotion: boolean;
}

export interface RecordExperienceInput {
  agentId: string;
  expectationBasis: ExperienceExpectationBasis;
  expected: string;
  observed: string;
  difference: string;
  lesson: string;
  context: string;
  confidence: number;
  source: ExperienceSource;
  /** Trusted server override. Model records must match their frozen Frame. */
  audience?: ExperienceAudience;
  frameId?: string;
  /** Trusted runtime decision; never accepted from model arguments. */
  admission?: LearningAdmission;
}

export interface ProposePracticeInput {
  agentId: string;
  key: string;
  trigger: string;
  guidance: string;
  context: string;
  /** 1-50 distinct, stable Experience ids; all must match Agent and context. */
  evidenceIds: string[];
  source: LearningSource;
  /** Required for model proposals and closed over by the runtime. */
  frameId?: string;
}

export interface ReviewLearningInput {
  agentId: string;
  target: 'experience' | 'practice';
  id: string;
  source: LearningSource;
  reason?: string;
}

export interface FactMemorySnapshotInput {
  /** Exact Turn-local standing Fact Memory prompt; never persisted in a Frame. */
  text: string;
  /** Exact rows represented by the standing block and any rendered hint titles. */
  rows: Array<{
    _id: string;
    scope: 'user' | 'agent' | 'app';
    text: string;
  }>;
}

export interface FreezeMemoryFrameInput {
  sessionId: string;
  agentId: string;
  triggerSeq: number;
  context: string;
  /** Defaults to `{ scope: 'identity', key: agentId }`. */
  audience?: ExperienceAudience;
  experienceLimit?: number;
  practiceLimit?: number;
  learningPolicy?: FrozenLearningPolicy;
  factMemory?: FactMemorySnapshotInput;
  source?: LearningSource;
}

export interface LearningMutationResult<T> {
  value: T;
  changed: boolean;
  replayed: boolean;
}

export interface LearningAudit {
  identity?: AgentIdentity;
  constitution?: AgentConstitution;
  counts: {
    activeExperiences: number;
    retractedExperiences: number;
    candidatePractices: number;
    validatedPractices: number;
    hardenedPractices: number;
    retiredPractices: number;
    rejectedPractices: number;
    frames: number;
    events: number;
  };
  /** Expected information loss, such as Session-erased Frame provenance. */
  notices: string[];
  integrity: { ok: boolean; issues: string[] };
}

export const LEARNING_TEXT_MAX = 2_000;
export const LEARNING_CONTEXT_MAX = 256;
export const EXPERIENCE_RECALL_DEFAULT = 4;
export const EXPERIENCE_RECALL_MAX = 20;
export const EXPERIENCE_AUTOMATIC_REVIEW_MAX = 100;
export const PRACTICE_EVIDENCE_MAX = 50;
export const PRACTICE_CANDIDATE_MAX = 25;
export const PRACTICE_AUTOMATIC_REVIEW_MAX = 25;
export const PRACTICE_FRAME_DEFAULT = 32;
export const PRACTICE_FRAME_MAX = 50;
export const IDENTITY_FLEXIBILITY_DEFAULT = 3;
