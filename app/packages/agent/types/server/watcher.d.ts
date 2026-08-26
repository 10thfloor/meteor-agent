import { ACTIVE_PHASES } from '../common/types';
/** §4.3 Recovery watcher. Sweeps + observer catch four orphan shapes:
 *  (1) dead-server leases, (2) timed-out approvals, (3) dropped wakes,
 *  (4) orphaned children. Delegates to existing machinery; owns no repair logic. */
/** Phases where a turn should be running; unleased = orphan. */
export { ACTIVE_PHASES };
export interface WatcherOptions {
    /** How often the sweep runs. Default 15s; tests lower it. */
    sweepMs?: number;
    /** Grace period before a standing verdict is treated as dropped (case 3).
     *  Prevents racing a legitimate resume. Default one sweep interval, min 1s. */
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