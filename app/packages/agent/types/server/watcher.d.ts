import { ACTIVE_PHASES } from '../common/types';
/**
 * §4.3. Recovery with nobody present.
 *
 * Every other entry point into a turn needs a person: a send, an approve, a
 * deny. That leaves four states no user action will ever clear —
 *
 *   1. An ORPHAN: a session parked in an active phase whose owner died. The
 *      lease expires and nothing notices, because noticing was the dead
 *      process's job.
 *   2. A TIMED-OUT APPROVAL: a `gate: 'ask'` request nobody will answer. The
 *      park holds no process and runs no timer by design, so there is nothing
 *      in-turn left to enforce `budget.approval`.
 *   3. A DROPPED WAKE: a verdict recorded, and the resume it deferred died
 *      before consuming it. The loop's own wind-down self-check closes the
 *      window it can see; a process that dies inside that window leaves the
 *      verdict standing forever.
 *
 *   4. An ORPHANED CHILD: a subagent session whose parent transcript never got
 *      the tool row that names it. The dispatch died between creating the child
 *      and committing its result, so the child is real, finished (or claimable
 *      by case 1) and reachable from NOTHING a client can see. Unlike the other
 *      three there is no turn to resume here — the repair is a pointer.
 *
 * For 1–3 this module NOTICES and CALLS the machinery that already handles
 * them — `runTurn` (via `deferTurn`, so a recovered turn runs with exactly the
 * config a user-initiated one would) and `recordTimeoutVerdict` (via the same
 * single-winner conditional write a human verdict goes through). It contains no
 * repair logic, no lease logic and no verdict logic of its own: `claimLease` and
 * repair-on-entry are what make a recovered turn safe, and duplicating either
 * here would give the fleet two implementations of the thing that must be
 * exactly one. Case 4 is the one exception, and only because there is nothing to
 * delegate to: no other caller writes an `orphan-child` note, and the write
 * itself is one transcript row through the same atomic-seq idiom `writeVerdict`
 * uses for its own.
 *
 * Multi-server safety needs no new coordination for the same reason. Two servers
 * racing on one orphan resolve through `claimLease` (one wins, the loser's
 * `runTurn` returns without writing); racing on one timeout resolve through the
 * verdict's conditional write (one wins, the loser gets a quiet false); racing
 * on one orphaned child resolve through the note's DERIVED `_id` (one wins, the
 * loser's insert is a duplicate key it swallows).
 */
/** Phases in which a turn is supposed to be RUNNING. A session sitting in one of
 *  these with no live lease is, by definition, nobody's. Defined in
 *  `common/types` and re-exported here, where it was born: subagent dispatch
 *  needs the same list to tell a mid-run child from a settled one. */
export { ACTIVE_PHASES };
export interface WatcherOptions {
    /** How often the sweep runs. Default 15s; tests lower it. */
    sweepMs?: number;
    /**
     * How long a standing verdict must have gone unconsumed before the sweep
     * treats it as a DROPPED wake rather than a live one (case 3).
     *
     * Without this the sweep would race every legitimate resume: `agent.approve`
     * writes the verdict and defers the run, and for the few milliseconds before
     * that run marks itself running, the session looks exactly like a dropped
     * wake. Waking it then risks a second turn nobody asked for — a provider
     * charge and an assistant row appended to a finished turn — because the
     * legitimate resume may spend the verdict in between, leaving the woken run to
     * fall straight into the think loop.
     *
     * `updatedAt` is the clock: the verdict write sets it, and a session in this
     * state has no other writer. Default one sweep interval, floored at 1s.
     */
    verdictGraceMs?: number;
    /**
     * How old a CHILD session must be before the sweep will re-link it (case 4).
     *
     * The same reasoning as `verdictGraceMs`, against a different race. A live
     * dispatch writes the child session first and the parent's `activeChild`
     * marker second; for the width of that one write a perfectly healthy child
     * looks exactly like an abandoned one. The `activeChild` check is what
     * normally excludes a live dispatch, and this is what covers the window
     * BEFORE that marker exists.
     *
     * `createdAt` is the clock — a child's birth is the only moment that matters
     * here, and it never moves. Default one sweep interval, floored at 1s; tests
     * lower it to make a sweep observable.
     */
    relinkGraceMs?: number;
}
export interface Watcher {
    /** Tear down the observer AND the interval, awaiting whatever is in flight. */
    stop(): Promise<void>;
}
export declare function startWatcher(opts?: WatcherOptions): Watcher;
//# sourceMappingURL=watcher.d.ts.map