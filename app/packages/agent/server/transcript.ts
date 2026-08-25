import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage, SessionParticipant } from '../common/types';
import { needsAttribution } from '../common/participants';
import type { ProviderMessage } from './providers/types';
import { guardedUpdate, SERVER_ID } from './lease';
import { attachmentSuffix } from './attachments';

/**
 * The transcript layer: turning the stored message log into what a provider
 * sees, computing per-turn windows, repairing abandoned turns, and the
 * batch-safe boundary walk shared by compaction and forking.
 *
 * A leaf module — it imports only the collections, the message type, the
 * lease guard and the attachment store (itself a leaf), so both
 * `compaction.ts` (`batchSafeBoundary`) and `dispatch.ts` (`discardTurn`,
 * `locateBatch`) can depend on it without a cycle back through `loop.ts`.
 */

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
 *
 * A USER row carrying attachment refs gains a mechanical suffix — name, type,
 * size, id per file, pointing at `read_attachment` (email v2 spec §6). This is
 * REQUEST-VIEW ONLY: the committed row's `content` stays exactly what the
 * human wrote (plus any admission notes), and the suffix is derived here, the
 * single boundary, on every call. User rows only — an assistant row's staged
 * files are already known to the model through the tool results that created
 * them, and teaching it the bracket syntax as something assistants write would
 * invite imitation.
 *
 * THE VIEW (participants spec §4.4). With no `view` — every 1:1 session, and
 * every caller that predates rosters — the projection is byte-identical to
 * what it always was. A rostered turn passes the RUNNING model's view:
 *
 *   - its OWN rows keep their roles (assistant stays assistant, its tool rows
 *     ride along);
 *   - another model's TURN-FINAL rows (no toolCalls, non-empty text) become
 *     attributed `user` rows — a provider treats `assistant` as "text I
 *     produced", so a colleague's words must arrive as input;
 *   - another model's WORKING — toolCall-bearing assistants, tool rows,
 *     empty rows — drops: invalid as anyone else's context, and token noise
 *     (an empty "[name]:" user row is a 400 on some providers);
 *   - HUMAN rows gain a `[name]: ` prefix only when the roster holds ≥2
 *     humans or ≥2 models (decision 9) — attribution only when it
 *     disambiguates, so the 1:1 payload never moves.
 *
 * The OMNISCIENT view (`self` absent) is the compaction summarizer's: every
 * row visible in today's structure, user and turn-final assistant text
 * prefixed, because any single participant's view drops exactly the working a
 * summary must fold in.
 *
 * Rows older than the `from` field project with fixed defaults: assistant and
 * tool rows belong to the PRIMARY model, user rows to the owner.
 */
export interface TranscriptView {
  /** The running model's participant id; absent = the omniscient projection. */
  self?: string;
  /** The primary model's participant id — the attribution default for
   *  `from`-less assistant/tool rows. */
  primary: string;
  participants: SessionParticipant[];
}

export function toProviderMessages(
  msgs: AgentMessage[], view?: TranscriptView,
): ProviderMessage[] {
  const nameOf = view
    ? (id: string, fallback?: string) =>
      view.participants.find((p) => p.id === id)?.displayName ?? fallback ?? id
    : undefined;
  const prefixing = view ? needsAttribution(view.participants) : false;
  const out: ProviderMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'note') continue;

    // A SYSTEM row — a turn the clock or a job runner started (system-turn
    // spec §4.9). No provider has a mid-conversation system message: that
    // channel is `ProviderRequest.system`, which the loop rebuilds from the
    // config on every iteration, so routing a one-shot prompt there would make
    // it standing and strip its place in history. It projects as a MARKED user
    // row instead — the shape a compaction note and a colleague's reply already
    // use.
    //
    // This arm must push and `continue`. The generic build below casts
    // `m.role as ProviderMessage['role']`, which compiles happily with a
    // literal 'system' and reaches an adapter that silently re-labels it
    // `role: 'user'` — telling the model a PERSON said it, the exact confusion
    // the role exists to prevent. The marker is unconditional, never gated on
    // `prefixing`: gating it would leave machine input unlabelled in every 1:1
    // session, and a session with no system rows projects identically either
    // way.
    if (m.role === 'system') {
      const body = (m.content ?? '').trim();
      // An empty user row is a 400 on some providers; a marker with nothing
      // after it is worse than no row at all.
      if (body === '') continue;
      out.push({ role: 'user', content: `[${m.from?.name ?? 'system'}] ${body}` });
      continue;
    }

    if (view && (m.role === 'assistant' || m.role === 'tool')) {
      const author = m.from?.participant ?? view.primary;
      const foreign = view.self !== undefined && author !== view.self;
      if (foreign) {
        // A colleague's row: its spoken outcome only. Working drops.
        const turnFinal = m.role === 'assistant'
          && (!m.toolCalls || m.toolCalls.length === 0)
          && (m.content ?? '') !== '';
        if (!turnFinal) continue;
        out.push({
          role: 'user',
          content: `[${nameOf!(author, m.from?.name)}]: ${m.content}`,
        });
        continue;
      }
      if (view.self === undefined && m.role === 'assistant' && prefixing
        && (!m.toolCalls || m.toolCalls.length === 0) && (m.content ?? '') !== '') {
        // Omniscient: the summarizer sees who spoke; structure untouched.
        out.push({
          role: 'assistant',
          content: `[${nameOf!(author, m.from?.name)}]: ${m.content}`,
          toolCalls: m.toolCalls,
          toolCallId: m.toolCallId,
          ...(m.error ? { isError: true } : {}),
        });
        continue;
      }
    }

    const refs = m.role === 'user' && m.attachments?.length ? m.attachments : null;
    let content = refs
      ? `${m.content ?? ''}${m.content ? '\n\n' : ''}${attachmentSuffix(refs)}`
      : m.content;
    if (view && prefixing && m.role === 'user') {
      const name = m.from
        ? m.from.name
        : nameOf!(
          view.participants.find((p) => p.role === 'owner')?.id ?? '', 'user',
        );
      content = `[${name}]: ${content ?? ''}`;
    }
    const row: ProviderMessage = {
      role: m.role as ProviderMessage['role'],
      content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
    };
    if (m.error) row.isError = true;
    out.push(row);
  }
  return out;
}

/** One assistant's turn, and the seq range its `tool` rows must live in. */
export interface TurnWindow {
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
export async function discardTurn(
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
      });
    }
    await AgentDeltas.removeAsync({ messageId });
    await AgentMessages.removeAsync({ _id: messageId });
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
export async function repairUnansweredToolUse(sessionId: string): Promise<boolean> {
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
  });

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
export function locateBatch(msgs: AgentMessage[], toolCallId: string): TurnWindow | null {
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
