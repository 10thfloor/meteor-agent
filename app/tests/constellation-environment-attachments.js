import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

if (Meteor.isServer) describe('Sprite-only environment attachment storage', function () {
  this.timeout(15000);
  let environmentModule; let createHash; let service; let adapter; let userId; let missionId; let bytes; let calls; let allowed;
  const reject = async (promise, code) => { let error; try { await promise; } catch (caught) { error = caught; } assert.ok(error, `Expected ${code}`); assert.strictEqual(error.error, code); };
  const file = (text = 'hello', patch = {}) => ({ missionId, sessionId: missionId, attachmentId: 'attachment-one', name: 'report.txt', contentType: 'text/plain', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64'), ...patch });
  const guard = async () => { if (!allowed) throw new Meteor.Error('attachment-cancelled', 'The attachment operation ended.'); };
  const acquire = () => service.acquireRun({ userId, missionId, agent: 'atlas', jobId: Random.id(), token: 'attachment-token', assertActive: guard });
  before(async () => { environmentModule = await import('../server/constellation-environments'); ({ createHash } = await import('node:crypto')); });
  beforeEach(async () => {
    userId = `attachment-owner-${Random.id()}`; missionId = `attachment-mission-${Random.id()}`; bytes = new Map(); calls = []; allowed = true;
    const fail = (code, reason) => { throw new Meteor.Error(code, reason); };
    const owner = async (id) => { if (id !== userId) fail('not-authorized', 'Owner required'); };
    adapter = {
      createWorkspace: async (request) => { calls.push(['create', request]); }, destroyWorkspace: async () => {}, applyPolicies: async () => {},
      writeFile: async (request) => { calls.push(['write', request.path]); bytes.set(request.path, Buffer.from(request.content)); },
      readWorkingFile: async (request) => {
        calls.push(['read', request.path]); const content = bytes.get(request.path);
        if (!content) throw Object.assign(new Error('missing'), { code: 'file-not-found' });
        if (content.length > request.maxBytes) throw Object.assign(new Error('too large'), { code: 'response-limit' });
        return { content: Buffer.from(content) };
      },
    };
    service = environmentModule.createExecutionEnvironmentService({ CrewConfigs: { findOneAsync: async () => ({ enabled: true }) }, missionAllowsAgent: async () => true }, {
      adapter, owner, fail, rootMission: async (id, target) => { await owner(id); if (target !== missionId) fail('mission-unavailable', 'Wrong mission'); return { _id: missionId, userId }; },
      getSettings: async () => ({ domains: [], limits: { maxArtifactBytes: 5_000_000 } }), tokenFor: async () => 'attachment-token',
      locked: async (_key, work) => work(), digest: (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'), checkConnections: async () => {},
    });
    await service.saveEnvironment(userId, { missionId, keepFiles: true, allowedAgents: ['atlas'], retention: 'keep' });
    const lease = await acquire(); await service.release(lease); calls = [];
  });
  afterEach(async () => { await environmentModule.ExecutionEnvironments.removeAsync({ userId }); });

  it('writes verified content-addressed snapshots and retains only metadata in Mongo', async () => {
    const input = file(); const reference = await service.writeAttachmentFile(userId, input, { assertActive: guard });
    assert.strictEqual(reference.missionId, missionId); assert.include(reference.path, '/workspace/attachments/attachment-one/');
    assert.strictEqual(reference.sha256, createHash('sha256').update('hello').digest('hex')); assert.include(reference.path, reference.sha256);
    assert.strictEqual(await service.readAttachmentFile(userId, { ...input, storageReference: reference }), input.content);
    const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(row.fileRevision, 1); assert.notProperty(row, 'content'); assert.notProperty(row, 'fileMutation');
    assert.strictEqual(JSON.stringify(row).includes(input.content), false);
  });

  it('does not provision or fall back when no enabled mission filesystem exists', async () => {
    await service.deleteEnvironment(userId, { missionId, confirm: true }); calls = [];
    await reject(service.writeAttachmentFile(userId, file()), 'attachment-storage-required');
    assert.isEmpty(calls); assert.strictEqual(bytes.size, 0);
  });

  it('reuses identical snapshots but never overwrites a different attachment body', async () => {
    const first = await service.writeAttachmentFile(userId, file());
    const same = await service.writeAttachmentFile(userId, file()); assert.deepEqual(same, first);
    assert.lengthOf(calls.filter(([kind]) => kind === 'write'), 1);
    const other = await service.writeAttachmentFile(userId, file('world')); assert.notStrictEqual(other.path, first.path);
    assert.strictEqual(bytes.get(first.path).toString(), 'hello'); assert.strictEqual(bytes.get(other.path).toString(), 'world');
  });

  it('moves legacy files up to 10 MB without depending on the current code-run file limit', async () => {
    const content = Buffer.alloc(5_100_000, 65); const input = file('', { size: content.length, content: content.toString('base64') });
    const reference = await service.writeAttachmentFile(userId, input);
    assert.strictEqual(await service.readAttachmentFile(userId, { ...input, storageReference: reference }), input.content);
    await reject(service.writeAttachmentFile(userId, file('', { size: 10_000_001, content: 'YQ==' })), 'attachment-invalid');
    assert.lengthOf(calls.filter(([kind]) => kind === 'write'), 1);
  });

  it('refuses changed, missing, forged and previous-generation references', async () => {
    const input = file(); const reference = await service.writeAttachmentFile(userId, input);
    await reject(service.readAttachmentFile(userId, { ...input, storageReference: { ...reference, missionId: 'foreign' } }), 'attachment-invalid');
    await reject(service.readAttachmentFile(userId, { ...input, storageReference: { ...reference, path: '/workspace/unrelated' } }), 'attachment-invalid');
    await reject(service.readAttachmentFile(userId, { ...input, storageReference: { ...reference, workspaceId: 'previous' } }), 'attachment-storage-missing');
    bytes.set(reference.path, Buffer.from('other'));
    await reject(service.readAttachmentFile(userId, { ...input, storageReference: reference }), 'attachment-storage-changed');
    await reject(service.writeAttachmentFile(userId, input), 'attachment-storage-changed');
    assert.lengthOf(calls.filter(([kind]) => kind === 'write'), 1);
    bytes.delete(reference.path);
    await reject(service.readAttachmentFile(userId, { ...input, storageReference: reference }), 'attachment-storage-missing');
  });

  it('allows existing attachment reads with sharing off but refuses new writes', async () => {
    const input = file(); const reference = await service.writeAttachmentFile(userId, input);
    await service.saveEnvironment(userId, { missionId, keepFiles: false, allowedAgents: [], retention: 'keep' });
    assert.strictEqual(await service.readAttachmentFile(userId, { ...input, storageReference: reference }), input.content);
    await reject(service.writeAttachmentFile(userId, file('new')), 'attachment-storage-required');
  });

  it('adopts only the exact live operation lease for run output and readback', async () => {
    const lease = await acquire(); const input = file(); let reference;
    try {
      await reject(service.writeAttachmentFile(userId, input), 'execution-environment-busy');
      await reject(service.withAttachmentLease({ ...lease, operationId: 'wrong' }, () => service.writeAttachmentFile(userId, input)), 'attachment-storage-lease');
      reference = await service.withAttachmentLease(lease, async () => {
        const result = await service.writeAttachmentFile(userId, input, { assertActive: guard });
        assert.strictEqual(await service.readAttachmentFile(userId, { ...input, storageReference: result }), input.content); return result;
      });
      const row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId }); assert.strictEqual(row.operationId, lease.operationId); assert.strictEqual(row.status, 'busy');
    } finally { await service.release(lease); }
    assert.ok(reference);
    await reject(service.withAttachmentLease(lease, () => service.readAttachmentFile(userId, { ...input, storageReference: reference })), 'attachment-storage-lease');
  });

  it('checks live authority immediately before a write and never stores fallback bytes', async () => {
    const original = adapter.readWorkingFile;
    adapter.readWorkingFile = async (request) => { allowed = false; return original(request); };
    await reject(service.writeAttachmentFile(userId, file(), { assertActive: guard }), 'attachment-cancelled');
    assert.lengthOf(calls.filter(([kind]) => kind === 'write'), 0); assert.strictEqual(bytes.size, 0);
    assert.strictEqual((await service.getEnvironment(userId, { missionId })).status, 'ready');
  });

  it('keeps an unconfirmed adopted write quarantined after the run releases its lease', async () => {
    const lease = await acquire();
    adapter.writeFile = async (request) => { calls.push(['write', request.path]); throw new Error('private provider detail'); };
    await reject(service.withAttachmentLease(lease, () => service.writeAttachmentFile(userId, file())), 'attachment-storage-unconfirmed');
    await service.release(lease);
    let row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(row.status, 'needs-attention'); assert.isTrue(row.attachmentWriteUnconfirmed); assert.strictEqual(row.recoveryKind, 'files');
    assert.notProperty(row.fileMutation, 'content'); assert.notProperty(row.fileMutation, 'base64');
    await service.reconcileEnvironment(userId, { missionId }); row = await environmentModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(row.status, 'ready'); assert.notProperty(row, 'attachmentWriteUnconfirmed'); assert.strictEqual(row.lastFileMutation.status, 'unknown');
    assert.lengthOf(calls.filter(([kind]) => kind === 'write'), 1, 'reconcile never replays a write');
  });

  it('does not replace an earlier uncertain file-change receipt when adopting a recovery lease', async () => {
    const lease = await acquire();
    const receipt = { id: 'earlier', action: 'move', path: '/workspace/original', requestedAt: new Date() };
    await environmentModule.ExecutionEnvironments.updateAsync(lease.environmentId, { $set: { fileMutation: receipt, recoveryKind: 'files' } });
    try {
      await reject(service.withAttachmentLease(lease, () => service.writeAttachmentFile(userId, file())), 'attachment-storage-unavailable');
      assert.deepEqual((await environmentModule.ExecutionEnvironments.findOneAsync(lease.environmentId)).fileMutation, receipt);
      assert.lengthOf(calls.filter(([kind]) => kind === 'write'), 0);
    } finally { await service.release(lease, { uncertain: true }); }
  });

  it('rechecks the adopted run authority before dispatching an output snapshot write', async () => {
    const lease = await acquire(); let runAllowed = true;
    const original = adapter.readWorkingFile;
    adapter.readWorkingFile = async (request) => { runAllowed = false; return original(request); };
    try {
      await reject(service.withAttachmentLease({ ...lease, assertActive: async () => { if (!runAllowed) throw new Meteor.Error('execution-access-off', 'Run access changed'); } },
        () => service.writeAttachmentFile(userId, file())), 'execution-access-off');
      assert.lengthOf(calls.filter(([kind]) => kind === 'write'), 0);
    } finally { await service.release(lease); }
  });

  it('passes the adopted run cancellation signal to Sprite attachment I/O', async () => {
    const lease = await acquire(); const controller = new AbortController();
    const original = adapter.readWorkingFile;
    adapter.readWorkingFile = async (request) => { assert.strictEqual(request.signal, controller.signal); controller.abort(); return original(request); };
    try {
      await reject(service.withAttachmentLease({ ...lease, signal: controller.signal }, () => service.writeAttachmentFile(userId, file())), 'attachment-storage-cancelled');
      assert.lengthOf(calls.filter(([kind]) => kind === 'write'), 0);
    } finally { await service.release(lease); }
  });
});
