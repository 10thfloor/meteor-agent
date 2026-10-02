import { Random } from 'meteor/random';
import { MongoInternals } from 'meteor/mongo';
import type { ClientSession } from 'mongodb';
import { AgentSessions } from '../common/collections';

/** @internal Production ambiguity horizon for Session-owned writes. */
export const SESSION_OPERATION_LEASE_MS = 30_000;
const SESSION_TRANSACTION_MAX_MS = 5_000;

interface OperationGuard {
  sessionId: string;
  id: string;
  leaseMs: number;
}

const OPERATION_GUARDS = Symbol('session-operation-guards');
type GuardedOperation = SessionOperation & {
  [OPERATION_GUARDS]: OperationGuard[];
};

/** @internal A Session-scoped mutation/delivery lease. */
export interface SessionOperation {
  /** Opaque identity for durable work that must prove this exact operation
   * has ended before cleaning up its marker. */
  readonly id: string;
  /** Aborted as soon as this process can no longer prove ownership. Long-lived
   * I/O should accept this signal in addition to asserting before it starts. */
  readonly signal: AbortSignal;
  /** Renew the durable fence immediately before a dependent write or external
   * disclosure. Throws when erasure has claimed the expired operation. */
  assertActive(): Promise<void>;
  close(): Promise<void>;
}

/** @internal Deliberately carries no Session id or storage detail. */
export class SessionOperationRevokedError extends Error {
  constructor() {
    super('The Session operation is no longer active.');
    this.name = 'SessionOperationRevokedError';
  }
}

/** The work this process has under way on each Session document, by Session
 * id. Everything this module writes to a Session document — the operation
 * markers, their renewals, and the transactions that renew them — takes its
 * turn here, one piece of work per document at a time.
 *
 * The reason is MongoDB's. A plain write that meets a document an open
 * transaction has written is retried inside the server, with a growing pause,
 * and holds one of the server's write tickets while it waits; MongoDB 7 gives
 * a server as many write tickets as cores, four on a small one. A burst of
 * sends to one Session made enough such waits to hold every ticket, so the
 * transaction that held the document could not get one for its next
 * statement, and every write on the database stood still until that
 * transaction's five-second limit. Taking turns here, this process never has
 * a plain write and a transaction on one Session document in flight together;
 * what other instances send can still meet a transaction, one write each. */
const turns = new Map<string, Promise<unknown>>();

function takeTurn(sessionId: string): Promise<() => void> {
  const previous = turns.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => mine);
  turns.set(sessionId, queued);
  return previous.then(() => () => {
    release();
    if (turns.get(sessionId) === queued) turns.delete(sessionId);
  });
}

/** Run `work` once every earlier piece of this process's work on the same
 * Session documents has finished. Documents are taken in one order, so two
 * operations on the same pair of documents cannot each hold what the other
 * waits for. */
async function inTurn<T>(sessionIds: readonly string[], work: () => Promise<T>): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const sessionId of [...new Set(sessionIds)].sort()) {
      // eslint-disable-next-line no-await-in-loop
      releases.push(await takeTurn(sessionId));
    }
    return await work();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** @internal Run Session-owned Mongo writes in one transaction which also
 * renews every lifecycle guard held by the operation. The guard write and the
 * dependent write therefore serialize with erasure's Session fence: whichever
 * commits first makes the other side observe it. The callback may be retried
 * by MongoDB and must contain only transactional database work. */
export async function withSessionOperationTransaction<T>(
  operation: SessionOperation,
  work: (mongoSession: ClientSession) => Promise<T>,
  timeoutMs = SESSION_TRANSACTION_MAX_MS,
): Promise<T> {
  const guards = (operation as GuardedOperation)[OPERATION_GUARDS];
  if (!guards?.length) throw new SessionOperationRevokedError();

  return inTurn(guards.map((guard) => guard.sessionId), async () => {
    const client = MongoInternals.defaultRemoteCollectionDriver().mongo.client;
    const mongoSession = client.startSession();
    let value: T | undefined;
    try {
      await (mongoSession as any).withTransaction(async () => {
        for (const guard of guards) {
          const now = new Date();
          // eslint-disable-next-line no-await-in-loop
          const renewed = await AgentSessions.rawCollection().updateOne(
            {
              _id: guard.sessionId,
              erasingAt: { $exists: false },
              purgingAt: { $exists: false },
              operations: { $elemMatch: { id: guard.id, until: { $gt: now } } },
            },
            { $set: { 'operations.$.until': new Date(now.getTime() + guard.leaseMs) } },
            { session: mongoSession },
          );
          if (renewed.matchedCount !== 1) throw new SessionOperationRevokedError();
        }
        value = await work(mongoSession);
      }, { timeoutMS: timeoutMs });
      return value as T;
    } finally {
      await mongoSession.endSession();
    }
  });
}

/** @internal Begin work that could write Session-owned state or disclose it to
 * an external transport. The atomic push and erasure's atomic fence serialize
 * which side wins. Null means the Session is absent or already fenced. */
export async function beginSessionOperation(
  sessionId: string, leaseMs = SESSION_OPERATION_LEASE_MS,
): Promise<SessionOperation | null> {
  const id = Random.secret();
  const now = new Date();
  const until = new Date(now.getTime() + leaseMs);
  const result = await inTurn([sessionId], async () => {
    // A dead process cannot pull its lease. Prune those remnants on the next
    // operation so ordinary long-lived Sessions remain bounded.
    await AgentSessions.rawCollection().updateOne(
      { _id: sessionId, erasingAt: { $exists: false }, purgingAt: { $exists: false } },
      { $pull: { operations: { until: { $lte: now } } } },
    );
    return AgentSessions.rawCollection().updateOne(
      { _id: sessionId, erasingAt: { $exists: false }, purgingAt: { $exists: false } },
      { $push: { operations: { id, until } } },
    );
  });
  if (result.modifiedCount !== 1) return null;

  let finished = false;
  let renewing: Promise<boolean> | null = null;
  const revoked = new AbortController();
  const lose = (): false => {
    if (!revoked.signal.aborted) revoked.abort(new SessionOperationRevokedError());
    clearInterval(heartbeat);
    return false;
  };
  const renew = (): Promise<boolean> => {
    if (finished || revoked.signal.aborted) return Promise.resolve(false);
    if (renewing) return renewing;
    const pending = inTurn([sessionId], () => {
      const heartbeatAt = new Date();
      return AgentSessions.rawCollection().updateOne(
        {
          _id: sessionId,
          purgingAt: { $exists: false },
          operations: { $elemMatch: { id, until: { $gt: heartbeatAt } } },
        },
        { $set: { 'operations.$.until': new Date(heartbeatAt.getTime() + leaseMs) } },
      );
    }).then((result) => (result.matchedCount === 1 ? true : lose()))
      .catch(() => lose())
      .finally(() => {
        if (renewing === pending) renewing = null;
      });
    renewing = pending;
    return pending;
  };
  const heartbeat = setInterval(() => {
    void renew();
  }, Math.max(10, Math.floor(leaseMs / 3)));
  (heartbeat as any).unref?.();

  const operation: GuardedOperation = {
    [OPERATION_GUARDS]: [{ sessionId, id, leaseMs }],
    id,
    signal: revoked.signal,
    async assertActive(): Promise<void> {
      if (!(await renew())) throw new SessionOperationRevokedError();
    },
    async close(): Promise<void> {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      await renewing;
      await inTurn([sessionId], () => AgentSessions.rawCollection().updateOne(
        { _id: sessionId }, { $pull: { operations: { id } } },
      )).catch(() => { /* an erasure may already have removed the Session */ });
    },
  };
  return operation;
}

/** @internal An operation acquired on a Session's lifecycle root. Child work
 * must hold this while it can create state, because erasure fences the root
 * before it walks and fences descendants. */
export interface SessionTreeOperation extends SessionOperation {
  readonly rootId: string;
}

/** @internal Walk the immutable parent chain, reject any existing lifecycle
 * fence, then atomically compete with root erasure for an operation. A fence
 * that lands during the walk makes the final root acquisition fail closed. */
export async function beginSessionTreeOperation(
  sessionId: string,
): Promise<SessionTreeOperation | null> {
  let currentId = sessionId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const current = await AgentSessions.findOneAsync(
      {
        _id: currentId,
        erasingAt: { $exists: false },
        purgingAt: { $exists: false },
      },
      { fields: { parent: 1 } },
    );
    if (!current) return null;
    const parentId = current.parent?.sessionId;
    if (parentId) {
      currentId = parentId;
      continue;
    }
    const operation = await beginSessionOperation(currentId);
    return operation ? Object.assign(operation, { rootId: currentId }) : null;
  }
}

/** @internal Acquire the lifecycle root first, then the target Session when it
 * is a child. The target operation's id can safely own a marker stored on that
 * target, while the root operation prevents an ancestor fence from being
 * bypassed between authorization and mutation. */
export async function beginSessionMutationOperation(
  sessionId: string,
): Promise<SessionOperation | null> {
  const tree = await beginSessionTreeOperation(sessionId);
  if (!tree) return null;
  if (tree.rootId === sessionId) return tree;

  const local = await beginSessionOperation(sessionId);
  if (!local) {
    await tree.close();
    return null;
  }
  const revoked = new AbortController();
  const revoke = (): void => {
    if (!revoked.signal.aborted) revoked.abort(new SessionOperationRevokedError());
  };
  tree.signal.addEventListener('abort', revoke, { once: true });
  local.signal.addEventListener('abort', revoke, { once: true });
  if (tree.signal.aborted || local.signal.aborted) revoke();
  const operation: GuardedOperation = {
    [OPERATION_GUARDS]: [
      ...(tree as unknown as GuardedOperation)[OPERATION_GUARDS],
      ...(local as GuardedOperation)[OPERATION_GUARDS],
    ],
    id: local.id,
    signal: revoked.signal,
    async assertActive(): Promise<void> {
      await tree.assertActive();
      await local.assertActive();
    },
    async close(): Promise<void> {
      tree.signal.removeEventListener('abort', revoke);
      local.signal.removeEventListener('abort', revoke);
      await local.close();
      await tree.close();
    },
  };
  return operation;
}
