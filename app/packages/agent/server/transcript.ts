import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage, SessionParticipant } from '../common/types';
import { needsAttribution } from '../common/participants';
import type { ProviderMessage } from './providers/types';
import { guardedUpdate, SERVER_ID } from './lease';
import { attachmentSuffix } from './attachments';

/** Transcript projection, per-turn windows, repair, and batch-safe boundary walk. */

/** Projects stored messages into what a provider sees. Omniscient view
 *  (no `self`) is for the compaction summarizer. */
export interface TranscriptView {
  /** The running model's participant id; absent = omniscient projection. */
  self?: string;
  /** Attribution default for `from`-less assistant/tool rows. */
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

    // System rows project as marked user rows — providers have no mid-conversation
    // system role, and the generic cast below would silently drop the distinction.
    if (m.role === 'system') {
      const body = (m.content ?? '').trim();
      // Empty user row is a 400 on some providers.
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

/** Per-assistant turn windows. Tool call ids are only unique within one
 *  provider response, so "answered?" is scoped per window. */
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

/** Walk boundary backward until no tool_use/tool_result pair is split. */
export function batchSafeBoundary(eligible: AgentMessage[], boundary: number): number {
  let cut = Math.max(0, Math.min(boundary, eligible.length));
  // Infinity when head is the whole list (fork case); unanswered batches
  // fall out via `lastAnswerSeq` below.
  const boundarySeq = () => (cut < eligible.length ? eligible[cut].seq : Infinity);
  // Reverse: moving earlier can only cascade into earlier windows, so one pass.
  for (const w of [...turnWindows(eligible)].reverse()) {
    const calls = w.assistant.toolCalls ?? [];
    if (calls.length === 0) continue;
    // Unanswered calls get Infinity, pushing the boundary back past them.
    // This is how forking an awaiting session cuts before the parked batch.
    const lastAnswerSeq = calls.every((c) => w.answered.has(c.id))
      ? Math.max(
        w.assistant.seq,
        ...eligible
          .filter((t) => t.role === 'tool' && t.seq > w.assistant.seq && t.seq < w.windowEnd)
          .map((t) => t.seq),
      )
      : Infinity;
    // Window spans boundary — pull cut back before this assistant.
    while (cut > 0 && w.assistant.seq < boundarySeq() && lastAnswerSeq >= boundarySeq()) {
      cut -= 1;
    }
  }
  return cut;
}

/** Delete an abandoned assistant + its deltas and tool results. Best-effort. */
export async function discardTurn(
  sessionId: string, messageId: string, turnSeq: number, toolCallIds: string[] = [],
  // Seq of the next assistant after this turn; Infinity at the transcript tail.
  upperBoundSeq: number = Infinity,
): Promise<void> {
  try {
    // Delete tool results, then deltas, then assistant LAST — the assistant
    // row is repair's anchor, so a partial failure leaves a repairable state.
    if (toolCallIds.length > 0) {
      await AgentMessages.removeAsync({
        sessionId, role: 'tool',
        toolCallId: { $in: toolCallIds },
        // Scoped to this turn's window — tool call ids can repeat across turns.
        seq: { $gt: turnSeq, $lt: upperBoundSeq },
      });
    }
    await AgentDeltas.removeAsync({ messageId });
    await AgentMessages.removeAsync({ _id: messageId });
  } catch { /* cleanup is best-effort by design */ }
}

/** Delete any assistant with unanswered tool_use (permanent 400 otherwise).
 *  Scans whole transcript; returns false if lease was lost. */
export async function repairUnansweredToolUse(sessionId: string): Promise<boolean> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return true;

  // An awaiting session's unanswered tool_use is a legitimate approval gate,
  // not an abandoned turn — repair must not delete it.
  if (session.phase === 'awaiting' || session.pending) return true;

  const msgs = await AgentMessages
    .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();

  // Remove crash-orphaned deltas whose messageId was never committed —
  // they'd render as a ghost streaming row forever.
  const committedIds = msgs.map((m) => m._id);
  await AgentDeltas.removeAsync({
    sessionId, messageId: { $nin: committedIds },
  });

  // Answered = tool row inside the same turn window (shared with locateBatch).
  const stranded = turnWindows(msgs).filter(
    (w) => (w.assistant.toolCalls ?? []).some((c) => !w.answered.has(c.id)),
  );
  if (stranded.length === 0) return true;

  // Lease guard: fail closed if another server claimed between claim and repair.
  const stillOurs = await guardedUpdate(sessionId, SERVER_ID, {
    $set: { updatedAt: new Date() },
  });
  if (!stillOurs) return false;

  // Delete ALL stranded assistants — a double-crash leaves more than one.
  for (const { assistant: m, windowEnd } of stranded) {
    await discardTurn(
      sessionId, m._id, m.seq, (m.toolCalls ?? []).map((c) => c.id), windowEnd,
    );
  }
  return true;
}

/** Find the turn window owning a parked tool call id. Newest-first;
 *  falls back to answered match for crash recovery. */
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
