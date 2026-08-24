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
    //
    // SUBAGENT children need no case of their own here, and deliberately get
    // none. A child session carries the parent's `userId` verbatim (see
    // `runSubagent`), so the lookup below authorizes exactly the people the
    // parent authorizes — including the anonymous capability-URL owner, for whom
    // "knows the id" is the credential and the child's id is only ever learned
    // from the parent's own tool row. The `agent` argument is the child's agent
    // name, not the parent's: a client follows `childSessionId` with
    // `new Agent('<the subagent>').subscribe(childSessionId)`, and the scope
    // check is the same one that stops agent A driving agent B's transcript.
    // MEMBERSHIP (participants spec §4.2): the owner clause first (the only
    // one a null caller may ever match — the anonymous rule is the owner's
    // alone), then the roster clause for signed-in members. The same
    // two-branch check `requireSession` makes, so the read surface and the
    // write surface agree about who a session belongs to.
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
      // `lease` is server-internal (which app process currently owns the
      // run, see server/lease.ts) — never wire hygiene the client needs, and
      // not something any client code reads (status()/usage()/pending() in
      // client/agent.ts only touch phase/usage/pending).
      //
      // `pending.wakeToken` is excluded for the same reason: it is the identity
      // of a scheduled wake, joined to `lease` as pure server-internal
      // bookkeeping (see `AgentSession.pending.wakeToken`), and a client that
      // could read it learns nothing but could echo it back to confuse the
      // wind-down self-check.
      AgentSessions.find(
        // `pendingRelay.token` joins the exclusions for exactly the
        // wakeToken's reason: it is the IDENTITY of a scheduled wake, pure
        // server bookkeeping, and a client that could read it learns nothing
        // but could echo it to confuse the self-check. The `agent` half may
        // ship — "a colleague's turn is scheduled" is renderable state.
        { _id: sessionId },
        { fields: { lease: 0, 'pending.wakeToken': 0, 'pendingRelay.token': 0 } },
      ),
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
    // CHILDREN ARE EXCLUDED. A subagent's session is a real session with a real
    // transcript, but it is not a conversation the user started — it is one
    // turn's internal work. Listing it here would put a stranger's name and a
    // fragment of a tool call at the top of a "your conversations" list, sorted
    // by `updatedAt` above everything the user actually said, and would do it
    // once per subagent call. A client that wants a child reaches it the way it
    // learns about it: `childSessionId` on the parent's tool row, then
    // `agent.session`, which serves children without a special case.
    // A member's conversation list includes sessions they were invited into
    // (participants spec §4.2) — the `$or` mirrors `requireSession`, and the
    // `'participants.userId'` index keeps the second clause from scanning.
    return AgentSessions.find(
      {
        agent,
        $or: [
          { userId: this.userId },
          { participants: { $elemMatch: { kind: 'human', userId: this.userId } } },
        ],
        parent: { $exists: false },
      },
      // `lease` and `pending.wakeToken` omitted here too — see the matching
      // comment on `pubSession`.
      {
        sort: { updatedAt: -1 },
        limit: 100,
        fields: { lease: 0, 'pending.wakeToken': 0, 'pendingRelay.token': 0 },
      },
    );
  });
}
