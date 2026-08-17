import { Meteor } from 'meteor/meteor';
import { ensureCapped } from './capped';
import { registerPublications } from './publications';
import { registerMethods } from './methods';
import { applyRateLimits } from './rate-limits';
import { startWatcher, type Watcher } from './watcher';

export * from '../common/types';
export { NAMES } from '../common/names';
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
export { mergeView } from '../common/merge';
export { Agent, type AgentConfig } from './agent';
export {
  validateToolArgs, setToolArgsValidator, defineAgentMethod,
  type ToolSpec, type InlineTool, type AdoptedTool, type ToolContext,
  type AgentMethodOptions, type ValidationResult, type ArgsValidator,
} from './tools';
export { mockProvider } from './providers/mock';
export { piAiProvider } from './providers/piai';
export type {
  Provider, ProviderChunk, ProviderRequest, ProviderMessage,
} from './providers/types';
export { startWatcher, type Watcher, type WatcherOptions } from './watcher';

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

Meteor.startup(async () => {
  await ensureCapped();
  registerPublications();
  registerMethods();
  // `Meteor.settings.packages` is undefined whenever no `--settings` file was
  // passed at all; `applyRateLimits` treats that (and a settings file with no
  // `rateLimit` block) the same way — zero rules, no throw — so an
  // unconfigured deployment still boots.
  const settings = (Meteor.settings as any)?.packages?.['10thfloor:agent'];
  applyRateLimits(settings);

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
