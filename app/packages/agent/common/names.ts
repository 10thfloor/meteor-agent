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
  mArchive: 'agent.archive',
  mUnarchive: 'agent.unarchive',
  mCompact: 'agent.compact',
  mAttachmentToken: 'agent.attachmentToken',
  pubMemories: 'agent.memories',
  // Memory methods — namespaced to avoid collisions with host app methods.
  mMemorySave: 'agent.memorySave',
  mMemorySearch: 'agent.memorySearch',
  mMemoryForget: 'agent.memoryForget',
} as const;

/** Capped collection size in bytes. Sized for ~200 concurrent streaming turns. */
export const DELTA_CAP_BYTES = 32 * 1024 * 1024;
