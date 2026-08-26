export * from '../common/types';
export { NAMES } from '../common/names';
export { mergeView } from '../common/merge';
export { Agent } from './agent';
// The collections themselves. `Agent` covers one agent's sessions, which is the
// common case and stays the recommended one — but an app with a roster of
// agents and a single cross-agent view (an approvals queue, an inbox) would
// otherwise need one `Agent` per name just to run a find. The server half has
// always exported these; the client omitting them was an oversight, not a
// boundary. Client-side these are minimongo caches: they hold what the app's
// own publications have sent and nothing more.
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
// The packaged UI. Exported, never self-registering: `defineAgentChat()` is
// the app's call to make (see client/element.ts).
export { defineAgentChat } from './element';
