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

export * from '../common/types';
export { NAMES } from '../common/names';
// Memory (memory spec): the core, its types, and the test seam. The DDP
// methods and the inline tools are registered by `define()`, not exported —
// an app reaches the store through `Agent.memory`.
export {
  saveMemory, searchMemory, forgetMemory, listForBlock, memoryBlock, memoryHint,
  readSelector, _setMemorySearch, _activeRung, _forceRegexRung,
  type SaveArgs, type SaveResult, type ForgetResult, type SearchRung,
  type ListedMemories,
} from './memory';
export { MEMORY_TOOL_NAMES } from './tools';
export { resolveMemory } from './registry';
export {
  AgentSessions, AgentMessages, AgentDeltas, AgentMemories,
} from '../common/collections';
export { mergeView } from '../common/merge';
// `Agent.provider` / `Agent.compact` are the doors to the provider registry and
// to manual compaction; the underlying `registerProvider` / `compactSession`
// stay internal, exactly as `runTurn` and `resolveTools` do.
export { Agent, type AgentConfig } from './agent';
export {
  validateToolArgs, setToolArgsValidator, defineAgentMethod,
  fullValidationAvailable, setTypeboxValueLoader, setTypeboxCompileLoader,
  _isSchemaCompiled, SUBAGENT_ARGS, SKILL_TOOL_NAME,
  type ToolSpec, type InlineTool, type AdoptedTool, type SubagentTool,
  type McpTool, type ToolContext, type AgentMethodOptions, type ValidationResult,
  type ArgsValidator, type TypeboxValue, type TypeboxCompile,
  type TypeboxValidator, type Skill, type ToolResult,
  // The gate surface. `Gate` is what a spec's `gate` accepts; `GateContext` is
  // what an app's predicate is handed, and is the one type it has to name.
  type Gate, type GateContext, type GatePredicate,
} from './tools';
export type {
  HookName, HookMap, HookPurpose, HookToolCall,
  BeforeProviderRequestHook, AfterToolResultHook,
  ProviderRequestHookContext, ToolResultHookContext,
} from './hooks';
export { MAX_SUBAGENT_DEPTH } from './subagent';
export {
  stopMcp, _setMcpClientFactory,
  type McpServerDef, type McpToolInfo, type McpClient, type McpClientFactory,
} from './mcp/client';
export { mcpSdkResolvable } from './mcp/loader';
export { mockProvider } from './providers/mock';
export { piAiProvider } from './providers/piai';
export type {
  Provider, ProviderChunk, ProviderRequest, ProviderMessage,
} from './providers/types';
export { startWatcher, type Watcher, type WatcherOptions } from './watcher';
export { ensureIndexes } from './indexes';
export { DEFAULT_MAX_TOOL_ARG_BYTES } from './loop';

// ---- Channels (channels spec) ----------------------------------------------
// What a channel AUTHOR or a HOST needs, and no more — the §8.7 ladder:
// install a channel package (it calls `Agent.channel`), override one item of
// its lens, or author a new surface against these types and prove it with
// `assertLensRoundTrip`. Exported: the lens contract (types, the grammar
// constants, the postback codec, the round-trip helper), the webhook helpers
// a `verify` needs, `deliverOnce` for tool bodies (§7), `startEgress` and the
// pipeline for a host that wires its own boot, linking, and the collections.
// The worker's and planner's INTERNALS — claim, cursor, per-binding delivery,
// `planItems`/`promptItem` — stay inside the package: nothing outside it has a
// reason to call them, and the tests reach them by path.
export {
  assertLensRoundTrip, exemplarItems, matchExpectation, attachmentNotice,
  promptDisplay,
  DELIVERY_ITEM_KINDS, MENU_MATCHES, VERDICT_FOR, LINK_GESTURE, isLinkGesture,
  encodeVerdictPostback, decodeVerdictPostback, isRemoteAttachment,
  type ChannelAttachment, type ChannelProfile, type ChannelTransport,
  type DeliveryItem, type InboundAttachment, type InboundIntent,
  type InboundReading, type Lens, type PromptChoice, type RemoteAttachment,
  type RoundTripOptions,
} from '../common/channel-contract';
export {
  type ChannelDef, type ChannelKnobs, type RawInbound,
  listChannels, getChannel, headerValue, safeEqual, channelKnobs, CHANNEL_KNOB_KEYS,
} from './channels/registry';
export {
  startEgress, deliverOnce,
  type DeliverableBinding, type EgressOptions, type EgressWorker,
} from './channels/egress';
export { handleInbound, mountChannelRoutes } from './channels/ingress';
export {
  issueLinkToken, redeemLinkToken, linkIdentity, resolveIdentity,
  issueVerdictToken, redeemVerdictToken,
} from './channels/linking';
export {
  ChannelBindings, ChannelIdentities, ChannelLinkTokens, ChannelVerdictTokens,
  DeliveryReceipts, InboundSubmissions, insertOrLose,
  type ChannelBinding, type ChannelIdentity, type ChannelLinkToken,
  type ChannelVerdictToken, type DeliveryReceipt, type InboundSubmission,
  type ReceiptExpectation,
} from './channels/collections';
// Attachments (email v2 spec): the store, the caps, and the pieces a channel
// package or a host needs — `Agent.attachments.create`/`.readTool` are the
// blessed doors (agent.ts); these exports are for lens authors (the contract
// types ride the channel-contract block above via `ChannelAttachment`) and for
// hosts that read or prune the store themselves.
export {
  AgentAttachments, DEFAULT_ATTACHMENT_CAPS,
  sanitizeAttachmentName, prettySize,
  type AgentAttachment, type AttachmentCaps, type CreateAttachmentOptions,
} from './attachments';
// Participants (participants spec): `Agent.participants` is the blessed door
// (agent.ts); the pure helpers are exported for channel packages (compose's
// pre-bind derives ids with them) and for hosts that build invite flows. The
// server-side `via` principal type rides along for trusted callers of
// `sendToSession`.
export {
  humanParticipantId, identityParticipantId, modelParticipantId,
  participantByIdentity, participantByUserId, resolveAddressee,
  participantsBlock, sanitizeDisplayName, needsAttribution,
} from '../common/participants';
// Downloads (participants spec §7): the mint for an app's own flows, the
// handler for a host that mounts its own route, and the collection for
// operators. Redemption's single-use burn lives inside `handleDownload`.
export {
  AttachmentDownloadTokens, issueAttachmentToken, redeemAttachmentToken,
  handleDownload, mountDownloadRoute, DOWNLOAD_ROUTE,
  type AttachmentDownloadToken,
} from './downloads';
export type { ViaIdentity } from './methods';
// System turns: a turn nobody typed (system-turn spec). `Agent#systemTurn` is
// the blessed door; the free function is here for a host that schedules
// without an Agent handle. `consumeSystemIntent` is exported for the watcher's
// sweep and for tests — an app has no reason to call it.
export {
  startSystemTurn, consumeSystemIntent, systemRowId, systemBudgetClause,
  SYSTEM_INTENT_TTL_MS, type SystemTurnResult,
} from './methods';
export { systemParticipantId, systemFrom } from '../common/participants';
export type { TranscriptView } from './transcript';

/**
 * This process's boot watcher, or null when the settings or the environment
 * disabled it. Exposed so a host app can stop it (a graceful shutdown, or a
 * process that wants to hand recovery to a single designated instance).
 */
export let watcher: Watcher | null = null;

/**
 * This process's boot egress workers, one per enabled channel kind — the
 * watcher's contract, per kind. Exposed for the same reason `watcher` is: a
 * host that wires a real SIGTERM handler stops these too, and one that runs
 * delivery on a designated instance disables kinds via
 * `settings.channels.<kind> = false` and reads this to verify.
 */
export const egress = new Map<string, EgressWorker>();

/**
 * True in EVERY test mode Meteor has.
 *
 * `Meteor.isTest` alone is not enough, and the trap is documented in Meteor's own
 * `test_environment.js`: under `meteor test-packages` — the mode this package's
 * suite runs in — neither `isTest` nor `isAppTest` is set. Both are read off
 * `TEST_METADATA`, which the tool populates only for `meteor test`
 * (`isTest`) and `meteor test --full-app` (`isAppTest`). The flag that IS true
 * for `test-packages` is `Meteor.isPackageTest`, derived from the presence of a
 * driver package. So a `!Meteor.isTest` gate would have read as correct and done
 * nothing at all: the boot watcher would have run through the whole suite,
 * sweeping every test's hand-seeded session — claiming orphans the lease tests
 * seeded on purpose, timing out the approvals the gate tests park — and the
 * failures would have looked like flakes in the code under test.
 *
 * All three are declared in meteor@2.3.1's `meteor.d.ts` (Meteor 3.5), so this
 * needs no `any`.
 */
const UNDER_TEST = Meteor.isTest || Meteor.isAppTest || Meteor.isPackageTest;

/**
 * SAFETY BY CONSTRUCTION against Meteor's `insecure` package.
 *
 * None of the package's collections carry allow/deny rules of their own, so in a host app
 * that still has `insecure` installed (Meteor ships it in every new app) a
 * client would inherit FULL write access to sessions, messages and deltas —
 * inserting forged transcript rows, editing budgets, deleting anyone's history —
 * which voids the entire method-and-publication auth model in one line of the
 * app's `.meteor/packages`. A blanket deny closes that regardless of what the
 * app's package list happens to say: with any deny rule present, `insecure`
 * grants nothing, and all legitimate writes already go through server methods
 * (which bypass allow/deny entirely). The README's Install section also tells
 * operators to remove `insecure`/`autopublish`; this is the belt to that
 * suspenders, because the failure is silent and total.
 */
function denyAllClientWrites(): void {
  const deny = { insert: () => true, update: () => true, remove: () => true };
  for (const c of [
    AgentSessions, AgentMessages, AgentDeltas,
    // The channel collections are server-declared (no client stub), but a DDP
    // client can invoke a collection's low-level mutation methods BY NAME
    // without one — so the belt covers them identically.
    ChannelIdentities, ChannelBindings, DeliveryReceipts,
    InboundSubmissions, ChannelLinkTokens, ChannelVerdictTokens,
    // The attachment store holds raw file bytes — the same lockout, doubly so.
    AgentAttachments,
    // Download tokens: a forged client insert naming any session's attachment
    // would be an exfiltration primitive through the GET route (participants
    // spec §7.1) — the full link-token idiom includes this belt.
    AttachmentDownloadTokens,
    // Memory: a forged client insert would let anyone write the shared work
    // pool the model reads on every turn — prompt injection with a write
    // primitive. Legitimate writes go through the methods and the core.
    AgentMemories,
  ]) {
    (c as any).deny(deny);
  }
}

/**
 * §9 residual-risk klaxon. `applyRateLimits` adds zero rules when settings are
 * absent and `defineAgent` supplies no default budget, so a default deployment
 * has no aggregate spend ceiling at all. The real ceiling is app-level and out
 * of this package's scope, but the package must not be SILENTLY unsafe: name
 * every agent shipped with neither a `budget` nor a configured `sends` rate
 * limit (the per-connection brake on the one spend vector), once, at startup.
 * See the README's "Production ceilings" note.
 */
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
  // FIRST — before any `await` yields the event loop. A write-lockout is a
  // security control, and it must not sit behind capped-collection or index
  // setup: registering it synchronously means there is never a tick between
  // boot and the deny where a client could slip a write past `insecure`.
  denyAllClientWrites();

  await ensureCapped();
  // After ensureCapped and before anything serves: the watcher's sweeps and
  // every transcript read depend on these. Non-fatal by design — see the file.
  await ensureIndexes();
  registerPublications();
  registerMethods();
  // `Meteor.settings.packages` is undefined whenever no `--settings` file was
  // passed at all; `applyRateLimits` treats that (and a settings file with no
  // `rateLimit` block) the same way — zero rules, no throw — so an
  // unconfigured deployment still boots.
  const settings = (Meteor.settings as any)?.packages?.['10thfloor:agent'];
  applyRateLimits(settings);
  // After methods and rate limits are in place: warn once about any agent left
  // with no spend ceiling at all. Non-fatal — a warning, not a refusal, because
  // an app may enforce its ceiling a level up (a per-IP gateway limit) that this
  // package cannot see.
  warnUncappedAgents(settings);

  // §4.3. On by default: an orphaned session with no watcher is recovered only
  // by the next `send`, which for an unattended run is never. `watcher: false`
  // turns it off for a deployment that recovers some other way (one designated
  // instance, an external scheduler).
  //
  // Tests start their OWN watchers with short timings and stop them in a
  // `finally`; a boot watcher would fight every one of them — see `UNDER_TEST`.
  if (settings?.watcher !== false && !UNDER_TEST) {
    watcher = startWatcher();
  }

  // The download route (participants spec §7): its OWN mount, outside the
  // channels guard — a web app with no channel still downloads its files —
  // and on every instance, since the GETs are load-balanced like any HTTP.
  // Not under test: route tests drive `handleDownload` directly.
  if (!UNDER_TEST) {
    mountDownloadRoute((WebApp as any).handlers);
  }

  // Channels (channels spec §9/§6.4). By this point every app-file
  // `Agent.channel(...)` has run — startup callbacks fire after all code
  // loads — so the registry is complete.
  //
  // The WEBHOOKS mount on every instance and unconditionally: inbound HTTP is
  // load-balanced and an unmounted route is a provider retry storm. The
  // EGRESS worker follows the watcher's boot contract instead — on by
  // default, disabled per kind via `settings.channels.<kind> = false` for
  // deployments that run delivery on one designated instance, and never under
  // test: a boot worker would deliver every test's hand-seeded transcripts to
  // a transport nobody mocked.
  if (!UNDER_TEST && listChannels().length > 0) {
    mountChannelRoutes((WebApp as any).handlers);
    for (const [kind] of listChannels()) {
      if (settings?.channels?.[kind] === false) continue;
      egress.set(kind, startEgress(kind));
    }
  }
});
