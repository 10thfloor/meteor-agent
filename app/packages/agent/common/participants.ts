import type { AgentSession, SessionParticipant } from './types';

/* Pure participants model (§4): id derivation, roster lookups, addressing
 * parse, system-prompt block. Isomorphic — no I/O, no Meteor imports. */

/** Control chars stripped, length-capped, never empty. */
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

/** `s:<source>` — a non-human, non-model origin (clock, webhook, job runner).
 *  Deliberately NOT a roster kind — adding one would rewrite the system prompt
 *  and flip attribution prefixing. Resolves through `nameOf`'s fallback. */
export function systemParticipantId(source?: string): string {
  return `s:${source && source !== '' ? source : 'system'}`;
}

/** `from` stamp for a system row. Always stamped (decision 3) — roster-gating
 *  would drop attribution for scheduled work. */
export function systemFrom(source?: string): { participant: string; name: string } {
  return {
    participant: systemParticipantId(source),
    name: source && source !== '' ? source : 'system',
  };
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

/** Leading `@<name>` addressing parse (decision 5). Token stays in text. */
const LEADING_MENTION = /^\s*@([\w.-]{1,64})/;

/** Resolve addressee: explicit `to` wins, else leading `@`, else null.
 *  Only model participants resolve. */
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
  // Retry with trailing punctuation trimmed — same recovery as element.ts.
  const trimmed = m[1].replace(/[.-]+$/, '');
  if (trimmed === m[1] || trimmed === '') return null;
  const hit = models.find((p) => p.agent === trimmed);
  return hit ? { id: hit.id, agent: hit.agent! } : null;
}

/** Relay addressee — like `resolveAddressee` but excludes self. */
export function resolveRelay(
  text: string | undefined, session: Roster, selfAgent: string,
): { id: string; agent: string } | null {
  const hit = resolveAddressee(text, undefined, session);
  return hit && hit.agent !== selfAgent ? hit : null;
}

/** Find an `@model` mention in text that addressed nobody (decision 5 makes
 *  addressing leading-token only). Returns the agent name so the caller can
 *  write a note about the near miss; null when nothing was missed. */
export function unroutedMention(
  text: string | undefined, session: Roster, selfAgent?: string,
): string | null {
  if (!text) return null;
  // It routed. Nothing was missed.
  if (resolveAddressee(text, undefined, session)) return null;
  const models = modelParticipants(session);
  if (models.length === 0) return null;
  const scan = /@([\w.-]{1,64})/g;
  let hit: RegExpExecArray | null = scan.exec(text);
  while (hit !== null) {
    // Same punctuation retry as the addressee parse, so "@risk." counts.
    const raw = hit[1];
    const trimmed = raw.replace(/[.-]+$/, '');
    const found = models.find((p) => p.agent === raw)
      ?? models.find((p) => p.agent === trimmed);
    // Naming yourself is not a missed relay — a model cannot relay to itself.
    if (found && found.agent !== selfAgent) return found.agent!;
    hit = scan.exec(text);
  }
  return null;
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

/** System-prompt participants block (§4.3). Appended per iteration because
 *  the roster can mutate mid-conversation. */
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
