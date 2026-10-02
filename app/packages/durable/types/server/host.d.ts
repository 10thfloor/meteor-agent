import type { Context } from "@earendil-works/chord";
import type { Harness, HarnessOptions, SettledSubmissionRecord, Storage, SubmissionId } from "@earendil-works/pi-durable";
import { type MongoClientLike, type MongoDbLike, MongoStorage, type MongoStorageRuntime } from "./mongo-storage";
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
    readonly Harness: {
        open(storage: Storage, options: HarnessOptions, context: Context): Promise<Harness>;
    };
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
export declare class HostedElsewhere extends Error {
    readonly key: string;
    readonly owner: string | undefined;
    constructor(key: string, owner: string | undefined);
}
/** No host took a request before it expired. The work was not done. */
export declare class RequestExpired extends Error {
    constructor(key: string, op: string);
}
/** Hosts Pi Durable storages on one server instance, in cooperation with the other instances on the database. */
export declare class DurableHost {
    readonly instanceId: string;
    /** This process's run of `instanceId`: what distinguishes it from the process that had the name before it. */
    private readonly incarnation;
    private readonly options;
    private readonly leases;
    private readonly requests;
    private readonly leaseMs;
    private readonly heartbeatMs;
    private readonly sweepMs;
    private readonly idleMs;
    private readonly requestMs;
    private readonly closeMs;
    private readonly slots;
    private readonly readers;
    /** Storages being erased here; nothing reopens one until its erasure has finished. */
    private readonly erasing;
    /** Requests this host is executing or has just executed, so a row seen twice is done once. */
    private readonly consuming;
    private readonly waiters;
    /** Recent commit failures per storage, for the delay before it is reopened. */
    private readonly strikes;
    private indexes;
    private heartbeat;
    private sweeper;
    private stream;
    private renewedAt;
    private running;
    /** Set by `stop()`: this host opens nothing any more, and what it is asked goes to the other instances. */
    private stopped;
    /** While this process takes up what the last run of its name left; see `adopt()`. */
    private adopting;
    private namesakeReported;
    constructor(options: DurableHostOptions);
    /** Begin renewing leases, consuming requests, and looking for storages nobody is running. Idempotent. */
    start(): Promise<void>;
    /**
     * Take up what the last process with this instance's name was running. Its leases are still live, so no sweep
     * would find them; they are this instance's by name, and opening each storage shuts the old process out. Until
     * this has gone through them, any lease in this instance's name is taken as its own, so a call that arrives first
     * does not wait behind the rest. Afterwards such a lease can only be a namesake's that is running now, and is
     * left alone.
     */
    private adopt;
    /**
     * Stop hosting. Each harness is closed, which ends its running calls; a storage that still has live tasks keeps an
     * expired lease, so another instance takes it at its next look rather than after a full lease. A stopped host
     * opens nothing: what it is asked afterwards goes to the other instances by request, until `start()`.
     */
    stop(): Promise<void>;
    /**
     * Stop as a process that died would: no close, no release, nothing written. For tests of takeover. The harnesses
     * of this host stay in memory and cannot commit once another host opens their storages.
     */
    abandon(): void;
    /**
     * Give up every lease this process holds, at once and without closing anything. For a process that has to exit
     * and could not wait for `stop()`: a harness whose tool ignores its cancellation never closes. The next instance
     * to look takes the storages that had work, and the epoch keeps whatever still runs here from committing.
     */
    surrender(): Promise<void>;
    /**
     * Stop hosting `key` on this instance, if it does. A storage with work left keeps an expired lease, so another
     * instance takes it at its next look; an idle one's lease is given up.
     */
    release(key: string): Promise<void>;
    /** Keys this instance has open. */
    hosted(): string[];
    /** The instance holding a live lease on `key`, if any. */
    owner(key: string): Promise<string | undefined>;
    /**
     * Use the harness of `key` on this instance, hosting the storage here if nobody does. Rejects with
     * `HostedElsewhere` when another live instance has it: a harness cannot be handed across processes. Code that
     * must work from any instance goes through `call()`.
     */
    with<T>(key: string, use: (harness: Harness) => T | Promise<T>): Promise<T>;
    /**
     * Run the operation `op` against the storage `key`, wherever it is hosted: here if this instance hosts it or
     * nobody does, otherwise by request to its host. Resolves with the operation's result.
     */
    call<T = unknown>(key: string, op: string, args: unknown, options?: {
        requestId?: string;
    }): Promise<T>;
    /**
     * Erase the storage `key`: whichever instance runs it stops, and every record of it is deleted. What its tasks
     * were doing is abandoned, not undone. A key that was erased should not be used again while other instances may
     * still hold what they read of it.
     */
    destroy(key: string): Promise<void>;
    /**
     * A read-only view of the storage `key`: every read of the storage contract, with no ownership. Works on any
     * instance, whether or not the storage is open anywhere.
     */
    reader(key: string): Promise<MongoStorage>;
    /**
     * Resolve once the submission is answered or has failed, from any instance. It reads the committed record, so it
     * does not depend on which instance runs the work, or on that instance surviving.
     */
    settled(key: string, id: SubmissionId, options?: {
        timeoutMs?: number;
    }): Promise<SettledSubmissionRecord>;
    private open;
    /**
     * The harness of `key` on this instance, opening it here when no live instance holds it. One flight per key.
     * `requests` is for a caller that is here only because it heard of a waiting request, possibly a while ago: it
     * opens a storage that has no lease only if a request is still waiting for it. Otherwise a late notice of a
     * request that has since been done, an erasure included, would create the storage afresh.
     */
    private host;
    private openKey;
    /**
     * A lease in this instance's name that is not this process's: another process is running under the same name.
     * The two still work as two instances, because a lease belongs to a process run. But each takes over everything
     * the other is running when it starts, so it is said, once.
     */
    private namesake;
    /**
     * Watch the storage's commits. A commit refused as a contract violation leaves the Session usable. Any other
     * failure leaves it poisoned, by Pi Durable's own rule that an uncertain commit is fatal: then this harness is
     * finished, and the storage is reopened so its tasks resume from their checkpoints.
     */
    private guard;
    private failed;
    /** Run `work` as a user of `hosted`, so the storage is not closed for idleness underneath it. */
    private using;
    /** Start or cancel the idle countdown of a hosted storage after its tasks or users changed. */
    private touch;
    private closeIfIdle;
    /**
     * Close a hosted storage. `release` gives the lease up. `handover` leaves it expired, for a storage that still has
     * work: the next instance to look takes it without waiting. `keep` leaves the lease as it is: because it is
     * someone else's now, or because this instance is not done with the storage.
     */
    private close;
    /** The lease on `key`, if this process holds it. */
    private held;
    /**
     * Take the lease on `key` if it is free, has run out, or is this process's already; while this process is taking
     * up what the last run of its name left, also if it is in this instance's name. Otherwise say who holds it.
     */
    private acquire;
    private renew;
    /** This instance no longer holds the lease on `key`: stop running it. */
    private lose;
    private sweep;
    private operation;
    private run;
    /**
     * Close the storage here and delete every record of it. The lease is held until the very end, and `recorded`,
     * which marks the request that asked for this as done, runs before it is given up. In the other order there
     * would be a moment with an unfinished request and no lease, which is exactly what a sweep takes for a storage
     * that needs a host: it would open the storage again, empty.
     */
    private erase;
    /** Ask the host of `key` to do `op`, and wait for its answer. This instance takes over if the host goes away. */
    private request;
    /**
     * Requests a host may take: pending ones that have not expired, and ones another process claimed. Only the host of
     * a storage consumes its requests, so a claim by anyone else is a claim by a host that is no longer one.
     */
    private actionable;
    /** Do every request waiting for the storage this instance hosts. */
    private drain;
    private consume;
    /** Hear of request rows as they are written, instead of at the next sweep. */
    private watchRequests;
    private ensureIndexes;
    private stopTimers;
    private report;
}
//# sourceMappingURL=host.d.ts.map