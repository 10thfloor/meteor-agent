import { Mongo } from 'meteor/mongo';
import type { AgentMessage } from '../common/types';
import type { AgentMemoryFrame } from '../common/learning';
import type { ResolvedTool, Skill } from './tools';
export type EvidenceStatus = 'running' | 'completed' | 'waiting' | 'stopped' | 'failed';
export interface AgentTrace {
    _id: string;
    sessionId: string;
    agent: string;
    agentId?: string;
    memoryFrameId?: string;
    kind: 'turn' | 'reflection';
    triggerSeq?: number;
    parentTraceId?: string;
    status: EvidenceStatus;
    summary: string;
    startedAt: Date;
    finishedAt?: Date;
    durationMs?: number;
}
export interface AgentTraceSpan {
    _id: string;
    traceId: string;
    sessionId: string;
    parentSpanId?: string;
    kind: 'model' | 'tool' | 'approval' | 'memory' | 'workflow';
    name: string;
    status: EvidenceStatus;
    summary: string;
    startedAt: Date;
    finishedAt?: Date;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    toolCallId?: string;
    messageId?: string;
    requestDigest?: string;
    inputCount?: number;
    outputCount?: number;
}
export interface AgentTurnManifest {
    _id: string;
    traceId: string;
    sessionId: string;
    agent: string;
    agentId?: string;
    model: string;
    triggerSeq?: number;
    memoryFrameId?: string;
    frameDigest?: string;
    tools: Array<{
        name: string;
        kind: string;
        gate: string;
        server?: string;
    }>;
    skills: Array<{
        name: string;
    }>;
    memory: {
        constitution?: {
            id: string;
            revision: number;
            digest: string;
        };
        practices: Array<{
            id: string;
            revision: number;
            digest: string;
        }>;
        facts: Array<{
            id: string;
            scope: string;
            digest: string;
        }>;
        experiences: Array<{
            id: string;
            digest: string;
        }>;
    };
    sources: Array<{
        id: string;
        seq: number;
        role: string;
        digest: string;
    }>;
    createdAt: Date;
}
interface AgentEvidenceDebug {
    _id: string;
    sessionId: string;
    traceId: string;
    spanId: string;
    kind: 'tool-result';
    value: unknown;
    createdAt: Date;
}
export interface EvidenceFeedback {
    _id: string;
    sessionId: string;
    traceId: string;
    actorId: string;
    rating: 'helpful' | 'unhelpful';
    note?: string;
    createdAt: Date;
    updatedAt: Date;
}
export declare const AgentTraces: Mongo.Collection<AgentTrace, AgentTrace>;
export declare const AgentTraceSpans: Mongo.Collection<AgentTraceSpan, AgentTraceSpan>;
export declare const AgentTurnManifests: Mongo.Collection<AgentTurnManifest, AgentTurnManifest>;
/** Raw results are server-only. Use listSessionEvidence({ includeDebug: true })
 * to obtain a bounded, credential-redacted debug view after host authorization. */
export declare const AgentEvidenceDebug: Mongo.Collection<AgentEvidenceDebug, AgentEvidenceDebug>;
export declare const AgentEvidenceFeedback: Mongo.Collection<EvidenceFeedback, EvidenceFeedback>;
export declare function activeTraceId(sessionId: string): string | undefined;
/** Best-effort observability cannot turn an already executed tool into a retry.
 * Durable action receipts and Memory Frames retain their stricter semantics. */
export declare function evidenceTask<T>(work: () => Promise<T>): Promise<T | undefined>;
export declare function evidenceDigest(value: unknown): string;
/** Credential patterns are removed even from opt-in debugging. Prompt and
 * provider request bodies are deliberately never recorded by this module. */
export declare function redactEvidence(value: unknown, depth?: number): unknown;
export declare function startAgentTrace(input: {
    sessionId: string;
    agent: string;
    agentId?: string;
    memoryFrameId?: string;
    triggerSeq?: number;
    parentTraceId?: string;
    activate?: boolean;
}): Promise<AgentTrace>;
export declare function finishAgentTrace(traceId: string, status: EvidenceStatus): Promise<void>;
export declare function startEvidenceSpan(input: {
    sessionId: string;
    traceId?: string;
    parentSpanId?: string;
    kind: AgentTraceSpan['kind'];
    name: string;
    summary: string;
    toolCallId?: string;
    messageId?: string;
}): Promise<string | undefined>;
export declare function finishEvidenceSpan(spanId: string | undefined, input: {
    status: EvidenceStatus;
    summary: string;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    requestDigest?: string;
    inputCount?: number;
    outputCount?: number;
}): Promise<void>;
export declare function captureToolAudit(spanId: string | undefined, value: unknown): Promise<void>;
export declare function captureTurnManifest(input: {
    traceId: string;
    sessionId: string;
    agent: string;
    model: string;
    tools: ResolvedTool[];
    skills?: Skill[];
    frame?: AgentMemoryFrame;
    messages: AgentMessage[];
}): Promise<AgentTurnManifest>;
/** Host-facing read API. The host MUST authorize session membership before
 * calling; no Meteor method or publication is registered implicitly. */
export declare function listSessionEvidence(sessionId: string, options?: {
    includeDebug?: boolean;
    limit?: number;
}): Promise<{
    traces: AgentTrace[];
    spans: AgentTraceSpan[];
    manifests: AgentTurnManifest[];
    feedback: EvidenceFeedback[];
    debug?: unknown;
}>;
/** Host-authorized feedback, one editable verdict per person and run. */
export declare function recordEvidenceFeedback(input: {
    traceId: string;
    actorId: string;
    rating: 'helpful' | 'unhelpful';
    note?: string;
}): Promise<EvidenceFeedback>;
export declare function ensureEvidenceIndexes(): Promise<void>;
export declare function eraseSessionEvidence(sessionIds: string[]): Promise<void>;
export {};
//# sourceMappingURL=evidence.d.ts.map