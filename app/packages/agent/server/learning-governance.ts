import { Meteor } from 'meteor/meteor';
import { createHash } from 'crypto';
import type { Mongo } from 'meteor/mongo';
import { NAMES } from '../common/names';
import type {
  AgentConstitution, AgentExperience, AgentPractice,
  AgentPracticeNonHardeningStatus, LearningMutationResult, LearningSource,
} from '../common/learning';
import {
  proposePractice, retractExperience, reviewLearning, reviseConstitution,
  transitionPractice,
} from './learning';
import {
  AgentConstitutions, AgentExperiences, AgentIdentities, AgentMemoryFrames,
  AgentPractices,
} from './learning-collections';

/* Host-callable learning governance. Hosts authorize the caller (ownership,
 * workspace membership) and hand already-authorized inputs here; this module
 * owns shape validation, idempotency-key derivation, and the translation of
 * governance refusals into structured Meteor.Error codes, so no host has to
 * hand-roll sha256 keys or string-match internal error messages. */

/** Deterministic app-side idempotency source. Meteor may transparently replay
 *  a method after reconnect; binding the key to the requested command lets an
 *  identical replay adopt its first result, while reuse for different content
 *  fails inside the Learning Module. `namespace` is the host's stable prefix
 *  (its keys must not collide with another host's or with model sources). */
export function hostLearningSource(
  namespace: string, action: string, agentId: string, command: unknown,
): LearningSource {
  const digest = createHash('sha256').update(JSON.stringify(command ?? null)).digest('hex');
  return { kind: 'app', key: `${namespace}:${action}:${agentId}:${digest}` };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Meteor.Error('invalid-args', `${name} must be a string.`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Meteor.Error('invalid-args', `${name} must be a number.`);
  }
  return value;
}

/** Input contract shared by hosts and `governedLearningReview`. Exported so a
 *  host method can refuse a malformed target before doing authorization work. */
export function assertLearningReviewTarget(
  target: unknown,
): asserts target is 'experience' | 'practice' {
  if (target !== 'experience' && target !== 'practice') {
    throw new Meteor.Error('invalid-learning-review', 'Unknown learning review target.');
  }
}

/** Input contract shared by hosts and `governedPracticeTransition`: hardening
 *  needs its exact proof Experience, and nothing else may carry one. */
export function assertPracticeTransitionEvidence(
  status: unknown, hardeningEvidenceId: unknown,
): void {
  if (status === 'hardened'
    && (typeof hardeningEvidenceId !== 'string' || !hardeningEvidenceId.trim())) {
    throw new Meteor.Error(
      'invalid-practice-transition',
      'Select the exact later Experience used to harden this Practice.',
    );
  }
  if (status !== 'hardened' && hardeningEvidenceId !== undefined) {
    throw new Meteor.Error(
      'invalid-practice-transition',
      'Hardening evidence is accepted only when hardening a Practice.',
    );
  }
}

/** Revise an Agent's Constitution on behalf of an authorized host caller.
 *  Generation CAS loss is an expected editing outcome, so it surfaces as a
 *  structured code clients can branch on — never as message text to match. */
export async function governedConstitutionRevise(
  namespace: string, agentIdInput: unknown, expectedGenerationInput: unknown,
  bodyInput: unknown, reasonInput: unknown,
): Promise<LearningMutationResult<AgentConstitution>> {
  const agentId = requireString(agentIdInput, 'agentId');
  const expectedGeneration = requireNumber(expectedGenerationInput, 'expectedGeneration');
  const body = requireString(bodyInput, 'body');
  const reason = requireString(reasonInput, 'reason');
  try {
    return await reviseConstitution(
      agentId,
      expectedGeneration,
      body,
      reason,
      hostLearningSource(namespace, 'constitution-revise', agentId, {
        expectedGeneration, body, reason,
      }),
    );
  } catch (error) {
    if (!(error instanceof Meteor.Error)
      && String((error as Error)?.message ?? error).includes('identity-generation-conflict')) {
      throw new Meteor.Error(
        'identity-generation-conflict',
        'The Constitution changed after this draft started. Rebase it onto the latest version.',
      );
    }
    throw error;
  }
}

/** Retract one Experience with a durable reason, for an authorized host caller. */
export async function governedExperienceRetract(
  namespace: string, agentIdInput: unknown, experienceIdInput: unknown, reasonInput: unknown,
): Promise<LearningMutationResult<AgentExperience>> {
  const agentId = requireString(agentIdInput, 'agentId');
  const experienceId = requireString(experienceIdInput, 'experienceId');
  const reason = requireString(reasonInput, 'reason');
  return retractExperience(
    agentId,
    experienceId,
    reason,
    hostLearningSource(namespace, 'experience-retract', agentId, { experienceId, reason }),
  );
}

/** Acknowledge an automatically admitted record on behalf of the reviewing
 *  person; `actorId` is the host principal accountable for the review. */
export async function governedLearningReview(
  namespace: string, agentIdInput: unknown, target: unknown, targetIdInput: unknown,
  actorIdInput: unknown,
): Promise<LearningMutationResult<AgentExperience | AgentPractice>> {
  const agentId = requireString(agentIdInput, 'agentId');
  assertLearningReviewTarget(target);
  const targetId = requireString(targetIdInput, 'targetId');
  const actorId = requireString(actorIdInput, 'actorId');
  return reviewLearning({
    agentId,
    target,
    id: targetId,
    source: {
      ...hostLearningSource(namespace, 'post-admission-review', agentId, { target, targetId }),
      actorId,
    },
  });
}

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
export async function governedPracticePropose(
  namespace: string, agentIdInput: unknown, proposalInput: unknown,
): Promise<LearningMutationResult<AgentPractice>> {
  const agentId = requireString(agentIdInput, 'agentId');
  if (typeof proposalInput !== 'object' || proposalInput === null) {
    throw new Meteor.Error('invalid-args', 'proposal must be an object.');
  }
  const proposal = proposalInput as GovernedPracticeProposal;
  if (proposal.commandId !== undefined) requireString(proposal.commandId, 'proposal.commandId');
  return proposePractice({
    agentId,
    key: proposal.key as string,
    trigger: proposal.trigger as string,
    guidance: proposal.guidance as string,
    context: proposal.context as string,
    evidenceIds: proposal.evidenceIds as string[],
    source: hostLearningSource(namespace, 'practice-propose', agentId, {
      commandId: proposal.commandId,
      key: proposal.key,
      trigger: proposal.trigger,
      guidance: proposal.guidance,
      context: proposal.context,
      evidenceIds: proposal.evidenceIds,
    }),
  });
}

/** Transition a Practice's lifecycle for an authorized host caller. Governance
 *  refusals from the Learning Module (candidate limits, live revisions, review
 *  backlogs) pass through untouched as their structured Meteor.Error codes. */
export async function governedPracticeTransition(
  namespace: string, agentIdInput: unknown, practiceIdInput: unknown, statusInput: unknown,
  reasonInput: unknown, hardeningEvidenceId?: unknown,
): Promise<LearningMutationResult<AgentPractice>> {
  const agentId = requireString(agentIdInput, 'agentId');
  const practiceId = requireString(practiceIdInput, 'practiceId');
  const status = requireString(statusInput, 'status');
  const reason = requireString(reasonInput, 'reason');
  if (hardeningEvidenceId !== undefined) requireString(hardeningEvidenceId, 'hardeningEvidenceId');
  assertPracticeTransitionEvidence(status, hardeningEvidenceId);
  const source = hostLearningSource(namespace, 'practice-transition', agentId, {
    practiceId,
    status,
    reason,
    ...(status === 'hardened' ? { hardeningEvidenceId } : {}),
  });
  if (status === 'hardened') {
    return transitionPractice(
      agentId, practiceId, status, reason, source, hardeningEvidenceId as string,
    );
  }
  return transitionPractice(
    agentId, practiceId, status as AgentPracticeNonHardeningStatus, reason, source,
  );
}

/* Publication surface. Learning rows are authority-bearing prompt material, so
 * what a browser may see is a reviewed allowlist, not a per-host judgment call. */

/** Per-collection field allowlists (plus ordering and caps) for publishing
 *  learning state to a browser. Internal bookkeeping — event ids, watermarks,
 *  raw digest inputs — stays server-side. */
export const LEARNING_PUBLICATION_VIEWS = {
  identities: {
    fields: {
      generation: 1, experienceSeq: 1, currentName: 1, aliases: 1,
      displayName: 1, lifecycle: 1, constitutionVersionId: 1,
      flexibility: 1, createdAt: 1, updatedAt: 1,
    },
  },
  constitutions: {
    fields: {
      agentId: 1, revision: 1, content: 1, reason: 1, digest: 1,
      'source.kind': 1, 'source.sessionId': 1, 'source.triggerSeq': 1, createdAt: 1,
    },
    sort: { revision: -1 },
    limit: 200,
  },
  experiences: {
    fields: {
      agentId: 1, sequence: 1, expectationBasis: 1,
      expected: 1, observed: 1, difference: 1,
      lesson: 1, context: 1, confidence: 1, status: 1,
      audience: 1, admission: 1,
      'review.at': 1, 'review.reason': 1,
      'review.source.kind': 1, 'review.source.actorId': 1,
      'source.kind': 1, 'source.sessionId': 1, 'source.triggerSeq': 1,
      frameId: 1, createdAt: 1, retractedAt: 1, retractionReason: 1,
    },
    sort: { sequence: -1 },
    limit: 500,
  },
  practices: {
    fields: {
      practiceId: 1, agentId: 1, key: 1, revision: 1, trigger: 1,
      guidance: 1, context: 1, evidenceIds: 1, status: 1,
      frameId: 1, validationAdmission: 1,
      'source.kind': 1, 'source.sessionId': 1, 'source.triggerSeq': 1,
      'transitionSource.kind': 1, 'transitionSource.actorId': 1,
      'review.at': 1, 'review.reason': 1,
      'review.source.kind': 1, 'review.source.actorId': 1,
      createdAt: 1, updatedAt: 1, transitionReason: 1, validatedAt: 1,
      validationWatermark: 1, hardenedAt: 1, hardenedEvidenceId: 1,
      retiredAt: 1, rejectedAt: 1,
    },
    sort: { updatedAt: -1 },
    limit: 500,
  },
  frames: {
    fields: {
      agentId: 1, sessionId: 1, triggerSeq: 1, digest: 1, createdAt: 1,
      context: 1, audience: 1, protectedPromptVersion: 1, protectedPromptDigest: 1,
      learningPolicy: 1,
      'constitution.id': 1, 'constitution.revision': 1, 'constitution.digest': 1,
      'practices.id': 1, 'practices.practiceId': 1, 'practices.revision': 1,
      'practices.status': 1, 'practices.digest': 1,
      'experiences.id': 1, 'experiences.digest': 1,
      'factMemory.promptDigest': 1, 'factMemory.evidence.id': 1,
      'factMemory.evidence.scope': 1, 'factMemory.evidence.digest': 1,
    },
    sort: { createdAt: -1 },
    limit: 100,
  },
} as const;

const PUBLISHED_VIEWS: Array<{
  collection: string;
  cursor: (agentIds: string[]) => Mongo.Cursor<any>;
}> = [
  {
    collection: NAMES.identities,
    cursor: (ids) => AgentIdentities.find(
      { _id: { $in: ids } }, LEARNING_PUBLICATION_VIEWS.identities as any,
    ),
  },
  {
    collection: NAMES.constitutions,
    cursor: (ids) => AgentConstitutions.find(
      { agentId: { $in: ids } }, LEARNING_PUBLICATION_VIEWS.constitutions as any,
    ),
  },
  {
    collection: NAMES.experiences,
    cursor: (ids) => AgentExperiences.find(
      { agentId: { $in: ids } }, LEARNING_PUBLICATION_VIEWS.experiences as any,
    ),
  },
  {
    collection: NAMES.practices,
    cursor: (ids) => AgentPractices.find(
      { agentId: { $in: ids } }, LEARNING_PUBLICATION_VIEWS.practices as any,
    ),
  },
  {
    collection: NAMES.memoryFrames,
    cursor: (ids) => AgentMemoryFrames.find(
      { agentId: { $in: ids } }, LEARNING_PUBLICATION_VIEWS.frames as any,
    ),
  },
];

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
export function createLearningPublisher(sub: LearningSubscription): LearningPublisher {
  let stopped = false;
  const handles: Array<{ stop(): void }> = [];
  const started = new Map<string, Promise<void>>();
  sub.onStop(() => {
    stopped = true;
    for (const handle of handles) handle.stop();
  });
  return {
    get stopped() { return stopped; },
    addAgent(agentId: string): Promise<void> {
      const existing = started.get(agentId);
      if (existing) return existing;
      const pending = Promise.all(PUBLISHED_VIEWS.map(async ({ collection, cursor }) => {
        const handle = await cursor([agentId]).observeChangesAsync({
          added: (id, fields) => {
            if (!stopped) sub.added(collection, id, fields as Record<string, unknown>);
          },
          changed: (id, fields) => {
            if (!stopped) sub.changed(collection, id, fields as Record<string, unknown>);
          },
          removed: (id) => { if (!stopped) sub.removed(collection, id); },
        }) as unknown as { stop(): void };
        // The client may have stopped while the observer was starting.
        if (stopped) handle.stop();
        else handles.push(handle);
      })).then(() => undefined);
      started.set(agentId, pending);
      return pending;
    },
  };
}
