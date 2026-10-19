import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) describe('Sprites working-file provider', function () {
  let createAdapter; let createHash;
  const token = 'working-file-test-token'; const workspaceId = 'constellation-mission-0123456789abcdef0123456789abcdef';
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  before(async () => {
    ({ createSpritesAdapter: createAdapter } = await import('../server/sprites-provider'));
    ({ createHash } = await import('node:crypto'));
  });
  const rejected = async (promise, code) => {
    let error; try { await promise; } catch (caught) { error = caught; }
    assert.ok(error, `Expected ${code}`); assert.equal(error.code, code); assert.ok(!error.message.includes(token)); return error;
  };
  function fixture({ beforeRequest = () => {} } = {}) {
    const nodes = new Map([['/workspace', { type: 'directory' }]]); const requests = []; const events = [];
    const put = (path, content = '') => nodes.set(path, { type: 'file', content: Buffer.from(content) });
    const mkdir = (path) => nodes.set(path, { type: 'directory' });
    const parent = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
    const row = (path, node) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), type: node.type, size: node.content?.length ?? 0, isDir: node.type === 'directory' });
    const adapter = createAdapter({
      webSocketFactory: () => { throw new Error('Working files must not open an exec session'); },
      fetchImpl: async (url, options) => {
        const parsed = new URL(url); const route = parsed.pathname.split('/fs/')[1]; const path = parsed.searchParams.get('path');
        const request = { route, path, query: parsed.searchParams, ...options }; requests.push(request); events.push(options.method === 'GET' ? 'read' : 'mutation');
        assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.redirect, 'error');
        assert.ok(route, 'Expected only the native filesystem API');
        const override = await beforeRequest(request, { nodes, put, mkdir, events }); if (override) return override;
        if (route === 'list') {
          if (path !== '/' && nodes.get(path)?.type !== 'directory') return new Response(null, { status: 404 });
          return new Response(JSON.stringify({ path, entries: [...nodes].filter(([key]) => parent(key) === path).map(([key, value]) => row(key, value)) }));
        }
        if (route === 'read') {
          if (nodes.get(path)?.type !== 'file') return new Response(null, { status: 404 });
          return new Response(nodes.get(path).content);
        }
        if (route === 'write') {
          if (parsed.searchParams.get('mkdirParents') === 'true') {
            const parts = parent(path).split('/').filter(Boolean);
            for (let index = 1; index <= parts.length; index += 1) if (!nodes.has(`/${parts.slice(0, index).join('/')}`)) mkdir(`/${parts.slice(0, index).join('/')}`);
          }
          if (nodes.get(parent(path))?.type !== 'directory') return new Response(null, { status: 404 });
          put(path, options.body); return new Response(null, { status: 204 });
        }
        if (route === 'delete') {
          if (!nodes.has(path)) return new Response(null, { status: 404 });
          if (parsed.searchParams.get('recursive') === 'true') for (const key of nodes.keys()) if (key.startsWith(`${path}/`)) nodes.delete(key);
          nodes.delete(path); return new Response(null, { status: 204 });
        }
        if (route === 'rename' || route === 'copy') {
          const body = JSON.parse(options.body);
          const targets = [...nodes].filter(([key]) => key === body.source || key.startsWith(`${body.source}/`));
          for (const [key, value] of targets) nodes.set(`${body.dest}${key.slice(body.source.length)}`, { ...value });
          if (route === 'rename') for (const [key] of targets) nodes.delete(key);
          return new Response(null, { status: 204 });
        }
        throw new Error('Unexpected native filesystem route');
      },
    });
    const onMutationStart = async () => { events.push('authorize'); };
    const args = { token, workspaceId, onMutationStart };
    return { adapter, args, nodes, requests, events, put, mkdir };
  }
  it('rejects escapes, managed paths, unsupported actions and unconfirmed deletion before any API request', async () => {
    const f = fixture();
    for (const path of ['/workspace', '/etc/passwd', '/workspace/../outside', '/workspace/runs/program.py', '/workspace/inputs/a', '/workspace/outputs/.constellation']) {
      await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'write', path, text: 'change' }), 'invalid-path');
    }
    for (const action of ['trash', 'restore', 'unknown']) await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action, path: '/workspace/a' }), 'invalid-action');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'delete', path: '/workspace/a' }), 'invalid-action');
    assert.equal(f.requests.length, 0); assert.equal(f.adapter.listWorkspaceTrash, undefined);
  });
  it('uses native reads and listings with bounded bytes, hashes and hidden internal files', async () => {
    const f = fixture(); f.put('/workspace/note.txt', 'draft'); f.mkdir('/workspace/docs'); f.mkdir('/workspace/.constellation-files');
    f.nodes.set('/workspace/link', { type: 'symlink' });
    const entries = await f.adapter.listWorkingFiles(f.args);
    assert.deepEqual(entries.map((entry) => entry.name), ['docs', 'note.txt']);
    const read = await f.adapter.readWorkingFile({ ...f.args, path: '/workspace/note.txt', maxBytes: 5 });
    assert.equal(read.content.toString(), 'draft'); assert.equal(read.hash, hash('draft'));
    await rejected(f.adapter.readWorkingFile({ ...f.args, path: '/workspace/note.txt', maxBytes: 4 }), 'response-limit');
    await rejected(f.adapter.readWorkingFile({ ...f.args, path: '/workspace/missing' }), 'file-not-found');
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });
  it('copies a managed attachment into working files without modifying its snapshot', async () => {
    const f = fixture(); const path = `/workspace/attachments/attOne/${hash('original')}-report.txt`;
    f.mkdir('/workspace/attachments'); f.mkdir('/workspace/attachments/attOne'); f.put(path, 'original');
    const result = await f.adapter.mutateWorkspaceFile({ ...f.args, action: 'copy', path, destination: '/workspace/report.txt' });
    assert.equal(result.entry.path, '/workspace/report.txt'); assert.equal(f.nodes.get('/workspace/report.txt').content.toString(), 'original');
    assert.equal(f.nodes.get(path).content.toString(), 'original');
    assert.sameMembers(f.requests.filter((request) => request.method !== 'GET').map((request) => request.route), ['copy']);
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'move', path, destination: '/workspace/moved.txt' }), 'invalid-path');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'copy', path: '/workspace/report.txt', destination: `${path} copy` }), 'invalid-path');
  });
  it('reads managed attachments above 5 MB through native FS without changing working-file limits', async () => {
    const f = fixture(); const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 'x');
    const path = `/workspace/attachments/attLarge/${hash(bytes)}-large.bin`;
    f.mkdir('/workspace/attachments'); f.mkdir('/workspace/attachments/attLarge'); f.put(path, bytes);
    const result = await f.adapter.readAttachmentBytes({ ...f.args, path, maxBytes: 10_000_000 });
    assert.ok(result.content instanceof Uint8Array); assert.equal(result.content.length, bytes.length); assert.equal(hash(result.content), hash(bytes));
    await rejected(f.adapter.readWorkingFile({ ...f.args, path, maxBytes: 10_000_000 }), 'response-limit');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'upload', path: '/workspace/too-large.bin', content: bytes.toString('base64'), maxBytes: 10_000_000 }), 'response-limit');
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });
  it('limits attachment reads to canonical managed paths, 10 MB, and non-symlink ancestors', async () => {
    const f = fixture(); const path = `/workspace/attachments/attOne/${hash('file')}-file.txt`;
    for (const forbidden of ['/workspace/ordinary.txt', `/workspace/attachments/attOne/${hash('file')}-../file.txt`, `/workspace/attachments/attOne/${hash('file')}-hidden/name`, '/workspace/attachments/attOne/no-hash.txt']) {
      await rejected(f.adapter.readAttachmentBytes({ ...f.args, path: forbidden, maxBytes: 10_000_000 }), 'invalid-path');
    }
    await rejected(f.adapter.readAttachmentBytes({ ...f.args, path, maxBytes: 10_000_001 }), 'response-limit');
    assert.equal(f.requests.length, 0);
    f.mkdir('/workspace/attachments'); f.mkdir('/workspace/attachments/attOne');
    await rejected(f.adapter.readAttachmentBytes({ ...f.args, path }), 'file-not-found');
    f.put(path, Buffer.alloc(10_000_001));
    await rejected(f.adapter.readAttachmentBytes({ ...f.args, path }), 'response-limit');
    assert.ok(!f.requests.some((request) => request.route === 'read'));
    f.nodes.set('/workspace/attachments/attOne', { type: 'symlink' });
    await rejected(f.adapter.readAttachmentBytes({ ...f.args, path }), 'invalid-path');
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });
  it('creates files through native PUT and authorizes immediately before dispatch', async () => {
    const f = fixture(); const text = 'literal $(not-a-command) `also literal`';
    const result = await f.adapter.mutateWorkspaceFile({ ...f.args, action: 'upload', path: '/workspace/new.txt', content: Buffer.from(text).toString('base64') });
    assert.equal(result.hash, hash(text)); assert.equal(f.nodes.get('/workspace/new.txt').content.toString(), text);
    const write = f.requests.find((request) => request.method === 'PUT');
    assert.equal(write.route, 'write'); assert.equal(write.query.get('mkdirParents'), 'false');
    assert.equal(write.query.get('workingDir'), '/workspace'); assert.equal(write.query.get('mode'), '0600');
    assert.equal(write.headers['Content-Type'], 'application/octet-stream'); assert.equal(Buffer.from(write.body).toString(), text);
    assert.equal(f.events[f.events.indexOf('mutation') - 1], 'authorize');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'write', path: '/workspace/new.txt', text: 'collision' }), 'file-exists');
    assert.equal(f.requests.filter((request) => request.method === 'PUT').length, 1);
  });
  it('checks the current file hash before native overwrite without claiming atomic CAS', async () => {
    const f = fixture(); f.put('/workspace/note', 'before');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'write', path: '/workspace/note', text: 'after', expectedHash: hash('stale') }), 'file-changed');
    assert.ok(f.requests.every((request) => request.method === 'GET'));
    const result = await f.adapter.mutateWorkspaceFile({ ...f.args, action: 'write', path: '/workspace/note', text: 'after', expectedHash: hash('before') });
    assert.equal(result.hash, hash('after'));
    const write = f.requests.find((request) => request.method === 'PUT');
    assert.equal(write.headers['If-Match'], undefined); assert.equal(write.query.get('expectedHash'), null);
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'write', path: '/workspace/missing', text: 'after', expectedHash: hash('before') }), 'file-changed');
  });
  it('creates an empty folder with a unique SDK-style marker and authorizes its exact cleanup separately', async () => {
    const f = fixture();
    const result = await f.adapter.mutateWorkspaceFile({ ...f.args, action: 'createFolder', path: '/workspace/new-folder' });
    assert.equal(result.entry.type, 'directory'); assert.equal(f.nodes.size, 2);
    const mutations = f.requests.filter((request) => request.method !== 'GET');
    assert.equal(mutations.length, 2); assert.equal(mutations[0].method, 'PUT'); assert.equal(mutations[1].method, 'DELETE');
    assert.ok(mutations[0].path.startsWith('/workspace/new-folder/.mkdir-')); assert.ok(mutations[0].path.endsWith('.tmp'));
    assert.equal(mutations[0].path, mutations[1].path); assert.equal(mutations[0].query.get('mkdirParents'), 'true');
    assert.equal(mutations[1].query.get('recursive'), 'false');
    for (let index = 0; index < f.events.length; index += 1) if (f.events[index] === 'mutation') assert.equal(f.events[index - 1], 'authorize');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'createFolder', path: '/workspace/new-folder' }), 'file-exists');
  });
  it('uses native rename and recursive copy only after destination and source-tree checks', async () => {
    const f = fixture(); f.mkdir('/workspace/source'); f.put('/workspace/source/file', 'data');
    await f.adapter.mutateWorkspaceFile({ ...f.args, action: 'copy', path: '/workspace/source', destination: '/workspace/copied' });
    const copy = f.requests.find((request) => request.route === 'copy');
    assert.deepEqual(JSON.parse(copy.body), { source: '/workspace/source', dest: '/workspace/copied', workingDir: '/workspace', recursive: true });
    await f.adapter.mutateWorkspaceFile({ ...f.args, action: 'move', path: '/workspace/copied', destination: '/workspace/moved' });
    const rename = f.requests.find((request) => request.route === 'rename');
    assert.deepEqual(JSON.parse(rename.body), { source: '/workspace/copied', dest: '/workspace/moved', workingDir: '/workspace' });
    assert.ok(f.nodes.has('/workspace/moved/file')); assert.ok(!f.nodes.has('/workspace/copied'));
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'rename', path: '/workspace/source', destination: '/workspace/moved' }), 'file-exists');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'copy', path: '/workspace/source', destination: '/workspace/large', maxBytes: 3 }), 'response-limit');
  });
  it('rejects symlink ancestors, symlink descendants and protected descendants before mutation', async () => {
    const f = fixture(); f.nodes.set('/workspace/link', { type: 'symlink' }); f.mkdir('/workspace/folder'); f.nodes.set('/workspace/folder/link', { type: 'symlink' });
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'write', path: '/workspace/link/new', text: 'no' }), 'invalid-path');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'copy', path: '/workspace/folder', destination: '/workspace/copy' }), 'invalid-path');
    f.nodes.delete('/workspace/folder/link'); f.put('/workspace/folder/.constellation-protected', 'no');
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'delete', path: '/workspace/folder', confirm: true }), 'invalid-path');
    assert.ok(f.requests.every((request) => request.method === 'GET'));
  });
  it('uses native DELETE only for the confirmed exact target and verifies absence', async () => {
    const f = fixture(); f.mkdir('/workspace/old'); f.put('/workspace/old/file', 'data'); f.put('/workspace/keep', 'keep');
    const result = await f.adapter.mutateWorkspaceFile({ ...f.args, action: 'delete', path: '/workspace/old', confirm: true });
    assert.equal(result.deleted, true); assert.ok(!f.nodes.has('/workspace/old/file')); assert.ok(f.nodes.has('/workspace/keep'));
    const remove = f.requests.find((request) => request.method === 'DELETE');
    assert.equal(remove.path, '/workspace/old'); assert.equal(remove.query.get('recursive'), 'true'); assert.equal(remove.query.get('workingDir'), '/workspace');
  });
  it('does not dispatch when live authorization is revoked before the first mutation', async () => {
    const f = fixture();
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'write', path: '/workspace/new', text: 'no', onMutationStart: async () => { const error = new Error('revoked'); error.code = 'revoked'; throw error; } }), 'revoked');
    assert.ok(f.requests.every((request) => request.method === 'GET')); assert.ok(!f.nodes.has('/workspace/new'));
  });
  it('quarantines unknown native writes and does not retry or mislabel a later read failure as a safe conflict', async () => {
    const lost = fixture({ beforeRequest: (request) => { if (request.method === 'PUT') throw new Error(token); } });
    await rejected(lost.adapter.mutateWorkspaceFile({ ...lost.args, action: 'write', path: '/workspace/new', text: 'draft' }), 'file-operation-unconfirmed');
    assert.equal(lost.requests.filter((request) => request.method === 'PUT').length, 1);
    let written = false;
    const unreadable = fixture({ beforeRequest: (request) => {
      if (request.method === 'PUT') written = true;
      if (written && request.method === 'GET') return new Response(null, { status: 403 });
      return null;
    } });
    await rejected(unreadable.adapter.mutateWorkspaceFile({ ...unreadable.args, action: 'write', path: '/workspace/new', text: 'draft' }), 'file-operation-unconfirmed');
    assert.equal(unreadable.nodes.get('/workspace/new').content.toString(), 'draft');
  });
  it('retains the folder marker when authorization changes before cleanup and reports uncertainty', async () => {
    const f = fixture(); let grants = 0;
    await rejected(f.adapter.mutateWorkspaceFile({ ...f.args, action: 'createFolder', path: '/workspace/folder', onMutationStart: async () => {
      grants += 1; if (grants === 2) throw new Error('revoked');
    } }), 'file-operation-unconfirmed');
    assert.equal(f.requests.filter((request) => request.method !== 'GET').length, 1);
    assert.ok([...f.nodes.keys()].some((path) => path.startsWith('/workspace/folder/.mkdir-') && path.endsWith('.tmp')));
    const entries = await f.adapter.listWorkingFiles({ ...f.args, path: '/workspace/folder' });
    assert.equal(entries.length, 1); assert.ok(entries[0].name.startsWith('.mkdir-'));
  });
});
