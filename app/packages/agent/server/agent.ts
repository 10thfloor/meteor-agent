import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import {
  defineAgent, getAgent, buildSystemPrompt, resolveBudget, type AgentConfig,
} from './registry';
import { runTurn } from './loop';
import { piAiProvider } from './providers/piai';
import { defineAgentMethod, type AdoptedTool, type AgentMethodOptions } from './tools';

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
   * Composition is the reason this is worth more than a bare provider call: an
   * agent's `ask` is a legal tool body, so one agent becomes another's
   * specialist and inherits the whole harness — the registry config, the tool
   * loop, budgets, retries, compaction — instead of a hand-rolled second
   * client.
   *
   *   const Researcher = new Agent('researcher', { … });
   *   new Agent('writer', {
   *     tools: [{
   *       name: 'research', description: 'Look something up', args: schema,
   *       run: ({ topic }, ctx) => Researcher.ask(topic, { userId: ctx.userId }),
   *     }],
   *     …
   *   });
   *
   * The nested run is a session of its own (its own id, its own lease, its own
   * budget accounting), so the outer turn's tool-call budget limits how many
   * times the inner agent is consulted and the inner agent's own budget limits
   * what each consultation may spend.
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
      await runTurn(sessionId, {
        model: config.model,
        system: buildSystemPrompt(config, { userId }),
        tools: config.tools ?? [],
        provider: config.provider ?? piAiProvider(),
        maxIterations: config.maxIterations,
        budget: resolveBudget(config.budget),
        pricing: config.pricing,
        retry: config.retry,
        context: config.context,
      });

      // `runTurn` never throws for a turn that merely ended badly — it records
      // the outcome in the session's terminal phase and a structured note. So
      // the phase, not a rejection, is what this reads.
      const session = await AgentSessions.findOneAsync(sessionId);
      if (!session) throw new Meteor.Error('ask-failed', 'The throwaway session vanished.');

      if (session.phase === 'awaiting') {
        throw new Meteor.Error(
          'ask-parked',
          `The turn is waiting for approval of "${session.pending?.name ?? 'a tool'}", `
          + 'which a headless caller cannot give. Use an interactive session for '
          + 'ask-gated tools.',
        );
      }
      if (session.phase === 'error' || session.phase === 'stopped') {
        // The note carries the reason the transcript would have shown a user;
        // the transcript is about to be deleted, so the reason has to travel
        // out on the error instead. `kind: 'budget'` for a stop, `kind: 'error'`
        // for a provider failure — read the last note either way.
        const note = await AgentMessages.findOneAsync(
          { sessionId, role: 'note', kind: { $in: ['budget', 'error'] } } as any,
          { sort: { seq: -1 } },
        );
        throw new Meteor.Error(
          'ask-failed',
          (note as any)?.error?.reason ?? 'The turn did not complete.',
        );
      }

      // The LAST assistant row, not the last one that happens to carry text: an
      // earlier iteration's chatter is not the answer to the question, and a
      // turn that ended without producing one (`maxIterations` exhausted
      // mid-batch, or a model that emitted only tool calls) has no answer to
      // give. Returning '' would look like one.
      const reply = await AgentMessages.findOneAsync(
        { sessionId, role: 'assistant' } as any,
        { sort: { seq: -1 } },
      );
      if (!reply?.content) {
        throw new Meteor.Error('ask-failed', 'The turn produced no reply.');
      }
      return reply.content;
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
}

export type { AgentConfig };
