export type Phase =
  | 'idle' | 'streaming' | 'calling' | 'awaiting'
  | 'compacting' | 'retrying' | 'stopped' | 'error';

/** Phases in which a turn is running. ONE definition — two lists answering
 *  the same question is how they drift. */
export const ACTIVE_PHASES: Phase[] = ['streaming', 'calling', 'retrying', 'compacting'];

/** Phases that are decided — not the harness's to wake or idle. Disjoint with
 *  `ACTIVE_PHASES`; together they cover every phase except `idle`. */
export const DECIDED_PHASES: Phase[] = ['stopped', 'error', 'awaiting'];

/** Valid `$inc` paths — typos in dotted Mongo modifier keys silently disable
 *  budgets; this type turns them into compile errors. */
export type SessionCounterPath =
  | 'nextSeq'
  | 'budgetSpent.turns'
  | 'budgetSpent.systemTurns'
  | 'budgetSpent.toolCalls'
  | 'usage.input'
  | 'usage.output'
  | 'usage.cost';

/** A `$inc` payload over the session counters — see `SessionCounterPath`. */
export type SessionInc = Partial<Record<SessionCounterPath, number>>;

export interface Usage { input: number; output: number; cost: number }

/** One roster member (§4.1) — human or model. Absent = classic 1:1 session;
 *  present = complete authorization list, seeded atomically. */
export interface SessionParticipant {
  /** `h:<userId>` | `x:<kind>:<externalUserId>` | `h:anon` | `m:<agentName>`. */
  id: string;
  kind: 'human' | 'model';
  /** Owner row mirrors `session.userId`. Models are always members. */
  role: 'owner' | 'member';
  /** Humans: the linked account, or null for the anonymous owner. Updated by
   *  link-time reconciliation when a channel-identified member later links. */
  userId?: string | null;
  /** Channel identity that admits them. No userId = no DDP capability. */
  identity?: { kind: string; externalUserId: string };
  assurance?: 'none' | 'link' | 'oidc';
  /** Models: the registry name whose config runs this participant's turns. */
  agent?: string;
  /** What attribution renders — prompts, transcripts, the web element. Display
   *  string discipline applies (control chars stripped, length-capped). */
  displayName: string;
  /** The participant id that admitted them; absent on seeded rows. */
  addedBy?: string;
  joinedAt: Date;
}

/** The roster ceiling — a conversation, not a mailing list. Joins past it are
 *  refused. */
export const MAX_PARTICIPANTS = 16;

export interface AgentSession {
  _id: string;
  agent: string;
  userId: string | null;
  title?: string;
  phase: Phase;
  model: string;
  usage: Usage;
  nextSeq: number;
  /** The parked tool call. Presence + `phase: 'awaiting'` IS the parked state.
   *  `verdict` written exactly once (single-winner); resume `$unset`s it. */
  pending?: {
    toolCallId: string;
    name: string;
    args: unknown;
    requestedAt?: Date;
    verdict?: 'approved' | 'denied';
    /** The userId that decided, or null for an anonymous capability-URL owner. */
    by?: string | null;
    reason?: string;
    /** MCP tools only: which server, recorded at park time so an unreachable
     *  server at resume reports `mcp-unavailable` instead of `unknown-tool`. */
    mcpServer?: string;
    /** Who the tool runs as. `null` = anonymous service context (check with
     *  `!== undefined`, not truthiness). Absent = session owner. */
    runAs?: string | null;
    /** Which model parked this call — resume uses its config, not the
     *  primary's. Absent on primary-model parks (falls back to `session.agent`). */
    agent?: string;
    /** Tool's one-line account of the call, from `describe(args, ctx)` at park
     *  time. Absent when no `describe` or it threw. Advisory only. */
    display?: string;
    /** Identity token for the wake. Activation and the Turn's first commit
     *  both require this exact token, so an older verdict cannot consume a
     *  replacement park. */
    wakeToken?: string;
  };
  lease?: { serverId: string; until: Date };
  /** @internal Short durable leases for Session-scoped writes and external
   *  delivery. Erasure fences new entries, then waits for live entries. */
  operations?: Array<{ id: string; until: Date }>;
  /** @internal Compatibility marker written by pre-Transcript-Commit builds.
   * New sends use `pendingInputs`; recovery reads this for one release. */
  pendingInput?: {
    token: string;
    at: Date;
    messageId?: string;
    /** Operation that owns the Message reservation. Optional on older rows. */
    operationId?: string;
  };
  /** @internal Compact, level-triggered wake links for user Messages. The
   * reconstructable draft lives in a private reservation collection until its
   * deterministic Message row exists. Links remain until the Transcript proves
   * the input was answered, closing materialize→activate crash windows. */
  pendingInputs?: Array<{
    messageId: string;
    seq: number;
    at: Date;
  }>;
  /** `systemTurns` is optional (legacy docs lack it) — read as `?? 0`. */
  budgetSpent: { turns: number; toolCalls: number; systemTurns?: number };
  /** Subagent sessions: which parent session's tool call opened this one.
   *  Presence makes a session a child — excluded from `agent.sessions`. */
  parent?: { sessionId: string; toolCallId: string };
  /** Live handle to an in-flight subagent child — a hint, not a contract
   *  (can go stale on lease steal). Cleared when dispatch returns. */
  activeChild?: { sessionId: string; toolCallId: string };
  /** Forked sessions: source session and inclusive cut-point seq. A fork is a
   *  new ROOT conversation (not a child), so it copies neither `parent` nor
   *  `depth`. Cut point is always batch-safe (see `findForkCut`). */
  forkedFrom?: { sessionId: string; seq: number };
  /** Subagent hop count. Absent (0) on root; refused past `MAX_SUBAGENT_DEPTH`. */
  depth?: number;
  /** Channel-originated sessions: origin surface and identity assurance level.
   *  Descriptor only — routing is the bindings collection's job. */
  channel?: { origin: string; assurance: 'none' | 'link' | 'oidc' };
  /** Throwaway (`Agent.ask`): deleted after one turn. Tools that create
   *  standing state pointing back at the session must refuse. */
  ephemeral?: true;
  /** @internal Durable lifecycle fence. Once present, no new turn, delivery,
   *  or user mutation may begin; the server removes package-owned session
   *  data after every lease in the recursive child tree is quiet. */
  erasingAt?: Date;
  /** @internal Final cleanup gate. Operation heartbeats cannot cross it. */
  purgingAt?: Date;
  /** Roster (§4.1) — absent on 1:1, complete when present. Capped at `MAX_PARTICIPANTS`. */
  participants?: SessionParticipant[];
  /** Model-relay hops since the last human message. At `budget.relay` the
   *  relay commits but schedules nothing. Absent reads as 0. */
  relay?: number;
  /** Durable relay wake — written atomically with the relay's seq, consumed by
   *  the addressee's turn. `token` is identity, same as `wakeToken`. */
  pendingRelay?: { agent: string; token: string };
  /** Durable scheduled System turn (one per session). Cleared by that Turn's
   *  first commit, not by Activation. A second park is refused. */
  pendingSystem?: {
    prompt: string;
    agent?: string;
    source?: string;
    key?: string;
    token: string;
    at: Date;
  };
  /** Last system-turn idempotency key — refuses repeated keys. */
  lastSystemKey?: string;
  /** Display-only archive flag — session still takes turns. Date, not boolean,
   *  because "when" is the natural question. Absent = active. */
  archived?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentToolCall { id: string; name: string; args: unknown }

/** Trusted ingress surface for a human-authored transcript row. DDP methods
 * stamp `desktop`; verified channel ingress stamps the registered channel
 * kind. Clients can read this field but cannot supply it to a write method. */
export type MessageSource =
  | { kind: 'desktop' }
  | {
    kind: 'channel';
    channel: string;
    /** Opaque binding token. It lets egress suppress only the surface that
     * originated the row while fanning out to the Session's other bindings.
     * Random and transport-independent: this is never a conversation id or
     * destination, and browser clients cannot choose it. */
    origin?: string;
  };

/** File metadata on a message row — bytes live in `AgentAttachments`, never in
 *  the row itself (rows are read constantly). `size` is decoded byte count. */
export interface AttachmentRef {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export interface AgentMessage {
  _id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'note' | 'system';
  content?: string;
  thinking?: string;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  /** The child session a subagent call ran. Present even on errors (the child
   *  exists); absent when no child was created. */
  childSessionId?: string;
  /** `kind: 'orphan-child'` only: agent name of the recovered child. */
  childAgent?: string;
  error?: { error: string; reason?: string };
  /** `orphan-child`: watcher recovered a child whose result row never landed. */
  kind?: 'compaction' | 'error' | 'budget' | 'interrupted' | 'approval' | 'orphan-child'
    | 'unrouted-mention' | 'crew-note';
  /** `kind: 'unrouted-mention'` notes only: the agent the text named but did
   *  not address. */
  mentioned?: string;
  /** `kind: 'budget'` notes only. WHICH limit tripped, so a UI can say
   *  "out of tool calls" rather than "budget exhausted" and an operator can
   *  raise the right one. The human-readable half lives in `error.reason`. */
  budget?: 'turns' | 'toolCalls' | 'spend' | 'relay';
  /** `kind: 'approval'` notes only. Structured, never prose: an approval is
   *  transcript history a UI renders and an audit reads, not a sentence. */
  approved?: boolean;
  by?: string | null;
  /** `kind: 'approval'`, rostered sessions: the deciding member's participant id. */
  byParticipant?: string;
  /** `kind: 'approval'` only: identity the call runs under, from `pending.runAs`.
   *  Absent when the tool runs as the session owner. */
  runAs?: string | null;
  /** Structured token, not prose — a UI renders its own text from it. */
  reason?: string;
  /** `kind: 'approval'` only, when true: watcher denied after timeout (`by` is null). */
  timedOut?: boolean;
  /** `kind: 'compaction'` only. Changes the model's view, never history. */
  summary?: string;
  upto?: number;
  /** `cost` present only when the provider priced the call. */
  usage?: { input: number; output: number; cost?: number };
  /** File refs — bytes in the store (see `AttachmentRef`). */
  attachments?: AttachmentRef[];
  /** Who wrote this row — stamped by trusted code only, never settable by a
   *  model. Additive; pre-roster rows project with fixed defaults. */
  from?: { participant: string; name: string };
  /** Where a human row entered the transcript. Trusted server attribution,
   * never accepted from browser input or inferred from message text. */
  source?: MessageSource;
  /** Addressee participant id — selects which model answers. Assistant rows
   *  addressing a model are internal deliberation (channel delivery skips them). */
  to?: string;
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
  /** `kind: 'tool_args'` only: content-block index for reassembling parallel tool calls. */
  contentIndex?: number;
  /** Which model is streaming — for in-flight attribution. Absent on 1:1 sessions. */
  from?: { participant: string; name: string };
  at: Date;
}

/** A merged row: either a committed message or an in-flight reconstruction. */
export interface ViewMessage extends Omit<AgentMessage, 'createdAt'> {
  streaming: boolean;
  truncatedHead?: boolean;
  deltaCount?: number;
  /** In-flight only: partial tool-argument JSON keyed by content-block index.
   *  Never the source of truth — the committed message supersedes it. */
  toolArgs?: Record<number, string>;
  /** Present on committed rows (copied from the message); absent on in-flight
   *  reconstructions, which have not been created yet in any durable sense. */
  createdAt?: Date;
}

/* ---------------------------------------------------------------------------
 * Memory (memory spec)
 * ------------------------------------------------------------------------ */

/** One remembered fact. Person memory (`user`/`agent`) carries a `userId`;
 *  work memory (`app`) has none — `userId` is never `null`, only absent. */
export interface AgentMemory {
  _id: string;
  /** Present for `'user'`/`'agent'` rows; ABSENT for `'app'` rows. */
  userId?: string;
  scope: MemoryScope;
  /** Present only for `scope: 'agent'` — the registry name whose private
   *  per-user note this is. */
  agent?: string;
  /** The fact itself. This is the field mongot auto-embeds. */
  text: string;
  /** Provenance, never authorization — a participant id or `'app'`. */
  by: string;
  /** Upsert identity — same key + scope = one row (crash-recovery idempotent). */
  key?: string;
  /** Always present in the standing block, up to `index.pinned` of them. */
  pinned?: true;
  at: Date;
  /** Opt-in decay, swept by a sparse TTL index. No global forgetting policy. */
  expiresAt?: Date;
}

/** Where a memory lives. `'app'` is the shared work pool; the fourth quadrant
 *  (agent-private, cross-user) is deliberately not built. */
export type MemoryScope = 'user' | 'agent' | 'app';

export const MEMORY_SCOPES: readonly MemoryScope[] = ['user', 'agent', 'app'];

/** Rows per (user, scope) before a save is refused. */
export const MEMORY_MAX_DEFAULT = 200;
export const MEMORY_MAX_APP_DEFAULT = 500;

/** Max text length — enforced with a structured refusal, never silent truncation. */
export const MEMORY_TEXT_MAX = 2000;

/** The resolved `memory` config, frozen into the registry entry at define()
 *  time (the `budget` idiom) so the loop and the tools read settled values. */
export interface ResolvedMemory {
  hints: false | { minScore: number };
  max: number;
  maxApp: number;
  index: { pinned: number; recent: number };
  scopes: MemoryScope[];
  search?: MemorySearchFn;
}

/** The app-installed top rung of the search ladder. Wins over every built-in
 *  rung, including `$vectorSearch`. */
export type MemorySearchFn = (
  query: string,
  ctx: { userId: string | null; agent: string; scopes: MemoryScope[]; limit: number },
) => Promise<AgentMemory[]> | AgentMemory[];

/** What an app writes in `Agent.define`. `true` takes every default. */
export type MemoryConfig = boolean | {
  hints?: boolean | { minScore?: number };
  max?: number;
  maxApp?: number;
  index?: { pinned?: number; recent?: number };
  scopes?: MemoryScope[];
  search?: MemorySearchFn;
};
