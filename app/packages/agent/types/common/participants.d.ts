import type { AgentSession, SessionParticipant } from './types';
/** Control chars stripped, length-capped, never empty. */
export declare function sanitizeDisplayName(raw: string): string;
/** `h:<userId>` | `h:anon` — the id of an ACCOUNT human (or the anonymous
 *  capability-URL owner). */
export declare function humanParticipantId(userId: string | null): string;
/** `x:<kind>:<externalUserId>` — the id of a CHANNEL-IDENTIFIED human. The
 *  components must arrive already normalized (the lens's canonical form). */
export declare function identityParticipantId(kind: string, externalUserId: string): string;
/** `m:<agentName>` — the id of a MODEL participant. One instance per agent
 *  name per session: the derived id is the duplicate guard. */
export declare function modelParticipantId(agent: string): string;
/** The roster row for the running-model side of a `from` stamp. Pure sugar —
 *  every stamper writes the same two fields. */
export declare function modelFrom(agent: string): {
    participant: string;
    name: string;
};
/** `s:<source>` — a non-human, non-model origin (clock, webhook, job runner).
 *  Deliberately NOT a roster kind — adding one would rewrite the system prompt
 *  and flip attribution prefixing. Resolves through `nameOf`'s fallback. */
export declare function systemParticipantId(source?: string): string;
/** `from` stamp for a system row. Always stamped (decision 3) — roster-gating
 *  would drop attribution for scheduled work. */
export declare function systemFrom(source?: string): {
    participant: string;
    name: string;
};
type Roster = Pick<AgentSession, 'agent' | 'participants'>;
/** The roster's MODEL rows (with a usable agent name). */
export declare function modelParticipants(session: Roster): SessionParticipant[];
/** The human roster row a VERIFIED channel identity matches, or undefined. */
export declare function participantByIdentity(session: Roster, kind: string, externalUserId: string): SessionParticipant | undefined;
/** The human roster row an ACCOUNT matches, or undefined. Null never matches a
 *  member — the anonymous rule is the owner's alone (§4.2). */
export declare function participantByUserId(session: Roster, userId: string | null): SessionParticipant | undefined;
/** Resolve addressee: explicit `to` wins, else leading `@`, else null.
 *  Only model participants resolve. */
export declare function resolveAddressee(text: string | undefined, to: string | undefined, session: Roster): {
    id: string;
    agent: string;
} | null;
/** Relay addressee — like `resolveAddressee` but excludes self. */
export declare function resolveRelay(text: string | undefined, session: Roster, selfAgent: string): {
    id: string;
    agent: string;
} | null;
/** Find an `@model` mention in text that addressed nobody (decision 5 makes
 *  addressing leading-token only). Returns the agent name so the caller can
 *  write a note about the near miss; null when nothing was missed. */
export declare function unroutedMention(text: string | undefined, session: Roster, selfAgent?: string): string | null;
/** Do attribution prefixes disambiguate anything (decision 9)? Only in a
 *  roster with ≥2 humans or ≥2 models — the 1:1 provider payload must stay
 *  byte-identical to the rosterless one. */
export declare function needsAttribution(participants: SessionParticipant[]): boolean;
/** System-prompt participants block (§4.3). Appended per iteration because
 *  the roster can mutate mid-conversation. */
export declare function participantsBlock(session: Roster, selfAgent: string): string;
/** Whether an assistant row answers the user row at `seq`. New rows carry the
 *  `answeredThrough` context watermark — the newest user seq the model saw —
 *  because commit order lies: a mid-stream interjection commits BELOW the
 *  reply that never saw it. Rows from before the watermark fall back to the
 *  legacy seq comparison. */
export declare function assistantAnswers(assistant: {
    seq: number;
    answeredThrough?: number;
}, seq: number): boolean;
export {};
//# sourceMappingURL=participants.d.ts.map