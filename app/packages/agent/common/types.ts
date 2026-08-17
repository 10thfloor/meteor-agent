export type Phase =
  | 'idle' | 'streaming' | 'calling' | 'awaiting'
  | 'compacting' | 'retrying' | 'stopped' | 'error';

export interface Usage { input: number; output: number; cost: number }

export interface AgentSession {
  _id: string;
  agent: string;
  userId: string | null;
  title?: string;
  phase: Phase;
  model: string;
  usage: Usage;
  nextSeq: number;
  /**
   * The one tool call a `gate: 'ask'` park is waiting on. Its presence (with
   * `phase: 'awaiting'`) IS the parked state: no process waits, no timer runs,
   * and repair-on-entry reads it as legitimate history rather than as an
   * abandoned turn.
   *
   * `verdict` is written exactly once, by `agent.approve` / `agent.deny`, under
   * a selector that also requires `phase: 'awaiting'` and no existing verdict —
   * so two approvers racing produce one winner. The resumed turn resolves the
   * call and `$unset`s the whole marker.
   */
  pending?: {
    toolCallId: string;
    name: string;
    args: unknown;
    requestedAt?: Date;
    verdict?: 'approved' | 'denied';
    /** The userId that decided, or null for an anonymous capability-URL owner. */
    by?: string | null;
    reason?: string;
  };
  lease?: { serverId: string; until: Date };
  budgetSpent: { turns: number; toolCalls: number };
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentToolCall { id: string; name: string; args: unknown }

export interface AgentMessage {
  _id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'note';
  content?: string;
  thinking?: string;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  error?: { error: string; reason?: string };
  kind?: 'compaction' | 'error' | 'budget' | 'interrupted' | 'approval';
  /** `kind: 'budget'` notes only. WHICH limit tripped, so a UI can say
   *  "out of tool calls" rather than "budget exhausted" and an operator can
   *  raise the right one. The human-readable half lives in `error.reason`. */
  budget?: 'turns' | 'toolCalls' | 'spend';
  /** `kind: 'approval'` notes only. Structured, never prose: an approval is
   *  transcript history a UI renders and an audit reads, not a sentence. */
  approved?: boolean;
  by?: string | null;
  reason?: string;
  /** `cost` is present only when the PROVIDER priced the call; the harness's
   *  own `pricing` fallback accrues to the session total without claiming the
   *  message carries a provider-reported figure. */
  usage?: { input: number; output: number; cost?: number };
  createdAt: Date;
}

export type DeltaKind = 'text' | 'thinking' | 'tool_args' | 'tool_output';

export interface AgentDelta {
  _id: string;
  sessionId: string;
  messageId: string;
  msgSeq: number;
  seq: number;
  kind: DeltaKind;
  chunk: string;
  at: Date;
}

/** A merged row: either a committed message or an in-flight reconstruction. */
export interface ViewMessage extends Omit<AgentMessage, 'createdAt'> {
  streaming: boolean;
  truncatedHead?: boolean;
  deltaCount?: number;
  createdAt?: Date;
}
