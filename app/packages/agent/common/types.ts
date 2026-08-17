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
    /**
     * Present only when the parked call was an MCP tool: which server it came
     * from. Recorded at PARK time because that is the last moment anything
     * knows.
     *
     * A whole-server spec (`{ mcp: { server } }`) has no tool names of its own —
     * they come from `tools/list`. If the server is unreachable when the verdict
     * resumes the turn, the expanded tool list simply has no entry for the name,
     * and the resume would report `unknown-tool`: a lie that tells an operator
     * to go looking for a rename that never happened. With this field it reports
     * `mcp-unavailable` instead, the same answer the streaming path gives.
     *
     * Absent on sessions parked before this field existed, which fall back to
     * the old `unknown-tool` answer — a stale marker is not worth a migration.
     */
    mcpServer?: string;
  };
  lease?: { serverId: string; until: Date };
  budgetSpent: { turns: number; toolCalls: number };
  /**
   * SUBAGENT sessions only: which parent session's tool call opened this one.
   * Its presence is what makes a session a CHILD — `agent.sessions` excludes
   * them (`parent: { $exists: false }`) so a session list stays
   * conversation-level, while `agent.session` serves a child exactly as it
   * serves any other session: the child inherits the parent's `userId`, so the
   * publication's ownership check needs no special case.
   *
   * The parent's tool row carries the mirror image (`childSessionId`), which is
   * how a client holding the parent finds the child to subscribe to.
   */
  parent?: { sessionId: string; toolCallId: string };
  /**
   * PARENT sessions only, and only WHILE a subagent dispatch is in flight: the
   * child currently running behind a tool call. This is the live handle — the
   * tool row that carries `childSessionId` durably is only written after the
   * child resolves, so without this field a streaming child is unreachable
   * from any client. Cleared (guarded) when the dispatch returns; a lease
   * steal mid-dispatch can leave it stale until the recovering server's turn
   * writes, which is why readers should treat it as a hint, not a contract.
   */
  activeChild?: { sessionId: string; toolCallId: string };
  /**
   * FORKED sessions only: which session this one was branched from, and at
   * which `seq` the copy stopped (inclusive — every message with `seq <= seq`
   * was copied, keeping its original seq and a fresh `_id`).
   *
   * A DIFFERENT relationship from `parent`, deliberately. `parent` says "this
   * session is one turn's internal work inside another session", which is why
   * `agent.sessions` excludes it. A fork is a new ROOT conversation that merely
   * remembers where it came from: it is listed, it is driven by the user, and
   * nothing about it is subordinate to the source. So a fork copies neither
   * `parent` nor `depth` — copying `parent` would hide a user's own fork from
   * their session list, and copying `depth` would charge a root conversation
   * for hops it never took.
   *
   * The seq is the source's cut point, which is always a batch-safe boundary
   * (see `findForkCut`): the fork can never begin life holding a `tool_use`
   * with no `tool_result`.
   */
  forkedFrom?: { sessionId: string; seq: number };
  /**
   * How many subagent hops deep this session is. Absent (read as 0) on a root
   * session; `parent.depth + 1` on a child. The guard that keeps agents
   * composing agents from fork-bombing: past `MAX_SUBAGENT_DEPTH` the tool call
   * is REFUSED with a structured `subagent-depth` result the model can route
   * around, and no child session is created at all.
   */
  depth?: number;
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
  /** `role: 'tool'` rows answering a SUBAGENT call only: the child session the
   *  call ran. It is the handle — a client holding this transcript subscribes
   *  to `agent.session` with the child agent's name and this id to follow the
   *  child's own live transcript. Present even when the result is an error
   *  (`subagent-parked`, `subagent-failed`), because the child session exists
   *  and is exactly what a human needs to look at; absent when no child was
   *  ever created (`subagent-depth`, an unknown agent name). */
  childSessionId?: string;
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
  /** Present on committed rows (copied from the message); absent on in-flight
   *  reconstructions, which have not been created yet in any durable sense. */
  createdAt?: Date;
}
