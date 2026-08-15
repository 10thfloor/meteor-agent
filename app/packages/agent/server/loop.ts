import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage } from '../common/types';
import type { Provider, ProviderMessage } from './providers/types';
import {
  claimLease, guardedUpdate, heartbeat, holdsLease, releaseLease,
  HEARTBEAT_MS, SERVER_ID,
} from './lease';
import { resolveTools, runTool, toolSchemas, type ToolSpec } from './tools';

export interface RunConfig {
  model: string;
  system: string;
  tools: ToolSpec[];
  provider: Provider;
  maxIterations?: number;
  flushMs?: number;
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

  // A toolCall counts as answered only by a `tool` row inside ITS OWN turn's
  // window — seq greater than the assistant's own seq, and less than the seq
  // of the NEXT assistant message (unbounded if there isn't one). Matching
  // across the whole session, as before, lets an EARLIER turn's result
  // silently answer for a LATER, genuinely-unanswered call: tool call ids are
  // only unique within one provider response (this repo's own `mockProvider`
  // reuses `t1` on every turn), so `assistant(seq 1, t1)` answered by
  // `tool(seq 2, t1)` would forever hide a second, truly-stranded
  // `assistant(seq 5, t1)` — a permanent 400 with no self-heal.
  const assistants = msgs.filter((m) => m.role === 'assistant');
  const stranded: Array<{ msg: AgentMessage; windowEnd: number }> = [];
  assistants.forEach((m, i) => {
    if (!m.toolCalls || m.toolCalls.length === 0) return;
    const windowEnd = assistants[i + 1]?.seq ?? Infinity;
    const answeredInWindow = new Set(
      msgs
        .filter((t) => t.role === 'tool' && t.toolCallId && t.seq > m.seq && t.seq < windowEnd)
        .map((t) => t.toolCallId),
    );
    if (m.toolCalls.some((c) => !answeredInWindow.has(c.id))) {
      stranded.push({ msg: m, windowEnd });
    }
  });
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
  for (const { msg: m, windowEnd } of stranded) {
    await discardTurn(
      sessionId, m._id, m.seq, (m.toolCalls ?? []).map((c) => c.id), windowEnd,
    );
  }
  return true;
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
  const tools = resolveTools(config.tools);
  const schemas = toolSchemas(tools);

  if (running.has(sessionId)) return;   // already running in THIS process
  running.add(sessionId);
  try {
    if (!(await claimLease(sessionId))) return;   // another server owns this run

    // LEASE_MS is 30s; one provider call plus a tool round trip routinely
    // exceeds that. Without this, losing the lease mid-turn is the normal case.
    const beat = setInterval(() => {
      void heartbeat(sessionId).catch(() => { /* the guards catch a lost lease */ });
    }, HEARTBEAT_MS);

    try {
      if (!(await repairUnansweredToolUse(sessionId))) return;

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const session = await AgentSessions.findOneAsync(sessionId);
        if (!session) return;

        const history = await AgentMessages
          .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();

        const messageId = Random.id();
        const msgSeq = session.nextSeq;
        if (!(await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'streaming' } }))) return;

        const writer = new DeltaWriter(sessionId, messageId, msgSeq, flushMs);
        let text = '';
        let thinking = '';
        let toolCalls: Array<{ id: string; name: string; args: unknown }> | undefined;
        let usage = { input: 0, output: 0 };

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
          }
        } finally {
          await writer.stop();
        }

        // Commit is conditional on still owning the lease. Losing it means
        // another server is redoing this turn; abandon without writing — and
        // take the deltas already streamed under this messageId with us, or
        // they render as a permanent ghost message.
        const stillOurs = await guardedUpdate(sessionId, SERVER_ID, {
          $inc: {
            nextSeq: 1,
            'usage.input': usage.input,
            'usage.output': usage.output,
          },
          $set: { updatedAt: new Date() },
        });
        if (!stillOurs) { await discardTurn(sessionId, messageId, msgSeq); return; }

        await AgentMessages.insertAsync({
          _id: messageId, sessionId, seq: msgSeq, role: 'assistant',
          content: text, thinking: thinking || undefined,
          toolCalls, usage, createdAt: new Date(),
        } as any);

        if (!toolCalls || toolCalls.length === 0) return;

        const callIds = toolCalls.map((c) => c.id);
        await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'calling' } });

        for (const call of toolCalls) {
          // Ownership is checked BEFORE dispatch, not after. Adopted tools are
          // real Meteor methods: running one we no longer own means the
          // recovering server runs it a second time — a second charge, a
          // second email. The window between this check and the tool's own
          // side effect is irreducible without idempotency keys carried
          // through to the tools themselves; this narrows the window, it does
          // not close it.
          if (!(await holdsLease(sessionId))) {
            await discardTurn(sessionId, messageId, msgSeq, callIds);
            return;
          }

          const tool = tools.find((t) => t.name === call.name);
          const result = tool
            ? await runTool(tool, call.args, { userId: session.userId, sessionId })
            : { ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` } };

          const after = await AgentSessions.findOneAsync(sessionId);
          if (!after) return;
          if (!(await guardedUpdate(sessionId, SERVER_ID, {
            $inc: { nextSeq: 1, 'budgetSpent.toolCalls': 1 },
          }))) {
            // The assistant message is already committed but this result never
            // will be: leaving it would strand a tool_use with no tool_result.
            await discardTurn(sessionId, messageId, msgSeq, callIds);
            return;
          }

          await AgentMessages.insertAsync({
            _id: Random.id(), sessionId, seq: after.nextSeq, role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(result.ok ? result.value : result.error),
            error: result.ok ? undefined : result.error,
            createdAt: new Date(),
          } as any);
        }
      }
    } finally {
      clearInterval(beat);
      // `stopped` is a deliberate terminal state set by an interrupt; idling it
      // back would erase the user's decision.
      const current = await AgentSessions.findOneAsync(sessionId);
      if (current && current.phase !== 'stopped') {
        await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'idle' } });
      }
      await releaseLease(sessionId);
    }
  } finally {
    running.delete(sessionId);
  }
}
