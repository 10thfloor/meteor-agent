import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) describe('Constellation Sprite attachment storage', function () {
  let createStorage; let attachmentStoragePath; let createHash;
  const workspaceId = 'constellation-mission-0123456789abcdef0123456789abcdef';
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const input = (patch = {}) => ({ id: 'attFixture', sessionId: 'child', name: 'Report.txt', contentType: 'text/plain', size: 5, content: Buffer.from('draft').toString('base64'), sha256: hash('draft'), ...patch });
  const rejected = async (promise, code) => {
    let error; try { await promise; } catch (caught) { error = caught; }
    assert.ok(error, `Expected ${code}`); assert.equal(error.error ?? error.code, code);
  };
  before(async () => {
    ({ createSpriteAttachmentStorage: createStorage } = await import('../server/sprite-attachment-storage'));
    ({ attachmentStoragePath } = await import('../server/sprite-attachment-path'));
    ({ createHash } = await import('node:crypto'));
  });
  function fixture() {
    const sessions = new Map([
      ['mission', { _id: 'mission', userId: 'owner', agent: 'orchestrator' }],
      ['child', { _id: 'child', userId: 'owner', agent: 'researcher', parent: { sessionId: 'mission' } }],
      ['other', { _id: 'other', userId: 'owner', agent: 'orchestrator' }],
    ]);
    const calls = []; const files = new Map(); const hooks = {}; let enabled = true; let currentLease;
    const rootMissionSession = async (id) => {
      let row = sessions.get(id);
      for (let depth = 0; row?.parent?.sessionId && depth < 8; depth += 1) row = sessions.get(row.parent.sessionId);
      return row ? { ...row } : null;
    };
    const host = {
      rootMissionSession,
      getSession: async (id) => { const row = sessions.get(id); return row ? { ...row } : null; },
      requireUser: async (userId) => { if (userId !== 'owner') throw new Meteor.Error('not-authorized'); },
      environments: {
        async writeAttachmentFile(userId, request, context) {
          if (!enabled) throw new Meteor.Error('execution-environment-access');
          await hooks.beforeWrite?.(request); await context.assertActive();
          calls.push({ action: 'write', userId, request, lease: currentLease, signal: context.signal });
          const path = attachmentStoragePath(request); files.set(path, request.content);
          await hooks.afterWrite?.(request);
          return { workspaceId, path, missionId: request.missionId, sha256: request.sha256, privateData: 'must-not-escape' };
        },
        async readAttachmentFile(userId, request, context) {
          await hooks.beforeRead?.(request); await context.assertActive();
          if (request.storageReference.workspaceId !== workspaceId) throw new Meteor.Error('attachment-storage-unavailable');
          calls.push({ action: 'read', userId, request, lease: currentLease, signal: context.signal });
          const value = files.get(request.storageReference.path);
          await hooks.afterRead?.(request);
          return value;
        },
        async withAttachmentLease(lease, callback) { const previous = currentLease; currentLease = lease; try { return await callback(); } finally { currentLease = previous; } },
      },
    };
    return { host, storage: createStorage(host), sessions, calls, files, hooks, setEnabled: (value) => { enabled = value; } };
  }
  it('derives safe immutable paths without allowing display names or IDs to select directories', () => {
    const path = attachmentStoragePath({ attachmentId: 'attOne', name: '../folder/Report.txt', sha256: hash('draft') });
    assert.ok(path.startsWith(`/workspace/attachments/attOne/${hash('draft')}-`));
    assert.equal(path.split('/').length, 5); assert.ok(!path.includes('..'));
    assert.ok(Buffer.byteLength(attachmentStoragePath({ attachmentId: 'attOne', name: '界'.repeat(160), sha256: hash('draft') }).split('/').at(-1)) <= 255);
    assert.notEqual(path, attachmentStoragePath({ attachmentId: 'attOne', name: '../folder/Report.txt', sha256: hash('other') }));
    for (const attachmentId of ['../other', 'a/b', '', 'x'.repeat(161)]) assert.throws(() => attachmentStoragePath({ attachmentId, name: 'file', sha256: hash('draft') }));
    assert.throws(() => attachmentStoragePath({ attachmentId: 'attOne', name: 'file', sha256: 'wrong' }));
  });
  it('writes a child-session attachment as its root owner and returns only a stable safe reference', async () => {
    const f = fixture(); const source = input(); const reference = await f.storage.write(source);
    assert.equal(f.storage.name, 'sprites');
    assert.deepEqual(reference, { workspaceId, path: attachmentStoragePath({ attachmentId: source.id, name: source.name, sha256: source.sha256 }), missionId: 'mission', sha256: hash('draft') });
    assert.equal(f.calls[0].userId, 'owner'); assert.equal(f.calls[0].request.sessionId, 'child'); assert.equal(f.calls[0].request.missionId, 'mission');
    assert.equal(f.calls[0].request.attachmentId, source.id); assert.equal(f.calls[0].request.sha256, hash('draft'));
    const second = await f.storage.write(input({ content: Buffer.from('other').toString('base64'), sha256: hash('other') }));
    assert.notEqual(second.path, reference.path); assert.equal(f.files.size, 2);
  });
  it('reads verified bytes in the exact mission, including when new filesystem writes are disabled', async () => {
    const f = fixture(); const source = input(); const reference = await f.storage.write(source); f.setEnabled(false);
    const content = await f.storage.read({ ...source, storageReference: reference, contentSha256: reference.sha256 });
    assert.equal(content, source.content);
    await rejected(f.storage.write(source), 'execution-environment-access');
    assert.equal(f.calls.filter((call) => call.action === 'read').length, 1);
  });
  it('validates large legacy payloads without a recursive regular expression', async () => {
    const f = fixture(); const bytes = Buffer.alloc(5_100_000, 65);
    const source = input({ content: bytes.toString('base64'), size: bytes.length, sha256: hash(bytes) });
    const reference = await f.storage.write(source);
    assert.equal(await f.storage.read({ ...source, storageReference: reference }), source.content);
    assert.lengthOf(f.calls.filter((call) => call.action === 'write'), 1);
  });
  it('rejects forged paths, attachment IDs, mission references and content hashes before reading', async () => {
    const f = fixture(); const source = input(); const reference = await f.storage.write(source);
    for (const patch of [{ path: '/workspace/secret' }, { path: reference.path.replace('attFixture', 'attSomeoneElse') }, { sha256: hash('other') }]) {
      await rejected(f.storage.read({ ...source, storageReference: { ...reference, ...patch } }), 'attachment-storage-invalid');
    }
    await rejected(f.storage.read({ ...source, storageReference: { ...reference, missionId: 'other' } }), 'attachment-storage-unavailable');
    await rejected(f.storage.read({ ...source, storageReference: reference, contentSha256: hash('wrong') }), 'attachment-storage-invalid');
    await rejected(f.storage.read({ ...source, storageReference: reference, sha256: hash('wrong') }), 'attachment-storage-invalid');
    await rejected(f.storage.read({ ...source, storageReference: reference, id: 'attSomeoneElse' }), 'attachment-storage-invalid');
    assert.equal(f.calls.filter((call) => call.action === 'read').length, 0);
  });
  it('rejects wrong environment generations and changed remote content without returning bytes', async () => {
    const f = fixture(); const source = input(); const reference = await f.storage.write(source);
    await rejected(f.storage.read({ ...source, storageReference: { ...reference, workspaceId: 'constellation-mission-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }), 'attachment-storage-unavailable');
    f.files.set(reference.path, Buffer.from('other').toString('base64'));
    await rejected(f.storage.read({ ...source, storageReference: reference }), 'attachment-storage-invalid');
    f.files.set(reference.path, Buffer.from('too long').toString('base64'));
    await rejected(f.storage.read({ ...source, storageReference: reference }), 'attachment-storage-invalid');
  });
  it('refuses missing, erasing, ephemeral, foreign and mismatched child sessions', async () => {
    for (const patch of [{ erasingAt: new Date() }, { erasedAt: new Date() }, { ephemeral: true }, { userId: 'foreign' }]) {
      const f = fixture(); Object.assign(f.sessions.get('child'), patch);
      await rejected(f.storage.write(input()), 'attachment-storage-unavailable'); assert.equal(f.calls.length, 0);
    }
    const f = fixture(); f.sessions.delete('child');
    await rejected(f.storage.write(input()), 'attachment-storage-unavailable');
    const foreign = fixture(); await rejected(foreign.storage.write(input({ userId: 'someone-else' })), 'attachment-storage-unavailable');
    await rejected(foreign.storage.write(input({ missionId: 'other' })), 'attachment-storage-unavailable');
  });
  it('checks every session ancestor instead of trusting only the root resolver', async () => {
    const f = fixture(); f.sessions.set('middle', { _id: 'middle', userId: 'owner', erasingAt: new Date(), parent: { sessionId: 'mission' } });
    f.sessions.get('child').parent.sessionId = 'middle';
    await rejected(f.storage.write(input()), 'attachment-storage-unavailable'); assert.equal(f.calls.length, 0);
    delete f.sessions.get('middle').erasingAt; f.sessions.get('middle').parent.sessionId = 'child';
    await rejected(f.storage.write(input()), 'attachment-storage-unavailable');
  });
  it('rechecks authority before native I/O and after remote completion', async () => {
    const f = fixture(); f.hooks.beforeWrite = () => { f.sessions.get('child').erasingAt = new Date(); };
    await rejected(f.storage.write(input()), 'attachment-storage-unavailable'); assert.equal(f.calls.length, 0);
    const after = fixture(); after.hooks.afterWrite = () => { after.sessions.get('mission').erasingAt = new Date(); };
    await rejected(after.storage.write(input()), 'attachment-storage-unavailable'); assert.equal(after.calls.length, 1);
    const read = fixture(); const source = input(); const reference = await read.storage.write(source);
    read.hooks.afterRead = () => { read.sessions.get('child').parent.sessionId = 'other'; };
    await rejected(read.storage.read({ ...source, storageReference: reference }), 'attachment-storage-unavailable');
  });
  it('honors framework guards and cancellation and delegates an exact server lease without a bypass', async () => {
    const f = fixture(); let checks = 0; const controller = new AbortController(); const lease = { environmentId: 'env', operationId: 'exact-op' };
    const reference = await f.storage.withLease(lease, () => f.storage.write(input(), { signal: controller.signal, assertActive: async () => { checks += 1; } }));
    assert.ok(checks >= 3); assert.equal(f.calls[0].lease, lease); assert.equal(f.calls[0].signal, controller.signal);
    controller.abort(); await rejected(f.storage.read({ ...input(), storageReference: reference }, { signal: controller.signal }), 'attachment-storage-cancelled');
    await rejected(f.storage.write(input(), { assertActive: async () => { throw new Meteor.Error('framework-fenced'); } }), 'framework-fenced');
    assert.equal(f.calls.length, 1);
  });
  it('rejects malformed, oversized or mismatched content and never deletes remote files on retirement', async () => {
    const f = fixture();
    for (const patch of [{ content: 'bad' }, { size: 4 }, { size: 10_000_001 }, { sha256: hash('other') }, { contentSha256: hash('other') }]) {
      await rejected(f.storage.write(input(patch)), 'attachment-storage-invalid');
    }
    await f.storage.retire({ id: 'missing', sessionId: 'erased', storageReference: { path: '/workspace/anything' } });
    assert.equal(f.calls.length, 0);
  });
});
