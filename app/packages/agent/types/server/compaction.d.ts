import { type AgentMessage } from '../common/types';
import type { ProviderMessage, ToolSchema } from './providers/types';
import { type TranscriptView } from './transcript';
import type { RunConfig } from './loop';
/** §9 compaction: context assembly, threshold check, summarization, and
 *  on-demand `compactSession`. `RunConfig` is a type-only import (no cycle). */
/** The newest `kind:'compaction'` note, or null. Only the newest matters:
 *  each compaction's summary already folds the previous one in. */
export declare function latestCompaction(msgs: AgentMessage[]): {
    seq: number;
    summary: string;
    upto: number;
} | null;
/** Build the model's context view: compaction summary + messages after `upto`,
 *  or the full transcript if uncompacted. `view` is the participant projection. */
export declare function assembleContext(msgs: AgentMessage[], view?: TranscriptView): ProviderMessage[];
/** Estimated context tokens: max of last reported input and chars/4.
 *  Errs high (compacts early) rather than low (never compacts). */
export declare function estimateContext(assembled: ProviderMessage[], lastReportedInput?: number): number;
/** Find the seq to compact up to, keeping `keep` tail messages. Uses
 *  `batchSafeBoundary` so the cut never splits tool_use from its tool_result. */
export declare function findCompactionCut(msgs: AgentMessage[], keep: number): number | null;
/** Compact if estimated context exceeds `window * compactAt`. Failure is
 *  degraded, never fatal. Returns true when a compaction note was committed. */
export declare function maybeCompact(sessionId: string, agent: string, config: RunConfig, history: AgentMessage[], schemas?: ToolSchema[], interruptCheckMs?: number): Promise<boolean>;
/** Result of a manual compaction. Meteor-free; callers map to `Meteor.Error`. */
export type CompactOutcome = 'compacted' | 'nothing' | 'busy' | 'awaiting' | 'errored' | 'gone' | 'over-budget';
/** Refusal reasons, shared by both call sites. All map to error code `busy`
 *  but carry distinct reasons so the UI can tell the user what to do next. */
export declare const COMPACT_REFUSALS: Partial<Record<CompactOutcome, string>>;
/** Separate from `COMPACT_REFUSALS`: this maps to `budget-exhausted`, not `busy`. */
export declare const COMPACT_OVER_BUDGET = "This session has reached its spend budget; compaction bills like a turn.";
/** On-demand compaction (no threshold). Takes a lease like `runTurn` so it
 *  never interleaves with a live turn; refuses busy/awaiting/errored sessions. */
export declare function compactSession(sessionId: string, config: RunConfig): Promise<CompactOutcome>;
//# sourceMappingURL=compaction.d.ts.map