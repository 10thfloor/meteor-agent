import { Meteor } from 'meteor/meteor';
import { Agent } from '../server/agent';
import { mockProvider } from '../server/providers/mock';
import type { Provider } from '../server/providers/types';
import { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';

/**
 * Server half of the live DDP round trip. No describe/it blocks: this file is
 * the FIXTURE the browser-side test in `integration.client.ts` talks to. It
 * registers an agent backed by the scripted provider (no API key, no network)
 * and a reset method so the client half starts from a clean transcript.
 */
export const AGENT = 'itest';

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

Meteor.methods({
  async 'itest.reset'() {
    await AgentSessions.removeAsync({});
    await AgentMessages.removeAsync({});
    await AgentDeltas.removeAsync({});
  },
});
