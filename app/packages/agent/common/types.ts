export type Phase =
  | 'idle' | 'streaming' | 'calling' | 'awaiting'
  | 'compacting' | 'retrying' | 'stopped' | 'error';

/**
 * Phases in which a turn is supposed to be RUNNING.
 *
 * ONE definition, deliberately: the watcher asks "is this session leased by a
 * process that should be driving it?" (a session in one of these with no live
 * lease is an orphan) and subagent dispatch asks "is this child mid-run?"
 * (a child in one of these has no outcome to report yet, whether it is running
 * elsewhere or orphaned). Two lists answering the same question is how they
 * drift; the harness has been bitten by exactly that once already (the loop's
 * wake exclusions vs. its terminal phases).
 */
export const ACTIVE_PHASES: Phase[] = ['streaming', 'calling', 'retrying', 'compacting'];

/**
 * Phases in which a turn has been DECIDED and is not the harness's to wake or
 * idle back: `stopped` is a deliberate interrupt that outranks any standing
 * verdict until the next send, `error` is a failed turn whose note is already
 * in the transcript, and `awaiting` is a live approval question a human still
 * owns (idling it would strand the parked call — approve/deny only fire on that
 * phase).
 *
 * ONE definition, deliberately — the same rule as `ACTIVE_PHASES` above. This
 * exact three-element set was written out inline six times (the loop's `$nin`
 * entry guard, its two winding-down `finally` blocks, the two wake self-checks,
 * and the watcher's wake exclusions); those copies disagreeing about whether
 * `error` belonged was itself a reviewed defect. A new terminal phase must be
 * added here and nowhere else.
 *
 * Note the partition: `ACTIVE_PHASES` (running) and `DECIDED_PHASES` (settled)
 * are disjoint and together cover every phase except `idle` — the only phase
 * that is neither mid-run nor decided. The unit test asserts that split so a
 * newly added `Phase` cannot be silently left unclassified.
 */
export const DECIDED_PHASES: Phase[] = ['stopped', 'error', 'awaiting'];

/**
 * The dotted session-counter paths a `$inc` may name.
 *
 * Mongo modifier keys are STRINGS, so `{ $inc: { 'budgetSpent.toolCall': 1 } }`
 * — a typo for `toolCalls` — type-checks fine as a plain object and silently
 * disables the budget it was meant to raise. That is the one bug class the
 * type gate could not otherwise catch (the collection writes go through
 * `rawCollection()`, whose driver types the modifier as `any`). Constraining
 * every counter `$inc` to `SessionInc` turns that typo back into a compile
 * error. Add a path here when you add a counter; a stray key is then rejected.
 */
export type SessionCounterPath =
  | 'nextSeq'
  | 'budgetSpent.turns'
  | 'budgetSpent.toolCalls'
  | 'usage.input'
  | 'usage.output'
  | 'usage.cost';

/** A `$inc` payload over the session counters — see `SessionCounterPath`. */
export type SessionInc = Partial<Record<SessionCounterPath, number>>;

export interface Usage { input: number; output: number; cost: number }

/**
 * One member of a session's roster (participants spec §4.1) — a HUMAN
 * (account-holding or channel-identified) or a MODEL (an agent-registry name).
 *
 * The roster is the authorization surface for n:n sessions: absent, the
 * session is the classic owner-plus-primary pair and behaves bit-for-bit as it
 * always has; present, it is the COMPLETE list of who may read, write, and
 * speak. Materialization seeds the owner and the primary model in one
 * single-winner write, so the array is never a half-roster.
 */
export interface SessionParticipant {
  /**
   * Derived, stable, collision-is-the-guard:
   *   humans:  `h:<userId>` (account) | `x:<kind>:<externalUserId>` (channel
   *            identity) | `h:anon` (the anonymous capability-URL owner)
   *   models:  `m:<agentName>`
   * Channel identity components are written exactly as the channel's lens
   * normalizes them (email: lowercase) — membership is an exact match.
   */
  id: string;
  kind: 'human' | 'model';
  /** Ownership is a ROLE in the roster, not a parallel system: the owner row
   *  mirrors `session.userId`. Models are always members. */
  role: 'owner' | 'member';
  /** Humans: the linked account, or null for the anonymous owner. Updated by
   *  link-time reconciliation when a channel-identified member later links. */
  userId?: string | null;
  /** Humans who joined via a surface: the channel identity that admits them
   *  through ingress. A member with an identity and no userId has NO DDP
   *  capability at all — their standing exists only while ingress vouches for
   *  the verified sender (the `via` principal, participants spec §4.2). */
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
    /**
     * WHO the parked tool will run as, put in front of the person deciding.
     *
     * Present only when the tool's spec carries `runAs` — and `null` is a real
     * value there (the ANONYMOUS service context), which is why every check on
     * this field is `!== undefined` and never truthiness. ABSENT means the tool
     * runs as the session's own owner, which needs no announcement.
     *
     * An approver being asked to authorize `billing.credit` is entitled to know
     * it will run as `service-account` rather than as them: that is the
     * difference between approving a request and approving an escalation.
     * `<agent-chat>` renders it as "— runs as <id|anonymous>" in the approval
     * bar, and the `kind: 'approval'` note records it so the audit row says what
     * was authorized and not merely that something was.
     */
    runAs?: string | null;
    /**
     * WHICH MODEL PARTICIPANT's turn parked this call (participants spec
     * decision 6) — the agent-registry name, recorded at PARK time exactly as
     * `mcpServer` is, because that is the last moment anything knows. Every
     * resume path (`recordVerdict`, the approval timeout, the watcher) builds
     * the resumed turn's config from this instead of `session.agent`, so an
     * approved call parked by an addressee model resumes with that model's
     * tools rather than answering `unknown-tool` under the primary's. Absent
     * on primary-model parks (the common case) and on parks written before
     * the field existed — both fall back to `session.agent`.
     */
    agent?: string;
    /**
     * Approval legibility (participants spec §8): the tool's own one-line
     * account of what THIS call will do — compose resolves ref ids to names
     * and sizes — produced by the spec's `describe(args, ctx)` at PARK time
     * and preferred by the approval bar and every channel's prompt rendering
     * over raw args JSON. Absent when the tool has no `describe` or it threw
     * (a broken description must never fail a park). Advisory: `run` still
     * re-validates everything after the verdict, so a stale display can
     * approve a call the policy then refuses — the refusal reaches the
     * model, exactly as today.
     */
    display?: string;
    /**
     * IDENTITY for the wake this verdict schedules, stamped by `writeVerdict`
     * in the same atomic write as the verdict itself.
     *
     * The loop's wind-down self-check re-reads the session inside its deferred
     * callback, because a legitimate resume can start AND finish in between.
     * Re-checking that "a verdict still stands" is a BOOLEAN answer to an
     * IDENTITY question: verdict A can be consumed, the batch re-park on its
     * next gate, and a second verdict B be written and already deferred by the
     * time the first timer fires — three writes later, the boolean still says
     * yes. The token says WHICH verdict was seen: the deferred callback
     * proceeds only if the token it captured is still the one on the document.
     *
     * A fresh park writes a whole new `pending` object, so a re-park clears it
     * — which is the point. Absent on verdicts written before this field
     * existed (and by tests that stamp a verdict directly), where the check
     * degrades to the old boolean form rather than refusing to wake at all.
     */
    wakeToken?: string;
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
  /**
   * CHANNEL-ORIGINATED sessions only (channels spec §5.2): which external
   * surface this session started on, and how strongly the sender's identity was
   * proven. Follows the `parent`/`forkedFrom` idiom exactly — absent by
   * default, additive, migration-free, and a DESCRIPTOR rather than routing
   * state (routing is the bindings collection's job,
   * `server/channels/collections.ts`).
   *
   * `origin` is the channel kind (`'slack'`, `'sms'`, …) — an open string, not
   * a union, because kinds are app-registered. `assurance` is the identity
   * strength the session was created under: `'none'` for an unlinked sender
   * (an anonymous capability-owned session), `'link'` for one proven by a
   * single-use link, `'oidc'` for a full OAuth round-trip. Gates and tools
   * read it to vary by surface — "require a real login before a refund" is a
   * one-line predicate, not a second permission system. It holds no secrets,
   * so it may ship to the client unprojected.
   */
  channel?: { origin: string; assurance: 'none' | 'link' | 'oidc' };
  /**
   * THROWAWAY sessions only (`Agent.ask`): this session is deleted the moment
   * its one turn answers. Stamped so tools that create standing state
   * pointing back at the session — compose's `onReply: 'continue'` pre-bind
   * is the canonical case — can refuse: a continued conversation must not
   * point at a session that is about to vanish (participants spec decision
   * 20). Additive; absent on every real session.
   */
  ephemeral?: true;
  /**
   * The ROSTER (participants spec §4.1) — absent on the classic 1:1 session,
   * complete when present (seeded with the owner and the primary model in a
   * single-winner write). The `channel`/`parent` idiom: optional, additive,
   * migration-free. Capped at `MAX_PARTICIPANTS`.
   */
  participants?: SessionParticipant[];
  /**
   * Model-relay hops since the last HUMAN message (participants spec §4.3). A
   * model's reply that leads with `@<other-model>` schedules that model's turn
   * and increments this; any human send resets it to 0. At `budget.relay`
   * (default 4) the relay row still commits and delivers — it just schedules
   * nothing, and a note-only budget row says why. Absent reads as 0.
   */
  relay?: number;
  /**
   * The DURABLE relay wake (participants spec decision 7): written in the same
   * atomic write that allocates the relaying reply's seq, consumed (`$unset`)
   * by the addressee's turn, cancelled by any human send, and swept by the
   * watcher — because a bare `deferTurn` from inside a committing turn lands
   * in exactly the non-durable-wake race `pending.wakeToken` exists for.
   * `token` is identity, not a boolean, for the same reason the verdict wake
   * carries one.
   */
  pendingRelay?: { agent: string; token: string };
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentToolCall { id: string; name: string; args: unknown }

/**
 * A file riding a MESSAGE ROW: metadata only — the bytes live in the
 * `AgentAttachments` store (server/attachments.ts), keyed by `id`. Rows are
 * read constantly (the loop's history, the publication, the planner's tail
 * scan), so a row never carries content; `size` is the DECODED byte count.
 * The model sees exactly these four fields, rendered as a mechanical suffix
 * at request time, and reads content through the shipped `read_attachment`
 * tool — bytes never enter a prompt in either direction.
 */
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
  role: 'user' | 'assistant' | 'tool' | 'note';
  content?: string;
  thinking?: string;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  /** `role: 'tool'` rows answering a SUBAGENT call, and `kind: 'orphan-child'`
   *  notes: the child session the call ran. It is the handle — a client holding
   *  this transcript subscribes to `agent.session` with the child agent's name
   *  and this id to follow the child's own live transcript. Present even when
   *  the result is an error (`subagent-parked`, `subagent-failed`), because the
   *  child session exists and is exactly what a human needs to look at; absent
   *  when no child was ever created (`subagent-depth`, an unknown agent name).
   *
   *  These two row kinds are the ONLY carriers of the field, which is what lets
   *  the watcher ask "is this child reachable from its parent's transcript at
   *  all" with one query over `childSessionId` and no role filter. */
  childSessionId?: string;
  /** `kind: 'orphan-child'` notes only: which AGENT the recovered child ran.
   *  Subscribing to a child needs its agent name as well as its id
   *  (`agent.session` is scoped by both), and the note is the only place a
   *  client holding the parent transcript can learn it — the child session
   *  document itself is not published to a client that cannot already name it. */
  childAgent?: string;
  error?: { error: string; reason?: string };
  /**
   * `orphan-child`: the watcher found a child session whose parent transcript
   * had no row naming it — a dispatch abandoned after the child was created and
   * before its result row landed — and wrote this pointer so the child is
   * reachable from the conversation again (§4.3). It answers no tool call and
   * carries no result: the child's own transcript is the record of what it did.
   */
  kind?: 'compaction' | 'error' | 'budget' | 'interrupted' | 'approval' | 'orphan-child';
  /** `kind: 'budget'` notes only. WHICH limit tripped, so a UI can say
   *  "out of tool calls" rather than "budget exhausted" and an operator can
   *  raise the right one. The human-readable half lives in `error.reason`. */
  budget?: 'turns' | 'toolCalls' | 'spend' | 'relay';
  /** `kind: 'approval'` notes only. Structured, never prose: an approval is
   *  transcript history a UI renders and an audit reads, not a sentence. */
  approved?: boolean;
  by?: string | null;
  /** `kind: 'approval'` notes in ROSTERED sessions only: the deciding
   *  member's participant id, so an audit of a group session names which
   *  member answered rather than a bare account id. Absent on 1:1 sessions
   *  and on rows written before rosters existed. */
  byParticipant?: string;
  /** `kind: 'approval'` notes only, and only when the parked tool carried a
   *  `runAs`: the identity the approved call runs under (`null` = the anonymous
   *  service context). Copied from `pending.runAs` so the audit row records WHAT
   *  was authorized, not merely that someone said yes — an approval of a call
   *  that runs as `service-account` is a different fact from an approval of one
   *  that runs as the approver. Absent when the tool runs as the session's
   *  owner. */
  runAs?: string | null;
  /** A structured TOKEN, not a sentence: `'approval timed out'` on a timeout
   *  row, `'recovered'` on an `orphan-child` note. A UI renders its own prose
   *  from it. */
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
  /**
   * Files this row carries — REFS only, bytes in the store (see
   * `AttachmentRef`). Legal on `user` rows (inbound files the channel
   * admitted) and `assistant` rows (files a tool staged for the turn's reply,
   * claimed at the turn-final commit). Additive and migration-free, the
   * `channel`/`parent` idiom.
   */
  attachments?: AttachmentRef[];
  /**
   * WHO wrote this row (participants spec decision 4) — stamped by TRUSTED
   * CODE only: the DDP send (caller), ingress (the verified channel sender),
   * the loop (the model that ran the turn), and dispatch (tool rows carry the
   * running model, so the per-model projection can tell whose working to
   * drop). Never parsed from text, never settable by a model. Stamped on
   * every new row regardless of roster — additive and invisible to old
   * readers — so a roster materialized mid-session attributes history it did
   * not exist for; rows older than the field project with fixed defaults
   * (assistant/tool → the primary model, user → the owner).
   */
  from?: { participant: string; name: string };
  /**
   * The ADDRESSEE (participants spec decision 5): a participant id, stamped
   * mechanically — from an explicit `extras.to` or a leading `@<agent-name>`
   * token, matched against the roster's models. Addressing selects which
   * model's config answers; `to` naming a human is recorded and schedules
   * nothing. Assistant rows whose `to` names a model are internal
   * deliberation: the web shows them, channel delivery skips them.
   */
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
  /** `kind: 'tool_args'` only. The provider's content-block index for the tool
   *  call this fragment belongs to — the attribution that lets a consumer
   *  reassemble PARALLEL tool calls instead of splicing their JSON together.
   *  Absent for text/thinking, and for a provider that reports no index. */
  contentIndex?: number;
  /** WHICH MODEL PARTICIPANT is streaming — stamped on every delta of a
   *  rostered session's turn so the in-flight row can be attributed before it
   *  commits (`mergeView` copies the first delta's). Absent on 1:1 sessions,
   *  whose deltas stay byte-identical to before the field existed. */
  from?: { participant: string; name: string };
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
