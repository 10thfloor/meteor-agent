import { Meteor } from 'meteor/meteor';
import { ensureCapped } from './capped';
import { registerPublications } from './publications';

export * from '../common/types';
export { NAMES } from '../common/names';
export { AgentSessions, AgentMessages, AgentDeltas } from '../common/collections';
export { mergeView } from '../common/merge';

Meteor.startup(async () => {
  await ensureCapped();
  registerPublications();
});
