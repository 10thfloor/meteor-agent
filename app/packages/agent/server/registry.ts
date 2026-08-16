import type { Provider } from './providers/types';
import type { ToolSpec } from './tools';

export interface AgentConfig {
  model: string;
  instructions: string | string[] | ((ctx: { userId: string | null }) => string);
  tools?: ToolSpec[];
  /** Required in Milestone 1. The pi-ai adapter that would default this is
   *  Milestone 2; until then every agent supplies its provider explicitly. */
  provider: Provider;
  maxIterations?: number;
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
