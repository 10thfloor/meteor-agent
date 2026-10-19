import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { normalizeEnvironmentPath } from '../imports/constellation/execution';

describe('Constellation environment paths', function () {
  it('accepts only bounded workspace-relative paths', () => {
    assert.strictEqual(normalizeEnvironmentPath('', true), '/workspace');
    assert.strictEqual(normalizeEnvironmentPath('results/report.csv'), '/workspace/results/report.csv');
    for (const path of ['/etc/passwd', '/workspace2/file', '../secret', 'a/../b', 'a//b', 'a\\b', 'a\nb', '/workspace']) assert.throws(() => normalizeEnvironmentPath(path));
  });
});

if (Meteor.isServer) describe('Constellation retained mission environments', function () {
  this.timeout(20000);
  let executionModule; let service; let userId; let context; let host; let adapter; let calls; let execute; let missions; let crew; let points; let previews;
  const input = (patch = {}) => ({ title: 'Count records', language: 'python', code: 'print(4)', ...patch });
  const rejected = async (promise, code) => { let error; try { await promise; } catch (failure) { error = failure; } assert.ok(error, `Expected ${code}`); assert.strictEqual(error.error, code); };
  const waitFor = async (condition) => { const until = Date.now() + 4000; while (!await condition()) { if (Date.now() > until) assert.fail('Expected state did not arrive'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  const enable = (patch = {}) => service.saveEnvironment(userId, { missionId: 'mission', keepFiles: true, allowedAgents: ['atlas'], retention: 'keep', ...patch });
  const next = (id = Random.id(), patch = {}) => service.run({ ...context, toolCallId: id }, input(patch));
  before(async () => { executionModule = await import('../server/constellation-execution'); });
  beforeEach(async () => {
    userId = `environment-test-${Random.id()}`; calls = []; points = []; previews = []; missions = new Set(['mission', 'second']); crew = new Set(['atlas', 'signal']);
    context = { userId, sessionId: 'mission', agent: 'atlas', toolCallId: 'one' };
    host = {
      requireUser: async (id) => { if (id !== userId) throw new Meteor.Error('not-authorized'); },
      CrewConfigs: { findOneAsync: async (query) => query.userId === userId && crew.has(query.agent) ? { agent: query.agent, enabled: true } : null },
      rootMissionSession: async (id) => missions.has(id === 'child' ? 'mission' : id) ? { _id: id === 'child' ? 'mission' : id, userId } : null,
      missionAllowsAgent: async (_context, agent) => crew.has(agent), requireActiveMissionExecution: async () => {},
      canStoreSecret: () => true, encryptSecret: async (_owner, token) => ({ fixture: token }), decryptSecret: async (_owner, box) => box.fixture,
      AgentAttachments: { findOneAsync: async () => null },
      Agent: { attachments: { create: async (file) => { calls.push(['artifact', file]); return { id: Random.id(), name: file.name, contentType: file.contentType, size: Buffer.from(file.content.base64, 'base64').length }; } } },
    };
    execute = async (_request, { onOutput }) => { onOutput({ stream: 'stdout', text: '4\n' }); return { exitCode: 0 }; };
    adapter = {
      testConnection: async () => {},
      inspectConnections: async () => ({ connections: [] }),
      createWorkspace: async (value) => { calls.push(['create', value]); },
      applyPolicies: async (value) => { calls.push(['policy', value]); },
      writeFile: async (value) => { calls.push(['write', value]); },
      clearOutputFiles: async (value) => { calls.push(['clear', value]); },
      readFile: async (value) => { calls.push(['export', value]); return Buffer.from('result'); },
      destroyWorkspace: async (value) => { calls.push(['destroy', value]); },
      stopExecution: async (value) => { calls.push(['stop', value]); if (!value.sessionId) throw Object.assign(new Error('No receipt'), { code: 'stop-unconfirmed' }); return { stopped: true }; },
      createSpritesProvider: (options) => ({ run: async (request, callbacks) => {
        if (options.persistent) await options.onSession(`remote-${Random.id()}`);
        calls.push(['run', request]); return execute(request, callbacks);
      } }),
      listFiles: async (value) => { calls.push(['list', value]); return [{ name: 'result.txt', path: '/workspace/result.txt', type: 'file', size: 4 }]; },
      readWorkspaceFile: async (value) => { calls.push(['download', value]); return Buffer.from('data'); },
      createCheckpoint: async (value) => { calls.push(['checkpoint', value]); const point = { id: `v${points.length + 1}`, createdAt: new Date(), comment: value.comment }; points.push(point); return point; },
      listCheckpoints: async () => points,
      getCheckpoint: async ({ checkpointId }) => points.find((point) => point.id === checkpointId),
      deleteCheckpoint: async (value) => { calls.push(['delete-point', value]); points = points.filter((point) => point.id !== value.checkpointId); return { deleted: true, id: value.checkpointId }; },
      listCheckpointFiles: async (value) => { calls.push(['historical-list', value]); return [{ name: 'result.txt', path: '/workspace/result.txt', type: 'file', size: 7 }]; },
      readCheckpointFile: async (value) => { calls.push(['historical-read', value]); return Buffer.from('earlier'); },
      restoreCheckpoint: async (value) => { calls.push(['restore', value]); return { restored: true, id: value.checkpointId }; },
      listServices: async () => previews,
      saveService: async (value) => { calls.push(['save-service', value]); const preview = { name: value.name, command: value.command, args: value.args, directory: value.directory, httpPort: value.httpPort, status: 'running', env: { secret: 'never-publish' } }; previews = [...previews.filter((item) => item.name !== preview.name), preview]; return preview; },
      startService: async (value) => { calls.push(['start-service', value]); const preview = previews.find((item) => item.name === value.name); preview.status = 'running'; return preview; },
      stopService: async (value) => { calls.push(['stop-service', value]); const preview = previews.find((item) => item.name === value.name); preview.status = 'stopped'; return preview; },
      deleteService: async (value) => { calls.push(['delete-service', value]); previews = previews.filter((item) => item.name !== value.name); return { deleted: true }; },
      getPrivatePreview: async () => ({ url: 'https://mission-fixture.sprites.app/', auth: 'sprite', privateAccess: 'admins' }),
    };
    service = executionModule.createConstellationExecutionService(host, { adapter, pollMs: 10 });
    await service.saveSettings(userId, { enabled: true, token: 'environment-fixture-token' }); await service.testConnection(userId);
    await service.setAgentPolicy(userId, { agent: 'atlas', policy: { run: 'auto' } });
    await service.setAgentPolicy(userId, { agent: 'signal', policy: { run: 'auto' } });
  });
  afterEach(async () => { for (const collection of [executionModule.ExecutionEnvironments, executionModule.ExecutionSettings, executionModule.ExecutionSecrets, executionModule.ExecutionJobs, executionModule.ExecutionBudgets]) await collection.removeAsync({ userId }); });

  it('saves opt-in settings without allocating, and requires explicit crew grants', async () => {
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).keepFiles, false);
    await enable({ allowedAgents: [] }); assert.isEmpty(calls);
    await rejected(next(), 'execution-environment-access');
    await enable();
    await rejected(service.run({ ...context, agent: 'signal' }, input()), 'execution-environment-access');
    await rejected(service.getEnvironment('foreign', { missionId: 'mission' }), 'not-authorized');
    await rejected(enable({ allowedAgents: ['missing'] }), 'execution-environment-agent');
    await rejected(enable({ missionId: 'child' }), 'execution-environment-mission');
    await service.setAgentPolicy(userId, { agent: 'atlas', policy: { run: 'disabled' } }); await rejected(next(), 'execution-access-off');
    assert.isFalse(calls.some(([kind]) => kind === 'create'));
  });

  it('reuses one mission workspace with unique run paths and fresh requested outputs', async () => {
    await enable(); const first = await next('one', { outputPaths: ['report.csv'] }); const second = await next('two', { outputPaths: ['report.csv'] });
    assert.strictEqual(first.status, 'completed'); assert.strictEqual(first.workspaceMode, 'retained'); assert.strictEqual(second.status, 'completed');
    assert.lengthOf(calls.filter(([kind]) => kind === 'create'), 1); assert.lengthOf(calls.filter(([kind]) => kind === 'destroy'), 0);
    const runs = calls.filter(([kind]) => kind === 'run').map(([, value]) => value);
    assert.strictEqual(runs[0].workspaceId, runs[1].workspaceId); assert.notStrictEqual(runs[0].command[1], runs[1].command[1]);
    assert.match(runs[0].command[1], /^\/workspace\/runs\/execution-[a-f0-9]+\/main.py$/);
    assert.deepEqual(calls.filter(([kind]) => kind === 'clear').map(([, value]) => value.paths), [['/workspace/outputs/report.csv'], ['/workspace/outputs/report.csv']]);
    const env = await service.getEnvironment(userId, { missionId: 'mission' }); assert.strictEqual(env.status, 'ready'); assert.notProperty(env, 'credentialHash'); assert.notProperty(env, 'remoteSessionId');
    assert.isTrue(await service.missionExecutionsQuiescent(userId, 'mission'));
    await enable({ missionId: 'second' }); await service.run({ ...context, sessionId: 'second', toolCallId: 'third' }, input());
    assert.notStrictEqual((await service.getEnvironment(userId, { missionId: 'second' })).workspaceId, env.workspaceId);
  });

  it('queues writers visibly and cancels a queued request without executing it', async () => {
    await enable(); let finish;
    execute = async () => new Promise((resolve) => { finish = resolve; });
    const first = next('first'); await waitFor(() => calls.some(([kind]) => kind === 'run'));
    const second = next('second'); await waitFor(async () => (await service.history(userId)).some((job) => job.toolCallId === 'second' && job.status === 'queued'));
    const queued = (await service.history(userId)).find((job) => job.toolCallId === 'second'); await service.stop(userId, { jobId: queued._id });
    assert.strictEqual((await second).status, 'cancelled'); assert.lengthOf(calls.filter(([kind]) => kind === 'run'), 1);
    finish({ exitCode: 0 }); await first;
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('queues selected Sprite inputs and reads bytes only after acquiring the run lease', async () => {
    await enable(); let finish; let executions = 0; let reads = 0;
    host.AgentAttachments.findOneAsync = async () => ({ _id: 'selected', sessionId: 'mission', name: 'input.txt', size: 4 });
    host.Agent.attachments.readContent = async () => {
      reads += 1;
      const environment = await service.getEnvironment(userId, { missionId: 'mission' });
      const current = (await service.history(userId)).find((job) => job._id === environment.currentJobId);
      assert.equal(current?.toolCallId, 'with-input');
      return Buffer.from('data').toString('base64');
    };
    execute = async () => { executions += 1; return executions === 1 ? new Promise((resolve) => { finish = resolve; }) : { exitCode: 0 }; };
    const first = next('blocks-input'); let second;
    try {
      await waitFor(() => calls.some(([kind]) => kind === 'run'));
      second = next('with-input', { inputAttachmentIds: ['selected'] });
      await waitFor(async () => (await service.history(userId)).some((job) => job.toolCallId === 'with-input' && job.status === 'queued'));
      assert.equal(reads, 0, 'reservation must never wake or read the busy Sprite');
      finish({ exitCode: 0 }); await first;
      assert.equal((await second).status, 'completed'); assert.equal(reads, 1);
      const uploaded = calls.find(([kind, request]) => kind === 'write' && request.path.endsWith('-input.txt'));
      assert.equal(Buffer.from(uploaded[1].content).toString(), 'data');
    } finally { finish?.({ exitCode: 0 }); await first; if (second) await second; }
  });

  it('rechecks connected API grants after a retained run leaves the queue', async () => {
    await enable(); let finish;
    execute = async () => new Promise((resolve) => { finish = resolve; });
    const first = next('connector-first'); let second;
    try {
      await waitFor(() => calls.some(([kind]) => kind === 'run'));
      second = next('connector-queued');
      await waitFor(async () => (await service.history(userId)).some((job) => job.toolCallId === 'connector-queued' && job.status === 'queued'));
      adapter.inspectConnections = async () => ({ connections: [{ id: 'new-connection', provider: 'github', name: 'New grant', scopes: 'repo', policy: { allowAll: true } }] });
      finish({ exitCode: 0 }); await first;
      const blocked = await second;
      assert.strictEqual(blocked.status, 'failed');
      const job = (await service.history(userId)).find((row) => row.toolCallId === 'connector-queued');
      assert.strictEqual(job.error.code, 'execution-connections-review');
      assert.lengthOf(calls.filter(([kind]) => kind === 'run'), 1);
      assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'ready');
    } finally { finish?.({ exitCode: 0 }); await first; if (second) await second; }
  });

  it('serializes queued writers and keeps files after a confirmed stop', async () => {
    await enable(); execute = async (_request, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true }));
    const run = next(); await waitFor(() => calls.some(([kind]) => kind === 'run'));
    const job = (await service.history(userId))[0]; await service.stop(userId, { jobId: job._id }); assert.strictEqual((await run).status, 'cancelled');
    assert.isFalse(calls.some(([kind]) => kind === 'destroy')); assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('quarantines unconfirmed stops even after cancellation and reconciles only the recorded execution', async () => {
    await enable(); execute = async (_request, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('provider private details'), { code: 'stop-unconfirmed' })), { once: true }));
    const run = next(); await waitFor(() => calls.some(([kind]) => kind === 'run'));
    await service.stop(userId, { jobId: (await service.history(userId))[0]._id }); const result = await run;
    assert.strictEqual(result.status, 'unknown'); assert.isFalse(result.cleanupPending); assert.isFalse(calls.some(([kind]) => kind === 'destroy'));
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'needs-attention');
    assert.isFalse(await service.missionExecutionsQuiescent(userId, 'mission')); await rejected(next(), 'execution-environment-attention');
    const env = await service.reconcileEnvironment(userId, { missionId: 'mission' }); assert.strictEqual(env.status, 'ready');
    assert.match(calls.find(([kind]) => kind === 'stop')[1].sessionId, /^remote-/);
  });

  it('does not strand confirmed environments when exporting a missing output fails', async () => {
    await enable(); adapter.readFile = async () => { throw new Error('Output missing'); };
    const result = await next('missing-output', { outputPaths: ['missing.csv'] }); assert.strictEqual(result.status, 'failed');
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'ready');
    assert.strictEqual((await next()).status, 'completed'); assert.isFalse(calls.some(([kind]) => kind === 'stop'));
  });

  it('revokes retained-file access during a live run', async () => {
    await enable(); execute = async (_request, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true }));
    const run = next(); await waitFor(() => calls.some(([kind]) => kind === 'run'));
    await enable({ allowedAgents: [] }); assert.strictEqual((await run).status, 'cancelled'); assert.isFalse(calls.some(([kind]) => kind === 'destroy'));
  });

  it('keeps saved files when disabled and uses disposable workspaces for future runs', async () => {
    await enable(); await next(); const prior = await service.getEnvironment(userId, { missionId: 'mission' });
    await enable({ keepFiles: false }); const result = await next(); assert.strictEqual(result.workspaceMode, 'disposable');
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).workspaceId, prior.workspaceId);
    assert.deepEqual(calls.filter(([kind]) => kind === 'destroy').map(([, value]) => value.workspaceId.startsWith('constellation-run-')), [true]);
  });

  it('binds retained files to the original credential but allows saving the same token', async () => {
    await enable(); await next(); await rejected(service.saveSettings(userId, { token: 'different-token' }), 'execution-environment-token');
    assert.strictEqual((await service.saveSettings(userId, { token: 'environment-fixture-token' })).connectionStatus, 'connected');
    await service.deleteEnvironment(userId, { missionId: 'mission', confirm: true });
    assert.strictEqual((await service.saveSettings(userId, { token: 'different-token' })).connectionStatus, 'untested');
  });

  it('never reuses a remote workspace name after deletion', async () => {
    await enable(); await next(); const original = (await service.getEnvironment(userId, { missionId: 'mission' })).workspaceId;
    await service.deleteEnvironment(userId, { missionId: 'mission', confirm: true }); await enable(); await next();
    const replacement = (await service.getEnvironment(userId, { missionId: 'mission' })).workspaceId;
    assert.notStrictEqual(replacement, original); assert.match(replacement, /^constellation-mission-[a-f0-9]{32}$/);
    assert.strictEqual(calls.filter(([kind]) => kind === 'run').at(-1)[1].workspaceId, replacement);
  });

  it('updates network restrictions on idle retained environments and quarantines failed updates', async () => {
    await enable(); await next(); await service.saveSettings(userId, { domains: ['example.com'] });
    assert.deepEqual(calls.filter(([kind]) => kind === 'policy').at(-1)[1].domains, ['example.com']);
    adapter.applyPolicies = async () => { throw new Error('private transport details'); }; await service.saveSettings(userId, { domains: [] });
    const env = await service.getEnvironment(userId, { missionId: 'mission' }); assert.strictEqual(env.status, 'needs-attention'); assert.strictEqual(env.recoveryKind, 'policies');
    adapter.applyPolicies = async () => {}; assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
    assert.isFalse(calls.some(([kind]) => kind === 'stop'));
  });

  it('browses only owned bounded files and serializes browsing with runs', async () => {
    await enable(); await next(); assert.lengthOf((await service.environmentFiles(userId, { missionId: 'mission' })).entries, 1);
    const file = await service.readEnvironmentFile(userId, { missionId: 'mission', path: 'result.txt' }); assert.strictEqual(Buffer.from(file.content, 'base64').toString(), 'data');
    await rejected(service.environmentFiles('foreign', { missionId: 'mission' }), 'not-authorized');
    adapter.readWorkspaceFile = async () => Buffer.alloc(5000001); await rejected(service.readEnvironmentFile(userId, { missionId: 'mission', path: 'large' }), 'execution-environment-file-limit');
    execute = async (_request, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true }));
    const run = next(); await waitFor(async () => (await service.history(userId)).some((job) => job.status === 'running'));
    await rejected(service.environmentFiles(userId, { missionId: 'mission' }), 'execution-environment-busy');
    await service.stop(userId, { jobId: (await service.history(userId)).find((job) => job.status === 'running')._id }); await run;
  });

  it('requires restore confirmation and records a safety save point before restoring', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Before analysis' });
    await rejected(service.restoreSavePoint(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id }), 'execution-confirm-required');
    const restored = await service.restoreSavePoint(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, confirm: true });
    assert.lengthOf(restored.savePoints, 2); assert.strictEqual(restored.savePoints[1].label, 'Before restore: Before analysis');
    assert.deepEqual(calls.filter(([kind]) => ['checkpoint', 'restore'].includes(kind)).map(([kind]) => kind), ['checkpoint', 'checkpoint', 'restore']);
    assert.match(calls.find(([kind]) => kind === 'checkpoint')[1].comment, /^constellation:/);
    assert.strictEqual((await service.history(userId))[0].status, 'completed');
  });

  it('checks current connected API grants before a restore or its safety save point', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Before restart' });
    const before = calls.filter(([kind]) => kind === 'checkpoint').length; let inspectedToken;
    adapter.inspectConnections = async ({ token }) => {
      inspectedToken = token;
      return { connections: [{ id: 'expanded', provider: 'github', name: 'New authority', scopes: 'repo' }] };
    };
    await rejected(service.restoreSavePoint(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, confirm: true }), 'execution-connections-review');
    assert.strictEqual(inspectedToken, 'environment-fixture-token');
    assert.strictEqual(calls.filter(([kind]) => kind === 'checkpoint').length, before); assert.isFalse(calls.some(([kind]) => kind === 'restore'));
    const env = await service.getEnvironment(userId, { missionId: 'mission' });
    assert.strictEqual(env.status, 'ready'); assert.lengthOf(env.savePoints, 1); assert.notProperty(env, 'restoreRequestedAt');
  });

  it('recovers a lost checkpoint receipt without creating a second checkpoint', async () => {
    await enable(); await next(); const create = adapter.createCheckpoint;
    adapter.createCheckpoint = async (value) => { await create(value); throw Object.assign(new Error('lost receipt'), { code: 'checkpoint-unconfirmed' }); };
    let caught; try { await service.savePoint(userId, { missionId: 'mission', label: 'Recovery' }); } catch (error) { caught = error; } assert.ok(caught);
    const restored = await service.reconcileEnvironment(userId, { missionId: 'mission' }); assert.strictEqual(restored.status, 'ready'); assert.strictEqual(restored.savePoints[0].label, 'Recovery');
    assert.lengthOf(calls.filter(([kind]) => kind === 'checkpoint'), 1);
  });

  it('does not treat a lost restore as idle or replay it, but permits recovery downloads', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Safe' });
    adapter.restoreCheckpoint = async (value) => { calls.push(['restore', value]); throw Object.assign(new Error('lost restore'), { code: 'restore-unconfirmed' }); };
    try { await service.restoreSavePoint(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, confirm: true }); } catch {}
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'needs-attention');
    assert.lengthOf((await service.environmentFiles(userId, { missionId: 'mission' })).entries, 1);
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'needs-attention');
    assert.lengthOf(calls.filter(([kind]) => kind === 'restore'), 1); assert.isFalse(calls.some(([kind]) => kind === 'stop'));
  });

  it('keeps environments by default and performs configured completion cleanup without erasing history', async () => {
    await enable(); await next(); await service.onMissionCompleted(userId, 'mission'); assert.isFalse(calls.some(([kind]) => kind === 'destroy'));
    await enable({ retention: 'delete-on-completion' }); await service.onMissionCompleted(userId, 'mission');
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'not-created'); assert.lengthOf(await service.history(userId), 1);
    await enable({ retention: 'delete-on-completion' }); await next(); adapter.destroyWorkspace = async () => { throw new Error('lost delete'); };
    await service.onMissionCompleted(userId, 'mission'); assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'needs-attention');
  });

  it('preserves a shared environment when a child chat is erased and keeps root cleanup owner-accessible', async () => {
    await enable(); await next(); await service.scrubSession('child'); assert.isFalse(calls.some(([kind]) => kind === 'destroy'));
    adapter.destroyWorkspace = async () => { throw new Error('lost delete'); }; missions.delete('mission'); await service.scrubSession('mission');
    const env = await service.getEnvironment(userId, { missionId: 'mission' }); assert.ok(env.erasedAt); assert.isEmpty(env.allowedAgents); assert.isEmpty(env.savePoints);
    await rejected(service.environmentFiles(userId, { missionId: 'mission' }), 'execution-mission-unavailable');
    adapter.destroyWorkspace = async (value) => calls.push(['destroy', value]); await service.deleteEnvironment(userId, { missionId: 'mission', confirm: true });
    assert.isUndefined(await executionModule.ExecutionEnvironments.findOneAsync({ userId, missionId: 'mission' }));
  });

  it('quarantines interrupted runs after restart without replaying or deleting retained files', async () => {
    await enable(); const result = await next(); const env = await executionModule.ExecutionEnvironments.findOneAsync({ userId });
    await executionModule.ExecutionEnvironments.updateAsync(env._id, { $set: { status: 'busy', operationId: result.runId, operationKind: 'run', remoteSessionId: 'recorded-session' } });
    await executionModule.ExecutionJobs.updateAsync(result.runId, { $set: { status: 'running' } });
    await service.recover({ userId }); assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'needs-attention');
    assert.strictEqual((await service.history(userId))[0].status, 'unknown'); assert.lengthOf(calls.filter(([kind]) => kind === 'run'), 1); assert.isFalse(calls.some(([kind]) => kind === 'destroy'));
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('does not quarantine an environment when save-point preflight fails', async () => {
    await enable(); await next(); const env = await executionModule.ExecutionEnvironments.findOneAsync({ userId });
    const full = Array.from({ length: 50 }, (_, index) => ({ id: `v${index + 1}`, label: `Point ${index}`, createdAt: new Date() }));
    await executionModule.ExecutionEnvironments.updateAsync(env._id, { $set: { savePoints: full } });
    await rejected(service.savePoint(userId, { missionId: 'mission', label: 'Over capacity' }), 'execution-save-point-limit');
    await rejected(service.restoreSavePoint(userId, { missionId: 'mission', savePointId: 'v1', confirm: true }), 'execution-save-point-limit');
    await rejected(service.restoreSavePoint(userId, { missionId: 'mission', savePointId: 'missing', confirm: true }), 'execution-save-point-missing');
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'ready');
    assert.isFalse(calls.some(([kind]) => kind === 'checkpoint' || kind === 'restore'));
  });

  it('requires confirmation to delete a save point and frees its local capacity only after remote confirmation', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Delete me' }); const id = saved.savePoints[0].id;
    await rejected(service.deleteSavePoint(userId, { missionId: 'mission', savePointId: id }), 'execution-confirm-required');
    await rejected(service.deleteSavePoint('foreign', { missionId: 'mission', savePointId: id, confirm: true }), 'not-authorized');
    const deleted = await service.deleteSavePoint(userId, { missionId: 'mission', savePointId: id, confirm: true }); assert.isEmpty(deleted.savePoints); assert.isEmpty(points); assert.strictEqual(deleted.status, 'ready');
    assert.lengthOf(calls.filter(([kind]) => kind === 'delete-point'), 1);
  });

  it('disables unsupported save-point deletion without quarantining restore or file access', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Keep' }); const id = saved.savePoints[0].id;
    let attempts = 0;
    adapter.deleteCheckpoint = async ({ onSession, onSessionFinished }) => {
      attempts += 1; await onSession('unsupported-delete-helper'); await onSessionFinished('unsupported-delete-helper');
      throw Object.assign(new Error('local delete unsupported'), { code: 'checkpoint-delete-unsupported' });
    };
    await rejected(service.deleteSavePoint(userId, { missionId: 'mission', savePointId: id, confirm: true }), 'execution-checkpoint-delete-unsupported');
    let env = await service.getEnvironment(userId, { missionId: 'mission' });
    assert.strictEqual(env.status, 'ready'); assert.isFalse(env.checkpointDeletionSupported); assert.lengthOf(env.savePoints, 1); assert.notProperty(env, 'checkpointDeletion');
    await rejected(service.deleteSavePoint(userId, { missionId: 'mission', savePointId: id, confirm: true }), 'execution-checkpoint-delete-unsupported'); assert.strictEqual(attempts, 1);
    assert.lengthOf((await service.environmentFiles(userId, { missionId: 'mission', savePointId: id })).entries, 1);
    assert.strictEqual((await service.restoreSavePoint(userId, { missionId: 'mission', savePointId: id, confirm: true })).status, 'ready');
    await service.deleteEnvironment(userId, { missionId: 'mission', confirm: true });
    env = await service.getEnvironment(userId, { missionId: 'mission' }); assert.notProperty(env, 'checkpointDeletionSupported');
    await enable(); await next(); assert.notProperty(await service.getEnvironment(userId, { missionId: 'mission' }), 'checkpointDeletionSupported');
  });

  it('preserves an earlier uncertain deletion receipt when deletion is unsupported', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Keep' }); const id = saved.savePoints[0].id;
    const receipt = { id, requestedAt: new Date(), clearsAttempt: false };
    await executionModule.ExecutionEnvironments.updateAsync({ userId }, { $set: { status: 'needs-attention', recoveryKind: 'checkpoint-delete', checkpointDeletion: receipt } });
    adapter.deleteCheckpoint = async () => { throw Object.assign(new Error('unsupported'), { code: 'checkpoint-delete-unsupported' }); };
    await rejected(service.deleteSavePoint(userId, { missionId: 'mission', savePointId: id, confirm: true }), 'execution-checkpoint-delete-unsupported');
    const row = await executionModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(row.status, 'needs-attention'); assert.isFalse(row.checkpointDeletionSupported); assert.deepEqual(row.checkpointDeletion, receipt);
  });

  it('reconciles an uncertain checkpoint deletion without issuing another destructive request', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Delete me' });
    adapter.deleteCheckpoint = async () => { calls.push(['delete-point']); points = []; throw Object.assign(new Error('lost response'), { code: 'checkpoint-delete-unconfirmed' }); };
    try { await service.deleteSavePoint(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, confirm: true }); } catch {}
    const env = await service.reconcileEnvironment(userId, { missionId: 'mission' }); assert.isEmpty(env.savePoints); assert.strictEqual(env.status, 'ready');
    assert.lengthOf(calls.filter(([kind]) => kind === 'delete-point'), 1);
  });

  it('rejects unhealthy checkpoint receipts and exposes their actual health for recovery', async () => {
    await enable(); await next(); const create = adapter.createCheckpoint;
    adapter.createCheckpoint = async (value) => { const point = await create(value); point.health = 'corrupt'; throw Object.assign(new Error('unhealthy checkpoint'), { code: 'checkpoint-unhealthy' }); };
    try { await service.savePoint(userId, { missionId: 'mission', label: 'Failed point' }); } catch {}
    let env = await service.reconcileEnvironment(userId, { missionId: 'mission' }); assert.strictEqual(env.status, 'needs-attention'); assert.isEmpty(env.savePoints);
    env = await service.refreshSavePoints(userId, { missionId: 'mission' }); assert.strictEqual(env.savePoints[0].healthy, false);
    await rejected(service.restoreSavePoint(userId, { missionId: 'mission', savePointId: env.savePoints[0].id, confirm: true }), 'execution-save-point-unavailable');
    await service.deleteSavePoint(userId, { missionId: 'mission', savePointId: env.savePoints[0].id, confirm: true });
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('clears every old restore marker when replacing an environment generation', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Safe' });
    adapter.restoreCheckpoint = async () => { throw Object.assign(new Error('lost response'), { code: 'restore-unconfirmed' }); };
    try { await service.restoreSavePoint(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, confirm: true }); } catch {}
    assert.ok((await executionModule.ExecutionEnvironments.findOneAsync({ userId })).restoreRequestedAt);
    await service.deleteEnvironment(userId, { missionId: 'mission', confirm: true }); await enable(); await next();
    const replacement = await executionModule.ExecutionEnvironments.findOneAsync({ userId }); assert.notProperty(replacement, 'restoreRequestedAt'); assert.notProperty(replacement, 'restoreTarget');
    await executionModule.ExecutionEnvironments.updateAsync(replacement._id, { $set: { status: 'needs-attention', recoveryKind: 'run', remoteSessionId: 'new-generation-session' } });
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('reads historical files without restoring or overwriting the live workspace', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Earlier' }); const savePointId = saved.savePoints[0].id;
    assert.strictEqual((await service.environmentFiles(userId, { missionId: 'mission', savePointId })).entries[0].name, 'result.txt');
    const file = await service.readEnvironmentFile(userId, { missionId: 'mission', savePointId, path: '/workspace/result.txt' }); assert.strictEqual(Buffer.from(file.content, 'base64').toString(), 'earlier');
    const writes = calls.filter(([kind]) => kind === 'write').length;
    const recovered = await service.recoverEnvironmentFile(userId, { missionId: 'mission', savePointId, path: '/workspace/result.txt' });
    assert.strictEqual(recovered.sessionId, 'mission'); assert.ok(recovered.artifact.id); assert.strictEqual(recovered.sourcePath, '/workspace/result.txt');
    assert.lengthOf(calls.filter(([kind]) => kind === 'write'), writes); assert.isFalse(calls.some(([kind]) => kind === 'restore'));
    assert.strictEqual(calls.filter(([kind]) => kind === 'artifact').at(-1)[1].attach, false);
    await rejected(service.recoverEnvironmentFile('foreign', { missionId: 'mission', savePointId, path: '/workspace/result.txt' }), 'not-authorized');
    adapter.readCheckpointFile = async () => { throw Object.assign(new Error('missing mount'), { code: 'checkpoint-unavailable' }); };
    await rejected(service.readEnvironmentFile(userId, { missionId: 'mission', savePointId, path: '/workspace/result.txt' }), 'execution-checkpoint-unavailable');
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('saves preview configuration locally and starts, stops, and deletes only on explicit owner actions', async () => {
    await enable(); await next(); const config = { missionId: 'mission', name: 'web', command: 'python3', args: ['-m', 'http.server', '8080'], directory: '/workspace', httpPort: 8080 };
    const draft = await service.savePreview(userId, config); assert.strictEqual(draft.status, 'not-started'); assert.isTrue(draft.pendingChanges); assert.isFalse(calls.some(([kind]) => kind === 'save-service'));
    const running = await service.startPreview(userId, { missionId: 'mission', name: 'web' }); assert.strictEqual(running.status, 'running'); assert.notProperty(running, 'env');
    assert.notInclude(JSON.stringify(await service.listPreviews(userId, { missionId: 'mission' })), 'never-publish');
    const link = await service.privatePreview(userId, { missionId: 'mission', name: 'web' }); assert.deepEqual(link, { url: 'https://mission-fixture.sprites.app/', auth: 'sprite', privateAccess: 'admins' });
    assert.strictEqual((await service.stopPreview(userId, { missionId: 'mission', name: 'web' })).status, 'stopped');
    await rejected(service.deletePreview(userId, { missionId: 'mission', name: 'web' }), 'execution-confirm-required');
    await rejected(service.startPreview('foreign', { missionId: 'mission', name: 'web' }), 'not-authorized');
    await service.deletePreview(userId, { missionId: 'mission', name: 'web', confirm: true }); assert.isEmpty(await service.listPreviews(userId, { missionId: 'mission' }));
    assert.isFalse(calls.some(([kind]) => kind === 'restore' || kind === 'destroy'));
  });

  it('never returns public preview URLs or token-bearing links', async () => {
    await enable(); await next(); await service.savePreview(userId, { missionId: 'mission', name: 'web', command: 'node', args: ['server.js'] });
    for (const value of [
      { url: 'https://mission-fixture.sprites.app', auth: 'public', privateAccess: 'admins' },
      { url: 'https://mission-fixture.sprites.app/?token=private', auth: 'sprite', privateAccess: 'admins' },
      { url: 'https://outside.example', auth: 'sprite', privateAccess: 'admins' },
    ]) {
      adapter.getPrivatePreview = async () => value;
      await rejected(service.privatePreview(userId, { missionId: 'mission', name: 'web' }), 'execution-preview-private');
    }
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('checks current connected API grants before issuing a private preview link', async () => {
    await enable(); await next(); await service.savePreview(userId, { missionId: 'mission', name: 'web', command: 'node', args: ['server.js'] });
    await service.startPreview(userId, { missionId: 'mission', name: 'web' });
    let links = 0; const getLink = adapter.getPrivatePreview;
    adapter.getPrivatePreview = async (request) => { links += 1; return getLink(request); };
    await service.privatePreview(userId, { missionId: 'mission', name: 'web' }); assert.strictEqual(links, 1);
    adapter.inspectConnections = async () => ({ connections: [{ id: 'changed', provider: 'github', name: 'Expanded access', scopes: 'repo' }] });
    await rejected(service.privatePreview(userId, { missionId: 'mission', name: 'web' }), 'execution-connections-review');
    assert.strictEqual(links, 1); assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('observes an ambiguous preview start before allowing another explicit change', async () => {
    await enable(); await next(); await service.savePreview(userId, { missionId: 'mission', name: 'web', command: 'node', args: ['server.js'] });
    const start = adapter.saveService; adapter.saveService = async (value) => { await start(value); throw new Error('lost service receipt'); };
    try { await service.startPreview(userId, { missionId: 'mission', name: 'web' }); } catch {}
    assert.strictEqual((await service.getEnvironment(userId, { missionId: 'mission' })).status, 'needs-attention');
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
    assert.lengthOf(calls.filter(([kind]) => kind === 'save-service'), 1);
  });

  it('keeps an uncertain preview target until reconciliation or same-target cleanup', async () => {
    await enable(); await next();
    for (const name of ['first', 'second']) await service.savePreview(userId, { missionId: 'mission', name, command: 'node', args: ['server.js'] });
    const start = adapter.saveService; adapter.saveService = async (request) => { await start(request); throw new Error('lost service receipt'); };
    try { await service.startPreview(userId, { missionId: 'mission', name: 'first' }); } catch {}
    await rejected(service.stopPreview(userId, { missionId: 'mission', name: 'second' }), 'execution-environment-attention');
    assert.strictEqual((await executionModule.ExecutionEnvironments.findOneAsync({ userId })).previewOperation.name, 'first');
    assert.isFalse(calls.some(([kind]) => kind === 'stop-service'));
    // Local status is still not-started, but the uncertain provider start must
    // be stopped remotely rather than dismissed as an untouched draft.
    await service.stopPreview(userId, { missionId: 'mission', name: 'first' });
    assert.deepEqual(calls.filter(([kind]) => kind === 'stop-service').map(([, request]) => request.name), ['first']);
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('preserves uncertain checkpoint deletion until same-target cleanup is confirmed', async () => {
    await enable(); await next(); await service.savePoint(userId, { missionId: 'mission', label: 'First' });
    const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Second' });
    const [first, second] = saved.savePoints;
    const remove = adapter.deleteCheckpoint; adapter.deleteCheckpoint = async () => { throw new Error('lost delete receipt'); };
    try { await service.deleteSavePoint(userId, { missionId: 'mission', savePointId: first.id, confirm: true }); } catch {}
    await rejected(service.deleteSavePoint(userId, { missionId: 'mission', savePointId: second.id, confirm: true }), 'execution-environment-attention');
    assert.strictEqual((await executionModule.ExecutionEnvironments.findOneAsync({ userId })).checkpointDeletion.id, first.id);
    adapter.deleteCheckpoint = async () => { throw Object.assign(new Error('current checkpoint'), { code: 'checkpoint-current' }); };
    await rejected(service.deleteSavePoint(userId, { missionId: 'mission', savePointId: first.id, confirm: true }), 'execution-checkpoint-current');
    assert.strictEqual((await executionModule.ExecutionEnvironments.findOneAsync({ userId })).checkpointDeletion.id, first.id);
    adapter.deleteCheckpoint = remove;
    await service.deleteSavePoint(userId, { missionId: 'mission', savePointId: first.id, confirm: true });
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
  });

  it('persists historical helper receipts and quarantines unconfirmed read termination', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Earlier' });
    adapter.readCheckpointFile = async ({ onSession }) => { await onSession('historical-helper'); throw Object.assign(new Error('stop uncertain'), { code: 'stop-unconfirmed' }); };
    try { await service.readEnvironmentFile(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, path: '/workspace/result.txt' }); } catch {}
    const row = await executionModule.ExecutionEnvironments.findOneAsync({ userId }); assert.strictEqual(row.status, 'needs-attention'); assert.strictEqual(row.recoveryKind, 'helper'); assert.strictEqual(row.helperSessionId, 'historical-helper');
    assert.notProperty(await service.getEnvironment(userId, { missionId: 'mission' }), 'helperSessionId');
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
    assert.strictEqual(calls.find(([kind]) => kind === 'stop')[1].sessionId, 'historical-helper');
  });

  it('preserves the original unknown run receipt when a historical read finishes', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Earlier' });
    await executionModule.ExecutionEnvironments.updateAsync({ userId }, { $set: { status: 'needs-attention', recoveryKind: 'run', remoteSessionId: 'original-run' } });
    adapter.readCheckpointFile = async ({ onSession, onSessionFinished }) => { await onSession('historical-helper'); await onSessionFinished('historical-helper'); return Buffer.from('earlier'); };
    await service.readEnvironmentFile(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, path: '/workspace/result.txt' });
    const row = await executionModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(row.status, 'needs-attention'); assert.strictEqual(row.recoveryKind, 'run'); assert.strictEqual(row.remoteSessionId, 'original-run'); assert.notProperty(row, 'helperSessionId');
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
    assert.deepEqual(calls.filter(([kind]) => kind === 'stop').map(([, request]) => request.sessionId), ['original-run']);
  });

  it('reconciles failed network updates after a historical helper has already finished', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Earlier' });
    let finishRead; let failPolicy; let policy;
    adapter.readCheckpointFile = async ({ onSession, onSessionFinished }) => {
      await onSession('finishing-helper'); await new Promise((resolve) => { finishRead = resolve; });
      await onSessionFinished('finishing-helper'); return Buffer.from('earlier');
    };
    const read = service.readEnvironmentFile(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, path: '/workspace/result.txt' });
    try {
      await waitFor(() => !!finishRead);
      const apply = adapter.applyPolicies;
      adapter.applyPolicies = async () => new Promise((_resolve, reject) => { failPolicy = () => reject(new Error('policy response lost')); });
      policy = service.saveSettings(userId, { domains: ['example.com'] });
      await waitFor(() => !!failPolicy);
      finishRead(); await read;
      failPolicy(); await policy; adapter.applyPolicies = apply;
      const row = await executionModule.ExecutionEnvironments.findOneAsync({ userId });
      assert.strictEqual(row.status, 'needs-attention'); assert.notProperty(row, 'helperSessionId'); assert.notStrictEqual(row.recoveryKind, 'helper');
      assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
      assert.isFalse(calls.some(([kind]) => kind === 'stop'));
    } finally { finishRead?.(); failPolicy?.(); await read; if (policy) await policy; }
  });

  it('reconciles an unfinished recovery helper without losing the original run target', async () => {
    await enable(); await next(); const saved = await service.savePoint(userId, { missionId: 'mission', label: 'Earlier' });
    await executionModule.ExecutionEnvironments.updateAsync({ userId }, { $set: { status: 'needs-attention', recoveryKind: 'run', remoteSessionId: 'original-run' } });
    adapter.readCheckpointFile = async ({ onSession }) => { await onSession('historical-helper'); throw Object.assign(new Error('stop uncertain'), { code: 'stop-unconfirmed' }); };
    try { await service.readEnvironmentFile(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, path: '/workspace/result.txt' }); } catch {}
    let row = await executionModule.ExecutionEnvironments.findOneAsync({ userId });
    assert.strictEqual(row.remoteSessionId, 'original-run'); assert.strictEqual(row.helperSessionId, 'historical-helper'); assert.strictEqual(row.helperPreviousRecoveryKind, 'run');
    await rejected(service.readEnvironmentFile(userId, { missionId: 'mission', savePointId: saved.savePoints[0].id, path: '/workspace/result.txt' }), 'execution-environment-attention');
    assert.strictEqual((await service.reconcileEnvironment(userId, { missionId: 'mission' })).status, 'ready');
    assert.deepEqual(calls.filter(([kind]) => kind === 'stop').map(([, request]) => request.sessionId), ['historical-helper', 'original-run']);
    row = await executionModule.ExecutionEnvironments.findOneAsync({ userId }); assert.notProperty(row, 'helperSessionId'); assert.notProperty(row, 'remoteSessionId');
  });
});
