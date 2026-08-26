export * from '../common/types';
export { NAMES } from '../common/names';
export { mergeView } from '../common/merge';
export { Agent, Agent as ClientAgent } from './agent';
// The raw collections for cross-agent views (approvals queue, inbox).
// Client-side these are minimongo caches holding only published data.
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
// The packaged UI. Exported, never self-registering: `defineAgentChat()` is
// the app's call to make (see client/element.ts).
export { defineAgentChat } from './element';
// The shapes an app needs to type its `mentionSources` without redeclaring them.
export type { Mentionable, MentionSource, MentionCollection } from './element';
