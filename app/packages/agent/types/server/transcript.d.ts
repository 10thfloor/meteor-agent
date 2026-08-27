import type { AgentMessage, SessionParticipant } from '../common/types';
import type { ProviderMessage } from './providers/types';
export declare const MAX_PENDING_INPUTS = 64;
/** Projects stored messages into what a provider sees. Omniscient view
 * (no `self`) is for the compaction summarizer. */
export interface TranscriptView {
    /** The running model's participant id; absent = omniscient projection. */
    self?: string;
    /** Attribution default for `from`-less assistant/tool rows. */
    primary: string;
    participants: SessionParticipant[];
}
export declare function toProviderMessages(msgs: AgentMessage[], view?: TranscriptView): ProviderMessage[];
/** One assistant's turn, and the seq range its `tool` rows must live in. */
export interface TurnWindow {
    assistant: AgentMessage;
    /** Seq of the NEXT assistant, or Infinity when this is the last turn. */
    windowEnd: number;
    /** The `toolCallId`s answered by a `tool` row INSIDE this window. */
    answered: Set<string | undefined>;
}
/** Walk boundary backward until no tool_use/tool_result pair is split. */
export declare function batchSafeBoundary(eligible: AgentMessage[], boundary: number): number;
/** Delete an abandoned assistant + its deltas and tool results. Best-effort. */
export declare function discardTurn(sessionId: string, messageId: string, turnSeq: number, toolCallIds?: string[], upperBoundSeq?: number): Promise<void>;
/** Delete any assistant with unanswered tool_use (permanent 400 otherwise).
 * Scans the whole Transcript; returns false if the Lease was lost. */
export declare function repairUnansweredToolUse(sessionId: string): Promise<boolean>;
/** Find the turn window owning a parked tool call id. Newest-first;
 * falls back to answered match for crash recovery. */
export declare function locateBatch(msgs: AgentMessage[], toolCallId: string): TurnWindow | null;
//# sourceMappingURL=transcript.d.ts.map