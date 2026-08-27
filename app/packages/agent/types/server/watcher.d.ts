import { ACTIVE_PHASES } from '../common/types';
/** Recovery supervisor. Activation owns durable Session-to-Turn recovery;
 * this Module composes it with approval expiry, lifecycle cleanup, and
 * orphan-child transcript repair. */
/** Phases where a turn should be running; unleased = orphan. */
export { ACTIVE_PHASES };
export interface WatcherOptions {
    /** How often the sweep runs. Default 15s; tests lower it. */
    sweepMs?: number;
    /** Grace before newly durable verdict, Relay, System, or input evidence is
     * eligible for sweep recovery. Prevents racing its local Activation nudge.
     * Default one sweep interval, minimum 1s. */
    verdictGraceMs?: number;
    /** Grace period before a child session is treated as orphaned (case 4).
     *  Covers the window between child creation and `activeChild` write. */
    relinkGraceMs?: number;
}
export interface Watcher {
    /** Tear down the observer AND the interval, awaiting whatever is in flight. */
    stop(): Promise<void>;
}
export declare function startWatcher(opts?: WatcherOptions): Watcher;
//# sourceMappingURL=watcher.d.ts.map