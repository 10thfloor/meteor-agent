import type { Context, JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationId, ConversationQuery, ConversationRecord, Cursor, DocumentAddress, DocumentId, DocumentPoint, DocumentQuery, DocumentRecord, EntryId, EntryQuery, EntryRecord, Id, Page, Seq, Storage, StorageWrite, StoredDocument, SubmissionId, SubmissionQuery, SubmissionRecord, TaskId, TaskQuery, TaskRecord } from "@earendil-works/pi-durable";
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
export type MongoClientLike = {
    startSession(): unknown;
};
export type MongoDbLike = {
    collection(name: string): unknown;
    /** Used for `killSessions` alone. Without it an unfinished commit ends when the server's own limit ends it. */
    command?(command: Record<string, unknown>): Promise<unknown>;
};
/** The two run-time values this file needs from Pi Durable's own packages. */
export type MongoStorageRuntime = {
    /** `apply` from `@earendil-works/chord/delta`. */
    apply<T>(target: T | undefined, ops: readonly Op[]): T;
    /** `StorageRejected` from `@earendil-works/pi-durable`; the Session recognises it by identity. */
    StorageRejected: new (message: string, options?: ErrorOptions) => Error;
};
export type MongoStorageOptions = {
    /** Client that owns `db`. Commits are transactions, so it must be connected to a replica set. */
    readonly client: MongoClientLike;
    readonly db: MongoDbLike;
    /** Names one Pi Durable Session among those sharing the collections. */
    readonly key: string;
    /** Collection name prefix. Default `pi_durable_`. */
    readonly prefix?: string;
    /**
     * What a commit waits for before it resolves. Default `{ w: "majority" }`: journaled on a majority, so it survives
     * a failover. That wait is most of a commit's cost. `{ w: 1 }` resolves once the primary applied the transaction,
     * as Pi Durable's SQLite backend does with `synchronous = NORMAL`; a failover can then lose the newest commits.
     */
    readonly writeConcern?: Record<string, unknown>;
    /**
     * How long `open()` and `destroy()` wait for a commit that is in flight before they end it. A commit takes
     * milliseconds; one still unfinished after this belongs to an owner that stopped in the middle of it. Default 2000.
     */
    readonly commitGraceMs?: number;
    /**
     * How long `open()` and `destroy()` wait in all before they fail with `StorageBusy`. Default 120000, which is
     * longer than MongoDB keeps a transaction whose client is gone.
     */
    readonly busyTimeoutMs?: number;
    readonly runtime: MongoStorageRuntime;
};
/**
 * A commit reached a storage whose ownership another `open()` has since taken, or that has since been destroyed.
 * Fatal to the Session that held it.
 */
export declare class StorageOwnershipLost extends Error {
    readonly key: string;
    constructor(key: string);
}
/** `open()` or `destroy()` gave up waiting: something kept the storage's meta row for longer than `busyTimeoutMs`. */
export declare class StorageBusy extends Error {
    readonly key: string;
    constructor(key: string, waitedMs: number);
}
export declare const MONGO_SCHEMA_VERSION = 1;
/** MongoDB implementation of the Pi Durable storage contract. */
export declare class MongoStorage implements Storage {
    private readonly client;
    private readonly db;
    private readonly c;
    private readonly key;
    /** The epoch this open took; `undefined` for a reader, which owns nothing and writes nothing. */
    private readonly epoch;
    /** Which storage of this key the epoch was taken in; see `MetaRow`. */
    private readonly life;
    private readonly runtime;
    private readonly writeConcern;
    /** The one session every commit of this owner runs in, which the meta row names. `undefined` for a reader. */
    private readonly session;
    /** Commits take turns: they share the session, and two at once would only make one of them start over. */
    private committing;
    private nextId;
    private closed;
    private readonly conversationJson;
    private lastClusterTime;
    private lastOperationTime;
    private constructor();
    /**
     * Read the storage named `key` without owning it: every read of the contract, no commit, no ID. It takes no
     * epoch, so the owner is not disturbed, and it sees each commit as soon as the owner's `commit()` resolves. This
     * is how a server instance that does not host a storage answers questions about it.
     */
    static reader(options: Omit<MongoStorageOptions, "writeConcern">): Promise<MongoStorage>;
    /**
     * Open the storage named `key`, creating it when absent, and take its ownership from any earlier open. A commit
     * the earlier owner has in flight finishes first, or is ended after `commitGraceMs` (see `takeMeta`).
     */
    static open(options: MongoStorageOptions): Promise<MongoStorage>;
    /**
     * Remove every record of the storage named `key`. The storage must not be open anywhere; a storage that is,
     * through a mistake or a process that will not stop, loses its ownership first and can commit nothing more.
     */
    static destroy(options: Omit<MongoStorageOptions, "runtime">): Promise<void>;
    commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq>;
    private commitNow;
    mintId<I extends Id<string>>(): Promise<I>;
    conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined>;
    scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<ConversationRecord, Cursor>>;
    entry(id: EntryId, context: Context): Promise<{
        readonly entry: EntryRecord;
        readonly commitSeq: Seq;
    } | undefined>;
    entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{
        readonly entry: EntryRecord;
        readonly commitSeq: Seq;
    } | undefined>;
    findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, _context: Context): Promise<(EntryRecord & {
        readonly head: EntryId;
    }) | undefined>;
    scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<EntryRecord, Cursor>>;
    task(id: TaskId, _context: Context): Promise<StoredTask | undefined>;
    scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<StoredTask, Cursor>>;
    submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined>;
    scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<SubmissionRecord, Cursor>>;
    submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context): Promise<SubmissionRecord | undefined>;
    findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined>;
    document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined>;
    scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<DocumentRecord, Cursor>>;
    /** Reject every later operation. The client belongs to the host and stays open. */
    close(_context: Context): Promise<void>;
    private rowId;
    private readConversation;
    private materializeDocument;
    private candidateNextId;
    private checkGlobalIds;
    private prepareDocumentActions;
    /** Validate the batch's document commands against stored state, and return the incarnations it found. */
    private checkDocumentActions;
    private applyWrites;
    private assertOpen;
    private assertOwner;
}
export {};
//# sourceMappingURL=mongo-storage.d.ts.map