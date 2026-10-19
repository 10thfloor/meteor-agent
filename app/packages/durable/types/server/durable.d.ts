import { ROOT_CONVERSATION_ID } from '../common/names';
import { DurableHost, type Operation } from './host';
import type { MongoStorage } from './mongo-storage';
import { type AgentChoices } from './operations';
/** What a client may ask for over DDP. The server-side API is never asked. */
export type DurableAction = 'view' | 'root' | 'create' | 'fork' | 'submit' | 'abort' | 'withdraw' | 'reset' | 'compact';
export type DurableTarget = {
    readonly key: string;
    readonly conversationId?: number;
};
/** User input as pi-ai takes it: text, or text and image parts. */
export type DurableContent = string | ({
    type: 'text';
    text: string;
} | {
    type: 'image';
    data: string;
    mimeType: string;
})[];
export type DurableDraft = {
    type: 'input';
    content: DurableContent;
    whenBusy?: 'steer' | 'followUp' | 'reject';
    requestId?: string;
} | {
    type: 'write';
    entry: Record<string, unknown>;
    requestId?: string;
};
export type DurableConfig = {
    /**
     * What a harness over the storage `key` runs with: Pi Durable's
     * `HarnessOptions` without the storage, so at least `models` and `registry`.
     * Called on whichever server instance hosts the storage, each time it opens.
     */
    harness(key: string): Record<string, any> | Promise<Record<string, any>>;
    /**
     * Who may do what over DDP. Absent, or returning anything but `true`:
     * refused. A viewer's rule is asked again while its subscription lives, so
     * a `view` that turns false ends the subscription.
     */
    allow?(userId: string | null, action: DurableAction, target: DurableTarget): boolean | Promise<boolean>;
    /**
     * The agent a conversation created over DDP starts with. A client never
     * chooses its own model, tools or instructions.
     */
    agent?(target: {
        key: string;
        userId: string | null;
        action: 'root' | 'create' | 'fork';
    }): AgentChoices | undefined | Promise<AgentChoices | undefined>;
    /**
     * More that can be asked of a storage from any instance, with `call()`,
     * beside the built-in operations. Each is given the storage's harness on
     * the instance that hosts it, and the app's `key`. A client cannot call one.
     */
    operations?: Readonly<Record<string, Operation>>;
    /** Document kinds a viewer receives. Default `pi.live`, `pi.inbox`, `pi.usage`. */
    documents?: readonly string[];
    /** Entry kinds a viewer does not receive. Default `pi.system`. */
    hiddenEntries?: readonly string[];
};
/**
 * Names this server instance among those sharing the database. It is stable
 * across restarts of the same instance, so a restarted server resumes its own
 * storages at once, and distinct between instances: the host name, plus the
 * app's URL in development (where the port changes) or its port in production,
 * plus PM2's `NODE_APP_INSTANCE` where several processes share one port.
 * `DURABLE_INSTANCE_ID`, or `instanceId` in the package settings, overrides it.
 * Processes that run at the same time need different names; see `DurableHost`.
 */
export declare function instanceId(): string;
/**
 * The one host of this server process. Every definition shares it: one lease
 * heartbeat, one sweep, one request stream.
 */
export declare function durableHost(): Promise<DurableHost>;
/**
 * Stop hosting on this instance: close every open storage and hand over the
 * ones with work left. The next use of a definition starts hosting again. A
 * production server does this by itself when it is told to end (SIGTERM or
 * SIGINT), within `shutdownMs`; call it from a shutdown path of your own.
 */
export declare function shutdown(): Promise<void>;
/** The definition named `name`, if this server has one. */
export declare function definitionNamed(name: string): Durable | undefined;
/**
 * A family of Pi Durable storages on this app's Mongo, hosted by whichever
 * server instance gets there first and reachable from all of them.
 *
 * ```ts
 * export const Missions = new Durable('missions', {
 *   harness: () => ({ models, registry }),
 *   allow: (userId, action, { key }) => ownsMission(userId, key),
 * });
 * const { submissionId } = await Missions.submit('m42', 1, 'Why did the deploy fail?');
 * ```
 *
 * One `key` is one storage: one Pi Durable Session, with its conversations,
 * tasks and documents, one commit line, and one owner at a time. Use a key
 * per unit that works together, such as a mission, never one for the app.
 */
export declare class Durable {
    readonly name: string;
    readonly operations: Readonly<Record<string, Operation>>;
    readonly documents: readonly string[];
    readonly hiddenEntries: readonly string[];
    private readonly config;
    constructor(name: string, config: DurableConfig);
    /** Test seam: forget this definition. Storages it has open here are closed, and handed over if they have work. */
    _remove(): Promise<void>;
    /** The storage key of `key`: the definition's name is its namespace. */
    storage(key: string): string;
    /** Whether `userId` may do `action` over DDP. Server-side callers are never asked. */
    allows(userId: string | null, action: DurableAction, target: DurableTarget): Promise<boolean>;
    /** The agent a conversation created over DDP starts with. */
    agentFor(target: {
        key: string;
        userId: string | null;
        action: 'root' | 'create' | 'fork';
    }): Promise<AgentChoices | undefined>;
    /** Run an operation against the storage `key`, on whichever instance hosts it. */
    call<T = unknown>(key: string, op: string, args?: unknown, options?: {
        requestId?: string;
    }): Promise<T>;
    /** The root conversation's ID, creating it with `agent` on first use. */
    root(key: string, agent?: AgentChoices): Promise<number>;
    /** A new conversation in the storage. */
    create(key: string, agent?: AgentChoices): Promise<number>;
    /** A fork of `conversationId` at the entry `at`. */
    fork(key: string, conversationId: number, at: number, agent?: AgentChoices): Promise<number>;
    /**
     * Hand user input, or a passive entry write, to a conversation. A string is
     * input. It resolves once the submission is durably admitted, not once it is
     * answered; `settled()` or `ask()` wait for the answer.
     */
    submit(key: string, conversationId: number, draft: string | DurableDraft): Promise<{
        submissionId: number;
    }>;
    /** Stop a conversation's current work. `idle` is whether it had stopped when this returned. */
    abort(key: string, conversationId: number, options?: {
        background?: boolean;
        waitMs?: number;
    }): Promise<{
        idle: boolean;
    }>;
    /** Withdraw a queued submission. */
    withdraw(key: string, submissionId: number, conversationId?: number): Promise<'aborted' | 'already_placed' | 'settled' | 'not_found'>;
    /** Start a new context, optionally from a handoff note. */
    reset(key: string, conversationId: number, handoff?: string): Promise<void>;
    /** Summarize older entries now. Resolves with the compaction task's ID. */
    compact(key: string, conversationId: number, instructions?: string): Promise<number>;
    /** Change what a conversation runs with. */
    configure(key: string, conversationId: number, agent: AgentChoices): Promise<void>;
    /** A read-only view of the storage: every read of Pi Durable's storage contract, with no ownership. */
    reader(key: string): Promise<MongoStorage>;
    /** Resolve with the submission's record once it is answered or has failed. */
    settled(key: string, submissionId: number, options?: {
        timeoutMs?: number;
    }): Promise<any>;
    /**
     * Input, and its answer: submit to the conversation (the root by default),
     * wait for the run to end, and read what the model said last.
     */
    ask(key: string, content: DurableContent, options?: {
        conversationId?: number;
        requestId?: string;
        timeoutMs?: number;
        agent?: AgentChoices;
    }): Promise<{
        status: 'done' | 'unanswered';
        text: string;
        submissionId: number;
        entryId?: number;
        reason?: string;
    }>;
    /**
     * Use the storage's harness directly. It is opened here if no instance has
     * it; if another live instance does, this rejects with `HostedElsewhere`,
     * because a harness cannot be handed across processes. In a deployment of
     * several instances, put such code in an `operations` entry and `call()` it.
     */
    with<T>(key: string, use: (harness: any) => T | Promise<T>): Promise<T>;
    /** The instance that holds the storage's lease now, if any. */
    owner(key: string): Promise<string | undefined>;
    /** Keys of this definition that this instance has open. */
    hosted(): Promise<string[]>;
    /**
     * Erase a storage: whichever instance runs it stops, and every record of it
     * is deleted. This is the unit of erasure: Pi Durable's entries are
     * immutable, and one conversation cannot be deleted from a storage.
     */
    destroy(key: string): Promise<void>;
}
export { ROOT_CONVERSATION_ID };
//# sourceMappingURL=durable.d.ts.map