import type { AgentMessage, SessionParticipant } from '../common/types';
import type { ProviderMessage } from './providers/types';
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
export declare function toProviderMessages(msgs: AgentMessage[], view?: TranscriptView): ProviderMessage[];
/** One assistant's turn, and the seq range its `tool` rows must live in. */
export interface TurnWindow {
    assistant: AgentMessage;
    /** Seq of the NEXT assistant, or Infinity when this is the last turn. */
    windowEnd: number;
    /** The `toolCallId`s answered by a `tool` row INSIDE this window. */
    answered: Set<string | undefined>;
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
export declare function batchSafeBoundary(eligible: AgentMessage[], boundary: number): number;
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
export declare function discardTurn(sessionId: string, messageId: string, turnSeq: number, toolCallIds?: string[], upperBoundSeq?: number): Promise<void>;
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
export declare function repairUnansweredToolUse(sessionId: string): Promise<boolean>;
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
export declare function locateBatch(msgs: AgentMessage[], toolCallId: string): TurnWindow | null;
//# sourceMappingURL=transcript.d.ts.map