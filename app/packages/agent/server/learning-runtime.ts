import type { AgentMessage, AgentSession, ResolvedMemory } from '../common/types';
import type {
  ExperienceAudience, ExperienceScope, IdentityConfig, ResolvedExperience, ResolvedPractice,
} from '../common/learning';
import { AgentMessages } from '../common/collections';
import { modelParticipantId, resolveAddressee } from '../common/participants';
import { memoryBlockSnapshot, memoryHintSnapshot } from './memory';
import {
  buildProtectedLearningPrompt, canonicalDigest, ensureAgentIdentity,
  freezeMemoryFrame, memoryFrameId,
} from './learning';
import { AgentMemoryFrames } from './learning-collections';

/** The small Turn-facing Interface to the deeper Learning Modules. A Turn
 * receives one immutable Frame plus the exact Fact Memory bytes proven against
 * that Frame; it does not know how Identity, Practice, or Experience are stored. */
export interface TurnLearningSnapshot {
  agentId: string;
  memoryFrameId: string;
  triggerSeq: number;
  frame: Awaited<ReturnType<typeof freezeMemoryFrame>>['value'];
  protectedSystem: string;
  factMemoryText: string;
}

export interface PrepareTurnLearningOptions {
  session: AgentSession;
  agentName: string;
  identity: IdentityConfig;
  experience?: ResolvedExperience;
  practice?: ResolvedPractice;
  factMemory?: ResolvedMemory;
}

function triggerForAgent(
  message: AgentMessage, session: AgentSession, agentName: string,
): boolean {
  if (message.role === 'assistant') {
    return message.to === modelParticipantId(agentName);
  }
  if (message.role === 'system') {
    // New system rows durably name their target because `pendingSystem` is
    // consumed by the Turn's first commit. For older rows, a parked approval
    // still carries the running Agent; an unconsumed intent carries it next.
    if (message.to !== undefined) return message.to === modelParticipantId(agentName);
    return (session.pending?.agent ?? session.pendingSystem?.agent ?? session.agent) === agentName;
  }
  if (message.role !== 'user') return false;
  if (!session.participants?.length) return session.agent === agentName;
  const addressee = resolveAddressee(message.content, message.to, session);
  // An unaddressed user message follows the Session's ordinary routing rule:
  // it activates the primary Agent. Explicit addresses remain isolated to the
  // selected participant.
  return addressee ? addressee.agent === agentName : session.agent === agentName;
}

function frameContext(message: AgentMessage): string {
  const text = (message.content ?? `${message.role} trigger`)
    .replace(/\s+/g, ' ').trim();
  return (text || `${message.role} trigger`).slice(0, 256);
}

/** Resolve a config scope to one immutable Turn audience. Owner scope never
 * persists an empty/anonymous owner key; anonymous owners are Session-local. */
export function resolveTurnExperienceAudience(
  agentId: string, session: Pick<AgentSession, '_id' | 'userId'>,
  scope: ExperienceScope,
): ExperienceAudience {
  if (scope === 'identity') return { scope, key: agentId };
  if (scope === 'owner' && typeof session.userId === 'string'
    && session.userId.trim().length > 0) {
    return { scope, key: session.userId };
  }
  return { scope: 'session', key: session._id };
}

function sameFactEvidence(
  frame: TurnLearningSnapshot['frame'],
  rows: Array<{ _id: string; scope: 'user' | 'agent' | 'app'; text: string }>,
): boolean {
  const expected = frame.factMemory.evidence
    .map((item) => `${item.id}:${item.scope}:${item.digest}`).sort();
  const actual = rows.map((row) => (
    `${row._id}:${row.scope}:${canonicalDigest({ id: row._id, scope: row.scope, text: row.text })}`
  )).sort();
  return canonicalDigest(expected) === canonicalDigest(actual);
}

function assertFactSnapshot(
  frame: TurnLearningSnapshot['frame'], text: string,
  rows: Array<{ _id: string; scope: 'user' | 'agent' | 'app'; text: string }>,
): void {
  if (canonicalDigest(text) !== frame.factMemory.promptDigest
    || !sameFactEvidence(frame, rows)) {
    throw new Error(
      '[10thfloor:agent] frozen Fact Memory changed before Frame recovery; '
      + 'the Turn is stopped rather than mixing causal snapshots',
    );
  }
}

/** Freeze or adopt one Agent/Session/trigger Frame before paid Provider work.
 * Existing Frames win over mutable current state. Fact prompt bytes are not
 * duplicated durably for privacy; recovery therefore re-renders and verifies
 * their digest/evidence, failing closed if the source facts changed. */
export async function prepareTurnLearning(
  options: PrepareTurnLearningOptions,
): Promise<TurnLearningSnapshot | undefined> {
  const ensured = await ensureAgentIdentity(options.identity);
  if (ensured.value.lifecycle !== 'active') {
    throw new Error('[10thfloor:agent] archived Agent Identity cannot start a Turn');
  }
  const agentId = ensured.value._id;
  const audience = resolveTurnExperienceAudience(
    agentId, options.session, options.experience?.scope ?? 'identity',
  );
  const messages = await AgentMessages.find(
    { sessionId: options.session._id }, { sort: { seq: 1 } },
  ).fetchAsync();
  const trigger = [...messages].reverse()
    .find((message) => triggerForAgent(message, options.session, options.agentName));
  const latest = await AgentMemoryFrames.findOneAsync(
    { sessionId: options.session._id, agentId }, { sort: { triggerSeq: -1 } },
  );
  const triggerSeq = trigger?.seq ?? latest?.triggerSeq;
  if (triggerSeq === undefined) {
    throw new Error('[10thfloor:agent] identity-enabled Turn has no durable trigger');
  }
  const id = memoryFrameId(options.session._id, agentId, triggerSeq);
  const existing = await AgentMemoryFrames.findOneAsync(id);

  let factMemoryText = '';
  let factRows: Array<{ _id: string; scope: 'user' | 'agent' | 'app'; text: string }> = [];
  // Children deliberately receive Constitution/Practice/Experience but no
  // inherited person/work Fact Memory.
  if (options.factMemory && !options.session.parent) {
    const query = trigger?.content ?? '';
    const hint = options.factMemory.hints && query
      ? await memoryHintSnapshot(query, {
        userId: options.session.userId, agent: options.agentName,
        config: options.factMemory,
      }) : { titles: [], rows: [] };
    const snapshot = await memoryBlockSnapshot({
      userId: options.session.userId,
      agent: options.agentName,
      config: options.factMemory,
      ...(hint.titles.length ? { hint: hint.titles } : {}),
    });
    factMemoryText = snapshot.text;
    const evidence = new Map(
      [...snapshot.rows, ...hint.rows].map((row) => [row._id, row]),
    );
    factRows = [...evidence.values()].map((row) => ({
      _id: row._id, scope: row.scope, text: row.text,
    }));
  }

  if (existing) {
    assertFactSnapshot(existing, factMemoryText, factRows);
    return {
      agentId, memoryFrameId: existing._id, triggerSeq,
      frame: existing,
      protectedSystem: await buildProtectedLearningPrompt(existing),
      factMemoryText,
    };
  }

  const frozen = await freezeMemoryFrame({
    sessionId: options.session._id,
    agentId,
    triggerSeq,
    context: trigger ? frameContext(trigger) : `trigger ${triggerSeq}`,
    audience,
    experienceLimit: options.experience?.recall
      ? options.experience.recall.recent : 0,
    learningPolicy: {
      experienceRecording: options.experience?.record === true,
      experienceRecallLimit: options.experience?.recall
        ? options.experience.recall.recent : 0,
      experienceAdmission: options.experience?.approval === 'auto'
        ? 'automatic' : 'reviewed',
      practiceAcquisition: !options.practice?.acquire
        ? 'disabled'
        : options.practice.approval === 'auto' ? 'automatic' : 'reviewed',
      allowScopedEvidencePromotion:
        options.practice?.allowScopedEvidencePromotion === true,
    },
    factMemory: { text: factMemoryText, rows: factRows },
    source: {
      kind: 'system', key: `frame:${options.session._id}:${agentId}:${triggerSeq}`,
      sessionId: options.session._id, triggerSeq,
    },
  });
  // `freezeMemoryFrame` may adopt a concurrent winner for this tuple. Prove
  // the local request bytes against that winner exactly as recovery does.
  assertFactSnapshot(frozen.value, factMemoryText, factRows);
  return {
    agentId, memoryFrameId: frozen.value._id, triggerSeq,
    frame: frozen.value,
    protectedSystem: await buildProtectedLearningPrompt(frozen.value),
    factMemoryText,
  };
}
