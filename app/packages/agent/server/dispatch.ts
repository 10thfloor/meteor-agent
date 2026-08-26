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

/** Tool-call dispatch. `runTurn` is injected (not imported) to break the
 *  dispatch -> loop value cycle — same DI pattern as `runSubagent`. */

/** Injected `runTurn` — avoids a dispatch -> loop value import. */
export type RunTurn = (sessionId: string, config: RunConfig) => Promise<void>;

/** Limits threaded through every dispatch path as one bundle. */
export interface DispatchLimits {
  maxResultChars: number;
  canUse?: RunConfig['canUse'];
  /** Vision capability for this turn (absent = false = gate fails closed). */
  imageInput?: boolean;
}

/** Run a resolved tool: subagents go to `runSubagent` (nested turn),
 *  everything else to `runTool`. Returns child session id for subagents. */
async function dispatchTool(
  tool: ResolvedTool, args: unknown, ctx: ToolContext, runTurn: RunTurn,
): Promise<SubagentDispatch> {
  if (tool.kind === 'subagent') return runSubagent(tool, args, ctx, runTurn);
  return { result: await runTool(tool, args, ctx) };
}

/** Latch: warn once per distinct serialization failure kind. */
const warnedSerialization = new Set<string>();

/** Structured error for unserializable tool results. */
const UNSERIALIZABLE = {
  error: 'unserializable-result',
  reason: 'The tool result could not be serialized.',
} as const;

/** Serialize + truncate a tool result for the transcript row. Guards against
 *  `JSON.stringify` throwing (circular, BigInt) so the turn completes. */
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

/** Clamp `error.reason` to `maxChars` — it's a separate field from `content`,
 *  so the content truncation doesn't bound it. */
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

/** parked = awaiting external answer, abandoned = turn gone,
 *  completed = all calls answered (safe to re-enter think loop). */
export type DispatchOutcome = 'completed' | 'parked' | 'abandoned';

interface TurnAnchor {
  userId: string | null;
  /** The running agent (addressee on addressed turns) — hooks and parks
   *  follow this name, so an addressee's turn uses the addressee's chain. */
  agent: string;
  /** The committed assistant carrying the `tool_use`s — the discard anchor. */
  messageId: string;
  assistantSeq: number;
  /** ALL call ids in the batch — discard needs the whole set. */
  batchIds: string[];
  /** Attribution stamp; present when the session has a roster. */
  from?: { participant: string; name: string };
}

/** Dispatch calls sequentially, gating each independently. The sole gate
 *  evaluation site — both streaming and resume paths share it. */
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

  /** Write a refusal row (canUse or predicate gate). No toolCalls budget
   *  charge — nothing was dispatched. Returns false if the turn is gone. */
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
      ...(turn.from ? { from: turn.from } : {}),
      createdAt: new Date(),
    });
    return true;
  };

  for (const call of calls) {
    // §7 backstop: a config-forbidden tool must not park (nothing may grant it).
    if (limits.canUse
      && !(await limits.canUse(call.name, { userId: turn.userId, sessionId }))) {
      if (!(await refuse(call, {
        ok: false,
        error: { error: 'not-allowed', reason: `This agent may not use ${call.name}.` },
      }))) return abandon();
      continue;
    }
    // Lease check BEFORE dispatch — running an adopted tool after losing
    // ownership risks the recovering server executing it a second time.
    if (!(await holdsLease(sessionId))) return abandon();

    // An interrupt (stopped) means discard — partial results would strand
    // unanswered tool_use calls.
    const phaseCheck = await AgentSessions.findOneAsync(sessionId);
    if (!phaseCheck || phaseCheck.phase === 'stopped') return abandon();

    // §9: budget check BEFORE the gate — don't ask a human to approve work
    // the session can't afford. Only dispatched calls count (parks/denials
    // spend nothing). On exceed, discard first, note second.
    if (budget?.toolCalls !== undefined
      && (phaseCheck.budgetSpent?.toolCalls ?? 0) >= budget.toolCalls) {
      await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
      await commitBudgetNote(sessionId, 'toolCalls');
      return 'abandoned';
    }

    const tool = tools.find((t) => t.name === call.name);

    // The sole gate evaluation site. Uses `turn.userId` (session owner), never
    // a `runAs` escalation — the escalation must not approve itself.
    // A throwing predicate lands as 'denied', not an exception.
    const decision = await evaluateGate(tool, {
      userId: turn.userId, sessionId, name: call.name, args: call.args,
    });

    if (decision === 'denied') {
      // A result, not a park — the model routes around it, batch continues.
      if (!(await refuse(call, gateDeniedResult(call.name)))) return abandon();
      continue;
    }

    if (decision === 'ask') {
      // Resolve a human-readable description BEFORE parking so the approver
      // sees names/sizes, not ref ids. Failure = no display, never a failed park.
      let display: string | undefined;
      if (typeof tool?.describe === 'function') {
        try {
          const d = await tool.describe(call.args, { userId: turn.userId, sessionId });
          if (typeof d === 'string' && d.trim() !== '') {
            display = d.length > 2000 ? `${d.slice(0, 2000)}…` : d;
          }
        } catch { /* no display beats no park */ }
      }
      // Park by exiting — the durable state is the marker + phase:'awaiting'.
      // Guarded on phase too: a lease-only guard would overwrite a `stopped`
      // that landed between the read and this write.
      const parked = await AgentSessions.updateAsync(
        {
          _id: sessionId, 'lease.serverId': SERVER_ID, phase: { $ne: 'stopped' },
        },
        {
          $set: {
            phase: 'awaiting',
            pending: {
              toolCallId: call.id, name: call.name, args: call.args, requestedAt: new Date(),
              // Which agent parked — resume rebuilds config from this.
              agent: turn.agent,
              ...(display !== undefined ? { display } : {}),
              // Resume uses this to distinguish "renamed away" from "server down".
              ...(tool?.kind === 'mcp' && tool.mcp?.server
                ? { mcpServer: tool.mcp.server } : {}),
              // Show the approver who the tool runs as. `null` = anonymous
              // service context (deliberate value); absent = session's own user.
              ...(tool?.runAs !== undefined ? { runAs: tool.runAs } : {}),
            },
            updatedAt: new Date(),
          },
        },
      );
      // Zero matched = interrupt or lost lease; park never became durable.
      if (parked !== 1) return abandon();
      return 'parked';
    }

    // Collect attachment refs the tool stamps onto its result.
    const resultRefs: import('../common/types').AttachmentRef[] = [];
    const dispatched = tool
      ? await dispatchTool(tool, call.args, {
        userId: turn.userId, sessionId, toolCallId: call.id, agent: turn.agent,
        ...(limits.imageInput !== undefined ? { imageInput: limits.imageInput } : {}),
        attachToResult: (ref) => { resultRefs.push(ref); },
      }, runTurn)
      : {
        result: {
          ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` },
        } as ToolResult,
        childSessionId: undefined,
      };
    const { childSessionId } = dispatched;
    // `afterToolResult` runs before truncation/storage — hooks see the full
    // result and can replace it or drop attachments.
    const result = await runAfterToolResult(dispatched.result, call, {
      ...hookCtx,
      ...(resultRefs.length > 0 ? { resultAttachments: resultRefs } : {}),
    });

    // Atomic seq + budget $inc — a subagent costs one toolCall to the parent.
    const toolSeq = await allocateSeq(sessionId, { 'budgetSpent.toolCalls': 1 });
    // Null seq = turn gone; abandon to avoid stranding a tool_use.
    if (toolSeq === null) return abandon();

    const row = toolResultContent(result, limits.maxResultChars);
    await AgentMessages.insertAsync({
      _id: Random.id(), sessionId, seq: toolSeq, role: 'tool',
      toolCallId: call.id,
      content: row.content,
      error: row.error,
      // Present even for a failed child — the transcript is what a human opens.
      childSessionId,
      ...(turn.from ? { from: turn.from } : {}),
      // Attachments that survived the hook chain.
      ...(resultRefs.length > 0 ? { attachments: resultRefs } : {}),
      createdAt: new Date(),
    });
  }

  return 'completed';
}

/** Resolve a parked call's verdict, then re-dispatch the batch remainder
 *  (each remaining call re-gated independently). */
export async function resumeParkedTurn(
  sessionId: string,
  pending: NonNullable<AgentSession['pending']>,
  tools: ResolvedTool[],
  userId: string | null,
  agent: string,
  budget: RunConfig['budget'],
  limits: DispatchLimits,
  runTurn: RunTurn,
  /** Attribution stamp for the resuming (= parking) agent. */
  from?: { participant: string; name: string },
): Promise<DispatchOutcome> {
  const msgs = await AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();
  const batch = locateBatch(msgs, pending.toolCallId);
  if (!batch) {
    // Assistant already discarded — clear the stale marker, but only if we
    // still hold the lease (failing the guard = another server owns it).
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
    ...(from ? { from } : {}),
  };
  const abandon = async (): Promise<DispatchOutcome> => {
    await discardTurn(sessionId, turn.messageId, turn.assistantSeq, turn.batchIds);
    return 'abandoned';
  };

  const call = calls.find((c) => c.id === pending.toolCallId);
  // `answered` guards against re-running after a crash between result and $unset.
  if (call && !answered.has(pending.toolCallId)) {
    // Phase write doubles as the interrupt check. Zero matched = stopped or
    // lost lease; leave `pending` in place so a future send can resume.
    const proceeding = await AgentSessions.updateAsync(
      { _id: sessionId, 'lease.serverId': SERVER_ID, phase: { $ne: 'stopped' } },
      { $set: { phase: 'calling', updatedAt: new Date() } },
    );
    // 'parked': nothing erased, still awaiting external resume.
    if (proceeding !== 1) return 'parked';

    const tool = tools.find((t) => t.name === call.name);
    let result: ToolResult;
    let childSessionId: string | undefined;
    // Per-call attachment collector, same as the streaming path.
    const resultRefs: import('../common/types').AttachmentRef[] = [];
    // Track canUse refusals separately — hooks may rewrite the error.
    let refusedByCanUse = false;
    if (pending.verdict === 'denied') {
      // Denial is a result — the model needs it in the transcript.
      result = { ok: false, error: { error: 'denied', reason: pending.reason } };
    } else if (!tool) {
      // Approved, but the tool vanished. `mcpServer` distinguishes "server
      // unreachable" (mcp-unavailable) from "tool renamed away" (unknown-tool).
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
      // §7 backstop re-checked at resume — entitlements may have changed while
      // parked. The GATE is not re-evaluated (a human answered it); `canUse`
      // is a separate "may this agent use this tool at all" question.
      refusedByCanUse = true;
      result = {
        ok: false,
        error: { error: 'not-allowed', reason: `This agent may not use ${call.name}.` },
      };
    } else {
      if (!(await holdsLease(sessionId))) return abandon();
      // Gate deliberately NOT re-evaluated — a human already answered it.
      // The batch remainder IS re-gated via `dispatchCalls` below.
      ({ result, childSessionId } = await dispatchTool(tool, call.args, {
        userId, sessionId, toolCallId: call.id, agent,
        ...(limits.imageInput !== undefined ? { imageInput: limits.imageInput } : {}),
        attachToResult: (ref) => { resultRefs.push(ref); },
      }, runTurn));
    }

    // Same `afterToolResult` seam as the streaming path (before truncation).
    result = await runAfterToolResult(result, call, {
      agent, sessionId, userId,
      ...(resultRefs.length > 0 ? { resultAttachments: resultRefs } : {}),
    });

    // Denied/refused calls cost no tool budget — nothing was dispatched.
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
      ...(from ? { from } : {}),
      ...(resultRefs.length > 0 ? { attachments: resultRefs } : {}),
      createdAt: new Date(),
    });
  }

  // Clear pending BEFORE re-dispatching the remainder — a second park would
  // otherwise overwrite the still-present first verdict.
  if (!(await guardedUpdate(sessionId, SERVER_ID, { $unset: { pending: 1 } }))) return abandon();

  const remaining = calls.filter(
    (c) => c.id !== pending.toolCallId && !answered.has(c.id),
  );
  // The approved call skips budget check (a human authorized it); the
  // remainder re-gates normally, so overrun is at most one call.
  return dispatchCalls(sessionId, remaining, tools, turn, budget, limits, runTurn);
}
