export type DurableConversationOptions = {
    /** The definition's name on the server: `new Durable(name, ...)`. */
    host: string;
    /** The storage key. */
    key: string;
    /** Default: the root conversation. */
    conversationId?: number;
    /** How many of the newest entries to receive. Default 200. */
    history?: number;
};
type Input = string | ({
    type: 'text';
    text: string;
} | {
    type: 'image';
    data: string;
    mimeType: string;
})[];
/**
 * A live view of one conversation, and the way to speak to it.
 *
 * ```ts
 * const chat = new DurableConversation({ host: 'missions', key: missionId });
 * Tracker.autorun(() => {
 *   render(chat.entries(), chat.streamingText(), chat.busy());
 * });
 * await chat.submit('Why did the deploy fail?');
 * ```
 *
 * Every read is reactive. Entries are immutable, so each is parsed once. A
 * document is rebuilt from its rows as they arrive: a base is its whole value,
 * a delta is a few Chord operations on the value before it. That is how a
 * streamed answer costs one small row per update, whatever its length.
 */
export declare class DurableConversation {
    readonly host: string;
    readonly key: string;
    readonly conversationId: number;
    private readonly storage;
    private handle;
    private observer;
    private readonly records;
    private readonly documents;
    private readonly dependencies;
    private window;
    constructor(options: DurableConversationOptions);
    /** Whether everything the conversation had when the subscription began has arrived. Reactive. */
    ready(): boolean;
    /** Receive the newest `count` entries from now on; for a "show earlier" control. */
    history(count: number): void;
    /** Stop watching. Idempotent. */
    stop(): void;
    /**
     * The entries this conversation can see, oldest first, as Pi Durable
     * records: `{ id, conversationId, kind, model?, data?, head? }`. A fork sees
     * its ancestors' entries up to where it left them. Reactive.
     */
    entries(): any[];
    /**
     * The entries of the active context: from the newest reset or compaction
     * on. Everything before it is history the model no longer sees. Reactive.
     */
    active(): any[];
    /**
     * The present value of one of the conversation's documents, by kind, and by
     * key for a member of a document family. Undefined until it arrives, and
     * for a kind the definition does not publish. Reactive.
     */
    document(kind: string, familyKey?: string): any;
    /** `pi.live`: the run in progress, the answer being generated, and the current round of tool calls. Reactive. */
    live(): any;
    /** `pi.inbox`: submissions waiting for a turn boundary. Reactive. */
    inbox(): any;
    /** `pi.usage`: tokens and cost by model and by tool. Reactive. */
    usage(): any;
    /** Whether a run is working on an input. Reactive. */
    busy(): boolean;
    /** The assistant message being generated, as far as it has been committed, or undefined. Reactive. */
    streaming(): any;
    /** The text of the answer being generated, or `''`. Reactive. */
    streamingText(): string;
    /** The current round of tool calls: name, status, running output. Reactive. */
    tools(): any[];
    /**
     * Hand input to the conversation. It resolves once the server has durably
     * admitted it. While a run is working, `whenBusy` decides what happens:
     * `followUp` (the default) queues it for after the answer, `steer` adds it
     * to the work in progress, `reject` fails with `conversation-busy`. The
     * request ID makes a retry after a lost connection admit it only once.
     */
    submit(content: Input, options?: {
        whenBusy?: 'steer' | 'followUp' | 'reject';
        requestId?: string;
    }): Promise<{
        submissionId: number;
    }>;
    /** Stop the current work. `idle` is whether it had stopped when the server answered. */
    abort(): Promise<{
        idle: boolean;
    }>;
    /** Withdraw a queued submission. */
    withdraw(submissionId: number): Promise<'aborted' | 'already_placed' | 'settled' | 'not_found'>;
    /** Start a new context, optionally from a handoff note. Older entries stay. */
    reset(handoff?: string): Promise<void>;
    /** Summarize older entries now. */
    compact(instructions?: string): Promise<void>;
    /** Fork this conversation at an entry. Resolves with the new conversation's ID. */
    fork(at: number): Promise<number>;
    /** The root conversation of a storage, created on first use. Resolves with its ID. */
    static root(host: string, key: string): Promise<number>;
    /** A new conversation in a storage. Resolves with its ID. */
    static create(host: string, key: string): Promise<number>;
    private target;
    private subscribe;
    /** This conversation and its fork ancestors, nearest first, each with the last of its entries visible from here. */
    private ancestry;
    private dependency;
    private observe;
    private rowAdded;
    private rowRemoved;
    /** Recompute a value from its rows: the newest base and every delta after it, in commit order. */
    private rebuild;
}
export {};
//# sourceMappingURL=conversation.d.ts.map