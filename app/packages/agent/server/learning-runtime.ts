import type { AgentMessage, AgentSession, ResolvedMemory } from '../common/types';
import type {
  ExperienceAudience, ExperienceScope, IdentityConfig, ResolvedExperience, ResolvedPractice,
} from '../common/learning';
import { AgentMemories, AgentMessages } from '../common/collections';
import { modelParticipantId, resolveAddressee } from '../common/participants';
import { promptDisplay } from '../common/channel-contract';
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
  // Crew notes promise "no model work" (participants.ts applies the same
  // rule); one landing mid-park must not become the next trigger.
  if (message.kind === 'crew-note') return false;
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
  // Surrogate-safe clamp: a raw slice can split an astral pair, and BSON
  // round-trips the lone surrogate as U+FFFD — bricking the frozen digest.
  // 255 + the appended ellipsis stays within LEARNING_CONTEXT_MAX (256),
  // which `cleanText` enforces by THROWING at frame creation.
  return promptDisplay(text || `${message.role} trigger`, { limit: 255 });
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
    throw new LearningIntegrityError(
      '[10thfloor:agent] frozen Fact Memory changed before Frame recovery; '
      + 'the Turn is stopped rather than mixing causal snapshots',
    );
  }
}

/** Fail-closed: the frozen causes themselves were edited or erased. The park
 *  (if any) is destroyed — resuming would mix causal snapshots. */
export class LearningIntegrityError extends Error {}

/** Retryable: the store could not be read. The park and its recorded verdict
 *  are the repairable state and MUST survive; activation retries the resume. */
export class LearningUnavailableError extends Error {
  readonly transient = true;
}

/** ADR-0001: "recovery re-renders it and fails closed if its evidence or
 *  digest changed." The frozen EVIDENCE is the contract — rows added since
 *  the freeze (including the turn's own `memory_save`, or another session's)
 *  are not this frame's causes and must not void a human's approval. Only an
 *  edit or erasure of a row the frame actually froze fails closed. */
async function assertFrozenEvidenceIntact(
  frame: TurnLearningSnapshot['frame'],
): Promise<void> {
  const evidence = frame.factMemory.evidence;
  if (evidence.length === 0) return;
  let rows: Array<{ _id: string; scope: string; text: string }>;
  try {
    rows = await AgentMemories.find(
      { _id: { $in: evidence.map((item) => item.id) } },
      { fields: { scope: 1, text: 1 } },
    ).fetchAsync() as Array<{ _id: string; scope: string; text: string }>;
  } catch (error) {
    throw new LearningUnavailableError(
      `[10thfloor:agent] frozen Fact Memory could not be read: ${String((error as Error)?.message ?? error)}`,
    );
  }
  const byId = new Map(rows.map((row) => [row._id, row]));
  for (const item of evidence) {
    const row = byId.get(item.id);
    if (!row || canonicalDigest({ id: row._id, scope: row.scope, text: row.text }) !== item.digest) {
      throw new LearningIntegrityError(
        '[10thfloor:agent] frozen Fact Memory changed before Frame recovery; '
        + 'the Turn is stopped rather than mixing causal snapshots',
      );
    }
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

  // A verdict resume is causally anchored: the park marker names the exact
  // Frame the batch was proposed under, so the trigger is never re-derived —
  // rows landing while parked cannot move the approved call to a fresh Frame.
  const pending = options.session.pending;
  const anchored = pending?.verdict && pending.agentId === agentId
    ? pending.memoryFrameId : undefined;
  let trigger: AgentMessage | undefined;
  let triggerSeqCandidate: number | undefined;
  let existing: Awaited<ReturnType<typeof AgentMemoryFrames.findOneAsync>> = undefined;
  if (anchored !== undefined) {
    existing = await AgentMemoryFrames.findOneAsync(anchored);
    if (!existing || existing.agentId !== agentId
      || existing.sessionId !== options.session._id) {
      // Missing, or an anchor pointing at another agent's/session's frame —
      // defense in depth against a corrupted park marker.
      throw new LearningIntegrityError(
        '[10thfloor:agent] the parked batch\'s Memory Frame no longer exists',
      );
    }
    triggerSeqCandidate = existing.triggerSeq;
    trigger = await AgentMessages.findOneAsync({
      sessionId: options.session._id, seq: existing.triggerSeq,
    });
  } else {
    // The trigger is virtually always among the last few rows; fetch a
    // bounded recent window first, falling back to the full transcript only
    // when the window is both full and trigger-free.
    const recent = await AgentMessages.find(
      { sessionId: options.session._id }, { sort: { seq: -1 }, limit: 200 },
    ).fetchAsync();
    trigger = recent
      .find((message) => triggerForAgent(message, options.session, options.agentName));
    if (!trigger && recent.length === 200) {
      const all = await AgentMessages.find(
        { sessionId: options.session._id }, { sort: { seq: 1 } },
      ).fetchAsync();
      trigger = [...all].reverse()
        .find((message) => triggerForAgent(message, options.session, options.agentName));
    }
    const latest = await AgentMemoryFrames.findOneAsync(
      { sessionId: options.session._id, agentId }, { sort: { triggerSeq: -1 } },
    );
    triggerSeqCandidate = trigger?.seq ?? latest?.triggerSeq;
    if (triggerSeqCandidate !== undefined) {
      existing = await AgentMemoryFrames.findOneAsync(
        memoryFrameId(options.session._id, agentId, triggerSeqCandidate),
      );
    }
  }
  if (triggerSeqCandidate === undefined) {
    throw new Error('[10thfloor:agent] identity-enabled Turn has no durable trigger');
  }
  const triggerSeq: number = triggerSeqCandidate;

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
    // Adoption (approval resume, crash recovery, later iterations): verify
    // the frozen EVIDENCE is intact, not that nothing was added since. The
    // turn's own auto-gated `memory_save`, or another session's, must not
    // void a human's approval — only an edit/erasure of a frozen cause does.
    await assertFrozenEvidenceIntact(existing);
    if (existing.factMemory.evidence.length > 0 && factMemoryText === ''
      && options.factMemory && !options.session.parent) {
      // Evidence rows are intact yet the block re-render came back empty —
      // memoryBlockSnapshot swallows store failures. Running the resumed
      // turn with silently missing facts would break the frame's promise.
      throw new LearningUnavailableError(
        '[10thfloor:agent] Fact Memory render unavailable during Frame recovery',
      );
    }
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
