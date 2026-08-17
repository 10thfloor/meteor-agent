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
  /** `kind: 'approval'` notes only, and only when true: the watcher denied this
   *  request because `budget.approval` elapsed with nobody answering (§4.3).
   *  `by` is null on those rows — nobody decided — and a UI must be able to say
   *  "timed out" rather than implying a person refused. */
  timedOut?: boolean;
  /** `kind: 'compaction'` notes only. `summary` is what the MODEL sees in
   *  place of everything at-or-before seq `upto`; the transcript itself keeps
   *  every message — compaction changes the model's view, never history. */
  summary?: string;
  upto?: number;
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
  /** `kind: 'tool_args'` only. The provider's content-block index for the tool
   *  call this fragment belongs to — the attribution that lets a consumer
   *  reassemble PARALLEL tool calls instead of splicing their JSON together.
   *  Absent for text/thinking, and for a provider that reports no index. */
  contentIndex?: number;
  at: Date;
}

/** A merged row: either a committed message or an in-flight reconstruction. */
export interface ViewMessage extends Omit<AgentMessage, 'createdAt'> {
  streaming: boolean;
  truncatedHead?: boolean;
  deltaCount?: number;
  /**
   * IN-FLIGHT rows only, and present only when tool-argument fragments have
   * arrived: the partial arguments JSON of each tool call the assistant is
   * still streaming, KEYED BY the provider's content-block index.
   *
   * One entry per concurrent tool call, so two calls streaming at once stay
   * two strings rather than one interleaved mess. The values are PARTIAL JSON
   * — a consumer that wants to render them mid-stream needs a tolerant parser,
   * and one that does not can ignore the field entirely. The committed message
   * supersedes it with the real `toolCalls` array, on which `args` is a parsed
   * object; nothing here is ever the source of truth for dispatch.
   *
   * Runtime keys are strings (they are object keys); the `number` in the type
   * says what they mean. Fragments from a provider that reports no index
   * collect under `0`.
   */
  toolArgs?: Record<number, string>;
}
