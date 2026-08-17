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
export const MCP_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * How long a failed open suppresses the next spawn attempt.
 *
 * NOT a negative cache of the RESULT — the unavailable answer the caller gets
 * during the window is regenerated from the recorded reason, and the window
 * expires on its own with no successful connect required to clear it. A success
 * clears it immediately. The distinction matters: M2's catalog cache remembered
 * a failure with no expiry, so one outage broke an agent until a redeploy.
 */
export const MCP_FAILURE_COOLDOWN_MS = 30_000;

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
 *
 * `listTools` takes the SDK's SECOND argument here — `params` first, `options`
 * second — because that is where the request `timeout` lives. Both are optional,
 * so a fake that declares `async listTools()` still satisfies this.
 */
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
  for (const field of ['timeoutMs', 'cooldownMs'] as const) {
    const v = def[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new Error(
        `[10thfloor:agent] Agent.mcpServer('${name}'): ${field} must be a non-negative number`,
      );
    }
  }
  if (servers.has(name)) dropConnection(name);
  // A redefinition is an operator SAYING they fixed it, so it clears the
  // cooldown as well as the connection: waiting out a 30s window after editing
  // the command would be a baffling dev-server experience.
  cooldowns.delete(name);
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
 * (`DEFAULT_INHERITED_ENV_VARS` — PATH, HOME and friends).
 *
 * CORRECTION (M2 review): the installed SDK ALREADY merges. `dist/esm/client/
 * stdio.js` (1.30.0) spawns with `env: { ...getDefaultEnvironment(),
 * ...this._serverParams.env }`, so passing `{ API_KEY: … }` alone does NOT
 * strip PATH today. An earlier note here claimed the SDK used `env` INSTEAD of
 * the defaults; that was wrong.
 *
 * The merge stays anyway, as INSURANCE, not as a fix: it is two lines, it is
 * idempotent against the SDK's own merge (same keys, same precedence — ours
 * wins in both), and the failure it guards against is a silent one. If a future
 * SDK version stops merging, a server spawned with no PATH surfaces as a
 * baffling ENOENT with nothing pointing at the cause.
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
    listTools: (params?: any, options?: any) => client.listTools(params, options),
    callTool: (params: any) => client.callTool(params),
    close: () => client.close(),
  };
};

let factory: McpClientFactory = defaultFactory;

const connections = new Map<string, Connection>();
const pending = new Map<string, Promise<Connection>>();
/** Per-server failure cooldowns: the wall-clock instant the next spawn attempt
 *  is allowed, and the reason to answer with until then. See
 *  `MCP_FAILURE_COOLDOWN_MS` for why this is a cooldown and not a cache. */
const cooldowns = new Map<string, { until: number; reason: string }>();

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

async function openConnection(name: string, def: McpServerDef): Promise<Connection> {
  const budget = budgetFor(def);
  const started = factory(name, def);
  let abandoned = false;
  // A factory that answers AFTER the deadline has already spawned a subprocess
  // nobody will ever read from. Close it rather than leak a child for the life
  // of the process. The rejection arm is swallowed: the deadline (or the await
  // below) is what reports the failure.
  void started.then(
    (late) => { if (abandoned) closeQuietly(late); },
    () => { /* reported by the await below */ },
  );

  let client: McpClient;
  try {
    client = await withDeadline(started, budget, `the MCP server "${name}" did not connect`);
  } catch (e) {
    abandoned = true;
    throw e;
  }

  try {
    // Discovery is part of CONNECTING, not a separately cached thing. A client
    // whose `tools/list` failed is a client this package cannot use, and
    // keeping it would leave a connection whose catalog is permanently empty.
    //
    // The budget is passed BOTH ways on purpose. `{ timeout }` is the SDK's own
    // per-request option (its default is 60s), and it is the one that actually
    // cancels the in-flight request and frees the SDK's bookkeeping. The outer
    // `withDeadline` is insurance for a client that ignores the option — an
    // injected fake, or an SDK whose option moves — so this call can never be
    // the thing that hangs a turn.
    const listed = await withDeadline(
      Promise.resolve(client.listTools(undefined, { timeout: budget })),
      budget,
      `the MCP server "${name}" did not list its tools`,
    );
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
 * single in-flight attempt; a SUCCESS is cached for the process; a FAILURE
 * starts a bounded COOLDOWN and is otherwise not remembered.
 *
 * The cooldown is what keeps a dead server from costing a spawn, a deadline and
 * (with `expandMcpTools` running every turn) a multi-second stall on every
 * single tool call — while still expiring on its own, with no successful
 * connect needed to clear it. See `MCP_FAILURE_COOLDOWN_MS` for the difference
 * from the M2 catalog cache this deliberately is not.
 */
async function connect(name: string): Promise<ConnectResult> {
  const hit = connections.get(name);
  if (hit) return { ok: true, conn: hit };
  const def = servers.get(name);
  if (!def) return { ok: false, reason: `No MCP server named "${name}" is registered.` };

  const cool = cooldowns.get(name);
  if (cool) {
    if (Date.now() < cool.until) return { ok: false, reason: cool.reason };
    // Expired: forget it BEFORE retrying, so the retry's own outcome — success
    // or a fresh cooldown — is the only thing that decides what happens next.
    cooldowns.delete(name);
  }

  let attempt = pending.get(name);
  if (!attempt) {
    attempt = openConnection(name, def);
    pending.set(name, attempt);
  }
  try {
    const conn = await attempt;
    connections.set(name, conn);
    // A success clears the cooldown outright — including one another concurrent
    // attempt may have written while this one was in flight.
    cooldowns.delete(name);
    return { ok: true, conn };
  } catch (e) {
    const reason = unavailable(name, e);
    const cooldownMs = def.cooldownMs ?? MCP_FAILURE_COOLDOWN_MS;
    if (cooldownMs > 0) cooldowns.set(name, { until: Date.now() + cooldownMs, reason });
    return { ok: false, reason };
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
 *  connection; a failure is remembered only as a bounded cooldown. */
export async function discoverMcpTools(server: string): Promise<DiscoveryResult> {
  const c = await connect(server);
  return c.ok ? { ok: true, tools: c.conn.tools } : { ok: false, reason: c.reason };
}

/**
 * One warn PER DISTINCT MESSAGE KIND, for MCP.
 *
 * A private latch, NOT `tools.ts`'s `warnUnavailable`. That one also flips the
 * module-level `warnedUnavailable` flag which `setToolArgsValidator` and
 * `setTypeboxValueLoader` snapshot and restore — validator state. An MCP server
 * being down has nothing to do with whether a validator is installed, and
 * letting MCP write that flag makes the validator suite's warn-once assertions
 * depend on unrelated MCP noise. Same per-kind `Set` pattern, separate Set.
 *
 * Keyed on the message's stable 40-character prefix, so a variable error suffix
 * does not defeat the latch — put the server and tool name EARLY in a message
 * that needs to distinguish one server from another.
 */
const warnedMcpKinds = new Set<string>();
export function warnMcp(message: string): void {
  const kind = message.slice(0, 40);
  if (warnedMcpKinds.has(kind)) return;
  warnedMcpKinds.add(kind);
  console.warn(`[10thfloor:agent] ${message}`);
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
 * `mcp-unavailable` for a server that could not be reached (retried once the
 * failure cooldown expires — nothing is cached as a verdict), `mcp-tool-failed`
 * for a server that answered `isError`.
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
  cooldowns.clear();
  await Promise.all(open.map(async (conn) => {
    try { await conn.client.close(); } catch { /* best effort */ }
  }));
}

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
export function _setMcpClientFactory(next: McpClientFactory | null): () => void {
  const previous = factory;
  const previousServers = new Map(servers);
  const open = [...connections.values()];
  connections.clear();
  pending.clear();
  cooldowns.clear();
  for (const conn of open) closeQuietly(conn.client);
  factory = next ?? defaultFactory;
  return () => {
    const live = [...connections.values()];
    connections.clear();
    pending.clear();
    cooldowns.clear();
    for (const conn of live) closeQuietly(conn.client);
    servers.clear();
    for (const [name, def] of previousServers) servers.set(name, def);
    factory = previous;
  };
}
