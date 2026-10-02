// Who runs a storage, and how work reaches whoever does.
//
// Pi Durable has one rule about processes: one of them owns a storage at a
// time. It leaves the "which one" to its host. A Meteor deployment is several
// server instances behind one database, so this file answers three things:
//
// - Hosting. An instance takes a lease on a storage key, opens the storage
//   (which takes its epoch, see mongo-storage.ts) and a harness over it, and
//   keeps the lease alive while there is work. An instance that stops, or
//   stops answering, loses the lease, and the next instance to look resumes
//   the work from storage. The lease is about liveness; safety is the epoch:
//   an instance that wakes up after losing its lease cannot commit.
// - Requests. Any instance may be asked to do something to any storage. If it
//   hosts the storage, or nobody does, it does the work itself. Otherwise it
//   writes a request row that the host consumes. A request carries its own ID
//   into the operation, so a retry or a takeover in between cannot do it twice
//   where the operation is idempotent on that ID, as `submit` is.
// - Reading. Everything committed is in Mongo, so any instance reads a storage
//   without hosting it.
//
// Like the storage, this file imports nothing at run time: the driver, the
// harness and the clock are passed in, so it runs under plain Node and inside
// a Meteor server alike.
import type { Context } from "@earendil-works/chord";
import type { Harness, HarnessOptions, SettledSubmissionRecord, Storage, SubmissionId } from "@earendil-works/pi-durable";
import {
	type MongoClientLike,
	type MongoDbLike,
	MongoStorage,
	type MongoStorageRuntime,
	StorageOwnershipLost,
} from "./mongo-storage";

/**
 * One lease per hosted storage. `until` is written and compared on the database's clock, never an instance's. `owner`
 * is the instance's name and `inc` the process run that holds the lease: a process renews and releases only what its
 * own run took, and takes what an earlier run of its name left only while it starts.
 */
type LeaseRow = { _id: string; owner: string; inc?: string; until: Date; since: Date };

/** Work addressed to whoever hosts storage `s`. `a` and `result` are JSON text. */
type RequestRow = {
	_id: string;
	s: string;
	op: string;
	a: string;
	at: Date;
	expires: Date;
	state: "pending" | "claimed" | "done" | "failed" | "expired";
	/** The incarnation that claimed it. */
	by?: string;
	result?: string;
	error?: { name: string; message: string };
};

type Filter = Record<string, unknown>;
type Cursor<Row> = {
	sort(order: Record<string, 1 | -1>): Cursor<Row>;
	limit(count: number): Cursor<Row>;
	toArray(): Promise<Row[]>;
};
type ChangeStream = {
	on(event: "change", listener: (change: { fullDocument?: unknown }) => void): unknown;
	on(event: "error", listener: (error: unknown) => void): unknown;
	close(): Promise<unknown>;
};
type Rows<Row> = {
	find(filter: Filter, options?: Record<string, unknown>): Cursor<Row>;
	findOne(filter: Filter, options?: Record<string, unknown>): Promise<Row | null>;
	findOneAndUpdate(filter: Filter, update: unknown, options: Record<string, unknown>): Promise<Row | null>;
	updateOne(
		filter: Filter,
		update: unknown,
		options?: Record<string, unknown>,
	): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }>;
	updateMany(filter: Filter, update: unknown, options?: Record<string, unknown>): Promise<{ matchedCount: number; modifiedCount: number }>;
	deleteOne(filter: Filter, options?: Record<string, unknown>): Promise<unknown>;
	deleteMany(filter: Filter, options?: Record<string, unknown>): Promise<unknown>;
	createIndexes(specs: Record<string, unknown>[]): Promise<unknown>;
	watch(pipeline: Record<string, unknown>[], options?: Record<string, unknown>): ChangeStream;
};

/** What an operation is given: the harness of the storage it was addressed to, on the instance that hosts it. */
export type OperationScope = {
	readonly harness: Harness;
	readonly key: string;
	/** Unique to the request, and the same on every attempt at it. Pass it on wherever a retry must not repeat. */
	readonly requestId: string;
	readonly context: Context;
};

/**
 * Something that can be asked of a storage from any instance. Arguments and result are JSON. It runs at least once:
 * if the host dies after doing the work and before recording the result, the next host does it again with the same
 * `requestId`.
 */
export type Operation = (args: any, scope: OperationScope) => unknown | Promise<unknown>;

export type DurableHostOptions = {
	/** Client that owns `db`; it must be connected to a replica set. */
	readonly client: MongoClientLike;
	readonly db: MongoDbLike;
	/** Collection name prefix, shared with the storage. Default `pi_durable_`. */
	readonly prefix?: string;
	readonly runtime: MongoStorageRuntime;
	/** `Harness` from `@earendil-works/pi-durable`. */
	readonly Harness: { open(storage: Storage, options: HarnessOptions, context: Context): Promise<Harness> };
	/** A context that never cancels: `BACKGROUND_CONTEXT` from `@earendil-works/chord/context`. */
	readonly context: Context;
	/** What a harness over `key` runs with. Called on whichever instance hosts the key, at each open. */
	harness(key: string): HarnessOptions | Promise<HarnessOptions>;
	/** Whether this instance can host `key` at all. Default: every key. */
	accepts?(key: string): boolean;
	/** What `call()` can ask for, by name. */
	operations?(key: string): Readonly<Record<string, Operation>> | undefined;
	/**
	 * Names this instance among those sharing the database. Keep it stable across restarts of the same instance: a
	 * restarted process then resumes its own storages at once instead of waiting for its old lease to run out. Give
	 * every process that runs at the same time its own name: a process that starts takes over whatever is leased to
	 * its name, which is a running namesake's work too.
	 */
	readonly instanceId: string;
	/** Passed to every storage this host opens. */
	readonly writeConcern?: Record<string, unknown>;
	/** How long a lease lasts without renewal. Default 30 s. */
	readonly leaseMs?: number;
	/** How often leases are renewed. Default a third of `leaseMs`. */
	readonly heartbeatMs?: number;
	/** How often this instance looks for storages nobody is running. Default 5 s. */
	readonly sweepMs?: number;
	/** How long a storage with no live task stays open here. Default 30 s. */
	readonly idleMs?: number;
	/** How long a request may wait for a host. Default 30 s. */
	readonly requestMs?: number;
	/**
	 * How long a storage may take to close before it is left behind. A harness whose tool ignores its cancellation
	 * never closes; what is left of it in memory cannot commit once the storage is opened again. Default 3 s.
	 */
	readonly closeMs?: number;
	/** Told about failures that no caller is waiting on. Must not throw. */
	readonly onError?: (error: unknown, where: string) => void;
};

/** A storage is hosted by another live instance, and the caller asked for something only its host can do. */
export class HostedElsewhere extends Error {
	readonly key: string;
	readonly owner: string | undefined;

	constructor(key: string, owner: string | undefined) {
		super(`Storage ${JSON.stringify(key)} is hosted by another instance${owner === undefined ? "" : ` (${owner})`}`);
		this.name = "HostedElsewhere";
		this.key = key;
		this.owner = owner;
	}
}

/** No host took a request before it expired. The work was not done. */
export class RequestExpired extends Error {
	constructor(key: string, op: string) {
		super(`No host took ${op} for storage ${JSON.stringify(key)} in time`);
		this.name = "RequestExpired";
	}
}

type Hosted = {
	readonly key: string;
	readonly harness: Harness;
	/** IDs of the storage's live tasks, kept from the harness's own commit publications. */
	readonly live: Set<number>;
	/** Local calls in progress; the storage is not closed under them. */
	users: number;
	idle: ReturnType<typeof setTimeout> | undefined;
	/** Set once this harness can no longer be used: its storage was taken, or a commit left it in doubt. */
	gone: boolean;
};

type Slot =
	| { readonly state: "opening"; readonly promise: Promise<Hosted | Elsewhere> }
	| { readonly state: "open"; readonly hosted: Hosted }
	| { readonly state: "closing"; readonly promise: Promise<void> };

type Elsewhere = { readonly elsewhere: true; readonly owner: string | undefined };

const DEFAULT_PREFIX = "pi_durable_";
/** The one operation the host does itself: it needs the storage closed, which no operation can do from inside. */
const DESTROY = "$destroy";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isElsewhere = (value: Hosted | Elsewhere): value is Elsewhere => "elsewhere" in value;

/** Hosts Pi Durable storages on one server instance, in cooperation with the other instances on the database. */
export class DurableHost {
	readonly instanceId: string;
	/** This process's run of `instanceId`: what distinguishes it from the process that had the name before it. */
	private readonly incarnation: string;
	private readonly options: DurableHostOptions;
	private readonly leases: Rows<LeaseRow>;
	private readonly requests: Rows<RequestRow>;
	private readonly leaseMs: number;
	private readonly heartbeatMs: number;
	private readonly sweepMs: number;
	private readonly idleMs: number;
	private readonly requestMs: number;
	private readonly closeMs: number;
	private readonly slots = new Map<string, Slot>();
	private readonly readers = new Map<string, { readonly reader: Promise<MongoStorage>; readonly at: number }>();
	/** Storages being erased here; nothing reopens one until its erasure has finished. */
	private readonly erasing = new Map<string, Promise<void>>();
	/** Requests this host is executing or has just executed, so a row seen twice is done once. */
	private readonly consuming = new Set<string>();
	private readonly waiters = new Map<string, () => void>();
	/** Recent commit failures per storage, for the delay before it is reopened. */
	private readonly strikes = new Map<string, { count: number; at: number }>();
	private indexes: Promise<void> | undefined;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private sweeper: ReturnType<typeof setInterval> | undefined;
	private stream: ChangeStream | undefined;
	private renewedAt = 0;
	private running = false;
	/** Set by `stop()`: this host opens nothing any more, and what it is asked goes to the other instances. */
	private stopped = false;
	/** While this process takes up what the last run of its name left; see `adopt()`. */
	private adopting = false;
	private namesakeReported = false;

	constructor(options: DurableHostOptions) {
		this.options = options;
		this.instanceId = options.instanceId;
		this.incarnation = `${options.instanceId}#${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		const prefix = options.prefix ?? DEFAULT_PREFIX;
		this.leases = options.db.collection(`${prefix}leases`) as Rows<LeaseRow>;
		this.requests = options.db.collection(`${prefix}requests`) as Rows<RequestRow>;
		this.leaseMs = options.leaseMs ?? 30_000;
		this.heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
		this.sweepMs = options.sweepMs ?? 5_000;
		this.idleMs = options.idleMs ?? 30_000;
		this.requestMs = options.requestMs ?? 30_000;
		this.closeMs = options.closeMs ?? 3_000;
	}

	/** Begin renewing leases, consuming requests, and looking for storages nobody is running. Idempotent. */
	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.stopped = false;
		this.adopting = true;
		try {
			await this.ensureIndexes();
		} catch (error) {
			this.running = false;
			this.adopting = false;
			throw error;
		}
		this.renewedAt = Date.now();
		this.heartbeat = setInterval(() => void this.renew(), this.heartbeatMs);
		this.sweeper = setInterval(() => void this.sweep(), this.sweepMs);
		this.watchRequests();
		void this.adopt().then(() => this.sweep());
	}

	/**
	 * Take up what the last process with this instance's name was running. Its leases are still live, so no sweep
	 * would find them; they are this instance's by name, and opening each storage shuts the old process out. Until
	 * this has gone through them, any lease in this instance's name is taken as its own, so a call that arrives first
	 * does not wait behind the rest. Afterwards such a lease can only be a namesake's that is running now, and is
	 * left alone.
	 */
	private async adopt(): Promise<void> {
		try {
			const mine = await this.leases.find({ owner: this.instanceId }, { projection: { _id: 1 } }).toArray();
			for (const { _id: key } of mine) {
				if (!this.running) return;
				if (this.options.accepts?.(key) === false || this.slots.has(key)) continue;
				await this.host(key).catch((error) => this.report(error, `adopt ${key}`));
			}
		} catch (error) {
			this.report(error, "adopt");
		} finally {
			this.adopting = false;
		}
	}

	/**
	 * Stop hosting. Each harness is closed, which ends its running calls; a storage that still has live tasks keeps an
	 * expired lease, so another instance takes it at its next look rather than after a full lease. A stopped host
	 * opens nothing: what it is asked afterwards goes to the other instances by request, until `start()`.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		if (!this.running) return;
		this.running = false;
		this.stopTimers();
		await Promise.all(
			[...this.slots.keys()].map(async (key) => {
				const slot = this.slots.get(key);
				if (slot?.state === "opening") await slot.promise.catch(() => undefined);
				const hosted = this.open(key);
				if (hosted !== undefined) await this.close(hosted, hosted.live.size > 0 ? "handover" : "release");
				const closing = this.slots.get(key);
				if (closing?.state === "closing") await closing.promise;
			}),
		);
	}

	/**
	 * Stop as a process that died would: no close, no release, nothing written. For tests of takeover. The harnesses
	 * of this host stay in memory and cannot commit once another host opens their storages.
	 */
	abandon(): void {
		this.stopped = true;
		this.running = false;
		this.stopTimers();
		for (const key of [...this.slots.keys()]) {
			const hosted = this.open(key);
			if (hosted !== undefined) {
				hosted.gone = true;
				if (hosted.idle !== undefined) clearTimeout(hosted.idle);
			}
		}
		this.slots.clear();
	}

	/**
	 * Give up every lease this process holds, at once and without closing anything. For a process that has to exit
	 * and could not wait for `stop()`: a harness whose tool ignores its cancellation never closes. The next instance
	 * to look takes the storages that had work, and the epoch keeps whatever still runs here from committing.
	 */
	async surrender(): Promise<void> {
		this.stopped = true;
		this.running = false;
		this.stopTimers();
		const idle: string[] = [];
		for (const [key, slot] of this.slots) {
			if (slot.state !== "open") continue;
			slot.hosted.gone = true;
			if (slot.hosted.idle !== undefined) clearTimeout(slot.hosted.idle);
			if (slot.hosted.live.size === 0) idle.push(key);
		}
		const mine = { owner: this.instanceId, inc: this.incarnation };
		if (idle.length > 0) await this.leases.deleteMany({ _id: { $in: idle }, ...mine });
		await this.leases.updateMany(mine, [{ $set: { until: "$$NOW" } }]);
	}

	/**
	 * Stop hosting `key` on this instance, if it does. A storage with work left keeps an expired lease, so another
	 * instance takes it at its next look; an idle one's lease is given up.
	 */
	async release(key: string): Promise<void> {
		const hosted = this.open(key);
		if (hosted !== undefined) await this.close(hosted, hosted.live.size > 0 ? "handover" : "release");
	}

	/** Keys this instance has open. */
	hosted(): string[] {
		return [...this.slots].flatMap(([key, slot]) => (slot.state === "open" ? [key] : []));
	}

	/** The instance holding a live lease on `key`, if any. */
	async owner(key: string): Promise<string | undefined> {
		const row = await this.leases.findOne({ _id: key, $expr: { $gt: ["$until", "$$NOW"] } });
		return row?.owner;
	}

	/**
	 * Use the harness of `key` on this instance, hosting the storage here if nobody does. Rejects with
	 * `HostedElsewhere` when another live instance has it: a harness cannot be handed across processes. Code that
	 * must work from any instance goes through `call()`.
	 */
	async with<T>(key: string, use: (harness: Harness) => T | Promise<T>): Promise<T> {
		const hosted = await this.host(key);
		if (isElsewhere(hosted)) throw new HostedElsewhere(key, hosted.owner);
		return this.using(hosted, () => use(hosted.harness));
	}

	/**
	 * Run the operation `op` against the storage `key`, wherever it is hosted: here if this instance hosts it or
	 * nobody does, otherwise by request to its host. Resolves with the operation's result.
	 */
	async call<T = unknown>(key: string, op: string, args: unknown, options: { requestId?: string } = {}): Promise<T> {
		const requestId = options.requestId ?? `${this.incarnation}.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
		for (let attempt = 0; ; attempt++) {
			const hosted = await this.host(key);
			if (isElsewhere(hosted)) return (await this.request(key, op, args, requestId)) as T;
			try {
				return (await this.run(hosted, op, args, requestId)) as T;
			} catch (error) {
				// The harness went away under the operation: its storage was taken, or a commit left it in doubt. The
				// operation is asked again, of whoever hosts the storage now, with the same request ID.
				if (!hosted.gone || op === DESTROY || attempt > 0) throw error;
			}
		}
	}

	/**
	 * Erase the storage `key`: whichever instance runs it stops, and every record of it is deleted. What its tasks
	 * were doing is abandoned, not undone. A key that was erased should not be used again while other instances may
	 * still hold what they read of it.
	 */
	async destroy(key: string): Promise<void> {
		await this.call(key, DESTROY, null);
	}

	/**
	 * A read-only view of the storage `key`: every read of the storage contract, with no ownership. Works on any
	 * instance, whether or not the storage is open anywhere.
	 */
	reader(key: string): Promise<MongoStorage> {
		const known = this.readers.get(key);
		// A reader caches conversation records, which never change while a storage lives. A minute bounds what an
		// instance can remember of a storage that was erased elsewhere.
		if (known !== undefined && Date.now() - known.at < 60_000) return known.reader;
		this.readers.delete(key);
		const { client, db, prefix, runtime } = this.options;
		const reader = MongoStorage.reader({ client, db, key, runtime, ...(prefix === undefined ? {} : { prefix }) });
		this.readers.set(key, { reader, at: Date.now() });
		reader.catch(() => this.readers.delete(key));
		if (this.readers.size > 1000) this.readers.delete(this.readers.keys().next().value as string);
		return reader;
	}

	/**
	 * Resolve once the submission is answered or has failed, from any instance. It reads the committed record, so it
	 * does not depend on which instance runs the work, or on that instance surviving.
	 */
	async settled(key: string, id: SubmissionId, options: { timeoutMs?: number } = {}): Promise<SettledSubmissionRecord> {
		const reader = await this.reader(key);
		const deadline = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
		for (let wait = 25; ; wait = Math.min(wait * 2, 250)) {
			const record = await reader.submission(id, this.options.context);
			if (record === undefined) throw new Error(`Submission ${id} does not exist in storage ${JSON.stringify(key)}`);
			if (record.status === "done" || record.status === "unanswered") return record;
			if (Date.now() >= deadline) throw new Error(`Submission ${id} did not settle in time`);
			await sleep(wait);
		}
	}

	// ── Hosting ────────────────────────────────────────────────────────────────

	private open(key: string): Hosted | undefined {
		const slot = this.slots.get(key);
		return slot?.state === "open" ? slot.hosted : undefined;
	}

	/**
	 * The harness of `key` on this instance, opening it here when no live instance holds it. One flight per key.
	 * `requests` is for a caller that is here only because it heard of a waiting request, possibly a while ago: it
	 * opens a storage that has no lease only if a request is still waiting for it. Otherwise a late notice of a
	 * request that has since been done, an erasure included, would create the storage afresh.
	 */
	private async host(key: string, need: "use" | "requests" = "use"): Promise<Hosted | Elsewhere> {
		// A host that was told to stop opens nothing more: it would take a lease and leave with it.
		if (this.stopped) return { elsewhere: true, owner: await this.owner(key) };
		for (;;) {
			const erasing = this.erasing.get(key);
			if (erasing !== undefined) {
				await erasing.catch(() => undefined);
				continue;
			}
			const slot = this.slots.get(key);
			if (slot === undefined) break;
			if (slot.state === "open") return slot.hosted;
			if (slot.state === "opening") return slot.promise;
			await slot.promise;
		}
		const promise = this.openKey(key, need);
		this.slots.set(key, { state: "opening", promise });
		try {
			const result = await promise;
			if (isElsewhere(result)) this.slots.delete(key);
			else {
				this.slots.set(key, { state: "open", hosted: result });
				this.touch(result);
				void this.drain(result);
			}
			return result;
		} catch (error) {
			this.slots.delete(key);
			throw error;
		}
	}

	private async openKey(key: string, need: "use" | "requests"): Promise<Hosted | Elsewhere> {
		await this.ensureIndexes();
		// A storage this instance cannot run is, for this instance, always somebody else's.
		if (this.options.accepts?.(key) === false) return { elsewhere: true, owner: await this.owner(key) };
		const lease = await this.acquire(key);
		if (!lease.held) {
			if (lease.owner === this.instanceId) this.namesake(key);
			return { elsewhere: true, owner: lease.owner };
		}
		// A lease that had to be created belongs to a storage nobody was running, or to no storage at all. Come for a
		// request, find none waiting: there is nothing to open, and the lease goes back as if never taken.
		if (need === "requests" && lease.created && (await this.requests.findOne({ s: key, ...this.actionable() })) === null) {
			await this.leases.deleteOne(this.held(key));
			return { elsewhere: true, owner: undefined };
		}
		try {
			const { client, db, prefix, runtime, writeConcern, context } = this.options;
			const storage = await MongoStorage.open({
				client,
				db,
				key,
				runtime,
				...(prefix === undefined ? {} : { prefix }),
				...(writeConcern === undefined ? {} : { writeConcern }),
			});
			const live = new Set<number>();
			const hosted: Hosted = { key, harness: undefined as never, live, users: 0, idle: undefined, gone: false };
			const options = await this.options.harness(key);
			const harness = await this.options.Harness.open(
				this.guard(storage, hosted),
				{
					...options,
					onReport: (error) => {
						// A harness that is gone has lost its storage or is being closed, and that was said when it
						// happened. What it reports from then on, once for every commit it still tries, is the echo.
						if (hosted.gone) return;
						if (options.onReport !== undefined) options.onReport(error);
						else this.report(error, `harness ${key}`);
					},
				},
				context,
			);
			(hosted as { harness: Harness }).harness = harness;
			// Subscribe before reading the live tasks, so none that starts in between is missed.
			harness.subscribeCommits((publication) => {
				for (const change of publication.changes) {
					if (change.type !== "task") continue;
					if (change.value.state.status === "terminal") live.delete(change.value.id);
					else live.add(change.value.id);
				}
				this.touch(hosted);
			});
			for (const task of (await harness.inspect(context)).tasks) live.add(task.record.id);
			// Continue whatever the last owner left unfinished.
			harness.resume();
			return hosted;
		} catch (error) {
			await this.leases.deleteOne(this.held(key)).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * A lease in this instance's name that is not this process's: another process is running under the same name.
	 * The two still work as two instances, because a lease belongs to a process run. But each takes over everything
	 * the other is running when it starts, so it is said, once.
	 */
	private namesake(key: string): void {
		if (this.namesakeReported) return;
		this.namesakeReported = true;
		this.report(
			new Error(
				`Another running server process uses this instance's name ${JSON.stringify(this.instanceId)}: it holds ` +
					`storage ${JSON.stringify(key)}. Give each process its own instance name; a process that starts takes ` +
					"over what is leased to its name.",
			),
			"instance name",
		);
	}

	/**
	 * Watch the storage's commits. A commit refused as a contract violation leaves the Session usable. Any other
	 * failure leaves it poisoned, by Pi Durable's own rule that an uncertain commit is fatal: then this harness is
	 * finished, and the storage is reopened so its tasks resume from their checkpoints.
	 */
	private guard(storage: MongoStorage, hosted: Hosted): Storage {
		return new Proxy(storage, {
			get: (target, property, receiver) => {
				const value = Reflect.get(target, property, receiver);
				if (property !== "commit") return typeof value === "function" ? value.bind(target) : value;
				return async (...args: Parameters<Storage["commit"]>) => {
					try {
						return await target.commit(...args);
					} catch (error) {
						if (!(error instanceof this.options.runtime.StorageRejected)) this.failed(hosted, error);
						throw error;
					}
				};
			},
		}) as Storage;
	}

	private failed(hosted: Hosted, error: unknown): void {
		if (hosted.gone) return;
		hosted.gone = true;
		const taken = error instanceof StorageOwnershipLost;
		if (!taken) this.report(error, `commit ${hosted.key}`);
		// A storage that keeps failing is reopened less and less eagerly; one that worked for a minute starts over.
		const strike = this.strikes.get(hosted.key);
		const count = strike !== undefined && Date.now() - strike.at < 60_000 ? strike.count + 1 : 0;
		this.strikes.set(hosted.key, { count, at: Date.now() });
		const delay = taken ? 0 : Math.min(30_000, count === 0 ? 0 : 250 * 2 ** (count - 1));
		// Off the commit's own stack: closing joins the harness, which is waiting for this very commit to reject.
		setTimeout(() => {
			void this.close(hosted, taken ? "keep" : "handover").then(() => {
				// A storage whose commit failed for another reason is still this instance's to run.
				if (taken || !this.running) return;
				setTimeout(() => {
					if (this.running) void this.host(hosted.key).catch((again) => this.report(again, `reopen ${hosted.key}`));
				}, delay);
			});
		}, 0);
	}

	/** Run `work` as a user of `hosted`, so the storage is not closed for idleness underneath it. */
	private async using<T>(hosted: Hosted, work: () => T | Promise<T>): Promise<T> {
		hosted.users++;
		if (hosted.idle !== undefined) {
			clearTimeout(hosted.idle);
			hosted.idle = undefined;
		}
		try {
			return await work();
		} finally {
			hosted.users--;
			this.touch(hosted);
		}
	}

	/** Start or cancel the idle countdown of a hosted storage after its tasks or users changed. */
	private touch(hosted: Hosted): void {
		if (hosted.gone || this.open(hosted.key) !== hosted) return;
		const idle = hosted.live.size === 0 && hosted.users === 0;
		if (!idle) {
			if (hosted.idle !== undefined) {
				clearTimeout(hosted.idle);
				hosted.idle = undefined;
			}
			return;
		}
		if (hosted.idle !== undefined) return;
		hosted.idle = setTimeout(() => {
			hosted.idle = undefined;
			void this.closeIfIdle(hosted).catch((error) => this.report(error, `idle close ${hosted.key}`));
		}, this.idleMs);
	}

	private async closeIfIdle(hosted: Hosted): Promise<void> {
		if (hosted.gone || this.open(hosted.key) !== hosted) return;
		if (hosted.live.size > 0 || hosted.users > 0) return;
		// A request may have been written for this host a moment ago; closing now would leave it to a sweep.
		const waiting = await this.requests.findOne({ s: hosted.key, ...this.actionable() });
		if (waiting !== null) {
			await this.drain(hosted);
			this.touch(hosted);
			return;
		}
		if (hosted.live.size > 0 || hosted.users > 0 || this.open(hosted.key) !== hosted) return;
		await this.close(hosted, "release");
	}

	/**
	 * Close a hosted storage. `release` gives the lease up. `handover` leaves it expired, for a storage that still has
	 * work: the next instance to look takes it without waiting. `keep` leaves the lease as it is: because it is
	 * someone else's now, or because this instance is not done with the storage.
	 */
	private close(hosted: Hosted, lease: "release" | "handover" | "keep"): Promise<void> {
		const slot = this.slots.get(hosted.key);
		if (slot?.state === "closing") return slot.promise;
		if (slot?.state !== "open" || slot.hosted !== hosted) return Promise.resolve();
		hosted.gone = true;
		if (hosted.idle !== undefined) clearTimeout(hosted.idle);
		const promise = (async () => {
			try {
				// Closing waits for the harness's running calls to end, and a tool that ignores its cancellation never
				// does. Past `closeMs` the harness is left behind: `gone` here, and unable to commit once the storage is
				// opened again or destroyed.
				let timer: ReturnType<typeof setTimeout> | undefined;
				const late = new Promise<"late">((resolve) => {
					timer = setTimeout(() => resolve("late"), this.closeMs);
				});
				const closing = hosted.harness.close(this.options.context);
				const outcome = await Promise.race([closing, late]);
				clearTimeout(timer);
				if (outcome === "late") {
					closing.catch(() => undefined);
					this.report(
						new Error(`Storage ${JSON.stringify(hosted.key)} did not close within ${this.closeMs} ms and was left behind`),
						`close ${hosted.key}`,
					);
				}
			} catch (error) {
				// A harness whose storage was taken, or whose last commit is in doubt, cannot close cleanly.
				if (lease === "release") this.report(error, `close ${hosted.key}`);
			}
			try {
				if (lease === "release") await this.leases.deleteOne(this.held(hosted.key));
				else if (lease === "handover") {
					await this.leases.updateOne(this.held(hosted.key), [{ $set: { until: "$$NOW" } }]);
				}
			} catch (error) {
				this.report(error, `lease ${hosted.key}`);
			} finally {
				if (this.slots.get(hosted.key)?.state === "closing") this.slots.delete(hosted.key);
			}
		})();
		this.slots.set(hosted.key, { state: "closing", promise });
		return promise;
	}

	// ── Leases ─────────────────────────────────────────────────────────────────

	/** The lease on `key`, if this process holds it. */
	private held(key: string): Filter {
		return { _id: key, owner: this.instanceId, inc: this.incarnation };
	}

	/**
	 * Take the lease on `key` if it is free, has run out, or is this process's already; while this process is taking
	 * up what the last run of its name left, also if it is in this instance's name. Otherwise say who holds it.
	 */
	private async acquire(
		key: string,
	): Promise<{ held: true; created: boolean } | { held: false; owner: string | undefined }> {
		const until = { $add: ["$$NOW", this.leaseMs] };
		// `$literal`: in a pipeline, a string that starts with `$` would otherwise be read as a field path.
		const me = { $literal: this.instanceId };
		const run = { $literal: this.incarnation };
		const majority = { writeConcern: { w: "majority" } };
		// Two statements, because Mongo allows no `$expr` in the predicate of an upsert. Each is atomic on the one row,
		// and each can only move the lease to this process from a state in which it was free to take.
		for (let attempt = 0; attempt < 2; attempt++) {
			const own = this.adopting ? { owner: this.instanceId } : { owner: this.instanceId, inc: this.incarnation };
			const taken = await this.leases.findOneAndUpdate(
				{ _id: key, $or: [own, { $expr: { $lte: ["$until", "$$NOW"] } }] },
				[
					{
						$set: {
							since: { $cond: [{ $and: [{ $eq: ["$owner", me] }, { $eq: ["$inc", run] }] }, "$since", "$$NOW"] },
							owner: me,
							inc: run,
							until,
						},
					},
				],
				{ returnDocument: "after", ...majority },
			);
			if (taken !== null) return { held: true, created: false };
			// No lease at all: create it. A row that exists is left exactly as it is.
			try {
				const created = await this.leases.updateOne(
					{ _id: key },
					[
						{
							$set: {
								owner: { $ifNull: ["$owner", me] },
								inc: { $ifNull: ["$inc", run] },
								until: { $ifNull: ["$until", until] },
								since: { $ifNull: ["$since", "$$NOW"] },
							},
						},
					],
					{ upsert: true, ...majority },
				);
				if (created.upsertedCount === 1) return { held: true, created: true };
			} catch (error) {
				// Two instances inserting the same row: one of them now holds it.
				if ((error as { code?: number }).code !== 11000) throw error;
			}
			const holder = await this.leases.findOne({ _id: key });
			const takeable = holder === null || (holder.owner === this.instanceId && (this.adopting || holder.inc === this.incarnation));
			if (!takeable) return { held: false, owner: holder.owner };
			// Released, or come into this process's reach, between the statements: go round once more.
		}
		return { held: false, owner: undefined };
	}

	private async renew(): Promise<void> {
		const keys = this.hosted();
		try {
			if (keys.length > 0) {
				const filter = { _id: { $in: keys }, owner: this.instanceId, inc: this.incarnation };
				const result = await this.leases.updateMany(filter, [{ $set: { until: { $add: ["$$NOW", this.leaseMs] } } }]);
				if (result.matchedCount < keys.length) {
					const held = new Set((await this.leases.find(filter, { projection: { _id: 1 } }).toArray()).map((row) => row._id));
					for (const key of keys) if (!held.has(key)) this.lose(key);
				}
			}
			this.renewedAt = Date.now();
		} catch (error) {
			this.report(error, "renew leases");
			// Leases this instance could not renew for a whole lease have run out, whatever it believes.
			if (Date.now() - this.renewedAt > this.leaseMs) for (const key of keys) this.lose(key);
		}
	}

	/** This instance no longer holds the lease on `key`: stop running it. */
	private lose(key: string): void {
		const hosted = this.open(key);
		if (hosted === undefined) return;
		hosted.gone = true;
		void this.close(hosted, "keep");
	}

	private async sweep(): Promise<void> {
		if (!this.running) return;
		try {
			// Storages whose owner stopped renewing. Taking the lease is a compare-and-set, so one instance wins each.
			const expired = await this.leases
				.find({ $expr: { $lte: ["$until", "$$NOW"] } }, { projection: { _id: 1 } })
				.limit(100)
				.toArray();
			// Requests that are waiting: for a storage this instance hosts, or for one that nobody does.
			const waiting = await this.requests.find(this.actionable(), { projection: { s: 1 } }).limit(500).toArray();
			const lapsed = new Set(expired.map((row) => row._id));
			for (const key of new Set([...lapsed, ...waiting.map((row) => row.s)])) {
				if (!this.running) return;
				if (this.options.accepts?.(key) === false) continue;
				const hosted = this.open(key);
				if (hosted !== undefined) void this.drain(hosted);
				else if (!this.slots.has(key)) {
					await this.host(key, lapsed.has(key) ? "use" : "requests").catch((error) => this.report(error, `host ${key}`));
				}
			}
		} catch (error) {
			this.report(error, "sweep");
		}
	}

	// ── Requests ───────────────────────────────────────────────────────────────

	private operation(key: string, op: string): Operation {
		const operations = this.options.operations?.(key);
		// Its own entries only: "toString" is not an operation.
		const operation = operations !== undefined && Object.hasOwn(operations, op) ? operations[op] : undefined;
		if (typeof operation !== "function") {
			throw new Error(`Unknown operation ${JSON.stringify(op)} for storage ${JSON.stringify(key)}`);
		}
		return operation;
	}

	private run(hosted: Hosted, op: string, args: unknown, requestId: string): Promise<unknown> {
		if (op === DESTROY) return this.erase(hosted);
		const operation = this.operation(hosted.key, op);
		return this.using(hosted, () =>
			operation(args, { harness: hosted.harness, key: hosted.key, requestId, context: this.options.context }),
		);
	}

	/**
	 * Close the storage here and delete every record of it. The lease is held until the very end, and `recorded`,
	 * which marks the request that asked for this as done, runs before it is given up. In the other order there
	 * would be a moment with an unfinished request and no lease, which is exactly what a sweep takes for a storage
	 * that needs a host: it would open the storage again, empty.
	 */
	private erase(hosted: Hosted, recorded?: () => Promise<unknown>): Promise<void> {
		const key = hosted.key;
		const running = this.erasing.get(key);
		if (running !== undefined) return running;
		const erasure = (async () => {
			try {
				await this.close(hosted, "keep");
				const { client, db, prefix } = this.options;
				await MongoStorage.destroy({ client, db, key, ...(prefix === undefined ? {} : { prefix }) });
				this.readers.delete(key);
				await recorded?.();
			} finally {
				await this.leases.deleteOne(this.held(key)).catch((error) => this.report(error, `lease ${key}`));
			}
		})().finally(() => this.erasing.delete(key));
		this.erasing.set(key, erasure);
		return erasure;
	}

	/** Ask the host of `key` to do `op`, and wait for its answer. This instance takes over if the host goes away. */
	private async request(key: string, op: string, args: unknown, requestId: string): Promise<unknown> {
		const _id = `${key}:${requestId}`;
		await this.requests.updateOne(
			{ _id },
			[
				{
					// `$literal`: in a pipeline, a string that starts with `$` would otherwise be read as a field path.
					$set: {
						s: { $ifNull: ["$s", { $literal: key }] },
						op: { $ifNull: ["$op", { $literal: op }] },
						a: { $ifNull: ["$a", { $literal: JSON.stringify(args ?? null) }] },
						state: { $ifNull: ["$state", "pending"] },
						at: { $ifNull: ["$at", "$$NOW"] },
						expires: { $ifNull: ["$expires", { $add: ["$$NOW", this.requestMs] }] },
					},
				},
			],
			{ upsert: true, writeConcern: { w: "majority" } },
		);
		const deadline = Date.now() + this.requestMs;
		for (let wait = 20, polls = 0; ; wait = Math.min(wait * 2, 250), polls++) {
			const row = await this.requests.findOne({ _id });
			if (row === null) throw new RequestExpired(key, op);
			if (row.state === "done") return row.result === undefined ? undefined : JSON.parse(row.result);
			if (row.state === "failed") {
				const error = new Error(row.error?.message ?? "Operation failed");
				error.name = row.error?.name ?? "Error";
				throw error;
			}
			if (row.state === "expired") throw new RequestExpired(key, op);
			if (row.state === "pending" && Date.now() >= deadline) {
				// Withdraw it, unless a host claimed it in this instant; then its answer is on the way.
				const withdrawn = await this.requests.updateOne({ _id, state: "pending" }, { $set: { state: "expired" } });
				if (withdrawn.modifiedCount === 1) throw new RequestExpired(key, op);
			}
			if (row.state === "claimed" && Date.now() >= deadline + this.requestMs) throw new RequestExpired(key, op);
			// The host may have closed, or died, since the row was written. Then the storage is this instance's to
			// open, and opening it consumes the row.
			if (polls % 4 === 3 && !this.slots.has(key)) await this.host(key, "requests").catch(() => undefined);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.waiters.delete(_id);
					resolve();
				}, wait);
				this.waiters.set(_id, () => {
					clearTimeout(timer);
					this.waiters.delete(_id);
					resolve();
				});
			});
		}
	}

	/**
	 * Requests a host may take: pending ones that have not expired, and ones another process claimed. Only the host of
	 * a storage consumes its requests, so a claim by anyone else is a claim by a host that is no longer one.
	 */
	private actionable(): Filter {
		return {
			$or: [
				{ state: "pending", $expr: { $gt: ["$expires", "$$NOW"] } },
				{ state: "claimed", by: { $ne: this.incarnation } },
			],
		};
	}

	/** Do every request waiting for the storage this instance hosts. */
	private async drain(hosted: Hosted): Promise<void> {
		if (hosted.gone) return;
		try {
			const rows = await this.requests.find({ s: hosted.key, ...this.actionable() }).sort({ at: 1 }).toArray();
			for (const row of rows) await this.consume(hosted, row);
		} catch (error) {
			this.report(error, `requests ${hosted.key}`);
		}
	}

	private async consume(hosted: Hosted, row: RequestRow): Promise<void> {
		if (hosted.gone || this.consuming.has(row._id)) return;
		this.consuming.add(row._id);
		try {
			const claimed = await this.requests.findOneAndUpdate(
				{ _id: row._id, ...this.actionable() },
				{ $set: { state: "claimed", by: this.incarnation } },
				{ returnDocument: "after" },
			);
			if (claimed === null) return;
			const mine = { _id: claimed._id, by: this.incarnation };
			let outcome: Record<string, unknown>;
			try {
				if (claimed.op === DESTROY) {
					// Recorded inside the erasure, before the lease goes; see `erase()`.
					await this.erase(hosted, () => this.requests.updateOne(mine, { $set: { state: "done" } }));
					return;
				}
				const requestId = claimed._id.slice(claimed.s.length + 1);
				const result = await this.run(hosted, claimed.op, JSON.parse(claimed.a), requestId);
				outcome = { state: "done", ...(result === undefined ? {} : { result: JSON.stringify(result) }) };
			} catch (error) {
				if (hosted.gone) {
					// The harness lost its storage under the operation, which is not the request failing. Put it back for
					// whoever hosts the storage next, this instance included.
					await this.requests.updateOne(
						{ _id: claimed._id, state: "claimed", by: this.incarnation },
						{ $set: { state: "pending" }, $unset: { by: "" } },
					);
					return;
				}
				const failure = error as { name?: unknown; message?: unknown };
				outcome = { state: "failed", error: { name: String(failure?.name ?? "Error"), message: String(failure?.message ?? error) } };
			}
			await this.requests.updateOne({ _id: claimed._id, by: this.incarnation }, { $set: outcome });
		} catch (error) {
			this.report(error, `request ${row._id}`);
		} finally {
			this.consuming.delete(row._id);
		}
	}

	/** Hear of request rows as they are written, instead of at the next sweep. */
	private watchRequests(): void {
		if (!this.running) return;
		try {
			const stream = this.requests.watch(
				[{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }],
				{ fullDocument: "updateLookup" },
			);
			this.stream = stream;
			stream.on("change", (change) => {
				const row = change.fullDocument as RequestRow | undefined;
				if (row === undefined || row === null) return;
				if (row.state !== "pending") {
					this.waiters.get(row._id)?.();
					return;
				}
				const hosted = this.open(row.s);
				if (hosted !== undefined) void this.consume(hosted, row);
				// Nobody may be hosting it: the instance that wrote the row could not, or it would have. Opening the
				// storage here consumes the row; if another instance holds the lease, this does nothing.
				else if (!this.slots.has(row.s) && this.options.accepts?.(row.s) !== false) {
					void this.host(row.s, "requests").catch((error) => this.report(error, `host ${row.s}`));
				}
			});
			stream.on("error", (error) => {
				if (this.stream !== stream) return;
				this.stream = undefined;
				void stream.close().catch(() => undefined);
				if (!this.running) return;
				this.report(error, "request stream");
				// The sweep covers the gap; the stream is only the fast path.
				setTimeout(() => this.watchRequests(), 1000);
			});
		} catch (error) {
			this.report(error, "request stream");
		}
	}

	// ── Housekeeping ───────────────────────────────────────────────────────────

	private ensureIndexes(): Promise<void> {
		this.indexes ??= (async () => {
			await Promise.all([
				this.leases.createIndexes([{ key: { until: 1 } }, { key: { owner: 1 } }]),
				this.requests.createIndexes([
					{ key: { s: 1, state: 1, at: 1 } },
					{ key: { state: 1 } },
					// Answered requests are of no use after their caller has gone.
					{ key: { at: 1 }, expireAfterSeconds: 3600 },
				]),
			]);
		})();
		this.indexes.catch(() => {
			this.indexes = undefined;
		});
		return this.indexes;
	}

	private stopTimers(): void {
		if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
		if (this.sweeper !== undefined) clearInterval(this.sweeper);
		this.heartbeat = undefined;
		this.sweeper = undefined;
		const stream = this.stream;
		this.stream = undefined;
		if (stream !== undefined) void stream.close().catch(() => undefined);
		for (const wake of [...this.waiters.values()]) wake();
	}

	private report(error: unknown, where: string): void {
		try {
			this.options.onError?.(error, where);
		} catch {
			// A reporter must not throw; if it does, there is nobody left to tell.
		}
	}
}
