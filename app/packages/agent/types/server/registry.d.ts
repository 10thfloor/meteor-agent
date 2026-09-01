import { type MemoryConfig, type ResolvedMemory } from '../common/types';
import type { ExperienceConfig, IdentityConfig, PracticeConfig } from '../common/learning';
import type { Provider } from './providers/types';
import { type Skill, type ToolSpec } from './tools';
import type { RunConfig } from './loop';
/** Stable identity configuration supplied by application code. The runtime
 * registry name is authoritative and is added by `buildRunConfig`; making it a
 * second configurable field would let the two names drift. */
export type AgentIdentityConfig = Omit<IdentityConfig, 'name'>;
export interface AgentConfig {
    /** `<pi-ai provider>/<model id>`, e.g. `anthropic/claude-sonnet-5`, unless a
     *  custom `provider` gives the string its own meaning. */
    model: string;
    instructions: string | string[] | ((ctx: {
        userId: string | null;
    }) => string);
    tools?: ToolSpec[];
    /** Durable recall (memory spec). `true` takes every default; absent means
     *  no memory tools, no standing block, and no writes — today's behavior,
     *  bit-for-bit. */
    memory?: MemoryConfig;
    /** Durable continuity for Constitution, Experience, Practice, and Frames.
     * `id` must remain stable when display name, model, Team, or instructions
     * change. Omit to disable those identity-owned layers; independently
     * configured Fact Memory is unaffected. */
    identity?: AgentIdentityConfig;
    /** Agent-owned episodic learning. Requires `identity`; `true` enables the
     * gated proposal Tool and bounded on-demand recall with safe defaults. */
    experience?: ExperienceConfig;
    /** Opt-in Agent-authored Practice candidates and their validation policy. */
    practice?: PracticeConfig;
    /** On-demand prompt fragments: listed by name/description in the system
     *  prompt, full content loaded via the skill tool only when needed. */
    skills?: Skill[];
    /** Defaults to `piAiProvider()`. A string names a provider registered with
     *  `Agent.provider(name, impl)`, resolved at run time so isomorphic configs
     *  avoid importing server-only implementations. */
    provider?: Provider | string;
    /** $/M tokens — fallback when a provider reports no cost of its own. */
    pricing?: {
        input: number;
        output: number;
    };
    /** §9. The only brake on loop-initiated work — DDPRateLimiter can't see
     *  what the loop does after `agent.send`. Each limit is checked BEFORE the
     *  spend it governs, so a limit of N permits exactly N. */
    budget?: {
        turns?: number;
        /** Decision 5: non-human-origin turn cap. Separate from `turns` because
         *  refusal here refuses the park outright (decision 6), not a note+stop. */
        systemTurns?: number;
        toolCalls?: number;
        /** Dollars, as a number or a `'$1.50'` string. Parsed at define() time. */
        spend?: number | string;
        /** §4.3. Ms before an unanswered gate:'ask' is auto-denied. Omit for
         *  forever (right for attended, wrong for unattended). Enforced by the
         *  recovery supervisor, not the Turn. */
        approval?: number;
        /** Decision 7: model-to-model relay hop cap after one human message.
         *  Default 4; any human message resets. Read from the primary's budget. */
        relay?: number;
    };
    maxIterations?: number;
    /** §9 compaction. Old messages summarized when context exceeds threshold.
     *  Defaults 200k / 0.8 / 6. Omit to disable. */
    context?: {
        window?: number;
        compactAt?: number;
        keep?: number;
    };
    /** §10. Full-jitter retry for transient failures only (429/408/5xx/network).
     *  Defaults: 3 attempts, 500ms base, 10s max. */
    retry?: {
        attempts?: number;
        baseMs?: number;
        maxDelayMs?: number;
    };
    /** §5.2. Tool results truncated past this char count; default 8000. */
    maxResultChars?: number;
    /** Per-turn ceiling on streamed `tool_args` delta bytes (default 256 KiB).
     *  Display-stream hygiene: the capped delta collection is shared, so one
     *  runaway blob would evict everyone else's in-flight tokens. */
    maxToolArgBytes?: number;
    /** §7 backstop: agent-level tool gate, checked before dispatch AND parking
     *  so a forbidden tool never reaches a human for approval. */
    canUse?: RunConfig['canUse'];
    /** Who may answer a gate:'ask' approval, on top of the ownership check.
     *  Omit and the session owner decides; false refuses with 'not-allowed'. */
    approve?: (ctx: {
        userId: string | null;
    }) => boolean | Promise<boolean>;
    /** False blocks `agent.start`/`agent.fork` — the agent is reachable only
     *  as a subagent or `Agent.ask` target, not as a direct endpoint. */
    startable?: boolean;
}
/** `budget` with `spend` reduced to a plain dollar number — what the loop and
 *  `mSend` compare against. */
export interface ResolvedBudget {
    turns?: number;
    /** The system-turn cap, validated like the counts. */
    systemTurns?: number;
    toolCalls?: number;
    spend?: number;
    /** Passed through unchanged (already a plain ms count). The Turn ignores it;
     *  the recovery supervisor enforces it. */
    approval?: number;
    /** The relay-hop cap, validated like the counts. */
    relay?: number;
}
/** Parse `budget.spend` to a dollar number. Throws at startup so a typo is
 *  never discovered by a session that has already overspent. */
export declare function parseSpend(spend: number | string): number;
/** The registry's `budget` as the loop consumes it. Undefined in, undefined
 *  out: no budget configured is not the same as a budget of zero. */
export declare function resolveBudget(budget?: AgentConfig['budget']): ResolvedBudget | undefined;
/** Warn+overwrite on re-register rather than throw — Meteor hot reload
 *  re-runs server files, so a throw would break ordinary edits. */
export declare function registerProvider(name: string, impl: Provider): void;
/** The registered impl, or undefined. Exported for tests and for a host that
 *  wants to reuse an app-registered provider directly. */
export declare function getProvider(name: string): Provider | undefined;
/** Resolved at run time, not define() time, so agent/provider registration
 *  order doesn't matter. Unknown name throws rather than falling back to
 *  pi-ai (which would bill the wrong provider). */
export declare function resolveProvider(provider: AgentConfig['provider']): Provider;
/** Frozen at define() time so the loop reads settled values. Unknown keys
 *  throw to catch typos on this new option surface. */
export declare function resolveMemory(memory?: MemoryConfig): ResolvedMemory | undefined;
export declare function defineAgent(name: string, config: AgentConfig): void;
export declare function getAgent(name: string): AgentConfig | undefined;
/** Startup walks this to warn about agents with no spend ceiling. */
export declare function listAgents(): Array<[string, AgentConfig]>;
/** One place for addressed-turn memory opts — duplication let the
 *  `agent.send` path drift and lose threading (decision 19). */
export declare function memoryOpt(config: AgentConfig): {
    memory?: ResolvedMemory;
};
/** Single assembly point for all four turn entries. Provider resolved here
 *  (not define time) so registration order doesn't matter. `opts.budget` is
 *  the primary's so one purse governs the session. */
export declare function buildRunConfig(config: AgentConfig, userId: string | null, opts?: {
    agentName?: string;
    budget?: ResolvedBudget;
    memory?: ResolvedMemory;
}): RunConfig;
/** Skills listing carries names/descriptions only — content never in the
 *  prompt, loaded on demand via the skill tool. */
export declare function buildSystemPrompt(config: AgentConfig, ctx: {
    userId: string | null;
}): string;
//# sourceMappingURL=registry.d.ts.map