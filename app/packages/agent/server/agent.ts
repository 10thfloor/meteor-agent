import type { AgentSession, ResolvedMemory } from '../common/types';
import type { SessionQuery } from '../common/db';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentMemories, AgentSessions } from '../common/collections';
import {
  defineAgent, getAgent, listAgents, buildRunConfig, registerProvider, resolveMemory,
  type AgentConfig,
} from './registry';
import type { Provider } from './providers/types';
import { runTurn } from './loop';
import { COMPACT_OVER_BUDGET, COMPACT_REFUSALS, compactSession } from './compaction';
import { forkSessionById } from './fork';
import { readTurnOutcome } from './subagent';
import { defineAgentMethod, type AdoptedTool, type AgentMethodOptions } from './tools';
import { registerMcpServer, type McpServerDef } from './mcp/client';
import {
  clearAgentHooks, clearHooks, registerAgentHook, registerHook,
  type HookMap, type HookName,
} from './hooks';
import { recordVerdict, sendToSession, startSystemTurn } from './methods';
import type { SystemTurnResult } from './system-turn';
import {
  forgetMemory, readSelector, saveMemory, type SaveArgs,
} from './memory';
import { registerChannel, type ChannelDef } from './channels/registry';
import { createAttachment, readTool } from './attachments';
import {
  addParticipant, listParticipants, removeParticipant,
} from './participants';
import { eraseOwnedSession, type SessionErasure } from './session-lifecycle';
import { createInitialTranscript } from './transcript';

/** Named agent wins; otherwise first memory-declaring agent (person memory
 *  resolves one store per spec decision 2). */
function memoryConfigFor(
  name?: string,
): { config?: ResolvedMemory; agent: string } {
  // Strict: fall-through once caused cross-agent data corruption silently.
  if (name) {
    const c = getAgent(name);
    if (!c) {
      throw new Error(`[10thfloor:agent] Agent.memory: unknown agent "${name}".`);
    }
    const r = resolveMemory(c.memory);
    if (!r) {
      throw new Error(
        `[10thfloor:agent] Agent.memory: agent "${name}" declares no \`memory\`, so it `
        + 'has no store. Add `memory` to its config, or omit the { agent } option to '
        + 'use the app\'s person store.',
      );
    }
    return { config: r, agent: name };
  }
  for (const [n, c] of listAgents()) {
    const r = resolveMemory(c.memory);
    if (r) return { config: r, agent: n };
  }
  return { agent: '' };
}

export class Agent {
  constructor(public readonly name: string, config?: AgentConfig) {
    if (config) this.define(config);
  }

  define(config: AgentConfig): this {
    defineAgent(this.name, config);
    return this;
  }

  /** Start a turn no person asked for (schedule, webhook, job).
   *  Idempotent via `key`; a busy session parks until idle. */
  async systemTurn(
    sessionId: string, prompt: string,
    opts?: { key?: string; agent?: string; source?: string },
  ): Promise<SystemTurnResult> {
    return startSystemTurn(sessionId, prompt, opts);
  }

  /** One question, one answer — throwaway session, inline turn, no trace.
   *  Rejects with `ask-parked` or `ask-failed` since headless callers
   *  cannot notice a stall. */
  async ask(text: string, opts?: { userId?: string | null }): Promise<string> {
    const config = getAgent(this.name);
    if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${this.name}`);
    const userId = opts?.userId ?? null;

    const sessionId = Random.id();
    // The same document `agent.start` builds, field for field: the loop, the
    // lease and the watcher all read this shape, and a throwaway that differs
    // from a real session would be a second shape to keep in step forever.
    const now = new Date();
    try {
      await createInitialTranscript({
        _id: sessionId, agent: this.name, userId,
        phase: 'idle', model: config.model, nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        // The throwaway marker: tools that would create standing state pointing
        // back at this session (compose's 'continue' pre-bind) read it and
        // refuse — the session is deleted in the finally below.
        ephemeral: true,
        createdAt: now, updatedAt: now,
      }, {
        _id: Random.id(), role: 'user', content: text, createdAt: now,
      });

      // Use the same Turn configuration as an interactive Session; only the
      // throwaway lifecycle differs.
      await runTurn(sessionId, buildRunConfig(config, userId));

      // runTurn records outcomes in session phase, never throws — shared
      // reader with subagent dispatch, each caller interprets differently.
      const outcome = await readTurnOutcome(sessionId);
      if (outcome.ok) return outcome.text;
      if (outcome.kind === 'gone') {
        throw new Meteor.Error('ask-failed', 'The throwaway session vanished.');
      }
      if (outcome.kind === 'parked') {
        throw new Meteor.Error(
          'ask-parked',
          `The turn is waiting for approval of "${outcome.toolName}", `
          + 'which a headless caller cannot give. Use an interactive session for '
          + 'ask-gated tools.',
        );
      }
      // The note's reason, already sanitized; the transcript that scrubbed it is
      // about to be deleted, so this is the only copy the caller ever sees.
      throw new Meteor.Error('ask-failed', outcome.reason);
    } finally {
      // Delete in reverse-read order so nothing points at a gone session.
      // Own try/catch: cleanup failure must not replace the caller's outcome.
      try {
        await eraseOwnedSession(this.name, sessionId, userId);
      } catch {
        console.error('[10thfloor:agent] ask() could not clean up its throwaway session');
      }
    }
  }

  /** Server-side send into an existing session — same core as the DDP method.
   *  `userId` defaults to null (anonymous owner), never "all sessions". */
  send(
    sessionId: string, text: string, opts?: { userId?: string | null },
  ): Promise<string> {
    return sendToSession(this.name, sessionId, text, opts?.userId ?? null);
  }

  /** Permanently erase one owned root Session and its subagent descendants.
   *  Server-only. `userId` is required; explicit null means anonymous owner.
   *  Memory and account-wide channel identities are preserved. */
  erase(
    sessionId: string, opts: { userId: string | null },
  ): Promise<SessionErasure> {
    return eraseOwnedSession(this.name, sessionId, opts.userId);
  }

  /** Server-side approve — same core as DDP method; racing answerers
   *  produce exactly one verdict. */
  async approve(sessionId: string, opts?: { userId?: string | null }): Promise<void> {
    await recordVerdict({ userId: opts?.userId ?? null }, this.name, sessionId, 'approved');
  }

  /** The deny half of `approve` — same core, same guarantees; `reason`
   *  reaches the model as the denied tool result. */
  async deny(
    sessionId: string, reason?: string, opts?: { userId?: string | null },
  ): Promise<void> {
    await recordVerdict({ userId: opts?.userId ?? null }, this.name, sessionId, 'denied', reason);
  }

  /** Branch a session at `atSeq` (clamped to batch-safe cut). Returns
   *  the new session's id; the fork is a new root with zeroed usage. */
  fork(
    sessionId: string,
    opts?: { atSeq?: number; title?: string; userId?: string | null },
  ): Promise<string> {
    return forkSessionById(this.name, sessionId, opts);
  }

  /** Manual compaction — skips the threshold, runs the same path as auto.
   *  Returns true if compacted, false if nothing worth compacting. */
  async compact(
    sessionId: string, opts?: { userId?: string | null },
  ): Promise<boolean> {
    const config = getAgent(this.name);
    if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${this.name}`);
    const selector: SessionQuery = {
      _id: sessionId, agent: this.name, erasingAt: { $exists: false },
    };
    if (opts && 'userId' in opts) selector.userId = opts.userId ?? null;
    const session = await AgentSessions.findOneAsync(selector);
    if (!session) throw new Meteor.Error('no-session', 'Session not found');

    // The session's OWN owner, not the caller's scope: a compaction runs the
    // agent's `instructions` and resolves its tools, and both must see the
    // identity every other entry into this session sees.
    const outcome = await compactSession(
      sessionId, buildRunConfig(config, session.userId),
    );
    // A spend-budget refusal has its own code — see `agent.compact` in methods.ts.
    if (outcome === 'over-budget') {
      throw new Meteor.Error('budget-exhausted', COMPACT_OVER_BUDGET);
    }
    const refusal = COMPACT_REFUSALS[outcome];
    if (refusal) throw new Meteor.Error('busy', refusal);
    if (outcome === 'gone') throw new Meteor.Error('no-session', 'Session not found');
    return outcome === 'compacted';
  }

  /** Per-agent hook — runs after globals, in registration order.
   *  Matched by name at run time, so define-order does not matter. */
  hook<N extends HookName>(name: N, fn: HookMap[N]): this {
    registerAgentHook(this.name, name, fn);
    return this;
  }

  /** Clear this agent's hooks only — test seam. */
  clearHooks(): void {
    clearAgentHooks(this.name);
  }

  /** Register a Meteor method + tool handle in one definition.
   *  Static: the method belongs to the app, any agent may list it. */
  static method(name: string, options: AgentMethodOptions): AdoptedTool {
    return defineAgentMethod(name, options);
  }

  /** Register an external channel (Slack, SMS, email) adapter.
   *  Webhook and egress worker are mounted at boot, not here. */
  static channel(kind: string, def: ChannelDef): void {
    registerChannel(kind, def);
  }

  /** File attachment surface — `create` for tool bodies (attach: true
   *  stages for the turn's reply), `readTool` for model reads. */
  static attachments = {
    create: createAttachment,
    readTool,
  };

  /** Session roster — server-only; joins are app-code decisions,
   *  never a DDP cap. 16-participant cap; owner cannot be removed. */
  static participants = {
    add: addParticipant,
    remove: removeParticipant,
    list: listParticipants,
  };

  /** Server-side memory access — unrestricted (no approval flow),
   *  because this is operator code, not a model. */
  static memory = {
    async save(
      userId: string | null,
      args: SaveArgs & { by?: string },
      opts?: { agent?: string },
    ) {
      const { config, agent } = memoryConfigFor(opts?.agent);
      if (!config) {
        throw new Error(
          '[10thfloor:agent] no agent in this app declares `memory`, so there is no '
          + 'memory store to write to.',
        );
      }
      // Agent-scope rows are keyed by the agent that owns them, so the caller
      // must SAY which — falling back to the first memory-declaring agent
      // filed the note under whoever happened to be defined first.
      if (args.scope === 'agent' && !opts?.agent) {
        throw new Error(
          '[10thfloor:agent] Agent.memory.save with scope "agent" needs the owning '
          + 'agent: Agent.memory.save(userId, args, { agent: "support" }).',
        );
      }
      return saveMemory(args, {
        by: args.by ?? 'app', userId, agent, config,
      });
    },
    async list(userId: string | null, opts?: { agent?: string }) {
      const { config, agent } = memoryConfigFor(opts?.agent);
      if (!config) return [];
      const sel = readSelector(config.scopes, userId, agent);
      if (!sel) return [];
      return AgentMemories.find(sel as any, { sort: { at: -1 } }).fetchAsync();
    },
    async forget(userId: string | null, id: string, opts?: { agent?: string }) {
      const { agent } = memoryConfigFor(opts?.agent);
      return forgetMemory(id, { userId, agent, allowApp: true });
    },
  };

  /** Register a named provider so configs can reference it by string.
   *  Resolved lazily on first turn, not at define() time. */
  static provider(name: string, impl: Provider): void {
    registerProvider(name, impl);
  }

  /** Register an MCP server as a tool source — validated here,
   *  connected lazily on first turn that needs it. */
  static mcpServer(name: string, def: McpServerDef): void {
    registerMcpServer(name, def);
  }

  /** Global hook — runs before per-agent hooks, in registration order.
   *  Unknown names throw here; a throwing hook is skipped, not fatal. */
  static hook<N extends HookName>(name: N, fn: HookMap[N]): void {
    registerHook(name, fn);
  }

  /** Clear all hooks (global + per-agent) — test seam. */
  static clearHooks(): void {
    clearHooks();
  }
}

export type { AgentConfig, SessionErasure };
