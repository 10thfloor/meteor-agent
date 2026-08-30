import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import type { Phase, ViewMessage } from '../common/types';
import type { SessionQuery } from '../common/db';
/** Client-side handle on one agent. Uses minimongo's synchronous API
 *  (the async-only rule is server-side). */
export declare class Agent {
    readonly name: string;
    /** Client-only collection holding the merged view. */
    private view;
    private computation;
    /** Retained so `stop()` can clean it up. */
    private handle;
    /** Which session is being watched — `stop(sessionId)` guard. */
    private watching;
    constructor(name: string);
    subscribe(sessionId: string): Meteor.SubscriptionHandle;
    /** Tear down computation + subscription + view. Idempotent (React 18
     *  StrictMode double-fires). `sessionId` is a guard: a stale unmount
     *  cleanup cannot tear down a newer subscription. */
    stop(sessionId?: string): void;
    /** Keep `view` = mergeView(committed, deltas) for one session.
     *  Sweeps the whole view so a re-subscribe evicts the old session. */
    private startMerging;
    messages(sessionId: string): Mongo.Cursor<ViewMessage, ViewMessage>;
    session(sessionId: string): import(".").AgentSession | undefined;
    status(sessionId: string): Phase;
    usage(sessionId: string): import(".").Usage;
    /** Requires a separate Meteor.subscribe(NAMES.pubSessions, name).
     *  Archived sessions are left out unless asked for. */
    subscribeSessions(includeArchived?: boolean): Meteor.SubscriptionHandle;
    sessions(selector?: SessionQuery): Mongo.Cursor<import(".").AgentSession, import(".").AgentSession>;
    start(opts?: {
        title?: string;
    }): Promise<string>;
    send(sessionId: string, text: string): Promise<string>;
    /** Commit human-to-crew context without waking an agent. The stable retry
     * key makes Meteor's transparent reconnect retry exactly-once. */
    contribute(sessionId: string, text: string): Promise<string>;
    interrupt(sessionId: string): Promise<void>;
    /** Branch at atSeq (clamped to batch-safe cut). Returns new session id. */
    fork(sessionId: string, opts?: {
        atSeq?: number;
        title?: string;
    }): Promise<string>;
    /** Force-compact now. True = summary committed, false = nothing to compact.
     *  Rejects 'busy' if a turn is running — gate on idle. */
    compact(sessionId: string): Promise<boolean>;
    /** Parked tool call awaiting human answer, or undefined. */
    pending(sessionId: string): {
        toolCallId: string;
        name: string;
        args: unknown;
        requestedAt?: Date;
        verdict?: 'approved' | 'denied';
        by?: string | null;
        reason?: string;
        mcpServer?: string;
        runAs?: string | null;
        agent?: string;
        display?: string;
        wakeToken?: string;
    } | undefined;
    /** Mint a single-use download URL (burned on GET, ~60s TTL). */
    attachmentUrl(sessionId: string, attachmentId: string): Promise<string>;
    /** Bind the click to the ask that was rendered when possible. Omitting the
     * id remains supported for older callers. */
    approve(sessionId: string, expectedToolCallId?: string): Promise<void>;
    /** `reason` reaches the model as the denied tool result, so it is the model's
     *  only account of why — worth writing for it, not just for the log. */
    deny(sessionId: string, reason?: string, expectedToolCallId?: string): Promise<void>;
    /** Shelve a session: it drops out of `sessions()` and keeps everything else,
     *  including the ability to take a turn. */
    archive(sessionId: string): Promise<void>;
    unarchive(sessionId: string): Promise<void>;
}
//# sourceMappingURL=agent.d.ts.map