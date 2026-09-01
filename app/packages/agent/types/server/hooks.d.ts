import type { ProviderRequest } from './providers/types';
import type { ToolResult } from './tools';
/** Hook seams: beforeProviderRequest, afterToolResult (global + per-agent).
 *  A broken hook is skipped with one warning; never kills a turn. */
export type HookPurpose = 'think' | 'compaction';
export interface ProviderRequestHookContext {
    /** A child session reports the child agent, not the parent's. */
    agent: string;
    /** Stable experiential identity. Absent for legacy Agents without the new
     * identity contract and for non-Turn provider work. */
    agentId?: string;
    sessionId: string;
    /** Frozen causal frame used by this Turn. */
    memoryFrameId?: string;
    /** `'think'` = the turn's call; `'compaction'` = the summarization call.
     *  A custom summarizer replaces the request when purpose is compaction. */
    purpose: HookPurpose;
}
export interface ToolResultHookContext {
    agent: string;
    agentId?: string;
    sessionId: string;
    memoryFrameId?: string;
    /** The session owner — redaction hooks need it to distinguish authed vs anonymous. */
    userId: string | null;
    /** Mutable so a redaction hook can drop attachments alongside rewritten text. */
    resultAttachments?: import('../common/types').AttachmentRef[];
}
/** The call a result answers, exactly as the model asked for it. */
export interface HookToolCall {
    id: string;
    name: string;
    args: unknown;
}
export type BeforeProviderRequestHook = (req: ProviderRequest, ctx: ProviderRequestHookContext) => ProviderRequest | void | Promise<ProviderRequest | void>;
export type AfterToolResultHook = (result: ToolResult, call: HookToolCall, ctx: ToolResultHookContext) => ToolResult | void | Promise<ToolResult | void>;
export interface HookMap {
    beforeProviderRequest: BeforeProviderRequestHook;
    afterToolResult: AfterToolResultHook;
}
export type HookName = keyof HookMap;
/** Register a global hook. Throws on an unknown name so typos fail loud. */
export declare function registerHook<N extends HookName>(name: N, fn: HookMap[N]): void;
/** Register a per-agent hook. Runs after global hooks when `ctx.agent` matches.
 *  The agent need not be `define()`d yet — hooks are matched by name at run time. */
export declare function registerAgentHook<N extends HookName>(agent: string, name: N, fn: HookMap[N]): void;
/** Test seam: drop all hooks (global + per-agent) and reset warn latches. */
export declare function clearHooks(): void;
/** Test seam: drop one agent's hooks only. */
export declare function clearAgentHooks(agent: string): void;
/** Run the beforeProviderRequest chain. Runs once per attempt (retries re-run).
 *  Caller re-stamps `signal` so a hook can't silently disable cancellation. */
export declare function runBeforeProviderRequest(req: ProviderRequest, ctx: ProviderRequestHookContext): Promise<ProviderRequest>;
/** Run the afterToolResult chain. Covers every tool row including refusals,
 *  so nothing enters the transcript unseen. Runs before truncation/storage. */
export declare function runAfterToolResult(result: ToolResult, call: HookToolCall, ctx: ToolResultHookContext): Promise<ToolResult>;
//# sourceMappingURL=hooks.d.ts.map