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
import { commitBudgetNote } from './turn-state';
import { commitLeasedMessage, discardTurn, locateBatch } from './transcript';
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
  authorize?: () => boolean | Promise<boolean>,
): Promise<SubagentDispatch> {
  if (tool.kind === 'subagent') return runSubagent(tool, args, ctx, runTurn, authorize);
  return { result: await runTool(tool, args, ctx, authorize) };
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
        + `(${kind}); the row records `
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

/** A host `canUse` predicate THREW — an application failure, not a policy
 *  denial. Callers convert it into an `entitlement-unavailable` result so the
 *  transcript never claims the agent is not entitled to a tool the host
 *  never denied. The raw cause stays server-side. */
class EntitlementCheckError extends Error {
  constructor(name: string, cause: unknown) {
    super(`[10thfloor:agent] canUse(${name}) threw: ${String((cause as Error)?.message ?? cause)}`);
  }
}

/** The single fail-closed entitlement predicate — both the streaming and
 *  resume paths share it. Truthy returns are honored as allowed (the
 *  documented contract is boolean; hosts predate the strict check). */
function entitlementFor(
  limits: DispatchLimits, userId: string | null, sessionId: string,
): (name: string, args?: unknown, toolCallId?: string) => Promise<boolean> {
  return async (name, args, toolCallId) => {
    if (!limits.canUse) return true;
    try {
      return Boolean(await limits.canUse(name, { userId, sessionId, args, toolCallId }));
    } catch (error) {
      throw new EntitlementCheckError(name, error);
    }
  };
}

interface TurnAnchor {
  userId: string | null;
  /** The running agent (addressee on addressed turns) — hooks and parks
   *  follow this name, so an addressee's turn uses the addressee's chain. */
  agent: string;
  /** Stable experiential identity and the deterministic frame for this
   * trigger. Optional keeps legacy RunConfig callers source compatible. */
  agentId?: string;
  memoryFrameId?: string;
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
    ...(turn.agentId ? { agentId: turn.agentId } : {}),
    ...(turn.memoryFrameId ? { memoryFrameId: turn.memoryFrameId } : {}),
  };
  const mayUse = entitlementFor(limits, turn.userId, sessionId);

  /** Write a refusal row (canUse or predicate gate). No toolCalls budget
   *  charge — nothing was dispatched. Returns false if the turn is gone. */
  const refuse = async (
    call: { id: string; name: string; args: unknown }, refusal: ToolResult,
  ): Promise<boolean> => {
    const result = await runAfterToolResult(refusal, call, hookCtx);
    const row = toolResultContent(result, limits.maxResultChars);
    const seq = await commitLeasedMessage(sessionId, {
      _id: Random.id(), role: 'tool',
      toolCallId: call.id,
      content: row.content,
      error: row.error,
      ...(turn.from ? { from: turn.from } : {}),
      createdAt: new Date(),
    });
    return seq !== null;
  };

  for (const call of calls) {
    // §7 backstop: a config-forbidden tool must not park (nothing may grant it).
    let entitled: boolean;
    try {
      entitled = await mayUse(call.name, call.args, call.id);
    } catch (error) {
      // Application failure, not a denial: answer the tool_use truthfully so
      // the model may retry, charge nothing, and keep the raw cause out of
      // the published transcript.
      console.error(String((error as Error)?.message ?? error));
      if (!(await refuse(call, {
        ok: false,
        error: {
          error: 'entitlement-unavailable',
          reason: 'The application entitlement check failed — not a policy '
            + 'denial. The tool may be retried.',
        },
      }))) return abandon();
      continue;
    }
    if (!entitled) {
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
      // `describe` is application code and may await while host entitlements
      // change. Do not park a request that is no longer authorizable — and a
      // THROWN check here is an application failure, answered truthfully.
      let stillEntitled: boolean;
      try {
        stillEntitled = await mayUse(call.name, call.args, call.id);
      } catch (error) {
        console.error(String((error as Error)?.message ?? error));
        if (!(await refuse(call, {
          ok: false,
          error: {
            error: 'entitlement-unavailable',
            reason: 'The application entitlement check failed — not a policy '
              + 'denial. The tool may be retried.',
          },
        }))) return abandon();
        continue;
      }
      if (!stillEntitled) {
        if (!(await refuse(call, {
          ok: false,
          error: { error: 'not-allowed', reason: `This agent may not use ${call.name}.` },
        }))) return abandon();
        continue;
      }
      const requestedAt = new Date();
      // Park by exiting — the durable state is the marker + phase:'awaiting'.
      // Guarded on phase too: a lease-only guard would overwrite a `stopped`
      // that landed between the read and this write.
      const parked = await AgentSessions.updateAsync(
        {
          _id: sessionId,
          'lease.serverId': SERVER_ID,
          'lease.until': { $gt: new Date() },
          erasingAt: { $exists: false },
          purgingAt: { $exists: false },
          phase: { $ne: 'stopped' },
        },
        {
          $set: {
            phase: 'awaiting',
            pending: {
              toolCallId: call.id, name: call.name, args: call.args, requestedAt,
              // Which agent parked — resume rebuilds config from this.
              agent: turn.agent,
              // The causal anchor. Without it, a user row landing while
              // parked would move the re-derived trigger and the approved
              // call would resume under a fresh Frame — bypassing the
              // fail-closed evidence check and mislabeling provenance.
              ...(turn.agentId !== undefined && turn.memoryFrameId !== undefined
                ? { agentId: turn.agentId, memoryFrameId: turn.memoryFrameId } : {}),
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

      // A host lifecycle fence can land after the pre-park check but before
      // the pending marker commits. Re-read entitlement after that atomic
      // write. On revocation, reclaim only this exact ask under our live lease,
      // clear it, and answer with a no-budget refusal. If cleanup or another
      // owner changed it first, ordinary abandon repair is the safe path.
      let postParkEntitled: boolean;
      try {
        postParkEntitled = await mayUse(call.name, call.args, call.id);
      } catch (error) {
        // The park is already durable and the resume path re-checks
        // entitlement anyway — a failed CHECK must not tear the park down.
        console.error(String((error as Error)?.message ?? error));
        return 'parked';
      }
      if (!postParkEntitled) {
        const reclaimed = await AgentSessions.updateAsync(
          {
            _id: sessionId,
            'lease.serverId': SERVER_ID,
            'lease.until': { $gt: new Date() },
            phase: 'awaiting',
            'pending.toolCallId': call.id,
            'pending.name': call.name,
            'pending.agent': turn.agent,
            'pending.requestedAt': requestedAt,
            erasingAt: { $exists: false },
            purgingAt: { $exists: false },
          },
          {
            $set: { phase: 'calling', updatedAt: new Date() },
            $unset: { pending: 1 },
          },
        );
        if (reclaimed !== 1) return abandon();
        if (!(await refuse(call, {
          ok: false,
          error: { error: 'not-allowed', reason: `This agent may not use ${call.name}.` },
        }))) return abandon();
        continue;
      }
      return 'parked';
    }

    // Gate/canUse/describe are application callbacks and may await arbitrary
    // work. Re-prove ownership at the last boundary before a real tool side
    // effect; a preflight performed only at the top of the loop can go stale.
    if (!(await holdsLease(sessionId))) return abandon();

    // Collect attachment refs the tool stamps onto its result.
    const resultRefs: import('../common/types').AttachmentRef[] = [];
    let refusedByCanUse = false;
    let checkUnavailable = false;
    const authorize = async (): Promise<boolean> => {
      let allowed: boolean;
      try {
        allowed = await mayUse(call.name, call.args, call.id);
      } catch (error) {
        // At the side-effect boundary a check failure fails CLOSED — better
        // to refuse a tool than run one unauthorized. The runner reports the
        // false as a policy denial; the flag rewrites that row truthfully.
        console.error(String((error as Error)?.message ?? error));
        refusedByCanUse = true;
        checkUnavailable = true;
        return false;
      }
      if (!allowed) refusedByCanUse = true;
      if (!allowed) return false;
      // Argument validation and MCP/subagent setup may await. Re-prove the
      // exact worker lease at the final implementation boundary as well.
      return holdsLease(sessionId);
    };
    const dispatched = tool
      ? await dispatchTool(tool, call.args, {
        userId: turn.userId, sessionId, toolCallId: call.id,
        assistantMessageId: turn.messageId, agent: turn.agent,
        ...(turn.agentId ? { agentId: turn.agentId } : {}),
        ...(turn.memoryFrameId ? { memoryFrameId: turn.memoryFrameId } : {}),
        ...(limits.imageInput !== undefined ? { imageInput: limits.imageInput } : {}),
        attachToResult: (ref) => { resultRefs.push(ref); },
      }, runTurn, authorize)
      : {
        result: {
          ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` },
        } as ToolResult,
        childSessionId: undefined,
      };
    if (checkUnavailable && dispatched.result.ok === false
      && (dispatched.result.error as { error?: string } | undefined)?.error === 'not-allowed') {
      // The host never denied this tool — its check failed. The durable row
      // must not steer the model away from a tool it is entitled to.
      dispatched.result = {
        ok: false,
        error: {
          error: 'entitlement-unavailable',
          reason: 'The application entitlement check failed — not a policy '
            + 'denial. The tool may be retried.',
        },
      };
    }
    const { childSessionId } = dispatched;
    // `afterToolResult` runs before truncation/storage — hooks see the full
    // result and can replace it or drop attachments.
    const result = await runAfterToolResult(dispatched.result, call, {
      ...hookCtx,
      ...(resultRefs.length > 0 ? { resultAttachments: resultRefs } : {}),
    });

    // Atomic seq + budget $inc — a subagent costs one toolCall to the parent.
    const row = toolResultContent(result, limits.maxResultChars);
    const toolSeq = await commitLeasedMessage(sessionId, {
      _id: Random.id(), role: 'tool',
      toolCallId: call.id,
      content: row.content,
      error: row.error,
      // Present even for a failed child — the transcript is what a human opens.
      childSessionId,
      ...(turn.from ? { from: turn.from } : {}),
      // Attachments that survived the hook chain.
      ...(resultRefs.length > 0 ? { attachments: resultRefs } : {}),
      createdAt: new Date(),
    }, { inc: refusedByCanUse ? {} : { 'budgetSpent.toolCalls': 1 } });
    // Null seq = turn gone; abandon to avoid stranding a tool_use.
    if (toolSeq === null) return abandon();
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
  // Stable learning context adopted from the trigger's Memory Frame.
  learning?: { agentId: string; memoryFrameId: string },
): Promise<DispatchOutcome> {
  const mayUse = entitlementFor(limits, userId, sessionId);
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
    ...(learning ?? {}),
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
    } else {
      // §7 backstop re-checked at resume — entitlements may have changed while
      // parked. The GATE is not re-evaluated (a human answered it); `canUse`
      // is a separate "may this agent use this tool at all" question. A THROWN
      // check is an application failure, answered truthfully, never as denial.
      let entitled: boolean | 'unavailable';
      try {
        entitled = await mayUse(call.name, call.args, call.id);
      } catch (error) {
        console.error(String((error as Error)?.message ?? error));
        entitled = 'unavailable';
      }
      if (entitled === 'unavailable') {
        refusedByCanUse = true; // nothing dispatched — no budget charge
        result = {
          ok: false,
          error: {
            error: 'entitlement-unavailable',
            reason: 'The application entitlement check failed — not a policy '
              + 'denial. The tool may be retried.',
          },
        };
      } else if (!entitled) {
        refusedByCanUse = true;
        result = {
          ok: false,
          error: { error: 'not-allowed', reason: `This agent may not use ${call.name}.` },
        };
      } else {
      if (!(await holdsLease(sessionId))) return abandon();
      let checkUnavailable = false;
      const authorize = async (): Promise<boolean> => {
        let allowed: boolean;
        try {
          allowed = await mayUse(call.name, call.args, call.id);
        } catch (error) {
          // Side-effect boundary: fail closed rather than run unauthorized;
          // the flag rewrites the runner's denial row truthfully below.
          console.error(String((error as Error)?.message ?? error));
          refusedByCanUse = true;
          checkUnavailable = true;
          return false;
        }
        if (!allowed) refusedByCanUse = true;
        if (!allowed) return false;
        return holdsLease(sessionId);
      };
      // Gate deliberately NOT re-evaluated — a human already answered it.
      // The batch remainder IS re-gated via `dispatchCalls` below.
      ({ result, childSessionId } = await dispatchTool(tool, call.args, {
        userId, sessionId, toolCallId: call.id,
        assistantMessageId: turn.messageId, agent,
        ...(learning ?? {}),
        ...(limits.imageInput !== undefined ? { imageInput: limits.imageInput } : {}),
        attachToResult: (ref) => { resultRefs.push(ref); },
      }, runTurn, authorize));
      if (checkUnavailable && result.ok === false
        && (result.error as { error?: string } | undefined)?.error === 'not-allowed') {
        result = {
          ok: false,
          error: {
            error: 'entitlement-unavailable',
            reason: 'The application entitlement check failed — not a policy '
              + 'denial. The tool may be retried.',
          },
        };
      }
      }
    }

    // Same `afterToolResult` seam as the streaming path (before truncation).
    result = await runAfterToolResult(result, call, {
      agent, sessionId, userId,
      ...(learning ?? {}),
      ...(resultRefs.length > 0 ? { resultAttachments: resultRefs } : {}),
    });

    // Denied/refused calls cost no tool budget — nothing was dispatched.
    const row = toolResultContent(result, limits.maxResultChars);
    const seq = await commitLeasedMessage(sessionId, {
      _id: Random.id(), role: 'tool', toolCallId: call.id,
      content: row.content,
      error: row.error,
      childSessionId,
      ...(from ? { from } : {}),
      ...(resultRefs.length > 0 ? { attachments: resultRefs } : {}),
      createdAt: new Date(),
    }, {
      inc: (pending.verdict === 'denied' || refusedByCanUse)
        ? {} : { 'budgetSpent.toolCalls': 1 },
    });
    if (seq === null) return abandon();
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
