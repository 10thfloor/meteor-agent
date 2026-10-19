import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage } from '../common/types';
import type { RecordExperienceInput } from '../common/learning';
import { AgentMemoryFrames } from './learning-collections';
import { buildProtectedLearningPrompt, recordExperience } from './learning';
import { activeTraceId, evidenceDigest, evidenceTask, finishAgentTrace, redactEvidence, startAgentTrace } from './evidence';
import { beginSessionMutationOperation, withSessionOperationTransaction, type SessionOperation } from './session-operations';

export type ObservationExperienceDraft = Pick<RecordExperienceInput,
  'expectationBasis' | 'expected' | 'observed' | 'difference' | 'lesson' | 'context' | 'confidence'>;
export interface AgentObservation {
  _id: string; sessionId: string; agentId: string; frameId: string; triggerSeq: number;
  throughSeq: number; summary: string; digest: string;
  sources: Array<{ id: string; seq: number; role: string; digest: string }>;
  status: 'recorded' | 'candidate' | 'admitting' | 'admitted' | 'dismissed';
  candidate?: ObservationExperienceDraft; experienceId?: string;
  admission?: 'automatic' | 'reviewed'; reviewedBy?: string;
  processing?: boolean; processingUntil?: Date; processingToken?: string; error?: string;
  createdAt: Date; updatedAt: Date;
}
export const AgentObservations = new Mongo.Collection<AgentObservation>(
  'agent_observations', { _preventAutopublish: true } as any,
);
AgentObservations.deny({ insert: () => true, update: () => true, remove: () => true });

export type ObservationResolver = (input: {
  agentId: string; sessionId: string; messages: AgentMessage[];
  priorSummary?: string;
  /** Dedicated background trace: resolver model/token spans can attach here. */
  traceId?: string;
  signal?: AbortSignal;
}) => Promise<{ summary: string; experience?: ObservationExperienceDraft }>;
let resolver: ObservationResolver | undefined;
export type ObservationPolicy = (input: { agentId: string; sessionId: string }) => boolean | Promise<boolean>;
let observationPolicy: ObservationPolicy | undefined;
/** Host-owned summarization adapter. It may use a model or a deterministic
 * domain extractor. Returned learning is always a candidate subject to the
 * exact Turn's frozen admission policy. */
export function setObservationResolver(next?: ObservationResolver): void { resolver = next; }
/** Automatic reflection is off until the host supplies an explicit per-agent
 * policy. Manual Reflect remains a separate user-authorized action. */
export function setObservationPolicy(next?: ObservationPolicy): void { observationPolicy = next; }

/** A completed answer remains immediately available while optional reflection
 * works under its own lifecycle lease. Safe errors stay with the observation. */
export function queueObservationReflection(observationId: string): void {
  if (!resolver || !observationPolicy) return;
  void (async () => {
    const row = await AgentObservations.findOneAsync(observationId);
    if (row && await observationPolicy!({ agentId: row.agentId, sessionId: row.sessionId })) {
      await reflectObservation(observationId);
    }
  })().catch(async () => {
    await evidenceTask(() => AgentObservations.updateAsync({ _id: observationId, processing: { $ne: true } }, { $set: {
      processing: false, error: 'Reflection could not complete. Try again.', updatedAt: new Date(),
    } }));
  });
}

const sourceDigest = (message: AgentMessage) => evidenceDigest({
  role: message.role, content: message.content, toolCalls: message.toolCalls,
  toolCallId: message.toolCallId,
});
const cleanSummary = (text: string) => String(redactEvidence(text)).trim().slice(0, 4000);

/** Deterministic capture is deliberately an extract of evidence, not a claim
 * that every conversational reply is a lesson. Explicit reflection can ask a
 * host resolver to propose meaning afterwards. */
export async function captureObservations(input: {
  sessionId: string; agentId: string; frameId: string; throughSeq: number;
  /** Runtime-proven input history plus the final reply. Excludes a human
   * interjection that landed while the model was streaming its answer. */
  sourceMessageIds?: string[];
}): Promise<AgentObservation> {
  const frame = await AgentMemoryFrames.findOneAsync({
    _id: input.frameId, sessionId: input.sessionId, agentId: input.agentId,
  });
  const session = await AgentSessions.findOneAsync({
    _id: input.sessionId, erasingAt: { $exists: false }, purgingAt: { $exists: false },
  });
  if (!frame || !session || !Number.isInteger(input.throughSeq) || input.throughSeq < frame.triggerSeq) {
    throw new Error('Observation source is no longer available.');
  }
  await buildProtectedLearningPrompt(frame);
  const range = await AgentMessages.find({ sessionId: input.sessionId,
    seq: { $gte: frame.triggerSeq, $lte: input.throughSeq } }, { sort: { seq: 1 }, limit: 500 }).fetchAsync();
  const selected = input.sourceMessageIds ? new Set(input.sourceMessageIds) : undefined;
  const messages = selected ? range.filter(({ _id }) => selected.has(_id)) : range;
  if (!messages.length || messages[messages.length - 1].seq !== input.throughSeq) {
    throw new Error('Observation needs a committed source range.');
  }
  const sources = messages.map((message) => ({ id: message._id, seq: message.seq,
    role: message.role, digest: sourceDigest(message) }));
  const _id = `observation_${evidenceDigest({ frame: frame._id, throughSeq: input.throughSeq })}`;
  const standing = await AgentObservations.findOneAsync(_id);
  if (standing) return standing;
  const excerpts = messages.filter((message) => ['user', 'assistant'].includes(message.role) && message.content)
    .map((message) => `${message.from?.name ?? (message.role === 'user' ? 'Request' : 'Reply')}: ${message.content!.slice(0, 1400)}`);
  const now = new Date();
  const observation: AgentObservation = {
    _id, sessionId: input.sessionId, agentId: input.agentId, frameId: input.frameId,
    throughSeq: input.throughSeq, triggerSeq: frame.triggerSeq, summary: cleanSummary(excerpts.join('\n\n')),
    digest: evidenceDigest(sources), sources, status: 'recorded', createdAt: now, updatedAt: now,
  };
  const operation = await beginSessionMutationOperation(input.sessionId);
  if (!operation) throw new Error('The source conversation is no longer available.');
  try {
    await withSessionOperationTransaction(operation, async (mongoSession) => {
      await AgentObservations.rawCollection().updateOne({ _id }, { $setOnInsert: { ...observation } },
        { upsert: true, session: mongoSession });
    });
  } finally { await operation.close(); }
  return (await AgentObservations.findOneAsync(_id))!;
}

async function verifiedSources(observation: AgentObservation): Promise<AgentMessage[]> {
  const session = await AgentSessions.findOneAsync({ _id: observation.sessionId,
    erasingAt: { $exists: false }, purgingAt: { $exists: false } });
  if (!session) throw new Error('The source conversation is no longer available.');
  const messages = await AgentMessages.find({ sessionId: observation.sessionId,
    _id: { $in: observation.sources.map(({ id }) => id) } }, { sort: { seq: 1 } }).fetchAsync();
  if (messages.length !== observation.sources.length || observation.sources.some((source) => {
    const message = messages.find(({ _id }) => _id === source.id);
    return !message || message.seq !== source.seq || sourceDigest(message) !== source.digest;
  })) throw new Error('Observation source messages changed. Capture the conversation again.');
  return messages;
}

function validateDraft(draft: ObservationExperienceDraft): ObservationExperienceDraft {
  if (!draft || typeof draft !== 'object'
    || !['explicit', 'inferred', 'retrospective'].includes(draft.expectationBasis)
    || !Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
    throw new Error('An experience needs an expectation basis and confidence from 0 to 1.');
  }
  const output = { expectationBasis: draft.expectationBasis, confidence: draft.confidence } as ObservationExperienceDraft;
  for (const field of ['expected', 'observed', 'difference', 'lesson', 'context'] as const) {
    if (typeof draft[field] !== 'string' || !draft[field].trim()
      || draft[field].length > (field === 'context' ? 256 : 2000)) {
      throw new Error(`Experience ${field} is missing or too long.`);
    }
    output[field] = draft[field].trim();
  }
  return output;
}

/** Explicit, host-authorized reflection. Supplying a draft is useful for a
 * human editing an observation; otherwise the registered resolver produces a
 * source-bound summary/candidate. Reviewed policy leaves a candidate for UI
 * approval; automatic policy writes an auditable Experience immediately. */
export async function reflectObservation(observationId: string, options: {
  draft?: ObservationExperienceDraft;
} = {}): Promise<AgentObservation> {
  const row = await AgentObservations.findOneAsync(observationId);
  if (!row) throw new Error('Observation not found.');
  const operation = await beginSessionMutationOperation(row.sessionId);
  if (!operation) throw new Error('The source conversation is no longer available.');
  const now = new Date();
  const processingToken = Random.id();
  const claimed = await AgentObservations.updateAsync({ _id: row._id,
    status: { $in: ['recorded', 'candidate'] },
    $or: [{ processing: { $ne: true } }, { processingUntil: { $lte: now } }],
  }, { $set: { processing: true, processingToken,
    processingUntil: new Date(now.getTime() + 120_000) }, $unset: { error: 1 } });
  if (claimed !== 1) { await operation.close(); return (await AgentObservations.findOneAsync(row._id))!; }
  const session = await AgentSessions.findOneAsync(row.sessionId);
  const trace = await evidenceTask(() => startAgentTrace({ sessionId: row.sessionId,
    agent: session?.agent ?? row.agentId, agentId: row.agentId, memoryFrameId: row.frameId,
    parentTraceId: activeTraceId(row.sessionId), triggerSeq: row.triggerSeq, activate: false }));
  try {
    const result = await reflectActive(row, options, operation, processingToken, trace?._id);
    if (trace) await evidenceTask(() => finishAgentTrace(trace._id, 'completed'));
    return { ...result, processing: false };
  } catch (error) {
    if (trace) await evidenceTask(() => finishAgentTrace(trace._id, 'failed'));
    await AgentObservations.updateAsync({ _id: row._id, processingToken }, { $set: { error: 'Reflection could not complete. Try again.' } });
    throw error;
  } finally {
    try {
      await AgentObservations.updateAsync({ _id: row._id, processingToken }, { $set: { processing: false },
        $unset: { processingUntil: 1, processingToken: 1 } });
    } finally { await operation.close(); }
  }
}

async function reflectActive(row: AgentObservation, options: { draft?: ObservationExperienceDraft },
  operation: SessionOperation, processingToken: string, traceId?: string): Promise<AgentObservation> {
  if (row.status === 'admitted' || row.status === 'dismissed' || row.status === 'admitting') return row;
  const messages = await verifiedSources(row);
  const result = options.draft ? { summary: row.summary, experience: options.draft }
    : resolver ? await resolver({ agentId: row.agentId, sessionId: row.sessionId,
      messages, priorSummary: row.summary, traceId, signal: operation.signal }) : { summary: row.summary };
  if (typeof result?.summary !== 'string' || !result.summary.trim()) throw new Error('Reflection needs a summary.');
  const candidate = result.experience ? validateDraft(result.experience) : undefined;
  const frame = await AgentMemoryFrames.findOneAsync({ _id: row.frameId, agentId: row.agentId, sessionId: row.sessionId });
  if (!frame) throw new Error('The memory snapshot is no longer available.');
  await buildProtectedLearningPrompt(frame);
  if (candidate && !frame.learningPolicy?.experienceRecording) throw new Error('Experience recording was disabled for this turn.');
  // Recheck after an asynchronous resolver: source mutation cannot gain admission.
  await verifiedSources(row);
  await operation.assertActive();
  const saved = await AgentObservations.updateAsync({ _id: row._id, processingToken,
    status: { $in: ['recorded', 'candidate'] },
    updatedAt: row.updatedAt }, { $set: {
    summary: cleanSummary(result.summary), ...(candidate ? { candidate, status: 'candidate' as const } : {}),
    updatedAt: new Date(),
  } });
  if (saved !== 1) throw new Error('Observation changed during reflection. Open it again.');
  const current = (await AgentObservations.findOneAsync(row._id))!;
  if (current.status === 'candidate' && frame.learningPolicy?.experienceAdmission === 'automatic') {
    return admitObservationExperience(current._id, { automatic: true });
  }
  return current;
}

/** Public review door. A principal is required for reviewed admission;
 * automatic admission is available only under the frozen frame policy. */
export async function admitObservationExperience(observationId: string, options: {
  actorId?: string; automatic?: boolean;
}): Promise<AgentObservation> {
  let row = await AgentObservations.findOneAsync(observationId);
  if (!row) throw new Error('Observation not found.');
  if (row.status === 'admitted') return row;
  if (!['candidate', 'admitting'].includes(row.status) || !row.candidate) throw new Error('Reflect on this observation before recording an experience.');
  const operation = await beginSessionMutationOperation(row.sessionId);
  if (!operation) throw new Error('The source conversation is no longer available.');
  try {
  await verifiedSources(row);
  const frame = await AgentMemoryFrames.findOneAsync({ _id: row.frameId, agentId: row.agentId, sessionId: row.sessionId });
  if (!frame?.learningPolicy?.experienceRecording) throw new Error('Experience recording was disabled for this turn.');
  await buildProtectedLearningPrompt(frame);
  const automatic = options.automatic === true;
  if (automatic && frame.learningPolicy.experienceAdmission !== 'automatic') {
    throw new Error('This experience requires a person’s approval.');
  }
  if (!automatic && !options.actorId?.trim()) throw new Error('A reviewer is required.');
  const admission = automatic ? 'automatic' : 'reviewed';
  await operation.assertActive();
  if (row.status === 'candidate') {
    await AgentObservations.updateAsync({ _id: row._id, status: 'candidate', updatedAt: row.updatedAt }, { $set: {
      status: 'admitting', admission, ...(!automatic ? { reviewedBy: options.actorId } : {}), updatedAt: new Date(),
    } });
    row = (await AgentObservations.findOneAsync(row._id))!;
  }
  if (row?.status === 'admitted') return row;
  if (row?.status !== 'admitting' || !row.candidate) throw new Error('Observation changed. Open it again.');
  // Resume the immutable winning admission after a crash or concurrent review.
  // Neither a later edit nor dismissal may race a recorded Experience.
  const claimedAdmission = row.admission!;
  await operation.assertActive();
  const experience = await recordExperience({
    ...validateDraft(row.candidate), agentId: row.agentId, frameId: row.frameId,
    audience: frame.audience, admission: claimedAdmission,
    source: { kind: claimedAdmission === 'automatic' ? 'system' : 'app', key: `observation:${row._id}`,
      sessionId: row.sessionId, triggerSeq: row.triggerSeq,
      ...(claimedAdmission === 'reviewed' ? { actorId: row.reviewedBy } : {}) },
  });
  await operation.assertActive();
  await AgentObservations.updateAsync({ _id: row._id, status: 'admitting' }, { $set: {
    status: 'admitted', experienceId: experience.value._id, updatedAt: new Date(),
  } });
  return (await AgentObservations.findOneAsync(row._id))!;
  } finally { await operation.close(); }
}

export async function dismissObservation(observationId: string, actorId: string): Promise<void> {
  if (!actorId?.trim()) throw new Error('A reviewer is required.');
  await AgentObservations.updateAsync({ _id: observationId, status: { $in: ['recorded', 'candidate'] } },
    { $set: { status: 'dismissed', reviewedBy: actorId, updatedAt: new Date() } });
}
export async function listSessionObservations(sessionId: string): Promise<AgentObservation[]> {
  const rows = await AgentObservations.find({ sessionId }, { sort: { createdAt: -1 }, limit: 100 }).fetchAsync();
  return rows.map(({ processingToken: _token, processingUntil, ...row }) => ({
    ...row, ...(row.processing && processingUntil && processingUntil.getTime() <= Date.now()
      ? { processing: false, error: 'Reflection was interrupted. Try again.' } : {}),
  }));
}
/** Exact original transcript rows; host must authorize their conversation. */
export async function readObservationSources(observationId: string): Promise<AgentMessage[]> {
  const row = await AgentObservations.findOneAsync(observationId);
  if (!row) throw new Error('Observation not found.');
  return verifiedSources(row);
}
export async function ensureObservationIndexes(): Promise<void> {
  await AgentObservations.rawCollection().createIndex({ sessionId: 1, createdAt: -1 });
}
