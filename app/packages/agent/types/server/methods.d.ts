import { buildRunConfig, type AgentConfig } from './registry';
import { type AgentSession, type AttachmentRef } from '../common/types';
import { type SystemTurnResult } from './system-turn';
/**
 * A VERIFIED channel identity, vouched for by trusted server code — the
 * ingress principal (participants spec decision 12). Constructible only by
 * callers of the server-side cores (`sendToSession`'s `extras.via`); never
 * reachable from a DDP cap. It matches a roster row's `identity` and confers
 * message-send standing for exactly one event — no DDP capability, no
 * approval authority, no reads.
 */
export interface ViaIdentity {
    kind: string;
    externalUserId: string;
}
/**
 * Authorize BEFORE acting, on every method that touches an existing session.
 *
 * Scoped by `agent` as well as `userId`, matching the `agent.session`
 * publication's filter exactly. Without the agent scope, `Agent('a').send(id)`
 * would run agent A's model, system prompt and tools against a transcript the
 * session document says belongs to agent B — a session the same caller cannot
 * even subscribe to under that name. Same-user only, so not a disclosure bug,
 * but the two halves of the API must agree on what a session is.
 *
 * The error is deliberately identical for "no such session" and "not yours":
 * distinguishing them would confirm the existence of another user's session id.
 *
 * MEMBERSHIP (participants spec §4.2) widens the match in one query, three
 * clauses ordered owner-first:
 *   1. `userId` equality — today's rule, the only clause a rosterless session
 *      can match, and the only one `userId: null` may EVER match: the
 *      anonymous rule is the owner's alone, so a null caller on an owned
 *      group session still gets `no-session`. Fail closed.
 *   2. A human roster row with this (non-null) userId — an account member.
 *   3. A human roster row whose `identity` equals the trusted `via` — a
 *      channel-identified member, vouched for by ingress and reachable from
 *      no DDP cap.
 */
export declare function requireSession(agent: string, sessionId: string, userId: string | null, via?: ViaIdentity): Promise<AgentSession>;
/**
 * Wake a run: return to the caller immediately and let the turn stream in the
 * background, watched through the subscription.
 *
 * Every method that starts work goes through this, so a send and an approval
 * resume a session on identical terms — same registry config, same pi-ai
 * fallback, same error containment. Exported for the watcher (§4.3), which wakes
 * an orphan through this same shape rather than assembling a `RunConfig` of its
 * own: a recovered turn must run with exactly the config a user-initiated one
 * would.
 *
 * The `.catch` is load-bearing, not decoration: an unhandled rejection is
 * fatal by default on Node >= 15, so a bare `void runTurn(...)` would let one
 * bad provider call take down the whole app server.
 */
export declare function deferTurn(sessionId: string, config: AgentConfig, userId: string | null, opts?: Parameters<typeof buildRunConfig>[2]): void;
/**
 * Wake a session as the RIGHT model participant (participants spec decision
 * 6): resolve the addressee from durable state (`resolveWakeAgent` — the
 * parked turn's `pending.agent`, a standing relay, the unanswered tail), then
 * compose the run — the addressee's config, the PRIMARY's budget, the
 * session's OWNER as the run identity. Every recovery-shaped caller
 * (`recordVerdict`, the approval timeout, the watcher) goes through this so
 * an addressed turn can never be resumed under the wrong model's tools.
 *
 * Falls back to the primary — with a warning — when the addressee's agent
 * name is no longer registered: a renamed colleague must not strand the
 * session, and the primary answering visibly beats nobody answering at all.
 */
export declare function deferResolvedTurn(session: AgentSession): Promise<boolean>;
/**
 * §4.3. Deny a parked approval that nobody answered in time, and wake the run.
 *
 * The watcher's sweep decides WHEN (it owns `budget.approval` and the clock);
 * this owns WHAT a timeout is: a denial, recorded through the same single-winner
 * core a human verdict goes through, with `by: null` because no one decided, and
 * `timedOut: true` on the audit row so the distinction survives in history. The
 * loop then answers the parked call with `{ error: 'denied', reason: 'approval
 * timed out' }` — the model sees the refusal and routes around it, exactly as it
 * does for a human denial.
 *
 * No `config.approve` check: that predicate says who may ANSWER, and nobody is
 * answering. No ownership check either — there is no caller to authorize.
 *
 * Returns false when the session or its agent is gone, or when another server's
 * sweep won the race. Never throws: a sweep is not a caller.
 */
export declare function recordTimeoutVerdict(sessionId: string): Promise<boolean>;
/**
 * The shared body of `agent.approve` and `agent.deny`: authorize, decide once,
 * record the verdict in the transcript, and wake the parked run.
 *
 * Order is the whole design here. Authorization comes first (`requireSession`,
 * then the agent's own `approve` predicate) so a refused caller changes
 * nothing at all — the run stays parked and the transcript stays clean. The
 * verdict write is conditional on the state it read (`phase: 'awaiting'`, no
 * verdict yet) rather than on a re-read, so two people clicking Approve at the
 * same instant produce exactly one winner and exactly one side effect; the
 * loser is told `no-pending` rather than being handed a silent success for a
 * tool it never authorized.
 */
export declare function recordVerdict(ctx: {
    userId: string | null;
}, agent: string, sessionId: string, verdict: 'approved' | 'denied', reason?: string): Promise<void>;
/**
 * The CORE of `agent.send`, with identity as a plain parameter — the same
 * extract-with-`userId` refactor `ask`/`fork`/`compact` already had (channels
 * spec §5.1). `mSend` below is a cap over this: checks, the `startable`
 * refusal (see its comment for why that lives on the cap, not here), then
 * this core with `this.userId`. `Agent.send` (agent.ts) owns the public
 * semantics.
 *
 * Nothing here is new machinery: `requireSession` is the same always-3-field
 * authorization every method uses (`userId: null` scopes to the ANONYMOUS
 * owner, never to "all sessions"), the seq allocation is the same atomic
 * `findOneAndUpdate` with the budget `$lt` folded in — so any caller of the
 * core inherits the turn budget — and the wake is the one `deferTurn` path.
 */
export declare function sendToSession(agent: string, sessionId: string, text: string, userId: string | null, 
/** Server-side extras trusted callers supply — never reachable from the DDP
 *  cap. `attachments`: refs a channel's admission just wrote (email v2 spec
 *  §6). `via`: the verified channel identity of the sender (participants
 *  spec decision 12) — ingress only. `to`: an explicit addressee
 *  (participant id or agent name), overriding the leading-`@` parse. */
extras?: {
    attachments?: AttachmentRef[];
    via?: ViaIdentity;
    to?: string;
}): Promise<string>;
export declare function startSystemTurn(sessionId: string, prompt: string, opts?: {
    key?: string;
    agent?: string;
    source?: string;
}): Promise<SystemTurnResult>;
/** Consume a standing intent, dispatching through `deferTurn`. The watcher's
 *  sweep and `Agent#systemTurn` both land here; the loop's wind-down passes its
 *  own dispatcher instead. */
export declare function consumeStandingIntent(sessionId: string): Promise<boolean>;
export declare function registerMethods(): void;
//# sourceMappingURL=methods.d.ts.map