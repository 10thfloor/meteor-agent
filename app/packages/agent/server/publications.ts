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
    // Authorize via session before returning cursors — messages carry no userId.
    // Membership check mirrors `requireSession`.
    const uid = this.userId ?? null;
    const session = await AgentSessions.findOneAsync({
      _id: sessionId,
      agent,
      $or: [
        { userId: uid },
        ...(uid !== null
          ? [{ participants: { $elemMatch: { kind: 'human', userId: uid } } }]
          : []),
      ],
    });
    if (!session) return []; // publishes nothing and marks the sub ready
    return [
      // `lease` and `pending.wakeToken` are server-internal bookkeeping —
      // never needed by any client code.
      AgentSessions.find(
        // Same exclusion rationale as wakeToken above.
        { _id: sessionId },
        { fields: { lease: 0, 'pending.wakeToken': 0, 'pendingRelay.token': 0, 'pendingSystem.token': 0 } },
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
        $or: [
          { userId: this.userId },
          { participants: { $elemMatch: { kind: 'human', userId: this.userId } } },
        ],
        parent: { $exists: false },
        ...(includeArchived ? {} : { archived: { $exists: false } }),
      },
      // `lease` and `pending.wakeToken` omitted here too — see the matching
      // comment on `pubSession`.
      {
        sort: { updatedAt: -1 },
        limit: 100,
        fields: { lease: 0, 'pending.wakeToken': 0, 'pendingRelay.token': 0, 'pendingSystem.token': 0 },
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
