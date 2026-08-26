import { Meteor } from 'meteor/meteor';
import { Agent } from '../server/agent';
import { mockProvider } from '../server/providers/mock';
import type { Provider } from '../server/providers/types';
import { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';

/**
 * Server half of the live DDP round trip. No describe/it blocks: this file is
 * the FIXTURE the browser-side tests in `integration.client.ts` and
 * `element.client.ts` talk to. It registers agents backed by the scripted
 * provider (no API key, no network) and a reset method so the client half
 * starts from a clean transcript.
 */
const AGENT = 'itest';
/** A SECOND agent rather than a gate bolted onto the first: the streaming test
 *  wants a turn that runs straight through, and the approval test wants one
 *  that parks. Two registrations keep both fixtures honest instead of making
 *  one agent behave two ways depending on the prompt. */
const GATED = 'itest-gate';

/**
 * Put a wall-clock gap between chunks.
 *
 * `mockProvider` yields its characters in one synchronous burst, so the whole
 * turn — stream, delta flush, commit — lands inside a few milliseconds and the
 * browser only ever observes the FINISHED transcript. That would make the
 * round trip prove far less than it appears to: `mergeView` suppresses deltas
 * whose messageId is already committed, so a publication that never delivered
 * a single delta document, or a `Tracker.autorun` that only recomputed when a
 * committed message arrived, would both still pass. Pacing the stream holds
 * the session in `streaming` long enough (~2s) for the client to catch the
 * in-flight row and assert the delta path carried `msgSeq` correctly.
 */
function paced(inner: Provider, delayMs: number): Provider {
  return {
    async *stream(req) {
      for await (const chunk of inner.stream(req)) {
        if (chunk.kind !== 'done') {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        yield chunk;
      }
    },
  };
}

new Agent(AGENT, {
  model: 'mock',
  instructions: 'You are a test agent.',
  tools: [],
  provider: paced(mockProvider(() => ({ text: 'live streamed reply' })), 110),
});

/**
 * The gated fixture: turn one asks for `refund`, which parks on its `gate:
 * 'ask'`; whatever verdict the browser clicks resolves the call, and turn two
 * (recognizable by the tool result now in the request) answers in words rather
 * than asking again — a script that always returned the tool call would loop
 * until the turn budget stopped it.
 */
new Agent(GATED, {
  model: 'mock',
  instructions: 'You are a test agent.',
  tools: [{
    name: 'refund',
    description: 'Refund an order.',
    gate: 'ask',
    // The escalation the approval bar has to announce: the browser half asserts
    // the rendered "runs as" line, which is the only end-to-end proof that
    // `pending.runAs` survives the park, the publication and the render.
    runAs: 'refund-service',
    args: { type: 'object', properties: {} },
    run: async () => ({ refunded: true, amount: 42 }),
  }],
  provider: mockProvider((req) => (
    req.messages.some((m) => m.role === 'tool')
      ? { text: 'all done' }
      : { toolCalls: [{ id: 'gate-1', name: 'refund', args: { order: 'A-1' } }] }
  )),
});

Meteor.methods({
  async 'itest.reset'() {
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
  },
  /**
   * How many sessions exist, per agent — the probe the element's
   * attribute-churn test counts starts with.
   *
   * An ORPHANED auto-start is invisible from the client: the element's
   * generation guard drops the resolved session id, so the only evidence that a
   * session was created at all is on the server. Hence a probe rather than an
   * assertion on the element.
   */
  async 'itest.sessionCounts'() {
    const rows = await AgentSessions.find({}, { fields: { agent: 1 } }).fetchAsync();
    const counts: Record<string, number> = {};
    for (const s of rows) counts[s.agent] = (counts[s.agent] ?? 0) + 1;
    return counts;
  },
  /** Claim an anonymous fixture while its browser subscription is live. The
   *  publication must retract the transcript immediately, not on reconnect. */
  async 'itest.claimAnonymous'(sessionId: string) {
    return AgentSessions.updateAsync(
      { _id: sessionId, userId: null },
      { $set: { userId: 'claimed-by-test' } },
    );
  },
  /** Give the one browser DDP connection a stable test identity. This is a
   *  fixture-only equivalent of an accounts login, without adding accounts to
   *  the package test app. */
  'itest.setUserId'(userId: string | null) {
    if (userId !== null && typeof userId !== 'string') throw new Meteor.Error('bad-user');
    this.setUserId(userId);
  },
  /** Move a session owned by the current test user under another owner while
   *  retaining access through the human-participant roster selector. */
  async 'itest.makeCurrentUserParticipant'(sessionId: string) {
    if (!this.userId) throw new Meteor.Error('not-authorized');
    return AgentSessions.updateAsync(
      { _id: sessionId, userId: this.userId },
      {
        $set: {
          userId: 'other-test-owner',
          participants: [{
            id: `h:${this.userId}`,
            kind: 'human',
            role: 'member',
            userId: this.userId,
            displayName: 'Live test member',
            joinedAt: new Date(),
          }],
        },
      },
    );
  },
  /** Remove the caller from the roster while its publication is live. */
  async 'itest.removeCurrentParticipant'(sessionId: string) {
    if (!this.userId) throw new Meteor.Error('not-authorized');
    return AgentSessions.updateAsync(
      { _id: sessionId, userId: 'other-test-owner' },
      { $pull: { participants: { kind: 'human', userId: this.userId } } } as any,
    );
  },
});
