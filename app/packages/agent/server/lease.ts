import { Random } from 'meteor/random';
import { AgentSessions } from '../common/collections';

/** Identity of this app server process, regenerated on every boot. */
export const SERVER_ID: string = Random.id();

export const LEASE_MS = 30_000;
export const HEARTBEAT_MS = 10_000;

/** Claim a run. Succeeds if unleased, expired, or already ours. Atomic on a
 *  single document, so exactly one racing server wins. */
export async function claimLease(sessionId: string, serverId = SERVER_ID): Promise<boolean> {
  const now = new Date();
  const n = await AgentSessions.updateAsync(
    {
      _id: sessionId,
      $or: [
        { lease: { $exists: false } },
        { lease: null },
        { 'lease.until': { $lt: now } },
        { 'lease.serverId': serverId },
      ],
    } as any,
    { $set: { lease: { serverId, until: new Date(now.getTime() + LEASE_MS) } } },
  );
  return n === 1;
}

export async function heartbeat(sessionId: string, serverId = SERVER_ID): Promise<boolean> {
  const n = await AgentSessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId } as any,
    { $set: { 'lease.until': new Date(Date.now() + LEASE_MS) } },
  );
  return n === 1;
}

export async function releaseLease(sessionId: string, serverId = SERVER_ID): Promise<void> {
  await AgentSessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId } as any,
    { $unset: { lease: 1 } },
  );
}

export async function holdsLease(sessionId: string, serverId = SERVER_ID): Promise<boolean> {
  const doc = await AgentSessions.findOneAsync(
    { _id: sessionId, 'lease.serverId': serverId } as any,
  );
  return !!doc;
}

/** Every write during a turn goes through this. A server that lost the lease
 *  fails the guard and must abandon rather than write. */
export async function guardedUpdate(
  sessionId: string, serverId: string, modifier: Record<string, unknown>,
): Promise<boolean> {
  const n = await AgentSessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId } as any,
    modifier as any,
  );
  return n === 1;
}
