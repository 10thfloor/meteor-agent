import type { Provider } from './providers/types';
import type { ToolSpec } from './tools';

export interface AgentConfig {
  /** `<pi-ai provider>/<model id>`, e.g. `anthropic/claude-sonnet-5`, unless a
   *  custom `provider` gives the string its own meaning. */
  model: string;
  instructions: string | string[] | ((ctx: { userId: string | null }) => string);
  tools?: ToolSpec[];
  /** Optional. Defaults to `piAiProvider()`, which resolves `model` against
   *  pi-ai's built-in catalog and reads API keys from the environment. Supply
   *  one explicitly for a mock (see `mockProvider`) or a custom backend. */
  provider?: Provider;
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
  registry.set(name, config);
}

export function getAgent(name: string): AgentConfig | undefined {
  return registry.get(name);
}

export function buildSystemPrompt(
  config: AgentConfig, ctx: { userId: string | null },
): string {
  const i = config.instructions;
  if (typeof i === 'function') return i(ctx);
  if (Array.isArray(i)) return i.join('\n\n');
  return i;
}
