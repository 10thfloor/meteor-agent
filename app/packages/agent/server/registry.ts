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
  };
  maxIterations?: number;
  /** §10. Provider retry: `attempts` counts the initial try (default 3),
   *  backoff is `baseMs * 2^attemptIndex` (default 500). Only transient
   *  failures (429/5xx/network) retry; auth and request errors fail fast. */
  retry?: { attempts?: number; baseMs?: number };
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
  return {
    turns: budget.turns,
    toolCalls: budget.toolCalls,
    spend: budget.spend === undefined ? undefined : parseSpend(budget.spend),
  };
}

const registry = new Map<string, AgentConfig>();

export function defineAgent(name: string, config: AgentConfig): void {
  // Validate BEFORE registering, so a bad config leaves no half-usable agent
  // behind: a config error is a startup error, not a runtime one.
  resolveBudget(config.budget);
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
