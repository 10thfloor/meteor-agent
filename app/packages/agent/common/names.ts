export const NAMES = {
  sessions: 'agent_sessions',
  messages: 'agent_messages',
  deltas: 'agent_deltas',
  pubSession: 'agent.session',
  pubSessions: 'agent.sessions',
  mStart: 'agent.start',
  mSend: 'agent.send',
  mInterrupt: 'agent.interrupt',
  mApprove: 'agent.approve',
  mDeny: 'agent.deny',
} as const;

/** Capped collection size in bytes. Sized for ~200 concurrent streaming turns. */
export const DELTA_CAP_BYTES = 32 * 1024 * 1024;
