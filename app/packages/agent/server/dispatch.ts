import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import type { AgentSession } from '../common/types';
import { guardedUpdate, holdsLease, SERVER_ID } from './lease';
import {
  evaluateGate, gateDeniedResult, runTool,
  type ResolvedTool, type ToolContext, type ToolResult,
} from './tools';
import { runSubagent, type SubagentDispatch } from './subagent';
import { runAfterToolResult, type ToolResultHookContext } from './hooks';
import { allocateSeq, commitBudgetNote } from './turn-state';
import { discardTurn, locateBatch } from './transcript';
import type { RunConfig } from './loop';

/**
 * Tool-call dispatch: running one committed assistant's batch (`dispatchCalls`),
 * resuming a parked batch after a verdict (`resumeParkedTurn`), and the single
 * `dispatchTool` seam both share.
 *
 * `runTurn` is INJECTED as a parameter rather than imported, deliberately. A
 * subagent tool is a nested turn, so `dispatchTool` needs `runTurn` — but
 * `loop.ts` (which owns `runTurn`) imports `dispatchCalls`/`resumeParkedTurn`
 * from here, so importing `runTurn` back would close a value cycle. Threading
 * it through as `RunTurn` keeps the dispatch → loop edge type-only (`RunConfig`
 * is erased) — the same dependency-injection `runSubagent` already used.
 */

/** The `runTurn` entry point, passed in so `dispatchTool` can start a subagent's
 *  nested turn without a `dispatch -> loop` value import. `loop.ts` passes its
 *  own `runTurn`, whose signature this matches. */
export type RunTurn = (sessionId: string, config: RunConfig) => Promise<void>;

/** Threaded into every dispatch path as one bundle so a future path cannot
 *  forget half of it. */
export interface DispatchLimits {
  maxResultChars: number;
  canUse?: RunConfig['canUse'];
}

/**
 * The ONE way a resolved tool is run, whatever its kind.
 *
 * Inline and adopted tools go to `runTool`, which owns argument validation,
 * the ambient method invocation and error sanitization. A SUBAGENT does not:
 * it is not a tool body but a nested TURN, so it needs `runTurn` — passed in
 * here (see the module note) rather than imported, which would close an import
 * cycle (tools -> subagent -> loop -> tools). The seam is at the single point
 * both dispatch paths (a streamed batch and an approved park's resume) already
 * share. `runSubagent` therefore takes `runTurn` as an argument: dependency in,
 * no cycle.
 *
 * The extra return field is the child's session id, which the caller records on
 * the tool row so a client can find and subscribe to the child transcript.
 */
async function dispatchTool(
  tool: ResolvedTool, args: unknown, ctx: ToolContext, runTurn: RunTurn,
): Promise<SubagentDispatch> {
  if (tool.kind === 'subagent') return runSubagent(tool, args, ctx, runTurn);
  return { result: await runTool(tool, args, ctx) };
}

/**
 * One warn per DISTINCT serialization failure kind (`TypeError` for a circular
 * value, `TypeError` for a BigInt, whatever a throwing `toJSON` raises).
 *
 * The same latch pattern as hooks.ts's and the validator's, for the same
 * reason: a tool or hook that returns an unserializable value returns one every
 * single call, and an unlatched warning would be a log line per tool result
 * forever. Keyed per kind rather than once ever, so one failure mode cannot
 * permanently suppress the next.
 */
const warnedSerialization = new Set<string>();

/** What a row says when its result could not be turned into JSON. Structured,
 *  like every other harness-authored failure: the model can read it and route
 *  around, and a UI can render it as an error rather than as an answer. */
const UNSERIALIZABLE = {
  error: 'unserializable-result',
  reason: 'The tool result could not be serialized.',
} as const;

/**
 * The transcript row for a tool result: its `content`, truncated explicitly,
 * and the `error` the row must carry alongside it.
 *
 * `JSON.stringify` THROWS on a circular object and on a BigInt, and a tool's
 * value is app data — a hook's replacement even more so. Unguarded, that throw
 * escapes the dispatch loop and abandons a turn that had already done all of
 * its work, which is a harness failure wearing an app's mistake. Guarded, the
 * row records a structured `unserializable-result` and the turn completes: the
 * model is told the call produced nothing usable and can try something else.
 *
 * Returning the error alongside the content rather than leaving it to the three
 * call sites is deliberate — a site that wrote the substituted content but kept
 * `result.ok`'s `undefined` error would publish a row that claims success and
 * carries an apology.
 */
function toolResultContent(
  result: ToolResult, maxChars: number,
): { content: string; error?: { error: string; reason?: string } } {
  let raw: string;
  try {
    raw = JSON.stringify(result.ok ? result.value : result.error) ?? 'null';
  } catch (e) {
    const kind = (e as Error)?.name ?? 'Error';
    if (!warnedSerialization.has(kind)) {
      warnedSerialization.add(kind);
      console.warn(
        '[10thfloor:agent] a tool result could not be serialized for the transcript '
        + `(${kind}: ${(e as Error)?.message}); the row records `
        + 'unserializable-result (warned once per kind)',
      );
    }
    return { content: JSON.stringify(UNSERIALIZABLE), error: { ...UNSERIALIZABLE } };
  }
  const content = raw.length <= maxChars
    ? raw
    : `${raw.slice(0, maxChars)}…[truncated ${raw.length - maxChars} of ${raw.length} chars]`;
  return { content, error: result.ok ? undefined : clampErrorReason(result.error, maxChars) };
}

/**
 * Clamp a failed row's `error.reason` to `maxChars`, the same ceiling and the
 * same explicit marker `content` gets above.
 *
 * `reason` reaches a published row from model- and caller-controlled strings — a
 * denial reason typed into `agent.deny`, a subagent's composed message, an MCP
 * server's answer — and unlike `content` it rides as its own field, so the
 * content clamp does not bound it. A million-character reason on a published,
 * capped-adjacent transcript is the same hazard truncation exists to prevent.
 */
function clampErrorReason(
  error: { error: string; reason?: string } | undefined, maxChars: number,
): { error: string; reason?: string } | undefined {
  if (!error || typeof error.reason !== 'string' || error.reason.length <= maxChars) {
    return error;
  }
  return {
    ...error,
    reason: `${error.reason.slice(0, maxChars)}…[truncated ${error.reason.length - maxChars} `
      + `of ${error.reason.length} chars]`,
  };
}

/**
 * What a batch of tool calls did to the turn that owns it.
 *
 * `parked` and `abandoned` both mean the caller must return WITHOUT falling
 * into the think loop — one because someone outside this turn owes us an
 * answer (a human at a gate, or the `agent.send` that clears an interrupt), the
 * other because the turn no longer exists. Only `completed` means every call in
 * the batch now carries a `tool` row, which is the precondition for asking the
 * model what to do next.
 */
export type DispatchOutcome = 'completed' | 'parked' | 'abandoned';

interface TurnAnchor {
  userId: string | null;
  /** The session's agent name — half of every hook's ctx. Read off the session
   *  document rather than threaded through `RunConfig`: a CHILD session's
   *  agent is the child's, and the session is the only place that is true. */
  agent: string;
  /** The committed assistant carrying the `tool_use`s — the discard anchor. */
  messageId: string;
  assistantSeq: number;
  /** EVERY call id of that assistant, not just the ones still to run: a
   *  discard has to take the whole batch's results with it. */
  batchIds: string[];
}

/**
 * Dispatch tool calls for one committed assistant, in order, answering each
 * with a `tool` row — or parking the turn on the first call whose gate asks.
 *
 * Shared by the streaming path and the resume path so a call is gated by the
 * SAME rule wherever it is reached: approving one call says nothing about the
 * next one, and a batch resumed after an approval must re-gate its remainder
 * rather than inherit the verdict.
 *
 * Every gate form is decided here and only here — the literal `'auto'`/`'ask'`
 * and the predicate alike (`evaluateGate`). A predicate that refuses answers the
 * call with a structured `denied-by-gate` row and the batch carries on; only an
 * `'ask'` parks.
 */
export async function dispatchCalls(
  sessionId: string,
  calls: Array<{ id: string; name: string; args: unknown }>,
  tools: ResolvedTool[],
  turn: TurnAnchor,
  budget: RunConfig['budget'],
  limits: DispatchLimits,
  runTurn: RunTurn,
): Promise<DispatchOutcome> {
  const abandon = async (): Promise<DispatchOutcome> => {
    await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
    return 'abandoned';
  };
  const hookCtx: ToolResultHookContext = {
    agent: turn.agent, sessionId, userId: turn.userId,
  };

  /**
   * Answer a call that was REFUSED before dispatch — a `canUse` backstop or a
   * predicate gate that said no.
   *
   * One helper for both because the write is subtle in the same three ways
   * every time and a second copy would drift on all three: the refusal goes
   * through `afterToolResult` (a row entering a published transcript is exactly
   * what that seam is for), the seq allocation carries NO `toolCalls` charge
   * (nothing was dispatched, so nothing was spent), and the row's `error` comes
   * back from the serializer rather than from the refusal we started with — a
   * hook may have turned it into a success.
   *
   * Returns false when the seq could not be allocated, i.e. the turn is gone.
   */
  const refuse = async (
    call: { id: string; name: string; args: unknown }, refusal: ToolResult,
  ): Promise<boolean> => {
    const result = await runAfterToolResult(refusal, call, hookCtx);
    const seq = await allocateSeq(sessionId);
    if (seq === null) return false;
    const row = toolResultContent(result, limits.maxResultChars);
    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq, role: 'tool',
      toolCallId: call.id,
      content: row.content,
      error: row.error,
      createdAt: new Date(),
    });
    return true;
  };

  for (const call of calls) {
    // §7's backstop, BEFORE the gate: a tool the agent may not use must never
    // park either — asking a human to approve a call the config forbids is a
    // request nothing may grant. Refusal is a result (no toolCalls budget:
    // nothing dispatched), and the model routes around it.
    if (limits.canUse
      && !(await limits.canUse(call.name, { userId: turn.userId, sessionId }))) {
      if (!(await refuse(call, {
        ok: false,
        error: { error: 'not-allowed', reason: `This agent may not use ${call.name}.` },
      }))) return abandon();
      continue;
    }
    // Ownership is checked BEFORE dispatch, not after. Adopted tools are real
    // Meteor methods: running one we no longer own means the recovering server
    // runs it a second time — a second charge, a second email. The window
    // between this check and the tool's own side effect is irreducible without
    // idempotency keys carried through to the tools themselves; this narrows
    // the window, it does not close it.
    if (!(await holdsLease(sessionId))) return abandon();

    // An interrupt landing after the assistant committed with toolCalls must
    // discard the turn exactly like an abandonment: committing SOME results
    // and stopping would strand the rest as unanswered tool_use, and
    // repair-on-entry would eat the turn next time anyway.
    const phaseCheck = await AgentSessions.findOneAsync(sessionId);
    if (!phaseCheck || phaseCheck.phase === 'stopped') return abandon();

    // §9: BEFORE the dispatch, off the document we just read — a limit of N
    // permits exactly N calls, because `budgetSpent.toolCalls` is $inc'd in the
    // same atomic write that allocates each result's seq. It counts calls that
    // actually RAN: a park spends nothing (the tool has not executed), and a
    // denial spends nothing (it never dispatched), so a batch that sat at a
    // gate for a day resumes against the same budget it left.
    //
    // The trip precedes the gate check deliberately. Asking a human to approve
    // work the session cannot afford wastes their attention and leaves an
    // approval standing that nothing may spend.
    //
    // Discard exactly as an interrupt does. Committing the results we DID get
    // and stopping would strand the remaining calls as unanswered `tool_use` —
    // a 400 from every provider, forever — and repair-on-entry would eat the
    // turn on the next run anyway. Discard first, note second: if the note's
    // writes fail on a lost lease, what is left is a resumable transcript with
    // no explanation, rather than an explanation over a broken one.
    if (budget?.toolCalls !== undefined
      && (phaseCheck.budgetSpent?.toolCalls ?? 0) >= budget.toolCalls) {
      await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
      await commitBudgetNote(sessionId, 'toolCalls');
      return 'abandoned';
    }

    const tool = tools.find((t) => t.name === call.name);

    /**
     * THE gate site — the only place in the package where a gate is read.
     *
     * Two dispatch paths reach it (the streaming batch, and a resumed park's
     * re-dispatch of the calls it never got to), which is what makes "approving
     * one call says nothing about the next" true by construction rather than by
     * two implementations agreeing. The APPROVED call's own resume deliberately
     * does not come through here: see `resumeParkedTurn`.
     *
     * `turn.userId` is the session's owner — the caller. A `runAs` tool's
     * escalated identity is not consulted, on purpose: the gate decides whether
     * the call happens at all, and letting the escalation answer that question
     * would be the escalation approving itself (see the GATES note in tools.ts).
     *
     * A predicate that throws lands here as `'denied'`, never as an exception:
     * a broken gate must not run the tool, and must not kill the turn either.
     */
    const decision = await evaluateGate(tool, {
      userId: turn.userId, sessionId, name: call.name, args: call.args,
    });

    if (decision === 'denied') {
      // A RESULT, not a park and not an abandonment. The model reads
      // `denied-by-gate`, routes around it, and the rest of the batch runs —
      // exactly the `canUse` shape above, and for the same reason: a refusal
      // nobody may overturn has no business waiting on a human. No `toolCalls`
      // budget is spent; nothing was dispatched.
      if (!(await refuse(call, gateDeniedResult(call.name)))) return abandon();
      continue;
    }

    if (decision === 'ask') {
      // Park by EXITING: no process waits here, no timer runs, nothing is
      // held. The committed assistant plus this marker plus `phase:
      // 'awaiting'` ARE the parked state, so it survives a deploy, a crash and
      // a lease expiry alike — approve/deny wake it by deferring a fresh
      // `runTurn`. `repairUnansweredToolUse`'s awaiting/pending guard is what
      // keeps the deliberately-unanswered `tool_use` from being read as an
      // abandoned turn and discarded.
      //
      // Conditional on `phase` as well as the lease. The phase this loop read
      // a few lines up is already stale by the time the park is written, and a
      // lease-only guard would happily overwrite a `stopped` that landed in
      // between — resurrecting a cancelled turn as a live approval request that
      // only approve/deny can ever clear.
      const parked = await AgentSessions.updateAsync(
        {
          _id: sessionId, 'lease.serverId': SERVER_ID, phase: { $ne: 'stopped' },
        },
        {
          $set: {
            phase: 'awaiting',
            pending: {
              toolCallId: call.id, name: call.name, args: call.args, requestedAt: new Date(),
              // MCP only, and only when there is a server to name. The resume
              // needs this to tell "the tool was renamed away" from "its server
              // is down" — see the field's comment in common/types.ts. Spread
              // rather than a plain `undefined` value so a non-MCP park writes
              // no key at all.
              ...(tool?.kind === 'mcp' && tool.mcp?.server
                ? { mcpServer: tool.mcp.server } : {}),
              // WHO the tool will run as, in front of the person deciding.
              // An approver being asked to authorize `billing.credit` is
              // entitled to know it will run as `service-account` and not as
              // them — that is the difference between approving a request and
              // approving an escalation.
              //
              // `!== undefined`, never truthiness: `runAs: null` is the
              // ANONYMOUS service context, a deliberate value, and a `null`
              // written here is exactly what tells a UI to render "anonymous"
              // rather than nothing at all. Absent means the tool runs as the
              // session's own user, which needs no announcement.
              ...(tool?.runAs !== undefined ? { runAs: tool.runAs } : {}),
            },
            updatedAt: new Date(),
          },
        },
      );
      // Zero matched is either an interrupt or another server redoing this
      // turn. Both mean the park never became durable, so the half-answered
      // batch must go, exactly as an interrupt caught at the check above.
      if (parked !== 1) return abandon();
      return 'parked';
    }

    const dispatched = tool
      ? await dispatchTool(tool, call.args, {
        userId: turn.userId, sessionId, toolCallId: call.id,
      }, runTurn)
      : {
        result: {
          ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` },
        } as ToolResult,
        childSessionId: undefined,
      };
    const { childSessionId } = dispatched;
    // The `afterToolResult` seam: BEFORE `toolResultContent`'s truncation and
    // before the row is written, so a hook sees the whole result and its
    // replacement is what gets truncated, stored, published and sent to the
    // model. A throwing hook leaves `dispatched.result` standing — see hooks.ts.
    const result = await runAfterToolResult(dispatched.result, call, hookCtx);

    // Same atomic allocation as the commit: `agent.send` can interject between
    // tool results, and read-then-$inc would hand both writers the same seq.
    //
    // §9: ONE tool call is what a subagent costs the parent, exactly like any
    // other tool. Whatever the child spent accrues to the CHILD's session under
    // the child agent's own config — see `runSubagent`. Nothing extra is
    // charged here, and nothing needs to be.
    const toolSeq = await allocateSeq(sessionId, { 'budgetSpent.toolCalls': 1 });
    // The assistant message is already committed but this result never will
    // be: leaving it would strand a tool_use with no tool_result.
    if (toolSeq === null) return abandon();

    const row = toolResultContent(result, limits.maxResultChars);
    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq: toolSeq, role: 'tool',
      toolCallId: call.id,
      content: row.content,
      error: row.error,
      // The handle on the child transcript. Present even for a parked or failed
      // child — that session is exactly what a human needs to open.
      childSessionId,
      createdAt: new Date(),
    });
  }

  return 'completed';
}

/**
 * Resolve a parked call whose verdict has been recorded, then finish the rest
 * of its batch.
 *
 * Resolving only the answered call would strand its siblings: the park happens
 * at the FIRST gated call, so every later call in that assistant's batch was
 * never dispatched at all. A `tool_use` with no `tool_result` is a 400 from
 * every provider, forever — so the remainder is re-dispatched here, each call
 * running or parking again on its OWN gate, and the think loop is reached only
 * when the whole batch is answered.
 */
export async function resumeParkedTurn(
  sessionId: string,
  pending: NonNullable<AgentSession['pending']>,
  tools: ResolvedTool[],
  userId: string | null,
  agent: string,
  budget: RunConfig['budget'],
  limits: DispatchLimits,
  runTurn: RunTurn,
): Promise<DispatchOutcome> {
  const msgs = await AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
  const batch = locateBatch(msgs, pending.toolCallId);
  if (!batch) {
    // The assistant is gone (a discard got here first). There is nothing left
    // to answer, so the marker is the only stale thing: drop it and let the
    // turn proceed as an ordinary one — but only if the drop actually landed.
    // Failing the guard means another server owns this session now; falling
    // through to the think loop from here would stream a whole response under
    // a lease we do not hold.
    if (!(await guardedUpdate(sessionId, SERVER_ID, { $unset: { pending: 1 } }))) {
      return 'abandoned';
    }
    return 'completed';
  }
  const { assistant, answered } = batch;
  const calls = assistant.toolCalls ?? [];
  const turn: TurnAnchor = {
    userId,
    agent,
    messageId: assistant._id,
    assistantSeq: assistant.seq,
    batchIds: calls.map((c) => c.id),
  };
  const abandon = async (): Promise<DispatchOutcome> => {
    await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
    return 'abandoned';
  };

  const call = calls.find((c) => c.id === pending.toolCallId);
  // `answered` covers the crash-between-result-and-$unset case: the row is
  // already committed, so re-running the tool would be a second real-world
  // side effect for one approval.
  if (call && !answered.has(pending.toolCallId)) {
    // Visible progress while an approved tool runs — and the interrupt check
    // for this path, which is why its RESULT decides whether the tool runs at
    // all. Zero matched means either the lease went elsewhere or `stopped`
    // landed between the verdict and this write; running the tool anyway would
    // be a real-world side effect the user just cancelled, and `dispatchCalls`
    // would then discard the assistant AND the executed call's `tool` row,
    // leaving a transcript that says "approved" with no record it ever ran.
    //
    // Leave `pending` — verdict and all — exactly where it is. A stop is
    // durable until the next `agent.send` clears it, and the verdict-carrying
    // marker is what makes that send resume this batch rather than strand it.
    const proceeding = await AgentSessions.updateAsync(
      { _id: sessionId, 'lease.serverId': SERVER_ID, phase: { $ne: 'stopped' } },
      { $set: { phase: 'calling', updatedAt: new Date() } },
    );
    // 'parked' rather than 'abandoned': nothing was erased, and something
    // outside this turn (a send clearing the stop) still owes it an answer.
    if (proceeding !== 1) return 'parked';

    const tool = tools.find((t) => t.name === call.name);
    let result: ToolResult;
    let childSessionId: string | undefined;
    // A `canUse` refusal at resume dispatched nothing, so — like a denial — it
    // must cost no tool budget. Tracked here rather than re-derived from
    // `result.error.error` (a hook may have rewritten it) below.
    let refusedByCanUse = false;
    if (pending.verdict === 'denied') {
      // A denial is ANSWERED, not dropped. The model has to see the refusal in
      // the transcript to route around it; a missing result would strand the
      // call and a silent success would be a lie.
      result = { ok: false, error: { error: 'denied', reason: pending.reason } };
    } else if (!tool) {
      // Approved, but the tool is no longer in the expanded list. Either way
      // the batch closes cleanly rather than wedging on a name that is not
      // there — but WHICH answer it closes with is a question of honesty.
      //
      // `pending.mcpServer` is the discriminator, recorded when the call
      // parked. A whole-server MCP spec contributes no tools at all while its
      // server is unreachable, so a perfectly healthy config produces exactly
      // the same "no such name" here as a rename does. Reporting `unknown-tool`
      // for it sends an operator hunting a config change that never happened,
      // and tells the model the tool does not exist when it merely cannot be
      // reached right now. `mcp-unavailable` is what the streaming path would
      // have said, so this is the two paths agreeing rather than a special
      // case.
      result = pending.mcpServer
        ? {
          ok: false,
          error: {
            error: 'mcp-unavailable',
            reason: `The MCP server "${pending.mcpServer}" is unavailable: its tool `
              + `"${call.name}" could not be resolved when the approval resumed.`,
          },
        }
        : {
          ok: false,
          error: { error: 'unknown-tool', reason: `No tool named ${call.name}` },
        };
    } else if (limits.canUse
      && !(await limits.canUse(call.name, { userId, sessionId }))) {
      // §7's backstop, re-checked at RESUME — the same `canUse` call
      // `dispatchCalls` makes before a streaming dispatch. `registry.ts`
      // documents `canUse` as "checked before dispatch AND before parking", but
      // an APPROVED park resumes straight into dispatch, so without this a
      // revoked entitlement or a kill-switch flipped while the request sat on
      // someone's screen would not stop the already-parked call. The GATE is
      // deliberately NOT re-evaluated here (a human answered it); `canUse` is a
      // different question — "may this agent use this tool AT ALL" — and the
      // answer can legitimately have changed since the park. A refusal is the
      // structured `not-allowed` result the model reads, never a dispatch.
      refusedByCanUse = true;
      result = {
        ok: false,
        error: { error: 'not-allowed', reason: `This agent may not use ${call.name}.` },
      };
    } else {
      if (!(await holdsLease(sessionId))) return abandon();
      // Same `dispatchTool` the streaming path uses, so an ask-gated SUBAGENT
      // approved by a human opens its child session here exactly as an
      // ungated one would have opened it there.
      //
      // THE GATE IS NOT RE-EVALUATED HERE, deliberately, and this is the one
      // place in the package where that is true. The gate's question is "may
      // this call happen?"; a human has just answered it, in writing, in the
      // transcript. Asking a predicate again would let it overturn an explicit
      // authorization — and a predicate that reads mutable state (a balance, a
      // shift roster, the clock) routinely gives a different answer minutes
      // later, which is exactly how long an approval sits on someone's screen.
      // The remainder of the batch is a different matter and IS re-gated: it
      // goes back through `dispatchCalls` below, where nobody has approved
      // anything.
      ({ result, childSessionId } = await dispatchTool(tool, call.args, {
        userId, sessionId, toolCallId: call.id,
      }, runTurn));
    }

    // The same `afterToolResult` seam the streaming path runs, at the same
    // point (before truncation, before the row): an approved tool's output, a
    // denial and an `mcp-unavailable` all reach the transcript through here, so
    // a redaction hook cannot be dodged by parking a call.
    result = await runAfterToolResult(result, call, {
      agent, sessionId, userId,
    });

    // A denied call — or one refused by `canUse` — was never dispatched, so it
    // costs no tool budget.
    const seq = await allocateSeq(
      sessionId,
      (pending.verdict === 'denied' || refusedByCanUse) ? {} : { 'budgetSpent.toolCalls': 1 },
    );
    if (seq === null) return abandon();

    const row = toolResultContent(result, limits.maxResultChars);
    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq, role: 'tool', toolCallId: call.id,
      content: row.content,
      error: row.error,
      childSessionId,
      createdAt: new Date(),
    });
  }

  // The verdict is spent the moment its call is answered. Clearing the marker
  // is what stops the next entry from reading this run as still parked — and
  // it must happen BEFORE the remainder re-dispatches, or a second gate's park
  // would overwrite a marker that still carried the first one's verdict.
  if (!(await guardedUpdate(sessionId, SERVER_ID, { $unset: { pending: 1 } }))) return abandon();

  const remaining = calls.filter(
    (c) => c.id !== pending.toolCallId && !answered.has(c.id),
  );
  // The approved call itself is NOT budget-checked: a human authorized that
  // specific side effect while the run was parked, and refusing it here would
  // discard the very turn they answered. The remainder goes through the
  // ordinary gate below, so a batch cannot run away past the limit — it can
  // only exceed it by the one call a person signed for.
  return dispatchCalls(sessionId, remaining, tools, turn, budget, limits, runTurn);
}
