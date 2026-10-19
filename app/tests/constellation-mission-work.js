import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';

if (Meteor.isServer) describe('Constellation durable mission work', function () {
  this.timeout(20000);
  let createService; let sessions; let attachments; let jobs; let missions; let service; let userId; let otherUser; let missionId; let childId; let otherMissionId;
  const now = new Date('2026-09-21T12:00:00Z');
  const rejected = async (promise, code) => {
    let failure; try { await promise; } catch (error) { failure = error; }
    assert.ok(failure, `Expected ${code}`); assert.equal(failure.error, code);
  };
  before(async () => {
    ({ createMissionWorkService: createService } = await import('../server/constellation-work'));
    sessions = new Mongo.Collection('test_constellation_work_sessions');
    attachments = new Mongo.Collection('test_constellation_work_attachments');
    jobs = new Mongo.Collection('test_constellation_work_jobs');
    missions = new Mongo.Collection('test_constellation_work_missions');
  });
  const session = async (patch = {}) => sessions.insertAsync({ _id: Random.id(), userId, agent: 'atlas', ...patch });
  const job = async (patch = {}) => jobs.insertAsync({ _id: Random.id(), userId, missionId, sessionId: missionId,
    agent: 'atlas', title: 'Run report', status: 'completed', language: 'python', createdAt: now,
    code: 'private source', stdout: 'private output', stderr: 'private error stream',
    credentialHash: 'private credential', fingerprint: 'private fingerprint', remoteSessionId: 'private remote',
    inputFiles: [{ path: 'private input' }], artifacts: [], ...patch });
  const file = async (patch = {}) => attachments.insertAsync({ _id: Random.id(), fixtureOwner: userId, sessionId: missionId,
    name: 'report.txt', contentType: 'text/plain', size: 5, content: Buffer.from('hello').toString('base64'),
    origin: 'tool', createdAt: now, ...patch });
  beforeEach(async () => {
    userId = `mission-work-test-${Random.id()}`; otherUser = `${userId}-other`;
    missionId = await session({ agent: 'orchestrator', title: 'Root title' });
    childId = await session({ parent: { sessionId: missionId }, agent: 'researcher' });
    otherMissionId = await session({ agent: 'orchestrator' });
    await missions.insertAsync({ _id: missionId, userId, title: 'Mission title' });
    const fail = (code, reason) => { throw new Meteor.Error(code, reason); };
    service = createService({ AgentSessions: sessions, AgentAttachments: attachments, MissionConfigs: missions,
      Agent: { attachments: { readContent: async (row) => row.content } } }, {
      jobs, fail,
      owner: async (id) => { if (id !== userId) fail('not-authorized', 'Not the owner.'); },
      rootMission: async (id, sessionId) => {
        let row = await sessions.findOneAsync(sessionId);
        for (let depth = 0; row?.parent?.sessionId && depth < 8; depth += 1) row = await sessions.findOneAsync(row.parent.sessionId);
        if (!row || row.userId !== id || row.erasingAt || row.ephemeral) fail('execution-mission-unavailable', 'Unavailable.');
        return row;
      },
      publicJob: ({ userId: owner, fingerprint, credentialHash, remoteSessionId, ...rest }) => rest,
    });
  });
  afterEach(async () => {
    await service.scrubFileSession(missionId); await service.scrubFileSession(otherMissionId);
    for (const collection of [sessions, jobs, missions]) await collection.removeAsync({ userId: { $in: [userId, otherUser] } });
    await attachments.removeAsync({ fixtureOwner: userId });
  });

  it('pages stable run metadata without code, output, credentials, or arbitrary artifact fields', async () => {
    await job({ _id: `${userId}-a` });
    await job({ _id: `${userId}-b`, artifacts: [{ id: 'file', name: 'result', contentType: 'text/plain', size: 4, content: 'private bytes' }] });
    await job({ _id: `${userId}-c` });
    const first = await service.historyPage(userId, { missionId, limit: 2 });
    assert.deepEqual(first.rows.map((row) => row._id), [`${userId}-c`, `${userId}-b`]);
    assert.equal(first.rows[0].missionTitle, 'Mission title');
    assert.notInclude(JSON.stringify(first), 'private');
    await job({ _id: `${userId}-new`, createdAt: new Date(now.getTime() + 1000) });
    const second = await service.historyPage(userId, { missionId, limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.rows.map((row) => row._id), [`${userId}-a`]); assert.isNull(second.nextCursor);
  });
  it('uses literal title search and exact agent, status, and mission filters', async () => {
    const wanted = await job({ title: 'Report [final]', agent: 'researcher', status: 'failed' });
    await job({ title: 'Report final', agent: 'researcher', status: 'failed' });
    await job({ title: 'Report [final]', agent: 'atlas', status: 'failed' });
    await job({ title: 'Report [final]', agent: 'researcher', status: 'completed' });
    await job({ missionId: otherMissionId, sessionId: otherMissionId, title: 'Report [final]', agent: 'researcher', status: 'failed' });
    const result = await service.historyPage(userId, { missionId, search: '[FINAL]', agent: 'researcher', status: 'failed' });
    assert.deepEqual(result.rows.map((row) => row._id), [wanted]);
  });
  it('binds cursors to owner, mission, and filters and validates bounds', async () => {
    await job(); await job();
    const first = await service.historyPage(userId, { missionId, limit: 1 });
    await rejected(service.historyPage(userId, { missionId: otherMissionId, cursor: first.nextCursor }), 'execution-invalid-cursor');
    await rejected(service.historyPage(userId, { missionId, search: 'other', cursor: first.nextCursor }), 'execution-invalid-cursor');
    await rejected(service.historyPage(userId, { missionId, cursor: `${first.nextCursor}x` }), 'execution-invalid-cursor');
    await rejected(service.historyPage(otherUser, { cursor: first.nextCursor }), 'not-authorized');
    for (const limit of [0, 101, -1, 1.2, '5']) await rejected(service.historyPage(userId, { limit }), 'invalid-execution');
    await rejected(service.historyPage(userId, { status: 'made-up' }), 'invalid-execution');
    await rejected(service.historyPage(userId, { search: { $ne: '' } }), 'invalid-execution');
  });
  it('finds the exact older run and refuses unrelated or erased conversations', async () => {
    const oldest = await job({ createdAt: new Date(now.getTime() - 1000), sessionId: childId });
    for (let index = 0; index < 105; index += 1) await job();
    const result = await service.getRun(userId, { missionId, jobId: oldest });
    assert.equal(result.code, 'private source'); assert.notProperty(result, 'credentialHash'); assert.notProperty(result, 'userId');
    await rejected(service.getRun(userId, { missionId: otherMissionId, jobId: oldest }), 'execution-not-found');
    await rejected(service.getRun(userId, { missionId: childId, jobId: oldest }), 'execution-mission-unavailable');
    await sessions.updateAsync(childId, { $set: { erasingAt: new Date() } });
    await rejected(service.getRun(userId, { missionId, jobId: oldest }), 'execution-not-found');
    const erased = await job({ erasedAt: now });
    await rejected(service.getRun(userId, { missionId, jobId: erased }), 'execution-not-found');
  });
  it('lists durable uploads and exports from authorized descendants without a Sprite connection', async () => {
    const grandchild = await session({ parent: { sessionId: childId }, agent: 'critic' });
    const inbound = await file({ origin: 'inbound' });
    const exported = await file({ sessionId: grandchild });
    const runId = await job({ sessionId: grandchild, agent: 'critic', artifacts: [{ id: exported, name: 'report.txt', contentType: 'text/plain', size: 5 }] });
    await file({ sessionId: otherMissionId }); await file({ staged: true }); await file({ erasedAt: now });
    const foreign = await session({ userId: otherUser, parent: { sessionId: missionId } }); await file({ sessionId: foreign });
    const orphan = await file({ sessionId: Random.id() });
    const result = await service.missionFiles(userId, { missionId });
    assert.sameMembers(result.rows.map((row) => row.id), [inbound, exported]);
    assert.notInclude(JSON.stringify(result), 'aGVsbG8=');
    const output = result.rows.find((row) => row.id === exported);
    assert.equal(output.runId, runId); assert.equal(output.agent, 'critic'); assert.equal(output.runTitle, 'Run report');
    assert.notInclude(result.rows.map((row) => row.id), orphan);
    assert.deepEqual(await service.readMissionFile(userId, { missionId, attachmentId: exported }), { name: 'report.txt', contentType: 'text/plain', size: 5, content: 'aGVsbG8=', storage: 'database', needsMigration: true });
  });
  it('pages equal-date files without duplicates and rejects a run cursor in the file list', async () => {
    for (const suffix of ['a', 'b', 'c']) await file({ _id: `${userId}-${suffix}` });
    const first = await service.missionFiles(userId, { missionId, limit: 2 });
    const second = await service.missionFiles(userId, { missionId, limit: 2, cursor: first.nextCursor });
    assert.deepEqual([...first.rows, ...second.rows].map((row) => row.id), ['c', 'b', 'a'].map((suffix) => `${userId}-${suffix}`));
    await job(); await job(); const runPage = await service.historyPage(userId, { missionId, limit: 1 });
    await rejected(service.missionFiles(userId, { missionId, cursor: runPage.nextCursor }), 'execution-invalid-cursor');
    await rejected(service.missionFiles(userId, { missionId: otherMissionId, cursor: first.nextCursor }), 'execution-invalid-cursor');
  });
  it('rejects unauthorized, removed, ephemeral and erased file scopes including intermediate ancestors', async () => {
    const grandchild = await session({ parent: { sessionId: childId } });
    const id = await file({ sessionId: grandchild });
    await rejected(service.readMissionFile(otherUser, { missionId, attachmentId: id }), 'not-authorized');
    await rejected(service.readMissionFile(userId, { missionId: otherMissionId, attachmentId: id }), 'execution-artifact-unavailable');
    await sessions.updateAsync(childId, { $set: { erasingAt: now } });
    assert.isEmpty((await service.missionFiles(userId, { missionId })).rows);
    await rejected(service.readMissionFile(userId, { missionId, attachmentId: id }), 'execution-artifact-unavailable');
    await sessions.updateAsync(childId, { $unset: { erasingAt: 1 }, $set: { ephemeral: true } });
    await rejected(service.readMissionFile(userId, { missionId, attachmentId: id }), 'execution-artifact-unavailable');
    await sessions.removeAsync(childId);
    await rejected(service.readMissionFile(userId, { missionId, attachmentId: id }), 'execution-artifact-unavailable');
    await sessions.updateAsync(missionId, { $set: { erasingAt: now } });
    await rejected(service.missionFiles(userId, { missionId }), 'execution-mission-unavailable');
  });
  it('bounds file reads before hydrating and rejects malformed payloads or staged attachments', async () => {
    const large = await file({ size: 10_000_001 });
    await rejected(service.readMissionFile(userId, { missionId, attachmentId: large }), 'execution-artifact-limit');
    for (const patch of [{ size: 4 }, { content: 'bad!' }, { content: 'aGVsbG8=' + ' ' }]) {
      const id = await file(patch); await rejected(service.readMissionFile(userId, { missionId, attachmentId: id }), 'execution-artifact-unavailable');
    }
    for (const patch of [{ staged: true }, { erasedAt: now }]) {
      const id = await file(patch); await rejected(service.readMissionFile(userId, { missionId, attachmentId: id }), 'execution-artifact-unavailable');
    }
  });
  it('does not leak global history for another owner, missing sources, or broken ancestry', async () => {
    const visible = await job();
    await job({ userId: otherUser }); await job({ sessionId: Random.id() });
    await job({ missionId: otherMissionId, sessionId: childId });
    const removed = await session({ parent: { sessionId: missionId }, erasingAt: now }); await job({ sessionId: removed });
    const foreign = await session({ userId: otherUser, parent: { sessionId: missionId } }); await job({ sessionId: foreign });
    await job({ erasedAt: now });
    assert.deepEqual((await service.historyPage(userId)).rows.map((row) => row._id), [visible]);
  });
  it('keeps list errors brief and excludes traces or additional provider payloads', async () => {
    await job({ error: { code: 'execution-failed', reason: 'Check connection.\n'.repeat(30), stack: 'private stack', providerPayload: { stdout: 'private payload' } }, cleanupError: 'Retry.\n'.repeat(100) });
    const result = await service.historyPage(userId, { missionId });
    assert.equal(result.rows[0].error.reason.length, 240); assert.notInclude(result.rows[0].error.reason, '\n');
    assert.equal(result.rows[0].cleanupError.length, 240); assert.notInclude(JSON.stringify(result), 'private');
  });
  it('refuses unsupported-depth file trees rather than silently presenting an incomplete list', async () => {
    let parent = missionId;
    for (let depth = 0; depth < 9; depth += 1) parent = await session({ parent: { sessionId: parent } });
    await file({ sessionId: parent });
    await rejected(service.missionFiles(userId, { missionId }), 'execution-mission-too-deep');
  });
});
