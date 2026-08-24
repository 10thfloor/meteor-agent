import type { AgentSession, ResolvedMemory, SessionInc } from '../common/types';
import type { SessionQuery } from '../common/db';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import {
  AgentDeltas, AgentMemories, AgentMessages, AgentSessions,
} from '../common/collections';
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
import { recordVerdict, sendToSession } from './methods';
import {
  forgetMemory, readSelector, saveMemory, type SaveArgs,
} from './memory';
import { registerChannel, type ChannelDef } from './channels/registry';
import { AgentAttachments, createAttachment, readTool } from './attachments';
import {
  addParticipant, listParticipants, removeParticipant,
} from './participants';

/** Which memory config governs a server-side `Agent.memory` call. Named agent
 *  wins; otherwise the first memory-declaring agent, because person memory
 *  follows the HUMAN and every memory-declaring agent resolves the same store
 *  (spec decision 2). */
function memoryConfigFor(
  name?: string,
): { config?: ResolvedMemory; agent: string } {
  if (name) {
    const c = getAgent(name);
    const r = c ? resolveMemory(c.memory) : undefined;
    if (r) return { config: r, agent: name };
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
      // The throwaway marker: tools that would create standing state pointing
      // back at this session (compose's 'continue' pre-bind) read it and
      // refuse — the session is deleted in the finally below.
      ephemeral: true,
      createdAt: new Date(), updatedAt: new Date(),
    });

    try {
      // Atomic seq allocation, exactly as `agent.send` does it — one
      // `findOneAndUpdate` rather than read-then-insert. Nothing else can be
      // writing to a session id that has not left this function yet, but the
      // shape is shared on purpose: the allocation rule is the transcript's
      // ordering invariant, and having one path in the package that does it
      // differently is how the next reader concludes it is optional.
      //
      // `sendToSession`'s `budgetSpent.turns: { $lt: … }` filter is deliberately NOT
      // here: this session has never sent, `budget.turns` is validated to be a
      // positive integer, so the filter could only ever match. The `$inc` still
      // runs so the accounting a nested run inherits is the real one.
      const before = await AgentSessions.rawCollection().findOneAndUpdate(
        { _id: sessionId },
        { $inc: { nextSeq: 1, 'budgetSpent.turns': 1 } satisfies SessionInc, $set: { updatedAt: new Date() } },
        { returnDocument: 'before' },
      ) as unknown as AgentSession | null;
      if (!before) throw new Meteor.Error('ask-failed', 'The throwaway session vanished.');

      await AgentMessages.insertAsync({
        _id: Random.id(), sessionId, seq: before.nextSeq, role: 'user',
        content: text, createdAt: new Date(),
      });

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
        // A tool may have staged files into the attachment store; a throwaway
        // session's bytes must not outlive its transcript.
        await AgentAttachments.removeAsync({ sessionId });
        await AgentSessions.removeAsync({ _id: sessionId });
      } catch (e) {
        console.error(
          `[10thfloor:agent] ask() could not clean up throwaway session ${sessionId}:`, e,
        );
      }
    }
  }

  /**
   * Send a message into an EXISTING session and wake a turn — the server-side
   * form of `agent.send` (channels spec §5.1). A channel webhook, a cron job,
   * or another agent calls this with a RESOLVED identity; the DDP method is a
   * cap over the identical core, `sendToSession` (methods.ts), so both run on
   * the same terms — authorization, the budget folded into the atomic seq
   * allocation, and the one `deferTurn` wake path.
   *
   * `userId` scopes the lookup, always three-field (`{_id, agent, userId}`):
   * an omitted one defaults to null and scopes to the ANONYMOUS owner — never
   * to "all sessions" — so the fail-closed guarantee needs no presence test
   * here. `userId: null` is a real owner (the capability-URL session), not
   * "denied".
   *
   * Note the DDP rate limiter does not see this path (its rules match method
   * names); the session budget does — it is enforced inside the core. A
   * server-side caller reachable from outside traffic must bring its own
   * throttle, as the channel webhook does (§9).
   */
  send(
    sessionId: string, text: string, opts?: { userId?: string | null },
  ): Promise<string> {
    return sendToSession(this.name, sessionId, text, opts?.userId ?? null);
  }

  /**
   * Answer a parked approval — the server-side form of `agent.approve`
   * (channels spec §5.1). The same core the DDP method caps: ownership check,
   * the agent's own `approve` predicate, the single-winner verdict write, the
   * audit note, and the wake. Two answerers racing — a webhook and a human,
   * two webhooks — produce exactly one verdict; the loser gets `no-pending`.
   */
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
   * §9's compaction, run NOW — regardless of the `context.compactAt` threshold,
   * which is the entire point of a manual call. Resolves true when a
   * `kind:'compaction'` note was committed, false when there was nothing worth
   * compacting (fewer than `context.keep` messages past the last note, or no
   * legal cut point).
   *
   * `Meteor.Error('busy')` when a turn is running or the session is leased: a
   * compaction writes to the transcript exactly as a turn does, so the two must
   * not overlap. Wait for `status()` to be `idle` and call again. The same
   * `busy` — with its own `reason` — refuses a session that is `awaiting` an
   * approval or sitting in `error`: both are decisions a person makes, and
   * compaction is bookkeeping that must not overwrite either (see
   * `compactSession`).
   *
   * The threshold is the only thing skipped. Everything else is the automatic
   * path: the same batch-safe cut, the same summarizer prompt through the same
   * `beforeProviderRequest` hook (`ctx.purpose === 'compaction'`), the same
   * usage and cost accrual — and the same silent degrade when the summarization
   * fails, which surfaces here as `false`.
   *
   * `userId` scopes the lookup for a server-side caller acting on someone's
   * behalf, exactly as `fork`'s does.
   */
  async compact(
    sessionId: string, opts?: { userId?: string | null },
  ): Promise<boolean> {
    const config = getAgent(this.name);
    if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${this.name}`);
    const selector: SessionQuery = { _id: sessionId, agent: this.name };
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

  /**
   * Register a hook for THIS AGENT only — the per-agent half of the extension
   * surface (server/hooks.ts owns the whole contract).
   *
   *   Support.hook('beforeProviderRequest', (req) => ({
   *     ...req, system: `${req.system}\n\n${supportPlaybook()}`,
   *   }));
   *
   * Identical seams, identical failure handling; the only difference is scope.
   * It runs when the session's agent is this one — a CHILD session reports the
   * CHILD's agent, so a subagent's hooks are the subagent's, not its parent's.
   *
   * ORDER: every `Agent.hook` (global) runs first, in registration order, then
   * every hook registered here, in registration order. Specificity, not
   * privilege: an agent's own hook refines the process-wide policy and gets the
   * last word, exactly as a later global hook refines an earlier one.
   *
   * The agent need not be `define()`d yet — hooks are matched by name at run
   * time, so registration order across server files does not matter.
   */
  hook<N extends HookName>(name: N, fn: HookMap[N]): this {
    registerAgentHook(this.name, name, fn);
    return this;
  }

  /**
   * Remove THIS agent's hooks, leaving the global ones and every other agent's
   * alone. The narrow counterpart of `Agent.clearHooks()`, and a test seam for
   * the same reason.
   */
  clearHooks(): void {
    clearAgentHooks(this.name);
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
   * Register a CHANNEL — an external surface (Slack, SMS, email) as an adapter
   * over the existing machinery (channels spec §10). STATIC and GLOBAL like
   * `Agent.provider`, and the same registry contract: validated cheaply here,
   * overwrite-with-warning on re-registration so a dev hot reload does not
   * throw.
   *
   *   // Tier 1 (§8.7): a channel package's factory builds the definition —
   *   import { sms } from 'meteor/10thfloor:agent-channel-sms';
   *   Agent.channel('sms', sms({
   *     agent: 'support', accountSid, authToken, webhookUrl,
   *   }));
   *
   *   // — which is sugar over a plain ChannelDef: one lens ({ out, in }),
   *   // one transport, one profile, the webhook's verify/parse, and the
   *   // knobs (statuses, onUncertainDelivery, sessionUrl, linkUrl, throttle).
   *
   * Registration is inert by itself: the boot wiring (server/index.ts) mounts
   * the webhook at `/agent/channels/<kind>` on EVERY instance, and starts the
   * egress worker — the worker alone gated per kind by
   * `settings.channels.<kind> !== false` — both skipped under test; the worker
   * follows the watcher's boot contract.
   */
  static channel(kind: string, def: ChannelDef): void {
    registerChannel(kind, def);
  }

  /**
   * The attachment surface (email v2 spec §7/§8) — STATIC like `Agent.method`,
   * because files belong to sessions, not to one agent instance.
   *
   * `create` is an API for TOOL BODIES, never a model surface: a tool that
   * builds a report calls it with `ctx.sessionId` (and `ctx.toolCallId` for
   * crash-safe idempotency), gets back a ref, and `attach: true` stages the
   * file for the turn's reply — the loop claims staged refs at the turn-final
   * commit and the reply becomes a file-bearing message.
   *
   *   const ref = await Agent.attachments.create({
   *     sessionId: ctx.sessionId, name: 'summary.csv', contentType: 'text/csv',
   *     content: csvText, attach: true, toolCallId: ctx.toolCallId,
   *   });
   *
   * `readTool` is the one shipped tool — list it in `tools` like any inline
   * spec (nothing auto-registers): the model reads a ref's content by id,
   * session-scoped, text inline and binary as a structured refusal.
   */
  static attachments = {
    create: createAttachment,
    readTool,
  };

  /**
   * The roster surface (participants spec §4.1) — STATIC like
   * `Agent.attachments`, because membership belongs to sessions, not to one
   * agent instance, and SERVER-ONLY by design: joins are app-code decisions
   * (an invite flow, compose's policy-gated recipient), never a DDP cap. The
   * app that wants a UI for it writes its own owner-gated method over these.
   *
   *   await Agent.participants.add(sessionId, {
   *     id: 'h:'+inviteeId, kind: 'human', role: 'member',
   *     userId: inviteeId, displayName: 'Dana',
   *   }, { by: 'h:'+ownerId });
   *   await Agent.participants.add(sessionId, {
   *     id: 'm:analyst', kind: 'model', role: 'member', agent: 'analyst',
   *   });
   *
   * `add` seeds the roster (owner + primary model) on first join, adopts an
   * existing id, and refuses past the 16-participant cap. `remove` refuses
   * the owner (ownership transfer is a named open question) and is what makes
   * ingress stop admitting the identity — admission reads the roster.
   */
  static participants = {
    add: addParticipant,
    remove: removeParticipant,
    list: listParticipants,
  };

  /**
   * The app's own way into the memory store (memory spec §5).
   *
   * UNRESTRICTED where the DDP methods are not: this is server code, not a
   * client, so it may write shared work memory directly — seeding an app's
   * institutional knowledge at startup is exactly the case the approval flow
   * exists to govern for MODELS, not for the operator who owns the deployment.
   *
   * `Agent.memory.save(null, …)` (or `scope: 'app'`) writes the shared pool;
   * `Agent.memory.list(null)` reads it.
   */
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

  /**
   * Register a provider implementation under a NAME, so a config can say
   * `provider: 'name'` instead of holding the implementation.
   *
   *   Agent.provider('mock', mockProvider(() => ({ text: 'hi' })));
   *   Support.define({ model: 'mock', instructions: '…', provider: 'mock' });
   *
   * STATIC and GLOBAL, like `Agent.method`, `Agent.mcpServer` and `Agent.hook`:
   * a provider belongs to the process, and any number of agents may name one.
   *
   * Two things it buys. An agent config can live in an ISOMORPHIC file — the
   * string names a server-only implementation without importing it into the
   * client bundle. And a deployment swaps its backend behind one registration
   * rather than editing every agent: a custom provider is also the third way to
   * avoid pi-ai entirely (the other two being `mockProvider` and passing an
   * implementation inline), which is what makes the npm peer genuinely
   * optional.
   *
   * Resolution happens on the first TURN, not at `define()`: agents and
   * providers register in whatever order their server files load, so an unknown
   * name throws when a turn needs it, naming what was asked for and what is
   * registered. Re-registering a name overwrites it with one warning — that is
   * a dev hot reload, and refusing it would turn an ordinary edit into a
   * startup failure.
   */
  static provider(name: string, impl: Provider): void {
    registerProvider(name, impl);
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
   * installed into the process, not into one agent. For one agent's own hooks
   * use the INSTANCE form, `agentInstance.hook(name, fn)` — every global hook
   * runs first, then that agent's.
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
   * Remove every registered hook — GLOBAL AND PER-AGENT. A TEST SEAM: hooks are
   * registered once at startup in an app, so the only caller with a reason to
   * clear them is a test that must not leak one into the next test's turn (call
   * it in a `finally`). It clears both scopes so that "no hook survives this
   * call" keeps meaning exactly that; `agentInstance.clearHooks()` is the narrow
   * form that clears one agent's.
   */
  static clearHooks(): void {
    clearHooks();
  }
}

export type { AgentConfig };
