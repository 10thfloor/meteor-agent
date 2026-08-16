import { Meteor } from 'meteor/meteor';
import { ensureCapped } from './capped';
import { registerPublications } from './publications';
import { registerMethods } from './methods';

export * from '../common/types';
export { NAMES } from '../common/names';
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
export { mergeView } from '../common/merge';
export { Agent, type AgentConfig } from './agent';
export { mockProvider } from './providers/mock';
export type { Provider, ProviderChunk, ProviderRequest } from './providers/types';

Meteor.startup(async () => {
  await ensureCapped();
  registerPublications();
  registerMethods();
});
