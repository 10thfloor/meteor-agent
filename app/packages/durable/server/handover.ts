// Leaving in good order.
//
// A server process that is told to end (a deploy, a scale-down) is given a few seconds. Ending at once is safe: its
// leases run out, and other instances resume its storages from what was committed. But "run out" is a whole lease,
// half a minute in which nobody works on them. With what is here, the process spends its last seconds handing its
// storages over, and the next instance to look takes them at once.
//
// Like the host, this file imports nothing at run time.

/** What `handoverOnSignal` uses of Node's `process`. */
export type SignalSource = {
	readonly pid: number;
	once(signal: string, listener: () => void): unknown;
	listenerCount(signal: string): number;
	kill(pid: number, signal: string): unknown;
};

/** What `handOver` uses of a `DurableHost`. */
export type Leaving = { stop(): Promise<void>; surrender(): Promise<void> };

const after = (ms: number) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const elapsed = new Promise<"late">((resolve) => {
		timer = setTimeout(() => resolve("late"), ms);
	});
	return { elapsed, cancel: () => clearTimeout(timer) };
};

/**
 * Stop `host`: close its storages, and leave those with work for the next instance to take at once. A storage whose
 * tool ignores its cancellation never closes, so after `graceMs`, or if stopping fails, the leases are given up as
 * they are. Never rejects, and never takes much longer than `graceMs`: it runs in a process that is ending.
 */
export async function handOver(host: Leaving, graceMs: number): Promise<"stopped" | "surrendered"> {
	const grace = after(graceMs);
	const stopped = host.stop().then(
		() => "stopped" as const,
		() => "failed" as const,
	);
	const outcome = await Promise.race([stopped, grace.elapsed]);
	grace.cancel();
	if (outcome === "stopped") return "stopped";
	// Bounded as well: a database that cannot be reached must not keep the process from ending.
	const last = after(Math.min(Math.max(graceMs, 0), 1000));
	await Promise.race([host.surrender().catch(() => undefined), last.elapsed]);
	last.cancel();
	return "surrendered";
}

/**
 * Run `leave` when the process is told to end, then let it end. Once `leave` has settled the signal is raised again:
 * with no other listener for it, Node ends the process exactly as it would have without this. Where the app has a
 * listener of its own, ending the process is that listener's business, and nothing is raised. A second signal while
 * leaving ends the process at once.
 */
export function handoverOnSignal(
	source: SignalSource,
	leave: () => Promise<unknown>,
	signals: readonly string[] = ["SIGTERM", "SIGINT"],
): void {
	let leaving = false;
	for (const signal of signals) {
		source.once(signal, () => {
			// `once` took this listener off before calling it.
			const end = () => {
				if (source.listenerCount(signal) === 0) source.kill(source.pid, signal);
			};
			if (leaving) {
				end();
				return;
			}
			leaving = true;
			void leave().then(end, end);
		});
	}
}
