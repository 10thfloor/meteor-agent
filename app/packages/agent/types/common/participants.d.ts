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
/**
 * `s:<source>` — the id of a NON-HUMAN, non-model origin: the clock, a webhook,
 * a job runner. System-turn spec decision 2.
 *
 * It is deliberately not a roster kind. `participantsBlock` renders every roster
 * row's `kind` into the prompt and `needsAttribution` counts every non-human row
 * as a model, so a `kind: 'system'` row would rewrite the system prompt of every
 * rostered session and flip `[name]: ` prefixing on 1:1 ones. An id outside the
 * roster resolves through `nameOf`'s fallback instead — the same trick a
 * subagent's stamp uses.
 *
 * The `s:` prefix must stay disjoint from `h:`, `x:` and `m:`: a system origin
 * that could be mistaken for a human id would be matched by the ownership and
 * publication checks that key on one.
 */
export declare function systemParticipantId(source?: string): string;
/** The `from` stamp for a system-originated row. Stamped whether or not the
 *  session has a roster (decision 3) — a system row is net-new, so there is no
 *  byte-identical 1:1 payload to preserve, and roster-gating it would drop
 *  attribution in exactly the case scheduled work uses. */
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
/**
 * Resolve a message's addressee against the roster, mechanically:
 * an explicit `to` (a participant id or a bare agent name) wins, else the
 * leading `@` token, else null — the caller's default (the primary model).
 * Only MODEL participants resolve: addressing a human schedules nothing, so a
 * `to` naming one is recorded by the caller but never returned from here.
 */
export declare function resolveAddressee(text: string | undefined, to: string | undefined, session: Roster): {
    id: string;
    agent: string;
} | null;
/**
 * A RELAY: the addressee of a MODEL's own reply, excluding itself — a model
 * cannot relay to itself, and only another model participant schedules
 * anything. Same parse as `resolveAddressee`, same mechanical contract.
 */
export declare function resolveRelay(text: string | undefined, session: Roster, selfAgent: string): {
    id: string;
    agent: string;
} | null;
/** Do attribution prefixes disambiguate anything (decision 9)? Only in a
 *  roster with ≥2 humans or ≥2 models — the 1:1 provider payload must stay
 *  byte-identical to the rosterless one. */
export declare function needsAttribution(participants: SessionParticipant[]): boolean;
/**
 * The system-prompt participants block (§4.3), appended INSIDE the loop per
 * iteration — never baked into `RunConfig.system`, because the roster mutates
 * mid-conversation (compose's `'continue'` joins a recipient mid-turn) and a
 * defer-time prompt would be stale by design. Mechanical: names, kinds, the
 * addressing rule, and the impersonation injunction.
 */
export declare function participantsBlock(session: Roster, selfAgent: string): string;
export {};
//# sourceMappingURL=participants.d.ts.map