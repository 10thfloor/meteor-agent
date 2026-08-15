import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { NAMES } from '../common/names';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';

export function registerPublications(): void {
  Meteor.publish(NAMES.pubSession, function (agent: string, sessionId: string) {
    check(agent, String);
    check(sessionId, String);
    const selector = { _id: sessionId, agent, userId: this.userId ?? null };
    return [
      AgentSessions.find(selector),
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
