import { type ResolvedTool, type ToolContext, type ToolResult } from './tools';
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
export declare const MAX_SUBAGENT_DEPTH = 3;
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
export type TurnOutcome = {
    ok: true;
    text: string;
}
/** The session document is gone. */
 | {
    ok: false;
    kind: 'gone';
}
/** Parked at a `gate: 'ask'` tool. `toolName` is what is waiting. */
 | {
    ok: false;
    kind: 'parked';
    toolName: string;
}
/** Terminal: a provider failure, a budget stop, or no assistant reply at all.
 *  `reason` is already sanitized — it comes from the transcript note, which
 *  never carries a raw provider message. */
 | {
    ok: false;
    kind: 'failed';
    reason: string;
};
export declare function readTurnOutcome(sessionId: string): Promise<TurnOutcome>;
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
export declare function subagentPrompt(args: unknown): string;
/** What the loop needs back: the tool result, plus the child session id to
 *  record on the tool row. The id is absent only when no child was created. */
export interface SubagentDispatch {
    result: ToolResult;
    childSessionId?: string;
}
type RunTurn = (sessionId: string, config: RunConfig) => Promise<void>;
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
export declare function runSubagent(tool: ResolvedTool, args: unknown, ctx: ToolContext, runTurn: RunTurn): Promise<SubagentDispatch>;
export {};
//# sourceMappingURL=subagent.d.ts.map