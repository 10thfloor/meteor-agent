import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { createHash } from 'node:crypto';
import { AgentMessages, AgentSessions, AgentTraces, AgentTraceSpans } from 'meteor/10thfloor:agent';
import {
  DECISION_TOOL_NAMES, DECISION_DEFAULT_LIMITS, DECISION_DEFAULT_POLICY, DecisionValidationError,
  decisionObject, decisionText, decisionJson, normalizeDecisionNode,
  normalizeDecisionLimits, normalizeDecisionPolicy, normalizeDecisionState,
  validateDecisionResponse, decisionAssertions, decisionAnswerLabel,
} from '../imports/constellation/decisions';
import { estimateDecisionCost } from '../imports/constellation/decision-costs';
import { publishDecisionMissionUsage } from './constellation-decision-usage';

export const DecisionNodes = new Mongo.Collection('constellation_decision_nodes', { _preventAutopublish: true });
export const DecisionVersions = new Mongo.Collection('constellation_decision_versions', { _preventAutopublish: true });
export const DecisionRuns = new Mongo.Collection('constellation_decision_runs', { _preventAutopublish: true });
export const DecisionSettings = new Mongo.Collection('constellation_decision_settings', { _preventAutopublish: true });
export const DecisionSecrets = new Mongo.Collection('constellation_decision_secrets', { _preventAutopublish: true });
export const DecisionBudgets = new Mongo.Collection('constellation_decision_budgets', { _preventAutopublish: true });
for (const collection of [DecisionNodes, DecisionVersions, DecisionRuns, DecisionSettings, DecisionSecrets, DecisionBudgets]) collection.deny({ insert: () => true, update: () => true, remove: () => true });

let indexesReady;
function ensureDecisionIndexes() {
  return (indexesReady ??= Promise.all([
    DecisionNodes.rawCollection().createIndex({ userId: 1, status: 1, updatedAt: -1 }),
    DecisionNodes.rawCollection().createIndex({ userId: 1, missionId: 1, status: 1 }),
    DecisionNodes.rawCollection().createIndex({ 'continuation.sessionId': 1, 'continuation.status': 1 }),
    DecisionNodes.rawCollection().createIndex({ 'continuation.missionId': 1, 'continuation.status': 1 }),
    DecisionNodes.rawCollection().createIndex({ userId: 1, creationRequest: 1 }, { unique: true, partialFilterExpression: { creationRequest: { $type: 'string' } } }),
    DecisionVersions.rawCollection().createIndex({ userId: 1, nodeId: 1, revision: -1 }),
    DecisionRuns.rawCollection().createIndex({ userId: 1, nodeId: 1, createdAt: -1 }),
    DecisionRuns.rawCollection().createIndex({ userId: 1, missionId: 1, createdAt: -1 }),
    DecisionRuns.rawCollection().createIndex({ status: 1 }),
    DecisionBudgets.rawCollection().createIndex({ userId: 1, missionId: 1 }),
  ]));
}

const safeFailure = Symbol('decision-safe-failure');
const fail = (code, reason) => { const error = new Meteor.Error(code, reason); error[safeFailure] = true; throw error; };
const clone = (value) => JSON.parse(JSON.stringify(value));
const revision = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid-decision', 'Choose a saved decision revision.');
  return value;
};
const safeError = (error) => {
  if (error?.[safeFailure] || error instanceof DecisionValidationError) return { code: error.error, reason: error.reason };
  const hostReasons = { 'not-authorized': 'Sign in to manage decisions.', 'mission-inactive': 'Activate this mission before running a decision.',
    'mission-stopped': 'The mission is stopped. Send a message in its chat to continue.',
    'agent-unavailable': 'This agent is no longer active on the mission.', 'workflow-cancelled': 'This plan run was cancelled.',
    'workflow-not-running': 'The plan run is no longer active.', 'workflow-inactive': 'The plan run is no longer active.',
    'workflow-budget': 'The plan run reached its execution limit.', 'workflow-unavailable': 'The plan run is no longer available.' };
  return hostReasons[error?.error] ? { code: error.error, reason: hostReasons[error.error] }
    : { code: 'decision-failed', reason: 'The decision could not finish. Check the connection and try again.' };
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requiredRequestKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,239}$/.test(value)) {
    fail('decision-request-id-required', 'This request needs a valid request ID. Reopen Decisions and try again.');
  }
  return value;
}

/** Only documented rate-limit responses are retried. Unknown network outcomes
 * are never replayed automatically; a new user request is a separate audit row. */
export async function requestTypeSafe({ apiKey, definition, state, beforeAttempt = async () => {}, signal,
  fetchImpl = globalThis.fetch, timeoutMs = 30_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await beforeAttempt(attempt);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) fail('decision-cancelled', 'This decision was cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: definition.model, questions: definition.questions, state }),
      });
      if ([429, 529].includes(response.status)) {
        // Do not copy provider bodies to clients/logs: they may echo context.
        await response.body?.cancel();
        if (attempt === 0) { await sleep(500); continue; }
        fail('decision-provider-busy', 'TypeSafe is busy. Try again shortly.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) fail('decision-key-rejected', 'TypeSafe rejected the API key. Update it in Decisions settings.');
        if (response.status === 422) fail('decision-provider-validation', 'TypeSafe rejected this question or input. Review the decision definition.');
        fail('decision-provider-error', 'TypeSafe could not complete this request. Try again later.');
      }
      const reader = response.body?.getReader();
      let raw = '';
      if (reader) {
        const decoder = new TextDecoder(); let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 512_000) { await reader.cancel(); fail('decision-response-too-large', 'TypeSafe returned more data than this decision allows.'); }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } else raw = await response.text();
      try { return validateDecisionResponse(JSON.parse(raw), definition); }
      catch { fail('decision-invalid-response', 'TypeSafe returned an unexpected result. No action was authorized.'); }
    } catch (error) {
      if (error?.[safeFailure]) throw error;
      if (controller.signal.aborted) fail(signal?.aborted ? 'decision-cancelled' : 'decision-timeout', signal?.aborted ? 'This decision was cancelled.' : 'TypeSafe timed out. Its result is unknown; it was not retried.');
      fail('decision-network-error', 'TypeSafe could not be reached. Its result is unknown; it was not retried.');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  return undefined;
}

/** All agent tools, UI methods and workflows meet at this authority boundary. */
export function createConstellationDecisionService(host, { adapter = requestTypeSafe } = {}) {
  const { requireUser, CrewConfigs, missionAllowsAgent, requireActiveMissionExecution } = host;
  const locks = new Map();
  const locked = async (key, operation) => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  };
  const owner = async (userId) => {
    if (!userId) fail('not-authorized', 'Sign in to manage decisions.');
    await requireUser(userId); await ensureDecisionIndexes(); return userId;
  };
  const rootMission = async (context) => {
    const sessionId = context.sessionId ?? context.missionId;
    if (!sessionId) return null;
    let session = host.rootMissionSession ? await host.rootMissionSession(sessionId) : await AgentSessions.findOneAsync(sessionId);
    if (!host.rootMissionSession) for (let depth = 0; session?.parent?.sessionId && depth < 8; depth += 1) session = await AgentSessions.findOneAsync(session.parent.sessionId);
    if (!session || session.userId !== context.userId || session.agent !== 'orchestrator' || session.erasingAt) fail('decision-mission-unavailable', 'This mission is no longer available.');
    return session;
  };
  const getSettings = async (userId) => {
    await owner(userId);
    let settings = await DecisionSettings.findOneAsync(userId);
    if (!settings) {
      await DecisionSettings.upsertAsync(userId, { $setOnInsert: { userId, enabled: false, limits: { ...DECISION_DEFAULT_LIMITS }, agentPolicies: {}, createdAt: new Date(), updatedAt: new Date() } });
      settings = await DecisionSettings.findOneAsync(userId);
    }
    const secret = await DecisionSecrets.findOneAsync(userId);
    const environment = !!process.env.TYPESAFE_API_KEY?.trim();
    const keySource = secret?.box ? 'saved' : environment ? 'shell' : null;
    const providerConfigured = !!keySource;
    const canStoreSecret = host.canStoreSecret?.() === true;
    if (settings.providerConfigured !== providerConfigured || settings.keySource !== keySource || settings.canStoreSecret !== canStoreSecret) {
      await DecisionSettings.updateAsync(userId, { $set: { providerConfigured, keySource, canStoreSecret } });
    }
    return { ...settings, providerConfigured, keySource, canStoreSecret };
  };
  const getPolicy = async (userId, agent) => {
    const settings = await getSettings(userId);
    return { ...DECISION_DEFAULT_POLICY, ...settings.agentPolicies?.[agent] };
  };
  const active = async (context) => {
    await owner(context.userId);
    const root = await rootMission(context);
    if (context.agent) {
      if (!root) fail('decision-mission-required', 'Agents may use decisions only inside a mission.');
      const row = await CrewConfigs.findOneAsync({ userId: context.userId, agent: context.agent, enabled: true, status: { $ne: 'archived' } });
      if (!row || !await missionAllowsAgent({ userId: context.userId, sessionId: context.sessionId ?? root._id }, context.agent)) fail('decision-agent-unavailable', 'This agent no longer has access to the mission.');
    }
    if (root) await requireActiveMissionExecution(context.sessionId ?? root._id, context.agent);
    await context.assertActive?.();
    if (context.signal?.aborted) fail('decision-cancelled', 'This decision was cancelled.');
    return root;
  };
  const mayUse = async (context) => {
    const root = await active(context);
    const settings = await getSettings(context.userId);
    if (!settings.enabled) fail('decisions-disabled', 'Enable Decisions in its connection settings first.');
    if (context.agent && !(await getPolicy(context.userId, context.agent)).use) fail('decision-access-denied', 'Decision access is disabled for this agent.');
    return { root, settings };
  };
  const resolveNode = async (context, nodeId, expectedRevision) => {
    await owner(context.userId);
    const root = await rootMission(context);
    const node = await DecisionNodes.findOneAsync({ _id: decisionText(nodeId, 'Decision', 120), userId: context.userId, status: { $ne: 'archived' } });
    if (!node || (node.scope === 'mission' && root?._id !== node.missionId)) fail('decision-not-found', 'This decision is not available in this mission.');
    if (expectedRevision !== undefined && node.revision !== revision(expectedRevision)) fail('decision-revision-changed', 'This decision changed. Review its latest revision before running it.');
    if (context.agent) {
      await mayUse(context);
      if (!node.enabled || node.status !== 'active' || !node.agentIds.includes(context.agent)) fail('decision-access-denied', 'This decision is not enabled for this agent.');
    }
    return node;
  };
  const authorizeNode = async (...args) => { try { await resolveNode(...args); return true; } catch { return false; } };
  const findNodes = async (context) => {
    await owner(context.userId);
    const root = await rootMission(context);
    if (context.agent) await mayUse(context);
    return DecisionNodes.find({ userId: context.userId, status: context.agent ? 'active' : { $ne: 'archived' },
      ...(context.agent ? { enabled: true, agentIds: context.agent } : {}),
      $or: [{ scope: 'workspace' }, ...(root ? [{ scope: 'mission', missionId: root._id }] : [])],
    }, { sort: { name: 1 }, limit: 200 }).fetchAsync();
  };
  const snapshot = (node, action, actor) => DecisionVersions.insertAsync({ _id: `${node._id}:${node.revision}`, userId: node.userId, nodeId: node._id,
    revision: node.revision, snapshot: clone(node), action, actor, createdAt: new Date() });
  const validateAgents = async (userId, agentIds, missionId = null) => {
    const valid = await CrewConfigs.find({ userId, agent: { $in: agentIds }, enabled: true, status: { $ne: 'archived' } }, { fields: { agent: 1 } }).fetchAsync();
    if (valid.length !== agentIds.length) fail('decision-agent-unavailable', 'A selected agent is no longer available.');
    if (missionId) {
      await rootMission({ userId, sessionId: missionId });
      for (const agent of agentIds) if (!await missionAllowsAgent({ userId, sessionId: missionId }, agent)) {
        fail('decision-agent-unavailable', 'A selected agent is not in this mission’s crew.');
      }
    }
  };
  const save = async (userId, { nodeId, expectedRevision, input }) => locked(`nodes:${userId}`, async () => {
    await owner(userId);
    const clean = normalizeDecisionNode(input);
    await validateAgents(userId, clean.agentIds, clean.scope === 'mission' ? clean.missionId : null);
    if (clean.scope === 'mission') await rootMission({ userId, sessionId: clean.missionId });
    const previous = nodeId ? await DecisionNodes.findOneAsync({ _id: nodeId, userId, status: { $ne: 'archived' } }) : null;
    if (nodeId && (!previous || previous.revision !== revision(expectedRevision))) fail('decision-revision-changed', 'This decision changed. Reopen it before saving.');
    if (previous && (previous.scope !== clean.scope || (clean.scope === 'mission' && previous.missionId !== clean.missionId))) fail('decision-scope-change', 'Use Save to workspace to change a decision’s scope.');
    if (!previous && await DecisionNodes.find({ userId, status: { $ne: 'archived' } }).countAsync() >= 200) fail('decision-limit', 'Archive an unused decision before adding another.');
    const now = new Date();
    const node = { ...(previous ?? {}), ...clean, _id: previous?._id ?? Random.id(), userId, revision: (previous?.revision ?? 0) + 1,
      status: previous?.status ?? 'active', createdAt: previous?.createdAt ?? now, updatedAt: now,
      createdBy: previous?.createdBy ?? { kind: 'human', userId } };
    delete node.lastTest;
    await snapshot(node, previous ? 'edited' : 'created', { kind: 'human', userId });
    if (previous) {
      const changed = await DecisionNodes.rawCollection().replaceOne({ _id: node._id, userId, revision: previous.revision }, node);
      if (changed.modifiedCount !== 1) fail('decision-revision-changed', 'This decision changed. Reopen it before saving.');
    }
    else await DecisionNodes.insertAsync(node);
    return node;
  });
  const mutate = async (userId, { nodeId, expectedRevision }, action, change) => locked(`nodes:${userId}`, async () => {
    await owner(userId);
    const node = await DecisionNodes.findOneAsync({ _id: nodeId, userId, status: { $ne: 'archived' } });
    if (!node || node.revision !== revision(expectedRevision)) fail('decision-revision-changed', 'This decision changed. Reopen it before continuing.');
    const patch = await change(node);
    const next = { ...node, ...patch, revision: node.revision + 1, updatedAt: new Date() };
    // A passing fixture suite is tied to exact definitions, assignments and scope.
    delete next.lastTest;
    await snapshot(next, action, { kind: 'human', userId });
    const changed = await DecisionNodes.rawCollection().replaceOne({ _id: nodeId, userId, revision: node.revision }, next);
    if (changed.modifiedCount !== 1) fail('decision-revision-changed', 'This decision changed. Try again.');
    return next;
  });
  const createNode = async (context, input) => locked(`nodes:${context.userId}`, async () => {
    const { root } = await mayUse(context);
    if (!context.agent || !root) fail('decision-agent-required', 'Agent-created decisions need an active mission.');
    let policy = await getPolicy(context.userId, context.agent);
    if (policy.create === 'disabled') fail('decision-creation-disabled', 'Creating decisions is disabled for this agent.');
    const clean = normalizeDecisionNode({ ...input, scope: 'mission', missionId: root._id, agentIds: [context.agent], enabled: true });
    const creationRequest = context.toolCallId ? hash([context.userId, context.sessionId, context.agent, context.toolCallId]) : null;
    const creationFingerprint = hash(clean);
    if (creationRequest) {
      const existing = await DecisionNodes.findOneAsync({ userId: context.userId, creationRequest });
      if (existing) {
        if (existing.creationFingerprint !== creationFingerprint) fail('decision-request-conflict', 'This creation request ID was already used for a different definition.');
        if (existing.status === 'archived') fail('decision-request-unresolved', 'This creation request was already removed. Find another decision or make a new request.');
        return { nodeId: existing._id, revision: existing.revision, name: existing.name, status: existing.status,
          message: existing.status === 'pending' ? 'Waiting for a person to review this decision in Decisions.' : 'This decision is already saved for the mission.' };
      }
    }
    if (await DecisionNodes.find({ userId: context.userId, status: { $ne: 'archived' } }).countAsync() >= 200
      || await DecisionNodes.find({ userId: context.userId, missionId: root._id, 'createdBy.kind': 'agent', status: { $ne: 'archived' } }).countAsync() >= 20) fail('decision-limit', 'This mission has reached its decision creation limit.');
    await mayUse(context);
    policy = await getPolicy(context.userId, context.agent);
    if (policy.create === 'disabled') fail('decision-creation-disabled', 'Creating decisions is disabled for this agent.');
    const node = { ...clean, _id: Random.id(), userId: context.userId, revision: 1,
      status: policy.create === 'ask' ? 'pending' : 'active', createdAt: new Date(), updatedAt: new Date(),
      createdBy: { kind: 'agent', agent: context.agent, sessionId: context.sessionId }, creationPolicy: policy.create,
      ...(creationRequest ? { creationRequest, creationFingerprint } : {}) };
    await snapshot(node, node.status === 'pending' ? 'proposed' : 'created', node.createdBy);
    await DecisionNodes.insertAsync(node);
    return { nodeId: node._id, revision: node.revision, name: node.name, status: node.status,
      message: node.status === 'pending' ? 'Waiting for a person to review this decision in Decisions. Do not evaluate it until approved.' : 'Decision saved for this mission. It can now be evaluated.' };
  });
  // Approval adds one durable system turn to the original creator's session.
  // It never replays an evaluation, impersonates a human chat message, or
  // moves a specialist's private assignment into the primary agent's context.
  const continueApproved = async (node) => {
    const key = `decision-approved:${node._id}:${node.reviewedRevision + 1}`;
    const context = { userId: node.userId, sessionId: node.createdBy?.sessionId, agent: node.createdBy?.agent };
    let continuation = { status: 'manual', sessionId: context.sessionId ?? null, missionId: node.missionId ?? null, agent: context.agent ?? null,
      key, requestedAt: node.continuation?.requestedAt ?? new Date(), reason: 'Approved. Continue from the mission chat when ready.' };
    try {
      if (!host.startDecisionContinuation || !context.sessionId || !context.agent || node.createdBy.kind !== 'agent') return continuation;
      const { root } = await mayUse(context);
      await resolveNode(context, node._id, node.revision);
      const session = await (host.getSession ? host.getSession(context.sessionId) : AgentSessions.findOneAsync(context.sessionId));
      if (!session || session.userId !== node.userId || session.erasingAt || session.ephemeral
        || session.agent !== context.agent && !session.participants?.some((participant) => participant.kind === 'model' && participant.agent === context.agent)) {
        continuation.reason = 'Approved. The original agent conversation is no longer available; continue from the mission chat.';
        return continuation;
      }
      if ([root?.phase, session.phase].some((phase) => ['stopped', 'error'].includes(phase))
        || [root?.stoppedAt, session.stoppedAt].some((at) => at instanceof Date && at >= continuation.requestedAt)) {
        continuation.reason = 'Approved. Work remains stopped; send a message in the mission chat when you want to continue.';
        return continuation;
      }
      const prompt = `A person approved decision ${JSON.stringify(node.name)} (ID ${JSON.stringify(node._id)}, revision ${node.revision}). Continue the original task in this conversation if it still needs this judgment. Use find_decision_nodes to confirm the current revision and inputs before evaluation. Do not repeat completed work or previously attempted evaluations with an unknown outcome. This approves the decision definition only, not any downstream action; preserve all existing permissions and approval gates. Explain the outcome in plain language.`;
      const result = await host.startDecisionContinuation(context.sessionId, prompt, { key, agent: context.agent, source: 'decision-review' });
      if (result?.ok) return { ...continuation, status: result.ran ? 'resumed' : 'queued', reason: result.ran
        ? 'The agent is continuing in its original conversation.' : 'The agent will continue when its current turn or approval finishes.' };
      const reasons = {
        'session-halted': 'Approved. Work remains stopped; send a message in the mission chat when you want to continue.',
        'intent-standing': 'Approved. Another continuation is already queued; continue from the mission chat after it finishes.',
        'budget-exhausted': 'Approved. The scheduled-turn limit is exhausted; review mission limits before continuing.',
        'no-session': 'Approved. The original conversation is no longer available.',
        'no-agent': 'Approved. The creating agent is no longer available.',
      };
      if (result?.reason === 'duplicate-key') return { ...continuation, status: 'resumed', reason: 'This continuation was already requested; no duplicate turn was started.' };
      return { ...continuation, reason: reasons[result?.reason] ?? continuation.reason };
    } catch (error) {
      // Authority failures are definite refusals. An unexpected transport/DB
      // failure may follow a committed system turn, so never retry it blindly.
      const safe = safeError(error);
      if (error?.[safeFailure] || ['mission-inactive', 'mission-stopped', 'agent-unavailable', 'workflow-cancelled', 'workflow-not-running', 'workflow-inactive', 'workflow-budget', 'workflow-unavailable', 'not-authorized'].includes(error?.error)) {
        return { ...continuation, reason: `Approved. ${safe.reason} Continue from the mission chat when ready.` };
      }
      return { ...continuation, status: 'uncertain', reason: 'Approved, but the continuation could not be confirmed. Check the agent’s work before sending another message; it was not retried.' };
    }
  };
  const review = async (userId, input) => locked(`review:${userId}:${input?.nodeId}`, async () => {
    await owner(userId); decisionObject(input, 'Review');
    if (typeof input.approve !== 'boolean') fail('decision-not-pending', 'Choose approve or reject.');
    const prior = await DecisionNodes.findOneAsync({ _id: input.nodeId, userId });
    // DDP reconnect can replay a completed click. Adopt its durable receipt,
    // even if the response was lost; never schedule a second model turn.
    if (prior?.reviewedBy === userId && prior.reviewedRevision === revision(input.expectedRevision)
      && prior.reviewApproved === input.approve) return prior;
    const node = await mutate(userId, input, input.approve ? 'approved' : 'rejected', (current) => {
      if (current.status !== 'pending') fail('decision-not-pending', 'This decision is not waiting for review.');
      return { status: input.approve ? 'active' : 'archived', enabled: input.approve, reviewedAt: new Date(), reviewedBy: userId,
        reviewedRevision: current.revision, reviewApproved: input.approve,
        ...(input.approve ? { continuation: { status: 'preparing', sessionId: current.createdBy?.sessionId ?? null,
          missionId: current.missionId ?? null, agent: current.createdBy?.agent ?? null,
          key: `decision-approved:${current._id}:${current.revision + 1}`, requestedAt: new Date() } } : {}) };
    });
    if (!input.approve) return node;
    const continuation = await continueApproved(node);
    await DecisionNodes.updateAsync({ _id: node._id, userId, reviewedRevision: node.reviewedRevision, 'continuation.status': 'preparing' }, { $set: { continuation } });
    return DecisionNodes.findOneAsync({ _id: node._id, userId });
  });
  const eligibleAgents = async (userId, { nodeId }) => {
    await owner(userId);
    const node = await DecisionNodes.findOneAsync({ _id: decisionText(nodeId, 'Decision', 120), userId, status: { $ne: 'archived' } });
    if (!node) fail('decision-not-found', 'Decision not found.');
    if (node.scope === 'mission') await rootMission({ userId, sessionId: node.missionId });
    const rows = await CrewConfigs.find({ userId, enabled: true, status: { $ne: 'archived' } }, { sort: { primary: -1, name: 1 } }).fetchAsync();
    const eligible = [];
    for (const row of rows) if (node.scope !== 'mission' || await missionAllowsAgent({ userId, sessionId: node.missionId }, row.agent)) {
      eligible.push({ agent: row.agent, displayName: row.displayName ?? row.agent, role: row.role ?? '', policy: await getPolicy(userId, row.agent) });
    }
    return eligible;
  };
  const setAssignments = (userId, input) => mutate(userId, input, 'assignments-changed', async (node) => {
    // Normalize only the requested membership. Neither rubric nor policy can
    // be smuggled into this human-only method through extra input properties.
    if (!Array.isArray(input.agentIds)) fail('invalid-decision', 'Choose the agents who can use this decision.');
    const { agentIds } = normalizeDecisionNode({ ...node, agentIds: input.agentIds });
    await validateAgents(userId, agentIds, node.scope === 'mission' ? node.missionId : null);
    return { agentIds };
  });
  const continuationSession = async (node) => {
    const continuation = node.continuation;
    if (!continuation?.sessionId || !continuation.missionId) return null;
    const session = await AgentSessions.findOneAsync({ _id: continuation.sessionId, userId: node.userId, erasingAt: { $exists: false } });
    if (!session) return null;
    try {
      const root = await rootMission({ userId: node.userId, sessionId: session._id });
      return root?._id === continuation.missionId ? session : null;
    } catch { return null; }
  };
  const isContinuationCause = async (node) => {
    const { sessionId, agent, key } = node.continuation;
    const trace = await AgentTraces.findOneAsync({ sessionId, agent, kind: 'turn', status: { $in: ['running', 'waiting'] } }, { sort: { startedAt: -1 } });
    const latest = await AgentMessages.findOneAsync({ sessionId, $or: [{ role: 'system' }, { role: 'user', kind: { $ne: 'crew-note' } }, { role: 'assistant', to: `m:${agent}` }] }, { sort: { seq: -1 } });
    // An interjected human message is a new request even before its next trace
    // starts. Do not turn that request back into stopped as old work unwinds.
    if (trace?.triggerSeq !== undefined && latest?.seq > trace.triggerSeq) return latest._id === `sys:${sessionId}:${key}`;
    const trigger = trace?.triggerSeq !== undefined
      ? await AgentMessages.findOneAsync({ sessionId, seq: trace.triggerSeq })
      : latest;
    return trigger?._id === `sys:${sessionId}:${key}`;
  };
  const continuationChain = async (node) => {
    const chain = []; let session = await continuationSession(node);
    for (let depth = 0; session && depth < 8; depth += 1) {
      if (chain.some((row) => row._id === session._id)) break;
      chain.push(session);
      session = session.activeChild?.sessionId ? await AgentSessions.findOneAsync({ _id: session.activeChild.sessionId, userId: node.userId,
        'parent.sessionId': session._id, erasingAt: { $exists: false } }) : null;
    }
    return chain;
  };
  const stopContinuationSession = async (node, { force = false } = {}) => {
    const session = await continuationSession(node);
    if (!session) return;
    // Cancel only this approval's standing intent. Other scheduled prompts and
    // fresh human messages are not owned by this continuation.
    await AgentSessions.updateAsync({ _id: session._id, userId: node.userId,
      'pendingSystem.key': node.continuation.key, 'pendingSystem.source': 'decision-review' }, { $unset: { pendingSystem: '' } });
    if (force || await isContinuationCause(node)) {
      const chain = await continuationChain(node);
      for (const [index, row] of chain.entries()) {
        const expected = index === 0 ? session : row;
        const changed = await AgentSessions.updateAsync({ _id: row._id, userId: node.userId, erasingAt: { $exists: false }, phase: { $nin: ['stopped', 'error'] },
          ...(!force ? { nextSeq: expected.nextSeq ?? { $exists: false },
            'activeChild.sessionId': expected.activeChild?.sessionId ?? { $exists: false },
            'activeChild.toolCallId': expected.activeChild?.toolCallId ?? { $exists: false } } : {}),
        }, { $set: { phase: 'stopped', stoppedAt: new Date(), updatedAt: new Date() } });
        // If a new human message/child won the CAS, its newly-read descendants
        // are not ours to stop. The exact obsolete intent was still cancelled.
        if (!force && changed !== 1) break;
      }
    }
    await DecisionNodes.updateAsync({ _id: node._id, 'continuation.key': node.continuation.key }, { $set: {
      'continuation.stopRequestedAt': new Date(),
    } });
  };
  const stopMissionContinuations = async (userId, missionId) => {
    // Only sessions durably linked to active decision continuations are in
    // scope; this is not an unrestricted descendant/session mutation API.
    const nodes = await DecisionNodes.find({ userId, 'continuation.missionId': missionId,
      'continuation.status': { $in: ['preparing', 'queued', 'resumed', 'waiting', 'uncertain'] } }).fetchAsync();
    for (const node of nodes) {
      await stopContinuationSession(node, { force: true });
      await DecisionNodes.updateAsync({ _id: node._id, 'continuation.key': node.continuation.key }, { $set: {
        'continuation.status': 'stopped', 'continuation.reason': 'The mission was stopped. This continuation will not restart automatically.', 'continuation.finishedAt': new Date(),
      } });
    }
  };
  const missionContinuationsQuiescent = async (userId, missionId) => {
    const nodes = await DecisionNodes.find({ userId, 'continuation.missionId': missionId,
      'continuation.stopRequestedAt': { $exists: true } }).fetchAsync();
    for (const node of nodes) {
      for (const session of await continuationChain(node)) {
        const liveLease = session.lease?.until instanceof Date && session.lease.until > new Date();
        if (liveLease || ['streaming', 'calling', 'retrying', 'compacting'].includes(session.phase)) return false;
        if (session.lease) await AgentSessions.updateAsync({ _id: session._id, userId, phase: 'stopped',
          'lease.serverId': session.lease.serverId, 'lease.until': session.lease.until }, { $unset: { lease: '' } });
      }
    }
    return true;
  };
  const assertContinuationExecution = async (sessionId, agent) => {
    const target = await AgentSessions.findOneAsync(sessionId);
    let child = target;
    const visited = new Set();
    // A stopped continuation may have authorized a delegation just before
    // Stop. Its child can be born after the stop walk, so bind each ancestor
    // edge to the exact proposing turn, not the parent's current/newer turn.
    for (let depth = 0; child?.parent?.sessionId && depth < 8; depth += 1) {
      if (visited.has(child._id)) break;
      visited.add(child._id);
      const parent = await AgentSessions.findOneAsync({ _id: child.parent.sessionId, userId: target.userId, erasingAt: { $exists: false } });
      if (!parent || child.userId !== target.userId) break;
      const ancestors = await DecisionNodes.find({ userId: target.userId, 'continuation.sessionId': parent._id,
        'continuation.status': { $in: ['preparing', 'queued', 'resumed', 'waiting', 'uncertain', 'stopped'] } }).fetchAsync();
      for (const node of ancestors) {
        const root = await rootMission({ userId: node.userId, sessionId: parent._id });
        const cutoffs = [parent.stoppedAt, root?.stoppedAt].filter((at) => at instanceof Date && at >= node.continuation.requestedAt);
        if (!cutoffs.length) continue;
        const cutoff = new Date(Math.max(...cutoffs.map((at) => at.getTime())));
        const trigger = await AgentMessages.findOneAsync(`sys:${parent._id}:${node.continuation.key}`);
        if (!trigger) continue; // No materialized approval could have delegated.
        const span = await AgentTraceSpans.findOneAsync({ sessionId: parent._id, kind: 'tool', toolCallId: child.parent.toolCallId,
          ...(child.createdAt ? { startedAt: { $lte: child.createdAt } } : {}) }, { sort: { startedAt: -1 } });
        const origin = span && await AgentTraces.findOneAsync({ _id: span.traceId, sessionId: parent._id });
        if (origin?.triggerSeq !== undefined && origin.triggerSeq !== trigger.seq) continue;
        if (origin?.triggerSeq === undefined) {
          const proposal = await AgentMessages.findOneAsync({ sessionId: parent._id, role: 'assistant', 'toolCalls.id': child.parent.toolCallId }, { sort: { seq: -1 } });
          // Evidence capture is best-effort. The durable assistant watermark
          // still proves when genuinely newer human input drove a delegation;
          // a merely newer message/commit timestamp does not prove that.
          if (proposal && (proposal.seq <= trigger.seq || proposal.answeredThrough > trigger.seq)) continue;
        }
        const currentTrace = await AgentTraces.findOneAsync({ sessionId, ...(agent ? { agent } : {}), kind: 'turn', status: 'running' }, { sort: { startedAt: -1 } });
        const currentTrigger = currentTrace?.triggerSeq !== undefined && await AgentMessages.findOneAsync({ sessionId, seq: currentTrace.triggerSeq });
        if (currentTrigger?.role === 'user' && currentTrigger.kind !== 'crew-note' && currentTrigger.seq > 0
          && currentTrigger.createdAt > cutoff
          && (['h:', 'x:'].some((prefix) => currentTrigger.from?.participant?.startsWith(prefix)) || currentTrigger.source?.kind === 'desktop')) continue;
        // Refuse only this descendant's provider/tool entry. Never stop the
        // ancestor or its new siblings: a human may already be doing new work.
        fail('decision-continuation-stopped', 'This delegated work belongs to a stopped decision continuation; it was not restarted.');
      }
      child = parent;
    }
    const nodes = await DecisionNodes.find({ 'continuation.sessionId': sessionId,
      ...(agent ? { 'continuation.agent': agent } : {}),
      'continuation.status': { $in: ['preparing', 'queued', 'resumed', 'waiting', 'uncertain', 'stopped'] } }).fetchAsync();
    for (const node of nodes) {
      const creator = await continuationSession(node);
      if (!creator) continue;
      const root = await rootMission({ userId: node.userId, sessionId });
      if (![creator.stoppedAt, root?.stoppedAt].some((at) => at instanceof Date && at >= node.continuation.requestedAt)) continue;
      const oldCause = await isContinuationCause(node);
      await stopContinuationSession(node);
      await DecisionNodes.updateAsync({ _id: node._id, 'continuation.key': node.continuation.key }, { $set: {
        'continuation.status': 'stopped', 'continuation.reason': 'This continuation was cancelled by Stop. Send a new message to request further work.',
      } });
      // A later human turn has a different trigger and remains executable.
      if (oldCause && await isContinuationCause(node)) fail('decision-continuation-stopped', 'This decision continuation was stopped; it was not restarted.');
    }
  };
  const refreshContinuations = async (sessionId, observedStopAt) => {
    const pendingStatuses = ['preparing', 'queued', 'resumed', 'waiting', 'uncertain', 'stopped'];
    const nodes = await DecisionNodes.find({ $or: [{ 'continuation.sessionId': sessionId }, { 'continuation.missionId': sessionId }],
      'continuation.status': { $in: pendingStatuses } }).fetchAsync();
    for (const node of nodes) {
      const continuation = node.continuation;
      const creatorSessionId = continuation.sessionId;
      const trigger = await AgentMessages.findOneAsync(`sys:${creatorSessionId}:${continuation.key}`);
      // Match the precise system trigger, not merely the newest final reply:
      // another human turn may already have overtaken this continuation.
      const trace = trigger && await AgentTraces.findOneAsync({ sessionId: creatorSessionId, agent: continuation.agent, kind: 'turn', triggerSeq: trigger.seq }, { sort: { startedAt: -1 } });
      const getSession = (id) => host.getSession ? host.getSession(id) : AgentSessions.findOneAsync(id);
      const creator = await getSession(creatorSessionId);
      const root = continuation.missionId ? await getSession(continuation.missionId) : creator;
      const cancelled = [observedStopAt, creator?.stoppedAt, root?.stoppedAt]
        .some((at) => at instanceof Date && at >= continuation.requestedAt);
      // Stop can win before the queued System row exists. Session lifecycle is
      // still conclusive evidence; no trace is required to honor that stop.
      if (trace?.status !== 'completed' && (cancelled || !creator || !root || creator.erasingAt || root.erasingAt
        || [creator.phase, root.phase].some((phase) => ['stopped', 'error'].includes(phase)))) {
        // Core chat Stop does not know about a formerly completed specialist.
        // Clear that child's queued intent as well, so a later root message
        // cannot resurrect work that the person explicitly stopped.
        await stopContinuationSession(node);
        await DecisionNodes.updateAsync({ _id: node._id, 'continuation.key': continuation.key, 'continuation.status': { $in: pendingStatuses } },
          { $set: { 'continuation.status': 'stopped', 'continuation.reason': 'The original conversation is stopped or no longer available. No further work was started.', 'continuation.finishedAt': new Date() } });
        continue;
      }
      if (continuation.status === 'stopped') continue;
      if (!trace) continue;
      const statuses = { running: 'resumed', completed: 'completed', waiting: 'waiting', stopped: 'stopped', failed: 'failed' };
      const reasons = { running: 'The agent is continuing in its original conversation.', completed: 'The agent finished its continuation. View its work for the result.',
        waiting: 'The agent is waiting for another approval. Open its work to review it.', stopped: 'The continuation was stopped. No further work was started.',
        failed: 'The continuation could not finish. Review the agent’s work before trying again.' };
      await DecisionNodes.updateAsync({ _id: node._id, 'continuation.key': continuation.key,
        'continuation.status': { $in: pendingStatuses } }, { $set: {
        'continuation.status': statuses[trace.status] ?? continuation.status,
        'continuation.reason': reasons[trace.status] ?? continuation.reason,
        'continuation.traceId': trace._id,
        ...(trace.finishedAt ? { 'continuation.finishedAt': trace.finishedAt } : {}),
      } });
    }
  };
  const apiKey = async (userId) => {
    const secret = await DecisionSecrets.findOneAsync(userId);
    if (secret?.box) {
      try { return await host.decryptSecret(userId, secret.box); }
      catch { fail('decision-key-locked', 'The credential store is locked. Launch Constellation from its desktop app.'); }
    }
    const value = process.env.TYPESAFE_API_KEY?.trim();
    if (!value) fail('decision-key-missing', 'Add a TypeSafe API key in Decisions settings, or launch with TYPESAFE_API_KEY.');
    return value;
  };
  const budgetId = (userId, missionId) => hash([userId, missionId ?? `workspace-tests:${new Date().toISOString().slice(0, 10)}`]);
  const reserve = async (context, root, settings, amount) => {
    const id = budgetId(context.userId, root?._id);
    await DecisionBudgets.upsertAsync(id, { $setOnInsert: { userId: context.userId, missionId: root?._id ?? null, calls: 0, tokens: 0, reservedTokens: 0, createdAt: new Date() } });
    const current = await DecisionBudgets.findOneAsync(id);
    if (current.calls >= settings.limits.callsPerMission || current.tokens + current.reservedTokens + amount > settings.limits.tokensPerMission) fail('decision-budget-exhausted', 'Decision usage limit reached. Review usage or raise the limit in Decisions settings.');
    const updated = await DecisionBudgets.updateAsync({ _id: id, calls: current.calls, tokens: current.tokens, reservedTokens: current.reservedTokens },
      { $inc: { calls: 1, reservedTokens: amount }, $set: { updatedAt: new Date() } });
    if (!updated) fail('decision-budget-busy', 'Another decision is reserving this mission’s budget. Try again.');
    return id;
  };
  const evaluate = async (context, { nodeId, revision: expectedRevision, state, purpose, requestKey }) => locked(`evaluate:${context.userId}:${context.sessionId ?? 'workspace'}`, async () => {
    const { root, settings } = await mayUse(context);
    const node = await resolveNode(context, nodeId, revision(expectedRevision));
    if (node.status !== 'active' || !node.enabled) fail('decision-disabled', 'Approve and enable this decision before running it.');
    const cleanState = normalizeDecisionState(state, node, settings.limits.maxInputChars);
    const key = await apiKey(context.userId);
    const stableKey = requestKey ?? context.idempotencyKey;
    // Framework tool-call IDs are opaque provider values. UI keys are checked
    // more strictly at the DDP boundary; hashing keeps either source safe.
    if (stableKey !== undefined) decisionText(stableKey, 'Request ID', 240);
    const runId = stableKey ? hash([context.userId, stableKey]) : Random.id();
    const fingerprint = hash([node._id, node.revision, cleanState, root?._id, context.agent]);
    const existing = await DecisionRuns.findOneAsync(runId);
    if (existing) {
      if (existing.userId !== context.userId || existing.fingerprint !== fingerprint) fail('decision-request-conflict', 'This request ID was used for a different decision.');
      if (existing.status === 'completed') return existing;
      fail('decision-request-unresolved', 'This request was already attempted. Inspect its history before starting a new attempt.');
    }
    const run = { _id: runId, userId: context.userId, nodeId, nodeRevision: node.revision, nodeName: node.name,
      missionId: root?._id ?? null, sessionId: context.sessionId ?? null, agent: context.agent ?? null,
      workflowRunId: context.workflowRunId ?? null, workflowStepId: context.workflowStepId ?? null,
      purpose: context.agent ? purpose === 'workflow' ? 'workflow' : 'agent' : purpose === 'fixture' ? 'fixture' : 'test',
      status: 'running', definition: clone(node.definition), inputFields: clone(node.inputFields), state: cleanState,
      fingerprint, createdAt: new Date(), updatedAt: new Date(), attempts: 0 };
    try { await DecisionRuns.insertAsync(run); } catch (error) { if (error.code === 11000) fail('decision-request-unresolved', 'This request is already being evaluated.'); throw error; }
    // A conservative byte-bound reservation, with additional answer overhead.
    // Unknown network outcomes retain the reservation as charged usage so they
    // cannot be used to bypass the cap. Actual provider tokens replace it on success.
    const reservedPerAttempt = Buffer.byteLength(JSON.stringify({ state: cleanState, ...node.definition }), 'utf8')
      + Object.values(node.definition.questions).reduce((sum, question) => sum + 1_024 + (question.type === 'noul' ? 0 : Object.keys(question.criteria).length * 96), 0);
    const reservations = [];
    let received;
    try {
      const result = await adapter({ apiKey: key, definition: run.definition, state: cleanState, signal: context.signal,
        async beforeAttempt() {
          const current = await mayUse(context);
          await resolveNode(context, nodeId, expectedRevision);
          const id = await reserve(context, root, current.settings, reservedPerAttempt);
          reservations.push(id);
          await DecisionRuns.updateAsync(runId, { $inc: { attempts: 1 } });
        } });
      const validated = validateDecisionResponse(result, run.definition);
      received = validated;
      await DecisionRuns.updateAsync(runId, { $set: { ...validated, costEstimate: estimateDecisionCost(validated),
        summary: decisionAnswerLabel(validated.answers), receivedAt: new Date() } });
      // Result is an observation, never an authorization. Revocation in flight
      // still prevents returning it to a tool/workflow as actionable success.
      await mayUse(context); await resolveNode(context, nodeId, expectedRevision);
      await DecisionRuns.updateAsync(runId, { $set: { ...validated, summary: decisionAnswerLabel(validated.answers),
        status: 'completed', completedAt: new Date(), updatedAt: new Date() } });
      for (const [index, id] of reservations.entries()) await DecisionBudgets.updateAsync(id, { $inc: { reservedTokens: -reservedPerAttempt,
        tokens: index === reservations.length - 1 ? validated.usage.input_tokens + validated.usage.output_tokens : 0 } });
      reservations.length = 0;
      return DecisionRuns.findOneAsync(runId);
    } catch (error) {
      await DecisionRuns.updateAsync(runId, { $set: { status: 'failed', error: safeError(error), completedAt: new Date(), updatedAt: new Date(),
        uncertainUsage: !received && reservations.length > 0, reservedTokens: received ? 0 : reservations.length * reservedPerAttempt } });
      for (const [index, id] of reservations.entries()) await DecisionBudgets.updateAsync(id, { $inc: { reservedTokens: -reservedPerAttempt,
        tokens: received ? index === reservations.length - 1 ? received.usage.input_tokens + received.usage.output_tokens : 0 : reservedPerAttempt } });
      fail(safeError(error).code, safeError(error).reason);
    }
  });
  const testFixtures = async (userId, { nodeId, revision: expectedRevision, requestKey }) => {
    await owner(userId);
    // UI replays supply the same suite key. Server-only callers may deliberately
    // start a new suite without one; each case is still stable for that suite.
    const suiteKey = requestKey === undefined ? Random.id() : requiredRequestKey(requestKey);
    const initial = await DecisionNodes.findOneAsync({ _id: nodeId, userId });
    if (!initial) fail('decision-not-found', 'Decision not found.');
    const context = { userId, ...(initial.missionId ? { sessionId: initial.missionId } : {}) };
    const node = await resolveNode(context, nodeId, expectedRevision);
    if (!node.fixtures.length) fail('decision-tests-missing', 'Add test cases with expected answers before running tests.');
    const results = [];
    for (const fixture of node.fixtures) {
      const run = await evaluate(context, { nodeId, revision: node.revision, state: fixture.state, purpose: 'fixture',
        requestKey: `fixture:${hash([suiteKey, nodeId, node.revision, fixture.id])}` });
      const assertions = decisionAssertions(fixture.expected, run.answers);
      results.push({ fixtureId: fixture.id, name: fixture.name, passed: assertions.every((item) => item.passed), runId: run._id, assertions });
    }
    const report = { nodeId, revision: node.revision, status: results.every((item) => item.passed) ? 'passed' : 'failed',
      passed: results.filter((item) => item.passed).length, total: results.length, results, completedAt: new Date() };
    const updated = await DecisionNodes.updateAsync({ _id: nodeId, userId, revision: node.revision }, { $set: { lastTest: report, updatedAt: new Date() } });
    if (!updated) fail('decision-revision-changed', 'The decision changed while tests ran. Test its current revision before sharing.');
    return report;
  };
  const saveSettings = async (userId, input) => locked(`settings:${userId}`, async () => {
    await owner(userId); decisionObject(input, 'Settings');
    const current = await getSettings(userId);
    if (input.apiKey) {
      const value = decisionText(input.apiKey, 'API key', 4_096);
      if (!host.canStoreSecret?.() || !host.encryptSecret) fail('decision-key-locked', 'Launch Constellation from its desktop app to save a key securely, or use TYPESAFE_API_KEY in your shell.');
      const box = await host.encryptSecret(userId, value);
      await DecisionSecrets.upsertAsync(userId, { $set: { userId, box, updatedAt: new Date() } });
    } else if (input.clearApiKey === true) await DecisionSecrets.removeAsync(userId);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('invalid-decision', 'Enabled must be on or off.');
    await DecisionSettings.updateAsync(userId, { $set: { enabled: input.enabled ?? current.enabled,
      limits: normalizeDecisionLimits(input.limits ?? current.limits), updatedAt: new Date() } });
    await host.onPolicyChange?.(userId);
    return getSettings(userId);
  });
  const setAgentPolicy = async (userId, { agent, policy }) => locked(`settings:${userId}`, async () => {
    await owner(userId); decisionText(agent, 'Agent', 120);
    if (agent.includes('.') || agent.startsWith('$') || ['__proto__', 'constructor', 'prototype'].includes(agent)) fail('invalid-decision', 'Invalid agent name.');
    await validateAgents(userId, [agent]); await getSettings(userId);
    const normalized = normalizeDecisionPolicy(policy);
    await DecisionSettings.updateAsync(userId, { $set: { [`agentPolicies.${agent}`]: normalized, updatedAt: new Date() } });
    await host.onPolicyChange?.(userId);
    return normalized;
  });
  const toolEntitlement = async (tool, context, agent) => {
    if (!DECISION_TOOL_NAMES.includes(tool)) return false;
    try {
      const ctx = { ...context, agent }; await mayUse(ctx);
      const policy = await getPolicy(context.userId, agent);
      return tool !== 'create_decision_node' || policy.create !== 'disabled';
    } catch { return false; }
  };
  const toolDefinitions = (agent) => [
    { name: 'find_decision_nodes', description: 'Find existing typed decision nodes available to this agent and mission. Reuse a suitable node before creating another.', args: { type: 'object', properties: {}, additionalProperties: false },
      gate: (context) => toolEntitlement('find_decision_nodes', context, agent),
      run: async (_args, context) => (await findNodes({ ...context, agent })).map((node) => ({ nodeId: node._id, revision: node.revision, name: node.name, description: node.description, inputFields: node.inputFields, definition: node.definition })) },
    { name: 'create_decision_node', description: 'Create a mission-local Jev decision from narrow independent questions. Choices select known options; scores use ordered levels; noul answers yes/no. No code is generated. Pending means a person must approve it before use.',
      args: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, definition: { type: 'object', properties: { model: { type: 'string', description: 'Use jev-latest unless a specific Jev version is required.' }, questions: {
        type: 'object', description: 'A map of 1–16 independent question IDs to definitions. IDs start with a letter. Questions see the same state and cannot see one another’s answers.',
        additionalProperties: { type: 'object', properties: {
          type: { type: 'string', enum: ['choice', 'score', 'noul'] },
          instructions: { type: 'string', description: 'The complete question, referencing named state fields with backticks.' },
          criteria: { description: 'choice: map of 2–255 option IDs to descriptions (include none when appropriate). score: 2–10 ordered level descriptions. noul: optional object with true and false meanings.',
            anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10 }] },
        }, required: ['type', 'instructions'], additionalProperties: false },
      } }, required: ['questions'], additionalProperties: false }, inputFields: { type: 'array', description: 'Named fields callers supply; defaults to one required text field named context.', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', enum: ['text', 'number', 'boolean'] }, required: { type: 'boolean' } }, required: ['key', 'label', 'type'] } } }, required: ['name', 'definition'], additionalProperties: false },
      gate: (context) => toolEntitlement('create_decision_node', context, agent), run: (args, context) => createNode({ ...context, agent }, args) },
    { name: 'evaluate_decision_node', description: 'Evaluate a saved decision revision using only the necessary named input fields. Context is sent to TypeSafe. Typed judgments do not grant permission to execute an action; use existing authorized tools. Never send credentials.',
      args: { type: 'object', properties: { nodeId: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, state: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] } }, required: ['nodeId', 'revision', 'state'], additionalProperties: false },
      gate: (context) => toolEntitlement('evaluate_decision_node', context, agent),
      run: async (args, context) => {
        const run = await evaluate({ ...context, agent }, { ...args, purpose: 'agent', requestKey: context.toolCallId ? `tool:${context.sessionId}:${context.toolCallId}` : undefined });
        return { runId: run._id, nodeId: run.nodeId, revision: run.nodeRevision, name: run.nodeName, answers: run.answers, summary: run.summary,
          usage: run.usage, notice: 'Judgments are not verified facts or permission to act.' };
      } },
  ];
  return { getSettings, getPolicy, saveSettings, setAgentPolicy, findNodes, resolveNode, authorizeNode, save, createNode,
    review, eligibleAgents, setAssignments, refreshContinuations, stopMissionContinuations, missionContinuationsQuiescent, assertContinuationExecution,
    evaluate, testFixtures, toolEntitlement, toolDefinitions,
    async authorizeMissionUsage(userId, missionId) {
      await owner(userId);
      const id = decisionText(missionId, 'Mission', 120);
      const root = await rootMission({ userId, sessionId: id });
      if (!root || root._id !== id) fail('decision-mission-unavailable', 'Choose an available mission.');
      return root._id;
    },
    setEnabled: (userId, input) => mutate(userId, input, input.enabled ? 'enabled' : 'disabled', () => {
      if (typeof input.enabled !== 'boolean') fail('invalid-decision', 'Enabled must be on or off.'); return { enabled: input.enabled }; }),
    remove: (userId, input) => mutate(userId, input, 'archived', () => ({ status: 'archived', enabled: false, archivedAt: new Date() })),
    promote: (userId, input) => mutate(userId, input, 'promoted', (node) => {
      if (node.scope !== 'mission' || node.status !== 'active') fail('decision-not-promotable', 'Only approved mission decisions can be saved to the workspace.');
      if (node.lastTest?.revision !== node.revision || node.lastTest?.status !== 'passed') fail('decision-tests-required', 'Pass test cases on this revision before saving it to the workspace.');
      return { scope: 'workspace', missionId: null, promotedBy: userId, promotedAt: new Date(), promotionTest: node.lastTest }; }),
    async history(userId, { nodeId }) { await owner(userId); return DecisionRuns.find({ userId, nodeId: decisionText(nodeId, 'Decision', 120) }, { sort: { createdAt: -1 }, limit: 50 }).fetchAsync(); },
    async versions(userId, { nodeId }) { await owner(userId); return DecisionVersions.find({ userId, nodeId: decisionText(nodeId, 'Decision', 120) }, { sort: { revision: -1 }, limit: 50 }).fetchAsync(); },
  };
}

/** Shared by installed DDP methods and controlled provider tests. A reconnect
 * replays identical method arguments; paid UI calls must carry a durable key. */
export function createDecisionMethods(service, recover = Promise.resolve()) {
  const handlers = {};
  for (const name of ['save', 'setEnabled', 'remove', 'review', 'promote', 'saveSettings', 'setAgentPolicy', 'setAssignments', 'eligibleAgents', 'testFixtures', 'history', 'versions']) handlers[`constellation.decisions.${name}`] = async function (input) {
    try {
      await recover;
      if (name === 'testFixtures') { decisionObject(input, 'Test request'); requiredRequestKey(input.requestKey); }
      return await service[name](this.userId, input);
    } catch (error) { const safe = safeError(error); throw new Meteor.Error(safe.code, safe.reason); }
  };
  handlers['constellation.decisions.evaluate'] = async function (input) {
    try {
      await recover; decisionObject(input, 'Decision request'); requiredRequestKey(input.requestKey);
      return await service.evaluate({ userId: this.userId, sessionId: input.missionId }, input);
    } catch (error) { const safe = safeError(error); throw new Meteor.Error(safe.code, safe.reason); }
  };
  handlers['constellation.decisions.list'] = async function ({ missionId } = {}) { return service.findNodes({ userId: this.userId, sessionId: missionId }); };
  handlers['constellation.decisions.get'] = async function ({ nodeId, missionId }) { return service.resolveNode({ userId: this.userId, sessionId: missionId }, nodeId); };
  return handlers;
}

let installed;
export function installConstellationDecisions(host) {
  if (installed) return installed;
  const service = createConstellationDecisionService(host);
  installed = service;
  const recover = Promise.all([
    DecisionRuns.updateAsync({ status: 'running' }, { $set: { status: 'failed', error: { code: 'decision-interrupted',
      reason: 'The app restarted before this decision finished. Its result is unknown; it was not retried.' }, uncertainUsage: true, completedAt: new Date() } }, { multi: true }),
    DecisionNodes.updateAsync({ 'continuation.status': 'preparing' }, { $set: { 'continuation.status': 'uncertain',
      'continuation.reason': 'The app restarted before continuation was confirmed. Check the agent’s work before sending another message; it was not retried.' } }, { multi: true }),
  ]);
  // Attach the rejection observer immediately; a database outage during boot
  // must not become an unhandled rejection before a method awaits recovery.
  recover.catch(() => { console.error('[constellation] Decision recovery could not finish.'); });
  Meteor.startup(async () => {
    await recover;
    let initializing = true;
    let pending = Promise.resolve();
    const notice = (sessionId, stoppedAt) => {
      if (initializing || !sessionId) return;
      pending = pending.then(() => service.refreshContinuations(sessionId, stoppedAt))
        .catch(() => { console.error('[constellation] Decision continuation status could not be refreshed.'); });
    };
    const sessions = new Map();
    await AgentTraces.find({ kind: 'turn' }, { fields: { sessionId: 1, status: 1, triggerSeq: 1 } }).observeChangesAsync({
      added(id, fields) { sessions.set(id, fields.sessionId); notice(fields.sessionId); },
      changed(id, fields) { if (fields.sessionId) sessions.set(id, fields.sessionId); notice(sessions.get(id)); },
      removed(id) { sessions.delete(id); },
    });
    await AgentSessions.find({}, { fields: { phase: 1, erasingAt: 1, stoppedAt: 1, pendingSystem: 1 } }).observeChangesAsync({
      added(id, fields) { notice(id, fields.stoppedAt); }, changed(id, fields) { notice(id, fields.stoppedAt); }, removed(id) { notice(id); },
    });
    initializing = false;
    const waiting = await DecisionNodes.find({ 'continuation.status': { $in: ['queued', 'resumed', 'waiting', 'uncertain'] } }, { fields: { continuation: 1 } }).fetchAsync();
    for (const sessionId of new Set(waiting.map((node) => node.continuation.sessionId))) notice(sessionId);
  });
  // Outstanding reservations intentionally remain held after restart because
  // the provider may have billed them; no process can know an interrupted result.
  Meteor.publish('constellation.decisions', async function () {
    if (!this.userId) return this.ready();
    await service.getSettings(this.userId);
    return [DecisionNodes.find({ userId: this.userId }, { fields: { userId: 0 }, sort: { updatedAt: -1 } }),
      DecisionSettings.find(this.userId, { fields: { userId: 0 } }),
      DecisionRuns.find({ userId: this.userId }, { fields: { userId: 0, state: 0, definition: 0, inputFields: 0, fingerprint: 0 }, sort: { createdAt: -1 }, limit: 100 }),
      DecisionBudgets.find({ userId: this.userId }, { fields: { userId: 0 } })];
  });
  Meteor.publish('constellation.decisions.missionUsage', async function (missionId) {
    await recover;
    await publishDecisionMissionUsage(this, service, DecisionRuns, missionId);
  });
  Meteor.methods(createDecisionMethods(service, recover));
  DDPRateLimiter.addRule({ type: 'method', name: (name) => name.startsWith('constellation.decisions.'), userId: (id) => !!id }, 80, 60_000);
  return service;
}
