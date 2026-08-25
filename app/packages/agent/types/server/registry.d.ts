import { type MemoryConfig, type ResolvedMemory } from '../common/types';
import type { Provider } from './providers/types';
import { type Skill, type ToolSpec } from './tools';
import type { RunConfig } from './loop';
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
    /**
     * On-demand prompt fragments. Each skill's `name` and `description` are
     * appended to the system prompt as a listing; its `content` is NOT — the
     * model loads that through the built-in `skill` tool, which exists only when
     * an agent has skills. See `Skill` and `buildSystemPrompt`.
     *
     * The economy is the point: a skill costs one line per model call until it is
     * needed, and its full body only in the turn that needs it.
     */
    skills?: Skill[];
    /**
     * Optional. Defaults to `piAiProvider()`, which resolves `model` against
     * pi-ai's built-in catalog and reads API keys from the environment. Supply
     * one explicitly for a mock (see `mockProvider`) or a custom backend.
     *
     * A STRING names a provider registered with `Agent.provider(name, impl)` and
     * is resolved at run time — see `registerProvider` and `buildRunConfig`. It
     * exists so an isomorphic config file can say `provider: 'mock'` without
     * importing a server-only implementation, and so a deployment can swap the
     * backend behind one registration.
     */
    provider?: Provider | string;
    /** $ per million tokens, for cost accounting. Used only as the FALLBACK when
     *  a provider reports no cost of its own: pi-ai prices each call itself,
     *  including the cacheRead/cacheWrite tokens this two-rate table cannot
     *  express. So this is a floor for providers that report nothing, not an
     *  override. */
    pricing?: {
        input: number;
        output: number;
    };
    /**
     * §9. The ONLY brake on loop-initiated work: `DDPRateLimiter` sees a user's
     * `agent.send` and nothing the loop does after it, so every model call and
     * every tool call the loop makes on its own is limited here or nowhere.
     *
     * `turns` counts `agent.send`s (checked in `mSend`, refusing the send).
     * `toolCalls` and `spend` are checked inside the loop, which commits a
     * `kind: 'budget'` note and stops. Each is checked BEFORE the spend it
     * governs, so a limit of N permits exactly N.
     */
    budget?: {
        turns?: number;
        /**
         * System-turn spec decision 5: how many turns started by a NON-HUMAN origin
         * this session permits. A separate purse from `turns` because scheduled work
         * and human work are tuned separately — and a refusal here refuses the park
         * outright (decision 6) rather than writing a note and stopping the session,
         * which would wedge a conversation because a machine ran out of budget.
         */
        systemTurns?: number;
        toolCalls?: number;
        /** Dollars, as a number or a `'$1.50'` string. Parsed at define() time. */
        spend?: number | string;
        /**
         * §4.3. Milliseconds a `gate: 'ask'` request may sit unanswered before the
         * watcher records a DENIED verdict for it (`reason: 'approval timed out'`)
         * and lets the turn continue. Omit it and a parked request waits forever —
         * which is the right default for a request a human is expected to see, and
         * the wrong one for an unattended run.
         *
         * Enforced by the WATCHER's sweep, not by the loop: a park holds no process
         * and runs no timer, so there is nothing in-turn left to enforce it.
         */
        approval?: number;
        /**
         * Participants spec decision 7: how many MODEL-TO-MODEL relay hops may
         * follow one human message before an `@`-addressed reply stops scheduling
         * its addressee. Default 4. The capped reply still commits and delivers —
         * a note-only budget row says why nothing answered — and any human
         * message resets the count. Read from the PRIMARY agent's budget, like
         * every other purse in a session.
         */
        relay?: number;
    };
    maxIterations?: number;
    /** §9 compaction. When the estimated context exceeds `window * compactAt`
     *  tokens, everything older than the last `keep` messages is summarized into
     *  a `kind:'compaction'` note and the MODEL's view restarts from that
     *  summary. The transcript keeps every message. Defaults 200_000 / 0.8 / 6.
     *  Omit `context` entirely to disable compaction. */
    context?: {
        window?: number;
        compactAt?: number;
        keep?: number;
    };
    /** §10. Provider retry: `attempts` counts the initial try (default 3);
     *  the delay is FULL JITTER — uniform in
     *  `[0, min(maxDelayMs, baseMs * 2^attempt)]` (defaults 500 / 10_000).
     *  Only transient failures (429/408/5xx/network) retry; other auth and
     *  request errors fail fast. */
    retry?: {
        attempts?: number;
        baseMs?: number;
        maxDelayMs?: number;
    };
    /** §5.2. Tool results are truncated past this many characters before they
     *  enter the transcript (and therefore every later model call). Explicit
     *  truncation marker; default 8000. */
    maxResultChars?: number;
    /**
     * Per-TURN ceiling on the bytes of `tool_args` deltas a turn may publish.
     * Default 256 KiB (`DEFAULT_MAX_TOOL_ARG_BYTES`).
     *
     * DISPLAY-STREAM HYGIENE ONLY. The delta collection is capped and shared by
     * every session on the deployment, so one model streaming a runaway argument
     * blob evicts everyone else's in-flight tokens. Past the ceiling a turn stops
     * publishing partial-arguments deltas; `text` and `thinking` deltas are
     * unaffected, and the committed assistant message's real `toolCalls` — what
     * dispatch actually reads — are never clamped. Raise it for an agent whose
     * tools genuinely take huge arguments and whose UI renders them.
     */
    maxToolArgBytes?: number;
    /** §7's backstop: may this agent use this tool at all, independent of any
     *  per-tool gate? Checked before dispatch AND before parking — a forbidden
     *  tool never asks a human for approval. Refusal reaches the model as a
     *  structured `not-allowed` result. */
    canUse?: (tool: string, ctx: {
        userId: string | null;
        sessionId: string;
    }) => boolean | Promise<boolean>;
    /**
     * Who may answer a `gate: 'ask'` approval, on top of the ownership check
     * every method already makes. Omit it and the session's owner decides —
     * which for an anonymous capability-URL session means whoever holds the id,
     * exactly as `send` and `interrupt` already work. Return false to refuse:
     * the caller gets `Meteor.Error('not-allowed')` and the run stays parked.
     */
    approve?: (ctx: {
        userId: string | null;
    }) => boolean | Promise<boolean>;
    /**
     * May `agent.start` (and `agent.fork`) open a session for this agent directly?
     *
     * Undefined (the default) means YES — every agent is a startable endpoint, the
     * behavior that predates this flag. Set it to `false` for a SPECIALIST that
     * should only ever be reached as a subagent or an `Agent.ask` target: those
     * paths do not go through `agent.start`, so a `startable: false` agent still
     * runs as a child session and still answers a headless one-shot, but a client
     * can no longer independently start it and bypass the parent's gates.
     *
     * This is coarse — an on/off switch on the public start method. For finer
     * control (start it only for certain callers, or only from a certain parent)
     * write a `canUse` on the PARENT that inspects `ctx` and keep the child
     * ungated. See the README's Subagents section.
     */
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
    /** Passed through unchanged (already a plain ms count). The loop ignores it;
     *  the watcher's sweep is what enforces it. */
    approval?: number;
    /** The relay-hop cap, validated like the counts. */
    relay?: number;
}
/**
 * Dollars out of `budget.spend`. THROWS on anything malformed, and is called
 * from `defineAgent` so it throws at startup: a budget is the only limit on
 * loop-initiated work, and a typo in it must never be discovered by a session
 * that has already overspent. There is no "ignore it and carry on" branch here
 * for the same reason.
 */
export declare function parseSpend(spend: number | string): number;
/** The registry's `budget` as the loop consumes it. Undefined in, undefined
 *  out: no budget configured is not the same as a budget of zero. */
export declare function resolveBudget(budget?: AgentConfig['budget']): ResolvedBudget | undefined;
/**
 * Register a provider under a name. See `Agent.provider` for the contract.
 *
 * Additive, and re-registering OVERWRITES with one warning rather than
 * throwing. Meteor's dev server re-runs server files on every hot reload, so a
 * throw here would turn an ordinary edit into a startup failure; a silent
 * overwrite, on the other hand, is how two different implementations end up
 * fighting over one name in production and nobody finds out. Warn and take the
 * newest — the reload case is exactly a re-registration of the same impl.
 */
export declare function registerProvider(name: string, impl: Provider): void;
/** The registered impl, or undefined. Exported for tests and for a host that
 *  wants to reuse an app-registered provider directly. */
export declare function getProvider(name: string): Provider | undefined;
/**
 * A config's `provider` reduced to an implementation.
 *
 * A STRING is resolved HERE — at `buildRunConfig` time, once per turn — and
 * NOT at `defineAgent` time, deliberately. Agents and providers register in
 * whatever order their server files load, and an agent that names a provider
 * registered in a later file is ordinary code, not a mistake; validating at
 * define() would make correctness depend on file order (the same reasoning
 * `resolveTools` gives for not resolving a subagent name). An unknown name is
 * therefore an error at the first turn, naming what was asked for and what is
 * available, rather than a silent fallback to pi-ai — which would bill a real
 * provider for a config that asked for a mock.
 */
export declare function resolveProvider(provider: AgentConfig['provider']): Provider;
/**
 * The `memory` block, resolved and frozen at define() time (the `budget`
 * idiom) so the loop and the tools read settled values rather than
 * re-deriving defaults per turn. Undefined in, undefined out: no memory
 * configured means no tools, no block, no writes — bit-for-bit today.
 *
 * Unknown keys THROW. `memory: { hint: false }` silently leaving hints on is
 * exactly the class of typo the define()-time posture exists to catch, and
 * this is a brand-new option surface with no back-compat to preserve.
 */
export declare function resolveMemory(memory?: MemoryConfig): ResolvedMemory | undefined;
export declare function defineAgent(name: string, config: AgentConfig): void;
export declare function getAgent(name: string): AgentConfig | undefined;
/**
 * Every registered agent as `[name, config]` pairs, in registration order.
 *
 * The registry is otherwise keyed lookup only; startup needs to WALK it to warn
 * about agents shipped with no spend ceiling (see `server/index.ts`), and a host
 * that builds its own admin surface may want the same. A fresh array each call —
 * the internal Map is not handed out.
 */
export declare function listAgents(): Array<[string, AgentConfig]>;
/**
 * The registry config as the LOOP consumes it — the one assembly every entry
 * into a turn goes through.
 *
 * There are now four of them (`agent.send`/`approve`/`deny` via `deferTurn`,
 * the watcher's recovery, `Agent.ask`, and a subagent's child run), and a turn
 * that ran under different terms depending on how it was started would make
 * every one of them untestable as a proxy for the others. `provider` is
 * resolved HERE rather than at define() time so `defineAgent` stays a pure
 * registration, pi-ai is loaded only when a turn actually runs, and a
 * `provider: 'name'` string can be registered after the agent that names it
 * (see `resolveProvider`, which is also where an unknown name throws); `spend` is
 * reduced to dollars here so the loop compares numbers (it cannot throw at this
 * point — `defineAgent` already parsed the same value at startup and refused a
 * bad one).
 *
 * `userId` is what `instructions` and every tool's `ctx.userId` see. A child
 * session passes its INHERITED owner, which is the parent's — and with a
 * roster, every entry passes the OWNER, not the triggering member
 * (participants spec decision 10): a turn always runs as one identity.
 *
 * `opts` is the ADDRESSED-TURN composition (participants spec §4.3): the run
 * is the addressee's config — model, prompt, tools, provider — but
 * `agentName` names it for stamps and hooks, and `budget` (when given) is the
 * PRIMARY's, so one purse governs the session whichever model spends it.
 */
/**
 * The addressed-turn memory option, in ONE place.
 *
 * Three hand-written copies of `resolveMemory(primary.memory) ? { memory: … }`
 * is what let the live `agent.send` path drift and lose the threading
 * entirely — the bug decision 19 exists to prevent, reintroduced by
 * duplication. Every addressed defer builds its opts through this.
 */
export declare function memoryOpt(config: AgentConfig): {
    memory?: ResolvedMemory;
};
export declare function buildRunConfig(config: AgentConfig, userId: string | null, opts?: {
    agentName?: string;
    budget?: ResolvedBudget;
    memory?: ResolvedMemory;
}): RunConfig;
/**
 * The system prompt: the agent's own instructions, plus a `## Skills` listing
 * when it has skills.
 *
 * The listing carries names and DESCRIPTIONS ONLY. A skill's content never
 * appears here — that is the entire token economy, and putting it in the prompt
 * "just for the small ones" would be the first step back to a prompt that grows
 * with the library.
 */
export declare function buildSystemPrompt(config: AgentConfig, ctx: {
    userId: string | null;
}): string;
//# sourceMappingURL=registry.d.ts.map