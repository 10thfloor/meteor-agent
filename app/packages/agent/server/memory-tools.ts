import { AgentMemories } from '../common/collections';
import type { ResolvedMemory } from '../common/types';
import { MEMORY_TEXT_MAX } from '../common/types';
import { forgetMemory, saveMemory, searchMemory } from './memory';
import { MEMORY_TOOL_NAMES, warnSkill, type ResolvedTool } from './tools';

/* Model's memory surface: three inline tools, closures over the run's
 * config and participant id. DDP methods in memory-methods.ts call the
 * same core. */

/** Whether a save needs approval: `app` scope → ask, everything else → auto. */
function saveGate(ctx: { args: unknown; userId: string | null }): boolean | 'ask' {
  // Anonymous session → auto-approve, let the core refuse with `no-account`.
  if (ctx.userId === null) return true;
  const scope = (ctx.args as { scope?: unknown } | null)?.scope;
  return scope === 'app' ? 'ask' : true;
}

/** Whether a forget needs approval — reads scope from the row, not the
 *  args (forget has no scope arg). App-scope row → ask. */
function forgetGate(config: ResolvedMemory) {
  return async (ctx: { args: unknown; userId: string | null }): Promise<boolean | 'ask'> => {
    if (ctx.userId === null) return true;
    if (!config.scopes.includes('app')) return true;
    const id = (ctx.args as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === '') return true;
    const row = await AgentMemories.findOneAsync(id);
    return row?.scope === 'app' ? 'ask' : true;
  };
}

/** Clip text for the approval dialog, with the elision marked. */
const DESCRIBE_CHARS = 300;
function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= DESCRIBE_CHARS
    ? t
    : `${t.slice(0, DESCRIBE_CHARS)}… (+${t.length - DESCRIBE_CHARS} more characters)`;
}

export interface MemoryToolOptions {
  config: ResolvedMemory;
  /** Session owner. Null = anonymous (app scope not offered). */
  userId?: string | null;
  /** Running model's participant id (`m:<agent>`) — the `by` stamp. */
  by: string;
  /** Agent registry name — scopes `agent`-scope rows. */
  agent: string;
}

function saveTool(opts: MemoryToolOptions): ResolvedTool {
  const canApp = opts.config.scopes.includes('app') && opts.userId !== null;
  const offered = opts.userId === null
    ? opts.config.scopes.filter((sc) => sc !== 'app')
    : opts.config.scopes;
  return {
    name: 'memory_save',
    description:
      'Remember a durable fact for later conversations. Save preferences, '
      + 'corrections, and standing context the user would expect you to recall — '
      + 'never a summary of this conversation, which is already in the transcript. '
      + 'Search first: prefer re-saving with an existing "key" over creating a near-duplicate.'
      + (canApp
        ? ' Use scope "app" for facts about the WORK that are true for every user '
          + '(schemas, policies, procedures); those are shared with everyone and '
          + 'require human approval.'
        : ''),
    args: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          maxLength: MEMORY_TEXT_MAX,
          description: 'The fact, in one or two sentences.',
        },
        scope: {
          type: 'string',
          enum: offered,
          description: canApp
            ? '"user" (about this person, the default) or "app" (about the work, shared).'
            : 'Which store to save to.',
        },
        key: {
          type: 'string',
          maxLength: 128,
          description: 'A stable identity for this fact. Saving again with the same '
            + 'key UPDATES that entry instead of adding a second one.',
        },
        pinned: {
          type: 'boolean',
          description: 'Keep this fact always visible in the memory listing.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    gate: saveGate,
    kind: 'inline',
    // Human-readable description for the approval prompt.
    describe: async (args: any, ctx) => {
      const shown = clip(String(args?.text ?? ''));
      if (args?.scope !== 'app') return `Remember: "${shown}"`;
      // Don't echo stored text to anonymous sessions.
      if (ctx?.userId === null) return `Remember for ALL users: "${shown}"`;
      // Keyed app save overwrites — show it as a replacement.
      if (typeof args?.key === 'string' && args.key !== '') {
        const prior = await AgentMemories.findOneAsync(
          { scope: 'app', key: args.key } as any,
        );
        if (prior) {
          return `Replace for ALL users: "${clip(prior.text)}" → "${shown}"`;
        }
      }
      return `Remember for ALL users: "${shown}"`;
    },
    run: async (args: any, ctx) => saveMemory(args ?? {}, {
      by: opts.by,
      userId: ctx?.userId ?? null,
      agent: opts.agent,
      config: opts.config,
    }),
  };
}

function searchTool(opts: MemoryToolOptions): ResolvedTool {
  return {
    name: 'memory_search',
    description:
      'Recall remembered facts by meaning. Use it when the memory listing in your '
      + 'system prompt hints at something relevant, or when the user refers to '
      + 'anything from a past conversation.',
    args: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to recall.' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    gate: 'auto',
    kind: 'inline',
    run: async (args: any, ctx) => {
      const rows = await searchMemory(String(args?.query ?? ''), {
        userId: ctx?.userId ?? null,
        agent: opts.agent,
        config: opts.config,
        limit: args?.limit,
      });
      // Project only what the model needs.
      return rows.map((r) => ({
        id: r._id, text: r.text, scope: r.scope, by: r.by, at: r.at,
        ...(r.key ? { key: r.key } : {}),
      }));
    },
  };
}

function forgetTool(opts: MemoryToolOptions): ResolvedTool {
  return {
    name: 'memory_forget',
    description:
      'Forget one remembered fact by its id, when the user asks you to or when '
      + 'you learn it is wrong. Prefer re-saving with the same "key" when a fact '
      + 'merely changed.',
    args: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    gate: forgetGate(opts.config),
    kind: 'inline',
    // Show the text being forgotten, not just an opaque id.
    describe: async (args: any, ctx) => {
      const id = String(args?.id ?? '');
      // Don't echo stored text to anonymous sessions.
      if (ctx?.userId === null) return `Forget memory ${id}`;
      const row = await AgentMemories.findOneAsync(id);
      if (!row) return `Forget memory ${id}`;
      return row.scope === 'app'
        ? `Forget for ALL users: "${clip(row.text)}"`
        : `Forget: "${clip(row.text)}"`;
    },
    run: async (args: any, ctx) => forgetMemory(String(args?.id ?? ''), {
      userId: ctx?.userId ?? null,
      agent: opts.agent,
      // Only agents that can write app scope may delete from it.
      allowApp: opts.config.scopes.includes('app'),
    }),
  };
}

/** Append memory tools. Same-name app tool wins (skipped with a warning). */
export function withMemoryTools(
  tools: ResolvedTool[], opts?: MemoryToolOptions,
): ResolvedTool[] {
  if (!opts) return tools;
  const built = [saveTool(opts), searchTool(opts), forgetTool(opts)];
  // Per-name collision, not all-or-nothing.
  const taken = built.filter((t) => tools.some((x) => x.name === t.name)).map((t) => t.name);
  if (taken.length > 0) {
    warnSkill(
      `this agent's tools already include ${taken.join(', ')}, so the built-in memory `
      + 'tool(s) of that name are not added — that part of the memory listing in the '
      + 'system prompt will be served by your tool, or not at all. Rename one of them.',
    );
  }
  return [...tools, ...built.filter((t) => !taken.includes(t.name))];
}
