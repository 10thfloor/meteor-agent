import type { DeltaKind } from '../common/types';
/**
 * The default per-turn `tool_args` delta ceiling: 256 KiB.
 *
 * `AgentDeltas` is a 32 MiB CAPPED collection shared by every session on the
 * deployment, and eviction is global FIFO — so the pressure one session's
 * argument streaming puts on it is everybody's problem.
 *
 * MEASURED (M5 Task 4, `tests/perf.test.ts`): a turn with four parallel tool
 * calls streaming ~20 KB of arguments each, in 200-byte fragments, writes
 * **400 delta documents totalling 80,000 bytes** — 0.24% of the cap. Note the
 * document count: `tool_args` is the one kind coalescing cannot help, because
 * parallel calls arrive INTERLEAVED and `contentIndex` is part of the
 * coalescing key, so no two consecutive fragments ever merge. Its cost scales
 * with the provider's fragment size, not with the response.
 *
 * 256 KiB is therefore a bit over three such turns' worth of headroom per
 * turn: generous for anything real, and a hard stop for a model looping on a
 * JSON fragment.
 */
export declare const DEFAULT_MAX_TOOL_ARG_BYTES: number;
/** Buffers deltas and flushes on an interval so a long response is O(chunk)
 *  on the wire rather than O(n²). */
/** Exported as a TEST SEAM. The loop is its only production caller; the
 *  attribution tests drive it directly because a committed turn deletes its
 *  own deltas, so nothing survives a full run to assert on. */
export declare class DeltaWriter {
    private sessionId;
    private messageId;
    private msgSeq;
    /**
     * Per-TURN ceiling on `tool_args` delta bytes. Display-stream hygiene and
     * nothing more: `AgentDeltas` is a capped collection shared by every
     * session on the deployment, so one model emitting a megabyte of arguments
     * JSON evicts every other session's in-flight tokens. Past the ceiling this
     * writer stops writing `tool_args` deltas; `text` and `thinking` are
     * untouched, and the COMMITTED assistant message's `toolCalls` — the actual
     * dispatch data — never passed through here at all. `Infinity` disables it.
     */
    private maxToolArgBytes;
    /** Streaming attribution (participants spec §4.1): the model participant
     *  whose turn is streaming, stamped on each delta so the in-flight row
     *  can be labelled before it commits. Absent for 1:1 sessions, whose
     *  deltas stay byte-identical to before the field existed. */
    private from?;
    private buf;
    private seq;
    private timer;
    /** Non-reentrancy: the interval fires on a wall clock regardless of whether
     *  the previous flush settled. Two overlapping flushes would interleave
     *  their inserts and scramble the rendered text. */
    private flushing;
    private pending;
    /** Cumulative bytes of `tool_args` chunks ACCEPTED by this writer. Compared
     *  against `maxToolArgBytes`; see `push`. */
    private toolArgBytes;
    /** One warn per turn, not one per dropped chunk. */
    private warnedClamp;
    constructor(sessionId: string, messageId: string, msgSeq: number, flushMs: number, 
    /**
     * Per-TURN ceiling on `tool_args` delta bytes. Display-stream hygiene and
     * nothing more: `AgentDeltas` is a capped collection shared by every
     * session on the deployment, so one model emitting a megabyte of arguments
     * JSON evicts every other session's in-flight tokens. Past the ceiling this
     * writer stops writing `tool_args` deltas; `text` and `thinking` are
     * untouched, and the COMMITTED assistant message's `toolCalls` — the actual
     * dispatch data — never passed through here at all. `Infinity` disables it.
     */
    maxToolArgBytes?: number, 
    /** Streaming attribution (participants spec §4.1): the model participant
     *  whose turn is streaming, stamped on each delta so the in-flight row
     *  can be labelled before it commits. Absent for 1:1 sessions, whose
     *  deltas stay byte-identical to before the field existed. */
    from?: {
        participant: string;
        name: string;
    } | undefined);
    /**
     * `seq` is assigned HERE, in push order, never lazily inside `flush()`.
     * Consecutive same-kind chunks coalesce into one run, so a run of tokens
     * costs a single delta document (one Mongo round trip) instead of one per
     * token — which is what this class's "O(chunk) on the wire" claim means.
     * Coalescing at push time is also what keeps `seq` contiguous: one run, one
     * seq, one document. `mergeView` walks back only while `seq` decrements by
     * exactly 1, so any gap would silently truncate the rendered message.
     *
     * `contentIndex` (tool_args only) is part of the coalescing key, not just a
     * field along for the ride: two PARALLEL tool calls stream interleaved, so
     * merging their fragments because both are `tool_args` would concatenate one
     * call's JSON into the other's and lose the boundary permanently — the
     * delta document is the only place the attribution can still be recorded.
     */
    push(kind: DeltaKind, chunk: string, contentIndex?: number): void;
    flush(): Promise<void>;
    private drain;
    stop(): Promise<void>;
}
//# sourceMappingURL=deltas.d.ts.map