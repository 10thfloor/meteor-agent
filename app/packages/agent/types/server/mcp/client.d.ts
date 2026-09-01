import type { ToolResult } from '../tools';
/** MCP servers as lazy stdio subprocesses. Failures become structured
 *  `mcp-unavailable` results (never throws). Failed opens use a bounded
 *  cooldown, not a permanent cache. */
/** How a server is started. */
export interface McpServerDef {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** Deadline for connect and `tools/list`, in ms. Default: `MCP_DISCOVERY_TIMEOUT_MS`. */
    timeoutMs?: number;
    /** How long a failed open suppresses the next attempt. Default: `MCP_FAILURE_COOLDOWN_MS`; 0 to disable. */
    cooldownMs?: number;
}
/** Coarse runtime state for operator UIs. Deliberately excludes the command,
 * environment and last failure reason: those may contain deployment secrets. */
export type McpServerState = 'disconnected' | 'connecting' | 'connected' | 'cooldown';
export interface McpServerStatus {
    registered: boolean;
    state: McpServerState;
    /** Present only while connected. */
    toolCount?: number;
    /** Present only during an active cooldown. */
    cooldownUntil?: Date;
}
/** 15s deadline for connect + discovery (the SDK's 60s default is too long
 *  for something that blocks the turn). */
export declare const MCP_DISCOVERY_TIMEOUT_MS = 15000;
/** Cooldown after a failed open. Expires on its own; a success clears it
 *  immediately. Not a permanent cache — that was an M2 bug. */
export declare const MCP_FAILURE_COOLDOWN_MS = 30000;
/** The slice of the SDK's RequestOptions this package sets. */
export interface McpRequestOptions {
    timeout?: number;
}
/** One entry of the server's `tools/list` answer. `inputSchema` is JSON Schema
 *  and becomes the tool's `args` unless the spec overrode it. */
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
}
/** The MCP `tools/call` answer, as much of it as this package reads. */
export interface McpCallResult {
    content?: Array<{
        type?: string;
        text?: string;
        [k: string]: unknown;
    }>;
    isError?: boolean;
    /** The SDK's `CompatibilityCallToolResultSchema` shape, for pre-content
     *  servers: `{ toolResult }` and no `content` at all. */
    toolResult?: unknown;
    [k: string]: unknown;
}
/** Test seam for the SDK Client. Connecting is the factory's job. */
export interface McpClient {
    listTools(params?: Record<string, unknown>, options?: McpRequestOptions): Promise<{
        tools?: McpToolInfo[];
    } | undefined>;
    callTool(params: {
        name: string;
        arguments?: Record<string, unknown>;
    }): Promise<McpCallResult>;
    close(): Promise<void>;
}
/** Build a CONNECTED client for a server definition. Rejecting is the way to
 *  report "this server is not available"; the caller turns that into
 *  `mcp-unavailable` and forgets it happened. */
export type McpClientFactory = (name: string, def: McpServerDef) => Promise<McpClient>;
/** Register (or replace) an MCP server definition. Validates eagerly. */
export declare function registerMcpServer(name: string, def: McpServerDef): void;
export declare function getMcpServer(name: string): McpServerDef | undefined;
/** Sanitize third-party error text for the published transcript. Falls back
 *  to a generic message on any sign of stack traces, paths, long opaque
 *  tokens, or control characters. */
export declare function sanitizeMcpReason(raw: unknown, fallback?: string): string;
export type DiscoveryResult = {
    ok: true;
    tools: McpToolInfo[];
} | {
    ok: false;
    reason: string;
};
/** The server's tool catalog, connecting if necessary. Cached with the
 *  connection; a failure is remembered only as a bounded cooldown. */
export declare function discoverMcpTools(server: string): Promise<DiscoveryResult>;
/** Close this server's current and in-flight clients while retaining its
 * registration. Returns false only when neither registration nor runtime state
 * exists for `name`. A later discovery reconnects from the stored definition. */
export declare function disconnectMcpServer(name: string): Promise<boolean>;
/** Remove this server's registration and close every current/in-flight client.
 * The registry deletion is synchronous from callers' perspective, before any
 * asynchronous close is awaited. */
export declare function unregisterMcpServer(name: string): Promise<boolean>;
/** Read a coarse, secret-safe snapshot for an operator UI. Configuration and
 * failure detail intentionally remain available only to the code that owns the
 * registration. */
export declare function getMcpServerStatus(name: string): McpServerStatus;
export declare function warnMcp(message: string): void;
/** Map an MCP call result to ToolResult. Errors are sanitized. */
export declare function mapMcpResult(raw: McpCallResult | undefined | null): ToolResult;
/** Call one tool on one server. Failures are structured, never throws. */
export declare function callMcpTool(server: string, tool: string, args: unknown, authorize?: () => boolean | Promise<boolean>, displayName?: string): Promise<ToolResult>;
/** Close every current and in-flight client. Registrations remain available so
 * a long-lived process can reconnect after a coordinated runtime stop. */
export declare function stopMcp(): Promise<void>;
/** Test seam: replace the client factory. null restores the default.
 *  Snapshots and restores server definitions so test registrations don't leak. */
export declare function _setMcpClientFactory(next: McpClientFactory | null): () => void;
//# sourceMappingURL=client.d.ts.map