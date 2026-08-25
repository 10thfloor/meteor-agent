import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import type { Phase, ViewMessage } from '../common/types';
import type { SessionQuery } from '../common/db';
/**
 * Client-side handle on one agent.
 *
 * Server-backed reads below use minimongo's SYNCHRONOUS API on purpose: the
 * async-only rule this package follows is a server rule (a Meteor 3 server
 * collection call must not block the event loop). On the client `find`,
 * `findOne`, `fetch`, `upsert` and `remove` are the idiomatic — and reactive —
 * calls.
 */
export declare class Agent {
    readonly name: string;
    /** Client-only collection holding the merged view. */
    private view;
    private computation;
    /** The handle from the LAST `subscribe()`, retained so `stop()` has something
     *  to stop. `Meteor.subscribe` outside a reactive computation is never
     *  cleaned up for you — returning the handle and keeping no reference to it
     *  was the leak. */
    private handle;
    /** Which session `subscribe()` last opened — the identity `stop(sessionId)`
     *  checks itself against. */
    private watching;
    constructor(name: string);
    subscribe(sessionId: string): Meteor.SubscriptionHandle;
    /**
     * Tear down everything `subscribe()` started: the merge computation, the
     * subscription, and the merged view it maintained.
     *
     * Call it from a component's unmount — `useEffect(() => () =>
     * agent.stop(sessionId), [sessionId])`. A `Tracker.autorun` created outside a
     * parent computation and a `Meteor.subscribe` called outside one both live
     * until stopped explicitly; without this, navigating away from a chat leaves
     * an autorun recomputing on every delta of a session nobody is looking at,
     * and a subscription still shipping them over DDP.
     *
     * Idempotent, because unmount paths double-fire (React 18 StrictMode mounts,
     * unmounts and remounts every effect in development): the second call finds
     * both handles already null and does nothing.
     *
     * `sessionId` is an optional GUARD, not a selector — this instance only ever
     * holds one session. Pass it and the teardown happens only if that session is
     * still the one being watched, so a stale unmount cleanup arriving AFTER a
     * re-subscribe to a newer session (React runs the old effect's cleanup after
     * the new render in some orderings) cannot tear down the live subscription.
     *
     * `subscribe()` afterwards works exactly as the first time: nothing here is
     * one-way.
     */
    stop(sessionId?: string): void;
    /**
     * Keep `view` equal to mergeView(committed, deltas) for ONE session.
     *
     * The sweep is over the whole view, not over `{ sessionId }`: re-subscribing
     * to a different session must evict the previous session's rows rather than
     * leave them behind for `messages()` to serve. One Agent instance therefore
     * shows one session at a time — construct a second Agent to watch two.
     */
    private startMerging;
    messages(sessionId: string): Mongo.Cursor<ViewMessage, ViewMessage>;
    session(sessionId: string): import(".").AgentSession | undefined;
    status(sessionId: string): Phase;
    usage(sessionId: string): import(".").Usage;
    /** Requires a separate Meteor.subscribe(NAMES.pubSessions, name). */
    subscribeSessions(): Meteor.SubscriptionHandle;
    sessions(selector?: SessionQuery): Mongo.Cursor<import(".").AgentSession, import(".").AgentSession>;
    start(opts?: {
        title?: string;
    }): Promise<string>;
    send(sessionId: string, text: string): Promise<string>;
    interrupt(sessionId: string): Promise<void>;
    /**
     * Branch this session into a new one sharing its history up to `atSeq`, and
     * resolve with the NEW session id — `subscribe()` it and carry on from there.
     *
     * `atSeq` defaults to the whole conversation and is clamped DOWN to the
     * nearest batch-safe cut point server-side, so passing the seq of the row a
     * user clicked is always safe even when that row sits inside a tool batch.
     * The fork shows up in `sessions()` like any other conversation.
     */
    fork(sessionId: string, opts?: {
        atSeq?: number;
        title?: string;
    }): Promise<string>;
    /**
     * Compact this session's history NOW, whatever the `context.compactAt`
     * threshold says — a "compact now" button. Resolves true when a summary note
     * was committed, false when there was nothing worth compacting.
     *
     * Rejects with `busy` while a turn is running: a compaction writes to the
     * transcript exactly as a turn does. Gate the button on
     * `status(id) === 'idle'`.
     *
     * The transcript keeps every message, so nothing disappears from your UI —
     * the note changes only what the MODEL sees from here on.
     */
    compact(sessionId: string): Promise<boolean>;
    /**
     * The tool call waiting on a human answer, or undefined when nothing is
     * parked. Reactive, like `status()` — render it beside `status(id) ===
     * 'awaiting'` to show what is being asked, then call `approve`/`deny`.
     */
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
    /**
     * Mint a single-use download URL for one attachment ref (participants spec
     * §7) — call it ON CLICK and navigate immediately: the token lives about a
     * minute and is burned by the GET, so the URL is a fetch handle, never a
     * share handle. Rejects `no-attachment` for an id this session does not
     * hold.
     */
    attachmentUrl(sessionId: string, attachmentId: string): Promise<string>;
    approve(sessionId: string): Promise<void>;
    /** `reason` reaches the model as the denied tool result, so it is the model's
     *  only account of why — worth writing for it, not just for the log. */
    deny(sessionId: string, reason?: string): Promise<void>;
}
//# sourceMappingURL=agent.d.ts.map