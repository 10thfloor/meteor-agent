import { type AgentSession, type AttachmentRef } from '../common/types';
import { type SystemTurnResult } from './system-turn';
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
}, agent: string, sessionId: string, verdict: 'approved' | 'denied', reason?: string): Promise<void>;
/** Core of `agent.send` (§5.1). `mSend` is a DDP cap over this. */
export declare function sendToSession(agent: string, sessionId: string, text: string, userId: string | null, 
/** Server-side extras (attachments, via identity, explicit addressee). */
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
/** Compatibility entry for consuming a standing intent through Activation. */
export declare function consumeStandingIntent(sessionId: string): Promise<boolean>;
export declare function registerMethods(): void;
//# sourceMappingURL=methods.d.ts.map