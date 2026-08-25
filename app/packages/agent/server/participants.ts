import { AgentMessages, AgentSessions } from '../common/collections';
import {
  MAX_PARTICIPANTS, type AgentSession, type SessionParticipant,
} from '../common/types';
import {
  humanParticipantId, modelParticipantId, resolveAddressee, sanitizeDisplayName,
} from '../common/participants';
import { ChannelBindings } from './channels/collections';

/**
 * Roster mutation and wake resolution (participants spec §4.1, §4.3) — the
 * server half of the participants model. A LEAF module: collections and types
 * only, so the loop, methods, ingress, and the watcher can all call in
 * without a cycle.
 *
 * Every write here is a guarded, single-winner Mongo operation. There is no
 * lease to hold — membership changes are legal while a turn runs (compose
 * joins its recipient mid-turn), and the running loop re-reads the session
 * each iteration, so a mid-turn join is visible at the next boundary.
 */

/** The seed rows a roster materializes with (decision 2): the owner human and
 *  the primary model — so the array is either absent or COMPLETE. */
function seedRows(
  session: Pick<AgentSession, 'agent' | 'userId'>,
  opts?: { ownerName?: string },
): SessionParticipant[] {
  const now = new Date();
  return [
    {
      id: humanParticipantId(session.userId),
      kind: 'human',
      role: 'owner',
      userId: session.userId,
      displayName: sanitizeDisplayName(opts?.ownerName ?? 'owner'),
      joinedAt: now,
    },
    {
      id: modelParticipantId(session.agent),
      kind: 'model',
      role: 'member',
      agent: session.agent,
      displayName: session.agent,
      joinedAt: now,
    },
  ];
}

export interface AddParticipantOptions {
  /** The participant id performing the add, recorded as `addedBy`. */
  by?: string;
  /** Display name for the OWNER's seeded row, used only when this add is the
   *  one that materializes the roster. Default 'owner'. */
  ownerName?: string;
}

/**
 * Add one participant to a session's roster, seeding it first if this is the
 * first join. Returns the participant's id, or null when the session is gone
 * or the roster is full.
 *
 * TWO single-winner writes, deliberately (a reviewer-found race: two racing
 * first-joins each passing a per-id guard would BOTH seed, duplicating the
 * owner and primary rows):
 *
 *   1. Materialization — `$set` of the complete seed, filtered on
 *      `participants: { $exists: false }`. Exactly one racer lands it; the
 *      loser's zero-match is not an error, the roster simply already exists.
 *   2. The join itself — `$push` filtered on `'participants.id' != id` (and
 *      the cap), so two racing joins of the same id resolve to one row and
 *      two different ids both land.
 *
 * Adding a participant who is already present ADOPTS the existing row (the
 * id collides, the push no-ops) — which is what makes compose's
 * crash-recovery re-run and a repeat compose to the same recipient both
 * idempotent here.
 */
export async function addParticipant(
  sessionId: string,
  participant: Omit<SessionParticipant, 'joinedAt' | 'displayName'>
    & { displayName?: string },
  opts?: AddParticipantOptions,
): Promise<string | null> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return null;

  const row: SessionParticipant = {
    ...participant,
    displayName: sanitizeDisplayName(
      participant.displayName
        ?? (participant.kind === 'model'
          ? participant.agent ?? participant.id
          : participant.identity?.externalUserId ?? participant.id),
    ),
    ...(opts?.by !== undefined ? { addedBy: opts.by } : {}),
    joinedAt: new Date(),
  };

  if (!session.participants) {
    await AgentSessions.updateAsync(
      { _id: sessionId, participants: { $exists: false } },
      { $set: { participants: seedRows(session, opts), updatedAt: new Date() } },
    );
    // Loser or winner, the roster now exists (or the session vanished — the
    // guarded push below then matches nothing, which is the right answer).
  }

  // A seeded row already carrying this id (the owner re-added, the primary
  // model re-added) is an adopt, not a failure.
  const seeded = await AgentSessions.findOneAsync(sessionId);
  if (!seeded?.participants) return null;
  if (seeded.participants.some((p) => p.id === row.id)) return row.id;
  if (seeded.participants.length >= MAX_PARTICIPANTS) return null;

  await AgentSessions.updateAsync(
    {
      _id: sessionId,
      'participants.id': { $ne: row.id },
      [`participants.${MAX_PARTICIPANTS - 1}`]: { $exists: false },
    },
    { $push: { participants: row }, $set: { updatedAt: new Date() } },
  );
  // Zero matched = a racer with the same id won (adopt), or the cap filled in
  // between (the racer's row is what filled it — either way the id below is
  // only returned if the row is actually there now).
  const after = await AgentSessions.findOneAsync(sessionId);
  return after?.participants?.some((p) => p.id === row.id) ? row.id : null;
}

/**
 * Remove a member from the roster (§4.6). REFUSED for the owner row —
 * ownership transfer is a named open question, and a session whose owner
 * evaporated would break every anchor the scalar owner holds. Returns whether
 * a row was removed.
 *
 * Binding teardown rides with it: the member's `member: true` bindings are
 * DELETED — egress consults only bindings, so removal without teardown would
 * keep mailing the departed member every future reply forever. The roster
 * removal is what makes ingress refuse their next event, because admission
 * reads the roster; a live web subscription is revoked on reconnect (the
 * publication authorizes at subscribe time — named and accepted, §4.6).
 */
export async function removeParticipant(
  sessionId: string, participantId: string,
): Promise<boolean> {
  const session = await AgentSessions.findOneAsync(sessionId);
  const row = session?.participants?.find((p) => p.id === participantId);
  if (!session || !row) return false;
  if (row.role === 'owner') {
    throw new Error(
      '[10thfloor:agent] the owner cannot be removed from a session; '
      + 'ownership transfer is not a supported operation',
    );
  }
  const n = await AgentSessions.updateAsync(
    { _id: sessionId },
    { $pull: { participants: { id: participantId } }, $set: { updatedAt: new Date() } },
  );
  if (n === 1) {
    await ChannelBindings.removeAsync({ sessionId, member: true, participant: participantId });
  }
  return n === 1;
}

/** The roster, read fresh. Empty array when absent — the classic pair. */
export async function listParticipants(sessionId: string): Promise<SessionParticipant[]> {
  const session = await AgentSessions.findOneAsync(sessionId);
  return session?.participants ?? [];
}

/**
 * The newest user row's ADDRESSEE, iff that addressee has not answered it —
 * the shared "unanswered tail" predicate (decision 6). ADDRESSEE-AWARE,
 * which is the load-bearing part: an addressed interjection is typically
 * followed by the RUNNING model's own reply at a higher seq, so "any
 * assistant row after the user row" reads answered when the addressee never
 * spoke (a reviewer-confirmed strand). For an addressed row, only an
 * assistant row FROM that addressee counts as its answer; for an unaddressed
 * row, any assistant row does (the primary's business, today's rule). Null =
 * nothing owed.
 */
export async function unansweredAddressee(
  session: AgentSession,
): Promise<{ id: string; agent: string } | null> {
  if (!session.participants?.length) return null;
  const [lastUser] = await AgentMessages.find(
    { sessionId: session._id, role: 'user' }, { sort: { seq: -1 }, limit: 1 },
  ).fetchAsync();
  if (!lastUser) return null;
  const hit = resolveAddressee(lastUser.content, lastUser.to, session);
  if (hit) {
    const [answer] = await AgentMessages.find(
      { sessionId: session._id, role: 'assistant', seq: { $gt: lastUser.seq } },
      { sort: { seq: -1 }, limit: 50 },
    ).fetchAsync().then((rows) => rows.filter(
      (m) => (m.from?.participant ?? `m:${session.agent}`) === hit.id,
    ));
    return answer ? null : hit;
  }
  const [lastAssistant] = await AgentMessages.find(
    { sessionId: session._id, role: 'assistant' }, { sort: { seq: -1 }, limit: 1 },
  ).fetchAsync();
  if (!lastAssistant || lastAssistant.seq < lastUser.seq) {
    return { id: modelParticipantId(session.agent), agent: session.agent };
  }
  return null;
}

/**
 * WHICH AGENT should answer a wake of this session (decision 6) — resolved
 * from durable state at wake time, never trusted from the argument a caller
 * happened to hold:
 *
 *   1. `pending.agent` — a parked (or verdict-carrying) turn belongs to the
 *      model that parked it.
 *   2. `pendingRelay.agent` — a scheduled relay belongs to its addressee.
 *   3. The newest user row's UNANSWERED addressee (rostered sessions,
 *      addressee-aware — see `unansweredAddressee`): a send addressed to a
 *      non-primary model whose deferred turn was dropped by the running/
 *      lease guards must not be answered by the primary, even when the
 *      running model's own reply committed after it.
 *   4. A mid-flight addressed turn's own tail: the newest assistant row still
 *      carrying unanswered toolCalls names its author in `from` — orphan
 *      recovery must resume that batch as that model.
 *   5. `session.agent` — the primary, today's answer.
 */
export async function resolveWakeAgent(session: AgentSession): Promise<string> {
  if (session.pending?.agent) return session.pending.agent;
  if (session.pendingRelay?.agent) return session.pendingRelay.agent;
  if (!session.participants?.length) return session.agent;

  const owed = await unansweredAddressee(session);
  if (owed) return owed.agent;

  // A standing SYSTEM INTENT names its own target (system-turn spec §4.8).
  // Consumption dispatches that target explicitly, so this clause matters only
  // on the RECOVERY path: an orphaned system turn whose row is already
  // committed would otherwise resume as the primary, under the wrong config.
  //
  // Last of the addressed clauses, deliberately. A standing relay is work the
  // team is already mid-way through, and an unanswered addressee is a person's
  // open question; a machine's scheduled prompt outranks neither — the same
  // direction decision 7 runs in.
  if (session.pendingSystem?.agent) return session.pendingSystem.agent;

  const [lastAssistant] = await AgentMessages.find(
    { sessionId: session._id, role: 'assistant' }, { sort: { seq: -1 }, limit: 1 },
  ).fetchAsync();
  if (lastAssistant?.toolCalls?.length && lastAssistant.from) {
    const owner = session.participants.find(
      (p) => p.id === lastAssistant.from!.participant && p.kind === 'model',
    );
    if (owner?.agent) return owner.agent;
  }
  return session.agent;
}
