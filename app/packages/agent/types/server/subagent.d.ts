import { type ResolvedTool, type ToolContext, type ToolResult } from './tools';
import type { RunConfig } from './loop';
/** Fork-bomb bound: each nesting level multiplies model calls. */
export declare const MAX_SUBAGENT_DEPTH = 3;
/** Outcome of a finished turn, shared by Agent.ask and subagent dispatch. */
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
/** Terminal failure. `reason` comes from the transcript note (sanitized). */
 | {
    ok: false;
    kind: 'failed';
    reason: string;
};
export declare function readTurnOutcome(sessionId: string): Promise<TurnOutcome>;
/** Extract `args.prompt` as a string, or JSON-serialize the whole args object. */
export declare function subagentPrompt(args: unknown): string;
/** Tool result plus optional child session id for the tool row. */
export interface SubagentDispatch {
    result: ToolResult;
    childSessionId?: string;
}
type RunTurn = (sessionId: string, config: RunConfig) => Promise<void>;
/** Run a named agent as a child session. Persists (unlike ask) so it can
 *  stream and accept approvals independently. */
export declare function runSubagent(tool: ResolvedTool, args: unknown, ctx: ToolContext, runTurn: RunTurn): Promise<SubagentDispatch>;
export {};
//# sourceMappingURL=subagent.d.ts.map