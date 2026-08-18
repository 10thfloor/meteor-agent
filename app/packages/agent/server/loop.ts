import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage, AgentSession } from '../common/types';
import type { Provider, ProviderMessage, ToolSchema } from './providers/types';
import {
  claimLease, guardedUpdate, heartbeat, holdsLease, releaseLease,
  HEARTBEAT_MS, SERVER_ID,
} from './lease';
import {
  expandMcpTools, resolveTools, runTool, toolSchemas, withSkillTool,
  type ResolvedTool, type Skill, type ToolContext, type ToolResult, type ToolSpec,
} from './tools';
import { runSubagent, type SubagentDispatch } from './subagent';
import {
  runAfterToolResult, runBeforeProviderRequest, type ToolResultHookContext,
} from './hooks';

export interface RunConfig {
  model: string;
  system: string;
  tools: ToolSpec[];
  provider: Provider;
  maxIterations?: number;
  flushMs?: number;
  /** How often the stream loop re-reads the session to honor an interrupt
   *  (`phase: 'stopped'`). Tests lower it; the default keeps the cost to a few
   *  indexed reads per response. */
  interruptCheckMs?: number;
  /** §10: bounded retry with full-jitter exponential backoff for a provider
   *  stream that throws mid-iteration. `attempts` counts the initial try
   *  (default 3); the delay is uniform in
   *  `[0, min(maxDelayMs, baseMs * 2^attemptIndex)]` (defaults 500 / 10_000). */
  retry?: { attempts?: number; baseMs?: number; maxDelayMs?: number };
  /** §9 compaction thresholds (defaults 200_000 / 0.8 / 6); absent =
   *  compaction disabled. */
  context?: { window?: number; compactAt?: number; keep?: number };
  /** §9, threaded from the registry by `deferTurn`. `spend` is already parsed
   *  to dollars (`parseSpend` runs at define() time). `turns` is enforced in
   *  `mSend`, not here — by the time a turn runs, the send it would refuse has
   *  already happened. */
  budget?: { turns?: number; toolCalls?: number; spend?: number };
  /** $ per million tokens. The FALLBACK for a provider that reports no cost of
   *  its own; see `accruedCost`. */
  pricing?: { input: number; output: number };
  /** §5.2. A tool result enters the transcript AND every later provider
   *  request; one oversized result inside compaction's kept tail can exceed
   *  the context window with nothing compaction can do about it. Truncation
   *  is explicit in the content so the model knows it saw a prefix.
   *  Default 8000. */
  maxResultChars?: number;
  /** §7's backstop: agent-level tool authorization, checked before gates and
   *  before dispatch. A refusal is a structured result the model reads and
   *  routes around — never a park, never a throw. */
  canUse?: (tool: string, ctx: { userId: string | null; sessionId: string })
    => boolean | Promise<boolean>;
  /** The agent's skills. Their descriptions are already in `system` (see
   *  `buildSystemPrompt`); the loop reads this only to decide whether to add
   *  the built-in `skill` tool and what it can load. Absent or empty = no
   *  loader tool at all. */
  skills?: Skill[];
}

/** Threaded into every dispatch path as one bundle so a future path cannot
 *  forget half of it. */
interface DispatchLimits {
  maxResultChars: number;
  canUse?: RunConfig['canUse'];
}

/**
 * The ONE way a resolved tool is run, whatever its kind.
 *
 * Inline and adopted tools go to `runTool`, which owns argument validation,
 * the ambient method invocation and error sanitization. A SUBAGENT does not:
 * it is not a tool body but a nested TURN, so it needs `runTurn` — which lives
 * here, in the module that imports tools.ts. Routing it from inside `runTool`
 * would close an import cycle (tools -> subagent -> loop -> tools), so the
 * split is here instead, at the single point both dispatch paths (a streamed
 * batch and an approved park's resume) already share. `runSubagent` therefore
 * takes `runTurn` as an argument: dependency in, no cycle.
 *
 * The extra return field is the child's session id, which the caller records on
 * the tool row so a client can find and subscribe to the child transcript.
 */
async function dispatchTool(
  tool: ResolvedTool, args: unknown, ctx: ToolContext,
): Promise<SubagentDispatch> {
  if (tool.kind === 'subagent') return runSubagent(tool, args, ctx, runTurn);
  return { result: await runTool(tool, args, ctx) };
}

/**
 * One warn per DISTINCT serialization failure kind (`TypeError` for a circular
 * value, `TypeError` for a BigInt, whatever a throwing `toJSON` raises).
 *
 * The same latch pattern as hooks.ts's and the validator's, for the same
 * reason: a tool or hook that returns an unserializable value returns one every
 * single call, and an unlatched warning would be a log line per tool result
 * forever. Keyed per kind rather than once ever, so one failure mode cannot
 * permanently suppress the next.
 */
const warnedSerialization = new Set<string>();

/** What a row says when its result could not be turned into JSON. Structured,
 *  like every other harness-authored failure: the model can read it and route
 *  around, and a UI can render it as an error rather than as an answer. */
const UNSERIALIZABLE = {
  error: 'unserializable-result',
  reason: 'The tool result could not be serialized.',
} as const;

/**
 * The transcript row for a tool result: its `content`, truncated explicitly,
 * and the `error` the row must carry alongside it.
 *
 * `JSON.stringify` THROWS on a circular object and on a BigInt, and a tool's
 * value is app data — a hook's replacement even more so. Unguarded, that throw
 * escapes the dispatch loop and abandons a turn that had already done all of
 * its work, which is a harness failure wearing an app's mistake. Guarded, the
 * row records a structured `unserializable-result` and the turn completes: the
 * model is told the call produced nothing usable and can try something else.
 *
 * Returning the error alongside the content rather than leaving it to the three
 * call sites is deliberate — a site that wrote the substituted content but kept
 * `result.ok`'s `undefined` error would publish a row that claims success and
 * carries an apology.
 */
function toolResultContent(
  result: ToolResult, maxChars: number,
): { content: string; error?: { error: string; reason?: string } } {
  let raw: string;
  try {
    raw = JSON.stringify(result.ok ? result.value : result.error) ?? 'null';
  } catch (e) {
    const kind = (e as Error)?.name ?? 'Error';
    if (!warnedSerialization.has(kind)) {
      warnedSerialization.add(kind);
      console.warn(
        '[10thfloor:agent] a tool result could not be serialized for the transcript '
        + `(${kind}: ${(e as Error)?.message}); the row records `
        + 'unserializable-result (warned once per kind)',
      );
    }
    return { content: JSON.stringify(UNSERIALIZABLE), error: { ...UNSERIALIZABLE } };
  }
  const content = raw.length <= maxChars
    ? raw
    : `${raw.slice(0, maxChars)}…[truncated ${raw.length - maxChars} of ${raw.length} chars]`;
  return { content, error: result.ok ? undefined : result.error };
}

/**
 * Dollars to add to `usage.cost` for one model call.
 *
 * The provider's own figure wins whenever it reports one. pi-ai prices each
 * call against its catalog including cacheRead/cacheWrite tokens, which
 * `ProviderChunk` does not carry and a two-rate table cannot express — so
 * recomputing from input/output alone would systematically underprice cached
 * calls, and a spend budget that undercounts is not a budget.
 *
 * With no reported cost and no configured `pricing`, this accrues ZERO rather
 * than guessing. A session with no way to price itself simply has no spend
 * budget: `usage.cost` stays 0, the spend check never trips, and the turn and
 * tool-call budgets are what limit the run. Guessing a rate would be worse —
 * it would trip a cap on a number nobody chose.
 */
export function accruedCost(
  usage: { input: number; output: number; cost?: number },
  pricing?: { input: number; output: number },
): number {
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost;
  if (!pricing) return 0;
  return (usage.input * pricing.input + usage.output * pricing.output) / 1e6;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** §10: 429, 408 (a request timeout is transient by definition — Anthropic's
 *  and OpenAI's own client libraries retry it alongside 429 and 5xx), 5xx and
 *  network-ish errors retry; other 4xx auth/request errors do not. Anything
 *  unclassifiable is treated as retryable — a transient blip should not
 *  permanently kill a session, and retries are bounded anyway.
 *
 *  'abandon' is the third answer: a cancelled request. Retrying re-issues the
 *  very request the user stopped, and a failure note blames them for their
 *  own cancellation — so an abort takes the interrupt path instead. Detected
 *  by the adapter's hint or by the standard AbortError name a raw aborted
 *  fetch carries (no status at all, so it would otherwise default to
 *  retryable).
 *
 *  An explicit `e.retryable` hint (set by an adapter that has better
 *  information than an HTTP status — pi-ai's own transient-error classifier,
 *  for one) short-circuits the status-based classification. */
export function classifyProviderError(e: any): 'retryable' | 'fatal' | 'abandon' {
  if (e?.retryable === 'abandon' || e?.name === 'AbortError') return 'abandon';
  if (e?.retryable === true) return 'retryable';
  if (e?.retryable === false) return 'fatal';
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status === 429 || status === 408
    || (typeof status === 'number' && status >= 500)) return 'retryable';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'fatal';
  return 'retryable';
}

/** Full jitter: uniform in [0, min(maxDelayMs, baseMs * 2^attemptIndex)].
 *  A deterministic exponential resynchronizes every session that failed
 *  together — a provider-wide 529 would have the whole fleet retrying in
 *  lockstep, which is how outages prolong themselves. */
export function backoffDelay(attemptIndex: number, baseMs: number, maxDelayMs: number): number {
  return Math.random() * Math.min(maxDelayMs, baseMs * 2 ** attemptIndex);
}

let backoff: typeof backoffDelay = backoffDelay;

/**
 * TEST SEAM, not public API — the same shape as lease.ts's `_setLeaseTimings`.
 * Full jitter draws a delay that can legitimately be ~0ms, which makes the
 * between-attempts `retrying` phase unobservable by any sampler (and the
 * test-environment Mongo observer runs on the polling driver, which coalesces
 * transient states away entirely). A test that must SEE the phase pins the
 * delay deterministic here and restores in `finally`. Pass null to restore
 * the jittered default. Not re-exported from server/index.ts.
 */
export function _setBackoff(fn: typeof backoffDelay | null): () => void {
  const previous = backoff;
  backoff = fn ?? backoffDelay;
  return () => { backoff = previous; };
}

/**
 * Atomically allocate the next message `seq` under the lease guard: one
 * `findOneAndUpdate`, so no interleaving with `agent.send`'s own atomic
 * allocation can hand out the same seq twice. Returns null when the lease is
 * gone (or the session vanished) — the caller must abandon without writing.
 *
 * This exists because read-then-`$inc` is NOT atomic: the loop used to capture
 * `nextSeq` before the stream and `$inc` at commit, so a user message sent
 * mid-stream landed on the same seq the assistant then committed at.
 */
async function allocateSeq(
  sessionId: string,
  inc: Record<string, number> = {},
): Promise<number | null> {
  const before = await AgentSessions.rawCollection().findOneAndUpdate(
    { _id: sessionId, 'lease.serverId': SERVER_ID } as any,
    { $inc: { nextSeq: 1, ...inc }, $set: { updatedAt: new Date() } },
    { returnDocument: 'before' },
  );
  return before ? (before as any).nextSeq : null;
}

/** Which limit tripped, and the sentence a UI shows for it. */
const BUDGET_REASONS = {
  turns: 'Turn budget reached.',
  toolCalls: 'Tool-call budget reached.',
  spend: 'Spend budget reached.',
} as const;

/**
 * Record a tripped budget and stop the session (§9).
 *
 * Structured, never prose: `kind: 'budget'` plus the same `{ error, reason }`
 * shape the provider-failure note uses, plus WHICH budget it was — so a UI can
 * offer to raise the right limit instead of saying "exhausted" and leaving the
 * operator to guess.
 *
 * `phase: 'stopped'` reuses the interrupt's semantics exactly, including its
 * durability: the loop refuses to run while it stands and the outer `finally`
 * preserves it, so the next `agent.send` is what clears it. For `turns` and
 * `spend` that next send then refuses (`mSend`) or trips again on its first
 * iteration — the closed loop is the design, not an oversight.
 *
 * Both writes are lease-guarded (`allocateSeq`, `guardedUpdate`). Losing the
 * lease means another server owns the session and will make its own decision;
 * writing a stop from here would stop ITS turn.
 */
async function commitBudgetNote(
  sessionId: string, budget: keyof typeof BUDGET_REASONS,
): Promise<void> {
  const seq = await allocateSeq(sessionId);
  if (seq === null) return;
  await AgentMessages.insertAsync({
    _id: Random.id(), sessionId, seq, role: 'note', kind: 'budget', budget,
    error: { error: 'budget-exhausted', reason: BUDGET_REASONS[budget] },
    createdAt: new Date(),
  } as any);
  await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'stopped' } });
}

/**
 * Sessions running a turn IN THIS PROCESS. `claimLease` succeeds on its
 * "already ours" branch, so two concurrent `runTurn` calls in one process would
 * both hold the lease and both pass every `guardedUpdate`; the read-then-`$inc`
 * of `nextSeq` is not atomic, so both could insert at the same `seq`. The
 * lease protects against a second SERVER, this Set against a second CALL —
 * a double-submitting user reaching `Meteor.defer(() => runTurn(...))` twice.
 */
const running = new Set<string>();

/**
 * Is a turn for this session running in THIS process?
 *
 * The watcher's read of the same guard `runTurn` enforces internally. It is an
 * optimization, not a correctness boundary: calling `runTurn` for a session
 * already running here returns immediately anyway, and a run on ANOTHER server
 * is invisible to this Set (that is what the lease is for). It exists so a sweep
 * does not queue wake-ups it knows will be no-ops.
 */
export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

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

  constructor(
    private sessionId: string,
    private messageId: string,
    private msgSeq: number,
    flushMs: number,
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

/** The newest `kind:'compaction'` note, or null. Only the newest matters:
 *  each compaction's summary already folds the previous one in. */
export function latestCompaction(
  msgs: AgentMessage[],
): { seq: number; summary: string; upto: number } | null {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i] as any;
    if (m.role === 'note' && m.kind === 'compaction' && typeof m.upto === 'number') {
      return { seq: m.seq, summary: m.summary ?? '', upto: m.upto };
    }
  }
  return null;
}

/**
 * What the MODEL sees: from the newest compaction note, its summary as a
 * leading user message, then every non-note message after the note's `upto`.
 * With no compaction, the whole (note-filtered) transcript. The transcript
 * itself is never touched — compaction changes this view only.
 */
export function assembleContext(msgs: AgentMessage[]): ProviderMessage[] {
  const c = latestCompaction(msgs);
  if (!c) return toProviderMessages(msgs);
  return [
    { role: 'user', content: `[Earlier conversation, compacted]\n${c.summary}` },
    ...toProviderMessages(msgs.filter((m) => m.seq > c.upto)),
  ];
}

/**
 * Estimated tokens the next provider call will carry. The last assistant's
 * provider-reported `usage.input` is ground truth for the context size at
 * THAT call; chars/4 approximates what has landed since. Take the max — the
 * estimate feeds a threshold, so erring high compacts a little early, erring
 * low silently never compacts. `lastReportedInput` must come from an
 * assistant NEWER than the latest compaction, or it describes a view that no
 * longer exists (the caller enforces this).
 */
export function estimateContext(
  assembled: ProviderMessage[], lastReportedInput?: number,
): number {
  const chars = JSON.stringify(assembled).length;
  return Math.max(lastReportedInput ?? 0, Math.ceil(chars / 4));
}

/**
 * Walk a proposed transcript boundary BACKWARD until it is batch-safe, and
 * return the adjusted boundary.
 *
 * `eligible` is a seq-sorted, NOTE-FREE message list; `boundary` is the index
 * of the first message that will NOT be in the head (so `boundary ===
 * eligible.length` means the head is everything). The head is what one side of
 * the operation keeps: for compaction it is what gets summarized away, for a
 * FORK it is what gets copied. Both need the same guarantee — the head must
 * never contain an assistant's `tool_use` whose `tool_result` is on the other
 * side of the boundary — so both call this, and the rule cannot drift between
 * them.
 *
 * Batch safety cannot rely on row adjacency: a `send` queued while the session
 * was `awaiting` puts a USER row between an assistant's toolCalls and its tool
 * results, so walking back off tool rows alone would cut between them — a
 * permanent 400 nothing can repair (the transcript itself is healthy; only the
 * model's view of it is broken). So this uses the same turn-window machinery
 * repair uses: if any assistant's window spans the boundary, the boundary moves
 * to before that assistant.
 */
export function batchSafeBoundary(eligible: AgentMessage[], boundary: number): number {
  let cut = Math.max(0, Math.min(boundary, eligible.length));
  // The first seq NOT in the head — Infinity when the head is the whole list.
  // That arm is reachable only from a fork (compaction always keeps a tail),
  // and it is what makes an UNANSWERED batch fall out of the same rule: see
  // `lastAnswerSeq` below.
  const boundarySeq = () => (cut < eligible.length ? eligible[cut].seq : Infinity);
  // Latest window first: moving the boundary earlier can only push it into
  // EARLIER windows, so processing in reverse handles the cascade in one pass.
  for (const w of [...turnWindows(eligible)].reverse()) {
    const calls = w.assistant.toolCalls ?? [];
    if (calls.length === 0) continue;
    // A call with NO `tool_result` anywhere in its window has its answer
    // "after everything" — Infinity — so a head that ends on such an assistant
    // strands a `tool_use` exactly as a mid-batch cut would, and the same
    // comparison pushes the boundary back past it. This is what makes forking
    // an AWAITING session cut before the parked batch with no special case:
    // the parked assistant is unanswered by construction.
    //
    // Compaction is unaffected in practice. Its boundary is never the end of
    // the list (`keep >= 1` keeps a tail), and repair-on-entry deletes stranded
    // assistants before a turn ever reaches `maybeCompact`, so the only
    // unanswered assistant a live transcript can hold is a parked one at the
    // tail — which is on the KEPT side, where this loop does not look.
    //
    // If that arm ever DID fire for compaction, the failure direction is: the
    // boundary walks back past the unanswered assistant, which therefore stays
    // in the KEPT tail instead of being summarized away — so the assembled view
    // carries a `tool_use` with no `tool_result` and every provider call 400s
    // until repair-on-entry deletes the stranded turn. Degraded and
    // self-healing, not silent corruption; but it is why the invariant above is
    // stated rather than assumed.
    const lastAnswerSeq = calls.every((c) => w.answered.has(c.id))
      ? Math.max(
        w.assistant.seq,
        ...eligible
          .filter((t) => t.role === 'tool' && t.seq > w.assistant.seq && t.seq < w.windowEnd)
          .map((t) => t.seq),
      )
      : Infinity;
    // Window spans the boundary: the assistant is in the head while some of
    // its results are (or would be) on the other side.
    while (cut > 0 && w.assistant.seq < boundarySeq() && lastAnswerSeq >= boundarySeq()) {
      cut -= 1;
    }
  }
  return cut;
}

/**
 * The seq to compact up to (inclusive), keeping the last `keep` non-note
 * messages — or null when there is nothing worth compacting. The cut NEVER
 * splits an assistant-with-toolCalls from its tool results: a summarized
 * `tool_use` whose `tool_result` survives in the tail (or vice versa) is the
 * same unmatched-pair 400 the repair machinery exists to prevent, introduced
 * by our own bookkeeping. `batchSafeBoundary` is the walk that guarantees it —
 * shared verbatim with session forking.
 */
export function findCompactionCut(msgs: AgentMessage[], keep: number): number | null {
  const c = latestCompaction(msgs);
  const eligible = msgs.filter(
    (m) => m.role !== 'note' && (!c || m.seq > c.upto),
  );
  if (eligible.length <= keep) return null;
  // `eligible.length - keep` is the index of the first KEPT message.
  const cut = batchSafeBoundary(eligible, eligible.length - keep);
  if (cut <= 0) return null;
  return eligible[cut - 1].seq;
}

/**
 * §9. Summarize everything older than the last `keep` messages into a
 * `kind:'compaction'` note, using the turn's own provider. Failure is
 * DEGRADED, never fatal: the turn proceeds uncompacted (too-long context is
 * the provider's error to report, and the next iteration tries again), and no
 * error note is written — compaction is bookkeeping, not the user's request.
 * Returns true when a note was committed (the caller re-reads history).
 *
 * This is the THRESHOLD half only. The step itself is `compactNow`, which the
 * manual `Agent.compact` calls directly — see there.
 */
async function maybeCompact(
  sessionId: string, agent: string, config: RunConfig, history: AgentMessage[],
  schemas: ToolSchema[] = [], interruptCheckMs = 250,
): Promise<boolean> {
  const ctx = config.context;
  if (!ctx) return false;
  const window = ctx.window ?? 200_000;
  const compactAt = ctx.compactAt ?? 0.8;

  const prior = latestCompaction(history);
  const assembled = assembleContext(history);
  const lastAssistant = [...history].reverse()
    .find((m) => m.role === 'assistant' && typeof m.usage?.input === 'number');
  // A reported input from BEFORE the latest compaction describes the
  // pre-compaction view; using it would re-trigger forever.
  const reported = lastAssistant && (!prior || lastAssistant.seq > prior.seq)
    ? lastAssistant.usage!.input : undefined;
  if (estimateContext(assembled, reported) <= window * compactAt) return false;

  return compactNow(sessionId, agent, config, history, schemas, interruptCheckMs);
}

/**
 * The §9 compaction STEP, with no threshold in it.
 *
 * Factored out of `maybeCompact` so the manual `Agent.compact` runs exactly the
 * automatic path — same cut, same summarizer prompt, same hook seam, same
 * usage accounting, same degrade-never-fail contract — instead of a second
 * implementation that would drift. `maybeCompact` is now the estimate and the
 * `window * compactAt` comparison, and nothing else; everything from the cut
 * down is here, unchanged.
 *
 * `context.keep` still applies (the manual call is "compact now", not "throw
 * the tail away"), and `config.context` may be absent entirely: a caller that
 * asked for this explicitly gets the defaults rather than a silent no-op.
 */
async function compactNow(
  sessionId: string, agent: string, config: RunConfig, history: AgentMessage[],
  schemas: ToolSchema[] = [], interruptCheckMs = 250,
): Promise<boolean> {
  const keep = config.context?.keep ?? 6;
  const prior = latestCompaction(history);

  const upto = findCompactionCut(history, keep);
  if (upto === null) return false;
  // Phase-guarded, not just lease-guarded: `guardedUpdate` filters on the
  // lease only, so without the $nin a stop landing right before this write
  // would be silently overwritten — the same interrupt-erasure hole the M2
  // retry branch had, widened here to a full provider round trip.
  //
  // `awaiting` and `error` join `stopped` as defence in depth behind
  // `compactSession`'s own refusals: all three are DECISIONS, and overwriting
  // one with `compacting` would leave the finally to "restore" a phase that
  // no longer describes the session (an unanswerable pending verdict, a
  // laundered failure). It is inert on the automatic path, which is the point
  // of a backstop — `maybeCompact`'s only call site is inside `runTurn`'s
  // iteration loop, after the head's `phase === 'stopped'` return and after
  // the pending-gate that returns on `awaiting`, with `error` terminal (the
  // loop returns on it, and only a send clears it). The phase there is `idle`
  // on the first iteration and `streaming`/`calling` on later ones — never
  // one of these three.
  const entered = await AgentSessions.updateAsync(
    {
      _id: sessionId,
      'lease.serverId': SERVER_ID,
      phase: { $nin: ['stopped', 'awaiting', 'error'] },
    } as any,
    { $set: { phase: 'compacting', updatedAt: new Date() } } as any,
  );
  if (entered !== 1) return false;

  const head = history.filter(
    (m) => m.role !== 'note' && (!prior || m.seq > prior.upto) && m.seq <= upto,
  );
  let summary = '';
  let usage = { input: 0, output: 0 } as { input: number; output: number; cost?: number };
  // The summarization is a full provider round trip with no consuming-loop
  // interrupt check of its own — so it polls the phase itself and ABORTS the
  // request on a stop, instead of leaving the user's interrupt waiting on a
  // call they cannot see.
  const abort = new AbortController();
  const poll = setInterval(() => {
    void AgentSessions.findOneAsync(sessionId)
      .then((s) => { if (!s || s.phase === 'stopped') abort.abort(); })
      .catch(() => { /* best-effort */ });
  }, interruptCheckMs);
  try {
    // The SECOND `beforeProviderRequest` seam, and the reason the hook carries
    // a `purpose` at all: this request is the harness's own initiative, not the
    // user's, and an app that wants its own summarizer replaces it here
    // (`ctx.purpose === 'compaction'`) rather than through a bespoke option.
    // `signal` is re-stamped below for the same reason it is on the think path:
    // cancelling this call is the harness's job, not the hook's.
    const request = await runBeforeProviderRequest({
      model: config.model,
      system:
        'You compact conversation history for an agent. Produce a concise brief '
        + 'the agent can continue from, structured as: Goal, Progress, Decisions, '
        + 'Open items. Preserve identifiers, numbers, and constraints exactly. '
        + 'Output only the brief.',
      messages: [
        ...(prior ? [{
          role: 'user' as const,
          content: `[Earlier conversation, compacted]\n${prior.summary}`,
        }] : []),
        ...toProviderMessages(head),
        { role: 'user' as const, content: 'Compact the conversation above now, as instructed.' },
      ],
      // The head keeps its tool_use/tool_result blocks, and Anthropic rejects
      // a request carrying those with no `tools` parameter — so the agent's
      // real tool schemas ride along. The summarizer is told to output only
      // the brief; a tool call in its reply is discarded anyway (only text
      // chunks accumulate below).
      tools: schemas,
    }, { agent, sessionId, purpose: 'compaction' });
    for await (const chunk of config.provider.stream({ ...request, signal: abort.signal })) {
      if (chunk.kind === 'text') summary += chunk.chunk;
      else if (chunk.kind === 'done' && chunk.usage) usage = chunk.usage;
    }
  } catch (e) {
    // An abort is the user's stop arriving mid-summarization — quiet return;
    // the attempt head's phase-conditional write is what honors it. Anything
    // else is degraded-not-fatal, per the compaction contract.
    if (classifyProviderError(e) !== 'abandon') {
      console.warn(
        `[10thfloor:agent] compaction failed for session ${sessionId}; proceeding uncompacted:`,
        (e as Error)?.message,
      );
    }
    return false;
  } finally {
    clearInterval(poll);
  }
  if (!summary.trim()) return false;

  // The summarization call is a real model call: its usage and cost accrue
  // exactly as a think's do, in the same atomic write as the note's seq.
  const noteSeq = await allocateSeq(sessionId, {
    'usage.input': usage.input,
    'usage.output': usage.output,
    'usage.cost': accruedCost(usage, config.pricing),
  });
  if (noteSeq === null) return false;
  await AgentMessages.insertAsync({
    _id: Random.id(), sessionId, seq: noteSeq, role: 'note', kind: 'compaction',
    summary, upto, usage, createdAt: new Date(),
  } as any);
  return true;
}

/**
 * What a manual compaction did. A plain union rather than a throw, because this
 * module is deliberately free of the Meteor namespace — `Agent.compact` turns
 * every REFUSING outcome into `Meteor.Error('busy')` and `gone` into
 * `no-session`, and the client sees those.
 */
export type CompactOutcome =
  'compacted' | 'nothing' | 'busy' | 'awaiting' | 'errored' | 'gone';

/**
 * The refusing outcomes, and the `reason` each one carries.
 *
 * One error CODE (`busy`) across all three, because that is the contract
 * `Agent.compact` and `agent.compact` already published and every client
 * branches on — but three distinct reasons, because "a turn is running",
 * "answer the approval first" and "this session failed" are three different
 * things for a person to do next, and a UI that only ever sees `busy` would
 * tell all three of them to wait a moment.
 *
 * Here rather than duplicated at the two call sites, which is exactly how the
 * two would drift.
 */
export const COMPACT_REFUSALS: Partial<Record<CompactOutcome, string>> = {
  busy: 'This session is running a turn; compact it when it is idle.',
  awaiting: 'This session is waiting on an approval; answer it before compacting.',
  errored: 'This session has failed; send to it again before compacting.',
};

/**
 * §9's compaction step, run ON DEMAND against an idle session — the whole point
 * being that the threshold does NOT apply. A UI's "compact now" button, a job
 * trimming a long-running session before it gets expensive.
 *
 * It takes the LEASE for the operation (claim, compact, release) rather than
 * writing under whatever the session's state happens to be. A compaction is a
 * full provider round trip that commits a note at an allocated seq, which is
 * precisely what a turn does — running one beside a live turn would interleave
 * two writers over one transcript. So a session with a live lease, or a turn in
 * flight in this process, is refused as `busy` instead of queued: the caller is
 * a human clicking a button, and "try again in a moment" is an answer they can
 * act on. The in-process `running` Set is held too, for the same reason
 * `runTurn` holds it — `claimLease` succeeds on its "already ours" branch, so
 * the lease alone would not stop a `Meteor.defer`red turn in THIS process from
 * writing straight through the compaction.
 *
 * The heartbeat mirrors `runTurn`'s: LEASE_MS is 30s and a summarization of a
 * long transcript can exceed it, and losing the lease mid-call would make the
 * note's own lease-guarded write fail silently.
 *
 * The watcher is not fought: it recovers sessions whose lease EXPIRED, and this
 * one is heartbeaten and released. The phase is restored on the way out with
 * `runTurn`'s exact rule — `stopped`, `error` and `awaiting` are decisions and
 * are left alone; anything else returns to `idle`, which is what an idle
 * session that was compacted goes back to being.
 *
 * `awaiting` and `error` are refused on the way IN for the same reason the
 * finally leaves them alone on the way out. Neither is leased — a parked run
 * releases its lease, and a failed one is long gone — so the lease check below
 * cannot see them, and without their own guard a compaction would overwrite
 * the phase with `compacting` and the finally would then "restore" `idle`: an
 * approval nobody can answer any more (`recordVerdict` and the watcher sweep
 * both require `awaiting`, and the next send's overtaken-park branch DELETES
 * the parked turn), or a failure laundered into a healthy-looking session.
 */
export async function compactSession(
  sessionId: string, config: RunConfig,
): Promise<CompactOutcome> {
  if (running.has(sessionId)) return 'busy';

  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return 'gone';
  // An approval is a DECISION, not a state to tidy: a human is being asked
  // something, and the only two answers are approve and deny.
  if (session.phase === 'awaiting') return 'awaiting';
  // A terminal failure is STATUS a UI gates on — a banner, a retry button, an
  // alert. Compaction is bookkeeping; it must not launder one into `idle`.
  if (session.phase === 'error') return 'errored';
  // A live lease is another server's turn (or ours, mid-wind-down). An EXPIRED
  // one is an orphan the watcher will re-run: `claimLease` would take it, and
  // compacting an abandoned turn's half-written transcript is not this call's
  // job — leave it to the recovery that knows how to repair it.
  if (session.lease) return 'busy';

  running.add(sessionId);
  try {
    if (!(await claimLease(sessionId))) return 'busy';
    const beat = setInterval(() => {
      void heartbeat(sessionId).catch(() => { /* the guards catch a lost lease */ });
    }, HEARTBEAT_MS);
    try {
      // The same assembly a turn makes, and for the same reason `maybeCompact`
      // is given `schemas` at all: the compacted head keeps its
      // tool_use/tool_result blocks, and Anthropic rejects a request carrying
      // those with no `tools` parameter.
      const tools = withSkillTool(
        await expandMcpTools(resolveTools(config.tools)), config.skills,
      );
      const history = await AgentMessages
        .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
      const did = await compactNow(
        sessionId, session.agent, config, history, toolSchemas(tools),
        config.interruptCheckMs ?? 250,
      );
      return did ? 'compacted' : 'nothing';
    } finally {
      clearInterval(beat);
      // `compactNow` leaves `phase: 'compacting'` behind on success — inside a
      // turn the next iteration's `streaming` write clears it, and here there
      // is no next iteration. Same terminal list as `runTurn`'s finally, for
      // the same reasons: a stop that landed mid-summarization (the abort poll
      // honors it) and an approval nobody has answered are decisions, not
      // states to tidy up.
      const current = await AgentSessions.findOneAsync(sessionId);
      if (current && !['stopped', 'error', 'awaiting'].includes(current.phase)) {
        await guardedUpdate(sessionId, SERVER_ID, {
          $set: { phase: 'idle', updatedAt: new Date() },
        });
      }
      await releaseLease(sessionId);
    }
  } finally {
    running.delete(sessionId);
  }
}

/**
 * The transcript, as the provider sees it — the single boundary between what
 * is stored and what is sent.
 *
 * Notes are dropped: `kind:'error'`, `'budget'`, `'approval'`, `'compaction'`
 * are the harness's own bookkeeping in a role no provider knows, and
 * `assembleContext` is what turns a compaction note back into something the
 * model reads.
 *
 * `error` becomes `isError`, and only on the rows that have one. The row's
 * `content` is already the error's JSON, but a tool result carries a
 * first-class failure flag on every provider worth the name, and a model told
 * a result failed treats it differently from one it has to infer failure from.
 * The error OBJECT stays behind: `isError` is a boolean on the wire, and the
 * `{error, reason}` detail is already in the content.
 */
export function toProviderMessages(msgs: AgentMessage[]): ProviderMessage[] {
  return msgs
    .filter((m) => m.role !== 'note')
    .map((m) => {
      const out: ProviderMessage = {
        role: m.role as ProviderMessage['role'],
        content: m.content,
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
      };
      if (m.error) out.isError = true;
      return out;
    });
}

/**
 * Erase an assistant message that was committed but whose turn was abandoned,
 * together with the deltas streamed under its id and any tool results that
 * answered it.
 *
 * The deltas matter as much as the message: an abandoned turn's deltas carry a
 * `messageId` that is never committed, so `mergeView`'s committed-id
 * suppression never fires and they render as a `streaming: true` ghost row
 * forever — beside the recovering server's own deltas at the same `msgSeq`.
 *
 * The tool results matter because removing a `tool_use` while leaving its
 * `tool_result` behind is the same 400 in mirror image.
 *
 * Never throws: a failed cleanup must not mask the abandonment it follows.
 * Because it never throws, the ORDER of the removals is what decides which
 * state a half-finished cleanup fails into — see below.
 */
async function discardTurn(
  sessionId: string, messageId: string, turnSeq: number, toolCallIds: string[] = [],
  // Seq of the next assistant message after this turn, when the caller knows
  // it (repair-on-entry does — it already scans the whole transcript to find
  // the window). Defaults to Infinity for the in-turn abandonment call sites
  // below, which are always at the transcript tail: there is no later turn
  // yet whose reused id could be mistaken for this one, so no upper bound is
  // needed there.
  upperBoundSeq: number = Infinity,
): Promise<void> {
  try {
    // Tool results first, deltas next, the assistant row LAST. The assistant
    // row is the repair anchor: `repairUnansweredToolUse` finds an abandoned
    // turn by looking for an assistant whose `tool_use` ids have no matching
    // `tool_result`, so while that row survives the turn stays detectable. Fail
    // part way through in this order and what is left is an unanswered
    // assistant — which the next turn's repair-on-entry cleans up. Remove the
    // assistant first (the old order) and a failure strands a `tool_result`
    // whose `tool_use` is gone: the mirror-image 400, and one repair can never
    // find. Fail toward the repairable state.
    if (toolCallIds.length > 0) {
      await AgentMessages.removeAsync({
        sessionId, role: 'tool',
        toolCallId: { $in: toolCallIds },
        // Scoped to THIS turn on both ends. `Provider` is a user-implementable
        // interface and tool call ids are only ever unique within one provider
        // response — the mock in this very repo reuses `t1` across turns.
        // Without the upper bound, abandoning turn N would also delete a
        // HEALTHY later turn's result whenever it reuses an id, stranding
        // THAT turn's `tool_use` instead — self-healing on the next repair,
        // but at the cost of a 400'd turn in between.
        seq: { $gt: turnSeq, $lt: upperBoundSeq },
      } as any);
    }
    await AgentDeltas.removeAsync({ messageId } as any);
    await AgentMessages.removeAsync({ _id: messageId } as any);
  } catch { /* cleanup is best-effort by design */ }
}

/** One assistant's turn, and the seq range its `tool` rows must live in. */
interface TurnWindow {
  assistant: AgentMessage;
  /** Seq of the NEXT assistant, or Infinity when this is the last turn. */
  windowEnd: number;
  /** The `toolCallId`s answered by a `tool` row INSIDE this window. */
  answered: Set<string | undefined>;
}

/**
 * Split a transcript into per-assistant turn windows.
 *
 * Tool call ids are unique only within one provider response — `Provider` is a
 * user-implementable interface, and this repo's own `mockProvider` reuses `t1`
 * on every turn — so "is this call answered?" is only ever a question about ONE
 * assistant's window: seq greater than that assistant's, less than the next
 * assistant's. Answering it session-wide lets an EARLIER turn's result stand in
 * for a LATER, genuinely-unanswered call.
 *
 * The one place that computes this, for both `repairUnansweredToolUse` (which
 * decides what to DELETE) and `locateBatch` (which decides what to RUN). They
 * were separate before and disagreed: repair scoped per window, locate matched
 * the first assistant carrying the id anywhere in the session.
 */
function turnWindows(msgs: AgentMessage[]): TurnWindow[] {
  const assistants = msgs.filter((m) => m.role === 'assistant');
  return assistants.map((assistant, i) => {
    const windowEnd = assistants[i + 1]?.seq ?? Infinity;
    return {
      assistant,
      windowEnd,
      answered: new Set(
        msgs
          .filter((t) => t.role === 'tool' && t.toolCallId
            && t.seq > assistant.seq && t.seq < windowEnd)
          .map((t) => t.toolCallId),
      ),
    };
  });
}

/**
 * Repair on entry. A turn abandoned between committing `assistant(toolCalls)`
 * and writing its `role: 'tool'` results leaves a `tool_use` with no
 * `tool_result` — which Anthropic and OpenAI both reject with a 400, on every
 * retry, forever. Cleanup at the abandoning end (`discardTurn`) races the
 * recovering server, so the recovering server checks for itself.
 *
 * The scan is over the WHOLE transcript, never just its tail. Tool rows carry a
 * higher `seq` than the assistant they answer, so the moment ONE of a parallel
 * batch is answered the assistant stops being the last message — and parallel
 * tool calls are the default for Anthropic and OpenAI both. A tail check calls
 * `[…, assistant(t1,t2), tool(t1)]` healthy while `t2` 400s every provider call
 * from then on, with no path back. That state is reachable by a plain SIGKILL
 * (deploy, OOM) between two results, and equally by `discardTurn` swallowing
 * its own failure.
 *
 * Returns false if the lease is gone, in which case the caller must abandon
 * without touching anything.
 */
async function repairUnansweredToolUse(sessionId: string): Promise<boolean> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return true;

  // An approval gate parks the transcript on exactly the shape repair deletes:
  // a `gate: 'ask'` tool commits `assistant(toolCalls)` and then waits, with no
  // `tool_result`, for a human to answer. That wait is legitimate history, not
  // an abandoned turn. Unreachable until Milestone 2 wires `pending`/`awaiting`
  // — and the day it does, without this guard repair would silently eat the
  // request the user is being asked to approve. Not dead code: load-bearing the
  // moment gating lands.
  if (session.phase === 'awaiting' || session.pending) return true;

  const msgs = await AgentMessages
    .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();

  // Sweep deltas whose messageId was never committed. A hard crash (SIGKILL,
  // OOM, pod roll) mid-stream leaves deltas under a messageId with no
  // committed message: `discardTurn` never ran, `mergeView`'s committed-id
  // suppression never fires, and the retry streams at the SAME msgSeq — so
  // the client renders the dead half-answer as a second streaming row
  // forever. We hold the lease, and this turn has written no deltas yet, so
  // everything not belonging to a committed message is a crash orphan.
  const committedIds = msgs.map((m) => m._id);
  await AgentDeltas.removeAsync({
    sessionId, messageId: { $nin: committedIds },
  } as any);

  // A toolCall counts as answered only by a `tool` row inside ITS OWN turn's
  // window — see `turnWindows`, which both this and `locateBatch` share so the
  // rule cannot drift between the code that deletes turns and the code that
  // resumes them.
  const stranded = turnWindows(msgs).filter(
    (w) => (w.assistant.toolCalls ?? []).some((c) => !w.answered.has(c.id)),
  );
  if (stranded.length === 0) return true;

  // Under a lease guard: the touch proves we still own the session, and fails
  // closed if another server took it between claim and repair.
  const stillOurs = await guardedUpdate(sessionId, SERVER_ID, {
    $set: { updatedAt: new Date() },
  });
  if (!stillOurs) return false;

  // Every stranded assistant, not just the first: a session that crashed twice
  // holds two of them, and leaving either behind is the same permanent 400.
  // Each one takes its OWN partial answers with it — hence its call ids, its
  // seq, and its window's upper bound, which together scope the tool-row
  // removal to exactly that turn and no other.
  for (const { assistant: m, windowEnd } of stranded) {
    await discardTurn(
      sessionId, m._id, m.seq, (m.toolCalls ?? []).map((c) => c.id), windowEnd,
    );
  }
  return true;
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
type DispatchOutcome = 'completed' | 'parked' | 'abandoned';

interface TurnAnchor {
  userId: string | null;
  /** The session's agent name — half of every hook's ctx. Read off the session
   *  document rather than threaded through `RunConfig`: a CHILD session's
   *  agent is the child's, and the session is the only place that is true. */
  agent: string;
  /** The committed assistant carrying the `tool_use`s — the discard anchor. */
  messageId: string;
  assistantSeq: number;
  /** EVERY call id of that assistant, not just the ones still to run: a
   *  discard has to take the whole batch's results with it. */
  batchIds: string[];
}

/**
 * Dispatch tool calls for one committed assistant, in order, answering each
 * with a `tool` row — or parking the turn on the first `gate: 'ask'` call.
 *
 * Shared by the streaming path and the resume path so a call is gated by the
 * SAME rule wherever it is reached: approving one call says nothing about the
 * next one, and a batch resumed after an approval must re-gate its remainder
 * rather than inherit the verdict.
 */
async function dispatchCalls(
  sessionId: string,
  calls: Array<{ id: string; name: string; args: unknown }>,
  tools: ResolvedTool[],
  turn: TurnAnchor,
  budget: RunConfig['budget'],
  limits: DispatchLimits,
): Promise<DispatchOutcome> {
  const abandon = async (): Promise<DispatchOutcome> => {
    await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
    return 'abandoned';
  };
  const hookCtx: ToolResultHookContext = {
    agent: turn.agent, sessionId, userId: turn.userId,
  };

  for (const call of calls) {
    // §7's backstop, BEFORE the gate: a tool the agent may not use must never
    // park either — asking a human to approve a call the config forbids is a
    // request nothing may grant. Refusal is a result (no toolCalls budget:
    // nothing dispatched), and the model routes around it.
    if (limits.canUse
      && !(await limits.canUse(call.name, { userId: turn.userId, sessionId }))) {
      // Through the hook like every other row: a refusal is still something
      // entering a published transcript, and `afterToolResult`'s contract is
      // that nothing reaches a row unseen.
      const denied: ToolResult = await runAfterToolResult({
        ok: false,
        error: { error: 'not-allowed', reason: `This agent may not use ${call.name}.` },
      }, call, hookCtx);
      const deniedSeq = await allocateSeq(sessionId);
      if (deniedSeq === null) return abandon();
      // `error` comes back from the serializer with the content: a hook may
      // turn this refusal into a SUCCESS (`ToolResult` carries `error` only on
      // the failing arm, but a hook is app code and hands back what it likes),
      // and a result that cannot be serialized at all carries its own.
      const deniedRow = toolResultContent(denied, limits.maxResultChars);
      await AgentMessages.insertAsync({
        _id: Random.id(), sessionId, seq: deniedSeq, role: 'tool',
        toolCallId: call.id,
        content: deniedRow.content,
        error: deniedRow.error,
        createdAt: new Date(),
      } as any);
      continue;
    }
    // Ownership is checked BEFORE dispatch, not after. Adopted tools are real
    // Meteor methods: running one we no longer own means the recovering server
    // runs it a second time — a second charge, a second email. The window
    // between this check and the tool's own side effect is irreducible without
    // idempotency keys carried through to the tools themselves; this narrows
    // the window, it does not close it.
    if (!(await holdsLease(sessionId))) return abandon();

    // An interrupt landing after the assistant committed with toolCalls must
    // discard the turn exactly like an abandonment: committing SOME results
    // and stopping would strand the rest as unanswered tool_use, and
    // repair-on-entry would eat the turn next time anyway.
    const phaseCheck = await AgentSessions.findOneAsync(sessionId);
    if (!phaseCheck || phaseCheck.phase === 'stopped') return abandon();

    // §9: BEFORE the dispatch, off the document we just read — a limit of N
    // permits exactly N calls, because `budgetSpent.toolCalls` is $inc'd in the
    // same atomic write that allocates each result's seq. It counts calls that
    // actually RAN: a park spends nothing (the tool has not executed), and a
    // denial spends nothing (it never dispatched), so a batch that sat at a
    // gate for a day resumes against the same budget it left.
    //
    // The trip precedes the gate check deliberately. Asking a human to approve
    // work the session cannot afford wastes their attention and leaves an
    // approval standing that nothing may spend.
    //
    // Discard exactly as an interrupt does. Committing the results we DID get
    // and stopping would strand the remaining calls as unanswered `tool_use` —
    // a 400 from every provider, forever — and repair-on-entry would eat the
    // turn on the next run anyway. Discard first, note second: if the note's
    // writes fail on a lost lease, what is left is a resumable transcript with
    // no explanation, rather than an explanation over a broken one.
    if (budget?.toolCalls !== undefined
      && (phaseCheck.budgetSpent?.toolCalls ?? 0) >= budget.toolCalls) {
      await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
      await commitBudgetNote(sessionId, 'toolCalls');
      return 'abandoned';
    }

    const tool = tools.find((t) => t.name === call.name);

    if ((tool?.gate ?? 'auto') === 'ask') {
      // Park by EXITING: no process waits here, no timer runs, nothing is
      // held. The committed assistant plus this marker plus `phase:
      // 'awaiting'` ARE the parked state, so it survives a deploy, a crash and
      // a lease expiry alike — approve/deny wake it by deferring a fresh
      // `runTurn`. `repairUnansweredToolUse`'s awaiting/pending guard is what
      // keeps the deliberately-unanswered `tool_use` from being read as an
      // abandoned turn and discarded.
      //
      // Conditional on `phase` as well as the lease. The phase this loop read
      // a few lines up is already stale by the time the park is written, and a
      // lease-only guard would happily overwrite a `stopped` that landed in
      // between — resurrecting a cancelled turn as a live approval request that
      // only approve/deny can ever clear.
      const parked = await AgentSessions.updateAsync(
        {
          _id: sessionId, 'lease.serverId': SERVER_ID, phase: { $ne: 'stopped' },
        } as any,
        {
          $set: {
            phase: 'awaiting',
            pending: {
              toolCallId: call.id, name: call.name, args: call.args, requestedAt: new Date(),
              // MCP only, and only when there is a server to name. The resume
              // needs this to tell "the tool was renamed away" from "its server
              // is down" — see the field's comment in common/types.ts. Spread
              // rather than a plain `undefined` value so a non-MCP park writes
              // no key at all.
              ...(tool?.kind === 'mcp' && tool.mcp?.server
                ? { mcpServer: tool.mcp.server } : {}),
            },
            updatedAt: new Date(),
          },
        } as any,
      );
      // Zero matched is either an interrupt or another server redoing this
      // turn. Both mean the park never became durable, so the half-answered
      // batch must go, exactly as an interrupt caught at the check above.
      if (parked !== 1) return abandon();
      return 'parked';
    }

    const dispatched = tool
      ? await dispatchTool(tool, call.args, {
        userId: turn.userId, sessionId, toolCallId: call.id,
      })
      : {
        result: {
          ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` },
        } as ToolResult,
        childSessionId: undefined,
      };
    const { childSessionId } = dispatched;
    // The `afterToolResult` seam: BEFORE `toolResultContent`'s truncation and
    // before the row is written, so a hook sees the whole result and its
    // replacement is what gets truncated, stored, published and sent to the
    // model. A throwing hook leaves `dispatched.result` standing — see hooks.ts.
    const result = await runAfterToolResult(dispatched.result, call, hookCtx);

    // Same atomic allocation as the commit: `agent.send` can interject between
    // tool results, and read-then-$inc would hand both writers the same seq.
    //
    // §9: ONE tool call is what a subagent costs the parent, exactly like any
    // other tool. Whatever the child spent accrues to the CHILD's session under
    // the child agent's own config — see `runSubagent`. Nothing extra is
    // charged here, and nothing needs to be.
    const toolSeq = await allocateSeq(sessionId, { 'budgetSpent.toolCalls': 1 });
    // The assistant message is already committed but this result never will
    // be: leaving it would strand a tool_use with no tool_result.
    if (toolSeq === null) return abandon();

    const row = toolResultContent(result, limits.maxResultChars);
    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq: toolSeq, role: 'tool',
      toolCallId: call.id,
      content: row.content,
      error: row.error,
      // The handle on the child transcript. Present even for a parked or failed
      // child — that session is exactly what a human needs to open.
      childSessionId,
      createdAt: new Date(),
    } as any);
  }

  return 'completed';
}

/**
 * The assistant that owns a parked call, plus the window its results live in.
 *
 * Scanned from the END (newest turn first) and matched on an UNANSWERED
 * occurrence of the id inside that turn's own window — never on "the first
 * assistant anywhere carrying this id". Tool call ids repeat across turns, so
 * the naive match reliably found an OLD, already-answered turn: the resume
 * would then skip execution and clear `pending`, silently voiding an approval
 * while the real `tool_use` stayed unanswered — and the caller that discards
 * an overtaken park would aim `discardTurn` at a healthy older turn and delete
 * its history.
 *
 * The answered fallback is the crash-between-result-and-`$unset` case: the
 * parked call's row is already committed, so no window holds it unanswered.
 * Returning that turn anyway is what lets the resume skip the tool (one
 * approval, one side effect) and still dispatch the siblings the park never
 * reached.
 */
function locateBatch(msgs: AgentMessage[], toolCallId: string): TurnWindow | null {
  const windows = turnWindows(msgs);
  let answeredMatch: TurnWindow | null = null;
  for (let i = windows.length - 1; i >= 0; i -= 1) {
    const w = windows[i];
    if ((w.assistant.toolCalls ?? []).some((c) => c.id === toolCallId)) {
      if (!w.answered.has(toolCallId)) return w;
      if (answeredMatch === null) answeredMatch = w;
    }
  }
  return answeredMatch;
}

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
async function resumeParkedTurn(
  sessionId: string,
  pending: NonNullable<AgentSession['pending']>,
  tools: ResolvedTool[],
  userId: string | null,
  agent: string,
  budget: RunConfig['budget'],
  limits: DispatchLimits,
): Promise<DispatchOutcome> {
  const msgs = await AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
  const batch = locateBatch(msgs, pending.toolCallId);
  if (!batch) {
    // The assistant is gone (a discard got here first). There is nothing left
    // to answer, so the marker is the only stale thing: drop it and let the
    // turn proceed as an ordinary one — but only if the drop actually landed.
    // Failing the guard means another server owns this session now; falling
    // through to the think loop from here would stream a whole response under
    // a lease we do not hold.
    if (!(await guardedUpdate(sessionId, SERVER_ID, { $unset: { pending: 1 } }))) {
      return 'abandoned';
    }
    return 'completed';
  }
  const { assistant, answered } = batch;
  const calls = assistant.toolCalls ?? [];
  const turn: TurnAnchor = {
    userId,
    agent,
    messageId: assistant._id,
    assistantSeq: assistant.seq,
    batchIds: calls.map((c) => c.id),
  };
  const abandon = async (): Promise<DispatchOutcome> => {
    await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
    return 'abandoned';
  };

  const call = calls.find((c) => c.id === pending.toolCallId);
  // `answered` covers the crash-between-result-and-$unset case: the row is
  // already committed, so re-running the tool would be a second real-world
  // side effect for one approval.
  if (call && !answered.has(pending.toolCallId)) {
    // Visible progress while an approved tool runs — and the interrupt check
    // for this path, which is why its RESULT decides whether the tool runs at
    // all. Zero matched means either the lease went elsewhere or `stopped`
    // landed between the verdict and this write; running the tool anyway would
    // be a real-world side effect the user just cancelled, and `dispatchCalls`
    // would then discard the assistant AND the executed call's `tool` row,
    // leaving a transcript that says "approved" with no record it ever ran.
    //
    // Leave `pending` — verdict and all — exactly where it is. A stop is
    // durable until the next `agent.send` clears it, and the verdict-carrying
    // marker is what makes that send resume this batch rather than strand it.
    const proceeding = await AgentSessions.updateAsync(
      { _id: sessionId, 'lease.serverId': SERVER_ID, phase: { $ne: 'stopped' } } as any,
      { $set: { phase: 'calling', updatedAt: new Date() } } as any,
    );
    // 'parked' rather than 'abandoned': nothing was erased, and something
    // outside this turn (a send clearing the stop) still owes it an answer.
    if (proceeding !== 1) return 'parked';

    const tool = tools.find((t) => t.name === call.name);
    let result: ToolResult;
    let childSessionId: string | undefined;
    if (pending.verdict === 'denied') {
      // A denial is ANSWERED, not dropped. The model has to see the refusal in
      // the transcript to route around it; a missing result would strand the
      // call and a silent success would be a lie.
      result = { ok: false, error: { error: 'denied', reason: pending.reason } };
    } else if (!tool) {
      // Approved, but the tool is no longer in the expanded list. Either way
      // the batch closes cleanly rather than wedging on a name that is not
      // there — but WHICH answer it closes with is a question of honesty.
      //
      // `pending.mcpServer` is the discriminator, recorded when the call
      // parked. A whole-server MCP spec contributes no tools at all while its
      // server is unreachable, so a perfectly healthy config produces exactly
      // the same "no such name" here as a rename does. Reporting `unknown-tool`
      // for it sends an operator hunting a config change that never happened,
      // and tells the model the tool does not exist when it merely cannot be
      // reached right now. `mcp-unavailable` is what the streaming path would
      // have said, so this is the two paths agreeing rather than a special
      // case.
      result = pending.mcpServer
        ? {
          ok: false,
          error: {
            error: 'mcp-unavailable',
            reason: `The MCP server "${pending.mcpServer}" is unavailable: its tool `
              + `"${call.name}" could not be resolved when the approval resumed.`,
          },
        }
        : {
          ok: false,
          error: { error: 'unknown-tool', reason: `No tool named ${call.name}` },
        };
    } else {
      if (!(await holdsLease(sessionId))) return abandon();
      // Same `dispatchTool` the streaming path uses, so an ask-gated SUBAGENT
      // approved by a human opens its child session here exactly as an
      // ungated one would have opened it there.
      ({ result, childSessionId } = await dispatchTool(tool, call.args, {
        userId, sessionId, toolCallId: call.id,
      }));
    }

    // The same `afterToolResult` seam the streaming path runs, at the same
    // point (before truncation, before the row): an approved tool's output, a
    // denial and an `mcp-unavailable` all reach the transcript through here, so
    // a redaction hook cannot be dodged by parking a call.
    result = await runAfterToolResult(result, call, {
      agent, sessionId, userId,
    });

    // A denied call was never dispatched, so it costs no tool budget.
    const seq = await allocateSeq(
      sessionId, pending.verdict === 'denied' ? {} : { 'budgetSpent.toolCalls': 1 },
    );
    if (seq === null) return abandon();

    const row = toolResultContent(result, limits.maxResultChars);
    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq, role: 'tool', toolCallId: call.id,
      content: row.content,
      error: row.error,
      childSessionId,
      createdAt: new Date(),
    } as any);
  }

  // The verdict is spent the moment its call is answered. Clearing the marker
  // is what stops the next entry from reading this run as still parked — and
  // it must happen BEFORE the remainder re-dispatches, or a second gate's park
  // would overwrite a marker that still carried the first one's verdict.
  if (!(await guardedUpdate(sessionId, SERVER_ID, { $unset: { pending: 1 } }))) return abandon();

  const remaining = calls.filter(
    (c) => c.id !== pending.toolCallId && !answered.has(c.id),
  );
  // The approved call itself is NOT budget-checked: a human authorized that
  // specific side effect while the run was parked, and refusing it here would
  // discard the very turn they answered. The remainder goes through the
  // ordinary gate below, so a batch cannot run away past the limit — it can
  // only exceed it by the one call a person signed for.
  return dispatchCalls(sessionId, remaining, tools, turn, budget, limits);
}

/**
 * Run one turn to completion. Assistant messages commit only at boundaries and
 * every abandonment path erases what it had already written, so the transcript
 * a turn leaves behind always ends in `user` or `tool` — the two states a turn
 * can legally start from. A recovering server additionally repairs on entry,
 * because cleanup by the abandoning process is not guaranteed to run at all.
 * Recovery is therefore just calling this again.
 */
export async function runTurn(sessionId: string, config: RunConfig): Promise<void> {
  const maxIterations = config.maxIterations ?? 10;
  const flushMs = config.flushMs ?? 60;
  const interruptCheckMs = config.interruptCheckMs ?? 250;
  // `attempts` counts the INITIAL try, so 1 means "no retry" and 0 means
  // nothing coherent at all: `attemptIndex + 1 < 0` is false on the first
  // pass, so 0 silently behaved as 1 — a config that reads like "never call
  // the provider" quietly calling it once. Floor it instead of trusting it.
  const retryAttempts = Math.max(1, config.retry?.attempts ?? 3);
  const retryBaseMs = config.retry?.baseMs ?? 500;
  const retryMaxDelayMs = config.retry?.maxDelayMs ?? 10_000;
  const limits: DispatchLimits = {
    maxResultChars: config.maxResultChars ?? 8000,
    canUse: config.canUse,
  };
  // Both feed the durable-wake check in the outer `finally` — see there.
  let owned = false;
  let resumed = false;

  if (running.has(sessionId)) return;   // already running in THIS process
  running.add(sessionId);
  try {
    if (!(await claimLease(sessionId))) return;   // another server owns this run
    owned = true;

    // LEASE_MS is 30s; one provider call plus a tool round trip routinely
    // exceeds that. Without this, losing the lease mid-turn is the normal case.
    const beat = setInterval(() => {
      void heartbeat(sessionId).catch(() => { /* the guards catch a lost lease */ });
    }, HEARTBEAT_MS);

    try {
      // The ONE async step in tool assembly, and the only concession the loop
      // makes to MCP: a `{ mcp: … }` spec carries a server name, and its
      // description, its schema and (for a whole-server spec) its very
      // existence come from that server's `tools/list`. Resolution stays
      // synchronous; discovery is awaited here, once per turn, before anything
      // is shown to the model. Connections and catalogs are cached per process,
      // so this is a Map lookup from the second turn on, and a no-op array
      // pass-through for an agent with no MCP tools. A server that is down
      // costs one failed connect and never fails the turn — see
      // `expandMcpTools`.
      //
      // AFTER `claimLease`, and after the heartbeat is running, deliberately.
      // Discovery spawns subprocesses and can burn a full
      // `MCP_DISCOVERY_TIMEOUT_MS` per server; doing it before the lease meant
      // a run that another server already owns paid the whole bill before
      // finding out it had nothing to do — every duplicate wake-up spawning its
      // own copy of every MCP server. Under the heartbeat, a slow discovery
      // cannot cost us the lease either. Nothing above reads `tools` or
      // `schemas`, so there is nothing to reorder around.
      //
      // The built-in `skill` loader joins the list AFTER expansion, for a
      // reason that only shows up with MCP in the tree: a whole-server spec's
      // tool names are not known until discovery has run, so appending earlier
      // could put two tools named `skill` in front of a provider that rejects
      // duplicates outright. Appending here makes the collision visible, and
      // `withSkillTool` resolves it in the app's favor with one warning.
      const tools = withSkillTool(
        await expandMcpTools(resolveTools(config.tools)), config.skills,
      );
      const schemas = toolSchemas(tools);

      if (!(await repairUnansweredToolUse(sessionId))) return;

      // An approval gate is resolved BEFORE the think loop, because the
      // transcript currently ends in an unanswered `tool_use`: streaming from
      // here would 400 on every provider. Once the batch is answered the
      // history ends in a `tool` row — the ordinary shape an iteration expects.
      const entry = await AgentSessions.findOneAsync(sessionId);
      if (!entry) return;
      if (entry.pending) {
        if (!entry.pending.verdict) {
          // Still parked, and re-entry here is the recovering-server case: exit
          // exactly as the parking run did, leaving the marker standing.
          //
          // 'awaiting' is a live request waiting on a human, and ONLY
          // approve/deny resolves it. A send that arrives while awaiting does
          // not cancel the approval and does not wake anything: `agent.send`
          // clears 'stopped'/'error' and nothing else, so the message is
          // QUEUED — it sits in the transcript until a verdict resumes the
          // batch, at which point the think loop reads the whole history and
          // answers it along with the tool results. (To cancel instead, the
          // caller interrupts first: that is what 'stopped' below is.)
          //
          // 'stopped' is that same request with an interrupt over it. There a
          // later send DOES clear the phase, and the overtaken branch below
          // discards the dead request rather than leaving its `tool_use`
          // unanswered.
          if (entry.phase === 'awaiting' || entry.phase === 'stopped') return;

          // Any other phase means the park was OVERTAKEN: `agent.interrupt`
          // stopped it and a later `agent.send` cleared the stop to 'idle'.
          // approve/deny require 'awaiting', so nothing can ever answer this
          // call now — and an unanswered `tool_use` 400s every provider call
          // from here on. Discard the dead turn exactly as an interrupt during
          // dispatch already does, then answer the message the user just sent.
          const msgs = await AgentMessages
            .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
          const batch = locateBatch(msgs, entry.pending.toolCallId);
          if (batch) {
            await discardTurn(
              sessionId, batch.assistant._id, batch.assistant.seq,
              (batch.assistant.toolCalls ?? []).map((c) => c.id), batch.windowEnd,
            );
          }
          if (!(await guardedUpdate(sessionId, SERVER_ID, { $unset: { pending: 1 } }))) return;
        } else {
          resumed = true;
          const outcome = await resumeParkedTurn(
            sessionId, entry.pending, tools, entry.userId, entry.agent,
            config.budget, limits,
          );
          // 'parked' means the NEXT gate in the same batch is now waiting on a
          // human; 'abandoned' means the turn is gone. Either way the think
          // loop must not run.
          if (outcome !== 'completed') return;
        }
      }

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const session = await AgentSessions.findOneAsync(sessionId);
        if (!session) return;
        // An interrupt is durable until the next send clears it (`agent.send`
        // flips stopped→idle). Without this check the unconditional
        // 'streaming' write below would silently erase a stop that landed
        // between iterations — or between Meteor.defer and the first one.
        if (session.phase === 'stopped') return;

        // §9: BEFORE the provider call, not after it — the point of a spend cap
        // is to prevent the next charge, and a check after the fact only
        // reports one. Reading it per ITERATION rather than once per turn is
        // what makes a tool-using run stop at the boundary instead of running
        // its whole batch out: each iteration is another model call.
        //
        // `>=` against the accrued total, so the turn that CROSSES the cap
        // still completes (its cost was already committed to when it started)
        // and the next one is refused. Combined with the note's
        // `phase: 'stopped'`, a session that has overspent needs an operator to
        // raise the budget: the next send clears the stop, and the very first
        // iteration trips again right here, before spending anything.
        if (config.budget?.spend !== undefined
          && session.usage.cost >= config.budget.spend) {
          await commitBudgetNote(sessionId, 'spend');
          return;
        }

        let history = await AgentMessages
          .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();

        // §9: compact BEFORE this iteration's provider call, so the call that
        // would have overflowed is the one that benefits. A committed note
        // changes the assembled view; re-read so this iteration streams
        // against it (the note also occupies a seq).
        if (await maybeCompact(
          sessionId, session.agent, config, history, schemas, interruptCheckMs,
        )) {
          history = await AgentMessages
            .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
        }

        const historyMaxSeq = history.length ? history[history.length - 1].seq : -1;

        let messageId = Random.id();
        // Deltas sort the in-flight row at the seq the message is EXPECTED to
        // commit at. If a user message interjects mid-stream, the committed
        // assistant lands one seq later (allocated atomically below) and the
        // committed row simply supersedes the in-flight one at its new, still
        // correct position — after the interjection, which is what a reader
        // expects. Retries reuse this SAME msgSeq (only messageId changes per
        // attempt): a retry is still logically the one reply this iteration
        // owes the transcript.
        const msgSeq = session.nextSeq;

        let text = '';
        let thinking = '';
        let toolCalls: Array<{ id: string; name: string; args: unknown }> | undefined;
        let usage: { input: number; output: number; cost?: number } = { input: 0, output: 0 };
        let interrupted = false;

        // §10: pi-ai's adapter (and any other Provider) turns a terminal
        // provider failure into a THROW mid-iteration, not a rejected
        // promise. One pass of this loop is one attempt: a fresh DeltaWriter
        // over a fresh messageId, because a failed attempt's deltas are
        // removed below and a retry must never stream under an id a
        // straggler flush from the dead attempt could still land under.
        for (let attemptIndex = 0; ; attemptIndex += 1) {
          // Per ATTEMPT, not once per iteration: a retry that left the phase
          // on 'retrying' for the whole of its own stream tells the client a
          // retry is still pending while tokens are already arriving.
          // 'retrying' must be visible only BETWEEN attempts.
          //
          // Phase-conditional as well as lease-guarded: compaction sits
          // between the iteration head's stopped-check and this write, a full
          // provider round trip in which an interrupt can land. A lease-only
          // write here would erase it — the M2 retry-branch hole, reopened.
          // Zero matched (stop OR lost lease) → return; the finally preserves
          // a stop.
          const streaming = await AgentSessions.updateAsync(
            { _id: sessionId, 'lease.serverId': SERVER_ID, phase: { $ne: 'stopped' } } as any,
            { $set: { phase: 'streaming', updatedAt: new Date() } } as any,
          );
          if (streaming !== 1) return;

          const writer = new DeltaWriter(sessionId, messageId, msgSeq, flushMs);
          text = '';
          thinking = '';
          toolCalls = undefined;
          usage = { input: 0, output: 0 };
          interrupted = false;
          let lastPhaseCheck = Date.now();
          let providerError: unknown = null;
          // Fresh per attempt: an aborted attempt's signal must not poison its
          // retry, and a signal is single-shot.
          const abort = new AbortController();

          try {
            // The `beforeProviderRequest` seam for the turn's own call. Run per
            // ATTEMPT rather than once per iteration, so a retry re-runs the
            // chain instead of resending a request a hook built before the
            // backoff (a hook stamping the current time is the obvious case).
            //
            // `signal` is attached AFTER the hooks and never handed to them to
            // preserve: a hook that rebuilds the request wholesale must not be
            // able to silently disable the interrupt — cancellation is the
            // harness's contract with the user, not the extension's.
            const request = await runBeforeProviderRequest({
              model: config.model, system: config.system,
              // The COMPACTED view when a compaction note stands; the raw
              // (note-filtered) transcript otherwise.
              messages: assembleContext(history), tools: schemas,
            }, { agent: session.agent, sessionId, purpose: 'think' });
            try {
              for await (const chunk of config.provider.stream({
                ...request, signal: abort.signal,
              })) {
                if (chunk.kind === 'text') { text += chunk.chunk; writer.push('text', chunk.chunk); }
                else if (chunk.kind === 'thinking') {
                  thinking += chunk.chunk; writer.push('thinking', chunk.chunk);
                } else if (chunk.kind === 'tool_args') {
                  // Streamed for FIDELITY, not for dispatch: the tool calls the
                  // loop actually runs come off the terminal `done` chunk,
                  // already parsed. These deltas exist so a client can show a
                  // tool call forming, and they carry `contentIndex` so two
                  // calls forming at once stay apart. Nothing accumulates them
                  // in memory here — a partial-JSON buffer the commit never
                  // reads would be dead weight on every turn.
                  writer.push('tool_args', chunk.chunk, chunk.contentIndex);
                } else if (chunk.kind === 'done') {
                  toolCalls = chunk.toolCalls;
                  usage = chunk.usage ?? usage;
                }
                // Honor an interrupt WHILE streaming, not after. `agent.interrupt`
                // sets `phase: 'stopped'`; without this check the stream runs to
                // completion, commits, and dispatches its tools anyway — a stop
                // button that only relabels the phase after the fact.
                if (Date.now() - lastPhaseCheck >= interruptCheckMs) {
                  lastPhaseCheck = Date.now();
                  const s = await AgentSessions.findOneAsync(sessionId);
                  if (!s || s.phase === 'stopped') {
                    // Abort BEFORE breaking: the break only stops consuming;
                    // the abort is what cancels the HTTP request behind the
                    // stream, which otherwise keeps arriving and billing.
                    abort.abort();
                    interrupted = true;
                    break;
                  }
                }
              }
            } finally {
              // A tail-flush rejection is NOT a provider failure. `stop()`
              // propagates an `insertAsync` rejection, so a Mongo blip after a
              // fully successful stream would land in `providerError`,
              // classify retryable (no status), and re-stream the entire
              // response — a second provider charge for a database hiccup.
              // The commit is built from the in-memory `text`, not from
              // deltas, so a lost tail flush costs nothing durable.
              await writer.stop().catch(() => {
                /* deltas are ephemeral; the commit supersedes them */
              });
            }
          } catch (e) {
            providerError = e;
          }

          if (providerError) {
            // Per-attempt cleanup: this attempt's partial never commits, so
            // its deltas must not linger as a streaming ghost row either.
            await AgentDeltas.removeAsync({ messageId } as any);

            // A stop outranks BOTH the retry and the error note. Re-read the
            // session once here because this branch is otherwise blind to an
            // interrupt: an attempt that throws before yielding a single chunk
            // (the ordinary 429/503 shape) never runs the in-stream check at
            // all, and every write below is guarded on the LEASE only — so a
            // `stopped` written by `agent.interrupt` while the attempt was
            // failing would be overwritten with 'retrying', the after-sleep
            // re-check would read back the value this branch itself wrote, and
            // a later attempt would commit a message the user cancelled. The
            // same hole let the fatal path stamp an error note over a stop.
            // The `finally` preserves `stopped`, so returning is enough.
            const live = await AgentSessions.findOneAsync(sessionId);
            if (interrupted || !live || live.phase === 'stopped') return;

            const classification = classifyProviderError(providerError);
            // An abandoned request is the interrupt path with a different
            // trigger: deltas are already cleaned above, no note is owed to
            // the user (nothing failed AT them), and the finally preserves a
            // stop if one stands. Returning here is the whole handling.
            if (classification === 'abandon') return;
            const hasMoreAttempts = attemptIndex + 1 < retryAttempts;
            if (classification === 'retryable' && hasMoreAttempts) {
              if (!(await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'retrying' } }))) return;
              await sleep(backoff(attemptIndex, retryBaseMs, retryMaxDelayMs));
              // The interrupt check above only fires WHILE a stream is
              // running; re-check here so an interrupt landing during the
              // backoff sleep itself still stops the turn, instead of being
              // silently overwritten by the next attempt's 'streaming' phase.
              const afterSleep = await AgentSessions.findOneAsync(sessionId);
              if (!afterSleep || afterSleep.phase === 'stopped') return;
              messageId = Random.id(); // fresh id: the old deltas are gone
              continue;
            }

            // Fatal, or every attempt exhausted: commit a sanitized note
            // through the normal atomic path and end the turn in a
            // terminal, visible phase. NEVER the raw provider message — it
            // can carry request headers, key fragments, or other upstream
            // detail that must not reach the transcript.
            const noteSeq = await allocateSeq(sessionId);
            if (noteSeq !== null) {
              await AgentMessages.insertAsync({
                _id: Random.id(), sessionId, seq: noteSeq, role: 'note', kind: 'error',
                error: { error: 'provider-failed', reason: 'The model request failed.' },
                createdAt: new Date(),
              } as any);
              await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'error' } });
            } else {
              // The only silent exit in this structure: the lease went to
              // another server between the failure and the note, so neither
              // the note nor the terminal phase can be written and the
              // session is left showing whatever phase it last had.
              console.warn(
                `[10thfloor:agent] lost lease before error note; session ${sessionId} `
                + 'may display a stale phase',
              );
            }
            return;
          }

          break; // this attempt succeeded; fall through to commit below
        }

        if (interrupted) {
          // Nothing committed yet: the partial exists only as deltas. Remove
          // them or they render as a streaming ghost row forever.
          await AgentDeltas.removeAsync({ messageId } as any);
          return;
        }

        // Commit is conditional on still owning the lease, and the seq is
        // allocated ATOMICALLY in the same write — see allocateSeq. Losing the
        // lease means another server is redoing this turn; abandon without
        // writing, taking the deltas streamed under this messageId with us.
        // Cost rides the SAME atomic write that allocates the seq and accrues
        // the tokens — no second write, and no window in which a committed
        // message exists whose cost the spend budget has not yet seen.
        const commitSeq = await allocateSeq(sessionId, {
          'usage.input': usage.input,
          'usage.output': usage.output,
          'usage.cost': accruedCost(usage, config.pricing),
        });
        if (commitSeq === null) { await discardTurn(sessionId, messageId, msgSeq); return; }

        await AgentMessages.insertAsync({
          _id: messageId, sessionId, seq: commitSeq, role: 'assistant',
          content: text, thinking: thinking || undefined,
          toolCalls, usage, createdAt: new Date(),
        } as any);

        // The committed message supersedes its deltas; remove them now rather
        // than letting them accumulate. Without this, subscribing to an old
        // session ships every token ever streamed in it, and the client
        // re-merges the full delta history on every flush of the NEXT turn.
        // Ordering is safe: the client receives the committed message first,
        // and mergeView already suppresses deltas by committed id.
        await AgentDeltas.removeAsync({ messageId } as any);

        if (!toolCalls || toolCalls.length === 0) {
          // A send that landed mid-stream committed a user message this turn
          // never saw (its history was read before the interjection). Ending
          // the turn here would strand that message unanswered until the user
          // sends AGAIN — so loop instead, still bounded by maxIterations.
          const interjected = await AgentMessages.findOneAsync({
            sessionId, role: 'user', seq: { $gt: historyMaxSeq },
          } as any);
          if (interjected) continue;
          return;
        }

        const callIds = toolCalls.map((c) => c.id);
        await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'calling' } });

        const outcome = await dispatchCalls(sessionId, toolCalls, tools, {
          userId: session.userId,
          agent: session.agent,
          messageId,
          assistantSeq: commitSeq,
          batchIds: callIds,
        }, config.budget, limits);
        // A park exits the turn with the batch deliberately unanswered; an
        // abandonment has already erased it. Only a fully answered batch may
        // go round again and ask the model what to do with the results.
        if (outcome !== 'completed') return;
      }
    } finally {
      clearInterval(beat);
      // `stopped` is a deliberate terminal state set by an interrupt, `error`
      // is the terminal state this turn just set on a fatal or exhausted
      // provider failure, and `awaiting` is a live approval request — idling
      // any of them back would erase the decision (the user's stop, the
      // failure the transcript note just recorded, or the question a human is
      // being asked) that the phase exists to preserve. For `awaiting` the
      // damage would be worse than cosmetic: approve/deny only fire on that
      // phase, so idling it back would strand the parked call permanently.
      const terminal = ['stopped', 'error', 'awaiting'];
      const current = await AgentSessions.findOneAsync(sessionId);
      if (current && !terminal.includes(current.phase)) {
        await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'idle' } });
      }
      await releaseLease(sessionId);
    }
  } finally {
    running.delete(sessionId);

    // The wake is otherwise not durable. `agent.approve`/`agent.deny` record a
    // verdict and defer a resume; if that verdict lands in the window between
    // this turn's park write and the two lines above (the `releaseLease` in the
    // inner `finally`, then `running.delete`), the deferred resume hits
    // `running.has` in this process — or `claimLease` from another server —
    // returns immediately, and NOTHING retries. What is left is a recorded
    // verdict, `phase: 'idle'`, a tool that never ran, and a UI that says the
    // turn is done. This closes that window: the state is re-read once here,
    // after the lease is released and the in-process guard is clear, so a
    // verdict that raced the wind-down still gets a run of its own.
    //
    // Bounded, not a watcher. It fires only for a run that actually held the
    // lease (`owned`) and that did not itself resume a verdict (`resumed`) —
    // the pair that stops a rescued run from rescuing itself forever, and stops
    // a run that never got the lease from spinning against the server that did.
    // `awaiting` means the batch re-parked on its NEXT gate (nobody's verdict to
    // spend), and `stopped` means an interrupt outranks the verdict until a
    // send clears it: neither is ours to wake.
    if (owned && !resumed) {
      const after = await AgentSessions.findOneAsync(sessionId).catch(() => null);
      // 'error' belongs in this exclusion list for the same reason it is in
      // the finally's terminal list: a failed turn is not ours to wake, and
      // the two lists disagreeing was itself a reviewed defect.
      if (after?.pending?.verdict
        && after.phase !== 'awaiting' && after.phase !== 'stopped' && after.phase !== 'error'
        && !running.has(sessionId)) {
        // WHICH verdict this wake is for. `writeVerdict` stamps a fresh token
        // with every verdict, so this is identity where the old re-check had
        // only a boolean: a verdict consumed, the batch re-parked on its next
        // gate, and a SECOND verdict written (with its own deferred resume
        // already queued) all before this timer fires is three writes that
        // still leave "a verdict stands" true — and this callback would then
        // run a turn nobody asked for, behind the resume that already owns it.
        // Undefined only for a verdict written before the field existed, where
        // the comparison degrades to the old boolean form rather than
        // stranding the session.
        const wakeToken = after.pending.wakeToken;
        // `setTimeout(…, 0)` rather than `Meteor.defer`: this module is
        // deliberately free of the Meteor namespace (methods.ts owns that
        // plumbing and calls in), and the only thing `defer` would add is an
        // environment binding a fresh `runTurn` has no use for — it reads its
        // own session and takes no ambient method invocation. The `.catch` is
        // the same load-bearing one `deferTurn` uses: an unhandled rejection is
        // fatal by default on Node >= 15.
        setTimeout(() => {
          void (async () => {
            // Re-read INSIDE the deferred callback, not before it: the
            // legitimate resume can start AND finish between the check above
            // and this timer firing. It spends the verdict; a woken run that
            // then finds no `pending` would fall straight into the think loop
            // and make a provider call nobody asked for — a charge, and an
            // assistant row appended to a turn the user considered finished.
            const still = await AgentSessions.findOneAsync(sessionId).catch(() => null);
            if (!still?.pending?.verdict
              || still.pending.wakeToken !== wakeToken
              || still.phase === 'awaiting' || still.phase === 'stopped'
              || still.phase === 'error' || running.has(sessionId)) return;
            await runTurn(sessionId, config);
          })().catch((e) => {
            console.error(`[10thfloor:agent] wake-up turn failed for session ${sessionId}:`, e);
          });
        }, 0);
      }
    }
  }
}
