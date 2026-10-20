import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Agent, AgentSessions, AgentAttachments } from 'meteor/10thfloor:agent';
import { executionObject, executionText } from '../imports/constellation/execution';
import { createLegacyMissionFileReader } from './mission-file-store';
import { missionConversationIds } from './mission-topics';
import { conversationHop, isMissionRoot } from '../imports/constellation/topics';

const cursorKey = randomBytes(32);
const MAX_MISSION_SESSIONS = 2048;
const MAX_FILE_BYTES = 10_000_000;
const FILE_FIELDS = { _id: 1, sessionId: 1, name: 1, contentType: 1, size: 1, origin: 1, createdAt: 1, storageProvider: 1, storageReference: 1 };
const STATES = ['queued', 'preparing', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'unknown'];
const RUN_FIELDS = { _id: 1, missionId: 1, sessionId: 1, agent: 1, title: 1, language: 1, status: 1,
  createdAt: 1, startedAt: 1, completedAt: 1, updatedAt: 1, artifacts: 1, outputBytes: 1,
  truncated: 1, exitCode: 1, persistent: 1, cleanupPending: 1, cleanupError: 1, 'error.code': 1, 'error.reason': 1 };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signature = (value) => createHmac('sha256', cursorKey).update(value).digest();
const pageCursor = (row, scope) => {
  const payload = Buffer.from(JSON.stringify({ v: 1, date: row.createdAt.toISOString(), id: row._id, scope })).toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
};
const liveSession = (row, userId) => row && row.userId === userId && !row.erasingAt && !row.erasedAt && !row.ephemeral;
const safeArtifact = ({ id, name, contentType, size }) => ({ id, name, contentType, size });
const shortReason = (value) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 240) : undefined;

/** Durable mission work metadata is independent of the remote provider.
 * Paging uses signed keyset cursors; neither arbitrary selectors nor skip offsets
 * cross the method boundary. Bytes are fetched only for an exact authorized file.
 */
export function createMissionWorkService(host, { owner, rootMission, jobs, publicJob, fail, attachmentStorage }) {
  const sessions = host.AgentSessions ?? AgentSessions;
  const attachments = host.AgentAttachments ?? AgentAttachments;
  const artifactsApi = host.Agent?.attachments ?? Agent.attachments;
  let indexes;
  const ensureIndexes = () => (indexes ??= Promise.all([
    jobs.rawCollection().createIndex({ userId: 1, missionId: 1, createdAt: -1, _id: -1 }),
    jobs.rawCollection().createIndex({ userId: 1, missionId: 1, 'artifacts.id': 1 }),
    sessions.rawCollection().createIndex({ userId: 1, 'parent.sessionId': 1 }),
    attachments.rawCollection().createIndex({ sessionId: 1, createdAt: -1, _id: -1 }),
  ]));
  const start = async (userId, input) => { await owner(userId); executionObject(input); await ensureIndexes(); };
  const limitOf = (input) => {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid-execution', 'Choose between 1 and 100 items per page.');
    return limit;
  };
  const after = (cursor, scope) => {
    if (cursor === undefined || cursor === null) return null;
    const invalid = () => fail('execution-invalid-cursor', 'This page has expired. Refresh the list.');
    if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(cursor)) return invalid();
    const [payload, encodedSignature] = cursor.split('.');
    const supplied = Buffer.from(encodedSignature, 'base64url'); const expected = signature(payload);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return invalid();
    let value; try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return invalid(); }
    const date = new Date(value.date);
    if (value.v !== 1 || value.scope !== scope || typeof value.id !== 'string' || !value.id || value.id.length > 200
      || typeof value.date !== 'string' || !Number.isFinite(date.getTime()) || date.toISOString() !== value.date) return invalid();
    return { $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: value.id } }] };
  };
  const exactMission = async (userId, missionId) => {
    executionText(missionId, 'Mission', 160);
    const root = await rootMission(userId, missionId);
    if (root._id !== missionId) fail('execution-mission-unavailable', 'Choose the root mission.');
    const current = await sessions.findOneAsync(missionId, { fields: { userId: 1, parent: 1, erasingAt: 1, erasedAt: 1, ephemeral: 1, title: 1, agent: 1 } });
    if (!liveSession(current, userId) || current.parent?.sessionId) fail('execution-mission-unavailable', 'This mission is no longer available.');
    return current;
  };
  const sessionLoader = () => {
    const cache = new Map();
    return (id) => {
      if (!cache.has(id)) cache.set(id, sessions.findOneAsync(id, { fields: { userId: 1, parent: 1, erasingAt: 1, erasedAt: 1, ephemeral: 1, title: 1, agent: 1, missionTopic: 1, thread: 1 } }));
      return cache.get(id);
    };
  };
  const inMission = async (userId, sessionId, missionId, load = sessionLoader()) => {
    const visited = new Set();
    for (let depth = 0; sessionId && depth <= 12; depth += 1) {
      if (visited.has(sessionId)) return false; visited.add(sessionId);
      const session = await load(sessionId);
      if (!liveSession(session, userId)) return false;
      if (sessionId === missionId) return isMissionRoot(session);
      // Past the top of a conversation: a thread belongs to its topic, a topic to its Mission.
      sessionId = session.parent?.sessionId ?? conversationHop(session);
    }
    return false;
  };
  const missionSessions = async (userId, missionId) => {
    const root = await exactMission(userId, missionId); const rows = new Map([[root._id, root]]);
    // Every topic and thread is a conversation of the Mission, and so is the work under it.
    let frontier = await missionConversationIds(sessions, userId, root._id);
    for (const id of frontier) if (!rows.has(id)) rows.set(id, { _id: id, agent: 'orchestrator' });
    for (let depth = 0; frontier.length && depth < 8; depth += 1) {
      const children = await sessions.find({ userId, 'parent.sessionId': { $in: frontier }, erasingAt: { $exists: false }, erasedAt: { $exists: false }, ephemeral: { $ne: true } },
        { fields: { _id: 1, agent: 1 }, limit: MAX_MISSION_SESSIONS - rows.size + 1 }).fetchAsync();
      if (children.length + rows.size > MAX_MISSION_SESSIONS) fail('execution-mission-too-large', 'This mission has too many conversations to list its files safely.');
      frontier = children.filter((row) => !rows.has(row._id)).map((row) => row._id);
      for (const child of children) rows.set(child._id, child);
    }
    // The framework admits only three delegation levels today. Keep support
    // for older/imported trees, but never label a silently truncated tree complete.
    if (frontier.length && await sessions.findOneAsync({ userId, 'parent.sessionId': { $in: frontier }, erasingAt: { $exists: false }, erasedAt: { $exists: false }, ephemeral: { $ne: true } }, { fields: { _id: 1 } })) {
      fail('execution-mission-too-deep', 'This mission has an unsupported conversation depth. Its complete file list cannot be shown.');
    }
    return rows;
  };
  const page = async (collection, query, fields, input, scope) => {
    const limit = limitOf(input); const position = after(input.cursor, scope);
    const found = await collection.find(position ? { $and: [query, position] } : query,
      { fields, sort: { createdAt: -1, _id: -1 }, limit: limit + 1 }).fetchAsync();
    const rows = found.slice(0, limit);
    return { rows, nextCursor: found.length > limit ? pageCursor(rows.at(-1), scope) : null };
  };
  const legacy = createLegacyMissionFileReader(host, { exactMission, inMission, fail, attachmentStorage });
  const migrationQuery = (scope) => ({ sessionId: { $in: [...scope.keys()] }, content: { $type: 'string' } });
  const migrationCount = async (userId, missionId, scope) =>
    await attachments.find(migrationQuery(scope), { fields: { _id: 1 } }).countAsync() + await legacy.migrationCount(userId, missionId);
  const storageMetadata = (row) => row.storageProvider
    ? { storage: 'sprite', path: row.storageReference?.path, needsMigration: false }
    : { storage: 'database', needsMigration: true };
  return {
    async historyPage(userId, input = {}) {
      await start(userId, input);
      const missionId = input.missionId === undefined ? null : executionText(input.missionId, 'Mission', 160);
      if (missionId) await exactMission(userId, missionId);
      const search = input.search === undefined || input.search === '' ? '' : executionText(input.search, 'Search', 120);
      const agent = input.agent === undefined || input.agent === '' ? '' : executionText(input.agent, 'Agent', 120);
      const status = input.status === undefined || input.status === '' ? '' : executionText(input.status, 'Status', 30);
      if (status && !STATES.includes(status)) fail('invalid-execution', 'Choose a valid run status.');
      const query = { userId, erasedAt: { $exists: false }, createdAt: { $type: 'date' },
        ...(missionId ? { missionId } : {}), ...(agent ? { agent } : {}), ...(status ? { status } : {}),
        ...(search ? { title: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {}) };
      const result = await page(jobs, query, RUN_FIELDS, input, hash(['runs', userId, missionId, search, agent, status]));
      const load = sessionLoader(); const rows = []; const missions = new Map();
      for (const row of result.rows) {
        if (!await inMission(userId, row.sessionId, row.missionId, load)) continue;
        const root = await load(row.missionId);
        if (!missions.has(row.missionId)) missions.set(row.missionId, host.MissionConfigs ? await host.MissionConfigs.findOneAsync({ _id: row.missionId, userId }, { fields: { title: 1 } }) : null);
        const mission = missions.get(row.missionId);
        const { error, cleanupError, ...metadata } = row;
        rows.push({ ...metadata, artifacts: (row.artifacts ?? []).map(safeArtifact), missionTitle: mission?.title ?? root?.title ?? 'Untitled mission',
          ...(error?.reason ? { error: { code: shortReason(error.code), reason: shortReason(error.reason) } } : {}),
          ...(cleanupError ? { cleanupError: shortReason(cleanupError) } : {}) });
      }
      return { ...result, rows };
    },
    async getRun(userId, input) {
      await start(userId, input); await exactMission(userId, input.missionId);
      const job = await jobs.findOneAsync({ _id: executionText(input.jobId, 'Run', 160), userId, missionId: input.missionId, erasedAt: { $exists: false } });
      if (!job || !await inMission(userId, job.sessionId, input.missionId)) fail('execution-not-found', 'This run is not available in this mission.');
      return publicJob(job);
    },
    async missionFiles(userId, input) {
      await start(userId, input); const scope = await missionSessions(userId, input.missionId);
      const search = input.search === undefined || input.search === '' ? '' : executionText(input.search, 'Search', 120);
      const pattern = search ? search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
      const pagingScope = hash(['attachments', userId, input.missionId, search]); const position = after(input.cursor, pagingScope); const limit = limitOf(input);
      const query = { sessionId: { $in: [...scope.keys()] }, staged: { $ne: true }, erasedAt: { $exists: false }, createdAt: { $type: 'date' },
        ...(search ? { name: { $regex: pattern, $options: 'i' } } : {}) };
      const originals = await attachments.find(position ? { $and: [query, position] } : query,
        { fields: FILE_FIELDS, sort: { createdAt: -1, _id: -1 }, limit: limit + 1 }).fetchAsync();
      const archived = (await legacy.legacyFileRows(userId, input.missionId)).filter((row) => {
        if (search && !new RegExp(pattern, 'i').test(row.name)) return false;
        if (!position) return true;
        const date = position.$or[0].createdAt.$lt; const id = position.$or[1]._id.$lt;
        return row.createdAt < date || (row.createdAt.getTime() === date.getTime() && row._id < id);
      });
      // Merge the preserved current copies into the immutable attachment list.
      // Their distinct IDs prevent an edited copy from masking original evidence.
      const candidates = [...originals, ...archived].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
      const selected = candidates.slice(0, limit); const ids = selected.filter((row) => !row.legacy).map((row) => row._id); const origins = new Map();
      if (ids.length) {
        const runs = await jobs.find({ userId, missionId: input.missionId, erasedAt: { $exists: false }, 'artifacts.id': { $in: ids } },
          { fields: { _id: 1, sessionId: 1, agent: 1, title: 1, artifacts: 1 }, sort: { createdAt: -1, _id: -1 }, limit: 800 }).fetchAsync();
        for (const run of runs) if (scope.has(run.sessionId)) for (const artifact of run.artifacts ?? []) if (!origins.has(artifact.id)) origins.set(artifact.id, run);
      }
      const load = sessionLoader(); const rows = [];
      for (const row of selected) {
        if (row.legacy) { rows.push(row); continue; }
        if (!await inMission(userId, row.sessionId, input.missionId, load)) continue;
        const candidate = origins.get(row._id); const run = candidate?.sessionId === row.sessionId ? candidate : null;
        const { storageProvider, storageReference, ...metadata } = row;
        rows.push({ ...metadata, ...storageMetadata(row), id: row._id, attachmentId: row._id, type: 'file', kind: 'file', readOnly: true, editable: false,
          agent: run?.agent ?? scope.get(row.sessionId)?.agent, ...(run ? { runId: run._id, runTitle: run.title } : {}) });
      }
      await exactMission(userId, input.missionId);
      return { rows, nextCursor: candidates.length > limit ? pageCursor(selected.at(-1), pagingScope) : null,
        migration: { remaining: await migrationCount(userId, input.missionId, scope) } };
    },
    async readMissionFile(userId, input) {
      await start(userId, input); await exactMission(userId, input.missionId);
      const legacyEntryId = input.legacyEntryId ?? (typeof input.entryId === 'string' && input.entryId.startsWith('legacy:') ? input.entryId.slice(7) : undefined);
      if (legacyEntryId !== undefined) return legacy.readLegacyMissionFile(userId, { missionId: input.missionId, legacyEntryId });
      const selector = { _id: executionText(input.attachmentId ?? input.entryId, 'Attachment', 160), staged: { $ne: true }, erasedAt: { $exists: false } };
      const metadata = await attachments.findOneAsync(selector, { fields: FILE_FIELDS });
      if (!metadata || !await inMission(userId, metadata.sessionId, input.missionId)) fail('execution-artifact-unavailable', 'This attachment is not available in this mission.');
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_FILE_BYTES) fail('execution-artifact-limit', 'This attachment exceeds the 10 MB reading limit.');
      const file = await attachments.findOneAsync({ ...selector, sessionId: metadata.sessionId, size: metadata.size });
      if (!file) fail('execution-artifact-unavailable', 'This file is no longer available.');
      const content = await artifactsApi.readContent(file);
      if (typeof content !== 'string' || content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
        || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || Buffer.byteLength(content, 'base64') !== file.size
        || !await inMission(userId, metadata.sessionId, input.missionId)) fail('execution-artifact-unavailable', 'This attachment is no longer available.');
      return { name: file.name, contentType: file.contentType, size: file.size, content, ...storageMetadata(file) };
    },
    async migrateMissionFiles(userId, input) {
      await start(userId, input);
      const scope = await missionSessions(userId, input.missionId);
      const limit = input.limit ?? 10;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) fail('invalid-execution', 'Move between 1 and 25 files at a time.');
      let migrated = 0; const failures = [];
      const rows = await attachments.find(migrationQuery(scope), { fields: FILE_FIELDS, sort: { _id: 1 }, limit }).fetchAsync();
      for (const row of rows) {
        try {
          await exactMission(userId, input.missionId);
          if (!await inMission(userId, row.sessionId, input.missionId)) continue;
          await artifactsApi.migrateContent({ id: row._id, sessionId: row.sessionId });
          const saved = await attachments.findOneAsync({ _id: row._id, sessionId: row.sessionId }, { fields: { storageProvider: 1, content: 1 } });
          if (!saved?.storageProvider || typeof saved.content === 'string') throw new Error('Migration not confirmed');
          migrated += 1;
        } catch {
          failures.push({ name: row.name, reason: 'This file could not be verified on the Sprite. Its original contents were kept.' });
          break;
        }
      }
      if (!failures.length && rows.length < limit) {
        const older = await legacy.migrateLegacyContents(userId, input.missionId, limit - rows.length);
        migrated += older.migrated; failures.push(...older.failures);
      }
      await exactMission(userId, input.missionId);
      const remaining = await migrationCount(userId, input.missionId, scope);
      return { migrated, remaining, failures, complete: remaining === 0 };
    },
    scrubFileSession: legacy.scrubFileSession,
    sweepOrphanFiles: legacy.sweepOrphanFiles,
  };
}
