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
      // `lease` is server-internal (which app process currently owns the
      // run, see server/lease.ts) — never wire hygiene the client needs, and
      // not something any client code reads (status()/usage()/pending() in
      // client/agent.ts only touch phase/usage/pending).
      AgentSessions.find({ _id: sessionId }, { fields: { lease: 0 } }),
      AgentMessages.find({ sessionId }, { sort: { seq: 1 } }),
      AgentDeltas.find({ sessionId }),
    ];
  });

  Meteor.publish(NAMES.pubSessions, function (agent: string) {
    check(agent, String);
    // Anonymous sessions are deliberately NON-ENUMERABLE. `userId: null`
    // matches every anonymous caller equally, so publishing the null-owner
    // list would hand any anonymous browser up to 100 other visitors' session
    // ids — and each id unlocks the full transcript (agent.session) plus
    // send/interrupt, since requireSession also matches null for everyone.
    // Anonymous use is a capability-URL model: it only holds if ids never
    // leak in bulk. A logged-out client that KNOWS an id keeps working.
    if (this.userId == null) return [];
    return AgentSessions.find(
      { agent, userId: this.userId },
      // `lease` omitted here too — see the matching comment on `pubSession`.
      { sort: { updatedAt: -1 }, limit: 100, fields: { lease: 0 } },
    );
  });
}
