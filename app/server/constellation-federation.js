import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Mongo } from 'meteor/mongo';
import { WebApp } from 'meteor/webapp';
import {
  Agent,
  AgentSessions,
  FEDERATION_BODY_MAX,
  FEDERATION_MCP_PATH,
  dispatchFederationMcp,
  discoverMcpPrompts,
  discoverMcpResources,
  federationTokenMatches,
  getMcpPrompt,
  getMcpServerStatus,
  isLoopbackAddress,
  issueFederationToken,
  readMcpResource,
} from 'meteor/10thfloor:agent';

// Name is part of the client/publication contract; the secret hash lives in the
// same server-owned row but is excluded from every publication.
export const FederationConfigs = new Mongo.Collection('constellation_federation');

FederationConfigs.deny({ insert: () => true, update: () => true, remove: () => true });

const CONFIG_ID = 'current';
const AGENT_LIMIT = 12;
const MISSION_LIMIT = 24;

function invalid(reason) {
  throw new Meteor.Error('invalid-federation', reason);
}

function cleanIds(value, label, limit) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) invalid(`${label} selection is invalid.`);
  const ids = value.map((id) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 128
      || /[\u0000-\u001f\u007f]/.test(id)) invalid(`${label} selection is invalid.`);
    return id.trim();
  });
  return [...new Set(ids)];
}

function publicConfig(row) {
  return {
    _id: CONFIG_ID,
    enabled: row.enabled === true,
    agentIds: row.agentIds ?? [],
    missionIds: row.missionIds ?? [],
    endpoint: row.endpoint ?? Meteor.absoluteUrl(FEDERATION_MCP_PATH.replace(/^\//, '')),
    tokenHint: row.tokenHint ?? null,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
  };
}

async function ensureConfig(userId) {
  let row = await FederationConfigs.findOneAsync({ _id: CONFIG_ID, userId });
  const endpoint = Meteor.absoluteUrl(FEDERATION_MCP_PATH.replace(/^\//, ''));
  if (row) {
    if (row.endpoint !== endpoint) {
      await FederationConfigs.updateAsync(
        { _id: CONFIG_ID, userId }, { $set: { endpoint } },
      );
      row = { ...row, endpoint };
    }
    return row;
  }
  const at = new Date();
  try {
    await FederationConfigs.insertAsync({
      _id: CONFIG_ID,
      userId,
      enabled: false,
      agentIds: [],
      missionIds: [],
      tokenHash: null,
      tokenHint: null,
      endpoint,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
  } catch {
    // The local workspace singleton may have been initialized concurrently.
  }
  row = await FederationConfigs.findOneAsync({ _id: CONFIG_ID, userId });
  if (!row) throw new Meteor.Error('federation-unavailable', 'Federation is unavailable.');
  return row;
}

async function validateTargets({ CrewConfigs, MissionConfigs, userId, agentIds, missionIds }) {
  const [agents, missions, sessions] = await Promise.all([
    CrewConfigs.find({
      userId,
      agent: { $in: agentIds },
      enabled: true,
      status: { $ne: 'archived' },
    }, { fields: { agent: 1 } }).fetchAsync(),
    MissionConfigs.find({
      userId,
      _id: { $in: missionIds },
      status: 'active',
    }, { fields: { _id: 1 } }).fetchAsync(),
    AgentSessions.find({
      userId,
      _id: { $in: missionIds },
      agent: 'orchestrator',
      erasingAt: { $exists: false },
    }, { fields: { _id: 1 } }).fetchAsync(),
  ]);
  const availableAgents = new Set(agents.map((row) => row.agent));
  const availableMissions = new Set(missions.map((row) => row._id));
  const availableSessions = new Set(sessions.map((row) => row._id));
  if (agentIds.some((id) => !availableAgents.has(id))) {
    throw new Meteor.Error('federation-agent-unavailable', 'A selected Agent is unavailable.');
  }
  if (missionIds.some((id) => !availableMissions.has(id) || !availableSessions.has(id))) {
    throw new Meteor.Error('federation-mission-unavailable', 'A selected Mission is not active.');
  }
}

function bearerFrom(headers) {
  const raw = headers?.authorization;
  if (typeof raw !== 'string') return '';
  const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(raw);
  return match?.[1] ?? '';
}

class BodyTooLarge extends Error {}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > FEDERATION_BODY_MAX) {
        reject(new BodyTooLarge());
        if (typeof req.resume === 'function') req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > FEDERATION_BODY_MAX) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new SyntaxError('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function mountRoute(handlers, dependencies) {
  handlers.use(FEDERATION_MCP_PATH, (req, res, next) => {
    const suffix = String(req.url ?? '').split('?')[0];
    if (suffix !== '/' && suffix !== '') { next(); return; }
    void (async () => {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: 'loopback-only' });
        if (typeof req.resume === 'function') req.resume();
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        sendJson(res, 405, { error: 'method-not-allowed' });
        if (typeof req.resume === 'function') req.resume();
        return;
      }
      const token = bearerFrom(req.headers);
      if (!token) {
        res.setHeader('www-authenticate', 'Bearer');
        sendJson(res, 401, { error: 'unauthorized' });
        if (typeof req.resume === 'function') req.resume();
        return;
      }
      try {
        const request = await readJsonBody(req);
        const dispatched = await dispatchFederationMcp(token, request, dependencies);
        if (dispatched.status === 401) res.setHeader('www-authenticate', 'Bearer');
        sendJson(res, dispatched.status, dispatched.response);
      } catch (error) {
        sendJson(res, error instanceof BodyTooLarge ? 413 : 400, {
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: error instanceof BodyTooLarge ? 'Request too large.' : 'Parse error.' },
        });
      }
    })();
  });
}

let installed = false;

/** Installs the disabled-by-default local MCP endpoint and its owner-scoped
 * configuration methods. No mutation/approval surface is federated: external
 * callers can only invoke the exact live targets on the current allowlist. */
export function installConstellationFederation({
  requireUser,
  CrewConfigs,
  MissionConfigs,
  McpConfigs,
  mcpDefinition,
  mcpRuntimeName,
  webAppHandlers = WebApp.handlers,
}) {
  if (installed) return;
  if (typeof requireUser !== 'function' || !CrewConfigs || !MissionConfigs || !webAppHandlers) {
    throw new Error('[constellation] Federation installer is incomplete.');
  }
  installed = true;

  const dependencies = {
    async resolveGrant(token) {
      const row = await FederationConfigs.findOneAsync({ _id: CONFIG_ID, enabled: true });
      if (!row?.tokenHash || !federationTokenMatches(token, row.tokenHash)) return null;
      void FederationConfigs.updateAsync(
        { _id: CONFIG_ID, userId: row.userId, revision: row.revision, enabled: true },
        { $set: { lastUsedAt: new Date() } },
      );
      return {
        ownerId: row.userId,
        agentIds: [...(row.agentIds ?? [])],
        missionIds: [...(row.missionIds ?? [])],
        revision: row.revision,
      };
    },

    async resolveTargets(grant) {
      const current = await FederationConfigs.findOneAsync({
        _id: CONFIG_ID,
        userId: grant.ownerId,
        enabled: true,
        revision: grant.revision,
      });
      if (!current) return [];
      const [agents, missions, sessions] = await Promise.all([
        CrewConfigs.find({
          userId: grant.ownerId,
          agent: { $in: grant.agentIds },
          enabled: true,
          status: { $ne: 'archived' },
        }, { fields: { agent: 1, displayName: 1, role: 1, order: 1 } }).fetchAsync(),
        MissionConfigs.find({
          userId: grant.ownerId,
          _id: { $in: grant.missionIds },
          status: 'active',
        }, { fields: { _id: 1, title: 1, updatedAt: 1 } }).fetchAsync(),
        AgentSessions.find({
          userId: grant.ownerId,
          _id: { $in: grant.missionIds },
          agent: 'orchestrator',
          erasingAt: { $exists: false },
        }, { fields: { _id: 1 } }).fetchAsync(),
      ]);
      const liveSessions = new Set(sessions.map((row) => row._id));
      return [
        ...agents.sort((left, right) => (left.order ?? 0) - (right.order ?? 0)).map((row) => ({
          kind: 'agent',
          id: row.agent,
          displayName: row.displayName || row.agent,
          description: row.role ? `Ask this ${row.role} Agent to complete one bounded task.` : undefined,
        })),
        ...missions.filter((row) => liveSessions.has(row._id)).map((row) => ({
          kind: 'mission',
          id: row._id,
          displayName: row.title || 'Mission',
          description: 'Continue this active Mission with one message.',
        })),
      ];
    },

    async invoke(target, prompt, grant) {
      if (target.kind === 'agent') {
        return new Agent(target.id).ask(prompt, { userId: grant.ownerId });
      }
      return new Agent('orchestrator').send(target.id, prompt, { userId: grant.ownerId });
    },
  };

  mountRoute(webAppHandlers, dependencies);

  async function inspectableServer(userId, serverId) {
    if (!McpConfigs || typeof mcpRuntimeName !== 'function') {
      throw new Meteor.Error('mcp-content-unavailable', 'MCP content inspection is unavailable.');
    }
    const config = await McpConfigs.findOneAsync({ _id: serverId, userId });
    if (!config) throw new Meteor.Error('no-mcp', 'MCP server not found.');
    if (!config.enabled || !config.trusted || config.approval === 'blocked') {
      throw new Meteor.Error(
        'mcp-content-disabled', 'Enable and trust this MCP server before browsing its content.',
      );
    }
    const runtime = mcpRuntimeName(config._id);
    if (!getMcpServerStatus(runtime).registered) {
      if (typeof mcpDefinition !== 'function') {
        throw new Meteor.Error('mcp-content-unavailable', 'MCP runtime is unavailable.');
      }
      try {
        Agent.mcpServer(runtime, await mcpDefinition(config));
      } catch {
        throw new Meteor.Error('mcp-content-unavailable', 'MCP runtime is unavailable.');
      }
    }
    const authorize = async () => {
      const live = await McpConfigs.findOneAsync({ _id: serverId, userId });
      return !!live?.enabled && !!live?.trusted && live.approval !== 'blocked';
    };
    return { runtime, authorize };
  }

  function unwrapMcpContent(result) {
    if (result.ok) return result;
    throw new Meteor.Error(result.error, result.reason);
  }

  Meteor.publish('constellation.federation', async function publishFederation() {
    if (!this.userId) return this.ready();
    await requireUser(this.userId);
    await ensureConfig(this.userId);
    return FederationConfigs.find(
      { _id: CONFIG_ID, userId: this.userId },
      { fields: { userId: 0, tokenHash: 0 } },
    );
  });

  Meteor.methods({
    async 'constellation.mcpResources'({ serverId }) {
      check(serverId, String);
      await requireUser(this.userId);
      const server = await inspectableServer(this.userId, serverId);
      const result = unwrapMcpContent(
        await discoverMcpResources(server.runtime, server.authorize),
      );
      return { resources: result.resources };
    },

    async 'constellation.mcpReadResource'({ serverId, uri }) {
      check(serverId, String);
      check(uri, String);
      await requireUser(this.userId);
      const server = await inspectableServer(this.userId, serverId);
      const result = unwrapMcpContent(
        await readMcpResource(server.runtime, uri, server.authorize),
      );
      return { contents: result.contents };
    },

    async 'constellation.mcpPrompts'({ serverId }) {
      check(serverId, String);
      await requireUser(this.userId);
      const server = await inspectableServer(this.userId, serverId);
      const result = unwrapMcpContent(
        await discoverMcpPrompts(server.runtime, server.authorize),
      );
      return { prompts: result.prompts };
    },

    async 'constellation.mcpGetPrompt'({ serverId, name, args }) {
      check(serverId, String);
      check(name, String);
      if (args !== undefined) check(args, Object);
      await requireUser(this.userId);
      const server = await inspectableServer(this.userId, serverId);
      const result = unwrapMcpContent(
        await getMcpPrompt(server.runtime, name, args ?? {}, server.authorize),
      );
      return {
        ...(result.description ? { description: result.description } : {}),
        messages: result.messages,
      };
    },

    async 'constellation.federationConfigure'(input) {
      check(input, Object);
      await requireUser(this.userId);
      const row = await ensureConfig(this.userId);
      const agentIds = cleanIds(input.agentIds, 'Agent', AGENT_LIMIT);
      const missionIds = cleanIds(input.missionIds, 'Mission', MISSION_LIMIT);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
        invalid('Enabled state is invalid.');
      }
      const enabled = input.enabled ?? row.enabled;
      if (enabled && !row.tokenHash) {
        throw new Meteor.Error('federation-token-required', 'Create an access token before enabling federation.');
      }
      if (enabled && agentIds.length + missionIds.length === 0) {
        invalid('Select at least one Agent or Mission before enabling federation.');
      }
      if (input.expectedRevision !== undefined
        && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== row.revision)) {
        throw new Meteor.Error('stale-federation', 'Federation changed in another window.');
      }
      await validateTargets({ CrewConfigs, MissionConfigs, userId: this.userId, agentIds, missionIds });
      const at = new Date();
      const changed = await FederationConfigs.updateAsync(
        { _id: CONFIG_ID, userId: this.userId, revision: row.revision },
        {
          $set: { enabled, agentIds, missionIds, updatedAt: at },
          $inc: { revision: 1 },
        },
      );
      if (changed !== 1) throw new Meteor.Error('stale-federation', 'Federation changed in another window.');
      return publicConfig({
        ...row, enabled, agentIds, missionIds, revision: row.revision + 1, updatedAt: at,
      });
    },

    async 'constellation.federationRotateToken'() {
      await requireUser(this.userId);
      const row = await ensureConfig(this.userId);
      const issued = issueFederationToken();
      const at = new Date();
      const changed = await FederationConfigs.updateAsync(
        { _id: CONFIG_ID, userId: this.userId, revision: row.revision },
        {
          $set: {
            tokenHash: issued.tokenHash,
            tokenHint: issued.tokenHint,
            tokenIssuedAt: at,
            updatedAt: at,
          },
          $inc: { revision: 1 },
        },
      );
      if (changed !== 1) throw new Meteor.Error('stale-federation', 'Federation changed in another window.');
      return { token: issued.token, tokenHint: issued.tokenHint, endpoint: row.endpoint };
    },

    async 'constellation.federationRevoke'() {
      await requireUser(this.userId);
      const row = await ensureConfig(this.userId);
      const at = new Date();
      const changed = await FederationConfigs.updateAsync(
        { _id: CONFIG_ID, userId: this.userId, revision: row.revision },
        {
          $set: { enabled: false, tokenHash: null, tokenHint: null, updatedAt: at },
          $unset: { tokenIssuedAt: '' },
          $inc: { revision: 1 },
        },
      );
      if (changed !== 1) throw new Meteor.Error('stale-federation', 'Federation changed in another window.');
      return true;
    },
  });
}
