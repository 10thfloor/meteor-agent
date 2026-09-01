import { type Watcher } from './watcher';
import { type EgressWorker } from './channels/egress';
export * from '../common/types';
export * from '../common/learning';
export { NAMES } from '../common/names';
export { saveMemory, searchMemory, forgetMemory, listForBlock, memoryBlock, memoryHint, memoryBlockSnapshot, memoryHintSnapshot, readSelector, type SaveArgs, type SaveResult, type ForgetResult, type SearchRung, type ListedMemories, } from './memory';
export { MEMORY_TOOL_NAMES } from './tools';
export { LEARNING_TOOL_NAMES } from './learning-tools';
export { hostLearningSource, assertLearningReviewTarget, assertPracticeTransitionEvidence, governedConstitutionRevise, governedExperienceRetract, governedLearningReview, governedPracticePropose, governedPracticeTransition, LEARNING_PUBLICATION_VIEWS, createLearningPublisher, type GovernedPracticeProposal, type LearningPublisher, type LearningSubscription, } from './learning-governance';
export { resolveMemory } from './registry';
export { AgentSessions, AgentMessages, AgentDeltas, AgentMemories, } from '../common/collections';
export { mergeView } from '../common/merge';
export { Agent, type AgentConfig, type SessionErasure } from './agent';
export { abandonPendingAgentTurns, type AbandonedAgentTurns, } from './session-lifecycle';
export { validateToolArgs, setToolArgsValidator, defineAgentMethod, fullValidationAvailable, SUBAGENT_ARGS, SKILL_TOOL_NAME, type ToolSpec, type InlineTool, type AdoptedTool, type SubagentTool, type McpTool, type ToolContext, type AgentMethodOptions, type ValidationResult, type ArgsValidator, type TypeboxValue, type TypeboxCompile, type TypeboxValidator, type Skill, type ToolResult, type Gate, type GateContext, type GatePredicate, tool, methodTool, type TypedInlineTool, type TypedAdoptedTool, } from './tools';
export type { FromSchema } from '../common/schema';
export type { HookName, HookMap, HookPurpose, HookToolCall, BeforeProviderRequestHook, AfterToolResultHook, ProviderRequestHookContext, ToolResultHookContext, } from './hooks';
export { MAX_SUBAGENT_DEPTH } from './subagent';
export { discoverMcpTools, disconnectMcpServer, unregisterMcpServer, getMcpServerStatus, stopMcp, type DiscoveryResult, type McpServerState, type McpServerStatus, type McpServerDef, type McpToolInfo, type McpClient, type McpClientFactory, } from './mcp/client';
export { mcpSdkResolvable } from './mcp/loader';
export { mockProvider } from './providers/mock';
export { createPiAiProvider, piAiProvider, type PiAiModels } from './providers/piai';
export { loadPiAi } from './providers/loader';
export type { Provider, ProviderChunk, ProviderRequest, ProviderMessage, } from './providers/types';
export { startWatcher, type Watcher, type WatcherOptions } from './watcher';
export { ensureIndexes } from './indexes';
export { DEFAULT_MAX_TOOL_ARG_BYTES } from './loop';
export { assertLensRoundTrip, exemplarItems, matchExpectation, attachmentNotice, promptDisplay, DELIVERY_ITEM_KINDS, MENU_MATCHES, VERDICT_FOR, LINK_GESTURE, isLinkGesture, encodeVerdictPostback, decodeVerdictPostback, isRemoteAttachment, type ChannelAttachment, type ChannelPostOptions, type ChannelProfile, type ChannelTransport, type DeliveryItem, type InboundAttachment, type InboundIntent, type InboundReading, type Lens, type PromptChoice, type RemoteAttachment, type RoundTripOptions, } from '../common/channel-contract';
export { type ChannelDef, type ChannelKnobs, type RawInbound, type RawInboundHead, listChannels, getChannel, headerValue, safeEqual, channelKnobs, CHANNEL_KNOB_KEYS, } from './channels/registry';
export { startEgress, deliverOnce, type DeliverableBinding, type DeliverOnceOptions, type EgressOptions, type EgressWorker, } from './channels/egress';
export { handleInbound, mountChannelRoutes } from './channels/ingress';
export { issueLinkToken, previewLinkToken, redeemLinkToken, linkIdentity, resolveIdentity, type LinkTokenPreview, issueVerdictToken, previewVerdictToken, redeemVerdictToken, type VerdictTokenPreview, } from './channels/linking';
export { ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens, DeliveryReceipts, InboundSubmissions, insertOrLose, type ChannelBinding, type ChannelIdentity, type ChannelLinkToken, type ChannelVerdictToken, type DeliveryReceipt, type InboundSubmission, type ReceiptExpectation, } from './channels/collections';
export { AgentAttachments, DEFAULT_ATTACHMENT_CAPS, sanitizeAttachmentName, prettySize, type AgentAttachment, type AttachmentCaps, type CreateAttachmentOptions, } from './attachments';
export { humanParticipantId, identityParticipantId, modelParticipantId, participantByIdentity, participantByUserId, resolveAddressee, participantsBlock, sanitizeDisplayName, needsAttribution, } from '../common/participants';
export { AttachmentDownloadTokens, issueAttachmentToken, DOWNLOAD_ROUTE, type AttachmentDownloadToken, } from './downloads';
export type { ViaIdentity } from './methods';
export { startSystemTurn, consumeStandingIntent } from './methods';
export { consumeSystemIntent, systemRowId, systemBudgetClause, SYSTEM_INTENT_TTL_MS, type SystemTurnResult, type SystemDispatch, } from './system-turn';
export { systemParticipantId, systemFrom } from '../common/participants';
export type { TranscriptView } from './transcript';
/** Boot watcher for this process; null if disabled. Exposed for graceful shutdown. */
export declare let watcher: Watcher | null;
/** Boot egress workers, one per enabled channel kind. Exposed for graceful shutdown. */
export declare const egress: Map<string, EgressWorker>;
/** Settles when the startup prelude — capped collections, indexes, erasure
 *  recovery, publications, and methods — has completed (or rejects with the
 *  failure). The mocha runner does not wait for `Meteor.startup` callbacks,
 *  so test entries MUST await this before any suite touches a method; hosts
 *  that probe readiness may await it too. */
export declare const startupComplete: Promise<void>;
//# sourceMappingURL=index.d.ts.map