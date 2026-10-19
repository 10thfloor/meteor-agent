import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Agent } from 'meteor/10thfloor:agent';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { executionObject, executionText, normalizeEnvironmentPath } from '../imports/constellation/execution';
import { normalizeWorkspaceMutation } from './sprites-workspace-control.js';
import { attachmentStoragePath } from './sprite-attachment-path.js';

export const ExecutionEnvironments = new Mongo.Collection('constellation_execution_environments', { _preventAutopublish: true });
ExecutionEnvironments.deny({ insert: () => true, update: () => true, remove: () => true });
export const ExecutionFileRequests = new Mongo.Collection('constellation_execution_file_requests', { _preventAutopublish: true });
ExecutionFileRequests.deny({ insert: () => true, update: () => true, remove: () => true });
export const ENVIRONMENT_PUBLIC_FIELDS = { userId: 0, credentialHash: 0, operationId: 0, remoteSessionId: 0, helperSessionId: 0, helperPreviousRecoveryKind: 0, checkpointAttempt: 0 };
export const publicEnvironment = (row) => {
  if (!row) return row; const { userId, credentialHash, operationId, remoteSessionId, helperSessionId, helperPreviousRecoveryKind, checkpointAttempt, ...value } = row; return value;
};
const defaults = (missionId) => ({ missionId, keepFiles: false, allowedAgents: [], retention: 'keep', status: 'not-created', savePoints: [], previews: [], recoveredFiles: [] });
let indexes;
let fileRequestIndex;

/** A trusted mission environment shares files and guest management authority.
 * Leases serialize app-issued operations, not guest services or detached code. */
export function createExecutionEnvironmentService(host, dependencies) {
  const { adapter, owner, rootMission, tokenFor, getSettings, locked, digest, fail } = dependencies;
  const checkConnections = dependencies.checkConnections ?? (async () => {});
  const healthy = (point) => point?.healthy !== false && !point?.health;
  const artifactApi = host.Agent?.attachments ?? Agent.attachments;
  const attachmentLeases = new AsyncLocalStorage();
  const ensure = () => (indexes ??= ExecutionEnvironments.rawCollection().createIndex({ userId: 1, missionId: 1 }, { unique: true }));
  const idFor = (userId, missionId) => `environment-${digest([userId, missionId]).slice(0, 40)}`;
  const raw = async (userId, missionId, { allowErased = false } = {}) => {
    await owner(userId); await ensure(); executionText(missionId, 'Mission', 160);
    const row = await ExecutionEnvironments.findOneAsync({ _id: idFor(userId, missionId), userId });
    if (allowErased && row?.erasedAt) return row;
    const root = await rootMission(userId, missionId);
    if (root._id !== missionId) fail('execution-environment-mission', 'Choose a root mission.');
    if (row?.erasedAt) fail('execution-environment-erased', 'This mission was deleted. Only environment cleanup is available.');
    return row;
  };
  const getEnvironment = async (userId, { missionId }) => publicEnvironment(await raw(userId, missionId, { allowErased: true })) ?? defaults(missionId);
  const token = async (row) => {
    const value = await tokenFor(row.userId);
    if (row.credentialHash && row.credentialHash !== digest(value)) fail('execution-environment-token', 'Restore the original Sprites token to access this environment.'); return value;
  };
  const binding = (row) => {
    if (!row?.workspaceId || !/^constellation-mission-[a-f0-9]{32}$/.test(row.workspaceId)) fail('execution-environment-missing', 'Enable mission filesystem to create this workspace.');
  };
  const saveEnvironment = async (userId, input) => locked(`settings:${userId}`, async () => {
    executionObject(input); const { missionId } = input; const prior = await raw(userId, missionId);
    if (typeof input.keepFiles !== 'boolean' || !['keep', 'delete-on-completion'].includes(input.retention)
      || !Array.isArray(input.allowedAgents) || input.allowedAgents.length > 12) fail('invalid-execution-environment', 'Choose retention and the agents allowed to use these files.');
    const agents = [...new Set(input.allowedAgents)];
    for (const agent of agents) {
      if (typeof agent !== 'string' || !await host.CrewConfigs.findOneAsync({ userId, agent, enabled: true, status: { $ne: 'archived' } })
        || !await host.missionAllowsAgent({ userId, sessionId: missionId }, agent)) fail('execution-environment-agent', 'Choose active agents in this mission’s crew.');
    }
    const id = idFor(userId, missionId);
    if (!prior) {
      await ExecutionEnvironments.upsertAsync(id, { $setOnInsert: { ...defaults(missionId), userId, createdAt: new Date(), updatedAt: new Date() } });
    }
    // Removing a grant is a live revocation. Never add grants/change retention
    // underneath an active operation, but let polling cancel revoked writers.
    const revocationOnly = prior?.operationId && input.retention === prior.retention
      && agents.every((agent) => prior.allowedAgents.includes(agent)) && (!input.keepFiles || prior.keepFiles);
    const changed = await ExecutionEnvironments.updateAsync({ _id: id, ...(!revocationOnly ? { operationId: { $exists: false } } : {}), erasedAt: { $exists: false }, status: { $ne: 'deleting' } },
      { $set: { keepFiles: input.keepFiles, allowedAgents: agents, retention: input.retention, updatedAt: new Date() } });
    if (!changed) fail('execution-environment-busy', 'Wait for the environment’s current operation to finish.');
    try { await rootMission(userId, missionId); } catch (error) { await scrubMission(missionId); throw error; }
    return getEnvironment(userId, { missionId });
  });
  const plan = async (userId, missionId, agent) => {
    const row = await ExecutionEnvironments.findOneAsync({ userId, missionId });
    if (!row?.keepFiles) return null;
    if (row.erasedAt || !row.allowedAgents?.includes(agent)) fail('execution-environment-access', 'This agent is not allowed to use the mission’s retained files.');
    if (['needs-attention', 'deleting'].includes(row.status) || row.deletionRequestedAt) fail('execution-environment-attention', 'Resolve this environment’s pending operation before running more code.');
    return row;
  };
  const attention = async (id, operationId, message) => {
    await ExecutionEnvironments.updateAsync({ _id: id, ...(operationId ? { operationId } : {}) }, { $set: { status: 'needs-attention', error: message, updatedAt: new Date() },
      $unset: { operationId: '', currentJobId: '' } });
  };
  const destroy = async (row) => {
    if (!row) return;
    const deleteId = `delete-${Random.id()}`;
    if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: { $exists: false } }, { $set: { operationId: deleteId, operationKind: 'delete', status: 'deleting', deletionRequestedAt: row.deletionRequestedAt ?? new Date(), updatedAt: new Date() } })) return;
    const selector = { _id: row._id, operationId: deleteId };
    row = await ExecutionEnvironments.findOneAsync(selector); if (!row) return;
    if (!row.workspaceId) {
      if (row.erasedAt) await ExecutionEnvironments.removeAsync(selector);
      else await ExecutionEnvironments.updateAsync(selector, { $set: { keepFiles: false, status: 'not-created', updatedAt: new Date() }, $unset: { deletionRequestedAt: '', operationId: '', operationKind: '', checkpointDeletionSupported: '', error: '' } });
      return;
    }
    try {
      binding(row); const value = await token(row);
      await adapter.destroyWorkspace({ token: value, workspaceId: row.workspaceId });
      if (row.creationUncertain && row.cleanupRetryAfter > new Date()) throw new Error('provisioning-in-flight');
      const current = await ExecutionEnvironments.findOneAsync(selector); if (!current) return;
      if (current.erasedAt) await ExecutionEnvironments.removeAsync(selector);
      else await ExecutionEnvironments.updateAsync(selector, { $set: { keepFiles: false, status: 'not-created', savePoints: [], updatedAt: new Date() },
        $unset: { workspaceId: '', credentialHash: '', remoteSessionId: '', helperSessionId: '', helperPreviousRecoveryKind: '', currentJobId: '', operationId: '', operationKind: '', helperOperationKind: '', recoveryKind: '', checkpointAttempt: '', checkpointDeletion: '', checkpointDeletionSupported: '', fileMutation: '', attachmentWriteUnconfirmed: '', lastFileMutation: '', fileRevision: '', policyUnconfirmed: '', error: '', deletionRequestedAt: '', creationUncertain: '', cleanupRetryAfter: '', provisioningRequestedAt: '', provisioningConfirmedAt: '', restoreRequestedAt: '', restoreTarget: '', lastRestoredSavePointId: '', restoredAt: '', previews: '', previewOperation: '', savePointsCheckedAt: '' } });
    } catch { await attention(row._id, deleteId, 'Environment removal is not confirmed. Retry deletion after provisioning settles.'); }
  };
  const release = async (lease, { uncertain = false, error } = {}) => {
    const row = await ExecutionEnvironments.findOneAsync({ _id: lease.environmentId, operationId: lease.operationId }); if (!row) return;
    uncertain = uncertain || !!row.policyUnconfirmed || !!row.attachmentWriteUnconfirmed || !!lease.preserveAttention;
    await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: lease.operationId }, { $set: { status: uncertain ? 'needs-attention' : 'ready', updatedAt: new Date(),
      ...(uncertain && !row.recoveryKind ? { recoveryKind: row.operationKind ?? 'run' } : {}),
      ...(uncertain ? { error: error || 'The previous operation’s outcome is unknown. Reconcile before continuing.' } : {}) },
      $unset: { operationId: '', currentJobId: '', operationKind: '', ...(!uncertain ? { error: '', remoteSessionId: '', helperSessionId: '', helperPreviousRecoveryKind: '', helperOperationKind: '', recoveryKind: '', checkpointAttempt: '' } : {}) } });
    const current = await ExecutionEnvironments.findOneAsync(row._id);
    if (current?.deletionRequestedAt || current?.erasedAt) await destroy(current).catch(() => attention(row._id, null, 'Restore the original connection, then retry environment deletion.'));
  };
  const acquireRun = async ({ userId, missionId, agent, jobId, token: value, domains, signal, assertActive, onQueued, onAcquired }) => {
    let row;
    for (;;) {
      await assertActive(); row = await plan(userId, missionId, agent);
      if (!row) fail('execution-environment-disabled', 'Retained files were turned off before this run started. Send a new request to run without them.');
      if (row.credentialHash && row.credentialHash !== digest(value)) fail('execution-environment-token', 'Restore the original Sprites connection to use these files.');
      if (!row.operationId && await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: { $exists: false }, status: { $in: ['ready', 'not-created'] }, keepFiles: true, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } },
        { $set: { operationId: jobId, operationKind: 'run', currentJobId: jobId, status: 'busy', updatedAt: new Date() } })) break;
      await onQueued?.(); await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal?.aborted) fail('execution-cancelled', 'The queued run was cancelled.');
    }
    // A deleted generation is never reused: an old timed-out remote DELETE
    // must not be able to remove a subsequently created environment.
    const lease = { environmentId: row._id, operationId: jobId, workspaceId: row.workspaceId ?? `constellation-mission-${digest([userId, missionId, Random.id()]).slice(0, 32)}` };
    try {
      await onAcquired?.(lease); await assertActive(); await assertRun(lease, agent);
      if (!row.workspaceId) {
        if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: jobId, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } }, { $set: { workspaceId: lease.workspaceId, credentialHash: digest(value), provisioningRequestedAt: new Date(), operationKind: 'provision', updatedAt: new Date() }, $unset: { checkpointDeletionSupported: '' } })) fail('execution-environment-access', 'This environment is no longer available.');
        await assertActive(); await assertRun(lease, agent);
        try { await locked(`environment-network:${row._id}`, async () => adapter.createWorkspace({ token: value, workspaceId: lease.workspaceId, domains: (await getSettings(userId)).domains, signal })); }
        catch (error) {
          if (error?.creationUncertain) await ExecutionEnvironments.updateAsync(row._id, { $set: { creationUncertain: true, cleanupRetryAfter: new Date(Date.now() + 120000) } });
          throw error;
        }
        if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: jobId, erasedAt: { $exists: false } }, { $set: { provisioningConfirmedAt: new Date(), operationKind: 'run' } })) fail('execution-environment-access', 'This environment was deleted while provisioning.');
      } else {
        await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: jobId }, { $set: { operationKind: 'policies' } });
        await locked(`environment-network:${row._id}`, async () => adapter.applyPolicies({ token: value, workspaceId: row.workspaceId, domains: (await getSettings(userId)).domains, signal }));
        await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: jobId }, { $set: { operationKind: 'run' } });
      }
      await assertActive(); await assertRun(lease, agent); return lease;
    } catch (error) { await release(lease, { uncertain: true }); throw error; }
  };
  const assertRun = async (lease, agent) => {
    const row = await ExecutionEnvironments.findOneAsync({ _id: lease.environmentId, operationId: lease.operationId, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } });
    if (!row || !row.keepFiles || !row.allowedAgents?.includes(agent) || row.policyUnconfirmed) fail('execution-environment-access', 'Access to these retained files changed during the run.');
  };
  const assertFilesystemRetention = async (userId, missionId, row) => {
    if (row?.retention !== 'delete-on-completion') return;
    const root = await rootMission(userId, missionId);
    const mission = await host.MissionConfigs?.findOneAsync({ _id: missionId, userId });
    if (root.archived || ['completed', 'archived'].includes(mission?.status)) {
      fail('execution-filesystem-completed', 'Reactivate this mission or change filesystem retention to “Until I delete the environment” before enabling it.');
    }
  };
  const enableFilesystem = async (userId, { missionId }) => {
    const reserved = await locked(`settings:${userId}`, async () => {
      const prior = await raw(userId, missionId); await assertFilesystemRetention(userId, missionId, prior);
      const settings = await getSettings(userId);
      if (!settings.providerConfigured || settings.connectionStatus !== 'connected') fail('execution-connection-required', 'Connect Sprites in Code settings before enabling this mission’s filesystem.');
      const value = await tokenFor(userId); await checkConnections(userId, value);
      if (prior?.credentialHash && prior.credentialHash !== digest(value)) fail('execution-environment-token', 'Restore the original Sprites connection to access this environment.');
      if (prior?.operationId) fail('execution-environment-busy', 'Wait for the current environment operation to finish.');
      if (prior?.erasedAt || prior?.deletionRequestedAt || ['needs-attention', 'deleting'].includes(prior?.status)) fail('execution-environment-attention', 'Reconcile the environment before enabling its filesystem.');
      const id = idFor(userId, missionId);
      if (!prior) {
        const crew = await host.CrewConfigs.find({ userId, enabled: true, status: { $ne: 'archived' } }).fetchAsync();
        const allowedAgents = [];
        for (const member of crew) if (await host.missionAllowsAgent({ userId, sessionId: missionId }, member.agent)) allowedAgents.push(member.agent);
        await ExecutionEnvironments.insertAsync({ _id: id, ...defaults(missionId), userId, allowedAgents, createdAt: new Date(), updatedAt: new Date() });
      }
      // Erasure may finish while connection review or crew lookup is pending.
      // Do not leave a newly inserted row behind that the erasure observer missed.
      try { await rootMission(userId, missionId); } catch (error) { await scrubMission(missionId); throw error; }
      await assertFilesystemRetention(userId, missionId, prior);
      if (prior?.workspaceId) {
        if (!await ExecutionEnvironments.updateAsync({ _id: id, workspaceId: prior.workspaceId, operationId: { $exists: false }, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false }, status: 'ready' }, { $set: { keepFiles: true, updatedAt: new Date() } })) fail('execution-environment-busy', 'Another environment operation has started.');
        return { existing: true };
      }
      const operationId = `filesystem-${Random.id()}`;
      const workspaceId = `constellation-mission-${digest([userId, missionId, Random.id()]).slice(0, 32)}`;
      if (!await ExecutionEnvironments.updateAsync({ _id: id, operationId: { $exists: false }, workspaceId: { $exists: false }, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false }, status: 'not-created' }, { $set: {
        keepFiles: true, workspaceId, credentialHash: digest(value), operationId, operationKind: 'provision', status: 'busy', updatedAt: new Date(),
      }, $unset: { checkpointDeletionSupported: '' } })) fail('execution-environment-busy', 'Another environment operation has started.');
      return { value, lease: { environmentId: id, operationId, workspaceId } };
    });
    if (reserved.existing) return getEnvironment(userId, { missionId });
    const { value, lease } = reserved;
    let provisioningStarted = false;
    try {
      await locked(`environment-network:${lease.environmentId}`, async () => {
        try { await rootMission(userId, missionId); } catch (error) { await scrubMission(missionId); throw error; }
        await checkConnections(userId, value);
        const domains = (await getSettings(userId)).domains;
        await assertFilesystemRetention(userId, missionId, await ExecutionEnvironments.findOneAsync(lease.environmentId));
        if (!await ExecutionEnvironments.updateAsync({ _id: lease.environmentId, operationId: lease.operationId, keepFiles: true, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } }, { $set: { provisioningRequestedAt: new Date() } })) fail('execution-environment-erased', 'This mission is no longer available.');
        provisioningStarted = true;
        await adapter.createWorkspace({ token: value, workspaceId: lease.workspaceId, domains });
      });
      if (!await ExecutionEnvironments.updateAsync({ _id: lease.environmentId, operationId: lease.operationId, erasedAt: { $exists: false } }, { $set: { provisioningConfirmedAt: new Date() } })) fail('execution-environment-erased', 'This mission was deleted while provisioning.');
      await assertFilesystemRetention(userId, missionId, await ExecutionEnvironments.findOneAsync(lease.environmentId));
      await release(lease);
      return getEnvironment(userId, { missionId });
    } catch (error) {
      if (!provisioningStarted) {
        await ExecutionEnvironments.updateAsync({ _id: lease.environmentId, operationId: lease.operationId }, { $set: { status: 'not-created', updatedAt: new Date() },
          $unset: { workspaceId: '', credentialHash: '', operationId: '', operationKind: '' } });
        const current = await ExecutionEnvironments.findOneAsync(lease.environmentId);
        if (current?.erasedAt || current?.deletionRequestedAt) await destroy(current);
        throw error;
      }
      if (error?.creationUncertain) await ExecutionEnvironments.updateAsync({ _id: lease.environmentId, operationId: lease.operationId }, { $set: { creationUncertain: true, cleanupRetryAfter: new Date(Date.now() + 120000) } });
      // Completion may have happened before the reservation existed, so its
      // normal lifecycle hook could not yet see this remote identity. Record
      // cleanup intent ourselves after a dispatched create (even if it failed).
      let retentionFailure = error?.error === 'execution-filesystem-completed' ? error : null;
      if (!retentionFailure) {
        try { await assertFilesystemRetention(userId, missionId, await ExecutionEnvironments.findOneAsync(lease.environmentId)); }
        catch (caught) { if (caught?.error === 'execution-filesystem-completed') retentionFailure = caught; }
      }
      if (retentionFailure) await ExecutionEnvironments.updateAsync({ _id: lease.environmentId, operationId: lease.operationId }, { $set: { deletionRequestedAt: new Date(), updatedAt: new Date() } });
      await release(lease, { uncertain: true, error: 'The mission filesystem could not be prepared. Check the environment before trying again.' });
      if (retentionFailure) throw retentionFailure;
      fail('execution-filesystem-unconfirmed', 'The mission filesystem could not be prepared. Check Environment settings before trying again.');
    }
  };
  const onSession = async (lease, sessionId) => {
    const id = executionText(String(sessionId), 'Execution session', 200);
    const updated = await ExecutionEnvironments.updateAsync({ _id: lease.environmentId, operationId: lease.operationId, erasedAt: { $exists: false } }, { $set: { remoteSessionId: id, updatedAt: new Date() } });
    if (!updated) fail('execution-environment-access', 'The environment is no longer assigned to this run.');
  };
  const operation = async (userId, missionId, kind, work, { preflight, allowAttention = false, assertActive } = {}) => {
    const row = await raw(userId, missionId); binding(row);
    await assertActive?.();
    if (row.helperSessionId && !row.operationId) fail('execution-environment-attention', 'Reconcile the unfinished file operation before starting another operation.');
    await preflight?.(row);
    const id = `operation-${Random.id()}`;
    const recoveryRead = row.status === 'needs-attention' && (allowAttention || (kind === 'read' && ['save', 'restore', 'policies', 'checkpoint-delete', 'preview', 'files'].includes(row.recoveryKind)));
    const claimed = await ExecutionEnvironments.updateAsync({ _id: row._id, workspaceId: row.workspaceId, status: recoveryRead ? 'needs-attention' : 'ready', operationId: { $exists: false }, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } },
      { $set: { operationId: id, operationKind: kind, status: 'busy', updatedAt: new Date() } });
    if (!claimed) fail('execution-environment-busy', 'Wait for the current operation, or reconcile this environment first.');
    const lease = { environmentId: row._id, operationId: id, workspaceId: row.workspaceId, preserveAttention: recoveryRead };
    let mutationStarted = false;
    const mutation = async () => {
      await assertActive?.();
      if (!await ExecutionEnvironments.findOneAsync({ _id: row._id, operationId: id, workspaceId: row.workspaceId, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } })) fail('execution-environment-erased', 'This environment is no longer available.');
      mutationStarted = true;
    };
    try {
      const current = await ExecutionEnvironments.findOneAsync({ _id: row._id, operationId: id });
      await preflight?.(current);
      await assertActive?.();
      const result = await work(current, await token(current), { mutation, operationId: id,
        onSession: async (sessionId) => {
          await assertActive?.();
          const helperSessionId = executionText(String(sessionId), 'Execution session', 200);
          if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: id, helperSessionId: { $exists: false }, erasedAt: { $exists: false } }, { $set: {
            operationKind: 'helper', helperOperationKind: kind, helperSessionId,
            helperPreviousRecoveryKind: row.recoveryKind ?? kind,
          } })) fail('execution-environment-erased', 'This environment is no longer available.');
        },
        onSessionFinished: async (sessionId) => {
          await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: id, helperSessionId: String(sessionId), erasedAt: { $exists: false } }, { $set: { operationKind: kind }, $unset: { helperSessionId: '', helperOperationKind: '', helperPreviousRecoveryKind: '' } });
        },
      }); await release(lease); return result;
    } catch (error) {
      const refused = ['checkpoint-current', 'checkpoint-delete-unsupported', 'private-preview-unavailable', 'invalid-service', 'invalid-checkpoint',
        ...(kind === 'files' ? ['file-exists', 'file-changed', 'file-not-found', 'file-confirm-required', 'invalid-content', 'invalid-action', 'invalid-path', 'response-limit'] : [])].includes(error?.code);
      if (refused && ['checkpoint-delete', 'preview'].includes(kind)) {
        const field = kind === 'checkpoint-delete' ? 'checkpointDeletion' : 'previewOperation';
        await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: id }, row[field] ? { $set: { [field]: row[field] } } : { $unset: { [field]: '' } });
      }
      if (error?.code === 'checkpoint-delete-unsupported') await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: id }, { $set: { checkpointDeletionSupported: false, updatedAt: new Date() } });
      if (kind === 'files' && (refused || !mutationStarted)) await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: id }, { $unset: { fileMutation: '' } });
      if (error?.code === 'stop-unconfirmed') await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: id }, { $set: { recoveryKind: 'helper' } });
      await release(lease, { uncertain: (!refused && mutationStarted) || error?.code === 'stop-unconfirmed' });
      if (error?.code === 'checkpoint-current') fail('execution-checkpoint-current', 'The current save point cannot be deleted. Restore another save point before deleting this one.');
      if (error?.code === 'checkpoint-delete-unsupported') fail('execution-checkpoint-delete-unsupported', 'This environment does not support save-point deletion. Restore and file access remain available.');
      if (error?.code === 'private-preview-unavailable') fail('execution-preview-private', 'The environment must use authenticated private access before starting a preview.');
      throw error;
    }
  };
  const checkPointCapacity = (row) => {
    if ((row.savePoints?.length ?? 0) >= 50) fail('execution-save-point-limit', 'This environment already has 50 save points.');
  };
  const requirePoint = (row, id) => {
    const point = row.savePoints?.find((item) => item.id === id);
    if (!point) fail('execution-save-point-missing', 'Choose a save point from this environment.');
    if (point.available === false || !healthy(point)) fail('execution-save-point-unavailable', 'This save point is missing or unhealthy. Refresh the save-point list.');
    return point;
  };
  const addPoint = async (row, value, label, context) => {
    checkPointCapacity(row);
    const attempt = { comment: `constellation:${Random.id()}`, label, createdAt: new Date() };
    if (!await ExecutionEnvironments.updateAsync({ _id: row._id, erasedAt: { $exists: false }, operationId: { $exists: true } }, { $set: { checkpointAttempt: attempt } })) fail('execution-environment-erased', 'The mission was deleted.');
    await context.mutation();
    const point = await adapter.createCheckpoint({ token: value, workspaceId: row.workspaceId, comment: attempt.comment });
    const saved = { id: executionText(String(point.id), 'Save point', 200), label, createdAt: new Date(), available: true, healthy: healthy(point) };
    if (!healthy(point)) fail('execution-save-point-unhealthy', 'The provider reported an unhealthy save point. Reconcile before continuing.');
    if (!await ExecutionEnvironments.updateAsync({ _id: row._id, erasedAt: { $exists: false } }, { $push: { savePoints: saved }, $set: { updatedAt: new Date() }, $unset: { checkpointAttempt: '' } })) fail('execution-environment-erased', 'The mission was deleted.'); return saved;
  };
  const savePoint = async (userId, { missionId, label }) => {
    const name = executionText(label, 'Save point label', 120);
    await operation(userId, missionId, 'save', (row, value, context) => addPoint(row, value, name, context), { preflight: checkPointCapacity }); return getEnvironment(userId, { missionId });
  };
  const restoreSavePoint = async (userId, { missionId, savePointId, confirm }) => {
    if (confirm !== true) fail('execution-confirm-required', 'Confirm that you want to replace the environment files. Chat and published artifacts will not change.');
    await operation(userId, missionId, 'restore', async (row, value, context) => {
      const point = requirePoint(row, savePointId);
      const remote = (await adapter.listCheckpoints({ token: value, workspaceId: row.workspaceId })).find((item) => item.id === point.id);
      if (!remote || !healthy(remote)) fail('execution-save-point-unavailable', 'This save point is missing or unhealthy. Refresh the save-point list.');
      // Restore restarts the environment and may start saved services. Check
      // its current API grants before either the safety snapshot or restore.
      await checkConnections(userId, value);
      await addPoint(row, value, `Before restore: ${point.label}`.slice(0, 120), context);
      if (!await ExecutionEnvironments.updateAsync({ _id: row._id, erasedAt: { $exists: false }, operationId: { $exists: true } }, { $set: { restoreRequestedAt: new Date(), restoreTarget: point.id } })) fail('execution-environment-erased', 'The mission was deleted.');
      await adapter.restoreCheckpoint({ token: value, workspaceId: row.workspaceId, checkpointId: point.id });
      await locked(`environment-network:${row._id}`, async () => adapter.applyPolicies({ token: value, workspaceId: row.workspaceId, domains: (await getSettings(userId)).domains }));
      await ExecutionEnvironments.updateAsync({ _id: row._id, erasedAt: { $exists: false } }, { $set: { lastRestoredSavePointId: point.id, restoredAt: new Date(), updatedAt: new Date() }, $unset: { restoreRequestedAt: '', restoreTarget: '' } });
    }, { preflight: (row) => { requirePoint(row, savePointId); checkPointCapacity(row); } }); return getEnvironment(userId, { missionId });
  };
  const deleteEnvironment = async (userId, { missionId, confirm }) => {
    if (confirm !== true) fail('execution-confirm-required', 'Confirm deletion of this environment’s files. Chat and published artifacts will remain.');
    const row = await raw(userId, missionId, { allowErased: true }); if (!row) return defaults(missionId);
    if (row.operationId) fail('execution-environment-busy', 'Stop the running job and wait for it to settle before deleting these files.');
    await ExecutionEnvironments.updateAsync(row._id, { $set: { deletionRequestedAt: new Date() } });
    try { await destroy(await ExecutionEnvironments.findOneAsync(row._id)); } catch { await attention(row._id, null, 'Restore the original connection, then retry deletion.'); }
    return publicEnvironment(await ExecutionEnvironments.findOneAsync(row._id)) ?? defaults(missionId);
  };
  const refreshSavePoints = async (userId, { missionId }) => {
    await operation(userId, missionId, 'read', async (row, value) => {
      const remote = await adapter.listCheckpoints({ token: value, workspaceId: row.workspaceId });
      const points = (row.savePoints ?? []).map((point) => {
        const found = remote.find((item) => item.id === point.id);
        return { ...point, available: !!found, healthy: !!found && healthy(found) };
      });
      for (const point of remote) {
        if (points.length >= 50) break;
        if (!points.some((item) => item.id === point.id)) points.push({ id: String(point.id), label: String(point.comment || `Save point ${point.id}`).slice(0, 120), createdAt: point.createdAt ?? new Date(), available: true, healthy: healthy(point) });
      }
      await ExecutionEnvironments.updateAsync({ _id: row._id, workspaceId: row.workspaceId, erasedAt: { $exists: false } }, { $set: { savePoints: points, savePointsCheckedAt: new Date(), updatedAt: new Date() } });
    }, { allowAttention: true }); return getEnvironment(userId, { missionId });
  };
  const deleteSavePoint = async (userId, { missionId, savePointId, confirm }) => {
    if (confirm !== true) fail('execution-confirm-required', 'Confirm deletion of this save point. Its files cannot be restored afterward.');
    const check = (row) => {
      if (!row.savePoints?.some((point) => point.id === savePointId)) fail('execution-save-point-missing', 'Choose a save point from this environment.');
      if (row.checkpointDeletionSupported === false) fail('execution-checkpoint-delete-unsupported', 'This environment does not support save-point deletion. Restore and file access remain available.');
      if (row.previewOperation || (row.checkpointDeletion && row.checkpointDeletion.id !== savePointId)) fail('execution-environment-attention', 'Reconcile the pending change before deleting another save point.');
    };
    await operation(userId, missionId, 'checkpoint-delete', async (row, value, context) => {
      if (typeof adapter.deleteCheckpoint !== 'function') fail('execution-checkpoint-delete-unavailable', 'This provider connection does not support save-point deletion.');
      const clearsAttempt = !!row.checkpointAttempt && (await adapter.listCheckpoints({ token: value, workspaceId: row.workspaceId })).some((point) => point.id === savePointId && point.comment === row.checkpointAttempt.comment);
      await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId }, { $set: { checkpointDeletion: { id: savePointId, clearsAttempt, requestedAt: new Date() } } });
      await context.mutation(); await adapter.deleteCheckpoint({ token: value, workspaceId: row.workspaceId, checkpointId: savePointId, onSession: context.onSession, onSessionFinished: context.onSessionFinished });
      await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId, erasedAt: { $exists: false } }, { $pull: { savePoints: { id: savePointId } }, $unset: { checkpointDeletion: '', ...(clearsAttempt ? { checkpointAttempt: '' } : {}) }, $set: { updatedAt: new Date() } });
    }, { preflight: check, allowAttention: true }); return getEnvironment(userId, { missionId });
  };
  const previewName = (value) => {
    const name = executionText(value, 'Preview name', 64);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) fail('execution-preview-name', 'Use letters, numbers, hyphens, and underscores.'); return name;
  };
  const previewDefinition = (input) => {
    const name = previewName(input.name); const command = executionText(input.command, 'Executable', 512);
    if (/[\x00-\x1f\x7f]/.test(command) || !Array.isArray(input.args ?? []) || (input.args ?? []).length > 40
      || (input.args ?? []).some((arg) => typeof arg !== 'string' || arg.length > 2048 || /[\x00-\x1f\x7f]/.test(arg))) fail('execution-preview-command', 'Provide an executable and up to 40 separate arguments.');
    const httpPort = input.httpPort ?? 8080;
    if (!Number.isInteger(httpPort) || httpPort < 1024 || httpPort > 65535) fail('execution-preview-port', 'Choose a port from 1024 to 65535.');
    return { name, command, args: input.args ?? [], directory: normalizeEnvironmentPath(input.directory ?? '/workspace', true), httpPort };
  };
  const observedPreview = (service) => ({ name: previewName(service.name), command: String(service.command ?? '').slice(0, 512),
    args: Array.isArray(service.args) ? service.args.slice(0, 40).map((arg) => String(arg).slice(0, 2048)) : [],
    directory: typeof service.directory === 'string' ? service.directory.slice(0, 512) : '/workspace',
    ...(Number.isInteger(service.httpPort) ? { httpPort: service.httpPort } : {}),
    status: ['running', 'stopped', 'starting', 'stopping', 'failed', 'exited', 'not-started'].includes(service.status) ? service.status : 'unknown',
    ...(Number.isInteger(service.pid) ? { pid: service.pid } : {}), ...(service.startedAt ? { startedAt: service.startedAt } : {}) });
  const savePreview = async (userId, input) => locked(`settings:${userId}`, async () => {
    executionObject(input); const row = await raw(userId, input.missionId); binding(row); await checkConnections(userId);
    const definition = previewDefinition(input); const prior = row.previews?.find((item) => item.name === definition.name);
    if (!prior && (row.previews?.length ?? 0) >= 12) fail('execution-preview-limit', 'Remove a preview before adding another.');
    const preview = { ...definition, status: prior?.status ?? 'not-started', pendingChanges: true, managed: true };
    if (!await ExecutionEnvironments.updateAsync({ _id: row._id, workspaceId: row.workspaceId, operationId: { $exists: false }, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } },
      { $set: { previews: [...(row.previews ?? []).filter((item) => item.name !== preview.name), preview], updatedAt: new Date() } })) fail('execution-environment-busy', 'Wait for the current app operation to finish.');
    return preview;
  });
  const listPreviews = async (userId, { missionId }) => operation(userId, missionId, 'read', async (row, value) => {
    const observed = (await adapter.listServices({ token: value, workspaceId: row.workspaceId })).map(observedPreview);
    const previews = (row.previews ?? []).map((saved) => {
      const live = observed.find((item) => item.name === saved.name);
      if (!live) return { ...saved, status: saved.pendingChanges ? 'not-started' : 'missing' };
      return saved.pendingChanges ? { ...saved, status: live.status } : { ...live, managed: saved.managed === true, pendingChanges: false };
    });
    for (const live of observed) if (!previews.some((item) => item.name === live.name)) previews.push({ ...live, managed: false, pendingChanges: false });
    const bounded = previews.slice(0, 50);
    await ExecutionEnvironments.updateAsync({ _id: row._id, workspaceId: row.workspaceId, erasedAt: { $exists: false } }, { $set: { previews: bounded, updatedAt: new Date() } }); return bounded;
  }, { allowAttention: true });
  const changePreview = async (userId, input, action) => {
    const name = previewName(input.name); const { missionId } = input;
    if (action === 'delete' && input.confirm !== true) fail('execution-confirm-required', 'Confirm removal of this preview service. Workspace files remain.');
    const check = (row) => {
      if (row.checkpointDeletion || row.checkpointAttempt || (row.previewOperation && row.previewOperation.name !== name)) fail('execution-environment-attention', 'Reconcile the pending change before changing another preview.');
    };
    return operation(userId, missionId, 'preview', async (row, value, context) => {
      const saved = row.previews?.find((item) => item.name === name);
      if (!saved) fail('execution-preview-missing', 'Refresh previews and choose a service from this mission.');
      if (action === 'start') await checkConnections(userId, value);
      if (action === 'stop' && saved.status === 'not-started' && !row.previewOperation) return saved;
      if (action === 'delete' && saved.status === 'not-started' && saved.pendingChanges && !row.previewOperation) {
        await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId }, { $pull: { previews: { name } }, $set: { updatedAt: new Date() } }); return { name, deleted: true };
      }
      await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId }, { $set: { previewOperation: { name, action, requestedAt: new Date() } } });
      await context.mutation();
      let result;
      if (action === 'start') {
        result = saved.pendingChanges
          ? await adapter.saveService({ token: value, workspaceId: row.workspaceId, ...previewDefinition(saved) })
          : await adapter.startService({ token: value, workspaceId: row.workspaceId, name });
      } else if (action === 'stop') result = await adapter.stopService({ token: value, workspaceId: row.workspaceId, name });
      else result = await adapter.deleteService({ token: value, workspaceId: row.workspaceId, name });
      const preview = action === 'delete' ? null : { ...observedPreview(result), managed: saved.managed === true, pendingChanges: false };
      await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId, erasedAt: { $exists: false } }, {
        $set: { previews: [...(row.previews ?? []).filter((item) => item.name !== name), ...(preview ? [preview] : [])], updatedAt: new Date() }, $unset: { previewOperation: '' } });
      return preview ?? { name, deleted: true };
    }, { preflight: check, allowAttention: action !== 'start' });
  };
  const privatePreview = async (userId, { missionId, name }) => operation(userId, missionId, 'read', async (row, value) => {
    const target = previewName(name);
    if (!row.previews?.some((item) => item.name === target)) fail('execution-preview-missing', 'Refresh previews and choose a service from this mission.');
    // Opening the provider URL may wake services. Treat issuing this link as
    // admission to execution, even when the service was configured earlier.
    await checkConnections(userId, value);
    const preview = await adapter.getPrivatePreview({ token: value, workspaceId: row.workspaceId, name: target });
    let url; try { url = new URL(preview.url); } catch { fail('execution-preview-private', 'The provider did not return a private preview URL.'); }
    if (preview.auth !== 'sprite' || preview.privateAccess !== 'admins' || url.protocol !== 'https:' || !url.hostname.endsWith('.sprites.app') || url.username || url.password || url.search || url.hash) fail('execution-preview-private', 'Only an authenticated private preview can be opened.');
    return { url: url.toString(), auth: 'sprite', privateAccess: 'admins' };
  });
  const reconcileEnvironment = async (userId, { missionId }) => {
    const row = await raw(userId, missionId, { allowErased: true }); if (!row?.workspaceId) return publicEnvironment(row) ?? defaults(missionId);
    if (row.erasedAt || row.deletionRequestedAt) return deleteEnvironment(userId, { missionId, confirm: true });
    if (row.operationId) fail('execution-environment-busy', 'Wait for the current operation to settle.');
    if (row.creationUncertain && row.cleanupRetryAfter > new Date()) fail('execution-environment-settling', 'Wait up to two minutes for provisioning to settle, then reconcile.');
    const operationId = `reconcile-${Random.id()}`;
    if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: { $exists: false } }, { $set: { operationId, status: 'busy' } })) fail('execution-environment-busy', 'Another operation has started.');
    try {
      const value = await token(row); let kind = row.recoveryKind ?? row.operationKind ?? 'run';
      if (row.helperSessionId) {
        await adapter.stopExecution({ token: value, workspaceId: row.workspaceId, sessionId: row.helperSessionId });
        kind = row.helperPreviousRecoveryKind ?? row.helperOperationKind ?? 'read';
        await ExecutionEnvironments.updateAsync({ _id: row._id, operationId, helperSessionId: row.helperSessionId }, {
          $set: { recoveryKind: kind }, $unset: { helperSessionId: '', helperPreviousRecoveryKind: '', helperOperationKind: '' },
        });
      }
      if (row.restoreRequestedAt) fail('execution-restore-unknown', 'The restore outcome is unknown. Download files for recovery or delete the environment; the restore will not be replayed.');
      if (!['policies', 'save', 'restore', 'read', 'checkpoint-delete', 'preview', 'files'].includes(kind)) {
        await adapter.stopExecution({ token: value, workspaceId: row.workspaceId, sessionId: row.remoteSessionId });
      }
      if (row.previewOperation) {
        const { name, action } = row.previewOperation;
        const found = (await adapter.listServices({ token: value, workspaceId: row.workspaceId })).find((item) => item.name === name);
        const saved = row.previews?.find((item) => item.name === name);
        if (action === 'delete' ? !!found : !found || ['unknown', 'starting', 'stopping'].includes(found.status)
          || (action === 'stop' && found.status === 'running')
          || (action === 'start' && saved?.pendingChanges && digest(previewDefinition(found)) !== digest(previewDefinition(saved)))) fail('execution-preview-unknown', 'The preview change is not confirmed. Refresh previews before retrying.');
        await ExecutionEnvironments.updateAsync({ _id: row._id, operationId, erasedAt: { $exists: false } }, {
          $set: { previews: [...(row.previews ?? []).filter((item) => item.name !== name), ...(found ? [{ ...observedPreview(found), managed: saved?.managed === true, pendingChanges: false }] : [])] }, $unset: { previewOperation: '' } });
      } else if (row.checkpointDeletion) {
        const found = (await adapter.listCheckpoints({ token: value, workspaceId: row.workspaceId })).find((point) => point.id === row.checkpointDeletion.id);
        if (found) fail('execution-checkpoint-delete-unknown', 'Save-point deletion is not confirmed. Refresh the list before retrying deletion.');
        await ExecutionEnvironments.updateAsync({ _id: row._id, operationId, erasedAt: { $exists: false } }, { $pull: { savePoints: { id: row.checkpointDeletion.id } }, $unset: { checkpointDeletion: '', ...(row.checkpointDeletion.clearsAttempt ? { checkpointAttempt: '' } : {}) } });
      } else if (row.checkpointAttempt) {
        const matches = (await adapter.listCheckpoints({ token: value, workspaceId: row.workspaceId })).filter((point) => point.comment === row.checkpointAttempt.comment);
        if (matches.length !== 1) fail('execution-checkpoint-unknown', 'The save point is not confirmed. Retry reconciliation later; it will not be created again.');
        if (!healthy(matches[0])) fail('execution-save-point-unhealthy', 'The provider reports that this save point is unhealthy. Refresh the list and delete it before continuing.');
        const point = { id: executionText(String(matches[0].id), 'Save point', 200), label: row.checkpointAttempt.label, createdAt: matches[0].createdAt ?? row.checkpointAttempt.createdAt, available: true, healthy: true };
        if (!row.savePoints?.some((saved) => saved.id === point.id)) await ExecutionEnvironments.updateAsync({ _id: row._id, operationId, erasedAt: { $exists: false } }, { $push: { savePoints: point } });
        await ExecutionEnvironments.updateAsync({ _id: row._id, operationId }, { $unset: { checkpointAttempt: '' } });
      }
      if (row.fileMutation) await ExecutionEnvironments.updateAsync({ _id: row._id, operationId }, {
        $set: { lastFileMutation: { ...row.fileMutation, status: 'unknown', checkedAt: new Date(), notice: 'The interrupted change was not replayed. Inspect the files before trying again.' } },
        $unset: { fileMutation: '', attachmentWriteUnconfirmed: '' }, $inc: { fileRevision: 1 },
      });
      await locked(`environment-network:${row._id}`, async () => adapter.applyPolicies({ token: value, workspaceId: row.workspaceId, domains: (await getSettings(userId)).domains }));
      await ExecutionEnvironments.updateAsync({ _id: row._id, operationId }, { $unset: { policyUnconfirmed: '', creationUncertain: '', cleanupRetryAfter: '' } });
      await release({ environmentId: row._id, operationId });
    } catch (error) { await attention(row._id, operationId, ['execution-restore-unknown', 'execution-checkpoint-unknown', 'execution-checkpoint-delete-unknown', 'execution-save-point-unhealthy', 'execution-preview-unknown'].includes(error?.error) ? error.reason : 'The app’s previous operation could not be confirmed. Reconcile again or delete the environment.'); }
    return getEnvironment(userId, { missionId });
  };
  const scrubMission = async (missionId) => {
    await ExecutionFileRequests.removeAsync({ missionId });
    for (const row of await ExecutionEnvironments.find({ missionId }).fetchAsync()) {
      const provisioning = row.provisioningRequestedAt && !row.provisioningConfirmedAt;
      await ExecutionEnvironments.updateAsync(row._id, { $set: { erasedAt: new Date(), keepFiles: false, allowedAgents: [], savePoints: [], previews: [], recoveredFiles: [], deletionRequestedAt: new Date(), status: 'deleting' },
        $unset: { recoveryKind: '', checkpointAttempt: '', checkpointDeletion: '', previewOperation: '', fileMutation: '', attachmentWriteUnconfirmed: '', lastFileMutation: '', restoreTarget: '', restoreRequestedAt: '', lastRestoredSavePointId: '', error: '' } });
      if (provisioning) await ExecutionEnvironments.updateAsync(row._id, { $set: { creationUncertain: true, cleanupRetryAfter: new Date(Date.now() + 120000) } });
      try { await destroy(await ExecutionEnvironments.findOneAsync(row._id)); }
      catch { await attention(row._id, null, 'Conversation deleted. Restore the original connection and retry environment deletion.'); }
    }
  };
  const onMissionCompleted = async (userId, missionId) => {
    const row = await ExecutionEnvironments.findOneAsync({ userId, missionId, retention: 'delete-on-completion', workspaceId: { $exists: true } }); if (!row) return;
    await ExecutionEnvironments.updateAsync(row._id, { $set: { deletionRequestedAt: new Date(), updatedAt: new Date() } });
    // destroy() atomically claims only an idle environment. An active holder
    // observes this intent and deletes after its provider has settled.
    try { await destroy(await ExecutionEnvironments.findOneAsync(row._id)); }
    catch { await attention(row._id, null, 'The mission is complete. Retry environment deletion to finish cleanup.'); }
  };
  const recover = async ({ userId } = {}) => {
    await ensure();
    const scope = userId ? { userId } : {};
    await ExecutionFileRequests.updateAsync({ ...scope, status: 'pending' }, { $set: { status: 'unknown', updatedAt: new Date() } }, { multi: true });
    for (const row of await ExecutionEnvironments.find({ ...scope, status: { $in: ['busy', 'deleting'] } }, { limit: 100 }).fetchAsync()) {
      await ExecutionEnvironments.updateAsync(row._id, { $set: { status: 'needs-attention', recoveryKind: row.recoveryKind ?? row.operationKind ?? 'run', error: 'The app restarted during an operation. Reconcile before continuing.', updatedAt: new Date() }, $unset: { operationId: '', currentJobId: '', operationKind: '' } });
    }
    await ExecutionEnvironments.updateAsync({ ...scope, provisioningRequestedAt: { $exists: true }, provisioningConfirmedAt: { $exists: false }, workspaceId: { $exists: true } },
      { $set: { creationUncertain: true, cleanupRetryAfter: new Date(Date.now() + 120000), status: 'needs-attention' } }, { multi: true });
    const pending = await ExecutionEnvironments.find({ ...scope, deletionRequestedAt: { $exists: true } }, { limit: 100 }).fetchAsync();
    for (const row of pending) { try { await destroy(row); } catch { await attention(row._id, null, 'Environment cleanup is pending. Restore the connection and retry deletion.'); } }
  };
  const historicalPoint = (row, savePointId) => {
    if (!savePointId) return;
    const point = row.savePoints?.find((item) => item.id === savePointId);
    if (!point || point.available === false) fail('execution-save-point-missing', 'Choose an available save point from this mission.');
  };
  const fileRequest = async (work) => {
    try { return await work(); } catch (error) {
      if (error?.code === 'checkpoint-unavailable') fail('execution-checkpoint-unavailable', 'Files from this save point are no longer mounted. Sprites exposes only its latest five save points for individual-file recovery.');
      if (error?.code === 'response-limit') fail('execution-environment-file-limit', 'This file exceeds the download limit.');
      if (error?.code === 'invalid-path') fail('execution-environment-file-unavailable', 'This file is unavailable or is a symbolic link.'); throw error;
    }
  };
  const readBytes = async (row, value, location, savePointId, limit, context) => {
    historicalPoint(row, savePointId);
    const result = await fileRequest(() => savePointId
      ? adapter.readCheckpointFile({ token: value, workspaceId: row.workspaceId, checkpointId: savePointId, path: location, maxBytes: limit, onSession: context.onSession, onSessionFinished: context.onSessionFinished })
      : (adapter.readWorkingFile ?? adapter.readWorkspaceFile)({ token: value, workspaceId: row.workspaceId, path: location, maxBytes: limit, onSession: context.onSession, onSessionFinished: context.onSessionFinished }));
    const content = result instanceof Uint8Array ? result : result?.content;
    if (!(content instanceof Uint8Array) || content.byteLength > limit) fail('execution-environment-file-limit', 'This file exceeds the download limit.');
    return { name: location.split('/').at(-1), contentType: result?.contentType ?? 'application/octet-stream', size: content.byteLength,
      content: Buffer.from(content).toString('base64'), hash: createHash('sha256').update(content).digest('hex'), writable: !savePointId && writablePath(location) };
  };
  const writablePath = (path) => { try { normalizeWorkspaceMutation({ action: 'delete', path, confirm: true }); return true; } catch { return false; } };
  const fileFailure = (error) => {
    const messages = {
      'invalid-path': 'Choose a writable path inside this mission’s workspace. App-managed files are read-only.',
      'file-exists': 'A file or folder already exists at that destination. Choose another name.',
      'file-changed': 'This file changed after you opened it. Reload it before saving.',
      'file-not-found': 'This file or folder is no longer available. Refresh the file list.',
      'file-confirm-required': 'Confirm permanent deletion of this file or folder and its contents.',
      'invalid-content': 'Provide valid file content within the upload limit.',
      'invalid-action': 'Choose a supported file action.',
      'response-limit': 'This operation exceeds the file size or item limit.',
      'file-operation-unconfirmed': 'The file change is not confirmed. Reconcile and inspect the files before trying again.',
    };
    if (messages[error?.code]) fail(`execution-${error.code}`, messages[error.code]);
    throw error;
  };
  const mutateEnvironmentFile = async (userId, input, serverContext = {}) => {
    executionObject(input);
    if (input.savePointId) fail('execution-invalid-action', 'Save-point files are read-only. Recover a copy first.');
    const maxBytes = Math.min(5_000_000, (await getSettings(userId)).limits.maxArtifactBytes);
    let change; try { change = normalizeWorkspaceMutation(input, { maxBytes }); } catch (error) { fileFailure(error); }
    if (!['createFolder', 'write', 'upload', 'rename', 'move', 'copy', 'delete'].includes(change.action)) fail('execution-invalid-action', 'Choose a supported file action.');
    const { maxBytes: ignoredBytes, maxEntries: ignoredEntries, ...semantics } = change;
    const fingerprint = digest(semantics);
    const requestId = serverContext.requestId === undefined ? null : executionText(serverContext.requestId, 'File request', 500);
    const receiptId = requestId ? `file-request-${digest([userId, input.missionId, requestId])}` : null;
    let claimed = false; let started = false; let confirmedResult;
    const priorResult = async (row) => {
      const prior = receiptId && await ExecutionFileRequests.findOneAsync({ _id: receiptId, userId, missionId: input.missionId });
      if (!prior) return null;
      if (prior.fingerprint !== fingerprint) fail('execution-file-request-conflict', 'This file request already refers to a different change. Send a new request.');
      if (prior.status === 'completed') return { ...prior.result, replayed: true, ...(prior.workspaceId !== row?.workspaceId ? { previousEnvironment: true } : {}) };
      if (prior.status === 'rejected') fail('execution-file-request-rejected', 'This file request was rejected earlier. Review the files and send a new request.');
      return { action: change.action, status: prior.status, replayed: true, notice: 'This request was not run again. Check the environment before sending another change.' };
    };
    if (receiptId) {
      await (fileRequestIndex ??= ExecutionFileRequests.rawCollection().createIndex({ userId: 1, missionId: 1 }));
      const row = await raw(userId, input.missionId); await serverContext.assertActive?.();
      const prior = await priorResult(row); if (prior) return prior;
    }
    try {
      return await operation(userId, input.missionId, 'files', async (row, value, context) => {
        const prior = await priorResult(row); if (prior) return prior;
        if (receiptId && await ExecutionFileRequests.find({ userId, missionId: input.missionId }).countAsync() >= 1000) fail('execution-file-request-limit', 'This mission reached its 1,000 agent file-change limit. Start a new mission to continue.');
        await checkConnections(userId, value); await serverContext.assertActive?.();
        if (receiptId) {
          await ExecutionFileRequests.insertAsync({ _id: receiptId, userId, missionId: input.missionId, workspaceId: row.workspaceId, fingerprint, action: change.action, status: 'pending', createdAt: new Date(), updatedAt: new Date() });
          claimed = true;
        }
        const receipt = { id: Random.id(), action: change.action, requestedAt: new Date(),
          ...(change.path ? { path: change.path } : {}), ...(change.destination ? { destination: change.destination } : {}) };
        if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } }, { $set: { fileMutation: receipt } })) fail('execution-environment-erased', 'This environment is no longer available.');
        const result = await adapter.mutateWorkspaceFile({ token: value, workspaceId: row.workspaceId, ...change, maxBytes,
          onMutationStart: async () => { await context.mutation(); started = true; } });
        confirmedResult = { action: change.action, status: 'completed' };
        for (const field of ['path', 'destination', 'hash']) if (typeof result?.[field] === 'string' && result[field].length <= 1024) confirmedResult[field] = result[field];
        if (result?.entry && typeof result.entry === 'object') confirmedResult.entry = Object.fromEntries(Object.entries(result.entry).filter(([key, value]) =>
          ['name', 'path', 'originalPath', 'type', 'deletedAt'].includes(key) ? typeof value === 'string' && value.length <= 1024 : key === 'size' && Number.isSafeInteger(value) && value >= 0));
        if (claimed) await ExecutionFileRequests.updateAsync({ _id: receiptId, userId }, { $set: { status: 'completed', result: confirmedResult, updatedAt: new Date() } });
        await serverContext.assertActive?.();
        if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } }, {
          $set: { lastFileMutation: { ...receipt, status: 'completed', completedAt: new Date() }, updatedAt: new Date() }, $unset: { fileMutation: '' }, $inc: { fileRevision: 1 },
        })) fail('execution-environment-erased', 'This environment is no longer available.');
        return confirmedResult;
      }, { assertActive: serverContext.assertActive });
    } catch (error) {
      if (claimed && !confirmedResult) {
        const refused = ['file-exists', 'file-changed', 'file-not-found', 'file-confirm-required', 'invalid-content', 'invalid-action', 'invalid-path', 'response-limit'].includes(error?.code);
        await ExecutionFileRequests.updateAsync({ _id: receiptId, userId }, { $set: { status: !started || refused ? 'rejected' : 'unknown', updatedAt: new Date() } });
      }
      if (claimed) {
        const current = await ExecutionEnvironments.findOneAsync({ userId, missionId: input.missionId });
        if (!current || current.erasedAt) await ExecutionFileRequests.removeAsync({ _id: receiptId, userId });
      }
      fileFailure(error);
    }
  };
  // Chat uploads use the same native write lease and durable no-replay receipts
  // as file tools. Only hashes and result metadata reach Mongo, never bytes.
  const uploadChatFile = async (userId, input) => {
    await owner(userId); executionObject(input);
    const missionId = executionText(input.missionId, 'Mission', 160);
    const name = executionText(input.name, 'File name', 255);
    if (name !== input.name || Buffer.byteLength(name, 'utf8') > 255 || /[/\\\x00-\x1f\x7f]/.test(name)
      || ['.', '..', 'runs', 'inputs', 'attachments'].includes(name) || name.startsWith('.constellation')) {
      fail('execution-invalid-path', 'Choose a file name without folders or control characters. App-managed names are reserved.');
    }
    const requestId = executionText(input.requestId, 'Upload request', 160);
    if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) fail('execution-invalid-upload-request', 'Choose a valid upload request ID.');
    const contentType = input.contentType || 'application/octet-stream';
    if (typeof contentType !== 'string' || contentType.length > 128 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType)) {
      fail('execution-invalid-content', 'Choose a valid file type.');
    }
    const path = `/workspace/${name}`;
    // Reuse strict canonical-base64 and configured byte-limit validation before
    // decoding; native upload semantics refuse any existing destination.
    let change;
    const validateContent = async () => {
      const settings = await getSettings(userId);
      if (!settings.providerConfigured || settings.connectionStatus !== 'connected') fail('execution-connection-required', 'Connect Sprites before uploading a file.');
      try { change = normalizeWorkspaceMutation({ action: 'upload', path, content: input.content }, { maxBytes: Math.min(5_000_000, settings.limits.maxArtifactBytes) }); }
      catch (error) { fileFailure(error); }
    };
    await validateContent();
    const size = Buffer.byteLength(change.base64, 'base64');
    const assertActive = async () => {
      const row = await raw(userId, missionId);
      const root = await rootMission(userId, missionId);
      if (root.erasedAt || root.erasingAt || root.ephemeral || row?.deletionRequestedAt) fail('execution-environment-erased', 'This mission filesystem is no longer available.');
      if (!row?.keepFiles || !row.workspaceId) fail('attachment-storage-required', 'Enable the mission filesystem before uploading files.');
      await assertFilesystemRetention(userId, missionId, row);
      await validateContent();
    };
    const result = await mutateEnvironmentFile(userId, { missionId, action: 'upload', path, content: change.base64 }, { requestId: `chat-upload:${requestId}`, assertActive });
    return { ...result, path, name, size, contentType };
  };
  // Server-only lease adoption lets a run publish its output before releasing
  // its writer lease. No client method accepts a lease or bypasses ownership.
  const withAttachmentLease = (lease, work) => {
    if (!lease || typeof lease.environmentId !== 'string' || typeof lease.operationId !== 'string'
      || typeof lease.workspaceId !== 'string' || typeof work !== 'function') fail('attachment-storage-lease', 'The file operation no longer owns this environment.');
    return attachmentLeases.run({ ...lease }, work);
  };
  const attachmentOperation = async (userId, missionId, write, serverContext, work) => {
    const adopted = attachmentLeases.getStore();
    const signals = [serverContext.signal, adopted?.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const check = async () => {
      if (signal?.aborted) fail('attachment-storage-cancelled', 'The attachment operation was cancelled.');
      await adopted?.assertActive?.();
      await serverContext.assertActive?.();
      if (signal?.aborted) fail('attachment-storage-cancelled', 'The attachment operation was cancelled.');
      if (write) await preflight(await ExecutionEnvironments.findOneAsync({ userId, missionId }));
    };
    const preflight = async (row) => {
      if (!row?.workspaceId || (write && !row.keepFiles)) fail('attachment-storage-required', 'Enable this mission’s filesystem before adding files. Attachments are stored only in Sprites.');
      if (write && (row.policyUnconfirmed || row.attachmentWriteUnconfirmed)) fail('attachment-storage-unavailable', 'Reconcile this mission’s filesystem before adding files.');
    };
    const prepare = async (row) => {
      await preflight(row);
      if (write && row.fileMutation) fail('attachment-storage-unavailable', 'Reconcile the earlier file change before adding another attachment.');
    };
    if (!adopted) {
      // Test preflight before binding() so a missing filesystem has an
      // attachment-specific, actionable error rather than triggering creation.
      await prepare(await raw(userId, missionId));
      return operation(userId, missionId, write ? 'files' : 'read', (row, value, context) => work(row, value, { ...context, signal }), { preflight: prepare, assertActive: check });
    }
    const row = await raw(userId, missionId); await preflight(row); await check();
    const assertLease = async () => {
      await check();
      const current = await ExecutionEnvironments.findOneAsync({ _id: adopted.environmentId, userId, missionId,
        workspaceId: adopted.workspaceId, operationId: adopted.operationId, status: 'busy', erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } });
      if (!current || row?._id !== adopted.environmentId) fail('attachment-storage-lease', 'The file operation no longer owns this environment.');
      await preflight(current); return current;
    };
    const current = await assertLease(); await prepare(current);
    return work(current, await token(current), { operationId: adopted.operationId, mutation: assertLease, assertActive: assertLease, signal });
  };
  const attachmentFailure = (error) => {
    if (String(error?.error ?? '').startsWith('attachment-')) throw error;
    if (['file-not-found', 'invalid-path'].includes(error?.code)) fail('attachment-storage-missing', 'This attachment is missing or no longer a regular file in the mission’s filesystem.');
    if (error?.code === 'response-limit') fail('attachment-storage-changed', 'This attachment no longer matches its saved size.');
    if (error?.error) throw error;
    fail('attachment-storage-unavailable', 'The attachment could not be read from Sprites. Check the mission filesystem and try again.');
  };
  const attachmentMetadata = (input, sha256) => {
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > 10_000_000) fail('attachment-invalid', 'The attachment exceeds the supported file size.');
    try { return attachmentStoragePath({ attachmentId: input.attachmentId, name: input.name, sha256 }); }
    catch { fail('attachment-invalid', 'The attachment reference is invalid.'); }
  };
  const writeAttachmentFile = async (userId, input, serverContext = {}) => {
    const encoded = input.content;
    if (typeof encoded !== 'string' || encoded.length > 13_333_336 || encoded.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('attachment-invalid', 'The attachment content is invalid.');
    const bytes = Buffer.from(encoded, 'base64'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.toString('base64') !== encoded || bytes.length !== input.size || input.sha256 && input.sha256 !== sha256) fail('attachment-invalid', 'The attachment content does not match its metadata.');
    const path = attachmentMetadata(input, sha256);
    try {
      return await attachmentOperation(userId, input.missionId, true, serverContext, async (row, value, context) => {
        await serverContext.assertActive?.();
        const reference = { missionId: input.missionId, workspaceId: row.workspaceId, path, sha256 };
        const args = { token: value, workspaceId: row.workspaceId, path, maxBytes: Math.max(1, input.size), signal: context.signal };
        let existing;
        try { existing = await (adapter.readAttachmentBytes ?? adapter.readWorkingFile)(args); } catch (error) { if (error?.code !== 'file-not-found') throw error; }
        if (existing) {
          const content = existing instanceof Uint8Array ? existing : existing.content;
          if (!(content instanceof Uint8Array) || content.length !== input.size || createHash('sha256').update(content).digest('hex') !== sha256) fail('attachment-storage-changed', 'This saved attachment was changed in Sprites. It will not be overwritten.');
          await serverContext.assertActive?.(); await context.assertActive?.(); return reference;
        }
        await checkConnections(userId, value);
        await context.mutation();
        const receipt = { id: Random.id(), action: 'attachment', path, requestedAt: new Date() };
        if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId, keepFiles: true, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } }, { $set: { fileMutation: receipt } })) fail('attachment-storage-lease', 'The mission filesystem is no longer available.');
        try {
          // Content-addressed paths prevent concurrent different-byte writes
          // from replacing the first attachment. Native Sprites REST still has
          // no atomic no-follow guarantee against a trusted guest process.
          await context.mutation();
          await adapter.writeFile({ token: value, workspaceId: row.workspaceId, path, content: bytes, signal: context.signal });
          const result = await (adapter.readAttachmentBytes ?? adapter.readWorkingFile)(args);
          const stored = result instanceof Uint8Array ? result : result.content;
          if (!(stored instanceof Uint8Array) || stored.length !== input.size || createHash('sha256').update(stored).digest('hex') !== sha256) throw new Error('attachment-readback-mismatch');
          await serverContext.assertActive?.(); await context.assertActive?.();
          if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } }, {
            $set: { updatedAt: new Date() }, $unset: { fileMutation: '' }, $inc: { fileRevision: 1 },
          })) fail('attachment-storage-lease', 'The mission filesystem is no longer available.');
          return reference;
        } catch {
          await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId, erasedAt: { $exists: false } }, { $set: { attachmentWriteUnconfirmed: true, recoveryKind: 'files', updatedAt: new Date() } });
          fail('attachment-storage-unconfirmed', 'The attachment write could not be verified. Reconcile the mission filesystem before trying again. No fallback copy was stored.');
        }
      });
    } catch (error) { attachmentFailure(error); }
  };
  const readAttachmentFile = async (userId, input, serverContext = {}) => {
    const reference = input.storageReference;
    const path = attachmentMetadata(input, reference?.sha256);
    if (!reference || reference.missionId !== input.missionId || reference.path !== path) fail('attachment-invalid', 'The attachment reference does not belong to this mission.');
    try {
      return await attachmentOperation(userId, input.missionId, false, serverContext, async (row, value, context) => {
        if (row.workspaceId !== reference.workspaceId) fail('attachment-storage-missing', 'This attachment belonged to a previous filesystem that was deleted or replaced.');
        await serverContext.assertActive?.(); await context.assertActive?.();
        const result = await (adapter.readAttachmentBytes ?? adapter.readWorkingFile)({ token: value, workspaceId: row.workspaceId, path, maxBytes: Math.max(1, input.size), signal: context.signal });
        const content = result instanceof Uint8Array ? result : result.content;
        if (!(content instanceof Uint8Array) || content.length !== input.size || createHash('sha256').update(content).digest('hex') !== reference.sha256) fail('attachment-storage-changed', 'This attachment was changed or replaced in Sprites and no longer matches its saved reference.');
        await serverContext.assertActive?.(); await context.assertActive?.();
        return Buffer.from(content).toString('base64');
      });
    } catch (error) { attachmentFailure(error); }
  };
  const recoverEnvironmentFile = async (userId, { missionId, savePointId, path }) => {
    executionText(savePointId, 'Save point', 200); const location = normalizeEnvironmentPath(path);
    const limit = Math.min(5000000, (await getSettings(userId)).limits.maxArtifactBytes);
    return operation(userId, missionId, 'read', async (row, value, context) => {
      const file = await readBytes(row, value, location, savePointId, limit, context);
      await rootMission(userId, missionId);
      const artifact = await withAttachmentLease({ environmentId: row._id, workspaceId: row.workspaceId, operationId: context.operationId }, () => artifactApi.create({ sessionId: missionId, name: `Recovered ${savePointId} ${file.name}`, contentType: file.contentType, content: { base64: file.content }, attach: false,
        caps: { maxFileBytes: limit, maxTotalBytes: limit, maxFiles: 1 } }));
      const recovered = { artifact, sessionId: missionId, agent: 'orchestrator', sourcePath: location, savePointId, createdAt: new Date() };
      if (!await ExecutionEnvironments.updateAsync({ _id: row._id, operationId: context.operationId, erasedAt: { $exists: false } }, { $push: { recoveredFiles: { $each: [recovered], $slice: -100 } }, $set: { updatedAt: new Date() } })) fail('execution-environment-erased', 'The mission was deleted before recovery completed.');
      return recovered;
    }, { preflight: (row) => historicalPoint(row, savePointId), allowAttention: true });
  };
  return { getEnvironment, saveEnvironment, enableFilesystem, savePoint, restoreSavePoint, deleteEnvironment, reconcileEnvironment, refreshSavePoints, deleteSavePoint, recoverEnvironmentFile, mutateEnvironmentFile, uploadChatFile, listPreviews, savePreview, privatePreview,
    startPreview: (userId, input) => changePreview(userId, input, 'start'), stopPreview: (userId, input) => changePreview(userId, input, 'stop'), deletePreview: (userId, input) => changePreview(userId, input, 'delete'),
    plan, acquireRun, release, assertRun, onSession, scrubMission, onMissionCompleted, recover, withAttachmentLease, writeAttachmentFile, readAttachmentFile,
    async applyNetworkPolicy(userId, domains) {
      // Host network controls may tighten while a process is running. Never
      // leave an idle retained VM with an obsolete allowlist after a save.
      for (const row of await ExecutionEnvironments.find({ userId, workspaceId: { $exists: true }, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } }).fetchAsync()) {
        await ExecutionEnvironments.updateAsync(row._id, { $set: { policyUnconfirmed: true, updatedAt: new Date() } });
        try {
          await locked(`environment-network:${row._id}`, async () => adapter.applyPolicies({ token: await token(row), workspaceId: row.workspaceId, domains }));
          await ExecutionEnvironments.updateAsync(row._id, { $unset: { policyUnconfirmed: '' } });
        } catch {
          // A file helper can finish while this policy request is pending. Its
          // cleared receipt must not become a fictitious unfinished process.
          const recoveryKind = row.recoveryKind ?? (row.operationKind === 'helper'
            ? row.helperPreviousRecoveryKind ?? row.helperOperationKind ?? 'read'
            : row.operationId ? row.operationKind ?? 'run' : 'policies');
          const selector = { _id: row._id, workspaceId: row.workspaceId, erasedAt: { $exists: false }, deletionRequestedAt: { $exists: false } };
          await ExecutionEnvironments.updateAsync({ ...selector, recoveryKind: { $exists: false } }, { $set: { recoveryKind } });
          await ExecutionEnvironments.updateAsync(selector, { $set: { status: 'needs-attention', error: 'The network policy update is not confirmed. Reconcile before continuing.', updatedAt: new Date() } });
        }
      }
    },
    async environmentFiles(userId, { missionId, path = '/workspace', savePointId }, serverContext = {}) {
      const location = normalizeEnvironmentPath(path, true);
      return operation(userId, missionId, 'read', async (row, value, context) => {
        await serverContext.assertActive?.();
        historicalPoint(row, savePointId);
        const entries = await fileRequest(() => savePointId
          ? adapter.listCheckpointFiles({ token: value, workspaceId: row.workspaceId, checkpointId: savePointId, path: location, onSession: context.onSession, onSessionFinished: context.onSessionFinished })
          : (adapter.listWorkingFiles ?? adapter.listFiles)({ token: value, workspaceId: row.workspaceId, path: location, onSession: context.onSession, onSessionFinished: context.onSessionFinished }));
        return { path: location, entries: entries.map((entry) => ({ ...entry, writable: !savePointId && writablePath(entry.path) })), writable: !savePointId && (location === '/workspace' || writablePath(location)), ...(savePointId ? { savePointId } : {}) };
      }, { allowAttention: !!savePointId, assertActive: serverContext.assertActive });
    },
    async readEnvironmentFile(userId, { missionId, path, savePointId }, serverContext = {}) {
      const location = normalizeEnvironmentPath(path); const limit = Math.min(5000000, (await getSettings(userId)).limits.maxArtifactBytes);
      return operation(userId, missionId, 'read', (row, value, context) => readBytes(row, value, location, savePointId, limit, context), { allowAttention: !!savePointId, assertActive: serverContext.assertActive });
    },
    async tokenChangeAllowed(userId, candidate) {
      const rows = await ExecutionEnvironments.find({ userId, workspaceId: { $exists: true } }).fetchAsync();
      return !rows.length || (!!candidate && rows.every((row) => row.credentialHash === digest(candidate)));
    },
  };
}
