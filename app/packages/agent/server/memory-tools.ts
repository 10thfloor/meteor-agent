import { AgentMemories } from '../common/collections';
import type { ResolvedMemory } from '../common/types';
import { MEMORY_TEXT_MAX } from '../common/types';
import { forgetMemory, saveMemory, searchMemory } from './memory';
import { MEMORY_TOOL_NAMES, warnSkill, type ResolvedTool } from './tools';

/**
 * The MODEL's memory surface: three inline tools built at tool-assembly time,
 * closing over the resolved config and the running model's participant id.
 *
 * Inline rather than co-registered methods, and that is the whole design
 * (memory spec decision 7): an adopted method body receives only the Meteor
 * invocation and its args — no `sessionId`, no agent name, no config, no way
 * to stamp `by`. A closure over the run's own values carries all four, and
 * `ToolContext` supplies the caller's identity. The UI's DDP methods live in
 * `memory-methods.ts` and call the SAME core.
 */

/** Whether a SAVE must be approved. The default gate is a PREDICATE, not the
 *  `'ask'` literal, because the answer depends on the model's arguments:
 *  promoting a fact to shared work knowledge is the consent moment (spec §7),
 *  while a personal note is not.
 *
 *  An app replaces this wholesale by declaring its own `gate` — this is an
 *  ordinary tool gate, with no privileged status. */
function saveGate(ctx: { args: unknown }): boolean | 'ask' {
  const scope = (ctx.args as { scope?: unknown } | null)?.scope;
  return scope === 'app' ? 'ask' : true;
}

/**
 * Whether a FORGET must be approved — and it cannot be answered from the
 * arguments, which is why this is its own predicate and not `saveGate`.
 *
 * `memory_forget` takes `{ id }` and nothing else: there is no `scope` in the
 * args to read, so reusing the save gate resolved `'auto'` for every delete
 * and let a model quietly remove work knowledge a human had approved —
 * asymmetric in exactly the wrong direction, since writing to the shared pool
 * asked and erasing from it did not.
 *
 * The scope lives on the ROW, so the gate reads the row. A miss (an id that
 * matches nothing, or someone else's row) resolves `'auto'`: the tool body
 * answers those as an ordinary no-op, and parking a human on a delete that
 * was never going to happen is worse than running it.
 */
function forgetGate(config: ResolvedMemory) {
  return async (ctx: { args: unknown }): Promise<boolean | 'ask'> => {
    if (!config.scopes.includes('app')) return true;
    const id = (ctx.args as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === '') return true;
    const row = await AgentMemories.findOneAsync(id);
    return row?.scope === 'app' ? 'ask' : true;
  };
}

export interface MemoryToolOptions {
  config: ResolvedMemory;
  /** The RUNNING model's participant id (`m:<agent>`) — the `by` stamp. Never
   *  the speaking human's: the member's id lives on the message `from` and
   *  does not reach a tool body (spec decision 14). */
  by: string;
  /** The running agent's registry name — scopes `agent`-scope rows. */
  agent: string;
}

function saveTool(opts: MemoryToolOptions): ResolvedTool {
  const canApp = opts.config.scopes.includes('app');
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
          enum: opts.config.scopes,
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
    // Rendered to the human at the approval prompt. Carries SCOPE and TEXT
    // only: `describe`'s ctx is `{ userId, sessionId }` and it runs before
    // `pending.agent` is written, so the proposing agent is not reachable here
    // — the UI composes "(proposed by X)" from `pending.agent` instead.
    describe: (args: any) => (args?.scope === 'app'
      ? `Remember for ALL users: "${String(args?.text ?? '').slice(0, 300)}"`
      : `Remember: "${String(args?.text ?? '').slice(0, 300)}"`),
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
      // Project rather than return rows whole: `_id` the model needs (to
      // forget), `text`/`scope`/`by`/`at` it can reason about. Nothing else
      // in the row is its business.
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
    // The approver is shown WHAT is being forgotten, not just an opaque id —
    // an id alone is not a decision anyone can make.
    describe: async (args: any) => {
      const row = await AgentMemories.findOneAsync(String(args?.id ?? ''));
      if (!row) return `Forget memory ${String(args?.id ?? '')}`;
      return row.scope === 'app'
        ? `Forget for ALL users: "${row.text.slice(0, 300)}"`
        : `Forget: "${row.text.slice(0, 300)}"`;
    },
    run: async (args: any, ctx) => forgetMemory(String(args?.id ?? ''), {
      userId: ctx?.userId ?? null,
      agent: opts.agent,
      // The model's own call went through the same gate its save did, so it
      // may delete shared knowledge; the DDP surface may not (decision 7a).
      allowApp: true,
    }),
  };
}

/**
 * Append the three memory tools to an agent's expanded tool list.
 *
 * Called AFTER `expandMcpTools` and beside `withSkillTool`, with the same
 * collision policy: an app tool of the same name WINS and the built-in is
 * skipped, with one warning. The app's tool is something it deliberately
 * defined and may already call from a UI; silently overriding it would be the
 * worse surprise. (Define-time reservation catches the common case earlier;
 * this covers a name arriving from a whole-server MCP spec, which is not
 * knowable until expansion.)
 */
export function withMemoryTools(
  tools: ResolvedTool[], opts?: MemoryToolOptions,
): ResolvedTool[] {
  if (!opts) return tools;
  const taken = MEMORY_TOOL_NAMES.filter((n) => tools.some((t) => t.name === n));
  if (taken.length > 0) {
    warnSkill(
      `this agent's tools already include ${taken.join(', ')}, so the built-in memory `
      + 'tool(s) of that name are not added — the memory listing in the system prompt '
      + 'will point at your tool. Rename one of them.',
    );
    return tools;
  }
  return [...tools, saveTool(opts), searchTool(opts), forgetTool(opts)];
}
