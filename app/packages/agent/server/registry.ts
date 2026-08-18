import type { Provider } from './providers/types';
import { validateSkills, type Skill, type ToolSpec } from './tools';
import type { RunConfig } from './loop';
import { piAiProvider } from './providers/piai';

export interface AgentConfig {
  /** `<pi-ai provider>/<model id>`, e.g. `anthropic/claude-sonnet-5`, unless a
   *  custom `provider` gives the string its own meaning. */
  model: string;
  instructions: string | string[] | ((ctx: { userId: string | null }) => string);
  tools?: ToolSpec[];
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
  pricing?: { input: number; output: number };
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
  };
  maxIterations?: number;
  /** §9 compaction. When the estimated context exceeds `window * compactAt`
   *  tokens, everything older than the last `keep` messages is summarized into
   *  a `kind:'compaction'` note and the MODEL's view restarts from that
   *  summary. The transcript keeps every message. Defaults 200_000 / 0.8 / 6.
   *  Omit `context` entirely to disable compaction. */
  context?: { window?: number; compactAt?: number; keep?: number };
  /** §10. Provider retry: `attempts` counts the initial try (default 3);
   *  the delay is FULL JITTER — uniform in
   *  `[0, min(maxDelayMs, baseMs * 2^attempt)]` (defaults 500 / 10_000).
   *  Only transient failures (429/408/5xx/network) retry; other auth and
   *  request errors fail fast. */
  retry?: { attempts?: number; baseMs?: number; maxDelayMs?: number };
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
  canUse?: (tool: string, ctx: { userId: string | null; sessionId: string })
    => boolean | Promise<boolean>;
  /**
   * Who may answer a `gate: 'ask'` approval, on top of the ownership check
   * every method already makes. Omit it and the session's owner decides —
   * which for an anonymous capability-URL session means whoever holds the id,
   * exactly as `send` and `interrupt` already work. Return false to refuse:
   * the caller gets `Meteor.Error('not-allowed')` and the run stays parked.
   */
  approve?: (ctx: { userId: string | null }) => boolean | Promise<boolean>;
}

/** `budget` with `spend` reduced to a plain dollar number — what the loop and
 *  `mSend` compare against. */
export interface ResolvedBudget {
  turns?: number;
  toolCalls?: number;
  spend?: number;
  /** Passed through unchanged (already a plain ms count). The loop ignores it;
   *  the watcher's sweep is what enforces it. */
  approval?: number;
}

/** `'$1.50'` / `'1.50'` / `1.5`, and nothing else. A bare `Number(...)` would
 *  read `''` as 0 and `'1.5 USD'` as NaN, both of which silently become a cap
 *  that can never be reached — the failure mode a budget exists to prevent. */
const DOLLARS = /^\$?\d+(?:\.\d+)?$/;

/**
 * Dollars out of `budget.spend`. THROWS on anything malformed, and is called
 * from `defineAgent` so it throws at startup: a budget is the only limit on
 * loop-initiated work, and a typo in it must never be discovered by a session
 * that has already overspent. There is no "ignore it and carry on" branch here
 * for the same reason.
 */
export function parseSpend(spend: number | string): number {
  if (typeof spend === 'number') {
    if (!Number.isFinite(spend) || spend < 0) {
      throw new Error(
        `[10thfloor:agent] budget.spend must be a non-negative finite number of `
        + `dollars; got ${String(spend)}`,
      );
    }
    return spend;
  }
  const trimmed = String(spend).trim();
  if (!DOLLARS.test(trimmed)) {
    throw new Error(
      `[10thfloor:agent] budget.spend must be dollars — a number like 1.5 or a `
      + `string like "$1.50"; got ${JSON.stringify(spend)}`,
    );
  }
  return Number(trimmed.replace('$', ''));
}

/** A count limit must be a positive integer. Validated with the same rigor as
 *  `parseSpend`, for the same reason: a string `turns: '5'` would reach mSend's
 *  `$lt` filter, where BSON type ordering makes a number never less-than a
 *  string — every send refused, discovered in production, baffling to debug. */
function assertCountLimit(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `[10thfloor:agent] budget.${field} must be a positive integer; `
      + `got ${JSON.stringify(value)}`,
    );
  }
}

/** The registry's `budget` as the loop consumes it. Undefined in, undefined
 *  out: no budget configured is not the same as a budget of zero. */
export function resolveBudget(budget?: AgentConfig['budget']): ResolvedBudget | undefined {
  if (!budget) return undefined;
  assertCountLimit(budget.turns, 'turns');
  assertCountLimit(budget.toolCalls, 'toolCalls');
  // Milliseconds rather than a count, but the same rigor for the same reason: a
  // string `'60000'` compares as a string against a Date arithmetic result and
  // an approval would silently never time out — the one failure mode this
  // setting exists to prevent.
  assertCountLimit(budget.approval, 'approval');
  return {
    turns: budget.turns,
    toolCalls: budget.toolCalls,
    spend: budget.spend === undefined ? undefined : parseSpend(budget.spend),
    approval: budget.approval,
  };
}

const registry = new Map<string, AgentConfig>();

/**
 * Named provider implementations, for configs that say `provider: 'name'`.
 *
 * GLOBAL, like `Agent.method` and `Agent.hook`: a provider belongs to the
 * process, and any number of agents may name the same one.
 */
const providers = new Map<string, Provider>();

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
export function registerProvider(name: string, impl: Provider): void {
  if (typeof name !== 'string' || name === '') {
    throw new Error('[10thfloor:agent] Agent.provider(name, impl) needs a non-empty name');
  }
  if (!impl || typeof (impl as any).stream !== 'function') {
    throw new Error(
      `[10thfloor:agent] Agent.provider("${name}", impl): impl must have a `
      + 'stream(request) method returning an async iterable of chunks',
    );
  }
  if (providers.has(name)) {
    console.warn(
      `[10thfloor:agent] provider "${name}" was already registered; overwriting `
      + '(expected on a dev hot reload, a real conflict otherwise)',
    );
  }
  providers.set(name, impl);
}

/** The registered impl, or undefined. Exported for tests and for a host that
 *  wants to reuse an app-registered provider directly. */
export function getProvider(name: string): Provider | undefined {
  return providers.get(name);
}

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
function resolveProvider(provider: AgentConfig['provider']): Provider {
  if (provider === undefined) return piAiProvider();
  if (typeof provider !== 'string') return provider;
  const impl = providers.get(provider);
  if (!impl) {
    const known = [...providers.keys()];
    throw new Error(
      `[10thfloor:agent] Unknown provider "${provider}". Register it with `
      + `Agent.provider("${provider}", impl) before a turn runs. `
      + `Registered: ${known.length ? known.join(', ') : '(none)'}`,
    );
  }
  return impl;
}

/** Numeric config keys are validated with `assertCountLimit`'s rigor and for
 *  its reason: a non-numeric `context.window` makes the compaction trigger
 *  compare against NaN — false forever — so compaction silently never runs,
 *  which is precisely the failure mode define-time validation exists to
 *  prevent. */
function assertFiniteNumber(value: unknown, field: string, opts: { min?: number; max?: number } = {}): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)
    || (opts.min !== undefined && value < opts.min)
    || (opts.max !== undefined && value > opts.max)) {
    throw new Error(
      `[10thfloor:agent] ${field} must be a finite number`
      + `${opts.min !== undefined ? ` >= ${opts.min}` : ''}`
      + `${opts.max !== undefined ? ` <= ${opts.max}` : ''}; got ${JSON.stringify(value)}`,
    );
  }
}

export function defineAgent(name: string, config: AgentConfig): void {
  // Validate BEFORE registering, so a bad config leaves no half-usable agent
  // behind: a config error is a startup error, not a runtime one.
  resolveBudget(config.budget);
  assertFiniteNumber(config.context?.window, 'context.window', { min: 1 });
  assertFiniteNumber(config.context?.compactAt, 'context.compactAt', { min: 0, max: 1 });
  assertFiniteNumber(config.context?.keep, 'context.keep', { min: 1 });
  assertFiniteNumber(config.retry?.attempts, 'retry.attempts', { min: 1 });
  assertFiniteNumber(config.retry?.baseMs, 'retry.baseMs', { min: 0 });
  assertFiniteNumber(config.retry?.maxDelayMs, 'retry.maxDelayMs', { min: 0 });
  assertFiniteNumber(config.maxResultChars, 'maxResultChars', { min: 1 });
  validateSkills(config.skills);
  registry.set(name, config);
}

export function getAgent(name: string): AgentConfig | undefined {
  return registry.get(name);
}

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
 * session passes its INHERITED owner, which is the parent's.
 */
export function buildRunConfig(config: AgentConfig, userId: string | null): RunConfig {
  return {
    model: config.model,
    system: buildSystemPrompt(config, { userId }),
    tools: config.tools ?? [],
    provider: resolveProvider(config.provider),
    maxIterations: config.maxIterations,
    budget: resolveBudget(config.budget),
    pricing: config.pricing,
    retry: config.retry,
    context: config.context,
    maxResultChars: config.maxResultChars,
    maxToolArgBytes: config.maxToolArgBytes,
    canUse: config.canUse,
    // Hooks are NOT threaded here, deliberately: they are registered globally
    // with `Agent.hook` and the loop imports their runners directly. Passing
    // them through `RunConfig` would mean every entry into a turn (send,
    // watcher recovery, `ask`, a subagent's child run) had to remember to carry
    // them, and one that forgot would silently skip an app's redaction. Skills
    // go the other way for the opposite reason: they are per-agent by
    // definition, so they belong to the config.
    skills: config.skills,
  };
}

/** The single instruction that makes the listing actionable. It names the tool,
 *  so `SKILL_TOOL_NAME` and this sentence travel together. */
const SKILLS_INSTRUCTION =
  "Load a skill's full instructions with the skill tool when its description "
  + 'matches the task.';

/**
 * The system prompt: the agent's own instructions, plus a `## Skills` listing
 * when it has skills.
 *
 * The listing carries names and DESCRIPTIONS ONLY. A skill's content never
 * appears here — that is the entire token economy, and putting it in the prompt
 * "just for the small ones" would be the first step back to a prompt that grows
 * with the library.
 */
export function buildSystemPrompt(
  config: AgentConfig, ctx: { userId: string | null },
): string {
  const i = config.instructions;
  let prompt: string;
  if (typeof i === 'function') prompt = i(ctx);
  else if (Array.isArray(i)) prompt = i.join('\n\n');
  else prompt = i;

  const skills = config.skills ?? [];
  if (skills.length === 0) return prompt;

  const listing = skills.map((s) => `- ${s.name} — ${s.description}`).join('\n');
  return `${prompt}\n\n## Skills\n\n${listing}\n\n${SKILLS_INSTRUCTION}`;
}
