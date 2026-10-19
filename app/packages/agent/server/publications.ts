import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { NAMES } from '../common/names';
import {
  AgentDeltas, AgentMemories, AgentMessages, AgentSessions,
} from '../common/collections';

/** Owner or human roster member of one session of `agent`. */
function authorizedSession(agent: string, sessionId: string, uid: string | null) {
  return {
    _id: sessionId,
    agent,
    erasingAt: { $exists: false },
    $or: [
      { userId: uid },
      ...(uid !== null
        ? [{ participants: { $elemMatch: { kind: 'human', userId: uid } } }]
        : []),
    ],
  };
}

/** Whether this subscription may read the session `authorized` selects,
 * keeping it that way: a tiny observer on the session row stops the whole
 * subscription the moment ownership/membership no longer matches. `stop()`
 * retracts every document the publication contributed. */
async function holdSessionAccess(sub: any, authorized: object): Promise<boolean> {
  // Unit tests also call publication handlers directly with only `userId`.
  // A real Meteor subscription always supplies stop/onStop; keep the direct
  // handler useful while making the live path revocation-safe.
  const canObserve = typeof sub.stop === 'function' && typeof sub.onStop === 'function';
  let stopped = false;
  let authHandle: { stop(): void } | null = null;
  if (canObserve) {
    sub.onStop(() => {
      stopped = true;
      if (authHandle) { authHandle.stop(); authHandle = null; }
    });
    try {
      authHandle = await AgentSessions.find(
        authorized as any,
        { fields: { _id: 1 } },
      ).observeChangesAsync({
        // Leaving the selector means access was revoked (participant removed,
        // anonymous session claimed, owner changed, or session deleted).
        removed: () => { sub.stop(); },
      }) as unknown as { stop(): void };
    } catch {
      // An unavailable revocation observer must never degrade to standing
      // transcript access. Stop without publishing anything.
      sub.stop();
      return false;
    }
    // The client may have stopped while observeChangesAsync was resolving.
    if (stopped) {
      if (authHandle) { authHandle.stop(); authHandle = null; }
      return false;
    }
  }

  // Read after the observer is attached: removal before/during this read is
  // either seen here or by `removed`, closing the subscribe-time TOCTOU gap.
  const session = await AgentSessions.findOneAsync(authorized as any);
  if (!session) {
    // An unauthorized subscription has nothing that can later be revoked,
    // so do not leave its authorization observer resident.
    if (authHandle) { authHandle.stop(); authHandle = null; }
    return false;
  }
  return true;
}

export function registerPublications(): void {
  Meteor.publish(NAMES.pubSession, async function (agent: string, sessionId: string) {
    check(agent, String);
    check(sessionId, String);
    // Messages carry no userId, so their cursors cannot carry the authorization
    // selector themselves — `holdSessionAccess` revokes on the session row.
    const authorized = authorizedSession(agent, sessionId, this.userId ?? null);
    // Unauthorized: publishes nothing and marks the sub ready.
    if (!(await holdSessionAccess(this, authorized))) return [];
    return [
      // Leases and wake tokens are server-internal bookkeeping —
      // never needed by any client code.
      AgentSessions.find(
        // Same exclusion rationale as wakeToken above.
        { _id: sessionId },
        {
          fields: {
            lease: 0, operations: 0, pendingInput: 0, pendingInputs: 0, purgingAt: 0,
            'pending.wakeToken': 0, 'pendingRelay.token': 0, 'pendingSystem.token': 0,
            // External ids (email addresses, phone numbers, provider user ids)
            // authorize on the server but are not client display data. The
            // roster's sanitized displayName + identity kind are sufficient.
            'participants.identity.externalUserId': 0,
          },
        },
      ),
      AgentMessages.find({ sessionId }, { sort: { seq: 1 } }),
      AgentDeltas.find({ sessionId }),
    ];
  });

  Meteor.publish(NAMES.pubSessions, function (agent: string, includeArchived?: boolean) {
    check(agent, String);
    check(includeArchived, Match.Maybe(Boolean));
    // Anonymous sessions are non-enumerable — listing null-owner sessions
    // would leak ids that unlock full transcripts.
    if (this.userId == null) return [];
    // Children excluded (subagent sessions are internal work, not conversations).
    // Members included (§4.2). Archived omitted unless `includeArchived`.
    return AgentSessions.find(
      {
        agent,
        erasingAt: { $exists: false },
        $or: [
          { userId: this.userId },
          { participants: { $elemMatch: { kind: 'human', userId: this.userId } } },
        ],
        parent: { $exists: false },
        // Threads are listed with their parent (`agent.threads`).
        thread: { $exists: false },
        ...(includeArchived ? {} : { archived: { $exists: false } }),
      },
      // Leases and wake tokens omitted here too — see the matching
      // comment on `pubSession`.
      {
        sort: { updatedAt: -1 },
        limit: 100,
        fields: {
          lease: 0, operations: 0, pendingInput: 0, pendingInputs: 0, purgingAt: 0,
          'pending.wakeToken': 0, 'pendingRelay.token': 0, 'pendingSystem.token': 0,
          'participants.identity.externalUserId': 0,
        },
      },
    );
  });

  /** The threads opened on one session's messages, for whoever may read that
   * session (owner or human roster member). Summary fields only; open one
   * with `agent.session` to read its transcript. */
  Meteor.publish(NAMES.pubThreads, async function (agent: string, sessionId: string) {
    check(agent, String);
    check(sessionId, String);
    const authorized = authorizedSession(agent, sessionId, this.userId ?? null);
    if (!(await holdSessionAccess(this, authorized))) return [];
    return AgentSessions.find(
      { 'thread.sessionId': sessionId, agent, erasingAt: { $exists: false } },
      {
        sort: { createdAt: 1 },
        fields: {
          _id: 1,
          agent: 1,
          userId: 1,
          title: 1,
          phase: 1,
          thread: 1,
          usage: 1,
          createdAt: 1,
          updatedAt: 1,
          // The roster without channel identities (see `pubSession`).
          'participants.id': 1,
          'participants.kind': 1,
          'participants.role': 1,
          'participants.userId': 1,
          'participants.agent': 1,
          'participants.displayName': 1,
          'participants.identity.kind': 1,
          'participants.assurance': 1,
          'participants.joinedAt': 1,
        },
      },
    );
  });

  /** Memory publication (§5): own person rows + shared work pool.
   *  Anonymous subscribers get nothing. */
  Meteor.publish(NAMES.pubMemories, function pubMemories() {
    if (this.userId === null) return this.ready();
    return AgentMemories.find(
      { $or: [{ userId: this.userId }, { scope: 'app' }] } as any,
      // Limit above the caps (200 + 500) so every deletable row is visible.
      { sort: { at: -1 }, limit: 1000 },
    );
  });
}
