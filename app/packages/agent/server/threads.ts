import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage, AgentSession } from '../common/types';
import type { SessionQuery } from '../common/db';
import { isDuplicateKey } from './channels/collections';
import {
  copyRows, forkDocument, forkSession, threadTitle,
} from './fork';
import {
  beginSessionMutationOperation, withSessionOperationTransaction,
} from './session-operations';
import {
  conflict, countThreadReply, openBatchIds, sameMessage, type UserMessageDraft,
} from './transcript';

/** Message threads. A thread is a fork of its parent session at one message
 * that runs beside the parent: the parent's model never waits on it, and the
 * thread's model sees the parent up to that message plus the thread. One
 * thread per message — a partial unique index on (`thread.sessionId`,
 * `thread.messageId`) makes concurrent opens converge. Callers authorize. */

/** Chunk size for insertMany — same bound as fork. */
const COPY_CHUNK = 500;
const THREAD_WRITE_MAX_MS = 20_000;

async function findThread(sessionId: string, messageId: string): Promise<string | null> {
  const row = await AgentSessions.findOneAsync(
    { 'thread.sessionId': sessionId, 'thread.messageId': messageId },
    { fields: { _id: 1, erasingAt: 1 } },
  );
  if (!row) return null;
  if (row.erasingAt) {
    throw new Meteor.Error(
      'thread-unavailable', 'This thread is being deleted. Try again shortly.',
    );
  }
  return row._id;
}

/** @internal Find or create the thread on one message of an authorized
 * session. Concurrent callers get the same thread id. */
export async function openThread(source: AgentSession, messageId: string): Promise<string> {
  const existing = await findThread(source._id, messageId);
  if (existing) return existing;
  try {
    return await forkSession(source, { thread: { messageId } });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const winner = await findThread(source._id, messageId);
    if (winner) return winner;
    throw error;
  }
}

/** @internal "Reply in thread": commit the user row into `source` and the
 * thread that answers it in ONE transaction, so both exist or neither. The
 * row carries `threadSessionId`; `source` gets no wake link and no Turn
 * charge. The thread copies `source` through the new row (leaving out any
 * tool batch still running there) and holds the wake link for that row's
 * copy, so Activation — or recovery after a crash — answers it there.
 * Returns the thread id; a replay of the same `messageId` returns the
 * thread it created. */
export async function replyInThread(
  source: AgentSession,
  args: {
    messageId: string;
    /** Repeats authorization inside the transaction. */
    access: SessionQuery;
    draft: UserMessageDraft;
  },
): Promise<string> {
  const operation = await beginSessionMutationOperation(source._id);
  if (!operation) throw new Meteor.Error('no-session', 'Session not found');
  const threadId = Random.id();
  const createdAt = new Date();
  try {
    return await withSessionOperationTransaction(operation, async (mongoSession) => {
      const existing = await AgentMessages.rawCollection().findOne(
        { _id: args.messageId }, { session: mongoSession },
      ) as AgentMessage | null;
      if (existing) {
        if (!existing.threadSessionId || !sameMessage(existing, source._id, {
          ...args.draft, threadSessionId: existing.threadSessionId,
        })) conflict();
        return existing.threadSessionId;
      }

      const before = await AgentSessions.rawCollection().findOneAndUpdate(
        {
          _id: source._id,
          erasingAt: { $exists: false },
          purgingAt: { $exists: false },
          $and: [args.access as any],
        },
        { $inc: { nextSeq: 1 }, $set: { updatedAt: createdAt } },
        { returnDocument: 'before', session: mongoSession },
      ) as unknown as AgentSession | null;
      if (!before) throw new Meteor.Error('no-session', 'Session not found');
      const seq = before.nextSeq;

      const row: AgentMessage = {
        _id: args.messageId,
        sessionId: source._id,
        seq,
        role: 'user',
        ...args.draft,
        threadSessionId: threadId,
        createdAt,
      };
      await AgentMessages.rawCollection().insertOne(row, { session: mongoSession });
      await countThreadReply(mongoSession, before, row);

      const history = await AgentMessages.rawCollection().find(
        { sessionId: source._id, seq: { $lte: seq } },
        { session: mongoSession, sort: { seq: 1 } },
      ).toArray() as AgentMessage[];
      const running = openBatchIds(history);
      const copies = copyRows(history.filter((m) => !running.has(m._id)), threadId);
      const anchor = copies[copies.length - 1];
      // In the thread this row is the open request, not a pointer elsewhere.
      delete anchor.threadSessionId;

      const thread: AgentSession = {
        ...forkDocument(before, threadId, seq, threadTitle(row), createdAt),
        thread: {
          sessionId: source._id, seq, messageId: row._id, anchorSeq: seq, replies: 0, repliers: [],
        },
        // The send's Turn is charged where it runs.
        budgetSpent: { turns: 1, toolCalls: 0 },
        pendingInputs: [{ messageId: anchor._id, seq, at: createdAt }],
      };
      await AgentSessions.rawCollection().insertOne(thread, { session: mongoSession });
      for (let i = 0; i < copies.length; i += COPY_CHUNK) {
        // eslint-disable-next-line no-await-in-loop
        await AgentMessages.rawCollection().insertMany(
          copies.slice(i, i + COPY_CHUNK), { ordered: true, session: mongoSession },
        );
      }
      return threadId;
    }, THREAD_WRITE_MAX_MS);
  } finally {
    await operation.close();
  }
}
