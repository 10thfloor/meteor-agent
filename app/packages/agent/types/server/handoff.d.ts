import type { AgentSession } from '../common/types';
import type { ResolvedTool, ToolSpec, ToolResult } from './tools';
export declare const HANDOFF_TOOL_NAME = "handoff_to_agent";
export declare const HANDOFF_MESSAGE_MAX = 8000;
export declare const HANDOFF_ARGS: {
    readonly type: 'object';
    readonly properties: {
        readonly agent: {
            readonly type: 'string';
            readonly minLength: 1;
            readonly maxLength: 128;
            readonly description: 'Exact agent handle from the conversation roster, without @.';
        };
        readonly message: {
            readonly type: 'string';
            readonly minLength: 1;
            readonly maxLength: 8000;
            readonly description: 'The request or context for the colleague to answer in this conversation.';
        };
    };
    readonly required: readonly ['agent', 'message'];
    readonly additionalProperties: false;
};
export declare function isHandoffTool(tool: ResolvedTool | undefined): boolean;
export declare function assertHandoffNameFree(specs: ToolSpec[]): void;
export declare function withHandoffTool(tools: ResolvedTool[], conversation?: {
    session: Pick<AgentSession, 'agent' | 'participants' | 'parent' | 'ephemeral'>;
    agent: string;
}): ResolvedTool[];
type HandoffOutcome = {
    kind: 'committed';
} | {
    kind: 'abandoned';
} | {
    kind: 'refused';
    result: ToolResult;
    capped?: boolean;
};
/** No external side effect. The receipt, budget and durable activation marker
 * are one leased transaction. A human send/roster edit/Stop winning the race
 * cannot leave a message claiming a handoff that was never scheduled. */
export declare function commitHandoff(input: {
    sessionId: string;
    sourceAgent: string;
    userId: string | null;
    messageId: string;
    toolCallId: string;
    args: unknown;
    relayCap: number;
    toolCallCap?: number;
    authorize(): Promise<boolean>;
}): Promise<HandoffOutcome>;
export {};
//# sourceMappingURL=handoff.d.ts.map