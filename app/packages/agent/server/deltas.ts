import { createHash } from 'crypto';
import { AgentDeltas } from '../common/collections';
import type { AgentDelta, DeltaKind } from '../common/types';
import { heartbeat } from './lease';
import {
  beginSessionMutationOperation, type SessionOperation,
} from './session-operations';

/** Per-turn `tool_args` delta ceiling (256 KiB). AgentDeltas is a shared capped
 *  collection with global FIFO eviction, so one session's argument streaming
 *  is everybody's problem. `tool_args` can't coalesce (interleaved parallel calls). */
export const DEFAULT_MAX_TOOL_ARG_BYTES = 256 * 1024;

// One physical Mongo command must fit comfortably under both the capped
// collection's limits and the 30-second Turn/lifecycle fences. Runtime Mongo
// driver 6.x applies `timeoutMS` across selection, checkout, and I/O.
const DELTA_COMMAND_MAX_MS = 5_000;
const DELTA_COMMAND_MAX_DOCS = 64;
const DELTA_COMMAND_MAX_BYTES = 256 * 1024;
const DELTA_DOC_OVERHEAD_BYTES = 512;
const DELTA_CHUNK_MAX_BYTES = DELTA_COMMAND_MAX_BYTES - DELTA_DOC_OVERHEAD_BYTES;

interface PendingDelta {
  kind: DeltaKind;
  chunk: string;
  seq: number;
  contentIndex?: number;
  at: Date;
}

function deltaId(messageId: string, seq: number): string {
  return `d:${createHash('sha256')
    .update('10thfloor:agent:delta\0')
    .update(messageId)
    .update('\0')
    .update(String(seq))
    .digest('hex')}`;
}

function utf8Pieces(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return [value];
  const pieces: string[] = [];
  let chars: string[] = [];
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (chars.length > 0 && bytes + size > maxBytes) {
      pieces.push(chars.join(''));
      chars = [];
      bytes = 0;
    }
    chars.push(char);
    bytes += size;
  }
  if (chars.length > 0) pieces.push(chars.join(''));
  return pieces;
}

/** Buffers deltas and flushes on an interval: O(chunk) on the wire, not O(n²).
 *  Exported as a test seam (committed turns delete their deltas). */
export class DeltaWriter {
  private buf: PendingDelta[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Non-reentrancy guard: overlapping flushes would scramble insert order. */
  private flushing = false;
  private pending: Promise<void> | null = null;
  /** Cumulative `tool_args` bytes accepted; compared against `maxToolArgBytes`. */
  private toolArgBytes = 0;
  /** One warn per turn, not one per dropped chunk. */
  private warnedClamp = false;
  /** Root+target lifecycle authority held from first flush through stop. */
  private operationPromise: Promise<SessionOperation | null> | null = null;
  /** Once authority/reconciliation is ambiguous, the durable Message wins. */
  private suppressed = false;

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
    if (this.suppressed || chunk.length === 0) return;
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

    for (const piece of utf8Pieces(chunk, DELTA_CHUNK_MAX_BYTES)) {
      const last = this.buf[this.buf.length - 1];
      if (last && last.kind === kind && last.contentIndex === index
        && Buffer.byteLength(last.chunk, 'utf8') + Buffer.byteLength(piece, 'utf8')
          <= DELTA_CHUNK_MAX_BYTES) {
        last.chunk += piece;
      } else {
        this.buf.push({
          kind,
          chunk: piece,
          seq: this.seq++,
          ...(index === undefined ? {} : { contentIndex: index }),
          at: new Date(),
        });
      }
    }
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
        let bytes = 0;
        let count = 0;
        while (count < this.buf.length && count < DELTA_COMMAND_MAX_DOCS) {
          const size = Buffer.byteLength(this.buf[count].chunk, 'utf8')
            + DELTA_DOC_OVERHEAD_BYTES;
          if (count > 0 && bytes + size > DELTA_COMMAND_MAX_BYTES) break;
          bytes += size;
          count += 1;
        }
        const batch = this.buf.splice(0, Math.max(1, count));
        const docs: AgentDelta[] = batch.map((item) => ({
          _id: deltaId(this.messageId, item.seq),
          sessionId: this.sessionId,
          messageId: this.messageId,
          msgSeq: this.msgSeq,
          seq: item.seq,
          kind: item.kind,
          chunk: item.chunk,
          ...(item.contentIndex === undefined ? {} : { contentIndex: item.contentIndex }),
          ...(this.from ? { from: this.from } : {}),
          at: item.at,
        }));

        this.operationPromise ??= beginSessionMutationOperation(this.sessionId);
        const operation = await this.operationPromise;
        if (!operation || !(await heartbeat(this.sessionId))) {
          this.suppressed = true;
          this.buf = [];
          return;
        }
        try {
          await operation.assertActive();
          await AgentDeltas.rawCollection().insertMany(docs, {
            ordered: true,
            timeoutMS: DELTA_COMMAND_MAX_MS,
            retryWrites: false,
          } as any);
        } catch (error) {
          // An ordered bulk may have partly landed, or its acknowledgement may
          // have been lost. Reconcile deterministic IDs while both authorities
          // remain live; blindly retrying would create duplicates or gaps.
          try {
            if (!(await heartbeat(this.sessionId))) throw error;
            await operation.assertActive();
            const standing = await AgentDeltas.rawCollection().find(
              { _id: { $in: docs.map((doc) => doc._id) } },
              {
                projection: {
                  _id: 1, sessionId: 1, messageId: 1, msgSeq: 1,
                  seq: 1, kind: 1, chunk: 1, contentIndex: 1,
                },
                timeoutMS: DELTA_COMMAND_MAX_MS,
              } as any,
            ).toArray() as AgentDelta[];
            const expected = new Map(docs.map((doc) => [doc._id, doc]));
            const exact = new Set(standing.filter((row) => {
              const wanted = expected.get(row._id);
              return wanted !== undefined
                && row.sessionId === wanted.sessionId
                && row.messageId === wanted.messageId
                && row.msgSeq === wanted.msgSeq
                && row.seq === wanted.seq
                && row.kind === wanted.kind
                && row.chunk === wanted.chunk
                && row.contentIndex === wanted.contentIndex;
            }).map((row) => row._id));
            if (exact.size !== standing.length) {
              this.suppressed = true;
              this.buf = [];
              return;
            }
            const missing = batch.filter(
              (item) => !exact.has(deltaId(this.messageId, item.seq)),
            );
            this.buf = [...missing, ...this.buf];
          } catch {
            this.suppressed = true;
            this.buf = [];
            return;
          }
          throw error;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try {
      // Wait for in-flight flush before final drain; bare `flush()` would no-op.
      const inFlight = this.pending;
      if (inFlight) await inFlight;
      await this.flush();
    } finally {
      const operation = await this.operationPromise;
      if (operation) await operation.close();
    }
  }
}
