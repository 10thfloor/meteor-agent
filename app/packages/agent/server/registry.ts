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
  /** $ per million tokens, for cost accounting. Consumed in Milestone 2's
   *  budget work; pi-ai reports its own per-model rates, so this is an
   *  override, not a requirement. */
  pricing?: { input: number; output: number };
  maxIterations?: number;
  /**
   * Who may answer a `gate: 'ask'` approval, on top of the ownership check
   * every method already makes. Omit it and the session's owner decides —
   * which for an anonymous capability-URL session means whoever holds the id,
   * exactly as `send` and `interrupt` already work. Return false to refuse:
   * the caller gets `Meteor.Error('not-allowed')` and the run stays parked.
   */
  approve?: (ctx: { userId: string | null }) => boolean | Promise<boolean>;
}

const registry = new Map<string, AgentConfig>();

export function defineAgent(name: string, config: AgentConfig): void {
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
