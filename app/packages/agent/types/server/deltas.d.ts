import type { DeltaKind } from '../common/types';
/** Per-turn `tool_args` delta ceiling (256 KiB). AgentDeltas is a shared capped
 *  collection with global FIFO eviction, so one session's argument streaming
 *  is everybody's problem. `tool_args` can't coalesce (interleaved parallel calls). */
export declare const DEFAULT_MAX_TOOL_ARG_BYTES: number;
/** Buffers deltas and flushes on an interval: O(chunk) on the wire, not O(n²).
 *  Exported as a test seam (committed turns delete their deltas). */
export declare class DeltaWriter {
    private sessionId;
    private messageId;
    private msgSeq;
    /** Per-turn ceiling on `tool_args` delta bytes. Past this, `tool_args`
     *  deltas stop; `text`/`thinking` and committed `toolCalls` are unaffected. */
    private maxToolArgBytes;
    /** Model participant whose turn is streaming; absent for 1:1 sessions. */
    private from?;
    private buf;
    private seq;
    private timer;
    /** Non-reentrancy guard: overlapping flushes would scramble insert order. */
    private flushing;
    private pending;
    /** Cumulative `tool_args` bytes accepted; compared against `maxToolArgBytes`. */
    private toolArgBytes;
    /** One warn per turn, not one per dropped chunk. */
    private warnedClamp;
    constructor(sessionId: string, messageId: string, msgSeq: number, flushMs: number, 
    /** Per-turn ceiling on `tool_args` delta bytes. Past this, `tool_args`
     *  deltas stop; `text`/`thinking` and committed `toolCalls` are unaffected. */
    maxToolArgBytes?: number, 
    /** Model participant whose turn is streaming; absent for 1:1 sessions. */
    from?: {
        participant: string;
        name: string;
    } | undefined);
    /** Consecutive same-kind chunks coalesce into one delta document. `seq` is
     *  assigned at push time to stay contiguous (`mergeView` truncates on gaps).
     *  `contentIndex` is part of the coalescing key to keep parallel tool calls apart. */
    push(kind: DeltaKind, chunk: string, contentIndex?: number): void;
    flush(): Promise<void>;
    private drain;
    stop(): Promise<void>;
}
//# sourceMappingURL=deltas.d.ts.map