import { type AgentMessage } from '../common/types';
import type { ProviderMessage, ToolSchema } from './providers/types';
import { type TranscriptView } from './transcript';
import type { RunConfig } from './loop';
/**
 * §9 compaction: the assembled context view, the threshold check, the
 * summarization step, and the on-demand `compactSession` entry point.
 *
 * `RunConfig` is imported as a TYPE only (it is defined in `loop.ts`, which
 * imports `maybeCompact`/`assembleContext` from here) — the type import is
 * erased at compile time, so the loop ↔ compaction relationship is a one-way
 * runtime edge, not a cycle.
 */
/** The newest `kind:'compaction'` note, or null. Only the newest matters:
 *  each compaction's summary already folds the previous one in. */
export declare function latestCompaction(msgs: AgentMessage[]): {
    seq: number;
    summary: string;
    upto: number;
} | null;
/**
 * What the MODEL sees: from the newest compaction note, its summary as a
 * leading user message, then every non-note message after the note's `upto`.
 * With no compaction, the whole (note-filtered) transcript. The transcript
 * itself is never touched — compaction changes this view only.
 *
 * `view` is the running participant's projection (participants spec §4.4),
 * threaded straight through to `toProviderMessages`; absent = today's,
 * byte-identical.
 */
export declare function assembleContext(msgs: AgentMessage[], view?: TranscriptView): ProviderMessage[];
/**
 * Estimated tokens the next provider call will carry. The last assistant's
 * provider-reported `usage.input` is ground truth for the context size at
 * THAT call; chars/4 approximates what has landed since. Take the max — the
 * estimate feeds a threshold, so erring high compacts a little early, erring
 * low silently never compacts. `lastReportedInput` must come from an
 * assistant NEWER than the latest compaction, or it describes a view that no
 * longer exists (the caller enforces this).
 */
export declare function estimateContext(assembled: ProviderMessage[], lastReportedInput?: number): number;
/**
 * The seq to compact up to (inclusive), keeping the last `keep` non-note
 * messages — or null when there is nothing worth compacting. The cut NEVER
 * splits an assistant-with-toolCalls from its tool results: a summarized
 * `tool_use` whose `tool_result` survives in the tail (or vice versa) is the
 * same unmatched-pair 400 the repair machinery exists to prevent, introduced
 * by our own bookkeeping. `batchSafeBoundary` is the walk that guarantees it —
 * shared verbatim with session forking.
 */
export declare function findCompactionCut(msgs: AgentMessage[], keep: number): number | null;
/**
 * §9. Summarize everything older than the last `keep` messages into a
 * `kind:'compaction'` note, using the turn's own provider. Failure is
 * DEGRADED, never fatal: the turn proceeds uncompacted (too-long context is
 * the provider's error to report, and the next iteration tries again), and no
 * error note is written — compaction is bookkeeping, not the user's request.
 * Returns true when a note was committed (the caller re-reads history).
 *
 * This is the THRESHOLD half only. The step itself is `compactNow`, which the
 * manual `Agent.compact` calls directly — see there.
 */
export declare function maybeCompact(sessionId: string, agent: string, config: RunConfig, history: AgentMessage[], schemas?: ToolSchema[], interruptCheckMs?: number): Promise<boolean>;
/**
 * What a manual compaction did. A plain union rather than a throw, because this
 * module is deliberately free of the Meteor namespace — `Agent.compact` turns
 * every REFUSING outcome into `Meteor.Error('busy')` and `gone` into
 * `no-session`, and the client sees those.
 */
export type CompactOutcome = 'compacted' | 'nothing' | 'busy' | 'awaiting' | 'errored' | 'gone' | 'over-budget';
/**
 * The refusing outcomes, and the `reason` each one carries.
 *
 * One error CODE (`busy`) across all three, because that is the contract
 * `Agent.compact` and `agent.compact` already published and every client
 * branches on — but three distinct reasons, because "a turn is running",
 * "answer the approval first" and "this session failed" are three different
 * things for a person to do next, and a UI that only ever sees `busy` would
 * tell all three of them to wait a moment.
 *
 * Here rather than duplicated at the two call sites, which is exactly how the
 * two would drift.
 */
export declare const COMPACT_REFUSALS: Partial<Record<CompactOutcome, string>>;
/**
 * The reason `over-budget` carries. Kept OUT of `COMPACT_REFUSALS` on purpose:
 * that map's every entry maps to `Meteor.Error('busy')`, and this is a distinct
 * `budget-exhausted` code — a compaction bills a provider round trip like a turn
 * does, and a session over its `budget.spend` must be refused it, not told to
 * "try again in a moment". The two call sites (`agent.compact`, `Agent.compact`)
 * branch on `over-budget` before the generic `busy` lookup.
 */
export declare const COMPACT_OVER_BUDGET = "This session has reached its spend budget; compaction bills like a turn.";
/**
 * §9's compaction step, run ON DEMAND against an idle session — the whole point
 * being that the threshold does NOT apply. A UI's "compact now" button, a job
 * trimming a long-running session before it gets expensive.
 *
 * It takes the LEASE for the operation (claim, compact, release) rather than
 * writing under whatever the session's state happens to be. A compaction is a
 * full provider round trip that commits a note at an allocated seq, which is
 * precisely what a turn does — running one beside a live turn would interleave
 * two writers over one transcript. So a session with a live lease, or a turn in
 * flight in this process, is refused as `busy` instead of queued: the caller is
 * a human clicking a button, and "try again in a moment" is an answer they can
 * act on. The in-process `running` Set is held too, for the same reason
 * `runTurn` holds it — `claimLease` succeeds on its "already ours" branch, so
 * the lease alone would not stop a `Meteor.defer`red turn in THIS process from
 * writing straight through the compaction.
 *
 * The heartbeat mirrors `runTurn`'s: LEASE_MS is 30s and a summarization of a
 * long transcript can exceed it, and losing the lease mid-call would make the
 * note's own lease-guarded write fail silently.
 *
 * The watcher is not fought: it recovers sessions whose lease EXPIRED, and this
 * one is heartbeaten and released. The phase is restored on the way out with
 * `runTurn`'s exact rule — `stopped`, `error` and `awaiting` are decisions and
 * are left alone; anything else returns to `idle`, which is what an idle
 * session that was compacted goes back to being.
 *
 * `awaiting` and `error` are refused on the way IN for the same reason the
 * finally leaves them alone on the way out. Neither is leased — a parked run
 * releases its lease, and a failed one is long gone — so the lease check below
 * cannot see them, and without their own guard a compaction would overwrite
 * the phase with `compacting` and the finally would then "restore" `idle`: an
 * approval nobody can answer any more (`recordVerdict` and the watcher sweep
 * both require `awaiting`, and the next send's overtaken-park branch DELETES
 * the parked turn), or a failure laundered into a healthy-looking session.
 */
export declare function compactSession(sessionId: string, config: RunConfig): Promise<CompactOutcome>;
//# sourceMappingURL=compaction.d.ts.map