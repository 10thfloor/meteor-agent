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
}

/** @internal Begin work that could write Session-owned state or disclose it to
 * an external transport. The atomic push and erasure's atomic fence serialize
 * which side wins. Null means the Session is absent or already fenced. */
export async function beginSessionOperation(
  sessionId: string, leaseMs = SESSION_OPERATION_LEASE_MS,
): Promise<SessionOperation | null> {
  const id = Random.secret();
  const now = new Date();
  // A dead process cannot pull its lease. Prune those remnants on the next
  // operation so ordinary long-lived Sessions remain bounded.
  await AgentSessions.rawCollection().updateOne(
    { _id: sessionId, erasingAt: { $exists: false }, purgingAt: { $exists: false } },
    { $pull: { operations: { until: { $lte: now } } } },
  );
  const until = new Date(now.getTime() + leaseMs);
  const result = await AgentSessions.rawCollection().updateOne(
    { _id: sessionId, erasingAt: { $exists: false }, purgingAt: { $exists: false } },
    { $push: { operations: { id, until } } },
  );
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
    const heartbeatAt = new Date();
    const pending = AgentSessions.rawCollection().updateOne(
      {
        _id: sessionId,
        purgingAt: { $exists: false },
        operations: { $elemMatch: { id, until: { $gt: heartbeatAt } } },
      },
      { $set: { 'operations.$.until': new Date(heartbeatAt.getTime() + leaseMs) } },
    ).then((result) => (result.matchedCount === 1 ? true : lose()))
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
      await AgentSessions.rawCollection().updateOne(
        { _id: sessionId }, { $pull: { operations: { id } } },
      ).catch(() => { /* an erasure may already have removed the Session */ });
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
