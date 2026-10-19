import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';

if (Meteor.isServer) describe('Constellation read-only mission attachments', function () {
  this.timeout(20000);
  let createService; let sweep; let sessions; let attachments; let jobs; let catalogs; let contents; let versions;
  let service; let userId; let missionId; let childId; let otherMissionId; let treeId; let storage; let remoteFiles;
  const time = new Date('2026-09-21T12:00:00Z');
  const rejected = async (promise, code) => { let failure; try { await promise; } catch (error) { failure = error; } assert.ok(failure, `Expected ${code}`); assert.equal(failure.error, code); };
  const list = (patch = {}) => service.missionFiles(userId, { missionId, ...patch });
  const read = (patch) => service.readMissionFile(userId, { missionId, ...patch });
  const attachment = async (patch = {}) => attachments.insertAsync({ _id: Random.id(), userId, sessionId: missionId,
    name: '1-result.txt', contentType: 'text/plain', size: 4, content: Buffer.from('5050').toString('base64'), createdAt: time, ...patch });
  const legacyFile = async (patch = {}, text = 'edited!') => {
    const contentId = await contents.insertAsync({ _id: Random.id(), userId, missionId, size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
    const entry = { id: Random.id(), kind: 'file', parentId: null, name: '1-result.txt', size: Buffer.byteLength(text), contentType: 'text/plain',
      contentId, history: [], revision: 2, createdAt: time, updatedAt: new Date(time.getTime() + 1000), ...patch };
    const versionId = await versions.insertAsync({ _id: Random.id(), userId, missionId, entryId: entry.id, revision: entry.revision, snapshot: { ...entry } });
    entry.history.push(versionId); await catalogs.updateAsync(treeId, { $push: { entries: entry } }); return entry;
  };
  before(async () => {
    ({ createMissionWorkService: createService } = await import('../server/constellation-work'));
    ({ sweepOrphanMissionFiles: sweep } = await import('../server/mission-file-store'));
    sessions = new Mongo.Collection('test_mission_file_store_sessions'); attachments = new Mongo.Collection('test_mission_file_store_attachments');
    jobs = new Mongo.Collection('test_mission_file_store_jobs'); catalogs = new Mongo.Collection('test_mission_file_store_catalogs');
    contents = new Mongo.Collection('test_mission_file_store_contents'); versions = new Mongo.Collection('test_mission_file_store_versions');
  });
  beforeEach(async () => {
    userId = `file-store-${Random.id()}`;
    missionId = await sessions.insertAsync({ _id: Random.id(), userId, agent: 'orchestrator' });
    childId = await sessions.insertAsync({ _id: Random.id(), userId, agent: 'researcher', parent: { sessionId: missionId } });
    otherMissionId = await sessions.insertAsync({ _id: Random.id(), userId, agent: 'orchestrator' });
    treeId = await catalogs.insertAsync({ _id: Random.id(), userId, missionId, revision: 10, entries: [] });
    const fail = (code, reason) => { throw new Meteor.Error(code, reason); };
    remoteFiles = new Map();
    storage = { name: 'sprites', write: async (file, guard) => { await guard.assertActive(); const path = `/workspace/attachments/${file.id}/${file.name}`; remoteFiles.set(path, file.content); return { path, missionId, workspaceId: 'fixture', sha256: file.sha256 }; },
      read: async (file, guard) => { await guard.assertActive(); return remoteFiles.get(file.storageReference.path); } };
    const readContent = async (row) => row.storageReference ? storage.read({ ...row, id: row._id }, { assertActive: async () => {} }) : row.content;
    const migrateContent = async ({ id, sessionId }) => {
      const row = await attachments.findOneAsync({ _id: id, sessionId });
      const info = { ...row, id }; const guard = { assertActive: async () => {} };
      const storageReference = await storage.write(info, guard);
      if (await storage.read({ ...info, storageReference }, guard) !== row.content) throw new Error('Verification failed');
      await attachments.updateAsync({ _id: id, sessionId, content: row.content }, { $set: { storageProvider: storage.name, storageReference }, $unset: { content: '' } });
    };
    service = createService({ AgentSessions: sessions, AgentAttachments: attachments, MissionFileCatalogs: catalogs, MissionFileContents: contents, MissionFileVersions: versions,
      Agent: { attachments: { readContent, migrateContent } } }, {
      jobs, fail, attachmentStorage: storage, owner: async (id) => { if (id !== userId) fail('not-authorized', 'Not authorized.'); }, publicJob: (row) => row,
      rootMission: async (id, sessionId) => { let row = await sessions.findOneAsync(sessionId); for (let depth = 0; row?.parent?.sessionId && depth < 8; depth += 1) row = await sessions.findOneAsync(row.parent.sessionId);
        if (!row || row.userId !== id || row.erasingAt || row.ephemeral) fail('execution-mission-unavailable', 'Mission unavailable.'); return row; },
    });
  });
  afterEach(async () => { for (const collection of [sessions, attachments, jobs, catalogs, contents, versions]) await collection.removeAsync({ userId }); });

  it('moves originals, edited copies, earlier revisions and Trash to Sprite in bounded batches', async () => {
    const originalId = await attachment(); const current = await legacyFile();
    await legacyFile({ name: 'trashed.txt', trashedAt: new Date() }, 'trashed');
    const previousId = await contents.insertAsync({ _id: Random.id(), userId, missionId, size: 3, content: 'b2xk' });
    await versions.insertAsync({ _id: Random.id(), userId, missionId, entryId: current.id, revision: 1, snapshot: { ...current, contentId: previousId, size: 3 } });
    const beforeTree = await catalogs.findOneAsync(treeId); const beforeVersions = await versions.find({ userId }).fetchAsync();
    assert.equal((await list()).migration.remaining, 4);
    const first = await service.migrateMissionFiles(userId, { missionId, limit: 1 });
    assert.equal(first.migrated, 1); assert.equal(first.remaining, 3); assert.isFalse(first.complete);
    const last = await service.migrateMissionFiles(userId, { missionId, limit: 10 });
    assert.equal(last.migrated, 3); assert.equal(last.remaining, 0); assert.isTrue(last.complete);
    assert.equal(await attachments.find({ userId, content: { $exists: true } }).countAsync(), 0);
    assert.equal(await contents.find({ userId, content: { $exists: true } }).countAsync(), 0);
    assert.equal(remoteFiles.size, 4); assert.equal((await list()).migration.remaining, 0);
    assert.isTrue((await list()).rows.every((row) => row.storage === 'sprite' && !row.needsMigration));
    assert.equal((await read({ attachmentId: originalId })).content, 'NTA1MA==');
    assert.equal((await read({ legacyEntryId: current.id })).content, 'ZWRpdGVkIQ==');
    assert.deepEqual(await catalogs.findOneAsync(treeId), beforeTree);
    assert.deepEqual(await versions.find({ userId }).fetchAsync(), beforeVersions);
    assert.equal((await service.migrateMissionFiles(userId, { missionId })).migrated, 0);
  });
  it('keeps old contents when a remote copy cannot be verified and resumes safely', async () => {
    const current = await legacyFile(); const original = await contents.findOneAsync(current.contentId);
    const readRemote = storage.read; storage.read = async () => 'd3Jvbmc=';
    const failed = await service.migrateMissionFiles(userId, { missionId });
    assert.equal(failed.migrated, 0); assert.equal(failed.remaining, 1); assert.lengthOf(failed.failures, 1);
    assert.deepEqual(await contents.findOneAsync(current.contentId), original);
    storage.read = readRemote;
    assert.isTrue((await service.migrateMissionFiles(userId, { missionId })).complete);
    assert.notProperty(await contents.findOneAsync(current.contentId), 'content');
  });
  it('does not resurrect metadata if a mission is erased during a migration', async () => {
    const current = await legacyFile();
    const write = storage.write; storage.write = async (...args) => {
      const reference = await write(...args); await sessions.updateAsync(missionId, { $set: { erasingAt: new Date() } });
      await contents.removeAsync({ userId, missionId }); return reference;
    };
    await rejected(service.migrateMissionFiles(userId, { missionId }), 'execution-mission-unavailable');
    assert.isUndefined(await contents.findOneAsync(current.contentId));
  });
  it('never migrates foreign missions and validates batch limits', async () => {
    await legacyFile();
    await rejected(service.migrateMissionFiles('foreign', { missionId }), 'not-authorized');
    for (const limit of [0, 26, 1.5, '10']) await rejected(service.migrateMissionFiles(userId, { missionId, limit }), 'invalid-execution');
    assert.equal(remoteFiles.size, 0);
  });

  it('retains the original attachment and its edited saved copy as distinct downloads', async () => {
    const originalId = await attachment(); const saved = await legacyFile({ id: originalId, sourceSessionId: missionId });
    const result = await list(); assert.lengthOf(result.rows, 2);
    const original = result.rows.find((row) => row.id === originalId); const preserved = result.rows.find((row) => row.legacy);
    assert.equal(original.size, 4); assert.equal(preserved.size, 7); assert.equal(preserved.id, `legacy:${originalId}`);
    assert.equal(preserved.legacyEntryId, saved.id); assert.equal(preserved.legacyPath, '/1-result.txt'); assert.isTrue(preserved.readOnly); assert.isFalse(preserved.editable);
    assert.equal((await read({ attachmentId: originalId })).content, Buffer.from('5050').toString('base64'));
    assert.equal((await read({ legacyEntryId: saved.id })).content, Buffer.from('edited!').toString('base64'));
    assert.equal((await read({ entryId: preserved.id })).content, Buffer.from('edited!').toString('base64'));
    assert.equal((await attachments.findOneAsync(originalId)).content, Buffer.from('5050').toString('base64'));
  });
  it('preserves new legacy files and their former folder paths without exposing an editable tree', async () => {
    const folderId = Random.id(); await catalogs.updateAsync(treeId, { $push: { entries: { id: folderId, kind: 'folder', parentId: null, name: 'Reports' } } });
    const saved = await legacyFile({ parentId: folderId, name: 'summary.md' }, '# Summary');
    const result = await list(); assert.lengthOf(result.rows, 1); assert.equal(result.rows[0].legacyPath, '/Reports/summary.md');
    assert.equal(result.rows[0].type, 'file'); assert.notProperty(result.rows[0], 'parentId'); assert.notProperty(result.rows[0], 'revision');
    assert.notProperty(result.rows[0], 'history'); assert.notProperty(result.rows[0], 'contentId');
    assert.equal((await read({ legacyEntryId: saved.id })).content, Buffer.from('# Summary').toString('base64'));
    assert.isUndefined(service.mutateMissionFile); assert.isUndefined(service.missionFileHistory);
  });
  it('does not create catalogs or import attachments while browsing a new mission', async () => {
    await catalogs.removeAsync(treeId); const originalId = await attachment();
    assert.deepEqual((await list()).rows.map((row) => row.id), [originalId]); await read({ attachmentId: originalId });
    assert.equal(await catalogs.find({ userId }).countAsync(), 0); assert.equal(await contents.find({ userId }).countAsync(), 0); assert.equal(await versions.find({ userId }).countAsync(), 0);
  });
  it('never changes existing catalogs, content, revisions or retired Trash during reads', async () => {
    await legacyFile(); const trashed = await legacyFile({ name: 'old.txt', trashedAt: new Date(), trashRootId: 'retired-trash' }, 'recover later');
    const before = await Promise.all([catalogs, contents, versions].map((collection) => collection.find({ userId }).fetchAsync()));
    await list(); await list(); await read({ legacyEntryId: (await list()).rows[0].legacyEntryId });
    await rejected(read({ legacyEntryId: trashed.id }), 'execution-artifact-unavailable');
    const after = await Promise.all([catalogs, contents, versions].map((collection) => collection.find({ userId }).fetchAsync()));
    assert.deepEqual(after, before);
  });
  it('omits unedited catalog imports rather than duplicating original evidence', async () => {
    const originalId = await attachment();
    await catalogs.updateAsync(treeId, { $push: { entries: { id: originalId, kind: 'file', name: '1-result.txt', parentId: null, attachmentId: originalId,
      sourceSessionId: missionId, size: 4, contentType: 'text/plain', createdAt: time, updatedAt: time } } });
    assert.deepEqual((await list()).rows.map((row) => row.id), [originalId]);
    await rejected(read({ legacyEntryId: originalId }), 'execution-artifact-unavailable');
  });
  it('pages a mixed original and legacy list without duplicates or skipped files', async () => {
    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(await attachment({ createdAt: new Date(time.getTime() + index * 2000) }));
      const entry = await legacyFile({ updatedAt: new Date(time.getTime() + index * 2000 + 1000) }); ids.push(`legacy:${entry.id}`);
    }
    const seen = []; let cursor;
    do { const result = await list({ limit: 2, ...(cursor ? { cursor } : {}) }); seen.push(...result.rows.map((row) => row.id)); cursor = result.nextCursor; } while (cursor);
    assert.sameMembers(seen, ids); assert.equal(new Set(seen).size, 6);
    const first = await list({ limit: 1 });
    await rejected(list({ cursor: first.nextCursor, search: 'different' }), 'execution-invalid-cursor');
    await rejected(service.missionFiles(userId, { missionId: otherMissionId, cursor: first.nextCursor }), 'execution-invalid-cursor');
  });
  it('uses literal search consistently for originals and preserved files', async () => {
    const original = await attachment({ name: 'Report [final].txt' }); const saved = await legacyFile({ name: 'Notes [final].txt' });
    await attachment({ name: 'Report final.txt' }); await legacyFile({ name: 'Notes final.txt' });
    assert.sameMembers((await list({ search: '[FINAL]' })).rows.map((row) => row.id), [original, `legacy:${saved.id}`]);
  });
  it('rejects foreign owners, unrelated missions and foreign content references', async () => {
    const saved = await legacyFile();
    await rejected(service.readMissionFile('other-user', { missionId, legacyEntryId: saved.id }), 'not-authorized');
    await rejected(service.readMissionFile(userId, { missionId: otherMissionId, legacyEntryId: saved.id }), 'execution-artifact-unavailable');
    await contents.updateAsync(saved.contentId, { $set: { missionId: otherMissionId } });
    await rejected(read({ legacyEntryId: saved.id }), 'execution-artifact-unavailable');
  });
  it('hides erased sources and inherited erased ancestry for edited files and copies', async () => {
    const grandchild = await sessions.insertAsync({ _id: Random.id(), userId, agent: 'critic', parent: { sessionId: childId } });
    const edited = await legacyFile({ sourceSessionId: grandchild, originSessionIds: [grandchild, childId] });
    const copied = await legacyFile({ originSessionIds: [grandchild, childId], name: 'copy.txt' }); await legacyFile({ name: 'root.txt' });
    await sessions.updateAsync(childId, { $set: { erasingAt: new Date() } });
    assert.deepEqual((await list()).rows.map((row) => row.name), ['root.txt']);
    await rejected(read({ legacyEntryId: edited.id }), 'execution-artifact-unavailable'); await rejected(read({ legacyEntryId: copied.id }), 'execution-artifact-unavailable');
    await service.scrubFileSession(childId); assert.equal(await contents.find({ userId }).countAsync(), 1); assert.equal(await versions.find({ userId }).countAsync(), 1);
  });
  it('fails closed for malformed or hidden folder ancestry', async () => {
    const parent = Random.id(); const saved = await legacyFile({ parentId: parent });
    assert.isEmpty((await list()).rows); await rejected(read({ legacyEntryId: saved.id }), 'execution-artifact-unavailable');
    await catalogs.updateAsync(treeId, { $push: { entries: { id: parent, parentId: parent, name: 'Loop', kind: 'folder' } } });
    assert.isEmpty((await list()).rows);
    await catalogs.updateAsync({ _id: treeId, 'entries.id': parent }, { $set: { 'entries.$.parentId': null, 'entries.$.trashedAt': new Date() } });
    assert.isEmpty((await list()).rows);
  });
  it('bounds preserved content reads and rejects malformed payloads', async () => {
    const large = await legacyFile({ size: 10_000_001 }); await rejected(read({ legacyEntryId: large.id }), 'execution-artifact-limit');
    const malformed = await legacyFile(); await contents.updateAsync(malformed.contentId, { $set: { content: 'bad!' } });
    await rejected(read({ legacyEntryId: malformed.id }), 'execution-artifact-unavailable');
    const mismatch = await legacyFile(); await contents.updateAsync(mismatch.contentId, { $set: { size: 3 } });
    await rejected(read({ legacyEntryId: mismatch.id }), 'execution-artifact-unavailable');
    await rejected(read({ legacyEntryId: { $ne: '' } }), 'invalid-execution');
  });
  it('preserves live legacy data on startup and removes it only with the mission privacy lifecycle', async () => {
    await legacyFile(); const before = await catalogs.findOneAsync(treeId);
    await sweep(sessions, { catalogs, contents, versions }); assert.deepEqual(await catalogs.findOneAsync(treeId), before);
    assert.equal(await contents.find({ userId }).countAsync(), 1); assert.equal(await versions.find({ userId }).countAsync(), 1);
    await service.scrubFileSession(missionId);
    for (const collection of [catalogs, contents, versions]) assert.equal(await collection.find({ userId }).countAsync(), 0);
  });
});
