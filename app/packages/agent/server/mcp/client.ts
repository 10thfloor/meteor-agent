import { loadMcpSdk } from './loader';
// TYPE-only: `tools.ts` imports THIS module at runtime, so a runtime import
// back would close a cycle. The result shape is the package's one tool-result
// vocabulary and there is no second copy of it.
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
export const MCP_DISCOVERY_TIMEOUT_MS = 15_000;

/** Cooldown after a failed open. Expires on its own; a success clears it
 *  immediately. Not a permanent cache — that was an M2 bug. */
export const MCP_FAILURE_COOLDOWN_MS = 30_000;

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
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  /** The SDK's `CompatibilityCallToolResultSchema` shape, for pre-content
   *  servers: `{ toolResult }` and no `content` at all. */
  toolResult?: unknown;
  [k: string]: unknown;
}

/** Test seam for the SDK Client. Connecting is the factory's job. */
export interface McpClient {
  listTools(
    params?: Record<string, unknown>, options?: McpRequestOptions,
  ): Promise<{ tools?: McpToolInfo[] } | undefined>;
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

/** Register (or replace) an MCP server definition. Validates eagerly. */
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
  for (const field of ['timeoutMs', 'cooldownMs'] as const) {
    const v = def[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new Error(
        `[10thfloor:agent] Agent.mcpServer('${name}'): ${field} must be a non-negative number`,
      );
    }
  }
  // Replacing a definition invalidates every open/pending operation before the
  // new definition becomes visible. Closing is best-effort because this API is
  // intentionally synchronous; generation fencing prevents a late close from
  // ever caching the old connection under the new definition.
  const invalidated = invalidateServerRuntime(name);
  void Promise.all(invalidated.closing);
  servers.set(name, {
    command: def.command,
    args: def.args ? [...def.args] : undefined,
    env: def.env ? { ...def.env } : undefined,
    timeoutMs: def.timeoutMs,
    cooldownMs: def.cooldownMs,
  });
}

export function getMcpServer(name: string): McpServerDef | undefined {
  return servers.get(name);
}

/* --------------------------- sanitization ---------------------------- */

const GENERIC = 'The MCP tool reported an error.';
const MAX_REASON = 200;

/** Matches stack frames, paths, URLs, and source locations. Replaced because
 *  these are third-party strings stored in the published transcript. */
const STACKISH = /\bat\s+\S+\s*\(|\bat\s+\/|file:\/\/|node_modules|[A-Za-z]:\\|(^|\s)\/[\w.-]+\/[\w.\-/]+|:\d+:\d+/;

/** A leading `Error:` / `TypeError:` / `McpError:` label — stripped rather
 *  than treated as stack-shaped, because "Error: no such document" is an
 *  ordinary, useful message. */
const ERROR_LABEL = /^[\w$]*Error:\s*/;

/** Detect control chars (except tab/newline/CR). Code-point scan avoids
 *  binary-looking regex escapes. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** Sanitize third-party error text for the published transcript. Falls back
 *  to a generic message on any sign of stack traces, paths, long opaque
 *  tokens, or control characters. */
export function sanitizeMcpReason(raw: unknown, fallback: string = GENERIC): string {
  if (typeof raw !== 'string') return fallback;
  const text = raw.trim().replace(ERROR_LABEL, '').trim();
  if (!text) return fallback;
  if (hasControlChars(text)) return fallback;
  if (STACKISH.test(text)) return fallback;
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)) return fallback;
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)) return fallback;
  if (/\+?\d[\d\s().-]{6,}\d/.test(text)) return fallback;
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
  generation: number;
}

interface PendingAttempt {
  generation: number;
  invalidated: boolean;
  /** Set as soon as the factory resolves, including while `tools/list` waits. */
  client?: McpClient;
  promise: Promise<ConnectResult>;
}

/** The default factory. env merges over the SDK's `getDefaultEnvironment()`
 *  as insurance — the SDK already merges, but a future version might not. */
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
    { name: '10thfloor:agent', version: '0.3.0' }, { capabilities: {} },
  );
  await client.connect(transport);
  return {
    listTools: (params?: any, options?: any) => client.listTools(params, options),
    callTool: (params: any) => client.callTool(params),
    close: () => client.close(),
  };
};

let factory: McpClientFactory = defaultFactory;

const connections = new Map<string, Connection>();
const pending = new Map<string, PendingAttempt>();
/** Per-server failure cooldowns: the wall-clock instant the next spawn attempt
 *  is allowed, and the reason to answer with until then. See
 *  `MCP_FAILURE_COOLDOWN_MS` for why this is a cooldown and not a cache. */
const cooldowns = new Map<string, { until: number; reason: string }>();

/** A monotonic token makes an old open distinguishable even if a server is
 * removed and immediately registered again under the same name. */
const generations = new Map<string, number>();
let nextGeneration = 1;

/** Closing is idempotent per client. Invalidation can race the factory/list
 * continuation, and both paths are responsible for cleanup. */
const closingClients = new WeakMap<McpClient, Promise<void>>();

function closeClient(client: McpClient): Promise<void> {
  const known = closingClients.get(client);
  if (known) return known;
  let finish!: () => void;
  const closing = new Promise<void>((resolve) => { finish = resolve; });
  // Publish before invoking third-party code so even a re-entrant close event
  // cannot call the same client's close method twice.
  closingClients.set(client, closing);
  try {
    void Promise.resolve(client.close()).then(finish, finish);
  } catch {
    finish();
  }
  return closing;
}

function closeQuietly(client: McpClient): void {
  void closeClient(client);
}

function advanceGeneration(name: string): number {
  const generation = nextGeneration;
  nextGeneration += 1;
  generations.set(name, generation);
  return generation;
}

function generationFor(name: string): number {
  return generations.get(name) ?? advanceGeneration(name);
}

/** Atomically forget one runtime generation, then close every client already
 * known to it. An unresolved factory is fenced by `invalidated`; its eventual
 * client is closed by `openConnection` and can never enter `connections`. */
function invalidateServerRuntime(
  name: string,
): { closing: Promise<void>[] } {
  const conn = connections.get(name);
  const attempt = pending.get(name);

  advanceGeneration(name);
  connections.delete(name);
  pending.delete(name);
  cooldowns.delete(name);
  if (attempt) attempt.invalidated = true;

  const clients = new Set<McpClient>();
  if (conn) clients.add(conn.client);
  if (attempt?.client) clients.add(attempt.client);
  return {
    closing: [...clients].map((client) => closeClient(client)),
  };
}

function invalidateAllRuntime(): Promise<void>[] {
  const names = new Set<string>([
    ...servers.keys(), ...connections.keys(), ...pending.keys(), ...cooldowns.keys(),
  ]);
  const closing: Promise<void>[] = [];
  for (const name of names) closing.push(...invalidateServerRuntime(name).closing);
  return closing;
}

/** Forget a server's connection (and close it, best effort). Called when the
 *  definition changes, when a call fails at the transport, and by `stopMcp`. */
function dropConnection(name: string, expected?: Connection): void {
  // A call on an old client may fail after a replacement has already connected.
  // It must close its own client without invalidating that newer generation.
  if (expected && connections.get(name) !== expected) {
    closeQuietly(expected.client);
    return;
  }
  const invalidated = invalidateServerRuntime(name);
  void Promise.all(invalidated.closing);
}

/** Best-effort child cleanup on exit; registered lazily. */
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    void Promise.all(invalidateAllRuntime());
  });
}

type ConnectResult = { ok: true; conn: Connection } | { ok: false; reason: string };

/** A promise with a hard deadline. Rejects with `what` when the budget runs
 *  out; the underlying work is NOT cancelled (nothing here can cancel a spawn),
 *  which is why the caller has to deal with a late arrival itself. */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function budgetFor(def: McpServerDef): number {
  return def.timeoutMs ?? MCP_DISCOVERY_TIMEOUT_MS;
}

function attemptIsCurrent(name: string, attempt: PendingAttempt): boolean {
  return !attempt.invalidated
    && pending.get(name) === attempt
    && generations.get(name) === attempt.generation
    && servers.has(name);
}

function invalidatedReason(name: string): string {
  return `The MCP server "${name}" changed while connecting. Retry with its current configuration.`;
}

async function openConnection(
  name: string, def: McpServerDef, attempt: PendingAttempt,
): Promise<Connection> {
  const budget = budgetFor(def);
  const started = factory(name, def);
  let abandoned = false;
  // Close a late-arriving or superseded subprocess rather than leaking it.
  void started.then(
    (late) => {
      if (abandoned || !attemptIsCurrent(name, attempt)) closeQuietly(late);
    },
    () => { /* reported by the await below */ },
  );

  let client: McpClient;
  try {
    client = await withDeadline(started, budget, `the MCP server "${name}" did not connect`);
  } catch (e) {
    abandoned = true;
    throw e;
  }
  attempt.client = client;
  if (!attemptIsCurrent(name, attempt)) {
    await closeClient(client);
    throw new Error(invalidatedReason(name));
  }

  try {
    // Discovery is part of connecting — a client with no tool list is useless.
    // Budget passed both to the SDK (cancels the request) and as a deadline
    // (insurance against a client that ignores the option).
    const listed = await withDeadline(
      Promise.resolve(client.listTools(undefined, { timeout: budget })),
      budget,
      `the MCP server "${name}" did not list its tools`,
    );
    if (!attemptIsCurrent(name, attempt)) {
      await closeClient(client);
      throw new Error(invalidatedReason(name));
    }
    const tools = (listed?.tools ?? []).filter(
      (t): t is McpToolInfo => !!t && typeof t.name === 'string' && t.name !== '',
    );
    const conn: Connection = {
      client,
      tools,
      byName: new Map(tools.map((t) => [t.name, t])),
      generation: attempt.generation,
    };
    hookExit();
    return conn;
  } catch (e) {
    closeQuietly(client);
    throw e;
  }
}

async function runConnectAttempt(
  name: string, def: McpServerDef, attempt: PendingAttempt,
): Promise<ConnectResult> {
  try {
    const conn = await openConnection(name, def, attempt);
    if (!attemptIsCurrent(name, attempt)) {
      await closeClient(conn.client);
      return { ok: false, reason: invalidatedReason(name) };
    }
    connections.set(name, conn);
    cooldowns.delete(name);
    return { ok: true, conn };
  } catch (e) {
    // Teardown/replacement is not an outage and must not poison the new
    // generation with the old definition's failure cooldown.
    if (!attemptIsCurrent(name, attempt)) {
      return { ok: false, reason: invalidatedReason(name) };
    }
    const reason = unavailable(name, e);
    const cooldownMs = def.cooldownMs ?? MCP_FAILURE_COOLDOWN_MS;
    if (cooldownMs > 0) cooldowns.set(name, { until: Date.now() + cooldownMs, reason });
    return { ok: false, reason };
  } finally {
    if (pending.get(name) === attempt) pending.delete(name);
  }
}

function startConnectAttempt(name: string, def: McpServerDef): PendingAttempt {
  const attempt: PendingAttempt = {
    generation: generationFor(name),
    invalidated: false,
    promise: undefined as unknown as Promise<ConnectResult>,
  };
  // Publish the identity before executing any asynchronous continuation: the
  // current-generation predicate is also used by a synchronously resolving
  // fake factory in tests.
  pending.set(name, attempt);
  attempt.promise = runConnectAttempt(name, def, attempt);
  return attempt;
}

/** Connect (or return cached connection). Concurrent callers share one attempt;
 *  failures start a bounded cooldown. */
async function connect(name: string): Promise<ConnectResult> {
  const hit = connections.get(name);
  if (hit && hit.generation === generations.get(name)) return { ok: true, conn: hit };
  const def = servers.get(name);
  if (!def) return { ok: false, reason: `No MCP server named "${name}" is registered.` };

  const cool = cooldowns.get(name);
  if (cool) {
    if (Date.now() < cool.until) return { ok: false, reason: cool.reason };
    // Expired: forget it BEFORE retrying, so the retry's own outcome — success
    // or a fresh cooldown — is the only thing that decides what happens next.
    cooldowns.delete(name);
  }

  const attempt = pending.get(name) ?? startConnectAttempt(name, def);
  return attempt.promise;
}

/* ------------------------------ the API ------------------------------ */

export type DiscoveryResult =
  | { ok: true; tools: McpToolInfo[] }
  | { ok: false; reason: string };

/** The server's tool catalog, connecting if necessary. Cached with the
 *  connection; a failure is remembered only as a bounded cooldown. */
export async function discoverMcpTools(server: string): Promise<DiscoveryResult> {
  const c = await connect(server);
  return c.ok ? { ok: true, tools: c.conn.tools } : { ok: false, reason: c.reason };
}

/** Close this server's current and in-flight clients while retaining its
 * registration. Returns false only when neither registration nor runtime state
 * exists for `name`. A later discovery reconnects from the stored definition. */
export async function disconnectMcpServer(name: string): Promise<boolean> {
  const existed = servers.has(name)
    || connections.has(name) || pending.has(name) || cooldowns.has(name);
  if (!existed) return false;
  const invalidated = invalidateServerRuntime(name);
  await Promise.all(invalidated.closing);
  return true;
}

/** Remove this server's registration and close every current/in-flight client.
 * The registry deletion is synchronous from callers' perspective, before any
 * asynchronous close is awaited. */
export async function unregisterMcpServer(name: string): Promise<boolean> {
  const existed = servers.has(name)
    || connections.has(name) || pending.has(name) || cooldowns.has(name);
  if (!existed) return false;
  servers.delete(name);
  const invalidated = invalidateServerRuntime(name);
  // `attempt.invalidated` plus the global monotonic token keep late work safe;
  // the per-name tombstone itself need not grow forever under CRUD churn.
  generations.delete(name);
  await Promise.all(invalidated.closing);
  return true;
}

/** Read a coarse, secret-safe snapshot for an operator UI. Configuration and
 * failure detail intentionally remain available only to the code that owns the
 * registration. */
export function getMcpServerStatus(name: string): McpServerStatus {
  const registered = servers.has(name);
  const conn = connections.get(name);
  if (conn && conn.generation === generations.get(name)) {
    return { registered, state: 'connected', toolCount: conn.tools.length };
  }
  if (pending.has(name)) return { registered, state: 'connecting' };
  const cool = cooldowns.get(name);
  if (cool) {
    if (Date.now() < cool.until) {
      return { registered, state: 'cooldown', cooldownUntil: new Date(cool.until) };
    }
    cooldowns.delete(name);
  }
  return { registered, state: 'disconnected' };
}

/** One warn per distinct message kind (separate from tools.ts's own latch). */
const warnedMcpKinds = new Set<string>();
export function warnMcp(message: string): void {
  const kind = message.slice(0, 40);
  if (warnedMcpKinds.has(kind)) return;
  warnedMcpKinds.add(kind);
  console.warn(`[10thfloor:agent] ${message}`);
}

/** Non-text content becomes a `[type content omitted]` marker. */
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

/** Map an MCP call result to ToolResult. Errors are sanitized. */
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

/** Call one tool on one server. Failures are structured, never throws. */
export async function callMcpTool(
  server: string, tool: string, args: unknown,
  authorize?: () => boolean | Promise<boolean>,
  displayName = tool,
): Promise<ToolResult> {
  const c = await connect(server);
  if (!c.ok) return { ok: false, error: { error: 'mcp-unavailable', reason: c.reason } };

  // Connecting may start a subprocess, perform initialization, and discover
  // tools. Re-read the host entitlement after all of that awaited setup and
  // immediately before the external tools/call side effect. A callback error
  // fails closed and is deliberately not exposed.
  if (authorize) {
    let allowed = false;
    try { allowed = (await authorize()) === true; } catch { /* fail closed */ }
    if (!allowed) {
      return {
        ok: false,
        error: { error: 'not-allowed', reason: `This agent may not use ${displayName}.` },
      };
    }
  }

  const params = {
    name: tool,
    arguments: (args && typeof args === 'object' && !Array.isArray(args))
      ? args as Record<string, unknown>
      : {},
  };
  try {
    return mapMcpResult(await c.conn.client.callTool(params));
  } catch (e) {
    // Transport failure — drop the connection so the next call reconnects.
    dropConnection(server, c.conn);
    return { ok: false, error: { error: 'mcp-unavailable', reason: unavailable(server, e) } };
  }
}

/** Close every current and in-flight client. Registrations remain available so
 * a long-lived process can reconnect after a coordinated runtime stop. */
export async function stopMcp(): Promise<void> {
  await Promise.all(invalidateAllRuntime());
}

/** Test seam: replace the client factory. null restores the default.
 *  Snapshots and restores server definitions so test registrations don't leak. */
export function _setMcpClientFactory(next: McpClientFactory | null): () => void {
  const previous = factory;
  const previousServers = new Map(servers);
  void Promise.all(invalidateAllRuntime());
  factory = next ?? defaultFactory;
  return () => {
    void Promise.all(invalidateAllRuntime());
    servers.clear();
    for (const [name, def] of previousServers) servers.set(name, def);
    factory = previous;
  };
}
