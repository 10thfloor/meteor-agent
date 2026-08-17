import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import {
  defineAgent, getAgent, buildRunConfig, type AgentConfig,
} from './registry';
import { runTurn } from './loop';
import { forkSessionById } from './fork';
import { readTurnOutcome } from './subagent';
import { defineAgentMethod, type AdoptedTool, type AgentMethodOptions } from './tools';
import { registerMcpServer, type McpServerDef } from './mcp/client';
import { clearHooks, registerHook, type HookMap, type HookName } from './hooks';

export class Agent {
  constructor(public readonly name: string, config?: AgentConfig) {
    if (config) this.define(config);
  }

  define(config: AgentConfig): this {
    defineAgent(this.name, config);
    return this;
  }

  /**
   * §5.4. One question, one answer, no session to manage — and the way agents
   * COMPOSE.
   *
   * The whole conversational surface (`start`/`send`/`subscribe`) exists for a
   * human watching a transcript. A caller that just needs an answer — a cron
   * job, a webhook, a Meteor method, or ANOTHER AGENT — has no UI to stream to
   * and nobody to answer an approval. So this creates a throwaway session,
   * runs exactly one turn INLINE (awaited, not `Meteor.defer`red, because the
   * caller is waiting on the string), reads the final assistant message, and
   * deletes every trace of the session before returning.
   *
   * An agent's `ask` is also a legal tool body, so one agent can be another's
   * specialist with no extra machinery. For agent COMPOSITION, though, prefer a
   * `{ subagent }` tool spec: it runs the same nested turn but keeps the child
   * session — a live transcript a client can subscribe to, and one a human can
   * still answer if it parks. `ask` is for the headless one-shot case, where
   * there is nothing to watch and nothing to keep.
   *
   * It REJECTS rather than returning a half-answer, because a headless caller
   * has no way to notice a stalled one:
   *   - `ask-parked` — the turn hit a `gate: 'ask'` tool. There is no human on
   *     this call path to approve it, and `approve`/`deny` need a session that
   *     is about to be deleted. Give an ask-gated tool to an interactive agent,
   *     not to one you `ask`.
   *   - `ask-failed` — the provider failed terminally (§10), or a budget
   *     stopped the run (§9, `reason` names which one), or the turn produced no
   *     assistant message at all.
   *
   * `userId` is what the agent's `instructions` function and every tool's
   * `ctx.userId` see. It defaults to null — the same anonymous owner an
   * unauthenticated capability-URL session has — so a cron job need not invent
   * one.
   */
  async ask(text: string, opts?: { userId?: string | null }): Promise<string> {
    const config = getAgent(this.name);
    if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${this.name}`);
    const userId = opts?.userId ?? null;

    const sessionId = Random.id();
    // The same document `agent.start` builds, field for field: the loop, the
    // lease and the watcher all read this shape, and a throwaway that differs
    // from a real session would be a second shape to keep in step forever.
    await AgentSessions.insertAsync({
      _id: sessionId, agent: this.name, userId,
      phase: 'idle', model: config.model, nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);

    try {
      // Atomic seq allocation, exactly as `agent.send` does it — one
      // `findOneAndUpdate` rather than read-then-insert. Nothing else can be
      // writing to a session id that has not left this function yet, but the
      // shape is shared on purpose: the allocation rule is the transcript's
      // ordering invariant, and having one path in the package that does it
      // differently is how the next reader concludes it is optional.
      //
      // `mSend`'s `budgetSpent.turns: { $lt: … }` filter is deliberately NOT
      // here: this session has never sent, `budget.turns` is validated to be a
      // positive integer, so the filter could only ever match. The `$inc` still
      // runs so the accounting a nested run inherits is the real one.
      const before = await AgentSessions.rawCollection().findOneAndUpdate(
        { _id: sessionId },
        { $inc: { nextSeq: 1, 'budgetSpent.turns': 1 }, $set: { updatedAt: new Date() } },
        { returnDocument: 'before' },
      );
      if (!before) throw new Meteor.Error('ask-failed', 'The throwaway session vanished.');

      await AgentMessages.insertAsync({
        _id: Random.id(), sessionId, seq: (before as any).nextSeq, role: 'user',
        content: text, createdAt: new Date(),
      } as any);

      // The identical `RunConfig` `deferTurn` assembles — same registry config,
      // same pi-ai fallback resolved at run time rather than at define() time,
      // same parsed budget. A headless turn that ran under different terms than
      // an interactive one would make `ask` untestable as a proxy for `send`.
      await runTurn(sessionId, buildRunConfig(config, userId));

      // `runTurn` never throws for a turn that merely ended badly — it records
      // the outcome in the session's terminal phase and a structured note. So
      // the phase, not a rejection, is what `readTurnOutcome` reads. Shared with
      // subagent dispatch, which reads the same states and reaches the OPPOSITE
      // conclusion about a park (its child session survives and a human can
      // still answer it), which is why the reader returns facts and each caller
      // writes its own sentence.
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
      // The throwaway must not survive its answer — not on the happy path, not
      // on a park, not on a provider failure, and not on an exception from
      // anywhere above. Deltas first, then messages, then the session itself:
      // the reverse of the order a reader would follow, so nothing is ever left
      // pointing at a session document that is already gone.
      //
      // Its own try/catch because a cleanup failure must not REPLACE the
      // outcome: a caller owed `ask-parked` learning about a Mongo hiccup
      // instead would be told the wrong thing about their own request. The leak
      // is logged loudly enough for an operator to find.
      try {
        await AgentDeltas.removeAsync({ sessionId });
        await AgentMessages.removeAsync({ sessionId });
        await AgentSessions.removeAsync({ _id: sessionId });
      } catch (e) {
        console.error(
          `[10thfloor:agent] ask() could not clean up throwaway session ${sessionId}:`, e,
        );
      }
    }
  }

  /**
   * Branch a session into a new one that shares its history up to a point, and
   * diverges from there. Returns the NEW session's id.
   *
   * `atSeq` is clamped DOWN to the nearest batch-safe cut point, so a caller
   * can pass the seq of any row — including a tool row in the middle of a
   * batch — without producing a transcript that strands a `tool_use`. It
   * defaults to the last message: fork the whole conversation.
   *
   * The fork is a new ROOT conversation owned by the source's owner, listed by
   * `agent.sessions` like any other, with zeroed usage and budgets and no
   * lease. It remembers where it came from in `forkedFrom` and nothing else —
   * see `forkSession` for the field-by-field reasoning.
   *
   * `userId` scopes the lookup for a server-side caller acting on behalf of
   * someone (a method, a job): give it and a session belonging to anyone else
   * is `no-session`. Omit it and the source's own owner is used, which is what
   * a direct server call wants.
   */
  fork(
    sessionId: string,
    opts?: { atSeq?: number; title?: string; userId?: string | null },
  ): Promise<string> {
    return forkSessionById(this.name, sessionId, opts);
  }

  /**
   * §6. Register a Meteor method and get a tool handle for it in one
   * definition — see `defineAgentMethod`. STATIC because a co-registered method
   * belongs to the app, not to one agent: any number of agents may list the
   * handle it returns (or the bare method name), and your UI calls it directly.
   *
   *   const lookup = Agent.method('orders.lookup', { description, args, run });
   *   Support.define({ ..., tools: [lookup] });
   *   await Meteor.callAsync('orders.lookup', { id });   // same schema, same check
   */
  static method(name: string, options: AgentMethodOptions): AdoptedTool {
    return defineAgentMethod(name, options);
  }

  /**
   * Register an MCP server as a tool source. STATIC for the same reason
   * `Agent.method` is: a server belongs to the app, and any number of agents
   * may list tools from it.
   *
   *   Agent.mcpServer('docs', { command: 'npx', args: ['-y', 'mcp-server-docs'] });
   *   Support.define({ ..., tools: [
   *     { mcp: { server: 'docs', tool: 'search' } },  // one tool
   *     { mcp: { server: 'docs' } },                  // all of them
   *   ] });
   *
   * Nothing is spawned here. The definition is validated (a bad command is a
   * startup error) and the server is connected lazily, at most once per
   * process, by the first turn that needs it.
   */
  static mcpServer(name: string, def: McpServerDef): void {
    registerMcpServer(name, def);
  }

  /**
   * Register a hook — the package's extension surface, and the replacement for
   * Pi's extension API (see server/hooks.ts for the whole contract).
   *
   *   Agent.hook('beforeProviderRequest', (req, ctx) => ({
   *     ...req, system: `${req.system}\n\nToday is ${new Date().toDateString()}.`,
   *   }));
   *   Agent.hook('afterToolResult', (result) => redact(result));
   *
   * STATIC and GLOBAL, like `Agent.method` and `Agent.mcpServer`: a hook is
   * installed into the process, not into one agent. Every hook's `ctx` carries
   * the agent name, so a per-agent hook is one `if` away — and per-agent
   * REGISTRATION is a v3 candidate, not an omission.
   *
   * Hooks run in registration order, each seeing the previous one's output.
   * Returning nothing keeps the value; returning a replacement swaps it. A hook
   * that throws is skipped with one warning — a broken extension must not kill
   * turns. An unknown hook name throws HERE, at registration, rather than
   * silently never running.
   */
  static hook<N extends HookName>(name: N, fn: HookMap[N]): void {
    registerHook(name, fn);
  }

  /**
   * Remove every registered hook. A TEST SEAM: hooks are global and registered
   * once at startup in an app, so the only caller with a reason to clear them
   * is a test that must not leak one into the next test's turn (call it in a
   * `finally`).
   */
  static clearHooks(): void {
    clearHooks();
  }
}

export type { AgentConfig };
