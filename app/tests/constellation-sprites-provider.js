import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) describe('Sprites provider boundary', function () {
  let createAdapter; let networkPolicy; let EventEmitter;
  const workspaceId = 'constellation-run-0123456789abcdef0123456789abcdef';
  const token = 'private-test-token';
  const rejected = async (promise, code) => {
    let error; try { await promise; } catch (caught) { error = caught; }
    assert.ok(error, `Expected ${code}`); assert.strictEqual(error.code, code);
    assert.notInclude(error.message, token); return error;
  };
  const policyFetch = (requests, change = (value) => value) => {
    const policies = new Map();
    return async (url, options) => {
      requests.push({ url, ...options });
      if (url.includes('/policy/')) {
        if (options.method === 'POST') policies.set(url, JSON.parse(options.body));
        else return new Response(JSON.stringify(change(policies.get(url), url)));
      }
      return new Response(null, { status: 204 });
    };
  };
  before(async () => {
    ({ createSpritesAdapter: createAdapter, spritesNetworkPolicy: networkPolicy } = await import('../server/sprites-provider'));
    ({ EventEmitter } = await import('node:events'));
  });
  it('loads the installed SDK through native Node without contacting Sprites', async () => {
    const { loadSpritesClient } = await import('../server/sprites-provider');
    assert.isFunction(await loadSpritesClient());
  });
  it('denies all network access before adding explicit allowed domains', () => {
    assert.deepEqual(networkPolicy(), { rules: [{ domain: '*', action: 'deny' }] });
    assert.deepEqual(networkPolicy(['example.com']), { rules: [{ domain: '*', action: 'deny' }, { domain: 'example.com', action: 'allow' }] });
    for (const domain of ['*', '127.0.0.1', 'https://example.com', 'example.com:443']) assert.throws(() => networkPolicy([domain]));
  });
  it('tests credentials read-only and refuses redirect-based credential forwarding', async () => {
    const requests = [];
    const adapter = createAdapter({ fetchImpl: async (url, options) => { requests.push({ url, ...options }); return new Response('{}'); } });
    await adapter.testConnection({ token });
    assert.lengthOf(requests, 1); assert.strictEqual(requests[0].method, 'GET');
    assert.strictEqual(requests[0].url, 'https://api.sprites.dev/v1/sprites?max_results=1');
    assert.strictEqual(requests[0].redirect, 'error');
  });
  it('applies host policies before writing any guest files', async () => {
    const requests = [];
    const adapter = createAdapter({ fetchImpl: policyFetch(requests) });
    await adapter.createWorkspace({ token, workspaceId, domains: [] });
    assert.strictEqual(requests[0].url, 'https://api.sprites.dev/v1/sprites');
    assert.deepEqual(JSON.parse(requests[0].body).url_settings, { auth: 'sprite', private_access: 'admins' });
    assert.include(requests[1].url, '/policy/network');
    assert.deepEqual(JSON.parse(requests[1].body), { rules: [{ domain: '*', action: 'deny' }] });
    assert.include(requests[2].url, '/policy/resources'); assert.include(requests[3].url, '/policy/privileges');
    assert.isTrue(requests.slice(4, 7).every((request) => request.method === 'GET' && request.url.includes('/policy/')));
    assert.include(requests[7].url, '/fs/write');
    assert.strictEqual(new URL(requests[7].url).searchParams.get('mkdirParents'), 'true');
    assert.notInclude(requests.map((request) => typeof request.body === 'string' ? request.body : '').join(''), token);
  });
  it('fails closed when a network policy cannot be applied', async () => {
    const requests = [];
    const adapter = createAdapter({ fetchImpl: async (url) => { requests.push(url); return new Response(null, { status: requests.length === 2 ? 500 : 204 }); } });
    await rejected(adapter.createWorkspace({ token, workspaceId }), 'provider-error');
    assert.lengthOf(requests, 2); assert.isFalse(requests.some((url) => url.includes('/fs/')));
  });
  it('marks lost creation responses uncertain without replaying the write', async () => {
    let count = 0;
    const adapter = createAdapter({ fetchImpl: async () => { count += 1; throw new Error(token); } });
    const error = await rejected(adapter.createWorkspace({ token, workspaceId }), 'network-error');
    assert.isTrue(error.creationUncertain); assert.strictEqual(count, 1);
  });
  it('redacts provider errors and bounds returned file bytes', async () => {
    const adapter = createAdapter({ fetchImpl: async () => new Response(token, { status: 401 }) });
    await rejected(adapter.testConnection({ token }), 'key-rejected');
    const large = createAdapter({ fetchImpl: async () => new Response('12345') });
    await rejected(large.readFile({ token, workspaceId, path: '/workspace/outputs/data.txt', maxBytes: 4 }), 'response-limit');
  });
  it('refuses arbitrary remote targets and paths before making a request', async () => {
    let count = 0;
    const adapter = createAdapter({ fetchImpl: async () => { count += 1; return new Response('{}'); } });
    await rejected(adapter.destroyWorkspace({ token, workspaceId: 'someone-elses-sprite' }), 'invalid-workspace');
    for (const path of ['/etc/passwd', '/workspace/outputs/../secret', '/workspace/main.py']) {
      await rejected(adapter.readFile({ token, workspaceId, path }), 'invalid-path');
    }
    assert.strictEqual(count, 0);
  });
  it('confirms deletion on not-found but does not disguise failed cleanup', async () => {
    const missing = createAdapter({ fetchImpl: async () => new Response(null, { status: 404 }) });
    await missing.destroyWorkspace({ token, workspaceId });
    const failed = createAdapter({ fetchImpl: async () => { throw new Error(token); } });
    await rejected(failed.destroyWorkspace({ token, workspaceId }), 'cleanup-unconfirmed');
  });
  function fakeCommand() {
    const cmd = new EventEmitter(); cmd.stdout = new EventEmitter(); cmd.stderr = new EventEmitter();
    cmd.stdin = { end: (value) => { cmd.input = value; } }; cmd.close = () => { cmd.closed = true; };
    return cmd;
  }
  const request = { workspaceId, command: ['python3', '/workspace/main.py'], timeoutMs: 1000, maxOutputBytes: 64000 };
  it('uses non-detachable execution with no host credentials and preserves split UTF-8 output', async () => {
    const cmd = fakeCommand(); let spawn;
    const adapter = createAdapter({ clientFactory: async () => ({ sprite: (name) => { assert.strictEqual(name, workspaceId); return { spawn: (...args) => { spawn = args; queueMicrotask(() => {
      cmd.emit('spawn'); const bytes = Buffer.from('hello 🌍'); cmd.stdout.emit('data', bytes.subarray(0, 8)); cmd.stdout.emit('data', bytes.subarray(8));
      cmd.stderr.emit('data', Buffer.from('warning')); cmd.emit('exit', 0);
    }); return cmd; } }; } }) });
    const output = [];
    const result = await adapter.createSpritesProvider({ token }).run(request, { signal: new AbortController().signal, onOutput: (chunk) => output.push(chunk) });
    assert.strictEqual(result.exitCode, 0); assert.isTrue(cmd.closed);
    assert.deepEqual(spawn.slice(0, 2), ['python3', ['/workspace/main.py']]);
    assert.isFalse(spawn[2].detachable); assert.strictEqual(spawn[2].maxRunAfterDisconnect, '1s');
    assert.notInclude(JSON.stringify(spawn), token); assert.notProperty(spawn[2].env, 'SPRITES_TOKEN');
    assert.strictEqual(output.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.text).join(''), 'hello 🌍');
  });
  it('waits for remote deletion before confirming cancellation', async () => {
    const cmd = fakeCommand(); const controller = new AbortController(); let release; let deleting = false; let settled = false;
    const adapter = createAdapter({ clientFactory: async () => ({ sprite: () => ({ spawn: () => { queueMicrotask(() => controller.abort()); return cmd; } }) }),
      fetchImpl: async (_url, options) => { assert.strictEqual(options.method, 'DELETE'); deleting = true; await new Promise((resolve) => { release = resolve; }); return new Response(null, { status: 204 }); } });
    const pending = adapter.createSpritesProvider({ token }).run(request, { signal: controller.signal, onOutput() {} });
    pending.then(() => { settled = true; }, () => { settled = true; });
    while (!deleting) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.isFalse(settled); assert.isTrue(cmd.closed); release(); await rejected(pending, 'cancelled');
  });
  it('surfaces cleanup uncertainty after a transport failure', async () => {
    const cmd = fakeCommand();
    const adapter = createAdapter({ clientFactory: async () => ({ sprite: () => ({ spawn: () => { queueMicrotask(() => cmd.emit('error', new Error(token))); return cmd; } }) }),
      fetchImpl: async () => new Response(null, { status: 500 }) });
    await rejected(adapter.createSpritesProvider({ token }).run(request, { signal: new AbortController().signal, onOutput() {} }), 'cleanup-unconfirmed');
  });
  const ndjson = (...events) => new Response(events.map((event) => JSON.stringify(event)).join('\n'), {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
  const stopped = () => ndjson({ type: 'signal', signal: 'SIGTERM', pid: 1847 }, { type: 'exited' }, { type: 'complete', exit_code: 0 });
  it('refreshes all three host policies without recreating a persistent environment', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: policyFetch(calls) });
    await adapter.applyPolicies({ token, workspaceId, domains: ['example.com'] });
    assert.lengthOf(calls, 6); assert.isTrue(calls.slice(0, 3).every((call) => call.method === 'POST' && call.url.includes(`/sprites/${workspaceId}/policy/`)));
    assert.isTrue(calls.slice(3).every((call) => call.method === 'GET'));
    assert.deepEqual(JSON.parse(calls[0].body), networkPolicy(['example.com']));
  });
  it('confirms a process-group stop only after a complete kill stream', async () => {
    let call;
    const adapter = createAdapter({ fetchImpl: async (url, options) => { call = { url, ...options }; return ndjson(
      { type: 'signal', signal: 'SIGTERM', pid: 1847 }, { type: 'timeout' }, { type: 'killed' }, { type: 'complete', exit_code: 137 },
    ); } });
    assert.deepEqual(await adapter.stopExecution({ token, workspaceId, executionId: '1847' }), { stopped: true, executionId: '1847' });
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(new URL(call.url).pathname, `/v1/sprites/${workspaceId}/exec/1847/kill`);
    assert.strictEqual(new URL(call.url).searchParams.get('signal'), 'SIGTERM');
    assert.strictEqual(new URL(call.url).searchParams.get('timeout'), '10s');
  });
  it('quarantines ambiguous, truncated, malformed, and failed kill responses', async () => {
    const responses = [
      () => new Response(null, { status: 204 }), () => new Response(null, { status: 404 }),
      () => ndjson({ type: 'signal', pid: 1847 }), () => ndjson({ type: 'complete' }),
      () => ndjson({ type: 'error', message: token }, { type: 'complete', exit_code: 0 }),
      () => new Response('{"type":"complete","exit_code":'),
      () => ndjson({ type: 'complete', exit_code: 0 }, { type: 'signal' }),
      () => new Response('x'.repeat(64_001)),
    ];
    for (const response of responses) {
      const adapter = createAdapter({ fetchImpl: async () => response() });
      await rejected(adapter.stopExecution({ token, workspaceId, sessionId: '1847' }), 'stop-unconfirmed');
    }
    let calls = 0;
    const adapter = createAdapter({ fetchImpl: async () => { calls += 1; return stopped(); } });
    for (const executionId of [undefined, '', '../1847', '1847?signal=SIGKILL']) {
      await rejected(adapter.stopExecution({ token, workspaceId, executionId }), 'stop-unconfirmed');
    }
    assert.strictEqual(calls, 0);
  });
  it('waits for the final kill event across arbitrary HTTP chunks', async () => {
    let stream; let settled = false;
    const adapter = createAdapter({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })) });
    const pending = adapter.stopExecution({ token, workspaceId, executionId: '1847' });
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream.enqueue(Buffer.from('{"type":"signal"}\n{"type":"com'));
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.isFalse(settled);
    stream.enqueue(Buffer.from('plete","exit_code":0}\n')); stream.close();
    assert.isTrue((await pending).stopped);
  });
  function fakeSocket() {
    const socket = new EventEmitter(); socket.sent = []; socket.closed = false;
    socket.addEventListener = socket.on.bind(socket); socket.removeEventListener = socket.off.bind(socket);
    socket.send = (frame) => { socket.sent.push(Buffer.from(frame)); };
    socket.close = () => { socket.closed = true; };
    socket.receive = (data) => socket.emit('message', { data });
    return socket;
  }
  const session = (socket, id = '1847') => socket.receive(JSON.stringify({ type: 'session_info', session_id: id, is_owner: true, tty: false }));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  it('holds persistent user code behind stdin until its remote session ID is durably stored', async () => {
    const socket = fakeSocket(); const calls = []; const output = []; let release; let persisted = false; let opened;
    const adapter = createAdapter({ webSocketFactory: (url, options) => { opened = { url, ...options }; return socket; },
      fetchImpl: async (url) => { calls.push(url); return stopped(); } });
    const pending = adapter.createSpritesProvider({ token, persistent: true, cwd: '/workspace', onSession: async (id) => {
      assert.strictEqual(id, '1847'); await new Promise((resolve) => { release = resolve; }); persisted = true;
    } }).run({ ...request, stdin: 'original\ninput' }, { onOutput: (chunk) => output.push(chunk) });
    session(socket); await tick(); assert.lengthOf(socket.sent, 0);
    const query = new URL(opened.url).searchParams;
    assert.strictEqual(query.get('tty'), 'false'); assert.strictEqual(query.get('dir'), '/workspace');
    assert.strictEqual(query.get('max_run_after_disconnect'), '1s');
    assert.deepEqual(query.getAll('cmd').slice(-2), request.command);
    assert.include(query.getAll('cmd')[2], 'exec "$@"');
    assert.notInclude(opened.url, token); assert.notInclude(query.getAll('env').join(' '), token);
    release(); await tick(); assert.isTrue(persisted);
    assert.strictEqual(socket.sent[0].subarray(1).toString(), 'constellation-ready\n');
    assert.strictEqual(socket.sent[1].subarray(1).toString(), 'original\ninput'); assert.deepEqual([...socket.sent[2]], [4]);
    const bytes = Buffer.from('hello 🌍');
    socket.receive(Buffer.concat([Buffer.from([1]), bytes.subarray(0, 8)]));
    socket.receive(Buffer.concat([Buffer.from([1]), bytes.subarray(8)]));
    socket.receive(Buffer.concat([Buffer.from([2]), Buffer.from('warning')])); socket.receive(Buffer.from([3, 0]));
    assert.deepEqual(await pending, { exitCode: 0, executionId: '1847' }); assert.isTrue(socket.closed); assert.lengthOf(calls, 0);
    assert.strictEqual(output.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.text).join(''), 'hello 🌍');
    assert.strictEqual(socket.listenerCount('message'), 0);
  });
  it('never deletes persistent files on cancellation and waits for process-group confirmation', async () => {
    const socket = fakeSocket(); const controller = new AbortController(); const calls = []; let release; let settled = false;
    const adapter = createAdapter({ webSocketFactory: () => socket, fetchImpl: async (url, options) => {
      calls.push({ url, ...options }); await new Promise((resolve) => { release = resolve; }); return stopped();
    } });
    const pending = adapter.createSpritesProvider({ token, persistent: true, onSession: async () => {} }).run(request, { signal: controller.signal, onOutput() {} });
    pending.then(() => { settled = true; }, () => { settled = true; });
    session(socket); await tick(); controller.abort(); await tick();
    assert.isFalse(settled); assert.isTrue(socket.closed); assert.lengthOf(calls, 1);
    assert.strictEqual(calls[0].method, 'POST'); assert.include(calls[0].url, '/exec/1847/kill?');
    release(); await rejected(pending, 'cancelled');
  });
  it('ignores bounded debug frames before and after the durable session receipt', async () => {
    const socket = fakeSocket(); const calls = []; const output = []; let received;
    const adapter = createAdapter({ webSocketFactory: () => socket, fetchImpl: async (url) => { calls.push(url); return stopped(); } });
    const pending = adapter.createSpritesProvider({ token, persistent: true, onSession: async (id) => { received = id; } })
      .run(request, { onOutput: (chunk) => output.push(chunk) });
    socket.receive(JSON.stringify({ type: 'debug', msg: 'session_created cmd=/bin/sh', pid: 5, t_ms: 24 }));
    assert.lengthOf(socket.sent, 0); assert.isUndefined(received);
    session(socket, '5'); await tick();
    socket.receive(JSON.stringify({ type: 'debug', msg: 'private diagnostics are not chat output' }));
    socket.receive(Buffer.concat([Buffer.from([1]), Buffer.from('visible result')])); socket.receive(Buffer.from([3, 0]));
    assert.deepEqual(await pending, { exitCode: 0, executionId: '5' }); assert.strictEqual(received, '5');
    assert.deepEqual(output, [{ stream: 'stdout', text: 'visible result' }]); assert.lengthOf(calls, 0);
  });
  it('accepts the live non-TTY is_owner:false receipt while retaining the durable exact-ID gate', async () => {
    const socket = fakeSocket(); let release; let received; let url;
    const adapter = createAdapter({ webSocketFactory: (value) => { url = value; return socket; } });
    const pending = adapter.createSpritesProvider({ token, persistent: true, onSession: async (id) => {
      received = id; await new Promise((resolve) => { release = resolve; });
    } }).run(request, { onOutput() {} });
    socket.receive(JSON.stringify({ type: 'session_info', session_id: '5', command: '/bin/sh', created: 1790034836,
      cols: 0, rows: 0, is_owner: false, tty: false }));
    await tick(); assert.strictEqual(received, '5'); assert.lengthOf(socket.sent, 0);
    assert.strictEqual(new URL(url).pathname, `/v1/sprites/${workspaceId}/exec`);
    assert.isFalse(new URL(url).searchParams.has('id'));
    release(); await tick(); assert.strictEqual(socket.sent[0].subarray(1).toString(), 'constellation-ready\n');
    socket.receive(Buffer.from([3, 0])); assert.deepEqual(await pending, { exitCode: 0, executionId: '5' });
  });
  it('still rejects a missing or conflicting ID regardless of non-TTY ownership metadata', async () => {
    for (const conflict of [false, true]) {
      const socket = fakeSocket(); const calls = [];
      const adapter = createAdapter({ webSocketFactory: () => socket, fetchImpl: async (url) => { calls.push(url); return stopped(); } });
      const pending = adapter.createSpritesProvider({ token, persistent: true, onSession: async () => {} }).run(request, { onOutput() {} });
      if (conflict) socket.receive(JSON.stringify({ type: 'session_info', session_id: '5', tty: false, is_owner: false }));
      socket.receive(JSON.stringify({ type: 'session_info', ...(conflict ? { session_id: '6' } : {}), tty: false, is_owner: false }));
      await rejected(pending, conflict ? 'invalid-response' : 'stop-unconfirmed');
      assert.lengthOf(socket.sent, 0);
      if (conflict) assert.include(calls[0], '/exec/5/kill?'); else assert.lengthOf(calls, 0);
    }
  });
  it('does not treat diagnostic frames as a substitute for a session ID and still bounds them', async () => {
    const socket = fakeSocket(); const output = []; const adapter = createAdapter({ webSocketFactory: () => socket });
    const pending = adapter.createSpritesProvider({ token, persistent: true, onSession: async () => {} }).run(request, { onOutput: (chunk) => output.push(chunk) });
    socket.receive(JSON.stringify({ type: 'debug', msg: 'x'.repeat(16_000) }));
    await rejected(pending, 'stop-unconfirmed'); assert.lengthOf(output, 0); assert.lengthOf(socket.sent, 0);
  });
  it('reports persistent stop uncertainty without issuing destructive fallback requests', async () => {
    for (const known of [false, true]) {
      const socket = fakeSocket(); const calls = [];
      const adapter = createAdapter({ webSocketFactory: () => socket, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return ndjson({ type: 'signal' }); } });
      const pending = adapter.createSpritesProvider({ token, persistent: true, onSession: async () => {} }).run(request, { onOutput() {} });
      if (known) { session(socket); await tick(); }
      socket.emit('error', new Error(token)); await rejected(pending, 'stop-unconfirmed');
      assert.lengthOf(calls, known ? 1 : 0); assert.isFalse(calls.some((call) => call.method === 'DELETE'));
    }
  });
  it('stops the captured session if persistence fails before releasing user code', async () => {
    const socket = fakeSocket(); const calls = [];
    const adapter = createAdapter({ webSocketFactory: () => socket, fetchImpl: async (url) => { calls.push(url); return stopped(); } });
    const pending = adapter.createSpritesProvider({ token, persistent: true, onSession: async () => { throw new Error(token); } }).run(request, { onOutput() {} });
    session(socket); await rejected(pending, 'provider-error'); assert.lengthOf(socket.sent, 0);
    assert.lengthOf(calls, 1); assert.include(calls[0], '/exec/1847/kill?');
  });
  it('does not release delayed persisted work after cancellation', async () => {
    const socket = fakeSocket(); const controller = new AbortController(); let release;
    const adapter = createAdapter({ webSocketFactory: () => socket, fetchImpl: async () => stopped() });
    const pending = adapter.createSpritesProvider({ token, persistent: true, onSession: () => new Promise((resolve) => { release = resolve; }) })
      .run(request, { signal: controller.signal, onOutput() {} });
    session(socket); await tick(); controller.abort(); await rejected(pending, 'cancelled');
    release(); await tick(); assert.lengthOf(socket.sent, 0);
  });
  it('requires a durable-session callback and valid workspace cwd before connecting', async () => {
    let connections = 0;
    const adapter = createAdapter({ webSocketFactory: () => { connections += 1; return fakeSocket(); } });
    await rejected(adapter.createSpritesProvider({ token, persistent: true }).run(request, { onOutput() {} }), 'invalid-response');
    await rejected(adapter.createSpritesProvider({ token, persistent: true, cwd: '/etc', onSession() {} }).run(request, { onOutput() {} }), 'invalid-path');
    const controller = new AbortController(); controller.abort();
    await rejected(adapter.createSpritesProvider({ token, persistent: true, onSession() {} }).run(request, { signal: controller.signal, onOutput() {} }), 'cancelled');
    assert.strictEqual(connections, 0);
  });
  const entry = (path, type = 'file', size = 0) => ({ name: path.split('/').at(-1), path, type, size, isDir: type === 'directory' });
  const directoryFetch = (directories, calls, file = 'abc') => async (url, options) => {
    calls.push({ url, ...options }); const parsed = new URL(url); const path = parsed.searchParams.get('path');
    if (parsed.pathname.endsWith('/fs/list')) return new Response(JSON.stringify({ path, entries: directories[path] ?? [] }));
    if (parsed.pathname.endsWith('/fs/read')) return new Response(file);
    if (parsed.pathname.endsWith('/fs/delete')) return new Response(null, { status: 204 });
    throw new Error('Unexpected endpoint');
  };
  it('lists only bounded, validated workspace entries and excludes symlinks', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: directoryFetch({
      '/': [entry('/workspace', 'directory')],
      '/workspace': [entry('/workspace/data', 'directory'), entry('/workspace/readme.txt', 'file', 3), entry('/workspace/outside', 'symlink')],
    }, calls) });
    assert.deepEqual(await adapter.listFiles({ token, workspaceId }), [
      { name: 'data', path: '/workspace/data', type: 'directory', size: 0 },
      { name: 'readme.txt', path: '/workspace/readme.txt', type: 'file', size: 3 },
    ]);
    assert.isTrue(calls.every((call) => call.method === 'GET'));
    for (const entries of [[entry('/etc/passwd')], [entry('/workspace/file', 'unknown')],
      [entry('/workspace/file', 'file', -1)], [entry('/workspace/file'), entry('/workspace/file')],
      Array.from({ length: 1001 }, (_, index) => entry(`/workspace/f${index}`))]) {
      const bad = createAdapter({ fetchImpl: directoryFetch({ '/': [entry('/workspace', 'directory')], '/workspace': entries }, []) });
      await rejected(bad.listFiles({ token, workspaceId }), 'invalid-response');
    }
  });
  it('rejects lexical escapes and symlink ancestors before downloading guest bytes', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: directoryFetch({ '/': [entry('/workspace', 'directory')],
      '/workspace': [entry('/workspace/linked', 'symlink'), entry('/workspace/readme.txt', 'file', 3)] }, calls) });
    for (const path of ['/etc/passwd', '/workspace/../etc/passwd', '/workspace//readme.txt', '/workspace/readme.txt/', '/workspace/a\\b', '/workspace/a\0b']) {
      await rejected(adapter.readWorkspaceFile({ token, workspaceId, path }), 'invalid-path');
    }
    assert.lengthOf(calls, 0);
    await rejected(adapter.readWorkspaceFile({ token, workspaceId, path: '/workspace/linked/secret' }), 'invalid-path');
    assert.isFalse(calls.some((call) => call.url.includes('/fs/read')));
    const bytes = await adapter.readWorkspaceFile({ token, workspaceId, path: '/workspace/readme.txt', maxBytes: 3 });
    assert.strictEqual(Buffer.from(bytes).toString(), 'abc');
    await rejected(adapter.readWorkspaceFile({ token, workspaceId, path: '/workspace/readme.txt', maxBytes: 2 }), 'response-limit');
    const rootLink = createAdapter({ fetchImpl: directoryFetch({ '/': [entry('/workspace', 'symlink')] }, []) });
    await rejected(rootLink.listFiles({ token, workspaceId }), 'invalid-path');
  });
  it('clears only exact declared output files, never recursively or outside outputs', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: directoryFetch({ '/': [entry('/workspace', 'directory')],
      '/workspace': [entry('/workspace/outputs', 'directory')],
      '/workspace/outputs': [entry('/workspace/outputs/result.csv'), entry('/workspace/outputs/folder', 'directory')],
    }, calls) });
    await adapter.clearOutputFiles({ token, workspaceId, paths: ['result.csv', '/workspace/outputs/result.csv', 'missing.txt'] });
    const deletes = calls.filter((call) => call.method === 'DELETE'); assert.lengthOf(deletes, 1);
    assert.strictEqual(new URL(deletes[0].url).searchParams.get('path'), '/workspace/outputs/result.csv');
    assert.strictEqual(new URL(deletes[0].url).searchParams.get('recursive'), 'false');
    await rejected(adapter.clearOutputFiles({ token, workspaceId, paths: ['folder'] }), 'invalid-path');
    const before = calls.length;
    await rejected(adapter.clearOutputFiles({ token, workspaceId, paths: ['../main.py'] }), 'invalid-path');
    assert.strictEqual(calls.length, before);
  });
  it('creates and verifies the exact checkpoint ID from the terminal NDJSON event', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return url.endsWith('/checkpoint') ? ndjson({ type: 'info', data: 'Creating' }, { type: 'complete', data: 'Checkpoint v3 created successfully' })
        : new Response(JSON.stringify({ id: 'v3', create_time: '2026-01-05T10:30:00Z' }));
    } });
    const saved = await adapter.createCheckpoint({ token, workspaceId, comment: 'Before changes' });
    assert.strictEqual(saved.id, 'v3'); assert.instanceOf(saved.createdAt, Date);
    assert.strictEqual(calls[0].method, 'POST'); assert.deepEqual(JSON.parse(calls[0].body), { comment: 'Before changes' });
    assert.isTrue(calls[1].url.endsWith('/checkpoints/v3')); assert.lengthOf(calls, 2);
  });
  it('never substitutes the latest checkpoint or assumes restore success from HTTP 200', async () => {
    for (const response of [() => ndjson({ type: 'info', data: 'Working' }), () => ndjson({ type: 'complete', data: 'Saved' }),
      () => ndjson({ type: 'error', error: token }), () => new Response('{"type":"complete"')]) {
      const calls = [];
      const adapter = createAdapter({ fetchImpl: async (url) => { calls.push(url); return response(); } });
      await rejected(adapter.createCheckpoint({ token, workspaceId }), 'checkpoint-unconfirmed');
      assert.lengthOf(calls, 1);
    }
    const adapter = createAdapter({ fetchImpl: async () => ndjson({ type: 'info' }) });
    await rejected(adapter.restoreCheckpoint({ token, workspaceId, checkpointId: 'v3' }), 'restore-unconfirmed');
    await rejected(adapter.restoreCheckpoint({ token, workspaceId, checkpointId: '../v3' }), 'invalid-checkpoint');
    await rejected(adapter.restoreCheckpoint({ token, workspaceId, checkpointId: 'Current' }), 'invalid-checkpoint');
  });
  it('returns restore completion only from a terminal provider receipt and lists saved metadata', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: async (url, options) => {
      calls.push({ url, ...options }); return url.endsWith('/restore') ? ndjson({ type: 'info' }, { type: 'complete', data: 'Restored to v3' })
        : new Response(JSON.stringify([{ id: 'Current' }, { id: 'v3', create_time: '2026-01-05T10:30:00Z', comment: 'Saved' }]));
    } });
    assert.deepEqual(await adapter.restoreCheckpoint({ token, workspaceId, checkpointId: 'v3' }), { restored: true, id: 'v3' });
    assert.isTrue(calls[0].url.endsWith('/checkpoints/v3/restore')); assert.strictEqual(calls[0].method, 'POST');
    const checkpoints = await adapter.listCheckpoints({ token, workspaceId }); assert.lengthOf(checkpoints, 1);
    assert.strictEqual(checkpoints[0].id, 'v3'); assert.strictEqual(checkpoints[0].comment, 'Saved');
  });
  it('refuses to start files or code when policy readback differs from the requested limits', async () => {
    for (const changed of ['network', 'resources', 'privileges']) {
      const calls = [];
      const adapter = createAdapter({ fetchImpl: policyFetch(calls, (value, url) => url.endsWith(`/${changed}`)
        ? ({ network: { rules: [] }, resources: { memory: { limit_mb: 2048, autoscale: false } }, privileges: { profile: 'standard', noNewPrivileges: false } })[changed]
        : value) });
      await rejected(adapter.createWorkspace({ token, workspaceId }), 'policy-unconfirmed');
      assert.isFalse(calls.some((call) => call.url.includes('/fs/')));
    }
    const calls = [];
    const extra = createAdapter({ fetchImpl: policyFetch(calls, (value, url) => url.endsWith('/network') ? { rules: [...value.rules, { include: 'defaults' }] } : value) });
    await rejected(extra.applyPolicies({ token, workspaceId }), 'policy-unconfirmed');
    const reordered = createAdapter({ fetchImpl: policyFetch([], (value, url) => url.endsWith('/network') ? { rules: [...value.rules].reverse() } : value) });
    await reordered.applyPolicies({ token, workspaceId, domains: ['example.com'] });
  });
  it('uses only the final checkpoint event as the terminal success or error', async () => {
    const adapter = createAdapter({ fetchImpl: async (url) => url.endsWith('/checkpoint')
      ? ndjson({ type: 'error', error: 'nonfatal advisory' }, { type: 'info' }, { type: 'complete', data: 'Checkpoint v3 created' })
      : url.endsWith('/restore') ? ndjson({ type: 'error', error: 'nonfatal advisory' }, { type: 'complete', data: 'Restore from v3 complete' })
        : new Response(JSON.stringify({ id: 'v3', health: '' })) });
    assert.strictEqual((await adapter.createCheckpoint({ token, workspaceId })).id, 'v3');
    assert.isTrue((await adapter.restoreCheckpoint({ token, workspaceId, checkpointId: 'v3' })).restored);
    const failed = createAdapter({ fetchImpl: async () => ndjson({ type: 'info' }, { type: 'error', error: token }) });
    await rejected(failed.restoreCheckpoint({ token, workspaceId, checkpointId: 'v3' }), 'restore-unconfirmed');
  });
  it('preserves checkpoint health and never accepts an unhealthy newly created save point', async () => {
    const metadata = { id: 'v3', health: 'mount_failed', comment: 'Before change', create_time: '2026-01-05T10:30:00Z' };
    const adapter = createAdapter({ fetchImpl: async (url) => url.endsWith('/checkpoint')
      ? ndjson({ type: 'complete', data: 'Checkpoint v3 created' })
      : new Response(JSON.stringify(url.endsWith('/checkpoints') ? [metadata] : metadata)) });
    assert.strictEqual((await adapter.getCheckpoint({ token, workspaceId, checkpointId: 'v3' })).health, 'mount_failed');
    assert.strictEqual((await adapter.listCheckpoints({ token, workspaceId }))[0].health, 'mount_failed');
    await rejected(adapter.createCheckpoint({ token, workspaceId }), 'checkpoint-unhealthy');
  });
  function controlAdapter(response, { calls = [], inspect = () => {}, fetchImpl } = {}) {
    return createAdapter({ fetchImpl: fetchImpl ?? (async (url, options) => {
      calls.push({ url, ...options });
      return new Response(JSON.stringify({ id: 'v3', health: '' }));
    }), webSocketFactory: (url, options) => {
      const socket = fakeSocket(); let input = '';
      const query = new URL(url).searchParams;
      assert.deepEqual(query.getAll('cmd').slice(4, 7), ['/usr/bin/python3', '-I', '-c']);
      assert.strictEqual(query.get('dir'), '/'); assert.notInclude(url, token);
      socket.send = (frame) => {
        const bytes = Buffer.from(frame);
        if (bytes[0] === 0 && bytes.subarray(1).toString() !== 'constellation-ready\n') input += bytes.subarray(1).toString();
        if (bytes[0] === 4) {
          const payload = JSON.parse(input); inspect({ payload, source: query.getAll('cmd')[7], options });
          socket.receive(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(typeof response === 'function' ? response(payload) : response))]));
          socket.receive(Buffer.from([3, 0]));
        }
      };
      queueMicrotask(() => session(socket)); return socket;
    } });
  }
  it('recovers historical workspace files through read-only pinned FDs without restoring the VM', async () => {
    const calls = []; const controls = []; const receipts = []; const finished = [];
    const adapter = controlAdapter((input) => input.action === 'list'
      ? { entries: [{ name: 'report.txt', path: '/workspace/report.txt', type: 'file', size: 3 }] }
      : { base64: Buffer.from('old').toString('base64') }, { calls, inspect: (value) => { assert.isAbove(receipts.length, 0); controls.push(value); } });
    const onSession = async (id) => { receipts.push(id); };
    const onSessionFinished = async (id) => { finished.push(id); };
    const files = await adapter.listCheckpointFiles({ token, workspaceId, checkpointId: 'v3', onSession, onSessionFinished });
    assert.strictEqual(files[0].path, '/workspace/report.txt');
    assert.strictEqual((await adapter.readCheckpointFile({ token, workspaceId, checkpointId: 'v3', path: files[0].path, onSession, onSessionFinished })).toString(), 'old');
    assert.deepEqual(controls.map((value) => value.payload.action), ['list', 'read']);
    assert.include(controls[0].source, 'os.O_NOFOLLOW'); assert.include(controls[0].source, 'os.ST_RDONLY');
    assert.deepEqual(receipts, ['1847', '1847']);
    assert.deepEqual(finished, receipts);
    assert.isTrue(calls.every((call) => call.method === 'GET' && call.url.endsWith('/checkpoints/v3')));
  });
  it('rejects historical path escapes, oversized files, missing mounts, and unhealthy snapshots', async () => {
    const calls = []; const adapter = controlAdapter({ error: 'checkpoint-unavailable' }, { calls });
    for (const path of ['/etc/passwd', '/workspace/../etc/passwd', '/workspace//file', '/workspace/a\\b']) {
      await rejected(adapter.readCheckpointFile({ token, workspaceId, checkpointId: 'v3', path }), 'invalid-path');
    }
    assert.lengthOf(calls, 0);
    await rejected(adapter.listCheckpointFiles({ token, workspaceId, checkpointId: 'v3' }), 'checkpoint-unavailable');
    const large = controlAdapter({ base64: Buffer.from('four').toString('base64') });
    await rejected(large.readCheckpointFile({ token, workspaceId, checkpointId: 'v3', path: '/workspace/file', maxBytes: 3 }), 'response-limit');
    const symlink = controlAdapter({ error: 'invalid-path' });
    await rejected(symlink.readCheckpointFile({ token, workspaceId, checkpointId: 'v3', path: '/workspace/link' }), 'invalid-path');
    let opened = false;
    const unhealthy = createAdapter({ fetchImpl: async () => new Response(JSON.stringify({ id: 'v3', health: 'mount_failed' })), webSocketFactory: () => { opened = true; return fakeSocket(); } });
    await rejected(unhealthy.listCheckpointFiles({ token, workspaceId, checkpointId: 'v3' }), 'checkpoint-unhealthy'); assert.isFalse(opened);
  });
  it('clears helper receipts on confirmed cancellation but preserves unconfirmed stops', async () => {
    for (const confirmed of [true, false]) {
      const socket = fakeSocket(); const controller = new AbortController(); const receipts = []; const finished = [];
      const adapter = createAdapter({ webSocketFactory: () => { queueMicrotask(() => session(socket)); return socket; },
        fetchImpl: async (url) => url.endsWith('/checkpoints/v3') ? new Response(JSON.stringify({ id: 'v3' }))
          : confirmed ? stopped() : ndjson({ type: 'signal' }) });
      const pending = adapter.listCheckpointFiles({ token, workspaceId, checkpointId: 'v3', signal: controller.signal,
        onSession: async (id) => { receipts.push(id); }, onSessionFinished: async (id) => { finished.push(id); } });
      await tick(); assert.deepEqual(receipts, ['1847']); controller.abort();
      await rejected(pending, confirmed ? 'cancelled' : 'stop-unconfirmed');
      assert.deepEqual(finished, confirmed ? ['1847'] : []);
    }
  });
  it('confirms exact checkpoint deletion through the documented local socket and independent remote inventory', async () => {
    let lists = 0; let control; let receipt;
    const adapter = controlAdapter({ status: 204 }, { inspect: (value) => { assert.strictEqual(receipt, '1847'); control = value; }, fetchImpl: async (url, options) => {
      assert.isTrue(url.endsWith('/checkpoints')); assert.strictEqual(options.method, 'GET'); lists += 1;
      return new Response(JSON.stringify(lists === 1 ? [{ id: 'v3' }] : []));
    } });
    assert.deepEqual(await adapter.deleteCheckpoint({ token, workspaceId, checkpointId: 'v3', onSession: async (id) => { receipt = id; } }), { deleted: true, id: 'v3' });
    assert.deepEqual(control.payload, { action: 'delete', id: 'v3' }); assert.include(control.source, "'/v1/checkpoints/'+q['id']");
    assert.strictEqual(lists, 2);
    await rejected(adapter.deleteCheckpoint({ token, workspaceId, checkpointId: 'Current' }), 'checkpoint-current');
    await rejected(adapter.deleteCheckpoint({ token, workspaceId, checkpointId: '../v3' }), 'invalid-checkpoint');
  });
  it('never claims checkpoint deletion from command success without confirmed absence', async () => {
    const stillThere = controlAdapter({ status: 204 }, { fetchImpl: async () => new Response(JSON.stringify([{ id: 'v3' }])) });
    await rejected(stillThere.deleteCheckpoint({ token, workspaceId, checkpointId: 'v3' }), 'checkpoint-delete-unconfirmed');
    const current = controlAdapter({ status: 409 }, { fetchImpl: async () => new Response(JSON.stringify([{ id: 'v3' }])) });
    await rejected(current.deleteCheckpoint({ token, workspaceId, checkpointId: 'v3' }), 'checkpoint-current');
    let count = 0; let finished;
    const unreadable = controlAdapter({ status: 204 }, { fetchImpl: async () => {
      if (++count === 1) return new Response(JSON.stringify([{ id: 'v3' }]));
      assert.strictEqual(finished, '1847'); return new Response(null, { status: 500 });
    } });
    await rejected(unreadable.deleteCheckpoint({ token, workspaceId, checkpointId: 'v3', onSessionFinished: async (id) => { finished = id; } }), 'checkpoint-delete-unconfirmed');
  });
  it('reports unsupported checkpoint deletion only after a refused route and successful inventory readback', async () => {
    for (const status of [404, 405]) {
      let calls = 0; let finished;
      const unsupported = controlAdapter({ status }, { fetchImpl: async () => {
        if (++calls === 2) assert.strictEqual(finished, '1847');
        return new Response(JSON.stringify([{ id: 'v3' }]));
      } });
      await rejected(unsupported.deleteCheckpoint({ token, workspaceId, checkpointId: 'v3',
        onSessionFinished: async (id) => { finished = id; } }), 'checkpoint-delete-unsupported');
      assert.strictEqual(calls, 2);
      let inventory = 0;
      const absent = controlAdapter({ status }, { fetchImpl: async () => new Response(JSON.stringify(++inventory === 1 ? [{ id: 'v3' }] : [])) });
      assert.deepEqual(await absent.deleteCheckpoint({ token, workspaceId, checkpointId: 'v3' }), { deleted: true, id: 'v3' });
      let reads = 0;
      const unavailable = controlAdapter({ status }, { fetchImpl: async () => ++reads === 1
        ? new Response(JSON.stringify([{ id: 'v3' }])) : new Response(null, { status: 503 }) });
      await rejected(unavailable.deleteCheckpoint({ token, workspaceId, checkpointId: 'v3' }), 'checkpoint-delete-unconfirmed');
    }
  });
  const service = (status = 'running') => ({ name: 'preview', cmd: '/usr/bin/python3', args: ['-m', 'http.server', '8080'], dir: '/workspace/site', http_port: 8080, state: { status, pid: 42 } });
  const privateSprite = () => ({ name: workspaceId, url: 'https://constellation-preview-org.sprites.app/', url_settings: { auth: 'sprite', private_access: 'admins' } });
  it('normalizes service state without returning secret environment values or raw provider errors', async () => {
    const raw = { ...service(), args: [token], env: { SECRET: token }, state: { status: 'failed', error: token } };
    const adapter = createAdapter({ fetchImpl: async (url) => new Response(JSON.stringify(url.endsWith('/services') ? { services: [raw] } : raw)) });
    const rows = await adapter.listServices({ token, workspaceId });
    assert.lengthOf(rows, 1); assert.strictEqual(rows[0].status, 'failed'); assert.strictEqual(rows[0].args[0], '[redacted]');
    assert.notInclude(JSON.stringify(rows), token); assert.notProperty(rows[0], 'env'); assert.notProperty(rows[0], 'error');
    assert.deepEqual(await adapter.getService({ token, workspaceId, name: 'preview' }), rows[0]);
  });
  it('creates and starts previews explicitly then returns observed service state', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === 'PUT') return ndjson({ type: 'started' }, { type: 'complete' });
      return new Response(JSON.stringify(url.endsWith(`/sprites/${workspaceId}`) ? privateSprite() : service('starting')));
    } });
    const saved = await adapter.saveService({ token, workspaceId, name: 'preview', command: '/usr/bin/python3', args: ['-m', 'http.server', '8080'], directory: '/workspace/site' });
    assert.strictEqual(saved.status, 'starting'); assert.strictEqual(calls[0].method, 'GET'); assert.strictEqual(calls[1].method, 'PUT');
    assert.deepEqual(JSON.parse(calls[1].body), { cmd: '/usr/bin/python3', args: ['-m', 'http.server', '8080'], dir: '/workspace/site', http_port: 8080, needs: [] });
    assert.strictEqual(new URL(calls[1].url).searchParams.get('duration'), '1s'); assert.strictEqual(calls[2].method, 'GET');
    assert.notInclude(calls[1].body, token);
  });
  it('returns only a verified private browser URL without tokens or public-mode mutations', async () => {
    const adapter = createAdapter({ fetchImpl: async (url, options) => {
      assert.strictEqual(options.method, 'GET'); return new Response(JSON.stringify(url.endsWith('/services/preview') ? service() : privateSprite()));
    } });
    const preview = await adapter.getPrivatePreview({ token, workspaceId, name: 'preview' });
    assert.deepEqual(preview, { url: privateSprite().url, auth: 'sprite', privateAccess: 'admins' });
    assert.notInclude(JSON.stringify(preview), token);
    for (const row of [{ ...privateSprite(), url_settings: { auth: 'public' } }, { ...privateSprite(), url: 'https://attacker.example/' },
      { ...privateSprite(), url: `https://constellation-preview-org.sprites.app/?token=${token}` }, { ...privateSprite(), name: 'other' },
      { ...privateSprite(), url_settings: { auth: 'sprite', private_access: 'org_users' } }]) {
      const calls = [];
      const invalid = createAdapter({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify(row)); } });
      await rejected(invalid.startService({ token, workspaceId, name: 'preview' }), 'private-preview-unavailable');
      assert.isTrue(calls.every((call) => call.method === 'GET'));
    }
  });
  it('requires terminal service receipts plus readback before confirming changes', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return options.method === 'POST' ? ndjson({ type: 'stopping' }, { type: 'stopped' }, { type: 'complete' }) : new Response(JSON.stringify(service('stopped')));
    } });
    assert.strictEqual((await adapter.stopService({ token, workspaceId, name: 'preview' })).status, 'stopped');
    assert.include(calls[0].url, '/services/preview/stop?timeout=10s'); assert.strictEqual(calls[1].method, 'GET');
    for (const result of [() => ndjson({ type: 'stopping' }), () => ndjson({ type: 'error', data: token }, { type: 'complete' })]) {
      const failed = createAdapter({ fetchImpl: async () => result() });
      await rejected(failed.stopService({ token, workspaceId, name: 'preview' }), 'service-unconfirmed');
    }
    const active = createAdapter({ fetchImpl: async (_url, options) => options.method === 'POST' ? ndjson({ type: 'complete' }) : new Response(JSON.stringify(service('running'))) });
    await rejected(active.stopService({ token, workspaceId, name: 'preview' }), 'service-unconfirmed');
  });
  it('confirms service deletion without recursive or environment destruction fallbacks', async () => {
    const calls = [];
    const adapter = createAdapter({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return options.method === 'DELETE'
      ? new Response(null, { status: 204 }) : new Response('[]'); } });
    assert.deepEqual(await adapter.deleteService({ token, workspaceId, name: 'preview' }), { deleted: true, name: 'preview' });
    assert.isTrue(calls[0].url.endsWith('/services/preview')); assert.strictEqual(calls[1].method, 'GET');
    const retained = createAdapter({ fetchImpl: async (_url, options) => options.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify([service()])) });
    await rejected(retained.deleteService({ token, workspaceId, name: 'preview' }), 'service-unconfirmed');
    const before = calls.length;
    await rejected(adapter.saveService({ token, workspaceId, name: '../preview', command: 'python3' }), 'invalid-service');
    await rejected(adapter.saveService({ token, workspaceId, name: 'preview', command: 'python3', directory: '/etc' }), 'invalid-path');
    assert.strictEqual(calls.length, before);
  });
});
