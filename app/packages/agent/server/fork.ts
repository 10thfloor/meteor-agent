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

/** Branch a session at a batch-safe cut and return the new session id.
 *  Source assumed authorized. A fork is a new root: no parent/depth,
 *  no lease/phase/pending, zero usage — only transcript + roster. */
export async function forkSession(
  source: AgentSession,
  opts?: { atSeq?: number; title?: string },
): Promise<string> {
  const operation = await beginSessionMutationOperation(source._id);
  if (!operation) throw new Meteor.Error('no-session', 'Session not found');
  try {
    const msgs = await AgentMessages
      .find({ sessionId: source._id }, { sort: { seq: 1 } }).fetchAsync();
    const cut = findForkCut(msgs, opts?.atSeq);
    const copied = msgs.filter((m) => m.seq <= cut);
    const forkId = Random.id();
    const docs = copied.map((m) => ({
      ...m,
      // New _id, same seq — compaction `upto` values stay valid.
      // childSessionId left pointing at source's child (shared history).
      _id: Random.id(),
      sessionId: forkId,
    }));
    const now = new Date();
    const fork: AgentSession = {
      _id: forkId,
      agent: source.agent,
      userId: source.userId,
      title: opts?.title ?? `Fork of ${source.title || source._id}`,
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
