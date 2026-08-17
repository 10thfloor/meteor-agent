import { Meteor } from 'meteor/meteor';
import { ensureCapped } from './capped';
import { registerPublications } from './publications';
import { registerMethods } from './methods';
import { applyRateLimits } from './rate-limits';

export * from '../common/types';
export { NAMES } from '../common/names';
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
export { mergeView } from '../common/merge';
export { Agent, type AgentConfig } from './agent';
export { mockProvider } from './providers/mock';
export { piAiProvider } from './providers/piai';
export type { Provider, ProviderChunk, ProviderRequest } from './providers/types';

Meteor.startup(async () => {
  await ensureCapped();
  registerPublications();
  registerMethods();
  // `Meteor.settings.packages` is undefined whenever no `--settings` file was
  // passed at all; `applyRateLimits` treats that (and a settings file with no
  // `rateLimit` block) the same way — zero rules, no throw — so an
  // unconfigured deployment still boots.
  applyRateLimits((Meteor.settings as any)?.packages?.['10thfloor:agent']);
});
