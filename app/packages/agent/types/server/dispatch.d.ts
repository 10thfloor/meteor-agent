import type { AgentSession } from '../common/types';
import { type ResolvedTool } from './tools';
import type { RunConfig } from './loop';
/** Tool-call dispatch. `runTurn` is injected (not imported) to break the
 *  dispatch -> loop value cycle — same DI pattern as `runSubagent`. */
/** Injected `runTurn` — avoids a dispatch -> loop value import. */
export type RunTurn = (sessionId: string, config: RunConfig) => Promise<void>;
/** Limits threaded through every dispatch path as one bundle. */
export interface DispatchLimits {
    maxResultChars: number;
    canUse?: RunConfig['canUse'];
    /** Vision capability for this turn (absent = false = gate fails closed). */
    imageInput?: boolean;
}
/** parked = awaiting external answer, abandoned = turn gone,
 *  completed = all calls answered (safe to re-enter think loop). */
export type DispatchOutcome = 'completed' | 'parked' | 'abandoned';
interface TurnAnchor {
    userId: string | null;
    /** The running agent (addressee on addressed turns) — hooks and parks
     *  follow this name, so an addressee's turn uses the addressee's chain. */
    agent: string;
    /** Stable experiential identity and the deterministic frame for this
     * trigger. Optional keeps legacy RunConfig callers source compatible. */
    agentId?: string;
    memoryFrameId?: string;
    /** The committed assistant carrying the `tool_use`s — the discard anchor. */
    messageId: string;
    assistantSeq: number;
    /** ALL call ids in the batch — discard needs the whole set. */
    batchIds: string[];
    /** Attribution stamp; present when the session has a roster. */
    from?: {
        participant: string;
        name: string;
    };
}
/** Dispatch calls sequentially, gating each independently. The sole gate
 *  evaluation site — both streaming and resume paths share it. */
export declare function dispatchCalls(sessionId: string, calls: Array<{
    id: string;
    name: string;
    args: unknown;
}>, tools: ResolvedTool[], turn: TurnAnchor, budget: RunConfig['budget'], limits: DispatchLimits, runTurn: RunTurn): Promise<DispatchOutcome>;
/** Resolve a parked call's verdict, then re-dispatch the batch remainder
 *  (each remaining call re-gated independently). */
export declare function resumeParkedTurn(sessionId: string, pending: NonNullable<AgentSession['pending']>, tools: ResolvedTool[], userId: string | null, agent: string, budget: RunConfig['budget'], limits: DispatchLimits, runTurn: RunTurn, 
/** Attribution stamp for the resuming (= parking) agent. */
from?: {
    participant: string;
    name: string;
}, learning?: {
    agentId: string;
    memoryFrameId: string;
}): Promise<DispatchOutcome>;
export {};
//# sourceMappingURL=dispatch.d.ts.map