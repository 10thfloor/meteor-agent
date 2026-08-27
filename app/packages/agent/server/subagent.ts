import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import { ACTIVE_PHASES, type AgentSession } from '../common/types';
import { modelFrom } from '../common/participants';
import { buildRunConfig, getAgent } from './registry';
import { guardedUpdate, SERVER_ID } from './lease';
import { validateToolArgs, type ResolvedTool, type ToolContext, type ToolResult } from './tools';
// Type-only: runTurn is passed in by the loop to avoid a cyclic import.
import type { RunConfig } from './loop';
import {
  beginSessionMutationOperation, withSessionOperationTransaction,
} from './session-operations';
import { insertInitialTranscript } from './transcript';

/** Fork-bomb bound: each nesting level multiplies model calls. */
export const MAX_SUBAGENT_DEPTH = 3;

/** Outcome of a finished turn, shared by Agent.ask and subagent dispatch. */
export type TurnOutcome =
  | { ok: true; text: string }
  /** The session document is gone. */
  | { ok: false; kind: 'gone' }
  /** Parked at a `gate: 'ask'` tool. `toolName` is what is waiting. */
  | { ok: false; kind: 'parked'; toolName: string }
  /** Terminal failure. `reason` comes from the transcript note (sanitized). */
  | { ok: false; kind: 'failed'; reason: string };

export async function readTurnOutcome(sessionId: string): Promise<TurnOutcome> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return { ok: false, kind: 'gone' };

  if (session.phase === 'awaiting') {
    return { ok: false, kind: 'parked', toolName: session.pending?.name ?? 'a tool' };
  }
  if (session.phase === 'error' || session.phase === 'stopped') {
    // Last budget or error note carries the displayable reason.
    const note = await AgentMessages.findOneAsync(
      { sessionId, role: 'note', kind: { $in: ['budget', 'error'] } },
      { sort: { seq: -1 } },
    );
    return {
      ok: false,
      kind: 'failed',
      // `stopped` with no note means an interrupt — say so explicitly rather
      // than the generic "did not complete", since interrupts are everyday.
      reason: note?.error?.reason
        ?? (session.phase === 'stopped'
          ? 'The turn was interrupted.'
          : 'The turn did not complete.'),
    };
  }

  // Only the LAST assistant row counts — earlier chatter is not the answer.
  const reply = await AgentMessages.findOneAsync(
    { sessionId, role: 'assistant' },
    { sort: { seq: -1 } },
  );
  if (!reply?.content) return { ok: false, kind: 'failed', reason: 'The turn produced no reply.' };
  return { ok: true, text: reply.content };
}

/** Extract `args.prompt` as a string, or JSON-serialize the whole args object. */
export function subagentPrompt(args: unknown): string {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const prompt = (args as Record<string, unknown>).prompt;
    if (typeof prompt === 'string') return prompt;
  }
  return JSON.stringify(args ?? null) ?? 'null';
}

/** Tool result plus optional child session id for the tool row. */
export interface SubagentDispatch {
  result: ToolResult;
  childSessionId?: string;
}

type RunTurn = (sessionId: string, config: RunConfig) => Promise<void>;

const failure = (error: string, reason: string): ToolResult =>
  ({ ok: false, error: { error, reason } });

/** Map a child's TurnOutcome to the parent's tool result. Shared by fresh
 *  dispatch and the idempotent reuse path so both report identically. */
function dispatchFromOutcome(
  outcome: TurnOutcome, name: string, childSessionId: string,
): SubagentDispatch {
  if (outcome.ok) return { result: { ok: true, value: outcome.text }, childSessionId };
  if (outcome.kind === 'parked') {
    return {
      result: failure(
        'subagent-parked',
        `The subagent "${name}" is waiting for approval of "${outcome.toolName}". Its `
        + 'session is still open and a human can answer it there; this call cannot wait.',
      ),
      childSessionId,
    };
  }
  if (outcome.kind === 'gone') {
    return {
      result: failure('subagent-failed', `The subagent "${name}" left no session behind.`),
      childSessionId,
    };
  }
  return {
    result: failure('subagent-failed', `The subagent "${name}" did not answer: ${outcome.reason}`),
    childSessionId,
  };
}

/** Find an unclaimed child from a prior abandoned dispatch of the same
 *  logical call. Misses gracefully — a fresh child is created instead. */
async function findReusableChild(
  parentSessionId: string, toolCallId: string, agent: string, prompt: string,
): Promise<AgentSession | null> {
  const candidates = await AgentSessions.find(
    {
      'parent.sessionId': parentSessionId,
      'parent.toolCallId': toolCallId,
      agent,
    },
    // Newest first so a fresh child beats an orphaned one.
    { sort: { createdAt: -1 } },
  ).fetchAsync();

  for (const child of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const claimed = await AgentMessages.findOneAsync(
      { sessionId: parentSessionId, role: 'tool', childSessionId: child._id },
    );
    if (claimed) continue;
    // Prompt must match; a crash-orphaned child with no first message is skipped.
    // eslint-disable-next-line no-await-in-loop
    const first = await AgentMessages.findOneAsync(
      { sessionId: child._id, seq: 0 },
    );
    if (first?.content !== prompt) continue;
    return child;
  }
  return null;
}

/** Reusable child's outcome if terminal/parked; null if still active. */
async function reuseChild(child: AgentSession, name: string): Promise<SubagentDispatch | null> {
  if (ACTIVE_PHASES.includes(child.phase)) return null;
  return dispatchFromOutcome(await readTurnOutcome(child._id), name, child._id);
}

/** Run a named agent as a child session. Persists (unlike ask) so it can
 *  stream and accept approvals independently. */
export async function runSubagent(
  tool: ResolvedTool, args: unknown, ctx: ToolContext, runTurn: RunTurn,
): Promise<SubagentDispatch> {
  const name = tool.subagent!;

  // Validate like inline tools — subagents bypass runTool.
  const verdict = await validateToolArgs(tool.args, args);
  if (!verdict.ok) {
    return { result: failure('invalid-args', verdict.reason) };
  }

  const parent = await AgentSessions.findOneAsync({
    _id: ctx.sessionId, erasingAt: { $exists: false },
  });
  if (!parent) return { result: failure('subagent-failed', 'The calling session is gone.') };

  // Check depth before any write to bound runaway chains.
  const depth = (parent.depth ?? 0) + 1;
  if (depth > MAX_SUBAGENT_DEPTH) {
    return {
      result: failure(
        'subagent-depth',
        `Subagents may nest ${MAX_SUBAGENT_DEPTH} deep; calling "${name}" here would be `
        + `level ${depth}. Do this work yourself, or answer without it.`,
      ),
    };
  }

  // Unknown agent is a structured result, not a thrown turn.
  const config = getAgent(name);
  if (!config) {
    return { result: failure('unknown-agent', `No agent named "${name}" is registered.`) };
  }

  // Read off the parent doc so child authorization matches the parent's.
  const userId = parent.userId ?? null;
  const prompt = subagentPrompt(args);

  // Idempotency: reuse a child from a prior abandoned dispatch if available.
  if (ctx.toolCallId) {
    const existing = await findReusableChild(ctx.sessionId, ctx.toolCallId, name, prompt);
    if (existing) {
      const reused = await reuseChild(existing, name);
      if (reused) return reused;
    }
  }

  const childSessionId = Random.id();
  const childMessageId = Random.id();
  const now = new Date();
  const child: AgentSession = {
    _id: childSessionId,
    agent: name,
    userId,
    phase: 'idle',
    model: config.model,
    nextSeq: 0,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    // Fallback '' keeps the field a string for direct callers with no call id.
    parent: { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId ?? '' },
    depth,
    // Copy human participants from parent; seed the child's own model only.
    ...(parent.participants?.length ? {
      participants: [
        ...parent.participants.filter((p) => p.kind === 'human'),
        {
          id: `m:${name}`, kind: 'model' as const, role: 'member' as const,
          agent: name, displayName: name, joinedAt: now,
        },
      ],
    } : {}),
    createdAt: now,
    updatedAt: now,
  };

  const parentOperation = await beginSessionMutationOperation(ctx.sessionId);
  if (!parentOperation) {
    return { result: failure('subagent-failed', 'The calling session is no longer writable.') };
  }
  let born = false;
  try {
    born = await withSessionOperationTransaction(parentOperation, async (mongoSession) => {
      // Parent Lease, active-child marker, child Session, and first Message are
      // one birth transaction. A crash cannot strand an unowned child or an
      // activeChild pointer to a transcript that never materialized.
      const activated = await AgentSessions.rawCollection().updateOne(
        {
          _id: ctx.sessionId,
          'lease.serverId': SERVER_ID,
          erasingAt: { $exists: false },
          purgingAt: { $exists: false },
        },
        {
          $set: {
            activeChild: { sessionId: childSessionId, toolCallId: ctx.toolCallId ?? '' },
            updatedAt: now,
          },
        },
        { session: mongoSession },
      );
      if (activated.matchedCount !== 1) return false;
      await insertInitialTranscript(mongoSession, child, {
        _id: childMessageId,
        role: 'user',
        content: prompt,
        // Attribute to the parent model, not the owner — it's a delegation.
        ...(parent.participants?.length ? { from: modelFrom(parent.agent) } : {}),
        createdAt: now,
      });
      return true;
    });
  } catch {
    // A transaction may commit even if its final acknowledgement is lost.
    // Adopt only the exact atomic birth; otherwise report a generic failure.
    const [standingChild, standingMessage, standingParent] = await Promise.all([
      AgentSessions.findOneAsync(childSessionId),
      AgentMessages.findOneAsync({ sessionId: childSessionId, seq: 0 }),
      AgentSessions.findOneAsync(ctx.sessionId),
    ]);
    born = standingChild?.parent?.sessionId === ctx.sessionId
      && standingChild.parent.toolCallId === (ctx.toolCallId ?? '')
      && standingMessage?.content === prompt
      && standingParent?.activeChild?.sessionId === childSessionId;
    if (!born) {
      console.error(`[10thfloor:agent] subagent "${name}" could not be created`);
    }
  } finally {
    await parentOperation.close();
  }
  if (!born) {
    return { result: failure('subagent-failed', 'The calling session is no longer writable.') };
  }

  try { // outer: the finally at the end clears activeChild on every exit
  try {
    await runTurn(childSessionId, buildRunConfig(config, userId));
  } catch {
    // Harness failure — never expose the raw message in the transcript.
    console.error(`[10thfloor:agent] subagent "${name}" failed`);
    return {
      result: failure('subagent-failed', `The subagent "${name}" could not run.`),
      childSessionId,
    };
  }

  return dispatchFromOutcome(await readTurnOutcome(childSessionId), name, childSessionId);
  } finally {
    // Clear live-child marker so it doesn't shadow the next call's.
    await guardedUpdate(ctx.sessionId, SERVER_ID, { $unset: { activeChild: 1 } });
  }
}
