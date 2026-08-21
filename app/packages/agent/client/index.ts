export * from '../common/types';
export { NAMES } from '../common/names';
export { mergeView } from '../common/merge';
export { Agent } from './agent';
// The packaged UI. Exported, never self-registering: `defineAgentChat()` is
// the app's call to make (see client/element.ts).
export { defineAgentChat } from './element';

// The channel LENS CONTRACT (channels spec §8). Re-exported here as well as
// from the server entry, for two reasons: contract.ts is deliberately PURE —
// closed unions, one matching rule, one property test, no I/O and no server
// imports — so it is isomorphic by construction; and this file is also the
// face `tsc` sees for `meteor/10thfloor:agent` (see tsconfig `paths`), so a
// channel package (`10thfloor:agent-channel-slack`) type-checks against the
// same module id it imports at runtime. The type-only re-exports below are
// erased; nothing server-shaped enters the client bundle.
export {
  assertLensRoundTrip, exemplarItems, matchExpectation,
  DELIVERY_ITEM_KINDS, MENU_MATCHES,
} from '../server/channels/contract';
export type {
  ChannelProfile, ChannelTransport, DeliveryItem, InboundIntent,
  InboundReading, Lens, PromptChoice, RoundTripOptions,
} from '../server/channels/contract';
export type { ChannelDef, RawInbound } from '../server/channels/registry';
