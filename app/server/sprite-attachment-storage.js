import { createHash } from 'node:crypto';
import { Meteor } from 'meteor/meteor';
import { attachmentStoragePath } from './sprite-attachment-path';
import { conversationHop } from '../imports/constellation/topics';

const MAX_BYTES = 10_000_000;
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
const available = (session) => !!session && validId(session._id) && validId(session.userId)
  && !session.erasingAt && !session.erasedAt && !session.ephemeral;
const unavailable = () => { throw new Meteor.Error('attachment-storage-unavailable', 'This attachment is not available in this mission.'); };
const invalid = () => { throw new Meteor.Error('attachment-storage-invalid', 'This attachment has an invalid file reference or content.'); };
const digest = (content) => createHash('sha256').update(content).digest('hex');
const bytesFor = (content, size) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || typeof content !== 'string'
    || content.length > Math.ceil(MAX_BYTES / 3) * 4
    || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) invalid();
  const bytes = Buffer.from(content, 'base64');
  if (bytes.length !== size || bytes.toString('base64') !== content) invalid();
  return bytes;
};
const expectedPath = (input, sha256) => {
  try { return attachmentStoragePath({ attachmentId: input.id, name: input.name, sha256 }); }
  catch { invalid(); }
};

/** Maps framework attachments to immutable mission-file snapshots. This adapter
 * does not allocate environments, grant access, or delete remote user files. */
export function createSpriteAttachmentStorage(host) {
  const environments = host.environments;
  const getSession = host.getSession ? (id) => host.getSession(id) : (id) => host.AgentSessions.findOneAsync(id);
  const scopeFor = async (input, expected) => {
    if (!validId(input.sessionId)) unavailable();
    const root = await host.rootMissionSession(input.sessionId);
    if (!available(root) || root.parent?.sessionId || (input.userId !== undefined && input.userId !== root.userId)
      || (input.missionId !== undefined && input.missionId !== root._id)) unavailable();
    await host.requireUser(root.userId);
    const lineage = []; const seen = new Set(); let id = input.sessionId;
    for (let depth = 0; depth <= 8; depth += 1) {
      if (!validId(id) || seen.has(id)) unavailable();
      seen.add(id);
      const session = await getSession(id);
      if (!available(session) || session._id !== id || session.userId !== root.userId) unavailable();
      lineage.push(id);
      if (!session.parent?.sessionId) {
        if (id === root._id) break;
        // A thread belongs to its topic and a topic to its Mission; both share the Mission's files.
        const next = conversationHop(session);
        if (!next) unavailable();
        id = next;
        if (depth === 8) unavailable();
        continue;
      }
      id = session.parent.sessionId;
      if (depth === 8) unavailable();
    }
    const currentRoot = await host.rootMissionSession(input.sessionId);
    if (!available(currentRoot) || currentRoot._id !== root._id || currentRoot.userId !== root.userId || currentRoot.parent?.sessionId) unavailable();
    const scope = { userId: root.userId, missionId: root._id, lineage: lineage.join('\u0000') };
    if (expected && (scope.userId !== expected.userId || scope.missionId !== expected.missionId || scope.lineage !== expected.lineage)) unavailable();
    return scope;
  };
  const operation = async (input, context, work) => {
    let scope;
    const assertActive = async () => {
      if (context.signal?.aborted) throw new Meteor.Error('attachment-storage-cancelled', 'The attachment operation was cancelled.');
      await context.assertActive?.();
      const current = await scopeFor(input, scope);
      scope ??= current;
      if (context.signal?.aborted) throw new Meteor.Error('attachment-storage-cancelled', 'The attachment operation was cancelled.');
    };
    await assertActive();
    const result = await work(scope, { assertActive, ...(context.signal ? { signal: context.signal } : {}) });
    await assertActive();
    return result;
  };
  const referenceFor = (reference, input, scope, sha256) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || typeof reference.workspaceId !== 'string' || !/^constellation-[a-z0-9-]{8,64}$/.test(reference.workspaceId)
      || reference.path !== expectedPath(input, sha256) || reference.sha256 !== sha256
      || (reference.missionId !== undefined && reference.missionId !== scope.missionId)) invalid();
    return { workspaceId: reference.workspaceId, path: reference.path, missionId: scope.missionId, sha256 };
  };
  return {
    name: 'sprites',
    async write(input, context = {}) {
      if (!input || typeof input !== 'object') invalid();
      const bytes = bytesFor(input.content, input.size); const sha256 = digest(bytes);
      if (input.sha256 !== undefined && input.sha256 !== sha256) invalid();
      if (input.contentSha256 !== undefined && input.contentSha256 !== sha256) invalid();
      expectedPath(input, sha256);
      return operation(input, context, async (scope, guards) => {
        const reference = await environments.writeAttachmentFile(scope.userId, {
          missionId: scope.missionId, attachmentId: input.id, sessionId: input.sessionId,
          name: input.name, contentType: input.contentType, content: input.content, size: input.size, sha256,
        }, guards);
        return referenceFor(reference, input, scope, sha256);
      });
    },
    async read(input, context = {}) {
      if (!input || typeof input !== 'object' || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_BYTES) invalid();
      const reference = input.storageReference;
      if (!reference || typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256)
        || !validId(reference.missionId) || (input.sha256 !== undefined && input.sha256 !== reference.sha256)
        || (input.contentSha256 !== undefined && input.contentSha256 !== reference.sha256)) invalid();
      expectedPath(input, reference.sha256);
      return operation(input, context, async (scope, guards) => {
        if (reference.missionId !== scope.missionId) unavailable();
        const safeReference = referenceFor(reference, input, scope, reference.sha256);
        const content = await environments.readAttachmentFile(scope.userId, {
          missionId: scope.missionId, attachmentId: input.id, sessionId: input.sessionId,
          name: input.name, contentType: input.contentType, size: input.size, storageReference: safeReference,
        }, guards);
        if (digest(bytesFor(content, input.size)) !== reference.sha256) invalid();
        return content;
      });
    },
    withLease(lease, callback) { return environments.withAttachmentLease(lease, callback); },
    // Framework row retirement is metadata-only. Environment deletion remains
    // the explicit owner-controlled remote-file lifecycle; never delete here.
    async retire() {},
  };
}
