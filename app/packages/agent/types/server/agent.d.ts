import type { MessageSource } from '../common/types';
import { type AgentConfig } from './registry';
import type { Provider } from './providers/types';
import { type AdoptedTool, type AgentMethodOptions } from './tools';
import { type McpServerDef } from './mcp/client';
import { type HookMap, type HookName } from './hooks';
import type { SystemTurnResult } from './system-turn';
import { type SaveArgs } from './memory';
import { type ChannelDef } from './channels/registry';
import { createAttachment } from './attachments';
import { addParticipant, listParticipants, removeParticipant } from './participants';
import { type SessionErasure } from './session-lifecycle';
export declare class Agent {
    readonly name: string;
    constructor(name: string, config?: AgentConfig);
    define(config: AgentConfig): this;
    /** Start a turn no person asked for (schedule, webhook, job).
     *  Idempotent via `key`; a busy session parks until idle. */
    systemTurn(sessionId: string, prompt: string, opts?: {
        key?: string;
        agent?: string;
        source?: string;
    }): Promise<SystemTurnResult>;
    /** One question, one answer — throwaway session, inline turn, no trace.
     *  Rejects with `ask-parked` or `ask-failed` since headless callers
     *  cannot notice a stall. */
    ask(text: string, opts?: {
        userId?: string | null;
    }): Promise<string>;
    /** Server-side send into an existing session — same core as the DDP method.
     *  `userId` defaults to null (anonymous owner), never "all sessions". */
    send(sessionId: string, text: string, opts?: {
        userId?: string | null;
    }): Promise<string>;
    /** Add human conversation context without waking a model. The row remains
     * visible to a later turn, but does not consume the Turn budget or resolve
     * a leading @mention. Server callers may stamp another trusted surface;
     * app/browser contributions default to Desktop. */
    contribute(sessionId: string, text: string, opts?: {
        userId?: string | null;
        source?: MessageSource;
    }): Promise<string>;
    /** Permanently erase one owned root Session and its subagent descendants.
     *  Server-only. `userId` is required; explicit null means anonymous owner.
     *  Memory and account-wide channel identities are preserved. */
    erase(sessionId: string, opts: {
        userId: string | null;
    }): Promise<SessionErasure>;
    /** Server-side approve — same core as DDP method; racing answerers
     *  produce exactly one verdict. */
    approve(sessionId: string, opts?: {
        userId?: string | null;
        expectedToolCallId?: string;
    }): Promise<void>;
    /** The deny half of `approve` — same core, same guarantees; `reason`
     *  reaches the model as the denied tool result. */
    deny(sessionId: string, reason?: string, opts?: {
        userId?: string | null;
        expectedToolCallId?: string;
    }): Promise<void>;
    /** Branch a session at `atSeq` (clamped to batch-safe cut). Returns
     *  the new session's id; the fork is a new root with zeroed usage. */
    fork(sessionId: string, opts?: {
        atSeq?: number;
        title?: string;
        userId?: string | null;
    }): Promise<string>;
    /** Manual compaction — skips the threshold, runs the same path as auto.
     *  Returns true if compacted, false if nothing worth compacting. */
    compact(sessionId: string, opts?: {
        userId?: string | null;
    }): Promise<boolean>;
    /** Per-agent hook — runs after globals, in registration order.
     *  Matched by name at run time, so define-order does not matter. */
    hook<N extends HookName>(name: N, fn: HookMap[N]): this;
    /** Clear this agent's hooks only — test seam. */
    clearHooks(): void;
    /** Register a Meteor method + tool handle in one definition.
     *  Static: the method belongs to the app, any agent may list it. */
    static method(name: string, options: AgentMethodOptions): AdoptedTool;
    /** Register an external channel (Slack, SMS, email) adapter.
     *  Webhook and egress worker are mounted at boot, not here. */
    static channel(kind: string, def: ChannelDef): void;
    /** File attachment surface — `create` for tool bodies (attach: true
     *  stages for the turn's reply), `readTool` for model reads. */
    static attachments: {
        create: typeof createAttachment;
        readTool: import("./tools").InlineTool;
    };
    /** Session roster — server-only; joins are app-code decisions,
     *  never a DDP cap. 16-participant cap; owner cannot be removed. */
    static participants: {
        add: typeof addParticipant;
        remove: typeof removeParticipant;
        list: typeof listParticipants;
    };
    /** Server-side memory access — unrestricted (no approval flow),
     *  because this is operator code, not a model. */
    static memory: {
        save(userId: string | null, args: SaveArgs & {
            by?: string;
        }, opts?: {
            agent?: string;
        }): Promise<import("./memory").SaveResult>;
        list(userId: string | null, opts?: {
            agent?: string;
        }): Promise<import(".").AgentMemory[]>;
        forget(userId: string | null, id: string, opts?: {
            agent?: string;
        }): Promise<import("./memory").ForgetResult>;
    };
    /** Register a named provider so configs can reference it by string.
     *  Resolved lazily on first turn, not at define() time. */
    static provider(name: string, impl: Provider): void;
    /** Register an MCP server as a tool source — validated here,
     *  connected lazily on first turn that needs it. */
    static mcpServer(name: string, def: McpServerDef): void;
    /** Global hook — runs before per-agent hooks, in registration order.
     *  Unknown names throw here; a throwing hook is skipped, not fatal. */
    static hook<N extends HookName>(name: N, fn: HookMap[N]): void;
    /** Clear all hooks (global + per-agent) — test seam. */
    static clearHooks(): void;
}
export type { AgentConfig, SessionErasure };
//# sourceMappingURL=agent.d.ts.map