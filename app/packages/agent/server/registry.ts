import {
  MEMORY_MAX_APP_DEFAULT, MEMORY_MAX_DEFAULT, MEMORY_SCOPES,
  type MemoryConfig, type MemoryScope, type ResolvedMemory,
} from '../common/types';
import type { Provider } from './providers/types';
import {
  assertMemoryNamesFree, validateSkills, type Skill, type ToolSpec,
} from './tools';
import { ensureMemoryMethods } from './memory-methods';
import type { RunConfig } from './loop';
import { piAiProvider } from './providers/piai';

export interface AgentConfig {
  /** `<pi-ai provider>/<model id>`, e.g. `anthropic/claude-sonnet-5`, unless a
   *  custom `provider` gives the string its own meaning. */
  model: string;
  instructions: string | string[] | ((ctx: { userId: string | null }) => string);
  tools?: ToolSpec[];
  /** Durable recall (memory spec). `true` takes every default; absent means
   *  no memory tools, no standing block, and no writes — today's behavior,
   *  bit-for-bit. */
  memory?: MemoryConfig;
  /** On-demand prompt fragments: listed by name/description in the system
   *  prompt, full content loaded via the skill tool only when needed. */
  skills?: Skill[];
  /** Defaults to `piAiProvider()`. A string names a provider registered with
   *  `Agent.provider(name, impl)`, resolved at run time so isomorphic configs
   *  avoid importing server-only implementations. */
  provider?: Provider | string;
  /** $/M tokens — fallback when a provider reports no cost of its own. */
  pricing?: { input: number; output: number };
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
     *  watcher's sweep, not the loop. */
    approval?: number;
    /** Decision 7: model-to-model relay hop cap after one human message.
     *  Default 4; any human message resets. Read from the primary's budget. */
    relay?: number;
  };
  maxIterations?: number;
  /** §9 compaction. Old messages summarized when context exceeds threshold.
   *  Defaults 200k / 0.8 / 6. Omit to disable. */
  context?: { window?: number; compactAt?: number; keep?: number };
  /** §10. Full-jitter retry for transient failures only (429/408/5xx/network).
   *  Defaults: 3 attempts, 500ms base, 10s max. */
  retry?: { attempts?: number; baseMs?: number; maxDelayMs?: number };
  /** §5.2. Tool results truncated past this char count; default 8000. */
  maxResultChars?: number;
  /** Per-turn ceiling on streamed `tool_args` delta bytes (default 256 KiB).
   *  Display-stream hygiene: the capped delta collection is shared, so one
   *  runaway blob would evict everyone else's in-flight tokens. */
  maxToolArgBytes?: number;
  /** §7 backstop: agent-level tool gate, checked before dispatch AND parking
   *  so a forbidden tool never reaches a human for approval. */
  canUse?: (tool: string, ctx: { userId: string | null; sessionId: string })
    => boolean | Promise<boolean>;
  /** Who may answer a gate:'ask' approval, on top of the ownership check.
   *  Omit and the session owner decides; false refuses with 'not-allowed'. */
  approve?: (ctx: { userId: string | null }) => boolean | Promise<boolean>;
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
  /** Passed through unchanged (already a plain ms count). The loop ignores it;
   *  the watcher's sweep is what enforces it. */
  approval?: number;
  /** The relay-hop cap, validated like the counts. */
  relay?: number;
}

/** Strict dollar pattern — bare `Number()` would silently allow '' as 0. */
const DOLLARS = /^\$?\d+(?:\.\d+)?$/;

/** Parse `budget.spend` to a dollar number. Throws at startup so a typo is
 *  never discovered by a session that has already overspent. */
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

/** A string count would break BSON's `$lt` comparison — every send silently
 *  refused in production. */
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
  assertCountLimit(budget.systemTurns, 'systemTurns');
  assertCountLimit(budget.toolCalls, 'toolCalls');
  // String ms would silently never time out against Date arithmetic.
  assertCountLimit(budget.approval, 'approval');
  assertCountLimit(budget.relay, 'relay');
  return {
    turns: budget.turns,
    // No spread — a new type key omitted here silently never applies.
    systemTurns: budget.systemTurns,
    toolCalls: budget.toolCalls,
    spend: budget.spend === undefined ? undefined : parseSpend(budget.spend),
    approval: budget.approval,
    relay: budget.relay,
  };
}

const registry = new Map<string, AgentConfig>();

/** Global, like `Agent.method` and `Agent.hook` — process-wide, not
 *  per-agent. */
const providers = new Map<string, Provider>();

/** Warn+overwrite on re-register rather than throw — Meteor hot reload
 *  re-runs server files, so a throw would break ordinary edits. */
export function registerProvider(name: string, impl: Provider): void {
  if (typeof name !== 'string' || name === '') {
    throw new Error('[10thfloor:agent] Agent.provider(name, impl) needs a non-empty name');
  }
  if (!impl || typeof impl.stream !== 'function') {
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

/** Resolved at run time, not define() time, so agent/provider registration
 *  order doesn't matter. Unknown name throws rather than falling back to
 *  pi-ai (which would bill the wrong provider). */
export function resolveProvider(provider: AgentConfig['provider']): Provider {
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

/** Non-numeric config values compare against NaN — feature silently never
 *  triggers. */
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

function assertPositiveIntegerOption(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)
    || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `[10thfloor:agent] ${field} must be a positive integer; `
      + `got ${JSON.stringify(value)}`,
    );
  }
}

function assertPricing(pricing: AgentConfig['pricing']): void {
  if (pricing === undefined) return;
  if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing)) {
    throw new Error(
      `[10thfloor:agent] pricing must be an object with input/output rates; `
      + `got ${JSON.stringify(pricing)}`,
    );
  }
  assertFiniteNumber(pricing.input, 'pricing.input', { min: 0 });
  assertFiniteNumber(pricing.output, 'pricing.output', { min: 0 });
}

/** Frozen at define() time so the loop reads settled values. Unknown keys
 *  throw to catch typos on this new option surface. */
export function resolveMemory(memory?: MemoryConfig): ResolvedMemory | undefined {
  if (memory === undefined || memory === false) return undefined;
  const m = memory === true ? {} : memory;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    throw new Error(
      '[10thfloor:agent] memory must be true or an options object; '
      + `got ${JSON.stringify(memory)}`,
    );
  }
  const known = ['hints', 'max', 'maxApp', 'index', 'scopes', 'search'];
  for (const key of Object.keys(m)) {
    if (!known.includes(key)) {
      throw new Error(
        `[10thfloor:agent] memory has an unknown key "${key}"; `
        + `expected ${known.join('/')}`,
      );
    }
  }

  assertCountLimit(m.max, 'max');
  assertCountLimit(m.maxApp, 'maxApp');
  assertCountLimit(m.index?.pinned, 'index.pinned');
  assertCountLimit(m.index?.recent, 'index.recent');
  if (m.search !== undefined && typeof m.search !== 'function') {
    throw new Error(
      '[10thfloor:agent] memory.search must be a function '
      + '(query, ctx) => AgentMemory[]; '
      + `got ${JSON.stringify(m.search)}`,
    );
  }

  let hints: ResolvedMemory['hints'] = { minScore: 0.6 };
  if (m.hints === false) hints = false;
  else if (typeof m.hints === 'object' && m.hints !== null) {
    assertFiniteNumber(m.hints.minScore, 'memory.hints.minScore', { min: 0, max: 1 });
    hints = { minScore: m.hints.minScore ?? 0.6 };
  }

  // 'user' is implied and always present: person memory is the default scope,
  // and a config naming only 'app' means "also app", not "no person store".
  const requested = m.scopes ?? ['user'];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error(
      '[10thfloor:agent] memory.scopes must be a non-empty array of '
      + `${MEMORY_SCOPES.join('/')}; got ${JSON.stringify(m.scopes)}`,
    );
  }
  for (const sc of requested) {
    if (!MEMORY_SCOPES.includes(sc)) {
      throw new Error(
        `[10thfloor:agent] memory.scopes has an unknown scope "${sc}"; `
        + `expected ${MEMORY_SCOPES.join('/')}`,
      );
    }
  }
  const scopes = Array.from(new Set<MemoryScope>(['user', ...requested]));

  return {
    hints,
    max: m.max ?? MEMORY_MAX_DEFAULT,
    maxApp: m.maxApp ?? MEMORY_MAX_APP_DEFAULT,
    index: { pinned: m.index?.pinned ?? 5, recent: m.index?.recent ?? 10 },
    scopes,
    ...(m.search ? { search: m.search } : {}),
  };
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
  assertPositiveIntegerOption(config.maxIterations, 'maxIterations');
  assertPositiveIntegerOption(config.maxToolArgBytes, 'maxToolArgBytes');
  assertPricing(config.pricing);
  validateSkills(config.skills);
  const memory = resolveMemory(config.memory);
  // The three model-facing names are reserved the way SKILL_TOOL_NAME is: a
  // collision is decidable here, at define time, where the operator can see it.
  if (memory) assertMemoryNamesFree(config.tools);
  registry.set(name, config);
  // Registering the UI caps is LATCHED, not per-agent: Meteor.methods throws
  // on a duplicate name and defineAgent is re-entrant (hot reload redefines
  // every agent), so a second memory-declaring agent would crash the server.
  if (memory) {
    ensureMemoryMethods(() => {
      for (const [n, c] of registry.entries()) {
        const r = resolveMemory(c.memory);
        if (r) return { config: r, agent: n };
      }
      return { agent: '' };
    });
  }
}

export function getAgent(name: string): AgentConfig | undefined {
  return registry.get(name);
}

/** Startup walks this to warn about agents with no spend ceiling. */
export function listAgents(): Array<[string, AgentConfig]> {
  return [...registry.entries()];
}

/** One place for addressed-turn memory opts — duplication let the
 *  `agent.send` path drift and lose threading (decision 19). */
export function memoryOpt(config: AgentConfig): { memory?: ResolvedMemory } {
  const mem = resolveMemory(config.memory);
  return mem ? { memory: mem } : {};
}

/** Single assembly point for all four turn entries. Provider resolved here
 *  (not define time) so registration order doesn't matter. `opts.budget` is
 *  the primary's so one purse governs the session. */
export function buildRunConfig(
  config: AgentConfig, userId: string | null,
  opts?: { agentName?: string; budget?: ResolvedBudget; memory?: ResolvedMemory },
): RunConfig {
  return {
    model: config.model,
    system: buildSystemPrompt(config, { userId }),
    tools: config.tools ?? [],
    provider: resolveProvider(config.provider),
    ...(opts?.agentName !== undefined ? { agentName: opts.agentName } : {}),
    maxIterations: config.maxIterations,
    budget: opts?.budget ?? resolveBudget(config.budget),
    pricing: config.pricing,
    retry: config.retry,
    context: config.context,
    maxResultChars: config.maxResultChars,
    maxToolArgBytes: config.maxToolArgBytes,
    canUse: config.canUse,
    // Hooks are global (Agent.hook), not per-config — so every turn entry
    // gets them without threading. Skills are per-agent, so they stay here.
    skills: config.skills,
    // Memory follows the PRIMARY, not the addressee (spec decision 19):
    // an addressed turn receives the primary's resolved bundle through `opts`.
    ...(() => {
      const mem = opts?.memory ?? resolveMemory(config.memory);
      return mem ? { memory: mem } : {};
    })(),
  };
}

/** The single instruction that makes the listing actionable. It names the tool,
 *  so `SKILL_TOOL_NAME` and this sentence travel together. */
const SKILLS_INSTRUCTION =
  "Load a skill's full instructions with the skill tool when its description "
  + 'matches the task.';

/** Skills listing carries names/descriptions only — content never in the
 *  prompt, loaded on demand via the skill tool. */
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
