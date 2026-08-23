import type { AgentSession, SessionParticipant } from './types';

/**
 * The PURE half of the participants model (participants spec §4): id
 * derivation, roster lookups, the mechanical addressing parse, and the
 * system-prompt block. Isomorphic — the web element renders names with the
 * same helpers the server stamps them with. No I/O, no Meteor imports.
 */

/** Display-string discipline for names that land in prompts, transcripts and
 *  the element: control characters stripped, length-capped, never empty. The
 *  same rule the attachment store applies to file names, for the same reason. */
export function sanitizeDisplayName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  const capped = cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
  return capped === '' ? 'participant' : capped;
}

/** `h:<userId>` | `h:anon` — the id of an ACCOUNT human (or the anonymous
 *  capability-URL owner). */
export function humanParticipantId(userId: string | null): string {
  return userId === null ? 'h:anon' : `h:${userId}`;
}

/** `x:<kind>:<externalUserId>` — the id of a CHANNEL-IDENTIFIED human. The
 *  components must arrive already normalized (the lens's canonical form). */
export function identityParticipantId(kind: string, externalUserId: string): string {
  return `x:${kind}:${externalUserId}`;
}

/** `m:<agentName>` — the id of a MODEL participant. One instance per agent
 *  name per session: the derived id is the duplicate guard. */
export function modelParticipantId(agent: string): string {
  return `m:${agent}`;
}

/** The roster row for the running-model side of a `from` stamp. Pure sugar —
 *  every stamper writes the same two fields. */
export function modelFrom(agent: string): { participant: string; name: string } {
  return { participant: modelParticipantId(agent), name: agent };
}

type Roster = Pick<AgentSession, 'agent' | 'participants'>;

/** The roster's MODEL rows (with a usable agent name). */
export function modelParticipants(session: Roster): SessionParticipant[] {
  return (session.participants ?? []).filter(
    (p) => p.kind === 'model' && typeof p.agent === 'string' && p.agent !== '',
  );
}

/** The human roster row a VERIFIED channel identity matches, or undefined. */
export function participantByIdentity(
  session: Roster, kind: string, externalUserId: string,
): SessionParticipant | undefined {
  return (session.participants ?? []).find(
    (p) => p.kind === 'human'
      && p.identity?.kind === kind && p.identity.externalUserId === externalUserId,
  );
}

/** The human roster row an ACCOUNT matches, or undefined. Null never matches a
 *  member — the anonymous rule is the owner's alone (§4.2). */
export function participantByUserId(
  session: Roster, userId: string | null,
): SessionParticipant | undefined {
  if (userId === null) return undefined;
  return (session.participants ?? []).find(
    (p) => p.kind === 'human' && p.userId === userId,
  );
}

/**
 * The one leading-token parse the package performs (decision 5): a message
 * whose trimmed text begins `@<name>` — where `<name>` is a model
 * participant's agent name — is ADDRESSED to that model. The token stays in
 * the text (it is speech, not markup); an unmatched `@name` is just text.
 */
const LEADING_MENTION = /^\s*@([\w.-]{1,64})/;

/**
 * Resolve a message's addressee against the roster, mechanically:
 * an explicit `to` (a participant id or a bare agent name) wins, else the
 * leading `@` token, else null — the caller's default (the primary model).
 * Only MODEL participants resolve: addressing a human schedules nothing, so a
 * `to` naming one is recorded by the caller but never returned from here.
 */
export function resolveAddressee(
  text: string | undefined, to: string | undefined, session: Roster,
): { id: string; agent: string } | null {
  const models = modelParticipants(session);
  if (models.length === 0) return null;
  if (to !== undefined && to !== '') {
    const hit = models.find((p) => p.id === to || p.agent === to);
    return hit ? { id: hit.id, agent: hit.agent! } : null;
  }
  const m = LEADING_MENTION.exec(text ?? '');
  if (!m) return null;
  const exact = models.find((p) => p.agent === m[1]);
  if (exact) return { id: exact.id, agent: exact.agent! };
  // "@analyst." — the class admits '.' and '-' for dotted agent names, so
  // sentence punctuation rides into the capture. A token that matches no
  // model retries with trailing punctuation trimmed: a real agent name the
  // roster lacks cannot END in it, so the trim can only recover an address,
  // never invent one.
  const trimmed = m[1].replace(/[.-]+$/, '');
  if (trimmed === m[1] || trimmed === '') return null;
  const hit = models.find((p) => p.agent === trimmed);
  return hit ? { id: hit.id, agent: hit.agent! } : null;
}

/**
 * A RELAY: the addressee of a MODEL's own reply, excluding itself — a model
 * cannot relay to itself, and only another model participant schedules
 * anything. Same parse as `resolveAddressee`, same mechanical contract.
 */
export function resolveRelay(
  text: string | undefined, session: Roster, selfAgent: string,
): { id: string; agent: string } | null {
  const hit = resolveAddressee(text, undefined, session);
  return hit && hit.agent !== selfAgent ? hit : null;
}

/** Do attribution prefixes disambiguate anything (decision 9)? Only in a
 *  roster with ≥2 humans or ≥2 models — the 1:1 provider payload must stay
 *  byte-identical to the rosterless one. */
export function needsAttribution(participants: SessionParticipant[]): boolean {
  let humans = 0;
  let models = 0;
  for (const p of participants) {
    if (p.kind === 'human') humans += 1;
    else models += 1;
  }
  return humans >= 2 || models >= 2;
}

/**
 * The system-prompt participants block (§4.3), appended INSIDE the loop per
 * iteration — never baked into `RunConfig.system`, because the roster mutates
 * mid-conversation (compose's `'continue'` joins a recipient mid-turn) and a
 * defer-time prompt would be stale by design. Mechanical: names, kinds, the
 * addressing rule, and the impersonation injunction.
 */
export function participantsBlock(session: Roster, selfAgent: string): string {
  const roster = session.participants ?? [];
  if (roster.length === 0) return '';
  const listing = roster
    .filter((p) => !(p.kind === 'model' && p.agent === selfAgent))
    .map((p) => {
      const role = p.kind === 'human' && p.role === 'owner' ? 'human, owner' : p.kind;
      return `- ${p.displayName} (${role})`;
    })
    .join('\n');
  const colleagues = modelParticipants(session).filter((p) => p.agent !== selfAgent);
  const addressing = colleagues.length > 0
    ? '\nAddress a model colleague by starting your reply with @<their name> '
      + `(${colleagues.map((p) => `@${p.agent}`).join(', ')}); otherwise your reply `
      + 'goes to the conversation.'
    : '';
  return `\n\n## Conversation participants\n\nYou are "${selfAgent}". `
    + `Also in this conversation:\n${listing}\n\n`
    + 'Messages may be prefixed with [name]: to show their speaker. The system '
    + 'records who wrote each message; never write such a prefix yourself and '
    + `never speak as another participant.${addressing}`;
}
