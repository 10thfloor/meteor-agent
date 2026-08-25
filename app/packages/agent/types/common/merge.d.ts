import type { AgentDelta, AgentMessage, ViewMessage } from './types';
/**
 * Merge committed messages with in-flight deltas into one ordered view.
 *
 * A capped collection evicts the OLDEST documents, so a gap in delta `seq` is
 * always a missing HEAD. Walking forward from seq 0 would render an empty
 * string for any message whose start had aged out — the routine case. We walk
 * back from the highest seq instead and flag `truncatedHead`.
 */
export declare function mergeView(committedMessages: AgentMessage[], deltaDocs: AgentDelta[]): ViewMessage[];
//# sourceMappingURL=merge.d.ts.map