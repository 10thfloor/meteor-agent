import type { ToolResult } from '../tools';
/**
 * MCP servers as tool sources.
 *
 * A server is a subprocess speaking MCP over stdio. It is registered by name
 * (`Agent.mcpServer('docs', { command, args, env })`), CONNECTED LAZILY — the
 * first tool use that needs it — and then kept for the life of the process:
 * one connection per SERVER, never per tool.
 *
 * Failure is never a throw. A server that will not start, a `tools/list` that
 * does not answer, a child that dies mid-call — all of it becomes a structured
 * `mcp-unavailable` tool result the model reads and routes around.
 *
 * A failure is remembered only as a COOLDOWN, never as a verdict. See
 * `MCP_FAILURE_COOLDOWN_MS`: a failed open suppresses re-spawning for a bounded
 * window and then expires on its own. That is the M2 catalog-cache lesson kept
 * intact — the lesson was "never cache a failure as if it were an answer", not
 * "re-spawn a dead subprocess on every single tool call". A poisoned cache
 * turns a ten-second outage into a permanently broken agent; a cooldown turns a
 * ten-second outage into a ten-second outage plus at most one cooldown window,
 * and it clears the instant a connect succeeds.
 *
 * Every connect and every discovery is also DEADLINED (`MCP_DISCOVERY_TIMEOUT_MS`).
 * The SDK's own default is 60s per request, and discovery runs on the turn's
 * critical path, so an unbounded wait here is a turn that appears to hang.
 */
/** How a server is started. The three fields a stdio MCP server needs, plus two
 *  per-server budget overrides; the SDK's `StdioServerParameters` has more
 *  (`cwd`, `stderr`, `maxBufferSize`) and adding one here is a one-line
 *  pass-through. */
export interface McpServerDef {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** Deadline for connect AND for `tools/list`, in ms. Defaults to
     *  `MCP_DISCOVERY_TIMEOUT_MS`. A server that is genuinely slow to boot (a
     *  container, a cold `npx` download) raises it. */
    timeoutMs?: number;
    /** How long a FAILED open suppresses the next spawn attempt, in ms. Defaults
     *  to `MCP_FAILURE_COOLDOWN_MS`; 0 disables the cooldown entirely. */
    cooldownMs?: number;
}
/**
 * The default deadline for connecting to a server and for its `tools/list`.
 *
 * 15s, against the SDK's 60s default. Discovery happens once per process per
 * server, but it happens INSIDE a turn that holds a lease and a user is
 * watching, and `expandMcpTools` runs every registered server's discovery
 * before the model is called at all. A minute of silence per dead server is not
 * a failure mode this package is willing to have.
 */
export declare const MCP_DISCOVERY_TIMEOUT_MS = 15000;
/**
 * How long a failed open suppresses the next spawn attempt.
 *
 * NOT a negative cache of the RESULT — the unavailable answer the caller gets
 * during the window is regenerated from the recorded reason, and the window
 * expires on its own with no successful connect required to clear it. A success
 * clears it immediately. The distinction matters: M2's catalog cache remembered
 * a failure with no expiry, so one outage broke an agent until a redeploy.
 */
export declare const MCP_FAILURE_COOLDOWN_MS = 30000;
/** The slice of the SDK's `RequestOptions` this package sets. Probed off
 *  `dist/esm/shared/protocol.d.ts` (1.30.0): `timeout?: number`, the
 *  per-request override for `DEFAULT_REQUEST_TIMEOUT_MSEC` (60000). */
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
/**
 * The slice of the SDK's `Client` this package uses — the TEST SEAM.
 *
 * Probed off `dist/esm/client/index.d.ts` (1.30.0):
 *   `listTools(params?, options?): Promise<{ tools: { name, description?,
 *      inputSchema: { type: 'object', properties?, required? }, … }[] }>`
 *   `callTool(params: { name, arguments?, … }, resultSchema?, options?)`
 *      `: Promise<{ content: (…)[]; isError?: boolean; … } | { toolResult }>`
 *   `close(): Promise<void>` (inherited from `Protocol`)
 * `connect(transport)` is deliberately NOT part of this interface: connecting
 * is the FACTORY's job, so a fake never has to model a transport.
 *
 * `listTools` takes the SDK's SECOND argument here — `params` first, `options`
 * second — because that is where the request `timeout` lives. Both are optional,
 * so a fake that declares `async listTools()` still satisfies this.
 */
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
/**
 * Register an MCP server definition. Validated and THROWN ON at registration,
 * like `defineAgent`: a typo in a command is a startup error, not something a
 * session discovers by failing every tool call.
 *
 * Re-registering a name replaces the definition and drops any live connection,
 * so a redefinition in a hot-reloaded dev server actually takes effect.
 */
export declare function registerMcpServer(name: string, def: McpServerDef): void;
export declare function getMcpServer(name: string): McpServerDef | undefined;
/**
 * Third-party error text → something safe to publish.
 *
 * The rules, in order. Any of them firing returns the GENERIC message rather
 * than a redacted version of the original — when in doubt, say nothing:
 *
 *  1. not a non-empty string → generic;
 *  2. a leading `…Error:` label is stripped (a label, not a stack);
 *  3. control characters → generic;
 *  4. stack-shaped, path-shaped, URL-shaped or `line:col`-shaped → generic;
 *  5. any whitespace-free run of 24+ characters → generic. A sentence does not
 *     contain one; a token, a key, a base64 blob, a URL and an absolute path
 *     all do. This is the rule that catches a leaked secret whose shape nobody
 *     anticipated;
 *  6. whitespace collapses to single spaces and the result is clamped to 200
 *     characters, because a tool row is published and a server may answer with
 *     a megabyte.
 */
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
export declare function warnMcp(message: string): void;
/**
 * An MCP `tools/call` answer → this package's tool-result vocabulary.
 *
 *  - `isError: true` → a structured `mcp-tool-failed` whose reason is the first
 *    text item, SANITIZED. That text is third-party output on its way into a
 *    published transcript; see `sanitizeMcpReason`.
 *  - text content items concatenate; anything else becomes a
 *    `[<type> content omitted]` marker, so the model knows something was there.
 *  - the pre-content `{ toolResult }` compatibility shape passes through as the
 *    value.
 *
 * SUCCESS output is NOT sanitized. It is the tool's legitimate answer, exactly
 * like an adopted method's return value, and it is truncated by the loop's
 * `maxResultChars` like every other result. Sanitization is for REASONS — the
 * field this package has always promised is safe to publish.
 *
 * Exported so the tests can pin this mapping rather than trust it.
 */
export declare function mapMcpResult(raw: McpCallResult | undefined | null): ToolResult;
/**
 * Call one tool on one server. The whole failure surface is structured:
 * `mcp-unavailable` for a server that could not be reached (retried once the
 * failure cooldown expires — nothing is cached as a verdict), `mcp-tool-failed`
 * for a server that answered `isError`.
 */
export declare function callMcpTool(server: string, tool: string, args: unknown): Promise<ToolResult>;
/**
 * Close every connection and forget it. Exported for hosts that manage their
 * own shutdown, and for tests, which must not leave subprocesses (or fakes)
 * behind between files.
 */
export declare function stopMcp(): Promise<void>;
/**
 * Replace the client factory — the seam the network-free tests inject a fake
 * through, mirroring `_setBackoff` and `setTypeboxValueLoader`. `null` restores
 * the real SDK-backed factory.
 *
 * Every cached connection and every failure cooldown is dropped on both the set
 * and the restore, and the restore ALSO puts the server-definitions map back the
 * way it found it: a `Agent.mcpServer(…)` a test registers while the fake is
 * installed names a server only the fake can serve, and leaving it in the
 * registry would let a later test — or the live smoke — connect the real SDK to
 * a command that was never meant to be spawned. Registrations made BEFORE the
 * seam is installed are in the snapshot, so they survive, which is the order
 * every test here uses.
 *
 * Underscored because it is a test seam, not API.
 */
export declare function _setMcpClientFactory(next: McpClientFactory | null): () => void;
//# sourceMappingURL=client.d.ts.map