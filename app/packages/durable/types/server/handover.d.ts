/** What `handoverOnSignal` uses of Node's `process`. */
export type SignalSource = {
    readonly pid: number;
    once(signal: string, listener: () => void): unknown;
    listenerCount(signal: string): number;
    kill(pid: number, signal: string): unknown;
};
/** What `handOver` uses of a `DurableHost`. */
export type Leaving = {
    stop(): Promise<void>;
    surrender(): Promise<void>;
};
/**
 * Stop `host`: close its storages, and leave those with work for the next instance to take at once. A storage whose
 * tool ignores its cancellation never closes, so after `graceMs`, or if stopping fails, the leases are given up as
 * they are. Never rejects, and never takes much longer than `graceMs`: it runs in a process that is ending.
 */
export declare function handOver(host: Leaving, graceMs: number): Promise<"stopped" | "surrendered">;
/**
 * Run `leave` when the process is told to end, then let it end. Once `leave` has settled the signal is raised again:
 * with no other listener for it, Node ends the process exactly as it would have without this. Where the app has a
 * listener of its own, ending the process is that listener's business, and nothing is raised. A second signal while
 * leaving ends the process at once.
 */
export declare function handoverOnSignal(source: SignalSource, leave: () => Promise<unknown>, signals?: readonly string[]): void;
//# sourceMappingURL=handover.d.ts.map