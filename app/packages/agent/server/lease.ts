import { Random } from 'meteor/random';
import { AgentSessions } from '../common/collections';
import type { SessionModifier, SessionQuery } from '../common/db';

/** Identity of this app server process, regenerated on every boot. */
export const SERVER_ID: string = Random.id();

export let LEASE_MS = 30_000;
export let HEARTBEAT_MS = 10_000;

/** Test seam: shrink lease/heartbeat timings. Returns previous values
 *  so a `finally` can restore them. */
export function _setLeaseTimings(
  { leaseMs, heartbeatMs }: { leaseMs?: number; heartbeatMs?: number },
): { leaseMs: number; heartbeatMs: number } {
  const previous = { leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS };
  if (leaseMs !== undefined) LEASE_MS = leaseMs;
  if (heartbeatMs !== undefined) HEARTBEAT_MS = heartbeatMs;
  return previous;
}

/** Claim a run. Succeeds if unleased, expired, or already ours. Atomic on a
 *  single document, so exactly one racing server wins. */
export async function claimLease(
  sessionId: string,
  serverId = SERVER_ID,
  expected?: SessionQuery,
): Promise<boolean> {
  const now = new Date();
  const n = await AgentSessions.updateAsync(
    {
      _id: sessionId,
      erasingAt: { $exists: false },
      purgingAt: { $exists: false },
      $and: [
        ...(expected ? [expected] : []),
        {
          $or: [
            { lease: { $exists: false } },
            { lease: null },
            { 'lease.until': { $lt: now } },
            { 'lease.serverId': serverId },
          ],
        },
      ],
    },
    { $set: { lease: { serverId, until: new Date(now.getTime() + LEASE_MS) } } },
  );
  return n === 1;
}

export async function heartbeat(sessionId: string, serverId = SERVER_ID): Promise<boolean> {
  const n = await AgentSessions.updateAsync(
    {
      _id: sessionId,
      'lease.serverId': serverId,
      erasingAt: { $exists: false },
      purgingAt: { $exists: false },
    },
    { $set: { 'lease.until': new Date(Date.now() + LEASE_MS) } },
  );
  return n === 1;
}

export async function releaseLease(sessionId: string, serverId = SERVER_ID): Promise<void> {
  await AgentSessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId },
    { $unset: { lease: 1 } },
  );
}

export async function holdsLease(sessionId: string, serverId = SERVER_ID): Promise<boolean> {
  const doc = await AgentSessions.findOneAsync(
    {
      _id: sessionId,
      'lease.serverId': serverId,
      'lease.until': { $gt: new Date() },
      erasingAt: { $exists: false },
      purgingAt: { $exists: false },
    },
  );
  return !!doc;
}

/** Every write during a turn goes through this. A server that lost the lease
 *  fails the guard and must abandon rather than write. */
export async function guardedUpdate(
  sessionId: string, serverId: string, modifier: SessionModifier,
): Promise<boolean> {
  const n = await AgentSessions.updateAsync(
    { _id: sessionId, 'lease.serverId': serverId, erasingAt: { $exists: false } },
    modifier,
  );
  return n === 1;
}
