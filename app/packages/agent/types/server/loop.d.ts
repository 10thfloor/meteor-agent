import { type ResolvedMemory } from '../common/types';
import type { Provider } from './providers/types';
import { type Skill, type ToolSpec } from './tools';
export { classifyProviderError } from './turn-state';
export { DeltaWriter, DEFAULT_MAX_TOOL_ARG_BYTES } from './deltas';
export { toProviderMessages } from './transcript';
export { assembleContext, estimateContext, findCompactionCut } from './compaction';
export interface RunConfig {
    model: string;
    system: string;
    tools: ToolSpec[];
    provider: Provider;
    /**
     * WHICH AGENT this turn runs as (participants spec §4.3) — set by
     * `buildRunConfig` when a turn is addressed to a non-primary model
     * participant. Absent = the session's own agent, today's behavior. The loop
     * and dispatch read it for `from` stamps, `pending.agent`, and hook
     * context; the BUDGET is composed separately (always the primary's — one
     * purse per conversation).
     */
    agentName?: string;
    maxIterations?: number;
    flushMs?: number;
    /** How often the stream loop re-reads the session to honor an interrupt
     *  (`phase: 'stopped'`). Tests lower it; the default keeps the cost to a few
     *  indexed reads per response. */
    interruptCheckMs?: number;
    /** §10: bounded retry with full-jitter exponential backoff for a provider
     *  stream that throws mid-iteration. `attempts` counts the initial try
     *  (default 3); the delay is uniform in
     *  `[0, min(maxDelayMs, baseMs * 2^attemptIndex)]` (defaults 500 / 10_000). */
    retry?: {
        attempts?: number;
        baseMs?: number;
        maxDelayMs?: number;
    };
    /** §9 compaction thresholds (defaults 200_000 / 0.8 / 6); absent =
     *  compaction disabled. */
    context?: {
        window?: number;
        compactAt?: number;
        keep?: number;
    };
    /** §9, threaded from the registry by `deferTurn`. `spend` is already parsed
     *  to dollars (`parseSpend` runs at define() time). `turns` is enforced in
     *  `mSend`, not here — by the time a turn runs, the send it would refuse has
     *  already happened. `relay` caps model-to-model hops (participants spec
     *  decision 7; default 4). On an ADDRESSED turn this whole bundle is the
     *  PRIMARY agent's, whatever config the rest of the run came from. */
    budget?: {
        turns?: number;
        toolCalls?: number;
        spend?: number;
        relay?: number;
    };
    /** $ per million tokens. The FALLBACK for a provider that reports no cost of
     *  its own; see `accruedCost`. */
    pricing?: {
        input: number;
        output: number;
    };
    /** §5.2. A tool result enters the transcript AND every later provider
     *  request; one oversized result inside compaction's kept tail can exceed
     *  the context window with nothing compaction can do about it. Truncation
     *  is explicit in the content so the model knows it saw a prefix.
     *  Default 8000. */
    maxResultChars?: number;
    /** Per-TURN ceiling on the bytes of `tool_args` deltas this turn may publish.
     *  Default 256 KiB; see `DeltaWriter`'s constructor. Display-stream hygiene
     *  only — the committed message's `toolCalls` are never clamped. */
    maxToolArgBytes?: number;
    /** §7's backstop: agent-level tool authorization, checked before gates and
     *  before dispatch. A refusal is a structured result the model reads and
     *  routes around — never a park, never a throw. */
    canUse?: (tool: string, ctx: {
        userId: string | null;
        sessionId: string;
    }) => boolean | Promise<boolean>;
    /** The agent's skills. Their descriptions are already in `system` (see
     *  `buildSystemPrompt`); the loop reads this only to decide whether to add
     *  the built-in `skill` tool and what it can load. Absent or empty = no
     *  loader tool at all. */
    skills?: Skill[];
    /** Durable recall (memory spec), resolved at define() time and threaded
     *  here from the PRIMARY's config — beside `budget`, on purpose: an
     *  addressed turn to a colleague that declared no memory of its own must
     *  still see the conversation's memory, or recall would differ by whoever
     *  was @-mentioned. Absent = no tools, no block, no writes. */
    memory?: ResolvedMemory;
}
/** Full jitter: uniform in [0, min(maxDelayMs, baseMs * 2^attemptIndex)].
 *  A deterministic exponential resynchronizes every session that failed
 *  together — a provider-wide 529 would have the whole fleet retrying in
 *  lockstep, which is how outages prolong themselves. */
export declare function backoffDelay(attemptIndex: number, baseMs: number, maxDelayMs: number): number;
/**
 * TEST SEAM, not public API — the same shape as lease.ts's `_setLeaseTimings`.
 * Full jitter draws a delay that can legitimately be ~0ms, which makes the
 * between-attempts `retrying` phase unobservable by any sampler (and the
 * test-environment Mongo observer runs on the polling driver, which coalesces
 * transient states away entirely). A test that must SEE the phase pins the
 * delay deterministic here and restores in `finally`. Pass null to restore
 * the jittered default. Not re-exported from server/index.ts.
 */
export declare function _setBackoff(fn: typeof backoffDelay | null): () => void;
/**
 * Run one turn to completion. Assistant messages commit only at boundaries and
 * every abandonment path erases what it had already written, so the transcript
 * a turn leaves behind always ends in `user` or `tool` — the two states a turn
 * can legally start from. A recovering server additionally repairs on entry,
 * because cleanup by the abandoning process is not guaranteed to run at all.
 * Recovery is therefore just calling this again.
 */
export declare function runTurn(sessionId: string, config: RunConfig): Promise<void>;
//# sourceMappingURL=loop.d.ts.map