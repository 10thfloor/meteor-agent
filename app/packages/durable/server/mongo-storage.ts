// A MongoDB backend for the Pi Durable storage contract (spec section 10).
//
// It follows the package's own SQLite backend table for table: one Mongo
// transaction is one Session commit, records are stored as JSON text beside
// the few columns the contract's scans need, and documents are bases plus
// ordered Chord delta tails.
//
// Two things are Mongo's own:
//
// - Many Pi Durable Sessions share one set of collections. Every row carries
//   the storage `key`, and every index starts with it.
// - Ownership is enforced, not assumed. The contract says one process owns a
//   storage at a time. Opening a key takes its `epoch`; every commit checks
//   that epoch inside its transaction, so an owner that was replaced cannot
//   write again. Who may open a key, and when, is the host's decision (a
//   lease); this file only makes a stale owner harmless.
//
// Nothing here is imported at run time. The driver, Chord's `apply`, and Pi
// Durable's `StorageRejected` are passed in, so the file loads the same way
// under plain Node and inside a Meteor server, whose bundler cannot follow
// the `exports` maps of those packages.
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type {
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Page,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "@earendil-works/pi-durable";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};
/** A document incarnation as stored before the batch: its record and the version of its newest revision. */
type StoredIncarnation = { readonly record: DocumentRecord; readonly version: number };

/** One storage's allocation state and owner. `_id` is the storage key. */
type MetaRow = { _id: string; nextId: number; nextSeq: number; schema: number; epoch: number };
/** The one global ID namespace of a storage: which table owns each ID. */
type IdRow = { _id: string; s: string; t: TableName };
type ConversationRow = { _id: string; s: string; id: number; oc: number | null; ot: number | null; r: string };
/** `h` is present only on an entry that carries a head, which is what the partial `heads` index selects. */
type EntryRow = { _id: string; s: string; id: number; c: number; h?: number; q: number; k: string; r: string };
type TaskRow = { _id: string; s: string; id: number; c: number; k: string; st: string; a: boolean; b: boolean; r: string };
type SubmissionRow = { _id: string; s: string; id: number; c: number; q: string | null; st: string; r: string };
type DocumentRow = {
	_id: string;
	s: string;
	id: number;
	k: string;
	f: 0 | 1;
	kv: string;
	sk: DocumentRecord["scope"]["kind"];
	o: number;
	ca: number;
	ra: number | null;
	/** Definition version of the newest stored revision: what a delta must match, without reading the revisions. */
	v: number;
	r: string;
};
type RevisionRow = { _id: string; s: string; d: number; q: number; t: DocumentContent["kind"]; v: number; c: string };

// The part of the MongoDB Node driver (6.x) this file calls, stated structurally: a Meteor server passes the client
// it already holds, and a plain Node host passes its own, without this file naming a driver version.
type Filter = Record<string, unknown>;
type Session = {
	withTransaction<T>(run: () => Promise<T>, options?: Record<string, unknown>): Promise<T>;
	endSession(): Promise<unknown>;
	readonly clusterTime?: unknown;
	readonly operationTime?: unknown;
	advanceClusterTime(clusterTime: never): void;
	advanceOperationTime(operationTime: never): void;
};
type Rows<Row> = {
	find(filter: Filter, options?: Record<string, unknown>): {
		sort(order: Record<string, 1 | -1>): { limit(count: number): { toArray(): Promise<Row[]> }; toArray(): Promise<Row[]> };
		toArray(): Promise<Row[]>;
	};
	findOne(filter: Filter, options?: Record<string, unknown>): Promise<Row | null>;
	findOneAndUpdate(filter: Filter, update: Record<string, unknown>, options: Record<string, unknown>): Promise<Row | null>;
	insertOne(row: Row, options?: Record<string, unknown>): Promise<unknown>;
	updateOne(filter: Filter, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
	deleteOne(filter: Filter, options?: Record<string, unknown>): Promise<unknown>;
	deleteMany(filter: Filter, options?: Record<string, unknown>): Promise<unknown>;
	bulkWrite(operations: Record<string, unknown>[], options?: Record<string, unknown>): Promise<unknown>;
	createIndexes(specs: Record<string, unknown>[]): Promise<unknown>;
};
export type MongoClientLike = { startSession(): unknown };
export type MongoDbLike = { collection(name: string): unknown };

type Collections = {
	readonly meta: Rows<MetaRow>;
	readonly ids: Rows<IdRow>;
	readonly conversations: Rows<ConversationRow>;
	readonly entries: Rows<EntryRow>;
	readonly tasks: Rows<TaskRow>;
	readonly submissions: Rows<SubmissionRow>;
	readonly documents: Rows<DocumentRow>;
	readonly revisions: Rows<RevisionRow>;
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
	readonly runtime: MongoStorageRuntime;
};

/** A commit reached a storage whose ownership another `open()` has since taken. Fatal to the Session that held it. */
export class StorageOwnershipLost extends Error {
	readonly key: string;

	constructor(key: string) {
		super(`Storage ${JSON.stringify(key)} is owned by a later open; this owner can no longer commit`);
		this.name = "StorageOwnershipLost";
		this.key = key;
	}
}

export const MONGO_SCHEMA_VERSION = 1;
const DEFAULT_PREFIX = "pi_durable_";

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value) as string;
// BSON strings are UTF-8, which cannot carry a lone UTF-16 surrogate. JSON text escapes it, so indexed identities
// stay lossless.
const encodeIndexedString = (value: string): string => JSON.stringify(value);

const cursorId = (cursor: Cursor | undefined): number | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
	return after;
};

const page = <T extends { readonly id: Id<string> }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: { after: items[items.length - 1]!.id } };
};

const scopeColumns = (scope: DocumentRecord["scope"]): { sk: DocumentRecord["scope"]["kind"]; o: number } => {
	switch (scope.kind) {
		case "session":
			return { sk: "session", o: 0 };
		case "conversation":
			return { sk: "conversation", o: scope.conversationId };
		case "task":
			return { sk: "task", o: scope.taskId };
	}
};

const addressColumns = (address: DocumentAddress | DocumentCreate | DocumentRecord) => ({
	k: encodeIndexedString(address.kind),
	...scopeColumns(address.scope),
	f: (address.key === undefined ? 0 : 1) as 0 | 1,
	kv: encodeIndexedString(address.key ?? ""),
});

const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
	const columns = addressColumns(address);
	return JSON.stringify([columns.k, columns.sk, columns.o, columns.f, columns.kv]);
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const aliveAtFilter = (at: DocumentPoint): Filter =>
	at === "current" ? { ra: null } : { ca: { $lte: at }, $or: [{ ra: null }, { ra: { $gt: at } }] };

const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

const writeId = (write: StorageWrite): number | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

/** A failure of the driver or server, as opposed to a contract violation this file detected. */
const isDriverError = (error: unknown): boolean =>
	error instanceof Error && (error.name.startsWith("Mongo") || "errorLabels" in error);

const indexed = new WeakMap<object, Map<string, Promise<void>>>();

/** Create the collections and their indexes once per database and prefix. Transactions need both to exist first. */
function ensureIndexes(db: MongoDbLike, prefix: string, collections: Collections): Promise<void> {
	let byPrefix = indexed.get(db);
	if (byPrefix === undefined) {
		byPrefix = new Map();
		indexed.set(db, byPrefix);
	}
	const known = byPrefix;
	let pending = known.get(prefix);
	if (pending === undefined) {
		pending = (async () => {
			// The ID order of every scan, and the uniqueness of an ID within its table.
			const byId = { key: { s: 1, id: 1 }, unique: true };
			await Promise.all([
				collections.ids.createIndexes([{ key: { s: 1 } }]),
				collections.conversations.createIndexes([
					byId,
					{ key: { s: 1, oc: 1, id: 1 } },
					{ key: { s: 1, ot: 1, id: 1 } },
				]),
				collections.entries.createIndexes([
					byId,
					{ key: { s: 1, c: 1, id: -1 } },
					{ key: { s: 1, c: 1, id: -1 }, name: "heads", partialFilterExpression: { h: { $exists: true } } },
				]),
				collections.tasks.createIndexes([
					byId,
					{ key: { s: 1, st: 1, id: 1 } },
					{ key: { s: 1, c: 1, id: 1 } },
					{ key: { s: 1, k: 1, id: 1 } },
					{ key: { s: 1, a: 1, id: 1 } },
					{ key: { s: 1, b: 1, id: 1 } },
				]),
				collections.submissions.createIndexes([
					byId,
					{ key: { s: 1, c: 1, q: 1 } },
					{ key: { s: 1, c: 1, id: 1 } },
					{ key: { s: 1, st: 1, id: 1 } },
				]),
				collections.documents.createIndexes([
					byId,
					{ key: { s: 1, k: 1, sk: 1, o: 1, f: 1, kv: 1, ca: -1 } },
					{ key: { s: 1, sk: 1, o: 1, id: 1 } },
					{ key: { s: 1, sk: 1, o: 1, k: 1, id: 1 } },
				]),
				collections.revisions.createIndexes([
					{ key: { s: 1, d: 1, q: 1 }, unique: true },
					{ key: { s: 1, d: 1, t: 1, q: -1 } },
				]),
			]);
		})();
		known.set(prefix, pending);
		pending.catch(() => known.delete(prefix));
	}
	return pending;
}

function collectionsOf(db: MongoDbLike, prefix: string): Collections {
	const rows = <Row>(name: string) => db.collection(`${prefix}${name}`) as Rows<Row>;
	return {
		meta: rows<MetaRow>("meta"),
		ids: rows<IdRow>("ids"),
		conversations: rows<ConversationRow>("conversations"),
		entries: rows<EntryRow>("entries"),
		tasks: rows<TaskRow>("tasks"),
		submissions: rows<SubmissionRow>("submissions"),
		documents: rows<DocumentRow>("documents"),
		revisions: rows<RevisionRow>("revisions"),
	};
}

/** MongoDB implementation of the Pi Durable storage contract. */
export class MongoStorage implements Storage {
	private readonly client: MongoClientLike;
	private readonly c: Collections;
	private readonly key: string;
	private readonly epoch: number;
	private readonly runtime: MongoStorageRuntime;
	private readonly writeConcern: Record<string, unknown>;
	private nextId: number;
	private closed = false;
	// Conversations are immutable once committed, so their encoded records are cached for ancestry walks.
	private readonly conversationJson = new Map<number, string>();
	// A read that spans several queries starts no earlier than the newest commit this storage acknowledged.
	private lastClusterTime: unknown;
	private lastOperationTime: unknown;

	private constructor(options: MongoStorageOptions, collections: Collections, meta: MetaRow) {
		this.client = options.client;
		this.c = collections;
		this.key = options.key;
		this.runtime = options.runtime;
		this.writeConcern = options.writeConcern ?? { w: "majority" };
		this.epoch = meta.epoch;
		this.nextId = meta.nextId;
	}

	/** Open the storage named `key`, creating it when absent, and take its ownership from any earlier open. */
	static async open(options: MongoStorageOptions): Promise<MongoStorage> {
		const prefix = options.prefix ?? DEFAULT_PREFIX;
		const collections = collectionsOf(options.db, prefix);
		await ensureIndexes(options.db, prefix, collections);
		const take = () =>
			collections.meta.findOneAndUpdate(
				{ _id: options.key },
				{ $setOnInsert: { nextId: 2, nextSeq: 1, schema: MONGO_SCHEMA_VERSION }, $inc: { epoch: 1 } },
				{ upsert: true, returnDocument: "after", writeConcern: { w: "majority" } },
			);
		// Two first opens of one key can both try to insert it; the loser finds the row on its second try.
		const meta = await take().catch((error: unknown) => {
			if ((error as { code?: number }).code === 11000) return take();
			throw error;
		});
		if (meta === null) throw new Error("Durable Mongo metadata is missing");
		if (meta.schema > MONGO_SCHEMA_VERSION) {
			throw new Error(
				`Durable Mongo schema version ${meta.schema} is newer than supported version ${MONGO_SCHEMA_VERSION}`,
			);
		}
		if (!Number.isSafeInteger(meta.nextSeq) || typeof meta.nextId !== "number") {
			throw new Error("Durable Mongo metadata is corrupt");
		}
		return new MongoStorage(options, collections, meta);
	}

	/** Remove every record of the storage named `key`. The storage must not be open anywhere. */
	static async destroy(options: Omit<MongoStorageOptions, "runtime">): Promise<void> {
		const collections = collectionsOf(options.db, options.prefix ?? DEFAULT_PREFIX);
		const mine = { s: options.key };
		await Promise.all([
			collections.ids.deleteMany(mine),
			collections.conversations.deleteMany(mine),
			collections.entries.deleteMany(mine),
			collections.tasks.deleteMany(mine),
			collections.submissions.deleteMany(mine),
			collections.documents.deleteMany(mine),
			collections.revisions.deleteMany(mine),
		]);
		await collections.meta.deleteOne({ _id: options.key });
	}

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const documentActions = this.prepareDocumentActions(writes);
		const candidateNextId = this.candidateNextId(writes);
		const session = this.client.startSession() as Session;
		let seq = 0;
		try {
			// The callback may run more than once: the driver retries a transaction the server reports as transient.
			await session.withTransaction(
				async () => {
					// Allocating the sequence is also the ownership check, and makes two commits to one storage conflict.
					const meta = await this.c.meta.findOneAndUpdate(
						{ _id: this.key, epoch: this.epoch },
						{ $inc: { nextSeq: 1 }, $max: { nextId: candidateNextId } },
						{ session, returnDocument: "before" },
					);
					if (meta === null) throw new StorageOwnershipLost(this.key);
					seq = meta.nextSeq;
					// Every read of the batch comes first, then one ordered bulk write per collection it touches.
					await this.checkGlobalIds(session, writes);
					const existing = await this.checkDocumentActions(session, documentActions);
					await this.applyWrites(session, writes, documentActions, existing, seq);
				},
				{ readConcern: { level: "snapshot" }, writeConcern: this.writeConcern, readPreference: "primary" },
			);
			this.lastClusterTime = session.clusterTime;
			this.lastOperationTime = session.operationTime;
		} finally {
			await session.endSession();
		}
		this.nextId = Math.max(this.nextId, candidateNextId);
		return seq as Seq;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++ as I;
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		return this.readConversation(id);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const filter: Filter = { s: this.key, id: { $gt: cursorId(cursor) ?? -1 } };
		if (query.ownerConversationId !== undefined) filter.oc = query.ownerConversationId;
		if (query.ownerTaskId !== undefined) filter.ot = query.ownerTaskId;
		const rows = await this.c.conversations
			.find(filter, { projection: { r: 1 } })
			.sort({ id: 1 })
			.limit(limit + 1)
			.toArray();
		return page(
			rows.map((row) => parseJson<ConversationRecord>(row.r)),
			limit,
		);
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	async entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		this.assertOpen();
		const id = context === undefined ? idOrConversationId : typeof idOrContext === "number" ? idOrContext : undefined;
		if (id === undefined) throw new TypeError("Storage.entry() requires an entry ID");
		let conversation: ConversationRecord | undefined;
		if (context !== undefined) {
			conversation = await this.readConversation(idOrConversationId);
			if (conversation === undefined) throw new Error(`Unknown conversation: ${idOrConversationId}`);
		}
		const row = await this.c.entries.findOne({ _id: this.rowId(id) }, { projection: { r: 1, q: 1 } });
		if (row === null) return undefined;
		const entry = parseJson<EntryRecord>(row.r);
		if (conversation !== undefined) {
			// Visible only through the ancestry: every fork point above the entry's own conversation caps it.
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				conversation = (await this.readConversation(conversation.parent.conversationId))!;
			}
			if (entry.id > upperEntryId) return undefined;
		}
		return { entry, commitSeq: row.q as Seq };
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		this.assertOpen();
		let conversation = await this.readConversation(conversationId);
		if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			const filter: Filter = { s: this.key, c: conversation.id, h: { $exists: true } };
			if (upper !== undefined) filter.id = { $lte: upper };
			const rows = await this.c.entries.find(filter, { projection: { r: 1 } }).sort({ id: -1 }).limit(1).toArray();
			if (rows.length > 0) return parseJson<EntryRecord & { readonly head: EntryId }>(rows[0]!.r);
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
	}

	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new Error(`Unknown conversation: ${query.conversationId}`);
		const after = cursorId(cursor);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const values: EntryRecord[] = [];
		while (true) {
			const range: { $gte?: number; $lte?: number } = {};
			if (query.minEntryId !== undefined) range.$gte = query.minEntryId;
			if (upper !== undefined) range.$lte = upper;
			const filter: Filter = { s: this.key, c: conversation.id };
			if (range.$gte !== undefined || range.$lte !== undefined) filter.id = range;
			const rows = await this.c.entries
				.find(filter, { projection: { r: 1 } })
				.sort({ id: -1 })
				.limit(limit + 1 - values.length)
				.toArray();
			for (const row of rows) values.push(parseJson<EntryRecord>(row.r));
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		return page(values, limit);
	}

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const row = await this.c.tasks.findOne({ _id: this.rowId(id) }, { projection: { r: 1 } });
		return row === null ? undefined : parseJson<StoredTask>(row.r);
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const filter: Filter = { s: this.key, id: { $gt: cursorId(cursor) ?? -1 } };
		if (query.conversationId !== undefined) filter.c = query.conversationId;
		if (query.kind !== undefined) filter.k = encodeIndexedString(query.kind);
		if (query.status !== undefined) filter.st = query.status;
		if (query.abortRequested !== undefined) filter.a = query.abortRequested;
		if (query.background !== undefined) filter.b = query.background;
		const rows = await this.c.tasks
			.find(filter, { projection: { r: 1 } })
			.sort({ id: 1 })
			.limit(limit + 1)
			.toArray();
		return page(
			rows.map((row) => parseJson<StoredTask>(row.r)),
			limit,
		);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.c.submissions.findOne({ _id: this.rowId(id) }, { projection: { r: 1 } });
		return row === null ? undefined : parseJson<SubmissionRecord>(row.r);
	}

	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const filter: Filter = { s: this.key, id: { $gt: cursorId(cursor) ?? -1 } };
		if (query.conversationId !== undefined) filter.c = query.conversationId;
		if (query.status !== undefined) filter.st = query.status;
		const rows = await this.c.submissions
			.find(filter, { projection: { r: 1 } })
			.sort({ id: 1 })
			.limit(limit + 1)
			.toArray();
		return page(
			rows.map((row) => parseJson<SubmissionRecord>(row.r)),
			limit,
		);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.c.submissions.findOne(
			{ s: this.key, c: conversationId, q: encodeIndexedString(requestId) },
			{ projection: { r: 1 } },
		);
		return row === null ? undefined : parseJson<SubmissionRecord>(row.r);
	}

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const rows = await this.c.documents
			.find({ s: this.key, ...addressColumns(address), ...aliveAtFilter(at) }, { projection: { r: 1 } })
			.sort({ ca: -1 })
			.limit(1)
			.toArray();
		return rows.length === 0 ? undefined : parseJson<DocumentRecord>(rows[0]!.r);
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		// The record and its revisions must come from one committed state: a commit between the queries can replace
		// the base. A snapshot transaction that starts no earlier than this storage's newest commit gives that.
		const session = this.client.startSession() as Session;
		try {
			if (this.lastClusterTime !== undefined) session.advanceClusterTime(this.lastClusterTime as never);
			if (this.lastOperationTime !== undefined) session.advanceOperationTime(this.lastOperationTime as never);
			return await session.withTransaction(() => this.materializeDocument(session, id, at), {
				readConcern: { level: "snapshot" },
				readPreference: "primary",
			});
		} finally {
			await session.endSession();
		}
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const filter: Filter = {
			s: this.key,
			...scopeColumns(query.scope),
			id: { $gt: cursorId(cursor) ?? -1 },
			...aliveAtFilter(query.at),
		};
		if (query.kind !== undefined) filter.k = encodeIndexedString(query.kind);
		const rows = await this.c.documents
			.find(filter, { projection: { r: 1 } })
			.sort({ id: 1 })
			.limit(limit + 1)
			.toArray();
		return page(
			rows.map((row) => parseJson<DocumentRecord>(row.r)),
			limit,
		);
	}

	/** Reject every later operation. The client belongs to the host and stays open. */
	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	private rowId(id: number): string {
		return `${this.key}:${id}`;
	}

	private async readConversation(id: number): Promise<ConversationRecord | undefined> {
		let json = this.conversationJson.get(id);
		if (json === undefined) {
			const row = await this.c.conversations.findOne({ _id: this.rowId(id) }, { projection: { r: 1 } });
			if (row === null) return undefined;
			json = row.r;
			this.conversationJson.set(id, json);
		}
		return parseJson<ConversationRecord>(json);
	}

	private async materializeDocument(
		session: Session,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		const row = await this.c.documents.findOne({ _id: this.rowId(id) }, { projection: { r: 1 }, session });
		if (row === null) return undefined;
		const record = parseJson<DocumentRecord>(row.r);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new Error(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const bases = await this.c.revisions
			.find({ s: this.key, d: id, t: "base", q: { $lte: upper } }, { session })
			.sort({ q: -1 })
			.limit(1)
			.toArray();
		const base = bases[0];
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<JsonObject>(base.c);
		const tail = await this.c.revisions
			.find({ s: this.key, d: id, q: { $gt: base.q, $lte: upper } }, { session })
			.sort({ q: 1 })
			.toArray();
		for (const revision of tail) {
			if (revision.t !== "delta" || revision.v !== base.v) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = this.runtime.apply(value, parseJson<readonly Op[]>(revision.c));
		}
		return { record, version: base.v, value, deltasSinceBase: tail.length };
	}

	private candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.nextId;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	private async checkGlobalIds(session: Session, writes: readonly StorageWrite[]): Promise<void> {
		const ids = new Set<number>();
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) ids.add(id);
		}
		if (ids.size === 0) return;
		const owners = new Map<string, TableName>();
		const rows = await this.c.ids.find({ _id: { $in: [...ids].map((id) => this.rowId(id)) } }, { session }).toArray();
		for (const row of rows) owners.set(row._id, row.t);

		const claimed = new Map<number, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existing = owners.get(this.rowId(id));
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (
				write.type !== "document.create" &&
				write.type !== "document.copy" &&
				write.type !== "document.change" &&
				write.type !== "document.retire"
			) {
				continue;
			}
			const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.copy = write.source;
					break;
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	/** Validate the batch's document commands against stored state, and return the incarnations it found. */
	private async checkDocumentActions(
		session: Session,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<ReadonlyMap<number, StoredIncarnation>> {
		const existingById = new Map<number, StoredIncarnation>();
		if (actions.size === 0) return existingById;
		const existingRows = await this.c.documents
			.find(
				{ _id: { $in: [...actions.keys()].map((id) => this.rowId(id)) } },
				{ projection: { id: 1, r: 1, v: 1 }, session },
			)
			.toArray();
		for (const row of existingRows) {
			existingById.set(row.id, { record: parseJson<DocumentRecord>(row.r), version: row.v });
		}

		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new this.runtime.StorageRejected(`Document copy ${id} source is changed in the copy batch`);
			}
			const existing = existingById.get(id);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				if (existing === undefined) throw new Error(`Document ${id} delta has no base`);
				if (existing.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			// An ordinary change neither frees nor takes its address, so only creation and retirement count incarnations.
			if (action.create === undefined && !action.retire) continue;
			const record = action.create ?? existing!.record;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) {
				const current = await this.c.documents.findOne(
					{ s: this.key, ...addressColumns(record), ra: null },
					{ projection: { _id: 1 }, session },
				);
				live = current === null ? 0 : 1;
			}
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
		return existingById;
	}

	private async applyWrites(
		session: Session,
		writes: readonly StorageWrite[],
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		existingDocuments: ReadonlyMap<number, StoredIncarnation>,
		seq: number,
	): Promise<void> {
		const s = this.key;
		const ids: Record<string, unknown>[] = [];
		const conversations: Record<string, unknown>[] = [];
		const entries: Record<string, unknown>[] = [];
		const tasks: Record<string, unknown>[] = [];
		const submissions: Record<string, unknown>[] = [];
		const documents: Record<string, unknown>[] = [];
		const revisions: Record<string, unknown>[] = [];
		const claim = (id: number, t: TableName) => {
			ids.push({ updateOne: { filter: { _id: this.rowId(id) }, update: { $setOnInsert: { s, t } }, upsert: true } });
		};
		for (const write of writes) {
			switch (write.type) {
				case "conversation": {
					const value = write.value;
					claim(value.id, "conversation");
					const row: ConversationRow = {
						_id: this.rowId(value.id),
						s,
						id: value.id,
						oc: value.owner?.conversationId ?? null,
						ot: value.owner?.taskId ?? null,
						r: encodeJson(value),
					};
					conversations.push({ insertOne: { document: row } });
					break;
				}
				case "entry": {
					const value = write.value;
					claim(value.id, "entry");
					const row: EntryRow = {
						_id: this.rowId(value.id),
						s,
						id: value.id,
						c: value.conversationId,
						...(value.head === undefined ? {} : { h: value.head }),
						q: seq,
						k: encodeIndexedString(value.kind),
						r: encodeJson(value),
					};
					entries.push({ insertOne: { document: row } });
					break;
				}
				case "task": {
					const value = write.value;
					claim(value.id, "task");
					const row: Omit<TaskRow, "_id"> = {
						s,
						id: value.id,
						c: value.conversationId,
						k: encodeIndexedString(value.kind),
						st: value.state.status,
						a: value.abortRequested,
						b: value.background,
						r: encodeJson(value),
					};
					tasks.push({ replaceOne: { filter: { _id: this.rowId(value.id) }, replacement: row, upsert: true } });
					break;
				}
				case "submission": {
					const value = write.value;
					claim(value.id, "submission");
					const row: Omit<SubmissionRow, "_id"> = {
						s,
						id: value.id,
						c: value.conversationId,
						q: value.requestId === undefined ? null : encodeIndexedString(value.requestId),
						st: value.status,
						r: encodeJson(value),
					};
					submissions.push({ replaceOne: { filter: { _id: this.rowId(value.id) }, replacement: row, upsert: true } });
					break;
				}
				case "document.create":
				case "document.copy":
				case "document.change":
				case "document.retire":
					break;
			}
		}
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				// Read inside the transaction: the batch may not touch its copy sources, so this is their state before it.
				try {
					const stored = await this.materializeDocument(session, action.copy.id, action.copy.at);
					if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create!;
					if (
						stored.record.scope.kind !== "conversation" ||
						create.scope.kind !== "conversation" ||
						stored.record.kind !== create.kind ||
						stored.record.key !== create.key ||
						stored.record.history !== create.history ||
						stored.record.fork !== create.fork
					) {
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					}
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (error) {
					// A driver failure must reach the transaction untouched, so that a transient one is retried.
					if (error instanceof this.runtime.StorageRejected || isDriverError(error)) throw error;
					throw new this.runtime.StorageRejected(`Document copy ${id} was rejected`, { cause: error });
				}
			}

			const existing = existingDocuments.get(id);
			let record: DocumentRecord;
			if (action.create !== undefined) {
				record = {
					...action.create,
					createdAt: seq as Seq,
					...(action.retire ? { retiredAt: seq as Seq } : {}),
				} as DocumentRecord;
				claim(id, "document");
				const row: DocumentRow = {
					_id: this.rowId(id),
					s,
					id,
					...addressColumns(record),
					ca: seq,
					ra: action.retire ? seq : null,
					// A created document always carries its first base, given or copied.
					v: content!.version,
					r: encodeJson(record),
				};
				documents.push({ insertOne: { document: row } });
			} else {
				record = existing!.record;
			}

			if (content !== undefined) {
				// A current-only document needs nothing older than its newest base.
				if (content.kind === "base" && isCurrentOnly(record)) {
					revisions.push({ deleteMany: { filter: { s, d: id } } });
				}
				const row: RevisionRow = {
					_id: `${s}:${id}:${seq}`,
					s,
					d: id,
					q: seq,
					t: content.kind,
					v: content.version,
					c: content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops),
				};
				revisions.push({ insertOne: { document: row } });
				if (existing !== undefined && existing.version !== content.version) {
					documents.push({ updateOne: { filter: { _id: this.rowId(id) }, update: { $set: { v: content.version } } } });
				}
			}

			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq as Seq };
					documents.push({
						updateOne: { filter: { _id: this.rowId(id) }, update: { $set: { ra: seq, r: encodeJson(record) } } },
					});
				}
				if (isCurrentOnly(record)) revisions.push({ deleteMany: { filter: { s, d: id } } });
			}
		}

		// One statement at a time: a session carries one operation at once. Within a collection the order is the
		// order above, which is what makes a base replace the revisions before it and a retirement clear them after.
		if (ids.length > 0) await this.c.ids.bulkWrite(ids, { session, ordered: true });
		if (conversations.length > 0) await this.c.conversations.bulkWrite(conversations, { session, ordered: true });
		if (entries.length > 0) await this.c.entries.bulkWrite(entries, { session, ordered: true });
		if (tasks.length > 0) await this.c.tasks.bulkWrite(tasks, { session, ordered: true });
		if (submissions.length > 0) await this.c.submissions.bulkWrite(submissions, { session, ordered: true });
		if (documents.length > 0) await this.c.documents.bulkWrite(documents, { session, ordered: true });
		if (revisions.length > 0) await this.c.revisions.bulkWrite(revisions, { session, ordered: true });
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MongoStorage is closed");
	}
}
