import { type ResolvedMemory } from '../common/types';
import type { Provider } from './providers/types';
import type { Skill, ToolSpec } from './tools';
export { classifyProviderError } from './turn-state';
export { DeltaWriter, DEFAULT_MAX_TOOL_ARG_BYTES } from './deltas';
export { toProviderMessages } from './transcript';
export { assembleContext, estimateContext, findCompactionCut } from './compaction';
import type { SessionQuery } from '../common/db';
export interface RunConfig {
    model: string;
    system: string;
    tools: ToolSpec[];
    provider: Provider;
    /** Which agent this turn runs as (§4.3). Absent = session's own agent. */
    agentName?: string;
    maxIterations?: number;
    flushMs?: number;
    /** How often the stream loop re-reads the session to honor an interrupt
     *  (`phase: 'stopped'`). Tests lower it; the default keeps the cost to a few
     *  indexed reads per response. */
    interruptCheckMs?: number;
    /** §10: bounded retry with full-jitter backoff. `attempts` includes the
     *  initial try (default 3). */
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
    /** §9 budget. Always the PRIMARY agent's, even on addressed turns. */
    budget?: {
        turns?: number;
        systemTurns?: number;
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
    /** §5.2. Oversized results are truncated to avoid wedging compaction.
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
    /** Skills available to the `skill` loader tool. Absent = no loader. */
    skills?: Skill[];
    /** Durable recall (memory spec). Always the PRIMARY's config so every
     *  participant sees the same memory. Absent = disabled. */
    memory?: ResolvedMemory;
}
/** Full jitter to prevent lockstep retries after a provider-wide failure. */
export declare function backoffDelay(attemptIndex: number, baseMs: number, maxDelayMs: number): number;
/** TEST SEAM: pin a deterministic delay so `retrying` phase is observable.
 *  Pass null to restore the jittered default. */
export declare function _setBackoff(fn: typeof backoffDelay | null): () => void;
/** Run one Turn to completion. Activation supplies a lazy config factory so
 * application callbacks run only after this process wins the exact Lease. */
export declare function runTurn(sessionId: string, configOrFactory: RunConfig | (() => RunConfig), expected?: SessionQuery): Promise<void>;
//# sourceMappingURL=loop.d.ts.map