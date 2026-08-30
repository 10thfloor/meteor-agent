import { Meteor } from 'meteor/meteor';
import { Mongo, MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { createHash } from 'crypto';
import type { ClientSession } from 'mongodb';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type {
  AgentMessage, AgentSession, AttachmentRef, MessageSource, SessionInc, SessionParticipant,
} from '../common/types';
import type { SessionQuery, SessionSet } from '../common/db';
import { needsAttribution } from '../common/participants';
import {
  beginSessionMutationOperation, type SessionOperation,
  withSessionOperationTransaction,
} from './session-operations';
import type { ProviderMessage } from './providers/types';
import { guardedUpdate, SERVER_ID } from './lease';
import { attachmentSuffix } from './attachments';

/** The Transcript Commit Module turns a user draft into one durable Message,
 * one sequence allocation, and one budget charge. Its private reservation is
 * reconstructable evidence: recovery never has to infer whether an ambiguous
 * Message insert might still arrive. */

/** @internal Trusted user-row fields derived after authorization. */
export interface UserMessageDraft {
  content: string;
  attachments?: AttachmentRef[];
  from?: { participant: string; name: string };
  to?: string;
  source?: MessageSource;
}

/** @internal */
export interface UserMessageCommit {
  sessionId: string;
  draft: UserMessageDraft;
  turnLimit?: number;
  /** Stable across a DDP retry; generated internally for server callers. */
  commitKey?: string;
}

/** @internal */
export interface CommittedUserMessage {
  messageId: string;
  seq: number;
  replayed: boolean;
}

/** @internal Unpublished outbox row. Large input stays out of the hot Session. */
export interface UserMessageReservation {
  _id: string;
  sessionId: string;
  draft: UserMessageDraft;
  turnLimit?: number;
  resetRelay: boolean;
  createdAt: Date;
}

/** @internal Server-only; Session Lifecycle imports it for cascade erasure. */
export const MESSAGE_RESERVATIONS_NAME = 'agent_message_reservations';
/** @internal Server-only private collection; never part of consumer types. */
export const UserMessageReservations =
  new Mongo.Collection<UserMessageReservation>(MESSAGE_RESERVATIONS_NAME, {
    // A fresh Meteor app may still carry `autopublish`; raw drafts must never
    // become an accidental publication merely because this collection exists.
    _preventAutopublish: true,
  } as any);

/** @internal Operational bounds, deliberately generous for chat input. */
export const MAX_USER_MESSAGE_BYTES = 256 * 1024;
export const MAX_PENDING_INPUTS = 64;

// Transactions make the Session operation guard and each dependent insert one
// atomic competitor with erasure. These bounds remain defense in depth for a
// slow server, not the lifecycle correctness proof.
const TRANSCRIPT_WRITE_MAX_MS = 5_000;
const boundedWrite = { maxTimeMS: TRANSCRIPT_WRITE_MAX_MS, retryWrites: false } as const;

type WakeLink = NonNullable<AgentSession['pendingInputs']>[number];

/** @internal Insert a fresh Session and its first Message in the caller's
 * transaction. Birth is atomic: neither orphan may become visible alone. */
export async function insertInitialTranscript(
  mongoSession: ClientSession,
  session: AgentSession,
  message: Omit<AgentMessage, 'sessionId' | 'seq'>,
): Promise<number> {
  const seq = session.nextSeq;
  await AgentSessions.rawCollection().insertOne({
    ...session,
    nextSeq: seq + 1,
    budgetSpent: {
      ...session.budgetSpent,
      turns: session.budgetSpent.turns + 1,
    },
  }, { session: mongoSession });
  await AgentMessages.rawCollection().insertOne({
    ...message,
    sessionId: session._id,
    seq,
  }, { session: mongoSession });
  return seq;
}

/** @internal Standalone fresh-root form used by throwaway ask Sessions. */
export async function createInitialTranscript(
  session: AgentSession,
  message: Omit<AgentMessage, 'sessionId' | 'seq'>,
): Promise<number> {
  const client = MongoInternals.defaultRemoteCollectionDriver().mongo.client;
  const mongoSession = client.startSession();
  let seq = session.nextSeq;
  try {
    await (mongoSession as any).withTransaction(async () => {
      seq = await insertInitialTranscript(mongoSession, session, message);
    }, { timeoutMS: TRANSCRIPT_WRITE_MAX_MS });
    return seq;
  } finally {
    await mongoSession.endSession();
  }
}

/** @internal Session mutation carried by one leased Transcript Message. */
export interface LeasedMessageMutation {
  inc?: SessionInc;
  set?: SessionSet;
  unset?: { pendingRelay?: 1; pendingSystem?: 1 };
  unlessStopped?: boolean;
  pendingRelayToken?: string;
  pendingSystemToken?: string;
}

/** @internal Atomically mutate the Lease-owned Session and insert its Message.
 * The transaction removes every allocation→insert crash window and makes the
 * commit an atomic competitor with Session erasure. */
export async function commitLeasedMessage(
  sessionId: string,
  message: Omit<AgentMessage, 'sessionId' | 'seq'>,
  mutation: LeasedMessageMutation = {},
): Promise<number | null> {
  const operation = await beginSessionMutationOperation(sessionId);
  if (!operation) return null;
  const committedAt = new Date();
  let committedSeq: number | null = null;
  try {
    await withSessionOperationTransaction(operation, async (mongoSession) => {
      committedSeq = null;
      const existing = await AgentMessages.rawCollection().findOne(
        { _id: message._id }, { session: mongoSession },
      ) as AgentMessage | null;
      if (existing) {
        if (existing.sessionId !== sessionId || existing.role !== message.role) {
          throw new Error('Transcript Message identity conflict');
        }
        committedSeq = existing.seq;
        return;
      }

      const before = await AgentSessions.rawCollection().findOneAndUpdate(
        {
          _id: sessionId,
          'lease.serverId': SERVER_ID,
          'lease.until': { $gt: committedAt },
          erasingAt: { $exists: false },
          purgingAt: { $exists: false },
          ...(mutation.unlessStopped ? { phase: { $ne: 'stopped' as const } } : {}),
          ...(mutation.pendingRelayToken
            ? { 'pendingRelay.token': mutation.pendingRelayToken } : {}),
          ...(mutation.pendingSystemToken
            ? { 'pendingSystem.token': mutation.pendingSystemToken } : {}),
        },
        {
          $inc: { nextSeq: 1, ...(mutation.inc ?? {}) } satisfies SessionInc,
          $set: { updatedAt: committedAt, ...(mutation.set ?? {}) },
          ...(mutation.unset && Object.keys(mutation.unset).length > 0
            ? { $unset: mutation.unset } : {}),
        },
        { returnDocument: 'before', session: mongoSession },
      ) as unknown as AgentSession | null;
      if (!before) return;

      await AgentMessages.rawCollection().insertOne({
        ...message, sessionId, seq: before.nextSeq,
      }, { session: mongoSession });
      committedSeq = before.nextSeq;
    }, TRANSCRIPT_WRITE_MAX_MS);
    return committedSeq;
  } finally {
    await operation.close();
  }
}

/** @internal Atomically apply a non-Turn Session mutation and insert the
 * Message derived from its exact pre-image. The supplied lifecycle operation
 * contributes the root/target erasure guards to the same transaction. */
export async function commitOperationMessage(
  operation: SessionOperation,
  sessionId: string,
  messageId: string,
  selector: SessionQuery,
  mutation: { inc?: SessionInc; set?: SessionSet; unset?: Record<string, 1> },
  message: (before: AgentSession) => Omit<AgentMessage, '_id' | 'sessionId' | 'seq'>,
): Promise<number | null> {
  let committedSeq: number | null = null;
  await withSessionOperationTransaction(operation, async (mongoSession) => {
    committedSeq = null;
    const existing = await AgentMessages.rawCollection().findOne(
      { _id: messageId }, { session: mongoSession },
    ) as AgentMessage | null;
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new Error('Transcript Message identity conflict');
      }
      committedSeq = existing.seq;
      return;
    }

    const before = await AgentSessions.rawCollection().findOneAndUpdate(
      {
        _id: sessionId,
        erasingAt: { $exists: false },
        purgingAt: { $exists: false },
        $and: [selector as any],
      },
      {
        $inc: { nextSeq: 1, ...(mutation.inc ?? {}) } satisfies SessionInc,
        $set: { updatedAt: new Date(), ...(mutation.set ?? {}) },
        ...(mutation.unset && Object.keys(mutation.unset).length
          ? { $unset: mutation.unset } : {}),
      },
      { returnDocument: 'before', session: mongoSession },
    ) as unknown as AgentSession | null;
    if (!before) return;
    await AgentMessages.rawCollection().insertOne({
      _id: messageId,
      sessionId,
      seq: before.nextSeq,
      ...message(before),
    }, { session: mongoSession });
    committedSeq = before.nextSeq;
  });
  return committedSeq;
}

function sameAttachments(a?: AttachmentRef[], b?: AttachmentRef[]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((left, index) => {
    const right = b[index];
    return !!right
      && left.id === right.id
      && left.name === right.name
      && left.contentType === right.contentType
      && left.size === right.size;
  });
}

function sameSource(a?: MessageSource, b?: MessageSource): boolean {
  if (a?.kind !== b?.kind) return false;
  if (a?.kind === 'channel' && b?.kind === 'channel') return a.channel === b.channel;
  return a === undefined ? b === undefined : true;
}

function sameDraft(a: UserMessageDraft, b: UserMessageDraft): boolean {
  return a.content === b.content
    && sameAttachments(a.attachments, b.attachments)
    && a.to === b.to
    && a.from?.participant === b.from?.participant
    && a.from?.name === b.from?.name
    && (a.from === undefined) === (b.from === undefined)
    && sameSource(a.source, b.source);
}

function sameMessage(
  message: AgentMessage, sessionId: string, draft: UserMessageDraft, seq?: number,
): boolean {
  return message.sessionId === sessionId
    && message.role === 'user'
    && (seq === undefined || message.seq === seq)
    && message.content === draft.content
    && sameAttachments(message.attachments, draft.attachments)
    && message.to === draft.to
    && message.from?.participant === draft.from?.participant
    && message.from?.name === draft.from?.name
    && (message.from === undefined) === (draft.from === undefined)
    && sameSource(message.source, draft.source);
}

function conflict(): never {
  throw new Meteor.Error(
    'commit-conflict',
    'This message commit key is already associated with different input.',
  );
}

function duplicateKey(error: unknown): boolean {
  const e = error as { code?: number; codeName?: string } | null;
  return e?.code === 11000 || e?.codeName === 'DuplicateKey';
}

function messageIdFor(sessionId: string, commitKey: string): string {
  return `u:${createHash('sha256')
    .update('10thfloor:agent:user-message\0')
    .update(sessionId)
    .update('\0')
    .update(commitKey)
    .digest('hex')}`;
}

async function settleReservation(
  reservation: UserMessageReservation,
  operation: SessionOperation,
): Promise<CommittedUserMessage> {
  type Outcome =
    | { kind: 'committed'; seq: number; replayed: boolean }
    | { kind: 'queue-full' | 'budget-exhausted' | 'no-session' };
  const now = new Date();

  // Reservation cleanup, Session allocation/budget, wake evidence, and the
  // user Message are one transaction. Recovery therefore sees either the
  // standing reservation or the complete commit, never a half-allocated seq.
  const outcome = await withSessionOperationTransaction<Outcome>(
    operation, async (mongoSession) => {
    const existing = await AgentMessages.rawCollection().findOne(
      { _id: reservation._id }, { session: mongoSession },
    ) as AgentMessage | null;
    if (existing) {
      if (!sameMessage(
        existing, reservation.sessionId, reservation.draft,
      )) conflict();
      await UserMessageReservations.rawCollection().deleteOne(
        { _id: reservation._id, sessionId: reservation.sessionId },
        { session: mongoSession },
      );
      return { kind: 'committed', seq: existing.seq, replayed: true };
    }

    const current = await AgentSessions.rawCollection().findOne(
      {
        _id: reservation.sessionId,
        erasingAt: { $exists: false },
        purgingAt: { $exists: false },
      },
      { session: mongoSession },
    ) as AgentSession | null;
    if (!current) return { kind: 'no-session' };

    let link = current.pendingInputs?.find(
      (candidate) => candidate.messageId === reservation._id,
    );
    let replayed = true;
    if (!link) {
      if ((current.pendingInputs?.length ?? 0) >= MAX_PENDING_INPUTS) {
        await UserMessageReservations.rawCollection().deleteOne(
          { _id: reservation._id, sessionId: reservation.sessionId },
          { session: mongoSession },
        );
        return { kind: 'queue-full' };
      }
      if (reservation.turnLimit !== undefined
        && current.budgetSpent.turns >= reservation.turnLimit) {
        await UserMessageReservations.rawCollection().deleteOne(
          { _id: reservation._id, sessionId: reservation.sessionId },
          { session: mongoSession },
        );
        return { kind: 'budget-exhausted' };
      }

      const after = await AgentSessions.rawCollection().findOneAndUpdate(
        {
          _id: reservation.sessionId,
          erasingAt: { $exists: false },
          purgingAt: { $exists: false },
          'pendingInputs.messageId': { $ne: reservation._id },
          $expr: {
            $lt: [{ $size: { $ifNull: ['$pendingInputs', []] } }, MAX_PENDING_INPUTS],
          },
          ...(reservation.turnLimit === undefined ? {} : {
            'budgetSpent.turns': { $lt: reservation.turnLimit },
          }),
        },
        [{
          $set: {
            pendingInputs: {
              $concatArrays: [
                { $ifNull: ['$pendingInputs', []] },
                [{
                  messageId: reservation._id,
                  seq: '$nextSeq',
                  at: reservation.createdAt,
                }],
              ],
            },
            nextSeq: { $add: ['$nextSeq', 1] },
            'budgetSpent.turns': {
              $add: [{ $ifNull: ['$budgetSpent.turns', 0] }, 1],
            },
            updatedAt: now,
            phase: {
              $cond: [{ $in: ['$phase', ['stopped', 'error']] }, 'idle', '$phase'],
            },
            ...(reservation.resetRelay ? { relay: 0, pendingRelay: '$$REMOVE' } : {}),
          },
        }],
        { returnDocument: 'after', session: mongoSession, ...boundedWrite },
      ) as unknown as AgentSession | null;
      link = after?.pendingInputs?.find(
        (candidate) => candidate.messageId === reservation._id,
      );
      if (!link) return { kind: 'no-session' };
      replayed = false;
    }

    await AgentMessages.rawCollection().insertOne({
      _id: reservation._id,
      sessionId: reservation.sessionId,
      seq: link.seq,
      role: 'user',
      ...reservation.draft,
      createdAt: reservation.createdAt,
    }, { session: mongoSession, ...boundedWrite });
    await UserMessageReservations.rawCollection().deleteOne(
      { _id: reservation._id, sessionId: reservation.sessionId },
      { session: mongoSession },
    );
    return { kind: 'committed', seq: link.seq, replayed };
  }, TRANSCRIPT_WRITE_MAX_MS);

  if (outcome.kind === 'committed') {
    return { messageId: reservation._id, seq: outcome.seq, replayed: outcome.replayed };
  }
  if (outcome.kind === 'queue-full') {
    throw new Meteor.Error(
      'queue-full', 'This session has too many unanswered messages; try again later.',
    );
  }
  if (outcome.kind === 'budget-exhausted') {
    throw new Meteor.Error('budget-exhausted', 'This session has used its turn budget.');
  }
  throw new Meteor.Error('no-session', 'Session not found');
}

/** @internal Reserve, allocate, and materialize one user Message. */
export async function commitUserMessage(
  command: UserMessageCommit,
): Promise<CommittedUserMessage> {
  if (Buffer.byteLength(command.draft.content, 'utf8') > MAX_USER_MESSAGE_BYTES) {
    throw new Meteor.Error(
      'message-too-large',
      `Messages may not exceed ${MAX_USER_MESSAGE_BYTES} UTF-8 bytes.`,
    );
  }
  const operation = await beginSessionMutationOperation(command.sessionId);
  if (!operation) throw new Meteor.Error('no-session', 'Session not found');
  const messageId = messageIdFor(command.sessionId, command.commitKey ?? Random.id());
  const proposed: UserMessageReservation = {
    _id: messageId,
    sessionId: command.sessionId,
    draft: command.draft,
    turnLimit: command.turnLimit,
    resetRelay: command.draft.from !== undefined,
    createdAt: new Date(),
  };
  try {
    const committed = await AgentMessages.findOneAsync(messageId);
    if (committed) {
      if (!sameMessage(committed, command.sessionId, command.draft)) conflict();
      return { messageId, seq: committed.seq, replayed: true };
    }

    let reservation = proposed;
    await operation.assertActive();
    try {
      await withSessionOperationTransaction(operation, async (mongoSession) => {
        await UserMessageReservations.rawCollection().insertOne(
          proposed, { ...boundedWrite, session: mongoSession },
        );
      });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const standing = await UserMessageReservations.findOneAsync(messageId);
      if (!standing
        || standing.sessionId !== command.sessionId
        || !sameDraft(standing.draft, command.draft)) conflict();
      reservation = standing;
    }
    return await settleReservation(reservation, operation);
  } finally {
    await operation.close();
  }
}

/** @internal Constructively finish every reservation/link for one Session.
 * False means durable corruption was fenced into an error phase. */
export async function reconcileUserMessageCommits(sessionId: string): Promise<boolean> {
  const operation = await beginSessionMutationOperation(sessionId);
  if (!operation) return false;
  try {
    const reservations = await UserMessageReservations.find(
      { sessionId }, { sort: { createdAt: 1, _id: 1 } },
    ).fetchAsync();
    for (const reservation of reservations) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await settleReservation(reservation, operation);
      } catch (error) {
        if ((error as any)?.error === 'budget-exhausted') continue;
        throw error;
      }
    }

    const session = await AgentSessions.findOneAsync(
      { _id: sessionId, erasingAt: { $exists: false } },
      { fields: { pendingInputs: 1 } },
    );
    for (const link of session?.pendingInputs ?? []) {
      // eslint-disable-next-line no-await-in-loop
      const message = await AgentMessages.findOneAsync(link.messageId);
      if (message?.sessionId === sessionId
        && message.role === 'user'
        && message.seq === link.seq) continue;
      await operation.assertActive();
      await AgentSessions.updateAsync(
        { _id: sessionId, erasingAt: { $exists: false } },
        { $set: { phase: 'error', updatedAt: new Date() } },
      );
      return false;
    }
    return true;
  } finally {
    await operation.close();
  }
}

/** @internal Release only exact wake links whose Messages are now answered.
 * Exact pulls cannot erase a concurrent send appended after the snapshot. */
export async function clearAnsweredUserMessageLinks(
  sessionId: string, links: WakeLink[],
): Promise<void> {
  if (links.length === 0) return;
  const operation = await beginSessionMutationOperation(sessionId);
  if (!operation) return;
  try {
    for (const link of links) {
      await operation.assertActive();
      // eslint-disable-next-line no-await-in-loop
      await AgentSessions.rawCollection().updateOne(
        { _id: sessionId, erasingAt: { $exists: false } },
        { $pull: { pendingInputs: { messageId: link.messageId, seq: link.seq } } },
      );
    }
  } finally {
    await operation.close();
  }
}

// ---- Provider projection and Turn-batch integrity -------------------------

/** Projects stored messages into what a provider sees. Omniscient view
 * (no `self`) is for the compaction summarizer. */
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

    if (m.role === 'system') {
      const body = (m.content ?? '').trim();
      if (body === '') continue;
      out.push({ role: 'user', content: `[${m.from?.name ?? 'system'}] ${body}` });
      continue;
    }

    if (view && (m.role === 'assistant' || m.role === 'tool')) {
      const author = m.from?.participant ?? view.primary;
      const foreign = view.self !== undefined && author !== view.self;
      if (foreign) {
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
 * provider response, so "answered?" is scoped per window. */
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
  const boundarySeq = () => (cut < eligible.length ? eligible[cut].seq : Infinity);
  for (const w of [...turnWindows(eligible)].reverse()) {
    const calls = w.assistant.toolCalls ?? [];
    if (calls.length === 0) continue;
    const lastAnswerSeq = calls.every((c) => w.answered.has(c.id))
      ? Math.max(
        w.assistant.seq,
        ...eligible
          .filter((t) => t.role === 'tool' && t.seq > w.assistant.seq && t.seq < w.windowEnd)
          .map((t) => t.seq),
      )
      : Infinity;
    while (cut > 0 && w.assistant.seq < boundarySeq() && lastAnswerSeq >= boundarySeq()) {
      cut -= 1;
    }
  }
  return cut;
}

/** Delete an abandoned assistant + its deltas and tool results. Best-effort. */
export async function discardTurn(
  sessionId: string, messageId: string, turnSeq: number, toolCallIds: string[] = [],
  upperBoundSeq: number = Infinity,
): Promise<void> {
  try {
    if (toolCallIds.length > 0) {
      await AgentMessages.removeAsync({
        sessionId, role: 'tool',
        toolCallId: { $in: toolCallIds },
        seq: { $gt: turnSeq, $lt: upperBoundSeq },
      });
    }
    await AgentDeltas.removeAsync({ messageId });
    await AgentMessages.removeAsync({ _id: messageId });
  } catch { /* cleanup is best-effort by design */ }
}

/** Delete any assistant with unanswered tool_use (permanent 400 otherwise).
 * Scans the whole Transcript; returns false if the Lease was lost. */
export async function repairUnansweredToolUse(sessionId: string): Promise<boolean> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return true;
  if (session.phase === 'awaiting' || session.pending) return true;

  const msgs = await AgentMessages
    .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
  const committedIds = msgs.map((m) => m._id);
  await AgentDeltas.removeAsync({
    sessionId, messageId: { $nin: committedIds },
  });

  const stranded = turnWindows(msgs).filter(
    (w) => (w.assistant.toolCalls ?? []).some((c) => !w.answered.has(c.id)),
  );
  if (stranded.length === 0) return true;

  const stillOurs = await guardedUpdate(sessionId, SERVER_ID, {
    $set: { updatedAt: new Date() },
  });
  if (!stillOurs) return false;

  for (const { assistant: m, windowEnd } of stranded) {
    await discardTurn(
      sessionId, m._id, m.seq, (m.toolCalls ?? []).map((c) => c.id), windowEnd,
    );
  }
  return true;
}

/** Find the turn window owning a parked tool call id. Newest-first;
 * falls back to answered match for crash recovery. */
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
