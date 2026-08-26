import { AgentMessages, AgentSessions } from '../common/collections';
import {
  MAX_PARTICIPANTS, type AgentSession, type SessionParticipant,
} from '../common/types';
import {
  humanParticipantId, modelParticipantId, resolveAddressee, sanitizeDisplayName,
} from '../common/participants';
import { ChannelBindings } from './channels/collections';

/**
 * Roster mutation and wake resolution (§4.1, §4.3). Leaf module — no cycle
 * risk. All writes are guarded single-winner Mongo ops; no lease required.
 */

/** Seed rows: owner human + primary model. The array is absent or complete. */
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
  /** Display name for the owner's seeded row (default 'owner'). */
  ownerName?: string;
}

/** Add a participant, seeding the roster on first join. Two single-winner
 *  writes avoid a race where concurrent first-joins duplicate seed rows.
 *  Re-adding an existing id is an idempotent adopt. */
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
    // Roster now exists regardless of which racer won.
  }

  // Already-seeded id is an adopt, not a failure.
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
  // Only return the id if the row actually landed.
  const after = await AgentSessions.findOneAsync(sessionId);
  return after?.participants?.some((p) => p.id === row.id) ? row.id : null;
}

/** Remove a member (§4.6). Refused for the owner. Also deletes the member's
 *  bindings so egress stops routing to the departed participant. */
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

/** Read the roster fresh; empty array when absent. */
export async function listParticipants(sessionId: string): Promise<SessionParticipant[]> {
  const session = await AgentSessions.findOneAsync(sessionId);
  return session?.participants ?? [];
}

/** The addressee of the newest user row, if that addressee hasn't answered.
 *  Addressee-aware: only a reply FROM the addressee counts as an answer. */
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

/** Resolve which agent should answer a wake, from durable state:
 *  pending.agent > pendingRelay > unanswered addressee > pendingSystem >
 *  mid-flight tool author > primary. */
export async function resolveWakeAgent(session: AgentSession): Promise<string> {
  if (session.pending?.agent) return session.pending.agent;
  if (session.pendingRelay?.agent) return session.pendingRelay.agent;

  // Guarded: rosterless sessions must still reach the pendingSystem clause below.
  if (session.participants?.length) {
    const owed = await unansweredAddressee(session);
    if (owed) return owed.agent;
  }

  // System intent: matters on recovery so an orphaned system turn resumes
  // under the right model. Ranked below relay and addressee deliberately.
  if (session.pendingSystem?.agent) return session.pendingSystem.agent;

  if (!session.participants?.length) return session.agent;

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
