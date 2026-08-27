import type { ToolSchema } from './providers/types';
import type { AgentSession, ResolvedMemory } from '../common/types';
import { modelParticipantId } from '../common/participants';
import {
  assertMemoryNamesFree, expandMcpTools, MEMORY_TOOL_NAMES, resolveTools,
  toolSchemas, withSkillTool,
  type ResolvedTool, type Skill, type ToolSpec,
} from './tools';
import { withMemoryTools } from './memory-tools';

/** @internal The Prepared Tool Runtime is the one executable catalog a Turn
 * and its provider schema see. Preparation owns discovery and name precedence;
 * callers cannot accidentally dispatch a different set than they advertised. */
export interface PreparedToolRuntime {
  readonly tools: ResolvedTool[];
  readonly schemas: ToolSchema[];
}

export interface PrepareToolRuntimeOptions {
  specs: ToolSpec[];
  skills?: Skill[];
  /** Configured Memory and the facts that decide whether this Session may
   * expose it. Presence protects the reserved names even for an ineligible
   * child/throwaway Session. */
  memory?: {
    config: ResolvedMemory;
    session: Pick<AgentSession, 'parent' | 'ephemeral' | 'userId'>;
    agent: string;
  };
}

function assertUniqueAuthored(tools: ResolvedTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.kind === 'mcp') continue;
    if (names.has(tool.name)) {
      throw new Error(
        `[10thfloor:agent] two authored tools are named "${tool.name}"; tool names must `
        + 'be unique before a provider can use them.',
      );
    }
    names.add(tool.name);
  }
}

function assertUniquePrepared(tools: ResolvedTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`[10thfloor:agent] prepared duplicate tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

/** @internal Resolve, discover, add built-ins, and derive schemas exactly once.
 * App tools win over MCP discoveries. Reserved built-ins win over MCP tools;
 * registry validation already prevents app tools from taking memory names. */
export async function prepareToolRuntime(
  options: PrepareToolRuntimeOptions,
): Promise<PreparedToolRuntime> {
  if (options.memory) assertMemoryNamesFree(options.specs);
  const resolved = resolveTools(options.specs);
  assertUniqueAuthored(resolved);
  const reserved = options.memory ? MEMORY_TOOL_NAMES : [];
  const discovered = await expandMcpTools(resolved, reserved);
  const memory = options.memory
    && !options.memory.session.parent
    && !options.memory.session.ephemeral
    ? {
      config: options.memory.config,
      by: modelParticipantId(options.memory.agent),
      agent: options.memory.agent,
      userId: options.memory.session.userId,
    }
    : undefined;
  const tools = withMemoryTools(
    withSkillTool(discovered, options.skills),
    memory,
  );
  assertUniquePrepared(tools);
  return { tools, schemas: toolSchemas(tools) };
}
