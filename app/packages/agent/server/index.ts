import { Meteor } from 'meteor/meteor';
import { ensureCapped } from './capped';
import { ensureIndexes } from './indexes';
import { registerPublications } from './publications';
import { registerMethods } from './methods';
import { applyRateLimits } from './rate-limits';
import { listAgents } from './registry';
import { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
import { startWatcher, type Watcher } from './watcher';

export * from '../common/types';
export { NAMES } from '../common/names';
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
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

/**
 * This process's boot watcher, or null when the settings or the environment
 * disabled it. Exposed so a host app can stop it (a graceful shutdown, or a
 * process that wants to hand recovery to a single designated instance).
 */
export let watcher: Watcher | null = null;

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
 * The three collections carry no allow/deny rules of their own, so in a host app
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
  for (const c of [AgentSessions, AgentMessages, AgentDeltas]) {
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
});
