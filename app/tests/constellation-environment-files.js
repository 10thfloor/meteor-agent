import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

if (Meteor.isServer) describe('Constellation working-file operations', function () {
  this.timeout(15000);
  let environmentModule; let createHash; let service; let adapter; let userId; let calls; let allowed; let mutate; let settings; let missionExists; let missionStatus; let archived; let connectionReview;
  const missionId = 'files-mission';
  const change = (patch = {}) => ({ missionId, action: 'write', path: '/workspace/notes.txt', text: 'draft', ...patch });
  const rejected = async (promise, code) => { let error; try { await promise; } catch (caught) { error = caught; } assert.ok(error, `Expected ${code}`); assert.strictEqual(error.error, code); };
  const waitFor = async (predicate) => { const end = Date.now() + 2000; while (!await predicate()) { if (Date.now() > end) assert.fail('Expected file operation state'); await new Promise((resolve) => setTimeout(resolve, 5)); } };
  const guard = async () => { if (!allowed) throw new Meteor.Error('execution-access-off', 'Access changed'); };
  before(async () => {
    environmentModule = await import('../server/constellation-environments');
    ({ createHash } = await import('node:crypto'));
  });
  beforeEach(async () => {
    userId = `working-files-${Random.id()}`; calls = []; allowed = true; missionExists = true; missionStatus = 'active'; archived = false; connectionReview = async () => {};
    settings = { enabled: false, providerConfigured: true, connectionStatus: 'connected', agentPolicies: { atlas: { run: 'disabled' } }, domains: [], limits: { maxArtifactBytes: 5_000_000 } };
    const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const owner = async (id) => { if (id !== userId) throw new Meteor.Error('not-authorized'); };
    mutate = async (request) => {
      await request.onMutationStart(); calls.push(['changed', request.action]);
      return { action: request.action, path: request.path, hash: 'a'.repeat(64) };
    };
    adapter = {
      createWorkspace: async (request) => { calls.push(['create', request]); }, applyPolicies: async () => {}, destroyWorkspace: async (request) => { calls.push(['destroy', request]); },
      mutateWorkspaceFile: (request) => { calls.push(['request', request]); return mutate(request); },
      listWorkingFiles: async () => [
        { name: 'notes.txt', path: '/workspace/notes.txt', type: 'file', size: 5 }, { name: 'runs', path: '/workspace/runs', type: 'directory', size: 0 },
      ],
      readWorkingFile: async () => ({ content: Buffer.from('draft') }),
      stopExecution: async (request) => { calls.push(['stop', request.sessionId]); return { stopped: true }; },
    };
    const host = { CrewConfigs: { findOneAsync: async () => ({ enabled: true }), find: () => ({ fetchAsync: async () => [{ agent: 'atlas' }, { agent: 'signal' }, { agent: 'other-mission' }] }) }, missionAllowsAgent: async (_context, agent) => agent !== 'other-mission',
      MissionConfigs: { findOneAsync: async () => ({ status: missionStatus }) } };
    service = environmentModule.createExecutionEnvironmentService(host, { adapter, owner,
      rootMission: async (id, mission) => { await owner(id); if (!missionExists || mission !== missionId) throw new Meteor.Error('execution-mission-unavailable'); return { _id: mission, userId, archived }; },
      tokenFor: async () => 'file-fixture-token', getSettings: async () => settings, locked: async (_key, work) => work(), digest,
      fail: (code, message) => { throw new Meteor.Error(code, message); }, checkConnections: async (_id, token) => { assert.strictEqual(token, 'file-fixture-token'); calls.push(['grants']); await connectionReview(); },
    });
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: ['atlas'], retention: 'keep' });
    const lease = await service.acquireRun({ userId, missionId, agent: 'atlas', jobId: Random.id(), token: 'file-fixture-token', assertActive: async () => {} });
    await service.release(lease);
  });
  afterEach(async () => { await environmentModule.ExecutionEnvironments.removeAsync({ userId }); await environmentModule.ExecutionFileRequests.removeAsync({ userId }); });

  it('checks owner, paths and current permission before any file mutation', async () => {
    await rejected(service.mutateEnvironmentFile('foreign', change()), 'not-authorized');
    for (const path of ['/workspace', '/etc/config', '/workspace/../outside', '/workspace/runs/private.py', '/workspace/inputs/data.csv', '/workspace/.constellation-trash/item']) {
      await rejected(service.mutateEnvironmentFile(userId, change({ path })), 'execution-invalid-path');
    }
    await rejected(service.mutateEnvironmentFile(userId, change({ savePointId: 'v1' })), 'execution-invalid-action');
    allowed = false; await rejected(service.mutateEnvironmentFile(userId, change(), { assertActive: guard }), 'execution-access-off');
    assert.isFalse(calls.some(([kind]) => kind === 'request'));
  });

  it('returns hashes and marks managed folders read-only', async () => {
    const file = await service.readEnvironmentFile(userId, { missionId, path: '/workspace/notes.txt' }, { assertActive: guard });
    assert.strictEqual(file.hash, createHash('sha256').update('draft').digest('hex')); assert.isTrue(file.writable);
    const listing = await service.environmentFiles(userId, { missionId }, { assertActive: guard });
    assert.isTrue(listing.writable); assert.isTrue(listing.entries[0].writable); assert.isFalse(listing.entries[1].writable);
    allowed = false; await rejected(service.environmentFiles(userId, { missionId }, { assertActive: guard }), 'execution-access-off');
  });

  it('serializes changes, passes hashes, and stores only a bounded receipt', async () => {
    let finish;
    mutate = async (request) => { await request.onMutationStart(); await new Promise((resolve) => { finish = resolve; }); return { action: 'write', path: request.path }; };
    const first = service.mutateEnvironmentFile(userId, change({ expectedHash: 'c'.repeat(64) }), { assertActive: guard });
    try {
      await waitFor(() => !!finish);
      await rejected(service.mutateEnvironmentFile(userId, change({ path: '/workspace/other.txt' })), 'execution-environment-busy');
      finish(); await first;
      const request = calls.find(([kind]) => kind === 'request')[1]; assert.strictEqual(request.expectedHash, 'c'.repeat(64));
      const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId }); assert.strictEqual(row.status, 'ready'); assert.strictEqual(row.fileRevision, 1);
      assert.notProperty(row, 'fileMutation'); assert.notProperty(row.lastFileMutation, 'text'); assert.notProperty(row.lastFileMutation, 'content'); assert.notProperty(row.lastFileMutation, 'base64');
    } finally { finish?.(); await first; }
  });

  it('rechecks agent authorization at the native mutation boundary, not only at method entry', async () => {
    mutate = async (request) => { allowed = false; await request.onMutationStart(); calls.push(['changed']); };
    await rejected(service.mutateEnvironmentFile(userId, change(), { assertActive: guard }), 'execution-access-off');
    assert.isFalse(calls.some(([kind]) => kind === 'changed'));
    const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId }); assert.strictEqual(row.status, 'ready'); assert.notProperty(row, 'fileMutation');
  });

  it('treats hash and collision refusals as safe failures without quarantine', async () => {
    for (const code of ['file-changed', 'file-exists']) {
      mutate = async () => { throw Object.assign(new Error('private guest detail'), { code }); };
      await rejected(service.mutateEnvironmentFile(userId, change()), `execution-${code}`);
      const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId }); assert.strictEqual(row.status, 'ready'); assert.notProperty(row, 'fileMutation');
    }
  });

  it('retains an uncertain file receipt and reconciles without replaying the change', async () => {
    mutate = async (request) => { await request.onMutationStart(); throw Object.assign(new Error('private guest detail'), { code: 'file-operation-unconfirmed' }); };
    try { await service.mutateEnvironmentFile(userId, change()); } catch {}
    let row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(row.status, 'needs-attention'); assert.strictEqual(row.fileMutation.path, '/workspace/notes.txt'); assert.notProperty(row, 'helperSessionId');
    await service.reconcileEnvironment(userId, { missionId }); row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(row.status, 'ready'); assert.strictEqual(row.lastFileMutation.status, 'unknown'); assert.notProperty(row, 'fileMutation');
    assert.lengthOf(calls.filter(([kind]) => kind === 'request'), 1); assert.lengthOf(calls.filter(([kind]) => kind === 'stop'), 0);
  });

  it('requires explicit confirmation for native deletion and has no custom trash', async () => {
    await rejected(service.mutateEnvironmentFile(userId, { missionId, action: 'delete', path: '/workspace/notes.txt' }), 'execution-file-confirm-required');
    await service.mutateEnvironmentFile(userId, { missionId, action: 'delete', path: '/workspace/notes.txt', confirm: true });
    assert.deepEqual(calls.filter(([kind]) => kind === 'request').map(([, request]) => request.action), ['delete']);
    for (const action of ['trash', 'restore']) await rejected(service.mutateEnvironmentFile(userId, { missionId, action, path: '/workspace/notes.txt' }), 'execution-invalid-action');
  });

  it('deduplicates agent requests durably and rejects reused IDs with different content', async () => {
    const guards = { assertActive: guard, requestId: 'child:one' };
    const first = await service.mutateEnvironmentFile(userId, change(), guards);
    const replayed = await service.mutateEnvironmentFile(userId, change(), guards);
    assert.strictEqual(first.status, 'completed'); assert.isTrue(replayed.replayed);
    assert.lengthOf(calls.filter(([kind]) => kind === 'request'), 1);
    await rejected(service.mutateEnvironmentFile(userId, change({ text: 'different' }), guards), 'execution-file-request-conflict');
    const stored = await environmentModule.ExecutionFileRequests.findOneAsync({ userId });
    assert.notProperty(stored, 'text'); assert.notProperty(stored, 'base64'); assert.notProperty(stored, 'content'); assert.match(stored.fingerprint, /^[a-f0-9]{64}$/);
    await service.deleteEnvironment(userId, { missionId, confirm: true });
    const historical = await service.mutateEnvironmentFile(userId, change(), guards);
    assert.isTrue(historical.replayed); assert.isTrue(historical.previousEnvironment); assert.lengthOf(calls.filter(([kind]) => kind === 'request'), 1);
  });

  it('never replays pending or unknown file requests and removes receipts with an erased mission', async () => {
    const guards = { requestId: 'child:uncertain' }; let finish;
    mutate = async (request) => { await request.onMutationStart(); await new Promise((resolve) => { finish = resolve; }); throw Object.assign(new Error('lost outcome'), { code: 'file-operation-unconfirmed' }); };
    const first = service.mutateEnvironmentFile(userId, change(), guards).catch(() => {});
    try {
      await waitFor(() => !!finish);
      const pending = await service.mutateEnvironmentFile(userId, change(), guards); assert.strictEqual(pending.status, 'pending'); assert.isTrue(pending.replayed);
      finish(); await first; await service.reconcileEnvironment(userId, { missionId });
      const unknown = await service.mutateEnvironmentFile(userId, change(), guards); assert.strictEqual(unknown.status, 'unknown');
      assert.lengthOf(calls.filter(([kind]) => kind === 'request'), 1);
      await service.scrubMission(missionId); assert.strictEqual(await environmentModule.ExecutionFileRequests.find({ userId }).countAsync(), 0);
    } finally { finish?.(); await first; }
  });

  it('fails at the receipt capacity instead of evicting earlier no-replay records', async () => {
    await environmentModule.ExecutionFileRequests.rawCollection().insertMany(Array.from({ length: 1000 }, (_, index) => ({ _id: `${userId}-${index}`, userId, missionId, status: 'unknown' })));
    await rejected(service.mutateEnvironmentFile(userId, change(), { requestId: 'at-capacity' }), 'execution-file-request-limit');
    assert.isFalse(calls.some(([kind]) => kind === 'request')); assert.strictEqual(await environmentModule.ExecutionFileRequests.find({ userId }).countAsync(), 1000);
    assert.strictEqual((await service.getEnvironment(userId, { missionId })).status, 'ready');
  });

  const upload = (patch = {}) => ({ missionId, name: 'Field notes.txt', content: Buffer.from('private chat upload').toString('base64'), contentType: 'text/plain', requestId: 'chat-upload-one', ...patch });

  it('uploads a chat file without enabling code and stores only a metadata receipt', async () => {
    const request = upload(); const before = JSON.stringify(settings);
    const result = await service.uploadChatFile(userId, request);
    assert.include(result, { status: 'completed', path: '/workspace/Field notes.txt', name: request.name, size: 19, contentType: 'text/plain' });
    assert.strictEqual(JSON.stringify(settings), before, 'human uploads must not change agent code permissions');
    const native = calls.find(([kind]) => kind === 'request')[1];
    assert.strictEqual(native.action, 'upload'); assert.strictEqual(native.base64, request.content); assert.notProperty(native, 'expectedHash');
    const receipt = await environmentModule.ExecutionFileRequests.findOneAsync({ userId });
    const environment = await environmentModule.ExecutionEnvironments.findOneAsync({ userId });
    for (const stored of [receipt, environment, result]) {
      assert.notInclude(JSON.stringify(stored), request.content); assert.notInclude(JSON.stringify(stored), 'private chat upload');
      assert.notProperty(stored, 'content'); assert.notProperty(stored, 'base64');
    }
    assert.strictEqual(receipt.status, 'completed');
  });

  it('requires an owned enabled filesystem and a connected provider for chat uploads', async () => {
    await rejected(service.uploadChatFile('foreign', upload()), 'not-authorized');
    await rejected(service.uploadChatFile(userId, upload({ missionId: 'another-mission' })), 'execution-mission-unavailable');
    settings.connectionStatus = 'untested';
    await rejected(service.uploadChatFile(userId, upload()), 'execution-connection-required');
    settings.connectionStatus = 'connected';
    await service.saveEnvironment(userId, { missionId, keepFiles: false, allowedAgents: [], retention: 'keep' });
    await rejected(service.uploadChatFile(userId, upload()), 'attachment-storage-required');
    await environmentModule.ExecutionEnvironments.removeAsync({ userId });
    await rejected(service.uploadChatFile(userId, upload()), 'attachment-storage-required');
    assert.isFalse(calls.some(([kind]) => kind === 'request'));
    assert.strictEqual(await environmentModule.ExecutionFileRequests.find({ userId }).countAsync(), 0);
  });

  it('validates chat upload names, types, canonical bytes and both size limits before writing', async () => {
    for (const name of ['../notes.txt', '/tmp/notes.txt', 'folder/notes.txt', 'folder\\notes.txt', 'line\nnotes.txt', '.constellation-data', 'attachments', ' name.txt', 'é'.repeat(128)]) {
      await rejected(service.uploadChatFile(userId, upload({ name })), 'execution-invalid-path');
    }
    await rejected(service.uploadChatFile(userId, upload({ contentType: 'text/plain\nsecret' })), 'execution-invalid-content');
    await rejected(service.uploadChatFile(userId, upload({ requestId: 'unsafe/request' })), 'execution-invalid-upload-request');
    for (const content of ['abc', '%%==', 'Zh==']) await rejected(service.uploadChatFile(userId, upload({ content })), 'execution-invalid-content');
    settings.limits.maxArtifactBytes = 1024;
    await rejected(service.uploadChatFile(userId, upload({ content: Buffer.alloc(1025).toString('base64') })), 'execution-response-limit');
    settings.limits.maxArtifactBytes = 10_000_000;
    await rejected(service.uploadChatFile(userId, upload({ content: Buffer.alloc(5_000_001).toString('base64') })), 'execution-response-limit');
    assert.isFalse(calls.some(([kind]) => kind === 'request'));
  });

  it('deduplicates completed chat uploads and never replaces an existing file', async () => {
    await service.uploadChatFile(userId, upload());
    const replayed = await service.uploadChatFile(userId, upload());
    assert.isTrue(replayed.replayed); assert.strictEqual(replayed.status, 'completed');
    assert.lengthOf(calls.filter(([kind]) => kind === 'request'), 1);
    await rejected(service.uploadChatFile(userId, upload({ content: Buffer.from('different').toString('base64') })), 'execution-file-request-conflict');
    await rejected(service.uploadChatFile(userId, upload({ name: 'renamed.txt' })), 'execution-file-request-conflict');
    mutate = async (request) => { assert.notProperty(request, 'expectedHash'); throw Object.assign(new Error('Already exists'), { code: 'file-exists' }); };
    await rejected(service.uploadChatFile(userId, upload({ requestId: 'a-new-upload', expectedHash: 'a'.repeat(64) })), 'execution-file-exists');
    assert.strictEqual((await service.getEnvironment(userId, { missionId })).status, 'ready');
    await rejected(service.uploadChatFile(userId, upload({ requestId: 'a-new-upload' })), 'execution-file-request-rejected');
    assert.lengthOf(calls.filter(([kind]) => kind === 'request'), 2);
  });

  it('does not replay pending or uncertain chat uploads, even after reconciliation', async () => {
    let finish;
    mutate = async (request) => { await request.onMutationStart(); await new Promise((resolve) => { finish = resolve; }); throw Object.assign(new Error('Lost outcome'), { code: 'file-operation-unconfirmed' }); };
    const first = service.uploadChatFile(userId, upload()); const settled = first.catch(() => {});
    try {
      await waitFor(() => !!finish);
      const pending = await service.uploadChatFile(userId, upload()); assert.strictEqual(pending.status, 'pending'); assert.isTrue(pending.replayed);
      finish(); await rejected(first, 'execution-file-operation-unconfirmed');
      await service.reconcileEnvironment(userId, { missionId });
      const unknown = await service.uploadChatFile(userId, upload()); assert.strictEqual(unknown.status, 'unknown'); assert.isTrue(unknown.replayed);
      assert.lengthOf(calls.filter(([kind]) => kind === 'request'), 1);
    } finally { finish?.(); await settled; }
  });

  it('rechecks filesystem revocation at the chat upload write boundary', async () => {
    mutate = async (request) => {
      await service.saveEnvironment(userId, { missionId, keepFiles: false, allowedAgents: [], retention: 'keep' });
      await request.onMutationStart(); calls.push(['changed']);
    };
    await rejected(service.uploadChatFile(userId, upload()), 'attachment-storage-required');
    assert.isFalse(calls.some(([kind]) => kind === 'changed'));
    const environment = await environmentModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(environment.status, 'ready'); assert.notProperty(environment, 'fileMutation');
  });

  it('identifies chat upload receipts from a previous filesystem instead of recreating files', async () => {
    await service.uploadChatFile(userId, upload());
    await service.deleteEnvironment(userId, { missionId, confirm: true });
    await service.enableFilesystem(userId, { missionId });
    const result = await service.uploadChatFile(userId, upload());
    assert.isTrue(result.replayed); assert.isTrue(result.previousEnvironment);
    assert.lengthOf(calls.filter(([kind]) => kind === 'request'), 1);
  });

  it('explicitly provisions a filesystem without enabling code execution or granting code tools', async () => {
    await environmentModule.ExecutionEnvironments.removeAsync({ userId }); calls = [];
    const before = JSON.stringify(settings);
    const empty = await service.getEnvironment(userId, { missionId }); assert.strictEqual(empty.status, 'not-created'); assert.lengthOf(calls, 0);
    const environment = await service.enableFilesystem(userId, { missionId });
    assert.strictEqual(environment.status, 'ready'); assert.isTrue(environment.keepFiles); assert.deepEqual(environment.allowedAgents, ['atlas', 'signal']);
    assert.match(environment.workspaceId, /^constellation-mission-[a-f0-9]{32}$/);
    assert.strictEqual(JSON.stringify(settings), before, 'filesystem setup cannot grant arbitrary code execution');
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 1); assert.notProperty(environment, 'credentialHash');
    await service.enableFilesystem(userId, { missionId }); assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 1);
  });

  it('preserves existing explicit grants and allocates only when enable is requested', async () => {
    await environmentModule.ExecutionEnvironments.removeAsync({ userId }); calls = [];
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: [], retention: 'keep' });
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 0);
    const environment = await service.enableFilesystem(userId, { missionId });
    assert.deepEqual(environment.allowedAgents, []); assert.strictEqual(environment.status, 'ready');
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 1);
  });

  it('requires an owner and connected provider before allocating a filesystem', async () => {
    await environmentModule.ExecutionEnvironments.removeAsync({ userId }); calls = []; settings.connectionStatus = 'untested';
    await rejected(service.enableFilesystem('foreign', { missionId }), 'not-authorized');
    await rejected(service.enableFilesystem(userId, { missionId }), 'execution-connection-required');
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 0);
    assert.strictEqual((await service.getEnvironment(userId, { missionId })).status, 'not-created');
  });

  it('quarantines uncertain filesystem creation rather than creating another resource', async () => {
    await environmentModule.ExecutionEnvironments.removeAsync({ userId }); calls = [];
    adapter.createWorkspace = async (request) => { calls.push(['create', request]); throw Object.assign(new Error('private provider detail'), { creationUncertain: true }); };
    await rejected(service.enableFilesystem(userId, { missionId }), 'execution-filesystem-unconfirmed');
    const environment = await service.getEnvironment(userId, { missionId });
    assert.strictEqual(environment.status, 'needs-attention'); assert.isTrue(environment.creationUncertain); assert.ok(environment.cleanupRetryAfter);
    await rejected(service.enableFilesystem(userId, { missionId }), 'execution-environment-attention');
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 1); assert.notInclude(environment.error, 'private provider detail');
  });

  it('retains cleanup ownership if a mission is erased during explicit filesystem creation', async () => {
    await environmentModule.ExecutionEnvironments.removeAsync({ userId }); calls = [];
    let finish;
    adapter.createWorkspace = async (request) => { calls.push(['create', request]); await new Promise((resolve) => { finish = resolve; }); };
    const enabling = service.enableFilesystem(userId, { missionId }); const settled = enabling.catch(() => {});
    try {
      await waitFor(() => !!finish); missionExists = false; await service.scrubMission(missionId);
      finish(); await rejected(enabling, 'execution-filesystem-unconfirmed');
      const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId });
      assert.ok(row.erasedAt); assert.ok(row.deletionRequestedAt); assert.isFalse(row.keepFiles);
      assert.lengthOf(calls.filter(([kind]) => kind === 'destroy'), 1);
      assert.strictEqual(calls.find(([kind]) => kind === 'destroy')[1].workspaceId, calls.find(([kind]) => kind === 'create')[1].workspaceId);
    } finally { finish?.(); await settled; }
  });

  it('never allocates for a completed or archived mission with delete-on-completion retention', async () => {
    await service.deleteEnvironment(userId, { missionId, confirm: true });
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: ['atlas'], retention: 'delete-on-completion' }); calls = [];
    for (const status of ['completed', 'archived']) {
      missionStatus = status;
      await rejected(service.enableFilesystem(userId, { missionId }), 'execution-filesystem-completed');
    }
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 0);
    assert.strictEqual((await service.getEnvironment(userId, { missionId })).status, 'not-created');
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: ['atlas'], retention: 'keep' });
    assert.strictEqual((await service.enableFilesystem(userId, { missionId })).status, 'ready', 'explicit retention change permits enabling');
  });

  it('rejects enabling an archived root without blocking reads of existing retained files', async () => {
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: ['atlas'], retention: 'delete-on-completion' }); calls = []; archived = new Date();
    await rejected(service.enableFilesystem(userId, { missionId }), 'execution-filesystem-completed');
    const file = await service.readEnvironmentFile(userId, { missionId, path: '/workspace/notes.txt' });
    assert.strictEqual(Buffer.from(file.content, 'base64').toString(), 'draft');
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 0);
  });

  it('rechecks completion after connector review before sending a filesystem create', async () => {
    await service.deleteEnvironment(userId, { missionId, confirm: true });
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: ['atlas'], retention: 'delete-on-completion' }); calls = [];
    let checks = 0;
    connectionReview = async () => { if (++checks === 2) { missionStatus = 'completed'; await service.onMissionCompleted(userId, missionId); } };
    await rejected(service.enableFilesystem(userId, { missionId }), 'execution-filesystem-completed');
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 0);
    const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId }); assert.strictEqual(row.status, 'not-created'); assert.notProperty(row, 'workspaceId');
  });

  it('deletes the exact new filesystem when completion races the remote create response', async () => {
    await service.deleteEnvironment(userId, { missionId, confirm: true });
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: ['atlas'], retention: 'delete-on-completion' }); calls = [];
    adapter.createWorkspace = async (request) => { calls.push(['create', request]); missionStatus = 'completed'; };
    await rejected(service.enableFilesystem(userId, { missionId }), 'execution-filesystem-completed');
    const create = calls.filter(([kind]) => kind === 'create'); const remove = calls.filter(([kind]) => kind === 'destroy');
    assert.lengthOf(create, 1); assert.lengthOf(remove, 1); assert.strictEqual(remove[0][1].workspaceId, create[0][1].workspaceId);
    const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId }); assert.strictEqual(row.status, 'not-created'); assert.notProperty(row, 'workspaceId');
  });

  it('retains cleanup intent when completion races an unconfirmed filesystem create', async () => {
    await service.deleteEnvironment(userId, { missionId, confirm: true });
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: ['atlas'], retention: 'delete-on-completion' }); calls = [];
    adapter.createWorkspace = async (request) => { calls.push(['create', request]); missionStatus = 'completed'; throw Object.assign(new Error('lost create response'), { creationUncertain: true }); };
    await rejected(service.enableFilesystem(userId, { missionId }), 'execution-filesystem-completed');
    const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId }); assert.strictEqual(row.status, 'needs-attention'); assert.ok(row.deletionRequestedAt); assert.isTrue(row.creationUncertain);
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 1); assert.lengthOf(calls.filter(([kind]) => kind === 'destroy'), 1);
  });
});
