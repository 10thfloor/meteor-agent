import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { NAMES } from '../common/names';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';

export function registerPublications(): void {
  Meteor.publish(NAMES.pubSession, async function (agent: string, sessionId: string) {
    check(agent, String);
    check(sessionId, String);
    // Messages and deltas are exactly as sensitive as the session envelope they
    // belong to, but they carry no owner field of their own. Meteor publishes
    // every cursor returned below independently, so if we returned scoped-looking
    // finds for all three collections in parallel, an unauthenticated or
    // wrong-user caller could still subscribe directly with someone else's
    // sessionId and the messages/deltas finds (which only filter on sessionId)
    // would happily serve their transcript. To prevent that we must authorize
    // ONCE via a verified lookup against AgentSessions (the only collection with
    // a userId) BEFORE returning anything, and return nothing at all if that
    // lookup fails. Do not "simplify" this back into three independently-scoped
    // find() calls — messages/deltas have no userId to scope by.
    const session = await AgentSessions.findOneAsync({
      _id: sessionId,
      agent,
      userId: this.userId ?? null,
    });
    if (!session) return []; // publishes nothing and marks the sub ready
    return [
      AgentSessions.find({ _id: sessionId }),
      AgentMessages.find({ sessionId }, { sort: { seq: 1 } }),
      AgentDeltas.find({ sessionId }),
    ];
  });

  Meteor.publish(NAMES.pubSessions, function (agent: string) {
    check(agent, String);
    return AgentSessions.find(
      { agent, userId: this.userId ?? null },
      { sort: { updatedAt: -1 }, limit: 100 },
    );
  });
}
