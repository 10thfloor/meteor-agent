import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Random } from 'meteor/random';
import { NAMES } from '../common/names';
import { AgentMessages, AgentSessions } from '../common/collections';
import { getAgent, buildSystemPrompt } from './registry';
import { runTurn } from './loop';
import { piAiProvider } from './providers/piai';

/**
 * Authorize BEFORE acting, on every method that touches an existing session.
 *
 * Scoped by `agent` as well as `userId`, matching the `agent.session`
 * publication's filter exactly. Without the agent scope, `Agent('a').send(id)`
 * would run agent A's model, system prompt and tools against a transcript the
 * session document says belongs to agent B — a session the same caller cannot
 * even subscribe to under that name. Same-user only, so not a disclosure bug,
 * but the two halves of the API must agree on what a session is.
 *
 * The error is deliberately identical for "no such session" and "not yours":
 * distinguishing them would confirm the existence of another user's session id.
 */
async function requireSession(agent: string, sessionId: string, userId: string | null) {
  const session = await AgentSessions.findOneAsync({ _id: sessionId, agent, userId } as any);
  if (!session) throw new Meteor.Error('no-session', 'Session not found');
  return session;
}

export function registerMethods(): void {
  Meteor.methods({
    async [NAMES.mStart](this: any, agent: string, opts?: { title?: string }) {
      check(agent, String);
      check(opts, Match.Maybe({ title: Match.Maybe(String) }));
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      const _id = Random.id();
      await AgentSessions.insertAsync({
        _id, agent, userId: this.userId ?? null, title: opts?.title,
        phase: 'idle', model: config.model, nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        createdAt: new Date(), updatedAt: new Date(),
      } as any);
      return _id;
    },

    async [NAMES.mSend](this: any, agent: string, sessionId: string, text: string) {
      check(agent, String);
      check(sessionId, String);
      check(text, String);
      const config = getAgent(agent);
      if (!config) throw new Meteor.Error('no-agent', `Unknown agent: ${agent}`);
      await requireSession(agent, sessionId, this.userId ?? null);

      // Seq allocation is ATOMIC (single findOneAndUpdate), not read-then-
      // insert. A read-then-insert here races the in-flight turn loop: both
      // read the same nextSeq and the user message lands on the same seq the
      // assistant is about to commit at, making transcript order
      // non-deterministic. The loop allocates its seqs the same way.
      const before = await AgentSessions.rawCollection().findOneAndUpdate(
        { _id: sessionId },
        {
          $inc: { nextSeq: 1, 'budgetSpent.turns': 1 },
          $set: { updatedAt: new Date() },
        },
        { returnDocument: 'before' },
      );
      if (!before) throw new Meteor.Error('no-session', 'Session not found');

      await AgentMessages.insertAsync({
        _id: Random.id(), sessionId, seq: (before as any).nextSeq, role: 'user',
        content: text, createdAt: new Date(),
      } as any);

      // A new message is the resume signal after an interrupt OR a provider
      // failure: both `stopped` and `error` are durable (the loop refuses to
      // run while either stands, and its `finally` preserves both), so the
      // send is what clears them — matching §10's "the model usually
      // recovers" philosophy for `error`. Conditional on the current phase so
      // a send during a live turn does not stomp `streaming`.
      await AgentSessions.updateAsync(
        { _id: sessionId, phase: { $in: ['stopped', 'error'] } } as any,
        { $set: { phase: 'idle' } } as any,
      );

      const userId = this.userId ?? null;
      // Return immediately; the client watches the subscription for output.
      Meteor.defer(() => {
        // The .catch is load-bearing, not decoration. Milestone 1 deliberately
        // lets a provider error propagate out of runTurn (retry, backoff and
        // the `error` note are Milestone 2), and an unhandled rejection is
        // fatal by default on Node >= 15 — so a bare `void runTurn(...)` would
        // let one bad provider call take down the whole app server.
        runTurn(sessionId, {
          model: config.model,
          system: buildSystemPrompt(config, { userId }),
          tools: config.tools ?? [],
          // `provider` is optional as of Milestone 2: an agent that names none
          // streams through pi-ai. Resolved HERE rather than at define() time
          // so defineAgent stays a pure registration and pi-ai is loaded only
          // when a turn actually runs.
          provider: config.provider ?? piAiProvider(),
          maxIterations: config.maxIterations,
        }).catch((e) => {
          console.error(`[10thfloor:agent] turn failed for session ${sessionId}:`, e);
        });
      });
      return sessionId;
    },

    async [NAMES.mInterrupt](this: any, agent: string, sessionId: string) {
      check(agent, String);
      check(sessionId, String);
      await requireSession(agent, sessionId, this.userId ?? null);
      // The loop's `finally` preserves a `stopped` phase rather than idling it
      // back, so this survives the in-flight turn winding down.
      await AgentSessions.updateAsync(sessionId, {
        $set: { phase: 'stopped', updatedAt: new Date() },
      } as any);
    },
  });
}
