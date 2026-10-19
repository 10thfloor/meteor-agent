import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { createHash } from 'node:crypto';
import { Agent, AgentSessions, AgentAttachments, runIsolatedExecution } from 'meteor/10thfloor:agent';
import { spritesAdapter, SpritesProviderError } from './sprites-provider';
import { createExecutionEnvironmentService, ExecutionEnvironments, ENVIRONMENT_PUBLIC_FIELDS } from './constellation-environments';
import { createMissionWorkService } from './constellation-work';
import { createMissionFileTools } from './mission-file-tools';
import { createSpriteAttachmentStorage } from './sprite-attachment-storage';
import { sweepOrphanMissionFiles } from './mission-file-store';
export { ExecutionEnvironments } from './constellation-environments';
import { EXECUTION_DEFAULT_LIMITS, EXECUTION_DEFAULT_POLICY, EXECUTION_ACTIVE_STATES, ExecutionValidationError,
  executionObject, executionText, normalizeExecutionInput, normalizeExecutionLimits, normalizeExecutionDomains, normalizeExecutionPolicy } from '../imports/constellation/execution';

export const ExecutionSettings = new Mongo.Collection('constellation_execution_settings', { _preventAutopublish: true });
export const ExecutionSecrets = new Mongo.Collection('constellation_execution_secrets', { _preventAutopublish: true });
export const ExecutionJobs = new Mongo.Collection('constellation_execution_jobs', { _preventAutopublish: true });
export const ExecutionBudgets = new Mongo.Collection('constellation_execution_budgets', { _preventAutopublish: true });
for (const collection of [ExecutionSettings, ExecutionSecrets, ExecutionJobs, ExecutionBudgets]) collection.deny({ insert: () => true, update: () => true, remove: () => true });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeFailure = Symbol('execution-safe');
const fail = (code, reason) => { const error = new Meteor.Error(code, reason); error[safeFailure] = true; throw error; };
const attachmentFailureHints = {
  'attachment-storage-required': 'Enable the mission filesystem from Files or Mission settings before saving files.',
  'attachment-storage-unavailable': 'This file could not be read from the mission Sprite. Check the filesystem connection and whether the file still exists.',
  'attachment-storage-write-failed': 'The file could not be saved and verified on the mission Sprite. No database copy was stored.',
  'attachment-unavailable': 'This file or its mission conversation is no longer available.',
};
const safeError = (error) => error?.[safeFailure] || error instanceof ExecutionValidationError
  ? { code: error.error, reason: error.reason } : error instanceof SpritesProviderError
    ? { code: `execution-${error.code}`, reason: error.reason } : Object.hasOwn(attachmentFailureHints, error?.error ?? '')
      ? { code: error.error, reason: attachmentFailureHints[error.error] } : { code: 'execution-failed', reason: 'The run could not finish. Check the connection and run history.' };
const publicJob = (job) => { if (!job) return job; const { userId, fingerprint, credentialHash, remoteSessionId, ...rest } = job; return rest; };
const jobFields = { userId: 0, fingerprint: 0, credentialHash: 0, remoteSessionId: 0 };
const CONNECTION_RECHECK_MS = 30_000;
const connectionFailure = (error) => {
  const code = error?.error === 'execution-token-locked' ? 'token-locked'
    : error?.error === 'execution-token-required' ? 'token-required'
      : ['auth', 'key-rejected'].includes(error?.code) ? 'key-rejected'
        : ['network-error', 'provider-busy'].includes(error?.code) ? error.code : 'provider-error';
  const reasons = {
    'key-rejected': 'Sprites rejected this token. Update it in Code settings and test the connection again.',
    'token-locked': 'The saved Sprites token is locked. Unlock the desktop credential store and test the connection again.',
    'token-required': 'Add a Sprites token in Code settings and test the connection.',
    'network-error': 'The connection to Sprites was interrupted. Connection checks can be retried; code and file changes will not be replayed.',
    'provider-busy': 'Sprites is busy. The connection can be checked again shortly.',
    'provider-error': 'Sprites could not complete the connection check. Try again shortly.',
  };
  return { code, reason: reasons[code], retryable: ['network-error', 'provider-busy', 'provider-error'].includes(code) };
};
const connectionReset = { testedAt: '', connectionError: '', connectionErrorCode: '', connectionRetryable: '', connectionRecheckAt: '', connectionRecheckAfter: '', connectorReview: '', approvedConnectorFingerprint: '', connectorApprovedAt: '' };
let indexesReady;
const ensureIndexes = () => (indexesReady ??= Promise.all([
  ExecutionJobs.rawCollection().createIndex({ userId: 1, missionId: 1, createdAt: -1 }),
  ExecutionJobs.rawCollection().createIndex({ userId: 1, createdAt: -1, _id: -1 }),
  ExecutionJobs.rawCollection().createIndex({ status: 1, cleanupPending: 1 }),
  ExecutionJobs.rawCollection().createIndex({ userId: 1, sessionId: 1, toolCallId: 1 }, { unique: true }),
]));

export function createConstellationExecutionService(host, { adapter = spritesAdapter, pollMs = 250, runner = runIsolatedExecution, now = () => Date.now() } = {}) {
  const running = new Map(); const locks = new Map();
  const writeJob = (jobId, fields, guard = {}) => ExecutionJobs.updateAsync({ _id: jobId, erasedAt: { $exists: false }, ...guard }, { $set: fields });
  const locked = async (key, operation) => {
    const previous = locks.get(key) ?? Promise.resolve(); const next = previous.catch(() => {}).then(operation); locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  };
  const owner = async (userId) => { if (!userId) fail('not-authorized', 'Sign in to manage execution.'); await host.requireUser(userId); await ensureIndexes(); };
  const getSettings = async (userId) => {
    await owner(userId);
    await ExecutionSettings.upsertAsync(userId, { $setOnInsert: { userId, enabled: false, connectionStatus: 'untested',
      agentPolicies: {}, domains: [], limits: { ...EXECUTION_DEFAULT_LIMITS }, createdAt: new Date(), updatedAt: new Date() } });
    const settings = await ExecutionSettings.findOneAsync(userId); const secret = await ExecutionSecrets.findOneAsync(userId);
    const keySource = secret?.box ? 'saved' : process.env.SPRITES_TOKEN?.trim() ? 'shell' : null;
    const derived = { providerConfigured: !!keySource, keySource, canStoreSecret: host.canStoreSecret?.() === true };
    if (Object.keys(derived).some((key) => settings[key] !== derived[key])) await ExecutionSettings.updateAsync(userId, { $set: derived });
    return { ...settings, ...derived };
  };
  const tokenFor = async (userId) => {
    const secret = await ExecutionSecrets.findOneAsync(userId);
    if (secret?.box) { try { return await host.decryptSecret(userId, secret.box); } catch { fail('execution-token-locked', 'The saved Sprites token could not be unlocked.'); } }
    const token = process.env.SPRITES_TOKEN?.trim(); if (!token) fail('execution-token-required', 'Add a Sprites token in execution settings.'); return token;
  };
  const rootMission = async (userId, sessionId) => {
    const root = await host.rootMissionSession(executionText(sessionId, 'Mission', 160));
    if (!root || root.userId !== userId || root.erasingAt || root.ephemeral) fail('execution-mission-unavailable', 'Choose an active, saved mission to run code.'); return root;
  };
  const readConnectionReview = async (userId, suppliedToken) => {
    await owner(userId); await getSettings(userId);
    let connectorReview;
    try {
      if (typeof adapter.inspectConnections !== 'function') throw new Error('Unsupported connection inspection');
      const result = await adapter.inspectConnections({ token: suppliedToken ?? await tokenFor(userId) });
      if (!result || !Array.isArray(result.connections)) throw new Error('Invalid connection inventory');
      connectorReview = { status: 'checked', connections: result.connections, fingerprint: digest(result.connections), checkedAt: new Date() };
    } catch {
      connectorReview = { status: 'unknown', connections: [], checkedAt: new Date(), error: 'Connection permissions could not be checked. Retry before starting code or a service.' };
    }
    await owner(userId);
    await ExecutionSettings.updateAsync(userId, { $set: { connectorReview } });
    return connectorReview;
  };
  const checkConnections = async (userId, suppliedToken) => {
    const review = await readConnectionReview(userId, suppliedToken);
    if (review.status !== 'checked') fail('execution-connections-unverified', review.error);
    const settings = await getSettings(userId);
    if (review.connections.length && settings.approvedConnectorFingerprint !== review.fingerprint) {
      fail('execution-connections-review', 'Review Connected APIs in Code settings before starting code or a service. These permissions are separate from allowed websites.');
    }
    return review;
  };
  const reviewConnections = async (userId) => locked(`settings:${userId}`, async () => { await readConnectionReview(userId); return getSettings(userId); });
  const approveConnections = async (userId, { fingerprint }) => locked(`settings:${userId}`, async () => {
    executionText(fingerprint, 'Connection review', 100);
    const review = await readConnectionReview(userId);
    if (review.status !== 'checked' || review.fingerprint !== fingerprint) fail('execution-connections-changed', 'Connection permissions changed. Review the latest list before allowing access.');
    await ExecutionSettings.updateAsync(userId, { $set: { approvedConnectorFingerprint: fingerprint, connectorApprovedAt: new Date() } });
    return getSettings(userId);
  });
  const environments = createExecutionEnvironmentService(host, { adapter, owner, rootMission, tokenFor, getSettings, locked, digest, fail, checkConnections });
  const attachmentStorage = createSpriteAttachmentStorage({ ...host, environments });
  const work = createMissionWorkService(host, { owner, rootMission, jobs: ExecutionJobs, publicJob, fail, attachmentStorage });
  const authorize = async (context, initial) => {
    await owner(context.userId); const root = await rootMission(context.userId, context.sessionId);
    const crew = await host.CrewConfigs.findOneAsync({ userId: context.userId, agent: context.agent, enabled: true, status: { $ne: 'archived' } });
    if (!crew || !await host.missionAllowsAgent(context, context.agent)) fail('execution-access-off', 'This agent no longer has execution access to the mission.');
    await host.requireActiveMissionExecution(context.sessionId, context.agent);
    if (context.signal?.aborted) fail('execution-cancelled', 'The run was cancelled.');
    const settings = await getSettings(context.userId); const policy = normalizeExecutionPolicy(settings.agentPolicies?.[context.agent] ?? {});
    if (!settings.enabled || !settings.providerConfigured || settings.connectionStatus !== 'connected' || policy.run === 'disabled') fail('execution-access-off', 'Execution is unavailable or access is off for this agent.');
    if (initial && (digest(settings.domains) !== initial.domainsHash || (initial.policy === 'auto' && policy.run !== 'auto'))) fail('execution-policy-changed', 'Execution permissions changed during the run.');
    await environments.plan(context.userId, root._id, context.agent);
    return { root, settings, policy };
  };
  const getPolicy = async (userId, agent) => normalizeExecutionPolicy((await getSettings(userId)).agentPolicies?.[agent] ?? {});
  const requireJob = async (userId, jobId) => { await owner(userId); const job = await ExecutionJobs.findOneAsync({ _id: executionText(jobId, 'Run', 160), userId }); if (!job) fail('execution-not-found', 'This run is not available.'); return job; };
  const destroy = async (job, token) => {
    if (!/^constellation-run-[a-f0-9]{32}$/.test(job.workspaceId)) fail('execution-invalid-workspace', 'The run has no valid isolated workspace.');
    if (digest(token) !== job.credentialHash) fail('execution-cleanup-token-changed', 'Restore the original Sprites connection to remove this run’s workspace.');
    try {
      await adapter.destroyWorkspace({ token, workspaceId: job.workspaceId });
      const current = await ExecutionJobs.findOneAsync(job._id);
      if (current?.creationUncertain && current.cleanupRetryAfter > new Date()) {
        await ExecutionJobs.updateAsync(job._id, { $set: { cleanupPending: true, cleanupError: 'Creation was uncertain. Retry cleanup after the provider settles.' } }); return false;
      }
      await ExecutionJobs.updateAsync({ _id: job._id, userId: job.userId }, { $set: { cleanupPending: false, cleanedAt: new Date(), updatedAt: new Date() }, $unset: { cleanupError: '' } });
      await ExecutionJobs.removeAsync({ _id: job._id, userId: job.userId, erasedAt: { $exists: true }, cleanupPending: false });
      return true;
    } catch (error) {
      await ExecutionJobs.updateAsync({ _id: job._id, userId: job.userId }, { $set: { cleanupPending: true, cleanupError: 'Workspace removal is not confirmed. Retry cleanup.', updatedAt: new Date() } });
      return false;
    }
  };
  const saveSettings = async (userId, input = {}) => locked(`settings:${userId}`, async () => {
    await owner(userId); executionObject(input); const current = await getSettings(userId);
    const limits = normalizeExecutionLimits(input.limits ?? current.limits); const domains = normalizeExecutionDomains(input.domains ?? current.domains);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('invalid-execution', 'Enabled must be on or off.');
    const changesToken = !!input.token || input.clearToken === true;
    const candidateToken = input.token ? executionText(input.token, 'Sprites token', 4096) : input.clearToken === true ? process.env.SPRITES_TOKEN?.trim() : null;
    let actualTokenChange = changesToken;
    if (changesToken) {
      const pending = await ExecutionJobs.find({ userId, $or: [{ status: { $in: EXECUTION_ACTIVE_STATES } }, { cleanupPending: true }] }).fetchAsync();
      if (pending.some((job) => !candidateToken || job.credentialHash !== digest(candidateToken))) fail('execution-cleanup-required', 'Stop running jobs and finish workspace cleanup before replacing the token.');
      if (!await environments.tokenChangeAllowed(userId, candidateToken)) fail('execution-environment-token', 'Delete existing retained environments before replacing their Sprites token.');
      try { actualTokenChange = (await tokenFor(userId)) !== candidateToken; } catch {}
    }
    if (input.token) {
      const value = executionText(input.token, 'Sprites token', 4096);
      if (!host.canStoreSecret?.() || !host.encryptSecret) fail('execution-token-locked', 'Use SPRITES_TOKEN in the shell, or launch the desktop app to save a token securely.');
      const box = await host.encryptSecret(userId, value); await ExecutionSecrets.upsertAsync(userId, { $set: { userId, box, updatedAt: new Date() } });
    } else if (input.clearToken === true) await ExecutionSecrets.removeAsync(userId);
    await ExecutionSettings.updateAsync(userId, { $set: { enabled: input.enabled ?? current.enabled, limits, domains,
      ...(actualTokenChange ? { connectionStatus: 'untested' } : {}), updatedAt: new Date() },
      ...(actualTokenChange ? { $unset: connectionReset } : {}) });
    if (digest(domains) !== digest(current.domains)) await environments.applyNetworkPolicy(userId, domains);
    await host.onPolicyChange?.(userId); return getSettings(userId);
  });
  const checkConnection = async (userId, automatic) => {
    await owner(userId); const settings = await getSettings(userId);
    if (automatic) {
      // Never test new credentials or repeatedly challenge rejected/locked ones.
      // A reconnect only repeats safe, read-only connection metadata requests.
      if (!settings.providerConfigured || !settings.testedAt || !['connected', 'error'].includes(settings.connectionStatus)
        || settings.connectionStatus === 'error' && settings.connectionRetryable !== true) return settings;
      const retryAfter = settings.connectionRecheckAfter ?? new Date(new Date(settings.testedAt).getTime() + CONNECTION_RECHECK_MS);
      if (new Date(retryAfter).getTime() > now()) return settings;
    }
    const startedAt = new Date(now());
    await ExecutionSettings.updateAsync(userId, { $set: { connectionRecheckAt: startedAt, connectionRecheckAfter: new Date(startedAt.getTime() + CONNECTION_RECHECK_MS) } });
    let problem; let token;
    try {
      token = await tokenFor(userId); await adapter.testConnection({ token });
    } catch (error) { problem = connectionFailure(error); }
    // Authorization may have changed while the safe provider request was pending.
    // Do not write a result for an owner who no longer has access.
    await owner(userId);
    let tokenChanged = false;
    const verifyCurrentToken = async () => {
      try { tokenChanged = token !== await tokenFor(userId); }
      catch (error) { problem = connectionFailure(error); }
    };
    if (token) await verifyCurrentToken();
    if (!problem && !tokenChanged) {
      await readConnectionReview(userId, token);
      // Saved-token changes are serialized by the settings lock. Recheck after
      // both requests as well, since a host credential store may change outside it.
      await verifyCurrentToken();
    }
    if (tokenChanged) {
      await owner(userId);
      await ExecutionSettings.updateAsync(userId, { $set: { connectionStatus: 'untested' }, $unset: connectionReset });
      await host.onPolicyChange?.(userId);
      if (!automatic) fail('execution-connection-changed', 'The Sprites token changed. Test the current connection again.');
      return getSettings(userId);
    }
    const testedAt = new Date(now());
    await owner(userId);
    await ExecutionSettings.updateAsync(userId, { $set: { connectionStatus: problem ? 'error' : 'connected', connectionRetryable: problem?.retryable ?? false,
      testedAt, connectionRecheckAfter: new Date(testedAt.getTime() + CONNECTION_RECHECK_MS),
      ...(problem ? { connectionError: problem.reason, connectionErrorCode: problem.code } : {}) },
      ...(!problem ? { $unset: { connectionError: '', connectionErrorCode: '' } } : {}) });
    await host.onPolicyChange?.(userId);
    if (problem && !automatic) fail('execution-connection-failed', problem.reason);
    return getSettings(userId);
  };
  const testConnection = async (userId) => locked(`settings:${userId}`, () => checkConnection(userId, false));
  const recheckConnection = async (userId, input = {}) => locked(`settings:${userId}`, async () => {
    executionObject(input); if (Object.keys(input).length) fail('invalid-execution', 'Connection rechecks do not accept settings or credentials.');
    return checkConnection(userId, true);
  });
  const setAgentPolicy = async (userId, input) => locked(`settings:${userId}`, async () => {
    await owner(userId); executionObject(input); const agent = executionText(input.agent, 'Agent', 120);
    if (!/^[a-zA-Z0-9_-]+$/.test(agent) || ['__proto__', 'constructor', 'prototype'].includes(agent)) fail('invalid-execution', 'Choose a valid agent.');
    if (!await host.CrewConfigs.findOneAsync({ userId, agent, status: { $ne: 'archived' } })) fail('execution-agent-unavailable', 'Choose an active workspace agent.');
    const policy = normalizeExecutionPolicy(input.policy); await getSettings(userId);
    await ExecutionSettings.updateAsync(userId, { $set: { [`agentPolicies.${agent}`]: policy, updatedAt: new Date() } }); await host.onPolicyChange?.(userId); return policy;
  });
  const artifactsApi = host.Agent?.attachments ?? Agent.attachments;
  const attachments = host.AgentAttachments ?? AgentAttachments;
  const reserveInputs = async (context, root, input, limits, base = '/workspace/inputs') => {
    const inputs = []; let bytes = 0;
    for (const id of input.inputAttachmentIds) {
      const file = await attachments.findOneAsync({ _id: id, sessionId: { $in: [context.sessionId, root._id] } });
      if (!file) fail('execution-input-unavailable', 'An input attachment does not belong to this conversation or mission.');
      if (!Number.isSafeInteger(file.size) || file.size < 0) fail('execution-input-limit', 'An input file has an invalid size.');
      bytes += file.size;
      if (bytes > limits.maxArtifactBytes) fail('execution-input-limit', 'The selected input files exceed the run’s file limit.');
      const name = String(file.name || 'input').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
      inputs.push({ id, name, path: `${base}/${digest(id).slice(0, 12)}-${name}`, size: file.size });
    }
    return inputs;
  };
  const resultOf = (job, context) => {
    for (const artifact of job.artifacts ?? []) context.attachToResult?.(artifact);
    return { runId: job._id, status: job.status, workspaceMode: job.persistent ? 'retained' : 'disposable', workspacePath: '/workspace', exitCode: job.exitCode ?? null, stdout: job.stdout || '', stderr: job.stderr || '',
      truncated: !!job.truncated, artifacts: job.artifacts || [], cleanupPending: !!job.cleanupPending,
      ...(job.error ? { error: job.error.reason } : {}), ...(job.status === 'unknown' ? { notice: 'Outcome unknown. This request was not replayed.' } : {}) };
  };
  const run = async (context, rawInput) => {
    const input = normalizeExecutionInput(rawInput); const toolCallId = executionText(context.toolCallId, 'Tool call ID', 240);
    const authorized = await authorize(context); const { root } = authorized; let { settings, policy } = authorized;
    const jobId = `execution-${digest([context.userId, context.sessionId, toolCallId]).slice(0, 40)}`;
    const fingerprint = digest(input); let workspaceId = `constellation-run-${digest(jobId).slice(0, 32)}`;
    const reservation = await locked(`settings:${context.userId}`, () => locked(`mission:${context.userId}:${root._id}`, async () => {
      const existing = await ExecutionJobs.findOneAsync(jobId);
      if (existing) { if (existing.fingerprint !== fingerprint) fail('execution-request-conflict', 'This tool call already refers to different code.'); return { existing }; }
      ({ settings, policy } = await authorize(context));
      if (policy.run === 'ask') {
        const session = await (host.getSession?.(context.sessionId) ?? AgentSessions.findOneAsync({ _id: context.sessionId, userId: context.userId }));
        if (session?.pending?.verdict !== 'approved' || session.pending.name !== 'run_code' || session.pending.toolCallId !== toolCallId
          || (session.pending.agent ?? session.agent) !== context.agent
          || digest(normalizeExecutionInput(session.pending.args)) !== fingerprint) fail('execution-approval-required', 'Approve this exact code run in the mission chat first.');
      }
      const token = await tokenFor(context.userId);
      await checkConnections(context.userId, token);
      const environment = await environments.plan(context.userId, root._id, context.agent);
      if (input.outputPaths.length && !environment) fail('execution-filesystem-required', 'Enable this mission’s filesystem before running code that returns files. Open Files or Mission settings.');
      // Only metadata during reservation: remote reads must wait for the run's
      // own lease, so selected inputs do not bypass or fail the visible queue.
      const files = await reserveInputs(context, root, input, settings.limits, environment ? `/workspace/runs/${jobId}/inputs` : undefined);
      if (environment) workspaceId = environment.workspaceId ?? null;
      const budgetId = digest([context.userId, root._id]);
      await ExecutionBudgets.upsertAsync(budgetId, { $setOnInsert: { userId: context.userId, missionId: root._id, runs: 0 } });
      const reserved = await ExecutionBudgets.updateAsync({ _id: budgetId, runs: { $lt: settings.limits.maxRunsPerMission } }, { $inc: { runs: 1 } });
      if (!reserved) fail('execution-run-limit', 'This mission has reached its execution run limit.');
      const job = { _id: jobId, userId: context.userId, sessionId: context.sessionId, missionId: root._id, agent: context.agent, toolCallId,
        title: input.title, language: input.language, code: input.code, inputFiles: files.map(({ content, ...file }) => file), outputPaths: input.outputPaths,
        workspaceId, fingerprint, credentialHash: digest(token), status: environment ? 'queued' : 'preparing', stdout: '', stderr: '', outputBytes: 0, artifacts: [],
        ...(environment ? { persistent: true, environmentId: environment._id } : {}),
        cleanupPending: !environment, createdAt: new Date(), updatedAt: new Date() };
      try { await ExecutionJobs.insertAsync(job); } catch (error) {
        if (error?.code !== 11000) throw error; const raced = await ExecutionJobs.findOneAsync(jobId);
        if (!raced || raced.fingerprint !== fingerprint) fail('execution-request-conflict', 'This tool call already refers to another run.'); return { existing: raced };
      }
      return { job, files, token };
    }));
    if (reservation.existing) return resultOf(reservation.existing, context);
    const { job, files, token } = reservation; const controller = new AbortController();
    let checking = false; let cancelled = false; let timedOut = false; let mayExist = false; let creationUncertain = false; let confirmedExecutionEnd = false; let environmentLease; let output = { stdout: '', stderr: '', outputBytes: 0, truncated: false };
    let liveWrite = Promise.resolve(); let lastWrite = 0; let doneResolve; const done = new Promise((resolve) => { doneResolve = resolve; });
    const abort = () => { if (!controller.signal.aborted) { cancelled = true; controller.abort(); } };
    context.signal?.addEventListener('abort', abort, { once: true }); if (context.signal?.aborted) abort();
    running.set(jobId, { controller, done, userId: context.userId, missionId: root._id });
    const initial = { domainsHash: digest(settings.domains), policy: policy.run };
    const stillAllowed = async () => {
      if (controller.signal.aborted) fail('execution-cancelled', 'The run was cancelled.');
      const current = await ExecutionJobs.findOneAsync(jobId);
      if (!current || current.erasedAt || current.stopRequestedAt || !['queued', 'preparing', 'running'].includes(current.status)) { controller.abort(); fail('execution-cancelled', 'The run was cancelled.'); }
      await authorize({ ...context, signal: controller.signal }, initial);
      if (environmentLease) await environments.assertRun(environmentLease, context.agent);
    };
    const poll = setInterval(() => {
      if (checking) return; checking = true;
      void stillAllowed().catch(abort).finally(() => { checking = false; });
    }, pollMs); poll.unref?.();
    let deadline;
    const startDeadline = () => { deadline = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort(); } }, settings.limits.timeoutSeconds * 1000); deadline.unref?.(); };
    if (!job.persistent) startDeadline();
    const writeOutput = () => {
      const snapshot = { ...output, updatedAt: new Date() };
      liveWrite = liveWrite.catch(() => {}).then(() => writeJob(jobId, snapshot, { status: { $in: ['preparing', 'running'] }, stopRequestedAt: { $exists: false } }));
    };
    try {
      if (job.persistent) {
        environmentLease = await environments.acquireRun({ userId: context.userId, missionId: root._id, agent: context.agent, jobId, token, domains: settings.domains,
          signal: controller.signal, assertActive: stillAllowed, onAcquired: (lease) => { environmentLease = lease; startDeadline(); }, onQueued: () => writeJob(jobId, { status: 'queued' }, { stopRequestedAt: { $exists: false } }) });
        workspaceId = environmentLease.workspaceId;
        await writeJob(jobId, { status: 'preparing', workspaceId }, { status: 'queued', stopRequestedAt: { $exists: false } });
      } else {
      await stillAllowed(); mayExist = true;
      const provisioning = await writeJob(jobId, { provisioningRequestedAt: new Date() }, { status: 'preparing', stopRequestedAt: { $exists: false } });
      if (!provisioning) { controller.abort(); fail('execution-cancelled', 'The run was cancelled.'); }
      try { await adapter.createWorkspace({ token, workspaceId, domains: settings.domains, signal: controller.signal }); }
      catch (error) { creationUncertain = error?.creationUncertain === true; throw error; }
      await writeJob(jobId, { provisioningConfirmedAt: new Date() });
      }
      await stillAllowed();
      const hydrateInputs = async () => {
        const hydrated = [];
        for (const inputFile of files) {
          await stillAllowed();
          const row = await attachments.findOneAsync({ _id: inputFile.id, sessionId: { $in: [context.sessionId, root._id] } });
          if (!row || row.size !== inputFile.size) fail('execution-input-unavailable', 'An input file changed or is no longer available.');
          const content = Buffer.from(await artifactsApi.readContent(row), 'base64');
          if (content.byteLength !== inputFile.size) fail('execution-input-limit', 'An input file no longer matches its saved size.');
          await stillAllowed(); hydrated.push({ ...inputFile, content });
        }
        return hydrated;
      };
      const inputFiles = environmentLease
        ? await attachmentStorage.withLease({ ...environmentLease, signal: controller.signal, assertActive: stillAllowed }, hydrateInputs)
        : await hydrateInputs();
      const extension = { python: 'py', javascript: 'js', shell: 'sh' }[input.language];
      const sourcePath = job.persistent ? `/workspace/runs/${jobId}/main.${extension}` : `/workspace/main.${extension}`;
      await adapter.writeFile({ token, workspaceId, path: sourcePath, content: Buffer.from(input.code), signal: controller.signal });
      await adapter.writeFile({ token, workspaceId, path: '/workspace/inputs/manifest.json', content: Buffer.from(JSON.stringify(files.map(({ content, ...file }) => file))), signal: controller.signal });
      await adapter.writeFile({ token, workspaceId, path: '/workspace/outputs/.constellation', content: Buffer.from(''), signal: controller.signal });
      for (const file of inputFiles) { await stillAllowed(); await adapter.writeFile({ token, workspaceId, path: file.path, content: file.content, signal: controller.signal }); }
      if (job.persistent && input.outputPaths.length) await adapter.clearOutputFiles({ token, workspaceId, paths: input.outputPaths.map((path) => `/workspace/outputs/${path}`), signal: controller.signal });
      await stillAllowed();
      // A retained job may have waited behind other work after reservation.
      // Recheck inherited API grants at dispatch, not only when it was queued.
      await checkConnections(context.userId, token);
      await stillAllowed();
      if (!await writeJob(jobId, { status: 'running', startedAt: new Date(), updatedAt: new Date() }, { status: 'preparing', stopRequestedAt: { $exists: false } })) { controller.abort(); fail('execution-cancelled', 'The run was cancelled.'); }
      const provider = adapter.createSpritesProvider({ token, ...(job.persistent ? { persistent: true, onSession: async (id) => {
        await environments.onSession(environmentLease, id);
        if (!await writeJob(jobId, { remoteSessionId: String(id) }, { stopRequestedAt: { $exists: false } })) fail('execution-cancelled', 'The run was cancelled before execution started.');
      } } : {}) });
      const result = await runner(provider, { workspaceId, command: [{ python: 'python3', javascript: 'node', shell: 'sh' }[input.language], sourcePath],
        timeoutMs: settings.limits.timeoutSeconds * 1000, maxOutputBytes: settings.limits.maxOutputBytes }, {
        signal: controller.signal, onOutput: ({ stream, text: chunk }) => {
          const buffer = Buffer.from(chunk); const remaining = Math.max(0, settings.limits.maxOutputBytes - output.outputBytes);
          const safe = buffer.subarray(0, remaining).toString('utf8'); output[stream === 'stderr' ? 'stderr' : 'stdout'] += safe;
          output.outputBytes += Math.min(buffer.byteLength, remaining); if (buffer.byteLength > remaining) output.truncated = true;
          if (Date.now() - lastWrite > 100) { lastWrite = Date.now(); writeOutput(); }
        },
      });
      output = { stdout: result.stdout, stderr: result.stderr, outputBytes: result.outputBytes, truncated: result.truncated };
      if (!Number.isInteger(result.exitCode)) throw new Error('Execution ended without a confirmed exit status.');
      confirmedExecutionEnd = true;
      await stillAllowed(); const artifacts = []; let exportedBytes = 0;
      for (const [index, path] of input.outputPaths.entries()) {
        await stillAllowed();
        if (exportedBytes >= settings.limits.maxArtifactBytes) fail('execution-artifact-limit', 'Output files exceed this run’s file limit.');
        const read = await adapter.readFile({ token, workspaceId, path: `/workspace/outputs/${path}`, maxBytes: settings.limits.maxArtifactBytes - exportedBytes, signal: controller.signal });
        const content = read instanceof Uint8Array ? read : read?.content;
        if (!(content instanceof Uint8Array)) fail('execution-artifact-invalid', 'An output file could not be read safely.');
        exportedBytes += content.byteLength; if (exportedBytes > settings.limits.maxArtifactBytes) fail('execution-artifact-limit', 'Output files exceed this run’s file limit.');
        await stillAllowed(); const name = input.outputPaths.length > 1 ? `${index + 1}-${path.split('/').at(-1)}` : path.split('/').at(-1);
        const ref = await attachmentStorage.withLease({ ...environmentLease, signal: controller.signal, assertActive: stillAllowed }, () => artifactsApi.create({ sessionId: context.sessionId, toolCallId, name, contentType: typeof read?.contentType === 'string' ? read.contentType : 'application/octet-stream',
          content: { base64: Buffer.from(content).toString('base64') }, attach: true,
          caps: { maxFileBytes: settings.limits.maxArtifactBytes, maxTotalBytes: settings.limits.maxArtifactBytes, maxFiles: 8 } }));
        artifacts.push(ref); await writeJob(jobId, { artifacts, updatedAt: new Date() });
      }
      await liveWrite;
      if (!await writeJob(jobId, { ...output, artifacts, status: result.exitCode === 0 ? 'completed' : 'failed', exitCode: result.exitCode,
        ...(result.exitCode !== 0 ? { error: { code: 'execution-exit', reason: `The command exited with status ${result.exitCode ?? 'unknown'}.` } } : {}), completedAt: new Date(), updatedAt: new Date() },
      { status: 'running', stopRequestedAt: { $exists: false } })) { controller.abort(); fail('execution-cancelled', 'The run was cancelled.'); }
    } catch (error) {
      await liveWrite.catch(() => {});
      if (error?.result) output = { stdout: error.result.stdout || '', stderr: error.result.stderr || '', outputBytes: error.result.outputBytes || 0, truncated: !!error.result.truncated };
      const isCancelled = !timedOut && (cancelled || controller.signal.aborted || error?.code === 'cancelled');
      const known = confirmedExecutionEnd || error?.[safeFailure] || error instanceof ExecutionValidationError || ['timeout', 'output-limit'].includes(error?.code);
      const unconfirmed = ['cleanup-unconfirmed', 'stop-unconfirmed'].includes(error?.code);
      const reason = error?.code === 'stop-unconfirmed' ? 'The remote process could not be confirmed stopped. Reconcile the retained environment before continuing.'
        : error?.code === 'cleanup-unconfirmed' ? 'The run’s outcome and workspace removal are not confirmed. Retry cleanup.'
        : creationUncertain ? 'Workspace creation was not confirmed. This run was not replayed. Retry cleanup shortly.'
        : isCancelled ? 'The run was cancelled.' : timedOut || error?.code === 'timeout' ? 'The run reached its time limit.'
        : error?.code === 'output-limit' ? 'The run reached its output limit.' : safeError(error).reason;
      await writeJob(jobId, { ...output, status: unconfirmed || creationUncertain ? 'unknown' : isCancelled ? 'cancelled' : known || timedOut ? 'failed' : 'unknown',
        ...(creationUncertain ? { creationUncertain: true, cleanupRetryAfter: new Date(Date.now() + 120000) } : {}),
        error: { code: unconfirmed ? `execution-${error.code}` : isCancelled ? 'execution-cancelled' : timedOut ? 'execution-timeout' : safeError(error).code, reason }, completedAt: new Date(), updatedAt: new Date() });
    } finally {
      clearInterval(poll); clearTimeout(deadline); context.signal?.removeEventListener('abort', abort);
      try {
        if (job.persistent) {
          const final = await ExecutionJobs.findOneAsync(jobId);
          if (environmentLease) await environments.release(environmentLease, { uncertain: final?.status === 'unknown', error: final?.error?.reason });
          await ExecutionJobs.removeAsync({ _id: jobId, erasedAt: { $exists: true } });
        } else {
        if (creationUncertain) await ExecutionJobs.updateAsync(jobId, { $set: { creationUncertain: true, cleanupPending: true, cleanupRetryAfter: new Date(Date.now() + 120000), cleanupError: 'Creation was uncertain. Retry cleanup after the provider settles.' } });
        if (mayExist) await destroy(job, token).catch(() => {});
        else await ExecutionJobs.updateAsync(jobId, { $set: { cleanupPending: false } });
        }
      } finally { running.delete(jobId); doneResolve(); }
    }
    return resultOf(await ExecutionJobs.findOneAsync(jobId) ?? { _id: jobId, status: 'cancelled' }, context);
  };
  const stop = async (userId, { jobId }) => {
    const job = await requireJob(userId, jobId);
    if (!EXECUTION_ACTIVE_STATES.includes(job.status)) return publicJob(job);
    const stopped = await ExecutionJobs.updateAsync({ _id: jobId, userId, status: { $in: EXECUTION_ACTIVE_STATES }, erasedAt: { $exists: false } },
      { $set: { status: 'stopping', stopRequestedAt: new Date(), updatedAt: new Date() } });
    if (!stopped) return publicJob(await ExecutionJobs.findOneAsync({ _id: jobId, userId }));
    const live = running.get(jobId);
    live?.controller.abort();
    if (!live) {
      const provisioningUnknown = job.provisioningRequestedAt && !job.provisioningConfirmedAt;
      if (!provisioningUnknown && !job.persistent) await destroy(job, await tokenFor(userId));
      await ExecutionJobs.updateAsync(jobId, { $set: { status: 'unknown', error: { code: 'execution-interrupted', reason: 'The app lost this run. It was not replayed.' }, completedAt: new Date() } });
      if (provisioningUnknown) await ExecutionJobs.updateAsync(jobId, { $set: { creationUncertain: true, cleanupPending: true, cleanupRetryAfter: new Date(Date.now() + 120000) } });
    }
    return publicJob(await ExecutionJobs.findOneAsync(jobId));
  };
  const cleanup = async (userId, { jobId }) => {
    const job = await requireJob(userId, jobId); if (running.has(jobId)) fail('execution-still-running', 'Stop this run before cleaning up its workspace.');
    if (job.persistent) fail('execution-retained-environment', 'Use the mission environment controls to reconcile or delete retained files.');
    if (!job.cleanupPending) return publicJob(job);
    if (job.creationUncertain && job.cleanupRetryAfter > new Date()) fail('execution-cleanup-settling', 'Wait up to two minutes for provisioning to settle, then retry cleanup.');
    await destroy(job, await tokenFor(userId)); return publicJob(await ExecutionJobs.findOneAsync(jobId));
  };
  const recover = async ({ userId } = {}) => {
    const scope = userId ? { userId } : {};
    await environments.recover({ userId });
    await ExecutionJobs.updateAsync({ ...scope, status: 'preparing', provisioningRequestedAt: { $exists: true }, provisioningConfirmedAt: { $exists: false } },
      { $set: { creationUncertain: true, cleanupRetryAfter: new Date(Date.now() + 120000) } }, { multi: true });
    await ensureIndexes(); await ExecutionJobs.updateAsync({ ...scope, status: { $in: EXECUTION_ACTIVE_STATES }, persistent: { $ne: true } }, { $set: { status: 'unknown', cleanupPending: true,
      error: { code: 'execution-interrupted', reason: 'The app restarted before completion was confirmed. This run was not replayed.' }, completedAt: new Date(), updatedAt: new Date() } }, { multi: true });
    await ExecutionJobs.updateAsync({ ...scope, status: { $in: EXECUTION_ACTIVE_STATES }, persistent: true }, { $set: { status: 'unknown', cleanupPending: false,
      error: { code: 'execution-interrupted', reason: 'The app restarted during a retained-environment run. Reconcile the environment before continuing.' }, completedAt: new Date(), updatedAt: new Date() } }, { multi: true });
    const jobs = await ExecutionJobs.find({ ...scope, cleanupPending: true, persistent: { $ne: true } }).fetchAsync();
    for (const job of jobs) { if (job.creationUncertain && job.cleanupRetryAfter > new Date()) continue; try { await destroy(job, await tokenFor(job.userId)); } catch {} }
  };
  const scrubSession = async (sessionId) => {
    const selector = { $or: [{ sessionId }, { missionId: sessionId }] };
    const jobs = await ExecutionJobs.find(selector).fetchAsync();
    for (const job of jobs) {
      const live = running.get(job._id); live?.controller.abort();
      const keep = !!live || job.cleanupPending || EXECUTION_ACTIVE_STATES.includes(job.status);
      if (!keep) { await ExecutionJobs.removeAsync(job._id); continue; }
      await ExecutionJobs.updateAsync(job._id, { $set: { erasedAt: new Date(), title: 'Deleted conversation · cleanup pending', status: 'unknown', cleanupPending: !job.persistent,
        ...(job.provisioningRequestedAt && !job.provisioningConfirmedAt ? { creationUncertain: true, cleanupRetryAfter: new Date(Date.now() + 120000) } : {}),
        error: { code: 'execution-source-deleted', reason: 'Conversation deleted. Remote workspace cleanup is pending.' }, updatedAt: new Date() },
        $unset: { code: '', stdout: '', stderr: '', inputFiles: '', outputPaths: '', artifacts: '', fingerprint: '', language: '', outputBytes: '', truncated: '' } });
    }
    await ExecutionBudgets.removeAsync({ missionId: sessionId });
    await work.scrubFileSession?.(sessionId);
    await environments.scrubMission(sessionId);
  };
  const toolEntitlement = async (context, agent) => { try { const { policy } = await authorize({ ...context, agent }); return policy.run === 'ask' ? 'ask' : true; } catch { return false; } };
  const inspectionEntitlement = async (context, agent) => {
    try {
      await owner(context.userId); await rootMission(context.userId, context.sessionId);
      const crew = await host.CrewConfigs.findOneAsync({ userId: context.userId, agent, enabled: true, status: { $ne: 'archived' } });
      return !!crew && await host.missionAllowsAgent(context, agent) && (await getPolicy(context.userId, agent)).run !== 'disabled';
    } catch { return false; }
  };
  const inspectRun = async (context, { runId }) => {
    if (!await inspectionEntitlement(context, context.agent)) fail('execution-access-off', 'This agent no longer has access to code run history.');
    const root = await rootMission(context.userId, context.sessionId);
    const job = await requireJob(context.userId, runId);
    if (job.erasedAt || job.missionId !== root._id) fail('execution-not-found', 'Choose a code run from this mission.');
    if (job.persistent) {
      const environment = await ExecutionEnvironments.findOneAsync({ userId: context.userId, missionId: root._id });
      if (!environment?.allowedAgents?.includes(context.agent)) fail('execution-environment-access', 'This agent cannot inspect the mission’s retained files or output.');
    }
    return { ...resultOf(job, context), title: job.title, agent: job.agent, createdAt: job.createdAt, completedAt: job.completedAt,
      ...(job.persistent ? { environmentStatus: (await environments.getEnvironment(context.userId, { missionId: root._id })).status } : {}),
      nextAction: job.status === 'unknown' ? 'Ask the owner to open this mission’s Files tab, then Environment settings, and check the environment. Do not rerun this request automatically.' : null };
  };
  const toolDefinitions = (agent) => [{ name: 'run_code', description: 'Run foreground Python, JavaScript, or shell scripts in a remote mission Sprite, never on the user’s computer. Code controls this environment’s files, packages, services and checkpoints: use only trusted code and dependencies. Use owner-managed Services for background servers; do not start hidden services or keepalive tasks. Disposable runs return console output only. To save or return files via outputPaths, the owner must enable Mission filesystem and grant this agent access first. Retained /workspace files and earlier inputs are shared with other allowed mission agents. Source and selected inputs use per-run paths under /workspace/runs/; /workspace/inputs/manifest.json maps selected attachment IDs to paths. Only selected mission attachments are copied into the run. Write outputPaths under /workspace/outputs/; those files are cleared before each run and selected results are preserved under /workspace/attachments in the same Sprite, never in Mongo. Ordinary website access requires allowed domains; Sprites connected APIs have separate organization permissions and charges. Do not use connected APIs for actions outside the mission approval or budget. No host files or raw app credentials are supplied. Use the mission file tools for ordinary file tasks. File deletion always requires human confirmation; never use code to bypass that review. Check existing files before changing them, request a save point before risky work, and verify results. One call is one run. Use inspect_code_run for an unknown outcome; never replay it automatically.',
    args: { type: 'object', properties: { title: { type: 'string', maxLength: 120 }, language: { type: 'string', enum: ['python', 'javascript', 'shell'] }, code: { type: 'string', maxLength: 32000 },
      inputAttachmentIds: { type: 'array', maxItems: 8, items: { type: 'string' } }, outputPaths: { type: 'array', maxItems: 8, items: { type: 'string' } } }, required: ['title', 'language', 'code'], additionalProperties: false },
    describe: ({ title, language }) => `Run ${language} code: ${title}. Code can change this mission’s remote environment. Selected files are sent to Sprites.`, gate: (context) => toolEntitlement(context, agent), run: (input, context) => run({ ...context, agent }, input) },
    { name: 'inspect_code_run', description: 'Read the recorded status, output and results of an exact code run in this mission. Does not execute, resume, replay or wake a Sprite. Unknown outcomes remain unknown until the owner checks the environment.',
      args: { type: 'object', properties: { runId: { type: 'string', maxLength: 160 } }, required: ['runId'], additionalProperties: false },
      describe: () => 'Inspect a code run', gate: (context) => inspectionEntitlement(context, agent), run: (input, context) => inspectRun({ ...context, agent }, input) }];
  return { getSettings, getPolicy, saveSettings, testConnection, recheckConnection, setAgentPolicy, reviewConnections, approveConnections, run, inspectRun, inspectionEntitlement, stop, cleanup, recover, scrubSession, toolDefinitions, toolEntitlement, attachmentStorage,
    ...work,
    ...createMissionFileTools(host, { owner, rootMission, work, environments, fail }),
    ...Object.fromEntries(['getEnvironment', 'saveEnvironment', 'enableFilesystem', 'environmentFiles', 'readEnvironmentFile', 'mutateEnvironmentFile', 'uploadChatFile', 'savePoint', 'restoreSavePoint', 'refreshSavePoints', 'deleteSavePoint', 'recoverEnvironmentFile', 'listPreviews', 'savePreview', 'startPreview', 'stopPreview', 'deletePreview', 'privatePreview', 'deleteEnvironment', 'reconcileEnvironment', 'onMissionCompleted'].map((name) => [name, environments[name]])),
    async authorizeMission(userId, missionId) { await owner(userId); const root = await rootMission(userId, missionId); if (root._id !== missionId) fail('execution-mission-unavailable', 'Choose the root mission.'); return root._id; },
    async workspaceJobsCursor(userId) { await owner(userId);
      return ExecutionJobs.find({ userId, erasedAt: { $exists: false } }, { fields: jobFields, sort: { createdAt: -1, _id: -1 }, limit: 100 }); },
    async history(userId, { missionId, limit = 50 } = {}) { await owner(userId); const query = { userId, erasedAt: { $exists: false } }; if (missionId) query.missionId = (await rootMission(userId, missionId))._id;
      return (await ExecutionJobs.find(query, { sort: { createdAt: -1, _id: -1 }, limit: Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 50)) }).fetchAsync()).map(publicJob); },
    async readArtifact(userId, { jobId, attachmentId }) { const job = await requireJob(userId, jobId); if (!job.artifacts?.some((ref) => ref.id === attachmentId)) fail('execution-artifact-unavailable', 'This file does not belong to the run.');
      return work.readMissionFile(userId, { missionId: job.missionId, attachmentId }); },
    async stopMissionExecutions(userId, missionId) { const jobs = await ExecutionJobs.find({ userId, missionId, status: { $in: EXECUTION_ACTIVE_STATES } }).fetchAsync(); for (const job of jobs) await stop(userId, { jobId: job._id }); },
    // Application operation fence, not proof that every guest process/service
    // is stopped. Services and trusted guest code have environment-wide authority.
    async missionExecutionsQuiescent(userId, missionId) { return !(await ExecutionJobs.findOneAsync({ userId, missionId, $or: [{ status: { $in: EXECUTION_ACTIVE_STATES } }, { cleanupPending: true }] }))
      && !(await ExecutionEnvironments.findOneAsync({ userId, missionId, $or: [{ operationId: { $exists: true } }, { deletionRequestedAt: { $exists: true } }, { status: { $in: ['busy', 'needs-attention', 'deleting'] } }] })); },
  };
}

export function createExecutionMethods(service, ready = Promise.resolve()) {
  return Object.fromEntries(['saveSettings', 'testConnection', 'recheckConnection', 'setAgentPolicy', 'reviewConnections', 'approveConnections', 'history', 'historyPage', 'getRun', 'missionFiles', 'readMissionFile', 'migrateMissionFiles', 'stop', 'cleanup', 'readArtifact', 'getEnvironment', 'saveEnvironment', 'enableFilesystem', 'environmentFiles', 'readEnvironmentFile', 'mutateEnvironmentFile', 'uploadChatFile', 'savePoint', 'restoreSavePoint', 'refreshSavePoints', 'deleteSavePoint', 'recoverEnvironmentFile', 'listPreviews', 'savePreview', 'startPreview', 'stopPreview', 'deletePreview', 'privatePreview', 'deleteEnvironment', 'reconcileEnvironment'].map((name) => [`constellation.execution.${name}`, async function (input = {}) {
    try { await ready; return await service[name](this.userId, input); } catch (error) { const safe = safeError(error); throw new Meteor.Error(safe.code, safe.reason); }
  }]));
}
let installed;
export function installConstellationExecution(host, options) {
  if (installed) return installed; const service = createConstellationExecutionService(host, options); installed = service;
  // App-wide policy: a failed/unavailable Sprite never falls back to database bytes.
  (host.Agent ?? Agent).attachments.configureStorage(service.attachmentStorage);
  const ready = service.recover(); ready.catch(() => { console.error('[constellation] Execution recovery could not finish.'); });
  Meteor.startup(async () => {
    await ready;
    await sweepOrphanMissionFiles();
    await AgentSessions.find({}, { fields: { erasingAt: 1 } }).observeChangesAsync({
      added(id, fields) { if (fields.erasingAt) void service.scrubSession(id).catch(() => {}); },
      changed(id, fields) { if (fields.erasingAt) void service.scrubSession(id).catch(() => {}); },
      removed(id) { void service.scrubSession(id).catch(() => {}); },
    });
    for (const [collection, sourceField] of [[ExecutionJobs, 'sessionId'], [ExecutionEnvironments, 'missionId']]) {
      let after;
      for (;;) {
        const rows = await collection.find(after ? { _id: { $gt: after } } : {}, { fields: { [sourceField]: 1 }, sort: { _id: 1 }, limit: 100 }).fetchAsync();
        for (const row of rows) if (!await AgentSessions.findOneAsync(row[sourceField], { fields: { _id: 1 } })) await service.scrubSession(row[sourceField]);
        if (rows.length < 100) break; after = rows.at(-1)._id;
      }
    }
  });
  Meteor.methods(createExecutionMethods(service, ready));
  Meteor.publish('constellation.execution', async function () { if (!this.userId) return this.ready(); await ready; await service.getSettings(this.userId);
    return [ExecutionSettings.find(this.userId, { fields: { userId: 0 } }), ExecutionJobs.find({ userId: this.userId, erasedAt: { $exists: true }, cleanupPending: true }, { fields: jobFields, limit: 100 })]; });
  Meteor.publish('constellation.execution.missionJobs', async function (missionId) { if (!this.userId) return this.ready(); await ready; await service.authorizeMission(this.userId, missionId);
    return ExecutionJobs.find({ userId: this.userId, missionId }, { fields: jobFields, sort: { createdAt: -1 }, limit: 100 }); });
  Meteor.publish('constellation.execution.workspaceJobs', async function () {
    if (!this.userId) return this.ready(); await ready; return service.workspaceJobsCursor(this.userId);
  });
  Meteor.publish('constellation.execution.environments', async function () {
    if (!this.userId) return this.ready(); await ready; await service.getSettings(this.userId);
    return ExecutionEnvironments.find({ userId: this.userId }, { fields: ENVIRONMENT_PUBLIC_FIELDS, sort: { updatedAt: -1 } });
  });
  DDPRateLimiter.addRule({ type: 'method', name: (name) => name.startsWith('constellation.execution.'), userId: (id) => !!id }, 60, 60_000);
  return service;
}
