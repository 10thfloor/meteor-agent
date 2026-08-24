export const NAMES = {
  sessions: 'agent_sessions',
  messages: 'agent_messages',
  deltas: 'agent_deltas',
  // Channels (§channels spec): identity, routing, delivery, admission, linking.
  channelIdentities: 'agent_channel_identities',
  channelBindings: 'agent_channel_bindings',
  deliveryReceipts: 'agent_delivery_receipts',
  inboundSubmissions: 'agent_inbound_submissions',
  channelLinkTokens: 'agent_channel_link_tokens',
  channelVerdictTokens: 'agent_channel_verdict_tokens',
  // Attachments (email v2 spec): file bytes in a side store, refs on rows.
  attachments: 'agent_attachments',
  // Downloads (participants spec §7): minted, single-use capability tokens.
  attachmentTokens: 'agent_attachment_tokens',
  // Memory (memory spec): durable recall about people and about the work.
  memories: 'agent_memories',
  pubSession: 'agent.session',
  pubSessions: 'agent.sessions',
  mStart: 'agent.start',
  mSend: 'agent.send',
  mInterrupt: 'agent.interrupt',
  mFork: 'agent.fork',
  mApprove: 'agent.approve',
  mDeny: 'agent.deny',
  mCompact: 'agent.compact',
  mAttachmentToken: 'agent.attachmentToken',
  pubMemories: 'agent.memories',
  // The UI caps (memory spec decision 7). Registered ONCE behind a latch at
  // the first memory-declaring define(); dotted names are DDP-only — the
  // model-facing tools use underscored, provider-safe names.
  mMemorySave: 'memory.save',
  mMemorySearch: 'memory.search',
  mMemoryForget: 'memory.forget',
} as const;

/** Capped collection size in bytes. Sized for ~200 concurrent streaming turns. */
export const DELTA_CAP_BYTES = 32 * 1024 * 1024;
