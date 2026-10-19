import { Mongo } from 'meteor/mongo';
import { createHash } from 'node:crypto';
import { AgentSessions } from 'meteor/10thfloor:agent';
import { executionText } from '../imports/constellation/execution';

// Read-only compatibility for files created by the retired Mongo file manager.
// Keep these collection names and their data: existing edits are not necessarily
// present in the original chat attachments. New files belong in the Sprite.
export const MissionFileCatalogs = new Mongo.Collection('constellation_mission_file_catalogs', { _preventAutopublish: true });
export const MissionFileContents = new Mongo.Collection('constellation_mission_file_contents', { _preventAutopublish: true });
export const MissionFileVersions = new Mongo.Collection('constellation_mission_file_versions', { _preventAutopublish: true });
for (const collection of [MissionFileCatalogs, MissionFileContents, MissionFileVersions]) collection.deny({ insert: () => true, update: () => true, remove: () => true });

const MAX_BYTES = 10_000_000;
const MAX_ENTRIES = 2000;
const LEGACY_FIELDS = { 'entries.id': 1, 'entries.kind': 1, 'entries.parentId': 1, 'entries.name': 1,
  'entries.contentType': 1, 'entries.size': 1, 'entries.contentId': 1, 'entries.sourceSessionId': 1,
  'entries.originSessionIds': 1, 'entries.trashedAt': 1, 'entries.createdAt': 1, 'entries.updatedAt': 1,
  'entries.agent': 1, 'entries.runId': 1, 'entries.runTitle': 1 };
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160;
const validDate = (value) => value instanceof Date && Number.isFinite(value.getTime());

export function createLegacyMissionFileReader(host, { exactMission, inMission, fail, attachmentStorage }) {
  const catalogs = host.MissionFileCatalogs ?? MissionFileCatalogs;
  const contents = host.MissionFileContents ?? MissionFileContents;
  const versions = host.MissionFileVersions ?? MissionFileVersions;
  const unavailable = () => fail('execution-artifact-unavailable', 'This preserved file is not available in this mission.');
  const treeFor = async (userId, missionId) => {
    const tree = await catalogs.findOneAsync({ userId, missionId }, { fields: LEGACY_FIELDS });
    if (!tree) return [];
    if (!Array.isArray(tree.entries) || tree.entries.length > MAX_ENTRIES) fail('execution-artifact-limit', 'This older file archive is too large to browse safely.');
    return tree.entries;
  };
  const lineageFor = (entry, entries) => {
    const lineage = [entry]; const visited = new Set([entry.id]);
    for (let current = entry.parentId; current !== null && current !== undefined;) {
      if (!validId(current) || visited.has(current) || lineage.length > 32) return null;
      visited.add(current); const parent = entries.find((row) => row.id === current);
      if (!parent || parent.kind !== 'folder') return null;
      lineage.unshift(parent); current = parent.parentId;
    }
    return lineage;
  };
  const allowed = async (userId, missionId, entry, entries) => {
    if (entry.kind !== 'file' || !validId(entry.id) || !validId(entry.contentId)) return false;
    const lineage = lineageFor(entry, entries);
    if (!lineage || lineage.some((row) => row.trashedAt || typeof row.name !== 'string')) return false;
    for (const row of lineage) {
      if (row.originSessionIds !== undefined && !Array.isArray(row.originSessionIds)) return false;
      const sources = new Set([row.sourceSessionId, ...(row.originSessionIds ?? [])].filter(Boolean));
      for (const sourceId of sources) if (!validId(sourceId) || !await inMission(userId, sourceId, missionId)) return false;
    }
    return true;
  };
  const metadata = (entry, entries) => ({
    _id: `legacy:${entry.id}`, id: `legacy:${entry.id}`, legacyEntryId: entry.id,
    legacy: true, readOnly: true, editable: false, kind: 'file', type: 'file', origin: 'legacy',
    name: entry.name, contentType: entry.contentType ?? 'application/octet-stream', size: entry.size,
    legacyPath: `/${lineageFor(entry, entries).map((row) => row.name).join('/')}`,
    createdAt: validDate(entry.updatedAt) ? entry.updatedAt : validDate(entry.createdAt) ? entry.createdAt : new Date(0),
    updatedAt: validDate(entry.updatedAt) ? entry.updatedAt : entry.createdAt,
    ...(entry.agent ? { agent: entry.agent } : {}),
    ...(entry.runId ? { runId: entry.runId, runTitle: entry.runTitle } : {}),
  });
  const storedMetadata = (file) => file?.storageProvider === 'sprites' && file.storageReference
    ? { storage: 'sprite', path: file.storageReference.path, needsMigration: false }
    : { storage: 'database', needsMigration: true };
  const validatedContent = (file, content) => {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES || typeof content !== 'string'
      || content.length > Math.ceil(MAX_BYTES / 3) * 4 || content.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) unavailable();
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length !== file.size || bytes.toString('base64') !== content
      || (file.contentSha256 && createHash('sha256').update(bytes).digest('hex') !== file.contentSha256)) unavailable();
    return bytes;
  };
  const migrationQuery = (userId, missionId) => ({ userId, missionId, content: { $type: 'string' } });
  return {
    async legacyFileRows(userId, missionId) {
      await exactMission(userId, missionId);
      const entries = await treeFor(userId, missionId); const rows = [];
      for (const entry of entries) if (await allowed(userId, missionId, entry, entries)) {
        const file = await contents.findOneAsync({ _id: entry.contentId, userId, missionId }, { fields: { storageProvider: 1, storageReference: 1 } });
        rows.push({ ...metadata(entry, entries), ...storedMetadata(file) });
      }
      await exactMission(userId, missionId); return rows;
    },
    async readLegacyMissionFile(userId, input) {
      await exactMission(userId, input.missionId);
      const entryId = executionText(input.legacyEntryId, 'Preserved file', 160);
      const entries = await treeFor(userId, input.missionId); const entry = entries.find((row) => row.id === entryId);
      if (!entry || !await allowed(userId, input.missionId, entry, entries)) unavailable();
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BYTES) fail('execution-artifact-limit', 'This file exceeds the 10 MB reading limit.');
      const file = await contents.findOneAsync({ _id: entry.contentId, userId, missionId: input.missionId });
      if (!file || file.size !== entry.size) unavailable();
      let content = file.content;
      if (file.storageProvider) {
        if (!attachmentStorage || file.storageProvider !== attachmentStorage.name) unavailable();
        content = await attachmentStorage.read({ id: file._id, sessionId: input.missionId, name: file.name ?? entry.name,
          contentType: file.contentType ?? entry.contentType ?? 'application/octet-stream', size: file.size,
          storageReference: file.storageReference }, { assertActive: () => exactMission(userId, input.missionId) });
      }
      validatedContent(file, content);
      if (!await allowed(userId, input.missionId, entry, entries)) unavailable();
      await exactMission(userId, input.missionId);
      return { ...metadata(entry, entries), ...storedMetadata(file), content };
    },
    async migrationCount(userId, missionId) {
      return contents.find(migrationQuery(userId, missionId), { fields: { _id: 1 } }).countAsync();
    },
    async migrateLegacyContents(userId, missionId, limit) {
      await exactMission(userId, missionId);
      if (!attachmentStorage) fail('execution-filesystem-required', 'Enable the mission filesystem before moving existing files.');
      // Include old revisions and Trash, not only the currently visible files.
      // Their existing metadata remains intact; only the byte location changes.
      const files = await contents.find(migrationQuery(userId, missionId), { sort: { _id: 1 }, limit }).fetchAsync();
      const entries = await treeFor(userId, missionId); let migrated = 0; const failures = [];
      for (const file of files) {
        const entry = entries.find((row) => row.contentId === file._id)
          ?? (await versions.findOneAsync({ userId, missionId, 'snapshot.contentId': file._id }))?.snapshot;
        const name = entry?.name ?? file.name ?? `Archived file ${file._id}`;
        try {
          const bytes = validatedContent(file, file.content);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const info = { id: file._id, sessionId: missionId, name,
            contentType: entry?.contentType ?? file.contentType ?? 'application/octet-stream', size: file.size };
          const guard = { assertActive: () => exactMission(userId, missionId) };
          await guard.assertActive();
          const storageReference = await attachmentStorage.write({ ...info, content: file.content, sha256 }, guard);
          const verified = await attachmentStorage.read({ ...info, storageReference }, guard);
          if (verified !== file.content) fail('execution-file-verification', 'The Sprite copy did not match. The original file was kept.');
          await guard.assertActive();
          // No upsert: erasure or a concurrent migration must never resurrect data.
          migrated += await contents.updateAsync({ _id: file._id, userId, missionId, content: file.content }, {
            $set: { storageProvider: attachmentStorage.name, storageReference, contentSha256: sha256,
              name: info.name, contentType: info.contentType, migratedAt: new Date() }, $unset: { content: '' },
          }) ? 1 : 0;
        } catch {
          failures.push({ name, reason: 'This file could not be verified on the Sprite. Its original contents were kept.' });
          break;
        }
      }
      return { migrated, failures };
    },
    async scrubFileSession(sessionId) { return scrubMissionFileSession(sessionId, { catalogs, contents, versions }); },
    async sweepOrphanFiles() { return sweepOrphanMissionFiles(host.AgentSessions ?? AgentSessions, { catalogs, contents, versions }); },
  };
}

// These are privacy-erasure hooks, not file-management operations. Normal reads
// never create, import, migrate, change or remove a catalog, content or revision.
export async function scrubMissionFileSession(sessionId, collections = {}) {
  if (!validId(sessionId)) return;
  const catalogs = collections.catalogs ?? MissionFileCatalogs;
  const contents = collections.contents ?? MissionFileContents;
  const versions = collections.versions ?? MissionFileVersions;
  // The explicit root-erasure lifecycle must also remove orphaned content if an
  // earlier deletion already removed its catalog before the process exited.
  for (const collection of [catalogs, contents, versions]) await collection.removeAsync({ missionId: sessionId });
  const affected = await catalogs.find({ $or: [{ 'entries.sourceSessionId': sessionId }, { 'entries.originSessionIds': sessionId }] },
    { fields: { userId: 1, missionId: 1 } }).fetchAsync();
  for (const scope of affected) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const tree = await catalogs.findOneAsync(scope._id); if (!tree) break;
      const removed = tree.entries.filter((entry) => entry.sourceSessionId === sessionId || entry.originSessionIds?.includes(sessionId));
      if (!removed.length) break;
      const ids = new Set(removed.map((entry) => entry.id)); const entries = tree.entries.filter((entry) => !ids.has(entry.id));
      if (!await catalogs.updateAsync({ _id: tree._id, revision: tree.revision }, { $set: { entries, updatedAt: new Date() }, $inc: { revision: 1 } })) continue;
      const removedVersions = await versions.find({ userId: scope.userId, missionId: scope.missionId, entryId: { $in: [...ids] } }, { fields: { 'snapshot.contentId': 1 } }).fetchAsync();
      await versions.removeAsync({ userId: scope.userId, missionId: scope.missionId, entryId: { $in: [...ids] } });
      const candidates = [...new Set([...removed.map((entry) => entry.contentId), ...removedVersions.map((version) => version.snapshot?.contentId)].filter(Boolean))];
      const remainingContentIds = new Set(entries.map((entry) => entry.contentId));
      for (const contentId of candidates) if (!remainingContentIds.has(contentId)
        && !await versions.findOneAsync({ userId: scope.userId, missionId: scope.missionId, 'snapshot.contentId': contentId }, { fields: { _id: 1 } })) {
        await contents.removeAsync({ _id: contentId, userId: scope.userId, missionId: scope.missionId });
      }
      break;
    }
  }
}

/** Finish only interrupted privacy erasures on startup; do not migrate, compact
 * or discard retained legacy files, revisions or Trash for a live mission.
 */
export async function sweepOrphanMissionFiles(sessions = AgentSessions, collections = {}) {
  const catalogs = collections.catalogs ?? MissionFileCatalogs;
  const contents = collections.contents ?? MissionFileContents;
  const versions = collections.versions ?? MissionFileVersions;
  const scopes = await catalogs.find({}, { fields: { userId: 1, missionId: 1, 'entries.sourceSessionId': 1, 'entries.originSessionIds': 1 } }).fetchAsync();
  for (const scope of scopes) {
    const root = await sessions.findOneAsync({ _id: scope.missionId, userId: scope.userId }, { fields: { erasingAt: 1, erasedAt: 1, ephemeral: 1, parent: 1 } });
    if (!root || root.erasingAt || root.erasedAt || root.ephemeral || root.parent?.sessionId) {
      for (const collection of [catalogs, contents, versions]) await collection.removeAsync({ userId: scope.userId, missionId: scope.missionId });
      continue;
    }
    const sources = new Set(scope.entries.flatMap((entry) => [entry.sourceSessionId, ...(entry.originSessionIds ?? [])]).filter(Boolean));
    for (const sourceId of sources) {
      const source = await sessions.findOneAsync({ _id: sourceId, userId: scope.userId }, { fields: { erasingAt: 1, erasedAt: 1, ephemeral: 1 } });
      if (!source || source.erasingAt || source.erasedAt || source.ephemeral) await scrubMissionFileSession(sourceId, { catalogs, contents, versions });
    }
  }
  for (const collection of [contents, versions]) {
    const orphanScopes = await collection.rawCollection().aggregate([{ $group: { _id: { userId: '$userId', missionId: '$missionId' } } }]).toArray();
    for (const { _id: scope } of orphanScopes) if (!await catalogs.findOneAsync(scope, { fields: { _id: 1 } })) {
      const root = await sessions.findOneAsync({ _id: scope.missionId, userId: scope.userId }, { fields: { erasingAt: 1, erasedAt: 1 } });
      if (!root || root.erasingAt || root.erasedAt) await collection.removeAsync(scope);
    }
  }
}
