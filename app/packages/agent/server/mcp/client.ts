import { loadMcpSdk } from './loader';
// TYPE-only: `tools.ts` imports THIS module at runtime, so a runtime import
// back would close a cycle. The result shape is the package's one tool-result
// vocabulary and there is no second copy of it.
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
 * `mcp-unavailable` tool result the model reads and routes around, and NOTHING
 * about the failure is cached. The next use reconnects. That is the M2
 * catalog-cache lesson applied here: a cache that remembers a failure turns a
 * ten-second outage into a permanently broken agent.
 */

/** How a server is started. Exactly the three fields a stdio MCP server needs;
 *  the SDK's `StdioServerParameters` has more (`cwd`, `stderr`,
 *  `maxBufferSize`) and adding one here is a one-line pass-through. */
export interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
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
 */
export interface McpClient {
  listTools(): Promise<{ tools?: McpToolInfo[] } | undefined>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** Build a CONNECTED client for a server definition. Rejecting is the way to
 *  report "this server is not available"; the caller turns that into
 *  `mcp-unavailable` and forgets it happened. */
export type McpClientFactory = (name: string, def: McpServerDef) => Promise<McpClient>;

/* ------------------------------ registry ------------------------------ */

const servers = new Map<string, McpServerDef>();

function assertString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `[10thfloor:agent] Agent.mcpServer: ${field} must be a non-empty string; `
      + `got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Register an MCP server definition. Validated and THROWN ON at registration,
 * like `defineAgent`: a typo in a command is a startup error, not something a
 * session discovers by failing every tool call.
 *
 * Re-registering a name replaces the definition and drops any live connection,
 * so a redefinition in a hot-reloaded dev server actually takes effect.
 */
export function registerMcpServer(name: string, def: McpServerDef): void {
  assertString(name, 'the server name');
  if (!def || typeof def !== 'object') {
    throw new Error(
      `[10thfloor:agent] Agent.mcpServer('${name}') needs a { command, args?, env? }`,
    );
  }
  assertString(def.command, `command for MCP server "${name}"`);
  if (def.args !== undefined
    && (!Array.isArray(def.args) || def.args.some((a) => typeof a !== 'string'))) {
    throw new Error(
      `[10thfloor:agent] Agent.mcpServer('${name}'): args must be an array of strings`,
    );
  }
  if (def.env !== undefined
    && (!def.env || typeof def.env !== 'object' || Array.isArray(def.env)
      || Object.values(def.env).some((v) => typeof v !== 'string'))) {
    throw new Error(
      `[10thfloor:agent] Agent.mcpServer('${name}'): env must be an object of strings`,
    );
  }
  if (servers.has(name)) dropConnection(name);
  servers.set(name, {
    command: def.command,
    args: def.args ? [...def.args] : undefined,
    env: def.env ? { ...def.env } : undefined,
  });
}

export function getMcpServer(name: string): McpServerDef | undefined {
  return servers.get(name);
}

/* --------------------------- sanitization ---------------------------- */

const GENERIC = 'The MCP tool reported an error.';
const MAX_REASON = 200;

/**
 * Anything that looks like a stack frame, a filesystem path, a URL or a
 * source location. Text matching this is REPLACED, not trimmed: a reason is
 * fed to the model AND stored in the published transcript, and a third-party
 * subprocess is under no obligation to keep secrets out of its error strings.
 */
const STACKISH = /\bat\s+\S+\s*\(|\bat\s+\/|file:\/\/|node_modules|[A-Za-z]:\\|(^|\s)\/[\w.-]+\/[\w.\-/]+|:\d+:\d+/;

/** A leading `Error:` / `TypeError:` / `McpError:` label — stripped rather
 *  than treated as stack-shaped, because "Error: no such document" is an
 *  ordinary, useful message. */
const ERROR_LABEL = /^[\w$]*Error:\s*/;

/**
 * Control characters: terminal escapes and framing junk, which a published row
 * must not carry. Tab, newline and carriage return are ORDINARY whitespace here
 * (they collapse to spaces below); everything else under 0x20, plus DEL, is
 * disqualifying.
 *
 * Written as a code-point scan rather than a regex character class on purpose:
 * a range like that has to be spelled with escapes, and one mistyped escape
 * puts a literal control byte in this source file — which makes the file
 * binary to grep and every other tool that reads it.
 */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) return true;
  }
  return false;
}

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
export function sanitizeMcpReason(raw: unknown, fallback: string = GENERIC): string {
  if (typeof raw !== 'string') return fallback;
  const text = raw.trim().replace(ERROR_LABEL, '').trim();
  if (!text) return fallback;
  if (hasControlChars(text)) return fallback;
  if (STACKISH.test(text)) return fallback;
  if (/\S{24,}/.test(text)) return fallback;
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > MAX_REASON ? `${oneLine.slice(0, MAX_REASON - 1)}…` : oneLine;
}

/** The reason for a server that could not be reached. The detail is the SDK's
 *  or the OS's message, so it goes through the same sanitizer. */
function unavailable(server: string, e: unknown): string {
  const detail = sanitizeMcpReason(
    (e as Error)?.message, 'it could not be started or did not answer',
  );
  return `The MCP server "${server}" is unavailable: ${detail}`;
}

/* ---------------------------- connections ---------------------------- */

interface Connection {
  client: McpClient;
  tools: McpToolInfo[];
  byName: Map<string, McpToolInfo>;
}

/**
 * The default factory: the real SDK, through the loader seam.
 *
 * `env` MERGES over the SDK's `getDefaultEnvironment()` rather than replacing
 * it. That function returns a curated safe subset of `process.env`
 * (`DEFAULT_INHERITED_ENV_VARS` — PATH, HOME and friends), and the SDK uses it
 * only when `env` is ABSENT: passing `{ API_KEY: … }` alone would spawn a
 * server with no PATH, which surfaces as a baffling ENOENT.
 */
const defaultFactory: McpClientFactory = async (_name, def) => {
  const clientNs = await loadMcpSdk('client') as any;
  const stdioNs = await loadMcpSdk('client/stdio.js') as any;
  const ClientCtor = clientNs?.Client;
  const TransportCtor = stdioNs?.StdioClientTransport;
  if (typeof ClientCtor !== 'function' || typeof TransportCtor !== 'function') {
    throw new Error('the MCP SDK exposes no Client/StdioClientTransport');
  }
  const baseEnv = typeof stdioNs.getDefaultEnvironment === 'function'
    ? stdioNs.getDefaultEnvironment() : {};
  const transport = new TransportCtor({
    command: def.command,
    args: def.args ?? [],
    ...(def.env ? { env: { ...baseEnv, ...def.env } } : {}),
  });
  const client = new ClientCtor(
    { name: '10thfloor:agent', version: '0.1.0' }, { capabilities: {} },
  );
  await client.connect(transport);
  return {
    listTools: () => client.listTools(),
    callTool: (params: any) => client.callTool(params),
    close: () => client.close(),
  };
};

let factory: McpClientFactory = defaultFactory;

const connections = new Map<string, Connection>();
const pending = new Map<string, Promise<Connection>>();

function closeQuietly(client: McpClient): void {
  try {
    void Promise.resolve(client.close()).catch(() => { /* best effort */ });
  } catch { /* best effort */ }
}

/** Forget a server's connection (and close it, best effort). Called when the
 *  definition changes, when a call fails at the transport, and by `stopMcp`. */
function dropConnection(name: string): void {
  const conn = connections.get(name);
  connections.delete(name);
  pending.delete(name);
  if (conn) closeQuietly(conn.client);
}

/**
 * Best-effort teardown at process exit. Registered ONCE, and only after a
 * connection actually exists, so a process that never touches MCP adds no
 * listener.
 *
 * `exit` handlers cannot await, so this is genuinely best effort: `close()`
 * kills the child synchronously enough to matter in practice, and the promise
 * it returns is dropped on the floor. A host that wants a guaranteed clean
 * shutdown calls `stopMcp()` itself.
 */
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const conn of connections.values()) {
      try { void conn.client.close(); } catch { /* best effort */ }
    }
    connections.clear();
  });
}

type ConnectResult = { ok: true; conn: Connection } | { ok: false; reason: string };

async function openConnection(name: string, def: McpServerDef): Promise<Connection> {
  const client = await factory(name, def);
  try {
    // Discovery is part of CONNECTING, not a separately cached thing. A client
    // whose `tools/list` failed is a client this package cannot use, and
    // keeping it would leave a connection whose catalog is permanently empty.
    const listed = await client.listTools();
    const tools = (listed?.tools ?? []).filter(
      (t): t is McpToolInfo => !!t && typeof t.name === 'string' && t.name !== '',
    );
    const conn: Connection = { client, tools, byName: new Map(tools.map((t) => [t.name, t])) };
    hookExit();
    return conn;
  } catch (e) {
    closeQuietly(client);
    throw e;
  }
}

/**
 * The one route to a connected, discovered server. Concurrent callers share a
 * single in-flight attempt; a SUCCESS is cached for the process; a FAILURE is
 * not cached at all.
 */
async function connect(name: string): Promise<ConnectResult> {
  const hit = connections.get(name);
  if (hit) return { ok: true, conn: hit };
  const def = servers.get(name);
  if (!def) return { ok: false, reason: `No MCP server named "${name}" is registered.` };

  let attempt = pending.get(name);
  if (!attempt) {
    attempt = openConnection(name, def);
    pending.set(name, attempt);
  }
  try {
    const conn = await attempt;
    connections.set(name, conn);
    return { ok: true, conn };
  } catch (e) {
    return { ok: false, reason: unavailable(name, e) };
  } finally {
    // The in-flight marker goes either way — a failed attempt must leave no
    // trace, and a successful one is remembered in `connections` instead.
    // Guarded so a slow loser cannot delete a NEWER attempt.
    if (pending.get(name) === attempt) pending.delete(name);
  }
}

/* ------------------------------ the API ------------------------------ */

export type DiscoveryResult =
  | { ok: true; tools: McpToolInfo[] }
  | { ok: false; reason: string };

/** The server's tool catalog, connecting if necessary. Cached with the
 *  connection; a failure is not. */
export async function discoverMcpTools(server: string): Promise<DiscoveryResult> {
  const c = await connect(server);
  return c.ok ? { ok: true, tools: c.conn.tools } : { ok: false, reason: c.reason };
}

/** One discovered tool's metadata, or undefined. */
export async function discoverMcpTool(
  server: string, tool: string,
): Promise<McpToolInfo | undefined> {
  const c = await connect(server);
  return c.ok ? c.conn.byName.get(tool) : undefined;
}

/** Non-text content is NOTED, not embedded: images and audio are base64 blobs
 *  that would blow the result budget and mean nothing to a text model. The
 *  type name is clamped to a plausible shape — it is server-supplied, and it
 *  lands in the published transcript. */
function renderContent(content: McpCallResult['content']): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
      continue;
    }
    const kind = item && typeof item.type === 'string' && /^[a-z_]{1,24}$/.test(item.type)
      ? item.type : 'unknown';
    parts.push(`[${kind} content omitted]`);
  }
  return parts.join('\n');
}

function firstText(raw: McpCallResult): string | undefined {
  if (!Array.isArray(raw.content)) return undefined;
  for (const item of raw.content) {
    if (item && item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      return item.text;
    }
  }
  return undefined;
}

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
export function mapMcpResult(raw: McpCallResult | undefined | null): ToolResult {
  if (!raw || typeof raw !== 'object') return { ok: true, value: '' };
  if (raw.isError === true) {
    return {
      ok: false,
      error: { error: 'mcp-tool-failed', reason: sanitizeMcpReason(firstText(raw)) },
    };
  }
  if (!Array.isArray(raw.content) && 'toolResult' in raw) {
    return { ok: true, value: raw.toolResult };
  }
  return { ok: true, value: renderContent(raw.content) };
}

/**
 * Call one tool on one server. The whole failure surface is structured:
 * `mcp-unavailable` for a server that could not be reached (retried on the next
 * call — nothing is cached), `mcp-tool-failed` for a server that answered
 * `isError`.
 */
export async function callMcpTool(
  server: string, tool: string, args: unknown,
): Promise<ToolResult> {
  const c = await connect(server);
  if (!c.ok) return { ok: false, error: { error: 'mcp-unavailable', reason: c.reason } };

  const params = {
    name: tool,
    arguments: (args && typeof args === 'object' && !Array.isArray(args))
      ? args as Record<string, unknown>
      : {},
  };
  try {
    return mapMcpResult(await c.conn.client.callTool(params));
  } catch (e) {
    // A rejection here is the TRANSPORT, not the tool: the child died, the
    // request timed out, the protocol framing broke. The connection is suspect,
    // so drop it — the next call reconnects rather than talking to a corpse.
    dropConnection(server);
    return { ok: false, error: { error: 'mcp-unavailable', reason: unavailable(server, e) } };
  }
}

/**
 * Close every connection and forget it. Exported for hosts that manage their
 * own shutdown, and for tests, which must not leave subprocesses (or fakes)
 * behind between files.
 */
export async function stopMcp(): Promise<void> {
  const open = [...connections.values()];
  connections.clear();
  pending.clear();
  await Promise.all(open.map(async (conn) => {
    try { await conn.client.close(); } catch { /* best effort */ }
  }));
}

/**
 * Replace the client factory — the seam the network-free tests inject a fake
 * through, mirroring `_setBackoff` and `setTypeboxValueLoader`. `null` restores
 * the real SDK-backed factory.
 *
 * Every cached connection is dropped on both the set and the restore, so a fake
 * can never outlive the test that installed it. Underscored because it is a
 * test seam, not API.
 */
export function _setMcpClientFactory(next: McpClientFactory | null): () => void {
  const previous = factory;
  const open = [...connections.values()];
  connections.clear();
  pending.clear();
  for (const conn of open) closeQuietly(conn.client);
  factory = next ?? defaultFactory;
  return () => {
    const live = [...connections.values()];
    connections.clear();
    pending.clear();
    for (const conn of live) closeQuietly(conn.client);
    factory = previous;
  };
}
