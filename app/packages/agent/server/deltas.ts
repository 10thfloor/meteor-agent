import { Random } from 'meteor/random';
import { AgentDeltas } from '../common/collections';

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
export const DEFAULT_MAX_TOOL_ARG_BYTES = 256 * 1024;

/** Buffers deltas and flushes on an interval so a long response is O(chunk)
 *  on the wire rather than O(n²). */
/** Exported as a TEST SEAM. The loop is its only production caller; the
 *  attribution tests drive it directly because a committed turn deletes its
 *  own deltas, so nothing survives a full run to assert on. */
export class DeltaWriter {
  private buf: Array<{ kind: string; chunk: string; seq: number; contentIndex?: number }> = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Non-reentrancy: the interval fires on a wall clock regardless of whether
   *  the previous flush settled. Two overlapping flushes would interleave
   *  their inserts and scramble the rendered text. */
  private flushing = false;
  private pending: Promise<void> | null = null;
  /** Cumulative bytes of `tool_args` chunks ACCEPTED by this writer. Compared
   *  against `maxToolArgBytes`; see `push`. */
  private toolArgBytes = 0;
  /** One warn per turn, not one per dropped chunk. */
  private warnedClamp = false;

  constructor(
    private sessionId: string,
    private messageId: string,
    private msgSeq: number,
    flushMs: number,
    /**
     * Per-TURN ceiling on `tool_args` delta bytes. Display-stream hygiene and
     * nothing more: `AgentDeltas` is a capped collection shared by every
     * session on the deployment, so one model emitting a megabyte of arguments
     * JSON evicts every other session's in-flight tokens. Past the ceiling this
     * writer stops writing `tool_args` deltas; `text` and `thinking` are
     * untouched, and the COMMITTED assistant message's `toolCalls` — the actual
     * dispatch data — never passed through here at all. `Infinity` disables it.
     */
    private maxToolArgBytes: number = Infinity,
  ) {
    // The `.catch` is not decoration. A bare `void this.flush()` turns an
    // `insertAsync` rejection into an unhandled promise rejection, which is
    // fatal by default on Node >= 15 — a delta write failure would kill the
    // whole turn, and deltas are ephemeral by design (capped, and superseded
    // by the committed message). Swallow it: the next tick flushes whatever is
    // still buffered, and `stop()` flushes the tail.
    this.timer = setInterval(() => {
      void this.flush().catch(() => { /* ephemeral: the next tick retries */ });
    }, flushMs);
  }

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
  push(kind: string, chunk: string, contentIndex?: number) {
    // `contentIndex` is meaningful for `tool_args` and nothing else — `mergeView`
    // only accumulates per index there. A stray one (a third-party Provider
    // stamping it on a text chunk) is DROPPED rather than thrown: deltas are
    // ephemeral by design and a provider's mistake must not abandon a turn, but
    // carried through it would split one text run into two coalescing buckets
    // and reorder nothing visibly — the worst kind of bug to find later.
    const index = kind === 'tool_args' ? contentIndex : undefined;

    // The clamp. Checked BEFORE coalescing, so a dropped chunk cannot sneak in
    // by being appended to the run already buffered. The chunk that CROSSES the
    // ceiling is written whole (a truncated JSON fragment renders no better
    // than a missing one) and everything after it is dropped, so the decision
    // is monotone and a client's partial-args view simply stops growing.
    if (kind === 'tool_args' && this.maxToolArgBytes !== Infinity) {
      if (this.toolArgBytes >= this.maxToolArgBytes) {
        if (!this.warnedClamp) {
          this.warnedClamp = true;
          console.warn(
            `[10thfloor:agent] session ${this.sessionId}: tool_args deltas exceeded `
            + `maxToolArgBytes (${this.maxToolArgBytes}); the rest of this turn's argument `
            + `streaming is not published. Tool dispatch is unaffected.`,
          );
        }
        return;
      }
      this.toolArgBytes += Buffer.byteLength(chunk, 'utf8');
    }

    const last = this.buf[this.buf.length - 1];
    if (last && last.kind === kind && last.contentIndex === index) {
      last.chunk += chunk;
      return;
    }
    this.buf.push({ kind, chunk, seq: this.seq++, ...(index === undefined ? {} : { contentIndex: index }) });
  }

  flush(): Promise<void> {
    if (this.flushing) return this.pending ?? Promise.resolve();
    if (this.buf.length === 0) return Promise.resolve();
    this.flushing = true;
    this.pending = this.drain().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async drain(): Promise<void> {
    try {
      // Loop rather than snapshot once: chunks pushed while an insert was in
      // flight belong to this flush, not to a tick that may never come.
      while (this.buf.length > 0) {
        const batch = this.buf;
        this.buf = [];
        for (let i = 0; i < batch.length; i += 1) {
          const item = batch[i];
          try {
            await AgentDeltas.insertAsync({
              _id: Random.id(),
              sessionId: this.sessionId,
              messageId: this.messageId,
              msgSeq: this.msgSeq,
              seq: item.seq,
              kind: item.kind as any,
              chunk: item.chunk,
              ...(item.contentIndex === undefined ? {} : { contentIndex: item.contentIndex }),
              at: new Date(),
            } as any);
          } catch (e) {
            // A throw here must not drop the UNWRITTEN remainder: `batch` was
            // already detached from `this.buf` above, so items after `i` —
            // never inserted — would otherwise vanish, opening a permanent
            // gap in `seq` that mergeView's backward walk (which stops the
            // instant `seq` fails to decrement by exactly 1) silently
            // truncates the render at. Splice the remainder (order
            // preserved, failed item included since it never landed) back
            // onto the FRONT of `this.buf` — ahead of anything pushed since —
            // so the next flush picks up exactly where this one broke off,
            // then rethrow to the caller, which already swallows this
            // rejection (the interval's `.catch`, or `stop()`'s).
            this.buf = [...batch.slice(i), ...this.buf];
            throw e;
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Wait for an in-flight flush instead of skipping the tail: a bare
    // `flush()` here would hit the non-reentrancy guard and return having
    // written nothing.
    const inFlight = this.pending;
    if (inFlight) await inFlight;
    await this.flush();
  }
}
