import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage, AgentSession } from '../common/types';
import type { SessionQuery } from '../common/db';
import { batchSafeBoundary } from './transcript';
import {
  beginSessionMutationOperation, withSessionOperationTransaction,
} from './session-operations';

/** Chunk size for insertMany — balances round trips vs Mongo limits. */
const COPY_CHUNK = 500;

/** The seq a fork copies up to, clamped to the nearest batch-safe cut
 *  point (same walk compaction uses). Returns -1 when nothing may be
 *  copied. When the walk moves, trailing notes are dropped — the fork
 *  may re-compact once, but its view always agrees with its rows. */
export function findForkCut(msgs: AgentMessage[], atSeq?: number): number {
  const lastSeq = msgs.length > 0 ? msgs[msgs.length - 1].seq : -1;
  // Default: whole transcript. Past-the-end clamped.
  const target = Math.min(atSeq ?? lastSeq, lastSeq);
  if (target < 0) return -1;

  const eligible = msgs.filter((m) => m.role !== 'note');
  // Index of the first non-note message NOT in the head.
  const firstExcluded = eligible.findIndex((m) => m.seq > target);
  const boundary = firstExcluded === -1 ? eligible.length : firstExcluded;

  const safe = batchSafeBoundary(eligible, boundary);
  // Walk didn't move: keep exact atSeq (including trailing notes).
  if (safe === boundary) return target;
  // Moved: cut at the last non-note message still in the head.
  return safe > 0 ? eligible[safe - 1].seq : -1;
}

/** The seq a thread on the row at `anchorSeq` copies up to: the smallest
 *  batch-safe cut that still includes the anchor, walking FORWARD to the end
 *  of its tool batch (a fork walks back). Null while that batch is open. */
export function findThreadCut(msgs: AgentMessage[], anchorSeq: number): number | null {
  const eligible = msgs.filter((m) => m.role !== 'note');
  const anchor = eligible.findIndex((m) => m.seq === anchorSeq);
  if (anchor === -1) return null;
  for (let boundary = anchor + 1; boundary <= eligible.length; boundary += 1) {
    if (batchSafeBoundary(eligible, boundary) === boundary) return eligible[boundary - 1].seq;
  }
  return null;
}

/** Short default title for a thread, from its first message. */
export function threadTitle(anchor: Pick<AgentMessage, 'content'>): string {
  const text = (anchor.content ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return 'Thread';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** @internal Copies of `rows` for a new session: new `_id`s, same seqs, so
 *  compaction `upto` values stay valid. `childSessionId` keeps pointing at
 *  the source's child (shared history). */
export function copyRows(rows: AgentMessage[], forkId: string): AgentMessage[] {
  return rows.map((m) => ({ ...m, _id: Random.id(), sessionId: forkId }));
}

/** @internal The session document of a fork of `source` cut at `cut`. */
export function forkDocument(
  source: AgentSession, forkId: string, cut: number, title: string, now: Date,
): AgentSession {
  return {
    _id: forkId,
    agent: source.agent,
    userId: source.userId,
    title,
    phase: 'idle',
    // Record of what produced this transcript, not the registry's current model.
    model: source.model,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    // Continues the source's numbering from the cut (seqs have gaps).
    nextSeq: cut + 1,
    forkedFrom: { sessionId: source._id, seq: cut },
    // Roster copies; relay/pendingSystem/lastSystemKey do not (idle fork).
    ...(source.participants?.length ? { participants: source.participants } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Branch a session at a batch-safe cut and return the new session id.
 *  Source assumed authorized. A fork is a new root: no parent/depth,
 *  no lease/phase/pending, zero usage — only transcript + roster.
 *  With `thread`, the cut includes that message (see `findThreadCut`) and
 *  the new session records it as its thread anchor. */
export async function forkSession(
  source: AgentSession,
  opts?: { atSeq?: number; title?: string; thread?: { messageId: string } },
): Promise<string> {
  const operation = await beginSessionMutationOperation(source._id);
  if (!operation) throw new Meteor.Error('no-session', 'Session not found');
  try {
    const msgs = await AgentMessages
      .find({ sessionId: source._id }, { sort: { seq: 1 } }).fetchAsync();
    let cut: number;
    let thread: AgentSession['thread'];
    let title = opts?.title ?? `Fork of ${source.title || source._id}`;
    if (opts?.thread) {
      const anchor = msgs.find((m) => m._id === opts.thread!.messageId);
      if (!anchor || (anchor.role !== 'user' && anchor.role !== 'assistant')) {
        throw new Meteor.Error(
          'thread-anchor-invalid', 'Threads can only start from a message.',
        );
      }
      const threadCut = findThreadCut(msgs, anchor.seq);
      if (threadCut === null) {
        throw new Meteor.Error(
          'thread-anchor-open',
          'This message is still running tools. Try again when it finishes.',
        );
      }
      cut = threadCut;
      thread = {
        sessionId: source._id,
        seq: cut,
        messageId: anchor._id,
        anchorSeq: anchor.seq,
        replies: 0,
        repliers: [],
      };
      title = opts.title ?? threadTitle(anchor);
    } else {
      cut = findForkCut(msgs, opts?.atSeq);
    }
    const forkId = Random.id();
    const docs = copyRows(msgs.filter((m) => m.seq <= cut), forkId);
    const fork: AgentSession = {
      ...forkDocument(source, forkId, cut, title, new Date()),
      ...(thread ? { thread } : {}),
    };

    // Source lifecycle proof, new Session, and every copied Message commit as
    // one unit. A crash can no longer leave orphaned transcript PII, and a
    // racing source erasure wins or loses against the same transaction.
    await withSessionOperationTransaction(operation, async (mongoSession) => {
      const sourceStillWritable = await AgentSessions.rawCollection().findOne(
        {
          _id: source._id,
          erasingAt: { $exists: false },
          purgingAt: { $exists: false },
        },
        { session: mongoSession, projection: { _id: 1 } },
      );
      if (!sourceStillWritable) throw new Meteor.Error('no-session', 'Session not found');
      await AgentSessions.rawCollection().insertOne(fork, { session: mongoSession });
      for (let i = 0; i < docs.length; i += COPY_CHUNK) {
        // eslint-disable-next-line no-await-in-loop
        await AgentMessages.rawCollection().insertMany(
          docs.slice(i, i + COPY_CHUNK),
          { ordered: true, session: mongoSession },
        );
      }
    }, 20_000);
    return forkId;
  } finally {
    await operation.close();
  }
}

/** Resolve, authorize, and fork. `userId` in opts scopes the lookup
 *  (fails closed); absent = unscoped server call. */
export async function forkSessionById(
  agent: string,
  sessionId: string,
  opts?: { atSeq?: number; title?: string; userId?: string | null },
): Promise<string> {
  const selector: SessionQuery = {
    _id: sessionId, agent, erasingAt: { $exists: false },
  };
  if (opts && 'userId' in opts) {
    // Roster members may fork (§4.2).
    const uid = opts.userId ?? null;
    selector.$or = [
      { userId: uid },
      ...(uid !== null
        ? [{ participants: { $elemMatch: { kind: 'human', userId: uid } } }]
        : []),
    ];
  }
  const source = await AgentSessions.findOneAsync(selector);
  if (!source) throw new Meteor.Error('no-session', 'Session not found');
  return forkSession(source, opts);
}
