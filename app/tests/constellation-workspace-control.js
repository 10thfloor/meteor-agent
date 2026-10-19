import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) describe('Native workspace file request validation', function () {
  let normalize;
  before(async () => { ({ normalizeWorkspaceMutation: normalize } = await import('../server/sprites-workspace-control')); });
  const rejected = (input, code) => { let error; try { normalize(input); } catch (caught) { error = caught; } assert.ok(error); assert.equal(error.code, code); };
  it('keeps only supported native filesystem actions with explicit deletion confirmation', () => {
    for (const action of ['trash', 'restore', 'listTrash', 'restoreVersion']) rejected({ action, path: '/workspace/file' }, 'invalid-action');
    rejected({ action: 'delete', path: '/workspace/file' }, 'file-confirm-required');
    assert.isTrue(normalize({ action: 'delete', path: '/workspace/file', confirm: true }).confirm);
  });
  it('rejects root mutations, traversal and app-managed directories', () => {
    for (const path of ['/workspace', '/etc/config', '/workspace/../outside', '/workspace//file', '/workspace/runs/run.py', '/workspace/inputs/data', '/workspace/.constellation-files/data', '/workspace/folder/.constellation-private']) {
      rejected({ action: 'createFolder', path }, 'invalid-path');
    }
    assert.equal(normalize({ action: 'list', path: '/workspace' }).path, '/workspace');
    assert.equal(normalize({ action: 'read', path: '/workspace/inputs/data' }).path, '/workspace/inputs/data');
  });
  it('normalizes bounded UTF8 and binary content without accepting ambiguous inputs', () => {
    assert.equal(normalize({ action: 'write', path: '/workspace/file', text: 'hello' }).base64, 'aGVsbG8=');
    const binary = normalize({ action: 'upload', path: '/workspace/file', content: 'YQ==' });
    assert.deepEqual(normalize(binary), binary);
    rejected({ action: 'upload', path: '/workspace/file', text: 'a', content: 'YQ==' }, 'invalid-content');
    rejected({ action: 'upload', path: '/workspace/file', content: 'a===' }, 'invalid-content');
    assert.throws(() => normalize({ action: 'write', path: '/workspace/file', text: 'large' }, { maxBytes: 3 }));
  });
  it('validates a full-size upload without a recursive base64 expression', () => {
    const content = Buffer.alloc(5_000_000, 65).toString('base64');
    assert.equal(normalize({ action: 'upload', path: '/workspace/large.txt', content }).base64, content);
  });
  it('copies managed snapshots out without granting mutation access to the source', () => {
    for (const path of ['/workspace/attachments/id/result.txt', '/workspace/runs/run/main.py', '/workspace/inputs/data.txt']) {
      assert.equal(normalize({ action: 'copy', path, destination: '/workspace/copy.txt' }).path, path);
      for (const action of ['rename', 'move', 'delete', 'write']) rejected({ action, path, destination: '/workspace/copy.txt', confirm: true, text: 'replacement' }, 'invalid-path');
      rejected({ action: 'copy', path: '/workspace/source.txt', destination: path }, 'invalid-path');
    }
  });
  it('requires valid content hashes for overwrite checks and exact destination paths', () => {
    assert.equal(normalize({ action: 'write', path: '/workspace/file', text: '', expectedHash: 'A'.repeat(64) }).expectedHash, 'a'.repeat(64));
    rejected({ action: 'write', path: '/workspace/file', text: '', expectedHash: 'invalid' }, 'file-changed');
    rejected({ action: 'copy', path: '/workspace/file', destination: '/workspace/inputs/file' }, 'invalid-path');
    assert.equal(normalize({ action: 'move', path: '/workspace/file', destination: '/workspace/new' }).destination, '/workspace/new');
  });
});
