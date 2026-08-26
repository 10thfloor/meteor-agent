import type { AgentDelta, AgentMessage, ViewMessage } from './types';
/** Merge committed messages with in-flight deltas into one ordered view.
 *  Walks back from highest seq (capped eviction loses the head). */
export declare function mergeView(committedMessages: AgentMessage[], deltaDocs: AgentDelta[]): ViewMessage[];
//# sourceMappingURL=merge.d.ts.map