export * from '../common/types';
export * from '../common/learning';
export { NAMES } from '../common/names';
export { mergeView } from '../common/merge';
export { modelParticipantByHandle, resolveAddressee } from '../common/participants';
export { Agent, Agent as ClientAgent } from './agent';
export type { SendOptions } from './agent';
// The raw collections for cross-agent views (approvals queue, inbox).
// Client-side these are minimongo caches holding only published data.
export {
  AgentSessions, AgentMessages, AgentDeltas, AgentMemories,
} from '../common/collections';
// The packaged UI. Exported, never self-registering: `defineAgentChat()` is
// the app's call to make (see client/element.ts).
export { defineAgentChat, sanitizeCleanAssistantContent } from './element';
// The shapes an app needs to type its `mentionSources` without redeclaring them.
export type {
  ComposerMode, ComposerSubmission, ComposerSubmissionHandler, ComposerDraftOptions, ChatTimelineItem, AgentChatElement,
  Mentionable, MentionSource, MentionCollection,
} from './element';
