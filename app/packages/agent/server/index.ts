import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';
import { ensureCapped } from './capped';
import { ensureIndexes } from './indexes';
import { registerPublications } from './publications';
import { registerMethods } from './methods';
import { applyRateLimits } from './rate-limits';
import { listAgents } from './registry';
import {
  AgentSessions, AgentMessages, AgentDeltas, AgentMemories,
} from '../common/collections';
import { startWatcher, type Watcher } from './watcher';
import {
  ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens,
  DeliveryReceipts, InboundSubmissions,
} from './channels/collections';
import { AgentAttachments } from './attachments';
import { AttachmentDownloadTokens, mountDownloadRoute } from './downloads';
import { listChannels } from './channels/registry';
import { mountChannelRoutes } from './channels/ingress';
import { startEgress, type EgressWorker } from './channels/egress';
import {
  resumeSessionErasures, startSessionLifecycleRecovery,
} from './session-lifecycle';
import { UserMessageReservations } from './transcript';
import {
  AgentConstitutions, AgentExperiences, AgentIdentities, AgentLearningEvents,
  AgentMemoryFrames, AgentPractices,
} from './learning-collections';
import { ensureLearningIndexes } from './learning';

export * from '../common/types';
export * from '../common/learning';
export { NAMES } from '../common/names';
// Memory: core and types. App reaches the store via `Agent.memory`.
export {
  saveMemory, searchMemory, forgetMemory, listForBlock, memoryBlock, memoryHint,
  memoryBlockSnapshot, memoryHintSnapshot,
  readSelector,
  type SaveArgs, type SaveResult, type ForgetResult, type SearchRung,
  type ListedMemories,
} from './memory';
export { MEMORY_TOOL_NAMES } from './tools';
export { LEARNING_TOOL_NAMES } from './learning-tools';
export { resolveMemory } from './registry';
export {
  AgentSessions, AgentMessages, AgentDeltas, AgentMemories,
} from '../common/collections';
export { mergeView } from '../common/merge';
// `Agent.provider` / `Agent.compact` are the public doors; internals stay unexported.
export { Agent, type AgentConfig, type SessionErasure } from './agent';
export {
  abandonPendingAgentTurns, type AbandonedAgentTurns,
} from './session-lifecycle';
export {
  validateToolArgs, setToolArgsValidator, defineAgentMethod,
  fullValidationAvailable, SUBAGENT_ARGS, SKILL_TOOL_NAME,
  type ToolSpec, type InlineTool, type AdoptedTool, type SubagentTool,
  type McpTool, type ToolContext, type AgentMethodOptions, type ValidationResult,
  type ArgsValidator, type TypeboxValue, type TypeboxCompile,
  type TypeboxValidator, type Skill, type ToolResult,
  type Gate, type GateContext, type GatePredicate,
  // Typed arguments (opt-in via `tool()` / `methodTool()`).
  tool, methodTool, type TypedInlineTool, type TypedAdoptedTool,
} from './tools';
export type { FromSchema } from '../common/schema';
export type {
  HookName, HookMap, HookPurpose, HookToolCall,
  BeforeProviderRequestHook, AfterToolResultHook,
  ProviderRequestHookContext, ToolResultHookContext,
} from './hooks';
export { MAX_SUBAGENT_DEPTH } from './subagent';
export {
  discoverMcpTools, disconnectMcpServer, unregisterMcpServer,
  getMcpServerStatus, stopMcp,
  type DiscoveryResult, type McpServerState, type McpServerStatus,
  type McpServerDef, type McpToolInfo, type McpClient, type McpClientFactory,
} from './mcp/client';
export { mcpSdkResolvable } from './mcp/loader';
export { mockProvider } from './providers/mock';
export { createPiAiProvider, piAiProvider, type PiAiModels } from './providers/piai';
export { loadPiAi } from './providers/loader';
export type {
  Provider, ProviderChunk, ProviderRequest, ProviderMessage,
} from './providers/types';
export { startWatcher, type Watcher, type WatcherOptions } from './watcher';
export { ensureIndexes } from './indexes';
export { DEFAULT_MAX_TOOL_ARG_BYTES } from './loop';

// ---- Channels (channels spec) ----------------------------------------------
// Lens contract, webhook helpers, delivery, egress, linking, and collections.
// Worker/planner internals stay unexported; tests reach them by path.
export {
  assertLensRoundTrip, exemplarItems, matchExpectation, attachmentNotice,
  promptDisplay,
  DELIVERY_ITEM_KINDS, MENU_MATCHES, VERDICT_FOR, LINK_GESTURE, isLinkGesture,
  encodeVerdictPostback, decodeVerdictPostback, isRemoteAttachment,
  type ChannelAttachment, type ChannelPostOptions, type ChannelProfile, type ChannelTransport,
  type DeliveryItem, type InboundAttachment, type InboundIntent,
  type InboundReading, type Lens, type PromptChoice, type RemoteAttachment,
  type RoundTripOptions,
} from '../common/channel-contract';
export {
  type ChannelDef, type ChannelKnobs, type RawInbound, type RawInboundHead,
  listChannels, getChannel, headerValue, safeEqual, channelKnobs, CHANNEL_KNOB_KEYS,
} from './channels/registry';
export {
  startEgress, deliverOnce,
  type DeliverableBinding, type DeliverOnceOptions, type EgressOptions, type EgressWorker,
} from './channels/egress';
export { handleInbound, mountChannelRoutes } from './channels/ingress';
export {
  issueLinkToken, previewLinkToken, redeemLinkToken, linkIdentity, resolveIdentity,
  type LinkTokenPreview,
  issueVerdictToken, previewVerdictToken, redeemVerdictToken,
  type VerdictTokenPreview,
} from './channels/linking';
export {
  ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens,
  DeliveryReceipts, InboundSubmissions, insertOrLose,
  type ChannelBinding, type ChannelIdentity, type ChannelLinkToken,
  type ChannelVerdictToken, type DeliveryReceipt, type InboundSubmission,
  type ReceiptExpectation,
} from './channels/collections';
// Attachments: store, caps, and helpers for lens authors and hosts.
// Blessed doors are `Agent.attachments.create`/`.readTool` (agent.ts).
export {
  AgentAttachments, DEFAULT_ATTACHMENT_CAPS,
  sanitizeAttachmentName, prettySize,
  type AgentAttachment, type AttachmentCaps, type CreateAttachmentOptions,
} from './attachments';
// Participants: pure helpers for channel packages and hosts; `Agent.participants`
// is the blessed door. `ViaIdentity` is for trusted `sendToSession` callers.
export {
  humanParticipantId, identityParticipantId, modelParticipantId,
  participantByIdentity, participantByUserId, resolveAddressee,
  participantsBlock, sanitizeDisplayName, needsAttribution,
} from '../common/participants';
// Downloads: token mint + collection. Serving/burning remains an internal route.
export {
  AttachmentDownloadTokens, issueAttachmentToken, DOWNLOAD_ROUTE,
  type AttachmentDownloadToken,
} from './downloads';
export type { ViaIdentity } from './methods';
// System turns: `Agent#systemTurn` is the blessed door. Compatibility free
// functions still park through the package's private Activation Module.
export { startSystemTurn, consumeStandingIntent } from './methods';
export {
  consumeSystemIntent, systemRowId, systemBudgetClause,
  SYSTEM_INTENT_TTL_MS, type SystemTurnResult, type SystemDispatch,
} from './system-turn';
export { systemParticipantId, systemFrom } from '../common/participants';
export type { TranscriptView } from './transcript';

/** Boot watcher for this process; null if disabled. Exposed for graceful shutdown. */
export let watcher: Watcher | null = null;
let lifecycleRecovery: { stop(): Promise<void> } | null = null;

/** Boot egress workers, one per enabled channel kind. Exposed for graceful shutdown. */
export const egress = new Map<string, EgressWorker>();

/** True in every Meteor test mode. `isTest` alone misses `test-packages`
 *  (which only sets `isPackageTest`), and a boot watcher under test would
 *  sweep hand-seeded sessions and cause flakes. */
const UNDER_TEST = Meteor.isTest || Meteor.isAppTest || Meteor.isPackageTest;

/** Blanket deny on all collections so Meteor's `insecure` package (shipped in
 *  every new app) can never grant client-side write access. All legitimate
 *  writes go through server methods, which bypass allow/deny. */
function denyAllClientWrites(): void {
  const deny = { insert: () => true, update: () => true, remove: () => true };
  for (const c of [
    AgentSessions, AgentMessages, AgentDeltas,
    // DDP clients can invoke mutation methods by name even without a client stub.
    ChannelIdentities, ChannelBindings, DeliveryReceipts,
    InboundSubmissions, ChannelLinkTokens, ChannelVerdictTokens,
    // Raw file bytes — same lockout.
    AgentAttachments, UserMessageReservations,
    // Forged download tokens would be an exfiltration primitive via the GET route.
    AttachmentDownloadTokens,
    // Forged memory inserts would be prompt injection with a write primitive.
    AgentMemories,
    // Learning state is authority-bearing prompt material. Browser mutation
    // remains denied even when an app accidentally ships `insecure`.
    AgentIdentities, AgentConstitutions, AgentExperiences,
    AgentPractices, AgentMemoryFrames, AgentLearningEvents,
  ]) {
    (c as any).deny(deny);
  }
}

/** Warn at startup about agents with no budget and no `sends` rate limit,
 *  so a default deployment isn't silently uncapped. */
function warnUncappedAgents(settings: any): void {
  const hasSendLimit = !!settings?.rateLimit?.sends;
  if (hasSendLimit) return;
  const uncapped = listAgents()
    .filter(([, config]) => {
      const b = config.budget;
      const hasBudget = !!b
        && (b.turns !== undefined || b.toolCalls !== undefined || b.spend !== undefined);
      return !hasBudget;
    })
    .map(([name]) => name);
  if (uncapped.length === 0) return;
  console.warn(
    `[10thfloor:agent] ${uncapped.length} agent(s) are defined with neither a `
    + `budget nor a configured "sends" rate limit, so nothing bounds their spend: `
    + `${uncapped.join(', ')}. Anonymous-reachable agents especially need an `
    + 'app-level per-IP/global ceiling — see the README "Production ceilings" note.',
  );
}

Meteor.startup(async () => {
  // Synchronous — no tick between boot and deny where a client could slip past `insecure`.
  denyAllClientWrites();

  await ensureCapped();
  // Learning correctness depends on unique identity/revision/frame keys. Fail
  // startup before methods/publications become reachable if Mongo cannot
  // enforce them.
  await ensureLearningIndexes();
  // Watcher sweeps and transcript reads depend on these indexes.
  await ensureIndexes();
  // A crash may leave only the root fence durable. Close its child graph
  // before any publication, method, webhook, or egress worker is reachable.
  await resumeSessionErasures({ strict: true });
  registerPublications();
  registerMethods();
  // Undefined when no `--settings` file was passed; `applyRateLimits` treats that as zero rules.
  const settings = (Meteor.settings as any)?.packages?.['10thfloor:agent'];
  applyRateLimits(settings);
  // Non-fatal: the app may enforce its own ceiling a level up.
  warnUncappedAgents(settings);

  // Data lifecycle recovery is independent of optional Turn recovery.
  if (!UNDER_TEST && !lifecycleRecovery) {
    lifecycleRecovery = startSessionLifecycleRecovery();
  }

  // On by default: orphans are recovered only by the next `send` otherwise.
  // Tests start their own watchers; a boot watcher would fight them.
  if (settings?.watcher !== false && !UNDER_TEST) {
    watcher = startWatcher();
  }

  // Own mount outside the channels guard — apps without channels still need downloads.
  if (!UNDER_TEST) {
    mountDownloadRoute((WebApp as any).handlers);
  }

  // Registry is complete by startup. Webhooks mount on every instance (unmounted
  // = retry storm); egress follows the watcher's boot contract (per-kind disable).
  if (!UNDER_TEST && listChannels().length > 0) {
    mountChannelRoutes((WebApp as any).handlers);
    for (const [kind] of listChannels()) {
      if (settings?.channels?.[kind] === false) continue;
      egress.set(kind, startEgress(kind));
    }
  }
});
