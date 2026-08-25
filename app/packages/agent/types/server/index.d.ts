import { type Watcher } from './watcher';
import { type EgressWorker } from './channels/egress';
export * from '../common/types';
export { NAMES } from '../common/names';
export { saveMemory, searchMemory, forgetMemory, listForBlock, memoryBlock, memoryHint, readSelector, _setMemorySearch, _activeRung, _forceRegexRung, type SaveArgs, type SaveResult, type ForgetResult, type SearchRung, type ListedMemories, } from './memory';
export { MEMORY_TOOL_NAMES } from './tools';
export { resolveMemory } from './registry';
export { AgentSessions, AgentMessages, AgentDeltas, AgentMemories, } from '../common/collections';
export { mergeView } from '../common/merge';
export { Agent, type AgentConfig } from './agent';
export { validateToolArgs, setToolArgsValidator, defineAgentMethod, fullValidationAvailable, setTypeboxValueLoader, setTypeboxCompileLoader, _isSchemaCompiled, SUBAGENT_ARGS, SKILL_TOOL_NAME, type ToolSpec, type InlineTool, type AdoptedTool, type SubagentTool, type McpTool, type ToolContext, type AgentMethodOptions, type ValidationResult, type ArgsValidator, type TypeboxValue, type TypeboxCompile, type TypeboxValidator, type Skill, type ToolResult, type Gate, type GateContext, type GatePredicate, tool, methodTool, type TypedInlineTool, type TypedAdoptedTool, } from './tools';
export type { FromSchema } from '../common/schema';
export type { HookName, HookMap, HookPurpose, HookToolCall, BeforeProviderRequestHook, AfterToolResultHook, ProviderRequestHookContext, ToolResultHookContext, } from './hooks';
export { MAX_SUBAGENT_DEPTH } from './subagent';
export { stopMcp, _setMcpClientFactory, type McpServerDef, type McpToolInfo, type McpClient, type McpClientFactory, } from './mcp/client';
export { mcpSdkResolvable } from './mcp/loader';
export { mockProvider } from './providers/mock';
export { piAiProvider } from './providers/piai';
export type { Provider, ProviderChunk, ProviderRequest, ProviderMessage, } from './providers/types';
export { startWatcher, type Watcher, type WatcherOptions } from './watcher';
export { ensureIndexes } from './indexes';
export { DEFAULT_MAX_TOOL_ARG_BYTES } from './loop';
export { assertLensRoundTrip, exemplarItems, matchExpectation, attachmentNotice, promptDisplay, DELIVERY_ITEM_KINDS, MENU_MATCHES, VERDICT_FOR, LINK_GESTURE, isLinkGesture, encodeVerdictPostback, decodeVerdictPostback, isRemoteAttachment, type ChannelAttachment, type ChannelProfile, type ChannelTransport, type DeliveryItem, type InboundAttachment, type InboundIntent, type InboundReading, type Lens, type PromptChoice, type RemoteAttachment, type RoundTripOptions, } from '../common/channel-contract';
export { type ChannelDef, type ChannelKnobs, type RawInbound, listChannels, getChannel, headerValue, safeEqual, channelKnobs, CHANNEL_KNOB_KEYS, } from './channels/registry';
export { startEgress, deliverOnce, type DeliverableBinding, type EgressOptions, type EgressWorker, } from './channels/egress';
export { handleInbound, mountChannelRoutes } from './channels/ingress';
export { issueLinkToken, redeemLinkToken, linkIdentity, resolveIdentity, issueVerdictToken, redeemVerdictToken, } from './channels/linking';
export { ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens, DeliveryReceipts, InboundSubmissions, insertOrLose, type ChannelBinding, type ChannelIdentity, type ChannelLinkToken, type ChannelVerdictToken, type DeliveryReceipt, type InboundSubmission, type ReceiptExpectation, } from './channels/collections';
export { AgentAttachments, DEFAULT_ATTACHMENT_CAPS, sanitizeAttachmentName, prettySize, type AgentAttachment, type AttachmentCaps, type CreateAttachmentOptions, } from './attachments';
export { humanParticipantId, identityParticipantId, modelParticipantId, participantByIdentity, participantByUserId, resolveAddressee, participantsBlock, sanitizeDisplayName, needsAttribution, } from '../common/participants';
export { AttachmentDownloadTokens, issueAttachmentToken, redeemAttachmentToken, handleDownload, mountDownloadRoute, DOWNLOAD_ROUTE, type AttachmentDownloadToken, } from './downloads';
export type { ViaIdentity } from './methods';
export type { TranscriptView } from './transcript';
/**
 * This process's boot watcher, or null when the settings or the environment
 * disabled it. Exposed so a host app can stop it (a graceful shutdown, or a
 * process that wants to hand recovery to a single designated instance).
 */
export declare let watcher: Watcher | null;
/**
 * This process's boot egress workers, one per enabled channel kind — the
 * watcher's contract, per kind. Exposed for the same reason `watcher` is: a
 * host that wires a real SIGTERM handler stops these too, and one that runs
 * delivery on a designated instance disables kinds via
 * `settings.channels.<kind> = false` and reads this to verify.
 */
export declare const egress: Map<string, EgressWorker>;
//# sourceMappingURL=index.d.ts.map