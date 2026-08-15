// S1 — can Meteor 3.5's bundler resolve pi-ai's ESM exports map?
// Static imports on purpose: this is exactly what the package would do.
import * as piaiRoot from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

export function s1Report() {
  const rootKeys = Object.keys(piaiRoot);
  return {
    rootResolved: rootKeys.length > 0,
    rootExportCount: rootKeys.length,
    hasType: typeof piaiRoot.Type !== 'undefined',
    hasCalculateCost: typeof piaiRoot.calculateCost === 'function',
    hasEventStream: typeof piaiRoot.EventStream !== 'undefined',
    subpathResolved: typeof anthropicProvider !== 'undefined',
    subpathType: typeof anthropicProvider,
  };
}
