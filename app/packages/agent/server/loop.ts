import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage, AgentSession } from '../common/types';
import type { Provider, ProviderMessage } from './providers/types';
import {
  claimLease, guardedUpdate, heartbeat, holdsLease, releaseLease,
  HEARTBEAT_MS, SERVER_ID,
} from './lease';
import {
  resolveTools, runTool, toolSchemas,
  type ResolvedTool, type ToolResult, type ToolSpec,
} from './tools';

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
  /** §10: bounded retry with exponential backoff for a provider stream that
   *  throws mid-iteration. `attempts` counts the initial try (default 3);
   *  `baseMs` is the base of `baseMs * 2^attemptIndex` (default 500). */
  retry?: { attempts?: number; baseMs?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** §10: 429, 5xx and network-ish errors retry; 4xx auth/request errors do
 *  not. Anything unclassifiable is treated as retryable — a transient blip
 *  should not permanently kill a session, and retries are bounded anyway.
 *
 *  An explicit `e.retryable` hint (set by an adapter that has better
 *  information than an HTTP status — pi-ai's own transient-error classifier,
 *  for one) short-circuits the status-based classification in either
 *  direction. */
export function classifyProviderError(e: any): 'retryable' | 'fatal' {
  if (e?.retryable === true) return 'retryable';
  if (e?.retryable === false) return 'fatal';
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return 'retryable';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'fatal';
  return 'retryable';
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

/**
 * Sessions running a turn IN THIS PROCESS. `claimLease` succeeds on its
 * "already ours" branch, so two concurrent `runTurn` calls in one process would
 * both hold the lease and both pass every `guardedUpdate`; the read-then-`$inc`
 * of `nextSeq` is not atomic, so both could insert at the same `seq`. The
 * lease protects against a second SERVER, this Set against a second CALL —
 * a double-submitting user reaching `Meteor.defer(() => runTurn(...))` twice.
 */
const running = new Set<string>();

/** Buffers deltas and flushes on an interval so a long response is O(chunk)
 *  on the wire rather than O(n²). */
class DeltaWriter {
  private buf: Array<{ kind: string; chunk: string; seq: number }> = [];
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
   */
  push(kind: string, chunk: string) {
    const last = this.buf[this.buf.length - 1];
    if (last && last.kind === kind) { last.chunk += chunk; return; }
    this.buf.push({ kind, chunk, seq: this.seq++ });
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
        for (const item of batch) {
          await AgentDeltas.insertAsync({
            _id: Random.id(),
            sessionId: this.sessionId,
            messageId: this.messageId,
            msgSeq: this.msgSeq,
            seq: item.seq,
            kind: item.kind as any,
            chunk: item.chunk,
            at: new Date(),
          } as any);
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

function toProviderMessages(msgs: AgentMessage[]): ProviderMessage[] {
  return msgs
    .filter((m) => m.role !== 'note')
    .map((m) => ({
      role: m.role as ProviderMessage['role'],
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
    }));
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
): Promise<DispatchOutcome> {
  const abandon = async (): Promise<DispatchOutcome> => {
    await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
    return 'abandoned';
  };

  for (const call of calls) {
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

    const result = tool
      ? await runTool(tool, call.args, { userId: turn.userId, sessionId })
      : { ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` } };

    // Same atomic allocation as the commit: `agent.send` can interject between
    // tool results, and read-then-$inc would hand both writers the same seq.
    const toolSeq = await allocateSeq(sessionId, { 'budgetSpent.toolCalls': 1 });
    // The assistant message is already committed but this result never will
    // be: leaving it would strand a tool_use with no tool_result.
    if (toolSeq === null) return abandon();

    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq: toolSeq, role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify(result.ok ? result.value : result.error),
      error: result.ok ? undefined : result.error,
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
    if (pending.verdict === 'denied') {
      // A denial is ANSWERED, not dropped. The model has to see the refusal in
      // the transcript to route around it; a missing result would strand the
      // call and a silent success would be a lie.
      result = { ok: false, error: { error: 'denied', reason: pending.reason } };
    } else if (!tool) {
      // Approved, but the tool is no longer in the config — a rename or a
      // removal deployed while the request sat on someone's screen. Same
      // answer the streaming path gives an unknown call, so the batch closes
      // cleanly instead of wedging on a name that no longer exists.
      result = { ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` } };
    } else {
      if (!(await holdsLease(sessionId))) return abandon();
      result = await runTool(tool, call.args, { userId, sessionId });
    }

    // A denied call was never dispatched, so it costs no tool budget.
    const seq = await allocateSeq(
      sessionId, pending.verdict === 'denied' ? {} : { 'budgetSpent.toolCalls': 1 },
    );
    if (seq === null) return abandon();

    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq, role: 'tool', toolCallId: call.id,
      content: JSON.stringify(result.ok ? result.value : result.error),
      error: result.ok ? undefined : result.error,
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
  return dispatchCalls(sessionId, remaining, tools, turn);
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
  const tools = resolveTools(config.tools);
  const schemas = toolSchemas(tools);

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
            sessionId, entry.pending, tools, entry.userId,
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

        const history = await AgentMessages
          .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
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
        let usage = { input: 0, output: 0 };
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
          if (!(await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'streaming' } }))) return;

          const writer = new DeltaWriter(sessionId, messageId, msgSeq, flushMs);
          text = '';
          thinking = '';
          toolCalls = undefined;
          usage = { input: 0, output: 0 };
          interrupted = false;
          let lastPhaseCheck = Date.now();
          let providerError: unknown = null;

          try {
            try {
              for await (const chunk of config.provider.stream({
                model: config.model, system: config.system,
                messages: toProviderMessages(history), tools: schemas,
              })) {
                if (chunk.kind === 'text') { text += chunk.chunk; writer.push('text', chunk.chunk); }
                else if (chunk.kind === 'thinking') {
                  thinking += chunk.chunk; writer.push('thinking', chunk.chunk);
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
                  if (!s || s.phase === 'stopped') { interrupted = true; break; }
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
            const hasMoreAttempts = attemptIndex + 1 < retryAttempts;
            if (classification === 'retryable' && hasMoreAttempts) {
              if (!(await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'retrying' } }))) return;
              await sleep(retryBaseMs * 2 ** attemptIndex);
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
        const commitSeq = await allocateSeq(sessionId, {
          'usage.input': usage.input,
          'usage.output': usage.output,
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
          messageId,
          assistantSeq: commitSeq,
          batchIds: callIds,
        });
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
      if (after?.pending?.verdict
        && after.phase !== 'awaiting' && after.phase !== 'stopped'
        && !running.has(sessionId)) {
        // `setTimeout(…, 0)` rather than `Meteor.defer`: this module is
        // deliberately free of the Meteor namespace (methods.ts owns that
        // plumbing and calls in), and the only thing `defer` would add is an
        // environment binding a fresh `runTurn` has no use for — it reads its
        // own session and takes no ambient method invocation. The `.catch` is
        // the same load-bearing one `deferTurn` uses: an unhandled rejection is
        // fatal by default on Node >= 15.
        setTimeout(() => {
          runTurn(sessionId, config).catch((e) => {
            console.error(`[10thfloor:agent] wake-up turn failed for session ${sessionId}:`, e);
          });
        }, 0);
      }
    }
  }
}
