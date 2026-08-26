import { Random } from 'meteor/random';
import { AgentDeltas } from '../common/collections';
import type { DeltaKind } from '../common/types';

/** Per-turn `tool_args` delta ceiling (256 KiB). AgentDeltas is a shared capped
 *  collection with global FIFO eviction, so one session's argument streaming
 *  is everybody's problem. `tool_args` can't coalesce (interleaved parallel calls). */
export const DEFAULT_MAX_TOOL_ARG_BYTES = 256 * 1024;

/** Buffers deltas and flushes on an interval: O(chunk) on the wire, not O(n²).
 *  Exported as a test seam (committed turns delete their deltas). */
export class DeltaWriter {
  private buf: Array<{ kind: DeltaKind; chunk: string; seq: number; contentIndex?: number }> = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Non-reentrancy guard: overlapping flushes would scramble insert order. */
  private flushing = false;
  private pending: Promise<void> | null = null;
  /** Cumulative `tool_args` bytes accepted; compared against `maxToolArgBytes`. */
  private toolArgBytes = 0;
  /** One warn per turn, not one per dropped chunk. */
  private warnedClamp = false;

  constructor(
    private sessionId: string,
    private messageId: string,
    private msgSeq: number,
    flushMs: number,
    /** Per-turn ceiling on `tool_args` delta bytes. Past this, `tool_args`
     *  deltas stop; `text`/`thinking` and committed `toolCalls` are unaffected. */
    private maxToolArgBytes: number = Infinity,
    /** Model participant whose turn is streaming; absent for 1:1 sessions. */
    private from?: { participant: string; name: string },
  ) {
    // Unhandled rejection is fatal on Node >= 15; deltas are ephemeral, so
    // swallow — the next tick retries whatever is still buffered.
    this.timer = setInterval(() => {
      void this.flush().catch(() => { /* ephemeral: the next tick retries */ });
    }, flushMs);
  }

  /** Consecutive same-kind chunks coalesce into one delta document. `seq` is
   *  assigned at push time to stay contiguous (`mergeView` truncates on gaps).
   *  `contentIndex` is part of the coalescing key to keep parallel tool calls apart. */
  push(kind: DeltaKind, chunk: string, contentIndex?: number) {
    // Only `tool_args` uses `contentIndex`; a stray one on text would split
    // coalescing buckets silently, so drop it rather than throw.
    const index = kind === 'tool_args' ? contentIndex : undefined;

    // Checked before coalescing so a dropped chunk can't sneak in via an
    // existing run. The crossing chunk is written whole; everything after is dropped.
    if (kind === 'tool_args' && this.maxToolArgBytes !== Infinity) {
      if (this.toolArgBytes >= this.maxToolArgBytes) {
        if (!this.warnedClamp) {
          this.warnedClamp = true;
          console.warn(
            '[10thfloor:agent] tool_args deltas exceeded '
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
      // Chunks pushed during an in-flight insert belong to this flush.
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
              kind: item.kind,
              chunk: item.chunk,
              ...(item.contentIndex === undefined ? {} : { contentIndex: item.contentIndex }),
              ...(this.from ? { from: this.from } : {}),
              at: new Date(),
            });
          } catch (e) {
            // Splice unwritten remainder back onto the front so the next flush
            // retries them — a seq gap would truncate mergeView's render.
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
    // Wait for in-flight flush before final drain; bare `flush()` would no-op.
    const inFlight = this.pending;
    if (inFlight) await inFlight;
    await this.flush();
  }
}
