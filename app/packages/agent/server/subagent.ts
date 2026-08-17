import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import { buildRunConfig, getAgent } from './registry';
import { validateToolArgs, type ResolvedTool, type ToolContext, type ToolResult } from './tools';
// TYPE-only, so no runtime edge is created: `runTurn` is passed IN by the loop
// (see `runSubagent`), which is what keeps loop -> subagent a one-way import.
import type { RunConfig } from './loop';

/**
 * How deep agents may compose agents. A root session is depth 0, its subagent
 * 1, and so on; a call that would create a child past this is refused with a
 * structured `subagent-depth` result and NO child session.
 *
 * Three is not a magic number so much as a fork-bomb bound: an agent that lists
 * itself as its own subagent (or two that list each other) recurses until
 * something stops it, and "something" would otherwise be the process. Each
 * level multiplies the model calls of the one above it.
 */
export const MAX_SUBAGENT_DEPTH = 3;

/**
 * What a finished turn LEFT BEHIND, read off the session and its transcript.
 *
 * `runTurn` never throws for a turn that merely ended badly — it records the
 * outcome in the session's terminal phase and a structured note — so the phase,
 * not a rejection, is what this reads. Shared by `Agent.ask` (which maps it to
 * `ask-parked`/`ask-failed` rejections) and by subagent dispatch (which maps it
 * to `subagent-parked`/`subagent-failed` tool results). One reader, so the two
 * headless callers can never disagree about what "the turn produced an answer"
 * means.
 *
 * The variants carry facts, not sentences: each caller composes its own
 * message, because "a headless caller cannot approve this" and "the child is
 * still parked and a human can still answer it" are opposite advice about the
 * same state.
 */
export type TurnOutcome =
  | { ok: true; text: string }
  /** The session document is gone. */
  | { ok: false; kind: 'gone' }
  /** Parked at a `gate: 'ask'` tool. `toolName` is what is waiting. */
  | { ok: false; kind: 'parked'; toolName: string }
  /** Terminal: a provider failure, a budget stop, or no assistant reply at all.
   *  `reason` is already sanitized — it comes from the transcript note, which
   *  never carries a raw provider message. */
  | { ok: false; kind: 'failed'; reason: string };

export async function readTurnOutcome(sessionId: string): Promise<TurnOutcome> {
  const session = await AgentSessions.findOneAsync(sessionId);
  if (!session) return { ok: false, kind: 'gone' };

  if (session.phase === 'awaiting') {
    return { ok: false, kind: 'parked', toolName: session.pending?.name ?? 'a tool' };
  }
  if (session.phase === 'error' || session.phase === 'stopped') {
    // The note carries the reason the transcript would have shown a user.
    // `kind: 'budget'` for a stop, `kind: 'error'` for a provider failure —
    // read the last note either way.
    const note = await AgentMessages.findOneAsync(
      { sessionId, role: 'note', kind: { $in: ['budget', 'error'] } } as any,
      { sort: { seq: -1 } },
    );
    return {
      ok: false,
      kind: 'failed',
      reason: (note as any)?.error?.reason ?? 'The turn did not complete.',
    };
  }

  // The LAST assistant row, not the last one that happens to carry text: an
  // earlier iteration's chatter is not the answer to the question, and a turn
  // that ended without producing one (`maxIterations` exhausted mid-batch, or a
  // model that emitted only tool calls) has no answer to give. Returning ''
  // would look like one.
  const reply = await AgentMessages.findOneAsync(
    { sessionId, role: 'assistant' } as any,
    { sort: { seq: -1 } },
  );
  if (!reply?.content) return { ok: false, kind: 'failed', reason: 'The turn produced no reply.' };
  return { ok: true, text: reply.content };
}

/**
 * The child's first user message.
 *
 * With the default schema that is `args.prompt`, full stop. A tool that
 * declares its OWN `args` schema gets the whole argument object serialized as
 * JSON instead — the child is an agent reading prose, and handing it
 * `{"topic":"x","depth":2}` is at least honest about what the parent sent.
 * Declare a `prompt: { type: 'string' }` property in a custom schema to keep
 * the plain-prose form.
 */
export function subagentPrompt(args: unknown): string {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const prompt = (args as Record<string, unknown>).prompt;
    if (typeof prompt === 'string') return prompt;
  }
  return JSON.stringify(args ?? null) ?? 'null';
}

/** What the loop needs back: the tool result, plus the child session id to
 *  record on the tool row. The id is absent only when no child was created. */
export interface SubagentDispatch {
  result: ToolResult;
  childSessionId?: string;
}

type RunTurn = (sessionId: string, config: RunConfig) => Promise<void>;

const failure = (error: string, reason: string): ToolResult =>
  ({ ok: false, error: { error, reason } });

/**
 * Run a named agent as a CHILD SESSION of the calling turn, and answer the
 * parent's tool call with what it said.
 *
 * The child is a real session, field for field the one `agent.start` builds,
 * plus two lineage fields (`parent`, `depth`). That is the whole difference
 * from `Agent.ask`, which runs the same shape and then DELETES it: the child
 * persists, so it streams live to anyone subscribed, it stays readable after
 * the parent has moved on, and — the part that matters most — a child parked on
 * an approval is still answerable through the ordinary `agent.approve` path.
 * The parent's turn must never hang waiting on a human (the same reasoning
 * behind `ask-parked`), so it is answered `subagent-parked` immediately; the
 * CHILD stays parked, and approving it later completes it independently.
 *
 * Runs INLINE — awaited inside the parent's tool dispatch, not deferred —
 * because the child's answer IS the tool result. The parent holds its lease and
 * its heartbeat throughout, and the child's own id keeps it clear of the loop's
 * per-session `running` guard.
 *
 * BUDGETS COMPOSE, they do not merge. The parent spends exactly one
 * `budgetSpent.toolCalls` for this call (the loop's ordinary dispatch
 * accounting — nothing here duplicates it), and everything the child spends —
 * turns, tool calls, dollars — accrues to the CHILD's session under the CHILD
 * agent's registry config. So an operator bounds a subagent-heavy parent with
 * the parent's `toolCalls` limit (how many consultations) and the child agent's
 * own `spend` limit (what each consultation may cost).
 */
export async function runSubagent(
  tool: ResolvedTool, args: unknown, ctx: ToolContext, runTurn: RunTurn,
): Promise<SubagentDispatch> {
  const name = tool.subagent!;

  // Model-supplied arguments, checked exactly as an inline tool's are —
  // `runTool` does this for inline tools and a subagent never reaches it, so
  // skipping it here would make the one tool kind whose argument becomes a
  // model's INSTRUCTIONS the only unchecked one.
  const verdict = await validateToolArgs(tool.args, args);
  if (!verdict.ok) {
    return { result: failure('invalid-args', verdict.reason) };
  }

  const parent = await AgentSessions.findOneAsync(ctx.sessionId);
  if (!parent) return { result: failure('subagent-failed', 'The calling session is gone.') };

  // Depth BEFORE the registry lookup and before any write: the guard exists to
  // stop a runaway chain, and a chain that has run away is exactly the case
  // where every extra document costs.
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

  // LAZY resolution — see the note in `resolveTools`. A name that is not
  // registered is a result the model can route around, not a thrown turn.
  const config = getAgent(name);
  if (!config) {
    return { result: failure('unknown-agent', `No agent named "${name}" is registered.`) };
  }

  // Inherited from the PARENT SESSION document, not from `ctx.userId`. They are
  // the same value today (the loop threads `session.userId` into every tool
  // context), and reading it off the document is what makes that a fact rather
  // than a coincidence: the child's owner has to be the parent's owner for
  // `agent.session` to authorize the same people for both.
  const userId = parent.userId ?? null;
  const childSessionId = Random.id();

  await AgentSessions.insertAsync({
    _id: childSessionId,
    agent: name,
    userId,
    phase: 'idle',
    model: config.model,
    nextSeq: 0,
    usage: { input: 0, output: 0, cost: 0 },
    budgetSpent: { turns: 0, toolCalls: 0 },
    // Every loop dispatch path sets `ctx.toolCallId`; the fallback is for a
    // direct caller with no call to name, and keeps the field a string rather
    // than making every reader handle a missing half of the lineage.
    parent: { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId ?? '' },
    depth,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);

  try {
    // Atomic seq allocation, exactly as `agent.send` does it. Nothing else can
    // be writing to a session id that has not left this function yet, but the
    // shape is shared on purpose: the allocation rule is the transcript's
    // ordering invariant, and one path in the package doing it differently is
    // how the next reader concludes it is optional. The `$inc` on
    // `budgetSpent.turns` makes the child's FIRST turn count against its own
    // turn budget, as a `send` would.
    const before = await AgentSessions.rawCollection().findOneAndUpdate(
      { _id: childSessionId },
      { $inc: { nextSeq: 1, 'budgetSpent.turns': 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'before' },
    );
    if (!before) {
      return {
        result: failure('subagent-failed', 'The child session vanished before it could start.'),
        childSessionId,
      };
    }

    await AgentMessages.insertAsync({
      _id: Random.id(),
      sessionId: childSessionId,
      seq: (before as any).nextSeq,
      role: 'user',
      content: subagentPrompt(args),
      createdAt: new Date(),
    } as any);

    await runTurn(childSessionId, buildRunConfig(config, userId));
  } catch (e) {
    // A throw from here is the harness failing, not the model: a bad registry
    // config, a Mongo error, a provider constructor that could not load. Never
    // put the raw message in the result — it reaches the transcript, which is
    // published.
    console.error(
      `[10thfloor:agent] subagent "${name}" (child session ${childSessionId}) threw:`, e,
    );
    return {
      result: failure('subagent-failed', `The subagent "${name}" could not run.`),
      childSessionId,
    };
  }

  const outcome = await readTurnOutcome(childSessionId);
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
