import { buildRunConfig, type AgentConfig } from './registry';
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
/** Fire-and-forget a turn. `.catch` is load-bearing (Node unhandled = fatal). */
export declare function deferTurn(sessionId: string, config: AgentConfig, userId: string | null, opts?: Parameters<typeof buildRunConfig>[2]): void;
/** Resolve the addressed model (decision 6) and defer a turn as it.
 *  Falls back to the primary if the addressee is no longer registered. */
export declare function deferResolvedTurn(session: AgentSession): Promise<boolean>;
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
/** Consume a standing intent, dispatching through `deferTurn`. The watcher's
 *  sweep and `Agent#systemTurn` both land here; the loop's wind-down passes its
 *  own dispatcher instead. */
export declare function consumeStandingIntent(sessionId: string): Promise<boolean>;
export declare function registerMethods(): void;
//# sourceMappingURL=methods.d.ts.map