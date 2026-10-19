import { type AgentSession, type AttachmentRef, type MessageSource } from '../common/types';
import { type SystemTurnResult } from './system-turn';
/** What a send with `replyIn` or `alsoToParent` resolves to. Plain sends keep
 * resolving to the session id. */
export interface ThreadSendResult {
    /** The session the send was addressed to. */
    sessionId: string;
    /** `replyIn: 'thread'`: the thread that answers the message. */
    threadSessionId?: string;
}
/** Verified channel identity (decision 12); server-side only, never from DDP. */
export interface ViaIdentity {
    kind: string;
    externalUserId: string;
}
/** Authorize by agent + userId (or roster membership / via identity).
 *  Same error for "not found" and "not yours" to avoid confirming ids. */
export declare function requireSession(agent: string, sessionId: string, userId: string | null, via?: ViaIdentity): Promise<AgentSession>;
/** §4.3. Timeout denial: deny via `writeVerdict`, then wake. Never throws. */
export declare function recordTimeoutVerdict(sessionId: string): Promise<boolean>;
/** Authorize, decide once (conditional write), record, and wake. */
export declare function recordVerdict(ctx: {
    userId: string | null;
}, agent: string, sessionId: string, verdict: 'approved' | 'denied', reason?: string, expectedToolCallId?: string): Promise<void>;
/** Core of `agent.send` (§5.1). `mSend` is a DDP cap over this. */
export declare function sendToSession(agent: string, sessionId: string, text: string, userId: string | null, 
/** Server-side extras (attachments, via identity, explicit addressee). */
extras?: {
    attachments?: AttachmentRef[];
    via?: ViaIdentity;
    to?: string;
    /** Trusted ingress attribution. DDP/channel callers stamp this themselves;
     *  no public method argument accepts it. */
    source?: MessageSource;
    /** `'thread'`: commit the message here without waking this session and
     *  open a thread on it whose model answers instead. */
    replyIn?: 'thread';
    /** Sends to a thread only: also copy the message into the thread's parent
     *  as context, without waking the parent. */
    alsoToParent?: boolean;
}): Promise<string | ThreadSendResult>;
/** Find or open the thread on one message. `userId` scopes the lookup to the
 * owner or a human roster member (send's rule, not fork's owner-only rule);
 * `undefined` is an unscoped server call. */
export declare function threadFor(agent: string, sessionId: string, messageId: string, userId?: string | null): Promise<string>;
/** Commit a human crew note without scheduling model work. It is deliberately
 * a `user` row (so a later turn sees it as conversation context) with
 * `kind:'crew-note'` (so recovery/routing never treats it as unanswered).
 * There is no pending-input link, Turn-budget charge, addressee resolution or
 * Activation call. */
export declare function contributeToSession(agent: string, sessionId: string, text: string, userId: string | null, extras?: {
    via?: ViaIdentity;
    source?: MessageSource;
}): Promise<string>;
export declare function startSystemTurn(sessionId: string, prompt: string, opts?: {
    key?: string;
    agent?: string;
    source?: string;
}): Promise<SystemTurnResult>;
/** Compatibility entry for consuming a standing intent through Activation. */
export declare function consumeStandingIntent(sessionId: string): Promise<boolean>;
export declare function registerMethods(): void;
//# sourceMappingURL=methods.d.ts.map