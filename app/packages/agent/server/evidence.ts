import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { AgentSessions } from '../common/collections';
import type { AgentMessage } from '../common/types';
import type { AgentMemoryFrame } from '../common/learning';
import type { ResolvedTool, Skill } from './tools';
import { beginSessionMutationOperation, withSessionOperationTransaction } from './session-operations';

export type EvidenceStatus = 'running' | 'completed' | 'waiting' | 'stopped' | 'failed';
export interface AgentTrace {
  _id: string; sessionId: string; agent: string; agentId?: string; memoryFrameId?: string;
  kind: 'turn' | 'reflection';
  triggerSeq?: number; parentTraceId?: string; status: EvidenceStatus; summary: string;
  startedAt: Date; finishedAt?: Date; durationMs?: number;
}
export interface AgentTraceSpan {
  _id: string; traceId: string; sessionId: string; parentSpanId?: string;
  kind: 'model' | 'tool' | 'approval' | 'memory' | 'workflow'; name: string;
  status: EvidenceStatus; summary: string; startedAt: Date; finishedAt?: Date;
  durationMs?: number; inputTokens?: number; outputTokens?: number; cost?: number;
  toolCallId?: string; messageId?: string; requestDigest?: string;
  inputCount?: number; outputCount?: number;
}
export interface AgentTurnManifest {
  _id: string; traceId: string; sessionId: string; agent: string; agentId?: string;
  model: string;
  triggerSeq?: number; memoryFrameId?: string; frameDigest?: string;
  tools: Array<{ name: string; kind: string; gate: string; server?: string }>;
  skills: Array<{ name: string }>;
  memory: {
    constitution?: { id: string; revision: number; digest: string };
    practices: Array<{ id: string; revision: number; digest: string }>;
    facts: Array<{ id: string; scope: string; digest: string }>;
    experiences: Array<{ id: string; digest: string }>;
  };
  sources: Array<{ id: string; seq: number; role: string; digest: string }>;
  createdAt: Date;
}
interface AgentEvidenceDebug {
  _id: string; sessionId: string; traceId: string; spanId: string;
  kind: 'tool-result'; value: unknown; createdAt: Date;
}
export interface EvidenceFeedback {
  _id: string; sessionId: string; traceId: string; actorId: string;
  rating: 'helpful' | 'unhelpful'; note?: string; createdAt: Date; updatedAt: Date;
}

const privateOptions = { _preventAutopublish: true } as any;
export const AgentTraces = new Mongo.Collection<AgentTrace>('agent_traces', privateOptions);
export const AgentTraceSpans = new Mongo.Collection<AgentTraceSpan>('agent_trace_spans', privateOptions);
export const AgentTurnManifests = new Mongo.Collection<AgentTurnManifest>('agent_turn_manifests', privateOptions);
/** Raw results are server-only. Use listSessionEvidence({ includeDebug: true })
 * to obtain a bounded, credential-redacted debug view after host authorization. */
export const AgentEvidenceDebug = new Mongo.Collection<AgentEvidenceDebug>('agent_evidence_debug', privateOptions);
export const AgentEvidenceFeedback = new Mongo.Collection<EvidenceFeedback>('agent_evidence_feedback', privateOptions);
for (const collection of [AgentTraces, AgentTraceSpans, AgentTurnManifests, AgentEvidenceDebug, AgentEvidenceFeedback]) {
  (collection as any).deny({ insert: () => true, update: () => true, remove: () => true });
}

const activeTraces = new Map<string, string>();
export function activeTraceId(sessionId: string): string | undefined { return activeTraces.get(sessionId); }

async function guardedEvidenceWrite<T>(sessionId: string, work: (session: ClientSession) => Promise<T>): Promise<T> {
  const operation = await beginSessionMutationOperation(sessionId);
  if (!operation) throw new Error('The conversation is no longer available.');
  try { return await withSessionOperationTransaction(operation, work); } finally { await operation.close(); }
}

/** Best-effort observability cannot turn an already executed tool into a retry.
 * Durable action receipts and Memory Frames retain their stricter semantics. */
export async function evidenceTask<T>(work: () => Promise<T>): Promise<T | undefined> {
  try { return await work(); } catch {
    console.warn('[10thfloor:agent] evidence could not be recorded');
    return undefined;
  }
}

export function evidenceDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
}

/** Credential patterns are removed even from opt-in debugging. Prompt and
 * provider request bodies are deliberately never recorded by this module. */
export function redactEvidence(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth limit]';
  if (typeof value === 'string') return value.slice(0, 16_000)
    .replace(/\b(?:sk|pk|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactEvidence(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key, /authorization|cookie|password|secret|api.?key|access.?token|refresh.?token|private.?key/i.test(key)
        ? '[redacted]' : redactEvidence(item, depth + 1),
    ]));
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

export async function startAgentTrace(input: {
  sessionId: string; agent: string; agentId?: string; memoryFrameId?: string;
  triggerSeq?: number; parentTraceId?: string; activate?: boolean;
}): Promise<AgentTrace> {
  const session = await AgentSessions.findOneAsync({
    _id: input.sessionId, erasingAt: { $exists: false }, purgingAt: { $exists: false },
  });
  if (!session) throw new Error('The conversation is no longer available.');
  const { activate, ...fields } = input;
  if (activate !== false) {
    const interrupted = await AgentTraces.find({ sessionId: input.sessionId, kind: 'turn', status: 'running' }).fetchAsync();
    for (const previous of interrupted) {
      const finishedAt = new Date();
      await AgentTraces.updateAsync({ _id: previous._id, status: 'running' }, { $set: {
        status: 'stopped', summary: 'Interrupted before completion', finishedAt,
        durationMs: finishedAt.getTime() - previous.startedAt.getTime(),
      } });
      await AgentTraceSpans.updateAsync({ traceId: previous._id, status: 'running' }, { $set: {
        status: 'stopped', summary: 'Interrupted before completion', finishedAt,
      } }, { multi: true });
    }
  }
  const trace: AgentTrace = {
    _id: Random.id(), ...fields, kind: activate === false ? 'reflection' : 'turn',
    status: 'running', summary: activate === false ? 'Reflecting on conversation' : 'Agent is working', startedAt: new Date(),
    ...(session.parent && activeTraceId(session.parent.sessionId)
      ? { parentTraceId: activeTraceId(session.parent.sessionId) } : {}),
  };
  await guardedEvidenceWrite(input.sessionId, async (session) => {
    await AgentTraces.rawCollection().insertOne(trace, { session });
  });
  if (activate !== false) activeTraces.set(input.sessionId, trace._id);
  return trace;
}

export async function finishAgentTrace(traceId: string, status: EvidenceStatus): Promise<void> {
  const trace = await AgentTraces.findOneAsync(traceId);
  if (!trace) return;
  const finishedAt = new Date();
  const summary = { running: 'Agent is working', completed: trace.kind === 'reflection' ? 'Reflection completed' : 'Reply completed', waiting: 'Waiting for approval',
    stopped: 'Run stopped', failed: 'Run failed' }[status];
  await AgentTraces.updateAsync({ _id: traceId, status: 'running' }, { $set: {
    status, summary, finishedAt, durationMs: finishedAt.getTime() - trace.startedAt.getTime(),
  } });
  if (activeTraceId(trace.sessionId) === traceId) activeTraces.delete(trace.sessionId);
}

export async function startEvidenceSpan(input: {
  sessionId: string; traceId?: string; parentSpanId?: string;
  kind: AgentTraceSpan['kind']; name: string; summary: string;
  toolCallId?: string; messageId?: string;
}): Promise<string | undefined> {
  const traceId = input.traceId ?? activeTraceId(input.sessionId);
  if (!traceId) return undefined;
  const trace = await AgentTraces.findOneAsync({ _id: traceId, sessionId: input.sessionId, status: 'running' });
  if (!trace) return undefined;
  const span: AgentTraceSpan = {
    ...input, _id: Random.id(), traceId, status: 'running', startedAt: new Date(),
    name: String(redactEvidence(input.name)).slice(0, 200),
    summary: String(redactEvidence(input.summary)).slice(0, 500),
  };
  await guardedEvidenceWrite(input.sessionId, async (session) => {
    await AgentTraceSpans.rawCollection().insertOne(span, { session });
  });
  return span._id;
}

export async function finishEvidenceSpan(spanId: string | undefined, input: {
  status: EvidenceStatus; summary: string; inputTokens?: number; outputTokens?: number;
  cost?: number; requestDigest?: string; inputCount?: number; outputCount?: number;
}): Promise<void> {
  if (!spanId) return;
  const span = await AgentTraceSpans.findOneAsync(spanId);
  if (!span) return;
  const finishedAt = new Date();
  await AgentTraceSpans.updateAsync({ _id: spanId, status: 'running' }, { $set: {
    ...input, summary: String(redactEvidence(input.summary)).slice(0, 500),
    finishedAt, durationMs: finishedAt.getTime() - span.startedAt.getTime(),
  } });
}

export async function captureToolAudit(spanId: string | undefined, value: unknown): Promise<void> {
  if (!spanId) return;
  const span = await AgentTraceSpans.findOneAsync(spanId);
  if (!span) return;
  // Bounded JSON copy prevents circular values and prototype/getter persistence.
  let safe: unknown;
  try { safe = JSON.parse(JSON.stringify(redactEvidence(value))); } catch { safe = '[unserializable result]'; }
  const operation = await beginSessionMutationOperation(span.sessionId);
  if (!operation) return;
  try {
    await withSessionOperationTransaction(operation, async (mongoSession) => {
      await AgentEvidenceDebug.rawCollection().updateOne({ _id: spanId }, { $setOnInsert: {
        sessionId: span.sessionId, traceId: span.traceId, spanId,
        kind: 'tool-result', value: safe, createdAt: new Date(),
      } }, { upsert: true, session: mongoSession });
    });
  } finally { await operation.close(); }
}

export async function captureTurnManifest(input: {
  traceId: string; sessionId: string; agent: string; model: string; tools: ResolvedTool[];
  skills?: Skill[]; frame?: AgentMemoryFrame; messages: AgentMessage[];
}): Promise<AgentTurnManifest> {
  const frame = input.frame;
  const manifest: AgentTurnManifest = {
    _id: input.traceId, traceId: input.traceId, sessionId: input.sessionId, agent: input.agent, model: input.model,
    ...(frame ? { agentId: frame.agentId, triggerSeq: frame.triggerSeq,
      memoryFrameId: frame._id, frameDigest: frame.digest } : {}),
    tools: input.tools.map((tool) => ({ name: tool.name, kind: tool.kind,
      gate: typeof tool.gate === 'function' ? 'conditional' : tool.gate,
      ...(tool.mcp ? { server: tool.mcp.server } : {}) })),
    skills: (input.skills ?? []).map((skill) => ({ name: skill.name })),
    memory: {
      ...(frame?.constitution ? { constitution: {
        id: frame.constitution.id, revision: frame.constitution.revision, digest: frame.constitution.digest,
      } } : {}),
      practices: (frame?.practices ?? []).map(({ id, revision, digest }) => ({ id, revision, digest })),
      facts: (frame?.factMemory.evidence ?? []).map(({ id, scope, digest }) => ({ id, scope, digest })),
      experiences: (frame?.experiences ?? []).map(({ id, digest }) => ({ id, digest })),
    },
    sources: input.messages.map((message) => ({ id: message._id, seq: message.seq,
      role: message.role, digest: evidenceDigest({ role: message.role, content: message.content,
        toolCalls: message.toolCalls, toolCallId: message.toolCallId }) })),
    createdAt: new Date(),
  };
  await guardedEvidenceWrite(input.sessionId, async (session) => {
    await AgentTurnManifests.rawCollection().updateOne({ _id: manifest._id }, { $setOnInsert: { ...manifest } }, { upsert: true, session });
  });
  return (await AgentTurnManifests.findOneAsync(manifest._id))!;
}

/** Host-facing read API. The host MUST authorize session membership before
 * calling; no Meteor method or publication is registered implicitly. */
export async function listSessionEvidence(sessionId: string, options: { includeDebug?: boolean; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
  const traces = await AgentTraces.find({ sessionId }, { sort: { startedAt: -1 }, limit }).fetchAsync();
  const traceIds = traces.map(({ _id }) => _id);
  const [spans, manifests, debug, feedback] = await Promise.all([
    AgentTraceSpans.find({ sessionId, traceId: { $in: traceIds } }, { sort: { startedAt: 1 }, limit: 2000 }).fetchAsync(),
    AgentTurnManifests.find({ sessionId, traceId: { $in: traceIds } }, { sort: { createdAt: -1 }, limit }).fetchAsync(),
    options.includeDebug === true
      ? AgentEvidenceDebug.find({ sessionId, traceId: { $in: traceIds } }, { limit: 200 }).fetchAsync()
      : Promise.resolve(undefined),
    AgentEvidenceFeedback.find({ sessionId, traceId: { $in: traceIds } }, { limit: 1000 }).fetchAsync(),
  ]);
  return { traces, spans, manifests, feedback, ...(debug ? { debug: redactEvidence(debug) } : {}) };
}

/** Host-authorized feedback, one editable verdict per person and run. */
export async function recordEvidenceFeedback(input: {
  traceId: string; actorId: string; rating: 'helpful' | 'unhelpful'; note?: string;
}): Promise<EvidenceFeedback> {
  if (!input.actorId?.trim() || !['helpful', 'unhelpful'].includes(input.rating)
    || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000))) {
    throw new Error('Feedback needs a reviewer and a helpful or unhelpful rating.');
  }
  const trace = await AgentTraces.findOneAsync(input.traceId);
  if (!trace) throw new Error('Run not found.');
  const _id = `feedback_${evidenceDigest({ traceId: input.traceId, actorId: input.actorId })}`;
  const now = new Date();
  const operation = await beginSessionMutationOperation(trace.sessionId);
  if (!operation) throw new Error('The conversation is no longer available.');
  try {
    await withSessionOperationTransaction(operation, async (mongoSession) => {
      await AgentEvidenceFeedback.rawCollection().updateOne({ _id }, {
        $setOnInsert: { sessionId: trace.sessionId, traceId: input.traceId,
          actorId: input.actorId, createdAt: now },
        $set: { rating: input.rating, note: String(redactEvidence(input.note ?? '')).trim(), updatedAt: now },
      }, { upsert: true, session: mongoSession });
    });
  } finally { await operation.close(); }
  return (await AgentEvidenceFeedback.findOneAsync(_id))!;
}

export async function ensureEvidenceIndexes(): Promise<void> {
  await Promise.all([
    AgentTraces.rawCollection().createIndex({ sessionId: 1, startedAt: -1 }),
    AgentTraceSpans.rawCollection().createIndex({ sessionId: 1, traceId: 1, startedAt: 1 }),
    AgentTurnManifests.rawCollection().createIndex({ sessionId: 1, traceId: 1 }),
    AgentEvidenceDebug.rawCollection().createIndex({ sessionId: 1, traceId: 1 }),
    AgentEvidenceFeedback.rawCollection().createIndex({ sessionId: 1, traceId: 1 }),
  ]);
}

export async function eraseSessionEvidence(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) activeTraces.delete(sessionId);
  await Promise.all([AgentTraces, AgentTraceSpans, AgentTurnManifests, AgentEvidenceDebug, AgentEvidenceFeedback]
    .map((collection) => collection.removeAsync({ sessionId: { $in: sessionIds } })));
}
