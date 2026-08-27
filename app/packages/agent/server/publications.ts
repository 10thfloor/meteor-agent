import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { NAMES } from '../common/names';
import {
  AgentDeltas, AgentMemories, AgentMessages, AgentSessions,
} from '../common/collections';

export function registerPublications(): void {
  Meteor.publish(NAMES.pubSession, async function (agent: string, sessionId: string) {
    check(agent, String);
    check(sessionId, String);
    // Messages carry no userId, so their cursors cannot carry the authorization
    // selector themselves. Keep a tiny observer on the session row and stop the
    // whole subscription the moment ownership/membership no longer matches.
    // `stop()` retracts every document this publication contributed.
    const uid = this.userId ?? null;
    const authorized = {
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

    // Unit tests also call publication handlers directly with only `userId`.
    // A real Meteor subscription always supplies stop/onStop; keep the direct
    // handler useful while making the live path revocation-safe.
    const canObserve = typeof this.stop === 'function' && typeof this.onStop === 'function';
    let stopped = false;
    let authHandle: { stop(): void } | null = null;
    if (canObserve) {
      this.onStop(() => {
        stopped = true;
        if (authHandle) { authHandle.stop(); authHandle = null; }
      });
      try {
        authHandle = await AgentSessions.find(
          authorized,
          { fields: { _id: 1 } },
        ).observeChangesAsync({
          // Leaving the selector means access was revoked (participant removed,
          // anonymous session claimed, owner changed, or session deleted).
          removed: () => { this.stop(); },
        }) as unknown as { stop(): void };
      } catch {
        // An unavailable revocation observer must never degrade to standing
        // transcript access. Stop without publishing anything.
        this.stop();
        return [];
      }
      // The client may have stopped while observeChangesAsync was resolving.
      if (stopped) {
        if (authHandle) { authHandle.stop(); authHandle = null; }
        return [];
      }
    }

    // Read after the observer is attached: removal before/during this read is
    // either seen here or by `removed`, closing the subscribe-time TOCTOU gap.
    const session = await AgentSessions.findOneAsync(authorized);
    if (!session) {
      // An unauthorized subscription has nothing that can later be revoked,
      // so do not leave its authorization observer resident.
      if (authHandle) { authHandle.stop(); authHandle = null; }
      return []; // publishes nothing and marks the sub ready
    }
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
