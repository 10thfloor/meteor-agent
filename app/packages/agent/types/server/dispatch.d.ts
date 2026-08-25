import type { AgentSession } from '../common/types';
import { type ResolvedTool } from './tools';
import type { RunConfig } from './loop';
/**
 * Tool-call dispatch: running one committed assistant's batch (`dispatchCalls`),
 * resuming a parked batch after a verdict (`resumeParkedTurn`), and the single
 * `dispatchTool` seam both share.
 *
 * `runTurn` is INJECTED as a parameter rather than imported, deliberately. A
 * subagent tool is a nested turn, so `dispatchTool` needs `runTurn` — but
 * `loop.ts` (which owns `runTurn`) imports `dispatchCalls`/`resumeParkedTurn`
 * from here, so importing `runTurn` back would close a value cycle. Threading
 * it through as `RunTurn` keeps the dispatch → loop edge type-only (`RunConfig`
 * is erased) — the same dependency-injection `runSubagent` already used.
 */
/** The `runTurn` entry point, passed in so `dispatchTool` can start a subagent's
 *  nested turn without a `dispatch -> loop` value import. `loop.ts` passes its
 *  own `runTurn`, whose signature this matches. */
export type RunTurn = (sessionId: string, config: RunConfig) => Promise<void>;
/** Threaded into every dispatch path as one bundle so a future path cannot
 *  forget half of it. */
export interface DispatchLimits {
    maxResultChars: number;
    canUse?: RunConfig['canUse'];
    /** The turn's resolved vision capability (participants spec §9) — answered
     *  once per turn by the loop from `Provider.capabilities.imageInput`,
     *  handed to every tool's ctx. Absent = false = the gate fails closed. */
    imageInput?: boolean;
}
/**
 * What a batch of tool calls did to the turn that owns it.
 *
 * `parked` and `abandoned` both mean the caller must return WITHOUT falling
 * into the think loop — one because someone outside this turn owes us an
 * answer (a human at a gate, or the `agent.send` that clears an interrupt), the
 * other because the turn no longer exists. Only `completed` means every call in
 * the batch now carries a `tool` row, which is the precondition for asking the
 * model what to do next.
 */
export type DispatchOutcome = 'completed' | 'parked' | 'abandoned';
interface TurnAnchor {
    userId: string | null;
    /** The RUNNING agent's name — half of every hook's ctx, the park's
     *  `pending.agent`, and (for a child session) the child's own agent. With
     *  the participants model this is the ADDRESSEE on an addressed turn
     *  (`RunConfig.agentName`), which is exactly why hooks and parks follow it:
     *  an addressee's turn runs the addressee's hook chain and resumes as the
     *  addressee (participants spec decision 6). */
    agent: string;
    /** The committed assistant carrying the `tool_use`s — the discard anchor. */
    messageId: string;
    assistantSeq: number;
    /** EVERY call id of that assistant, not just the ones still to run: a
     *  discard has to take the whole batch's results with it. */
    batchIds: string[];
    /** Attribution for the batch's `tool` rows (participants spec decision 4):
     *  present exactly when the session has a roster, so the per-model
     *  projection can tell whose working to drop. */
    from?: {
        participant: string;
        name: string;
    };
}
/**
 * Dispatch tool calls for one committed assistant, in order, answering each
 * with a `tool` row — or parking the turn on the first call whose gate asks.
 *
 * Shared by the streaming path and the resume path so a call is gated by the
 * SAME rule wherever it is reached: approving one call says nothing about the
 * next one, and a batch resumed after an approval must re-gate its remainder
 * rather than inherit the verdict.
 *
 * Every gate form is decided here and only here — the literal `'auto'`/`'ask'`
 * and the predicate alike (`evaluateGate`). A predicate that refuses answers the
 * call with a structured `denied-by-gate` row and the batch carries on; only an
 * `'ask'` parks.
 */
export declare function dispatchCalls(sessionId: string, calls: Array<{
    id: string;
    name: string;
    args: unknown;
}>, tools: ResolvedTool[], turn: TurnAnchor, budget: RunConfig['budget'], limits: DispatchLimits, runTurn: RunTurn): Promise<DispatchOutcome>;
/**
 * Resolve a parked call whose verdict has been recorded, then finish the rest
 * of its batch.
 *
 * Resolving only the answered call would strand its siblings: the park happens
 * at the FIRST gated call, so every later call in that assistant's batch was
 * never dispatched at all. A `tool_use` with no `tool_result` is a 400 from
 * every provider, forever — so the remainder is re-dispatched here, each call
 * running or parking again on its OWN gate, and the think loop is reached only
 * when the whole batch is answered.
 */
export declare function resumeParkedTurn(sessionId: string, pending: NonNullable<AgentSession['pending']>, tools: ResolvedTool[], userId: string | null, agent: string, budget: RunConfig['budget'], limits: DispatchLimits, runTurn: RunTurn, 
/** The rostered session's attribution stamp (participants spec decision 4)
 *  — the RESUMING model's, which decision 6 guarantees is the parker's. */
from?: {
    participant: string;
    name: string;
}): Promise<DispatchOutcome>;
export {};
//# sourceMappingURL=dispatch.d.ts.map