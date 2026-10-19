import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A small, stateless MCP surface for exposing an explicitly selected slice of
 * a Constellation. Authentication and target resolution are re-checked at the
 * dispatch boundary, so disabling, rotating, archiving, or changing the
 * allowlist revokes the next call without restarting the server. */

export const FEDERATION_MCP_PATH = '/constellation/mcp';
export const FEDERATION_PROTOCOL_VERSION = '2025-11-25';
export const FEDERATION_PROMPT_MAX = 50_000;
export const FEDERATION_BODY_MAX = 1024 * 1024;

export interface FederationGrant {
  ownerId: string;
  agentIds: string[];
  missionIds: string[];
  revision: number;
}

export interface FederationTarget {
  kind: 'agent' | 'mission';
  id: string;
  displayName: string;
  description?: string;
}

export interface FederationDependencies {
  /** Return null for disabled, expired, rotated, malformed, or unknown tokens. */
  resolveGrant(token: string): Promise<FederationGrant | null>;
  /** Resolve only targets which are still active and owned by the grant owner. */
  resolveTargets(grant: FederationGrant): Promise<FederationTarget[]>;
  invoke(target: FederationTarget, prompt: string, grant: FederationGrant): Promise<string>;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | {
    jsonrpc: '2.0'; id: string | number | null;
    error: { code: number; message: string };
  };

export interface FederationDispatchResult {
  status: number;
  response?: JsonRpcResponse;
}

export function hashFederationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueFederationToken(): { token: string; tokenHash: string; tokenHint: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashFederationToken(token), tokenHint: token.slice(-6) };
}

export function federationTokenMatches(token: string, expectedHash: string): boolean {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(token)
    || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashFederationToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isLoopbackAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase().split('%')[0];
  return normalized === '::1'
    || normalized === '127.0.0.1'
    || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.');
}

function cleanSegment(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (slug || 'target').slice(0, 40);
}

/** Stable and collision-resistant even when two display/runtime ids slugify to
 * the same MCP name. The hash is an identifier checksum, not a credential. */
export function federationToolName(target: Pick<FederationTarget, 'kind' | 'id'>): string {
  const digest = createHash('sha256').update(`${target.kind}:${target.id}`).digest('hex').slice(0, 8);
  return `${target.kind === 'agent' ? 'ask' : 'continue'}_${cleanSegment(target.id)}_${digest}`;
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function validRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Partial<JsonRpcRequest>;
  return request.jsonrpc === '2.0'
    && typeof request.method === 'string'
    && (request.id === undefined || request.id === null
      || typeof request.id === 'string' || typeof request.id === 'number');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function publicDescription(target: FederationTarget): string {
  const clean = typeof target.description === 'string'
    ? target.description.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300)
    : '';
  if (clean) return clean;
  return target.kind === 'agent'
    ? `Ask ${target.displayName} to complete one bounded task.`
    : `Continue ${target.displayName} with one message.`;
}

function listTools(targets: FederationTarget[]): unknown[] {
  return targets.map((target) => ({
    name: federationToolName(target),
    title: target.displayName,
    description: publicDescription(target),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: FEDERATION_PROMPT_MAX },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: {
      title: target.displayName,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }));
}

function resourceUri(target: FederationTarget): string {
  return `constellation://${target.kind}/${encodeURIComponent(target.id)}`;
}

function listResources(targets: FederationTarget[]): unknown[] {
  return targets.map((target) => ({
    uri: resourceUri(target),
    name: target.displayName,
    description: publicDescription(target),
    mimeType: 'text/markdown',
  }));
}

function resourceText(target: FederationTarget): string {
  return [
    `# ${target.displayName}`,
    '',
    `Type: ${target.kind === 'agent' ? 'Agent' : 'Mission'}`,
    '',
    publicDescription(target),
    '',
    `Callable tool: ${federationToolName(target)}`,
  ].join('\n');
}

async function currentAuthorization(
  token: string, dependencies: FederationDependencies,
): Promise<{ grant: FederationGrant; targets: FederationTarget[] } | null> {
  let grant: FederationGrant | null = null;
  try { grant = await dependencies.resolveGrant(token); } catch { /* fail closed */ }
  if (!grant) return null;
  let targets: FederationTarget[] = [];
  try { targets = await dependencies.resolveTargets(grant); } catch { return null; }
  // Resolver output is defense-in-depth intersected with the durable grant.
  const allowedAgents = new Set(grant.agentIds);
  const allowedMissions = new Set(grant.missionIds);
  return {
    grant,
    targets: targets.filter((target) => (
      target.kind === 'agent' ? allowedAgents.has(target.id) : allowedMissions.has(target.id)
    )),
  };
}

/** Process one stateless MCP JSON-RPC message. The bearer is re-resolved for
 * tools/call after all catalog/setup work and immediately before invocation. */
export async function dispatchFederationMcp(
  bearerToken: string,
  rawRequest: unknown,
  dependencies: FederationDependencies,
): Promise<FederationDispatchResult> {
  if (!validRequest(rawRequest)) {
    return { status: 400, response: rpcError(null, -32600, 'Invalid request.') };
  }
  const request = rawRequest;
  const authorized = await currentAuthorization(bearerToken, dependencies);
  if (!authorized) {
    return { status: 401, response: rpcError(request.id, -32001, 'Unauthorized.') };
  }

  // Notifications have no response body. Unknown notifications are ignored as
  // required by JSON-RPC; known initialization notification needs no state in
  // this stateless transport.
  const notification = request.id === undefined;
  if (notification) return { status: 202 };

  if (request.method === 'initialize') {
    return {
      status: 200,
      response: rpcResult(request.id, {
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: 'Constellation Federation', version: '1.0.0' },
        instructions: 'Only the Agents and Missions explicitly shared by this workspace are available.',
      }),
    };
  }
  if (request.method === 'ping') return { status: 200, response: rpcResult(request.id, {}) };
  if (request.method === 'tools/list') {
    return {
      status: 200,
      response: rpcResult(request.id, { tools: listTools(authorized.targets) }),
    };
  }
  if (request.method === 'resources/list') {
    return {
      status: 200,
      response: rpcResult(request.id, { resources: listResources(authorized.targets) }),
    };
  }
  if (request.method === 'resources/read') {
    const params = asObject(request.params);
    const uri = params?.uri;
    if (typeof uri !== 'string') {
      return { status: 200, response: rpcError(request.id, -32602, 'Resource URI is required.') };
    }
    const target = authorized.targets.find((candidate) => resourceUri(candidate) === uri);
    if (!target) {
      return { status: 200, response: rpcError(request.id, -32002, 'Resource not found.') };
    }
    return {
      status: 200,
      response: rpcResult(request.id, {
        contents: [{ uri, mimeType: 'text/markdown', text: resourceText(target) }],
      }),
    };
  }
  if (request.method === 'prompts/list') {
    return { status: 200, response: rpcResult(request.id, { prompts: [] }) };
  }
  if (request.method === 'tools/call') {
    const params = asObject(request.params);
    const args = asObject(params?.arguments);
    const name = params?.name;
    const prompt = args?.prompt;
    if (typeof name !== 'string' || typeof prompt !== 'string'
      || !prompt.trim() || prompt.length > FEDERATION_PROMPT_MAX
      || Object.keys(args ?? {}).some((key) => key !== 'prompt')) {
      return { status: 200, response: rpcError(request.id, -32602, 'Valid name and prompt are required.') };
    }

    // Re-read token generation, enabled state, allowlists, ownership, and live
    // target state immediately before the only side effect in this module.
    const fresh = await currentAuthorization(bearerToken, dependencies);
    const target = fresh?.targets.find((candidate) => federationToolName(candidate) === name);
    if (!fresh || !target) {
      return { status: 401, response: rpcError(request.id, -32001, 'Unauthorized.') };
    }
    try {
      const answer = await dependencies.invoke(target, prompt.trim(), fresh.grant);
      return {
        status: 200,
        response: rpcResult(request.id, {
          content: [{ type: 'text', text: String(answer).slice(0, FEDERATION_PROMPT_MAX) }],
          isError: false,
        }),
      };
    } catch {
      return {
        status: 200,
        response: rpcResult(request.id, {
          content: [{ type: 'text', text: 'The selected target could not complete the request.' }],
          isError: true,
        }),
      };
    }
  }

  return { status: 200, response: rpcError(request.id, -32601, 'Method not found.') };
}
