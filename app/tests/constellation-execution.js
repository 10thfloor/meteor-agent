import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { normalizeExecutionInput, normalizeExecutionDomains, normalizeExecutionLimits, normalizeExecutionPolicy, executionToolAccess } from '../imports/constellation/execution';

const sample = (patch = {}) => ({ title: 'Count records', language: 'python', code: 'print(2 + 2)', ...patch });
describe('Constellation execution validation', function () {
  it('uses disabled access, bounded limits, and exact deny-by-default network rules', () => {
    assert.deepEqual(normalizeExecutionPolicy(), { run: 'disabled' }); assert.deepEqual(normalizeExecutionDomains(), []);
    assert.deepEqual(normalizeExecutionDomains(['api.github.com', 'API.GITHUB.COM']), ['api.github.com']);
    for (const domain of ['*', '*.github.com', 'https://github.com', '127.0.0.1', 'localhost', 'a.internal', 'github.com:443']) assert.throws(() => normalizeExecutionDomains([domain]));
    assert.throws(() => normalizeExecutionLimits({ timeoutSeconds: 301 })); assert.throws(() => normalizeExecutionLimits({ maxRunsPerMission: 0 }));
  });
  it('rejects host paths and traversal and bounds code and explicit files', () => {
    assert.deepEqual(normalizeExecutionInput(sample({ outputPaths: ['report.csv', 'tables/result.json'] })).outputPaths, ['report.csv', 'tables/result.json']);
    for (const path of ['/etc/passwd', '../outside', 'a/../../b', 'a//b', 'a/./b', 'a\\b', 'a\nb']) assert.throws(() => normalizeExecutionInput(sample({ outputPaths: [path] })));
    assert.throws(() => normalizeExecutionInput(sample({ code: 'x'.repeat(32001) })));
    assert.throws(() => normalizeExecutionInput(sample({ inputAttachmentIds: Array(9).fill('id') })));
  });
  it('keeps catalog access truthful until connection and explicit agent policy are ready', () => {
    const crew = [{ agent: 'atlas', enabled: true }, { agent: 'inactive', enabled: false }];
    assert.deepEqual(executionToolAccess(crew, {}).agents, []);
    const settings = { enabled: true, providerConfigured: true, connectionStatus: 'connected', agentPolicies: { atlas: { run: 'ask' }, inactive: { run: 'auto' } } };
    assert.deepEqual(executionToolAccess(crew, settings).agents, ['atlas']);
    assert.strictEqual(executionToolAccess(crew, { ...settings, connectionStatus: 'error' }).statusLabel, 'Test connection');
  });
});

if (Meteor.isServer) describe('Constellation isolated execution service', function () {
  this.timeout(20000);
  let executionModule; let service; let userId; let context; let host; let adapter; let calls; let allowed; let crewEnabled; let execute; let files; let created;
  const rejected = async (promise, code) => { let error; try { await promise; } catch (failure) { error = failure; } assert.ok(error, `Expected ${code}`); assert.strictEqual(error.error, code); };
  const waitFor = async (condition) => { const until = Date.now() + 3000; while (!await condition()) { if (Date.now() > until) assert.fail('Expected operation did not arrive'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  before(async () => { executionModule = await import('../server/constellation-execution'); });
  beforeEach(async () => {
    userId = `execution-test-${Random.id()}`; allowed = true; crewEnabled = true; calls = []; files = []; created = [];
    context = { userId, sessionId: 'mission', agent: 'atlas', toolCallId: 'call-one', attachToResult: (ref) => calls.push(['attach', ref]) };
    host = {
      requireUser: async (id) => { if (id !== userId) throw new Meteor.Error('not-authorized', 'Private owner'); },
      CrewConfigs: { findOneAsync: async (query) => query.userId === userId && query.agent === 'atlas' && (!query.enabled || crewEnabled) ? { agent: 'atlas', enabled: crewEnabled, status: 'active' } : null },
      rootMissionSession: async (id) => ['mission', 'child'].includes(id) ? { _id: 'mission', userId, agent: 'orchestrator' } : null,
      missionAllowsAgent: async () => allowed,
      requireActiveMissionExecution: async () => { if (!allowed) throw new Meteor.Error('mission-stopped', 'Stopped'); },
      canStoreSecret: () => true, encryptSecret: async () => ({ fixture: 'encrypted' }), decryptSecret: async () => 'private-fixture-token',
      AgentAttachments: { findOneAsync: async (query) => files.find((row) => row._id === query._id && (typeof query.sessionId === 'string' ? row.sessionId === query.sessionId : query.sessionId.$in.includes(row.sessionId))) },
      Agent: { attachments: { readContent: async (file) => file.content, create: async (input) => { created.push(input); return { id: `artifact-${created.length}`, name: input.name, contentType: input.contentType, size: Buffer.from(input.content.base64, 'base64').length }; } } },
    };
    execute = async (request, { onOutput }) => { onOutput({ stream: 'stdout', text: '4\n' }); return { exitCode: 0 }; };
    adapter = {
      inspectConnections: async () => ({ connections: [] }),
      testConnection: async () => { calls.push(['test']); },
      createWorkspace: async (input) => { calls.push(['create', input]); },
      writeFile: async (input) => { calls.push(['write', input]); },
      clearOutputFiles: async (input) => { calls.push(['clear', input]); },
      readFile: async (input) => { calls.push(['read', input]); return Buffer.from('a,b\n1,2\n'); },
      destroyWorkspace: async (input) => { calls.push(['destroy', input]); },
      createSpritesProvider: () => ({ run: async (...args) => { calls.push(['run', args[0]]); return execute(...args); } }),
    };
    service = executionModule.createConstellationExecutionService(host, { adapter, pollMs: 10 });
    await service.saveSettings(userId, { enabled: true, token: 'private-fixture-token' }); await service.testConnection(userId);
    await service.setAgentPolicy(userId, { agent: 'atlas', policy: { run: 'auto' } });
  });
  afterEach(async () => { for (const collection of [executionModule.ExecutionEnvironments, executionModule.ExecutionSettings, executionModule.ExecutionSecrets, executionModule.ExecutionJobs, executionModule.ExecutionBudgets]) await collection.removeAsync({ userId }); });

  describe('connection rechecks', function () {
    let clock;
    const providerFailure = (code) => Object.assign(new Error('Bearer private-fixture-token: private provider diagnostic'), { code });
    beforeEach(() => {
      clock = Date.now() + 60_000;
      service = executionModule.createConstellationExecutionService(host, { adapter, pollMs: 10, now: () => clock });
      adapter.inspectConnections = async () => { calls.push(['inventory']); return { connections: [] }; };
      calls.length = 0;
    });

    it('recovers a transient failure with safe reads and never approves newly discovered connections', async () => {
      adapter.testConnection = async () => { calls.push(['test']); throw providerFailure('network-error'); };
      await rejected(service.testConnection(userId), 'execution-connection-failed');
      const failed = await service.getSettings(userId);
      assert.equal(failed.connectionStatus, 'error'); assert.equal(failed.connectionErrorCode, 'network-error');
      assert.isTrue(failed.connectionRetryable); assert.notInclude(failed.connectionError.toLowerCase(), 'rejected');
      assert.notInclude(JSON.stringify(failed), 'private-fixture-token');
      adapter.testConnection = async () => { calls.push(['test']); };
      adapter.inspectConnections = async () => { calls.push(['inventory']); return { connections: [{ id: 'github', provider: 'github', scopes: 'repo' }] }; };
      calls.length = 0; clock += 30_001;
      const recovered = await service.recheckConnection(userId, {});
      assert.equal(recovered._id, userId); assert.equal(recovered.connectionStatus, 'connected'); assert.isFalse(recovered.connectionRetryable);
      assert.notProperty(recovered, 'connectionError'); assert.notProperty(recovered, 'connectionErrorCode');
      assert.equal(recovered.connectorReview.status, 'checked'); assert.lengthOf(recovered.connectorReview.connections, 1);
      assert.notProperty(recovered, 'approvedConnectorFingerprint'); assert.notProperty(recovered, 'connectorApprovedAt');
      assert.deepEqual(calls.map(([kind]) => kind), ['test', 'inventory']);
      assert.isEmpty(await executionModule.ExecutionJobs.find({ userId }).fetchAsync());
      assert.isEmpty(await executionModule.ExecutionBudgets.find({ userId }).fetchAsync());
      assert.isEmpty(await executionModule.ExecutionEnvironments.find({ userId }).fetchAsync());
    });

    it('classifies failures without leaking raw diagnostics and returns failures on the automatic path', async () => {
      for (const [providerCode, expectedCode, retryable] of [
        ['network-error', 'network-error', true], ['provider-busy', 'provider-busy', true],
        ['provider-error', 'provider-error', true], ['invalid-response', 'provider-error', true],
        ['unexpected', 'provider-error', true], ['auth', 'key-rejected', false], ['key-rejected', 'key-rejected', false],
      ]) {
        await executionModule.ExecutionSettings.updateAsync(userId, { $set: { connectionStatus: 'connected' } });
        clock += 30_001;
        adapter.testConnection = async () => { throw providerFailure(providerCode); };
        const result = await service.recheckConnection(userId, {});
        assert.equal(result.connectionStatus, 'error', providerCode); assert.equal(result.connectionErrorCode, expectedCode, providerCode);
        assert.equal(result.connectionRetryable, retryable, providerCode);
        assert.notInclude(JSON.stringify(result), 'private-fixture-token'); assert.notInclude(JSON.stringify(result), 'private provider diagnostic');
      }
    });

    it('does not loop on rejected tokens but still permits an explicit successful connection test', async () => {
      adapter.testConnection = async () => { calls.push(['test']); throw providerFailure('key-rejected'); };
      await rejected(service.testConnection(userId), 'execution-connection-failed');
      calls.length = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        clock += 60_000;
        assert.equal((await service.recheckConnection(userId, {})).connectionErrorCode, 'key-rejected');
      }
      assert.isEmpty(calls);
      adapter.testConnection = async () => { calls.push(['test']); };
      assert.equal((await service.testConnection(userId)).connectionStatus, 'connected');
      assert.deepEqual(calls.map(([kind]) => kind), ['test', 'inventory']);
    });

    it('classifies locked credentials without provider traffic or automatic repeated unlock attempts', async () => {
      let unlocks = 0;
      host.decryptSecret = async () => { unlocks += 1; throw new Error('private keychain diagnostic'); };
      const locked = await service.recheckConnection(userId, {});
      assert.equal(locked.connectionErrorCode, 'token-locked'); assert.isFalse(locked.connectionRetryable); assert.equal(unlocks, 1);
      assert.notInclude(JSON.stringify(locked), 'private keychain diagnostic'); assert.isEmpty(calls);
      clock += 60_000; await service.recheckConnection(userId, {}); assert.equal(unlocks, 1);
      host.decryptSecret = async () => 'private-fixture-token';
      assert.equal((await service.testConnection(userId)).connectionStatus, 'connected');
    });

    it('does not automatically test missing or never-tested credentials', async () => {
      await executionModule.ExecutionSettings.updateAsync(userId, { $set: { connectionStatus: 'untested' }, $unset: { testedAt: '' } });
      assert.equal((await service.recheckConnection(userId, {})).connectionStatus, 'untested'); assert.isEmpty(calls);
      const previousToken = process.env.SPRITES_TOKEN;
      try {
        delete process.env.SPRITES_TOKEN; await executionModule.ExecutionSecrets.removeAsync({ userId });
        await executionModule.ExecutionSettings.updateAsync(userId, { $set: { connectionStatus: 'connected', testedAt: new Date(clock - 60_000) } });
        assert.isFalse((await service.recheckConnection(userId, {})).providerConfigured); assert.isEmpty(calls);
        await rejected(service.testConnection(userId), 'execution-connection-failed');
        const missing = await service.getSettings(userId);
        assert.equal(missing.connectionErrorCode, 'token-required'); assert.isFalse(missing.connectionRetryable); assert.isEmpty(calls);
      } finally {
        if (previousToken === undefined) delete process.env.SPRITES_TOKEN; else process.env.SPRITES_TOKEN = previousToken;
      }
    });

    it('serializes concurrent rechecks and throttles from completion, including across service restart', async () => {
      let release;
      adapter.testConnection = async () => { calls.push(['test']); await new Promise((resolve) => { release = resolve; }); };
      const first = service.recheckConnection(userId, {}); await waitFor(() => !!release);
      const second = service.recheckConnection(userId, {});
      clock += 60_000; release();
      const [one, two] = await Promise.all([first, second]);
      assert.equal(one.connectionRecheckAfter.getTime(), clock + 30_000);
      assert.equal(two.testedAt.getTime(), clock); assert.deepEqual(calls.map(([kind]) => kind), ['test', 'inventory']);
      const restarted = executionModule.createConstellationExecutionService(host, { adapter, now: () => clock });
      clock += 29_999; await restarted.recheckConnection(userId, {});
      assert.deepEqual(calls.map(([kind]) => kind), ['test', 'inventory']);
      adapter.testConnection = async () => { calls.push(['test']); };
      clock += 1; await restarted.recheckConnection(userId, {});
      assert.deepEqual(calls.map(([kind]) => kind), ['test', 'inventory', 'test', 'inventory']);
    });

    it('preserves disabled execution, agent permissions, limits, domains, and prior human approvals', async () => {
      const settings = await service.saveSettings(userId, { enabled: false, domains: ['example.com'], limits: { maxRunsPerMission: 4 } });
      await executionModule.ExecutionSettings.updateAsync(userId, { $set: { approvedConnectorFingerprint: 'previous-human-review', connectorApprovedAt: new Date(clock - 10_000) } });
      calls.length = 0;
      const result = await service.recheckConnection(userId, {});
      assert.isFalse(result.enabled); assert.deepEqual(result.agentPolicies, settings.agentPolicies);
      assert.deepEqual(result.domains, settings.domains); assert.deepEqual(result.limits, settings.limits);
      assert.equal(result.approvedConnectorFingerprint, 'previous-human-review');
      assert.equal(result.connectorApprovedAt.getTime(), clock - 10_000);
      assert.deepEqual(calls.map(([kind]) => kind), ['test', 'inventory']);
    });

    it('does not treat a failed connector inventory as permission to execute or approve connectors', async () => {
      adapter.inspectConnections = async () => { calls.push(['inventory']); throw providerFailure('provider-error'); };
      const result = await service.recheckConnection(userId, {});
      assert.equal(result.connectionStatus, 'connected'); assert.equal(result.connectorReview.status, 'unknown');
      assert.notInclude(JSON.stringify(result), 'private-fixture-token'); assert.notProperty(result, 'approvedConnectorFingerprint');
      await rejected(service.run(context, sample()), 'execution-connections-unverified');
      assert.isFalse(calls.some(([kind]) => ['create', 'write', 'run'].includes(kind)));
    });

    it('does not publish results after the owner loses access during a provider check', async () => {
      const before = await service.getSettings(userId); let release; let authorized = true;
      host.requireUser = async (id) => { if (!authorized || id !== userId) throw new Meteor.Error('not-authorized', 'Private owner'); };
      adapter.testConnection = async () => { calls.push(['test']); await new Promise((resolve) => { release = resolve; }); };
      const pending = service.recheckConnection(userId, {}); await waitFor(() => !!release); authorized = false; release();
      await rejected(pending, 'not-authorized');
      const stored = await executionModule.ExecutionSettings.findOneAsync(userId);
      assert.equal(stored.testedAt.getTime(), before.testedAt.getTime()); assert.deepEqual(stored.connectorReview, before.connectorReview);
      assert.deepEqual(calls.map(([kind]) => kind), ['test']);
    });

    it('serializes token replacement after a pending check and requires a new explicit test', async () => {
      let release; let token = 'private-fixture-token'; let replacementSaved = false;
      host.decryptSecret = async () => token;
      host.encryptSecret = async (_owner, value) => { token = value; return { fixture: 'encrypted' }; };
      adapter.testConnection = async () => { calls.push(['test']); await new Promise((resolve) => { release = resolve; }); };
      const pending = service.recheckConnection(userId, {}); await waitFor(() => !!release);
      const replacing = service.saveSettings(userId, { token: 'replacement-fixture-token' }).then((result) => { replacementSaved = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 0)); assert.isFalse(replacementSaved);
      release(); assert.equal((await pending).connectionStatus, 'connected');
      const replaced = await replacing;
      assert.equal(replaced.connectionStatus, 'untested');
      for (const field of ['testedAt', 'connectionError', 'connectionErrorCode', 'connectionRetryable', 'connectionRecheckAt', 'connectionRecheckAfter', 'connectorReview']) assert.notProperty(replaced, field);
      calls.length = 0; clock += 60_000;
      assert.equal((await service.recheckConnection(userId, {})).connectionStatus, 'untested'); assert.isEmpty(calls);
    });

    it('discards a completed inventory if host credentials change outside the settings lock', async () => {
      let token = 'private-fixture-token'; host.decryptSecret = async () => token;
      adapter.inspectConnections = async () => { calls.push(['inventory']); token = 'externally-replaced-fixture-token'; return { connections: [{ id: 'stale', scopes: 'write' }] }; };
      const result = await service.recheckConnection(userId, {});
      assert.equal(result.connectionStatus, 'untested'); assert.notProperty(result, 'testedAt'); assert.notProperty(result, 'connectorReview');
      assert.notProperty(result, 'approvedConnectorFingerprint'); assert.deepEqual(calls.map(([kind]) => kind), ['test', 'inventory']);
    });

    it('keeps the explicit-test cooldown when an unchanged token is saved', async () => {
      const checked = await service.testConnection(userId);
      const saved = await service.saveSettings(userId, { token: 'private-fixture-token' });
      assert.equal(saved.testedAt.getTime(), checked.testedAt.getTime());
      assert.equal(saved.connectionRecheckAfter.getTime(), checked.connectionRecheckAfter.getTime());
      calls.length = 0; await service.recheckConnection(userId, {}); assert.isEmpty(calls);
    });

    it('accepts no client credentials, settings, or owner override and exposes the scoped method', async () => {
      await rejected(service.recheckConnection('another-owner', {}), 'not-authorized');
      for (const input of [{ userId: 'another-owner' }, { token: 'model-token' }, { enabled: true }, { force: true }]) {
        await rejected(service.recheckConnection(userId, input), 'invalid-execution');
      }
      assert.isEmpty(calls);
      const methods = executionModule.createExecutionMethods(service);
      const result = await methods['constellation.execution.recheckConnection'].call({ userId }, {});
      assert.equal(result._id, userId); assert.equal(result.connectionStatus, 'connected');
    });
  });

  it('saves a first token locally without contacting Sprites or blocking a catalog settings refresh', async () => {
    await executionModule.ExecutionSecrets.removeAsync({ userId });
    await executionModule.ExecutionSettings.removeAsync({ userId });
    calls.length = 0;
    let refreshed = false;
    host.onPolicyChange = async (id) => {
      const current = await service.getSettings(id);
      refreshed = current.providerConfigured && current.keySource === 'saved';
    };
    const saved = await service.saveSettings(userId, { enabled: false, token: 'private-fixture-token' });
    assert.isTrue(refreshed);
    assert.isTrue(saved.providerConfigured);
    assert.isFalse(saved.enabled);
    assert.equal(saved.connectionStatus, 'untested');
    assert.isEmpty(calls, 'saving alone must not test a token or allocate remote resources');
    assert.notInclude(JSON.stringify(saved), 'private-fixture-token');
  });

  it('requires configured access and returns the framework approval gate', async () => {
    await service.setAgentPolicy(userId, { agent: 'atlas', policy: { run: 'ask' } });
    assert.strictEqual(await service.toolDefinitions('atlas')[0].gate(context), 'ask');
    await service.setAgentPolicy(userId, { agent: 'atlas', policy: { run: 'auto' } }); assert.strictEqual(await service.toolEntitlement(context, 'atlas'), true);
    await service.setAgentPolicy(userId, { agent: 'atlas', policy: { run: 'disabled' } }); assert.strictEqual(await service.toolEntitlement(context, 'atlas'), false);
    await rejected(service.run(context, sample()), 'execution-access-off'); assert.isFalse(calls.some(([kind]) => kind === 'create'));
  });

  it('rejects retired database file inputs instead of silently omitting them', async () => {
    await rejected(service.run(context, sample({ inputFileIds: ['legacy-file'] })), 'invalid-execution');
    assert.isFalse(calls.some(([kind]) => kind === 'create'));
    assert.notProperty(service.toolDefinitions('atlas')[0].args.properties, 'inputFileIds');
  });
  it('requires an exact owner review when connected API grants exist or change', async () => {
    adapter.inspectConnections = async () => ({ connections: [{ id: 'github', provider: 'github', scopes: 'repo' }] });
    await rejected(service.run(context, sample()), 'execution-connections-review');
    assert.isFalse(calls.some(([kind]) => kind === 'create'));
    const review = await service.reviewConnections(userId);
    await service.approveConnections(userId, { fingerprint: review.connectorReview.fingerprint });
    const result = await service.run(context, sample()); assert.equal(result.status, 'completed');
    adapter.inspectConnections = async () => ({ connections: [{ id: 'github', provider: 'github', scopes: 'repo,admin' }] });
    await rejected(service.approveConnections(userId, { fingerprint: review.connectorReview.fingerprint }), 'execution-connections-changed');
    await rejected(service.run({ ...context, toolCallId: 'changed-grant' }, sample()), 'execution-connections-review');
    assert.equal((await service.run(context, sample())).runId, result.runId, 'previous result is never replayed');
  });
  it('fails closed before allocating when connector access cannot be inspected', async () => {
    adapter.inspectConnections = async () => { throw new Error('private-fixture-token'); };
    await rejected(service.run(context, sample()), 'execution-connections-unverified');
    assert.isEmpty(await service.history(userId)); assert.isFalse(calls.some(([kind]) => kind === 'create'));
    assert.notInclude(JSON.stringify(await service.getSettings(userId)), 'private-fixture-token');
  });
  it('inspects an exact same-mission run without executing, waking, or requiring a connection', async () => {
    const result = await service.run(context, sample()); const before = calls.length;
    await service.saveSettings(userId, { enabled: false });
    const inspected = await service.inspectRun(context, { runId: result.runId });
    assert.equal(inspected.stdout, '4\n'); assert.equal(calls.length, before);
    assert.isTrue(await service.toolDefinitions('atlas')[1].gate(context));
    await executionModule.ExecutionJobs.updateAsync(result.runId, { $set: { missionId: 'other-mission' } });
    await rejected(service.inspectRun(context, { runId: result.runId }), 'execution-not-found');
    await service.setAgentPolicy(userId, { agent: 'atlas', policy: { run: 'disabled' } });
    assert.isFalse(await service.toolDefinitions('atlas')[1].gate(context));
  });
  it('creates one isolated run, captures bounded output, removes its scratch space, and never replays', async () => {
    const result = await service.run(context, sample()); assert.strictEqual(result.status, 'completed'); assert.strictEqual(result.stdout, '4\n'); assert.isFalse(result.cleanupPending);
    const second = await service.run(context, sample()); assert.strictEqual(second.runId, result.runId);
    assert.strictEqual(calls.filter(([kind]) => kind === 'create').length, 1); assert.strictEqual(calls.filter(([kind]) => kind === 'run').length, 1);
    assert.deepEqual(calls.find(([kind]) => kind === 'create')[1].domains, []);
    assert.deepEqual(calls.find(([kind]) => kind === 'run')[1].command, ['python3', '/workspace/main.py']);
    assert.match(calls.find(([kind]) => kind === 'destroy')[1].workspaceId, /^constellation-run-[a-f0-9]{32}$/);
    await rejected(service.run(context, sample({ code: 'print(99)' })), 'execution-request-conflict');
  });
  it('refuses file-producing disposable runs before creating a workspace or spending a run', async () => {
    await rejected(service.run(context, sample({ outputPaths: ['report.csv'] })), 'execution-filesystem-required');
    assert.isFalse(calls.some(([kind]) => kind === 'create')); assert.lengthOf(await service.history(userId), 0); assert.isEmpty(created);
  });
  it('admits only explicit same-mission inputs and attaches results from a retained Sprite', async () => {
    await service.saveEnvironment(userId, { missionId: 'mission', keepFiles: true, allowedAgents: ['atlas'], retention: 'keep' });
    files = [{ _id: 'input-a', sessionId: 'mission', name: 'records.csv', size: 4, content: Buffer.from('a\n1\n').toString('base64') },
      { _id: 'unselected', sessionId: 'mission', name: 'private.txt', size: 6, content: Buffer.from('secret').toString('base64') }];
    const result = await service.run({ ...context, sessionId: 'child' }, sample({ inputAttachmentIds: ['input-a'], outputPaths: ['report.csv'] }));
    assert.strictEqual(result.status, 'completed'); assert.lengthOf(result.artifacts, 1); assert.lengthOf(created, 1);
    assert.strictEqual(created[0].sessionId, 'child'); assert.isTrue(created[0].attach);
    assert.isFalse(calls.some(([kind, input]) => kind === 'write' && input.path.includes('private.txt')));
    const manifest = calls.find(([kind, input]) => kind === 'write' && input.path.endsWith('/manifest.json'));
    assert.deepEqual(JSON.parse(Buffer.from(manifest[1].content).toString()).map((file) => file.id), ['input-a']);
    assert.strictEqual(calls.find(([kind]) => kind === 'read')[1].path, '/workspace/outputs/report.csv');
    assert.ok(calls.some(([kind]) => kind === 'attach'));
  });
  it('rejects foreign input attachments before allocating any workspace', async () => {
    files = [{ _id: 'private', sessionId: 'another-mission', name: 'data.txt', size: 1, content: 'YQ==' }];
    await rejected(service.run(context, sample({ inputAttachmentIds: ['private'] })), 'execution-input-unavailable');
    assert.isFalse(calls.some(([kind]) => kind === 'create')); assert.lengthOf(await service.history(userId), 0);
  });
  it('persists uncertain provider outcomes without leaking provider credentials or retrying them', async () => {
    execute = async () => { throw new Error('Authorization: Bearer private-fixture-token'); };
    const result = await service.run(context, sample()); assert.strictEqual(result.status, 'unknown');
    assert.notInclude(JSON.stringify(await service.history(userId)), 'private-fixture-token');
    assert.notInclude(JSON.stringify(await service.getSettings(userId)), 'private-fixture-token');
    await service.run(context, sample()); assert.strictEqual(calls.filter(([kind]) => kind === 'run').length, 1);
  });
  it('stops a live execution and destroys the entire exact workspace', async () => {
    execute = async (_request, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true }));
    const run = service.run(context, sample()); await waitFor(async () => (await service.history(userId))[0]?.status === 'running');
    const job = (await service.history(userId))[0]; await service.stop(userId, { jobId: job._id });
    const result = await run; assert.strictEqual(result.status, 'cancelled'); assert.isFalse(result.cleanupPending);
    assert.ok(calls.some(([kind, input]) => kind === 'destroy' && input.workspaceId === job.workspaceId));
  });
  it('revokes a running job when agent membership or access disappears', async () => {
    execute = async (_request, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true }));
    const run = service.run(context, sample()); await waitFor(() => calls.some(([kind]) => kind === 'run'));
    crewEnabled = false; const result = await run; assert.strictEqual(result.status, 'cancelled');
    assert.ok(calls.some(([kind]) => kind === 'destroy'));
  });
  it('keeps cleanup failures visible and permits only owned exact cleanup retries', async () => {
    adapter.destroyWorkspace = async () => { throw new Error('secret provider diagnostic'); };
    const result = await service.run(context, sample()); assert.isTrue(result.cleanupPending);
    await rejected(service.cleanup('another-owner', { jobId: result.runId }), 'not-authorized');
    await rejected(service.saveSettings(userId, { token: 'replacement-token' }), 'execution-cleanup-required');
    adapter.destroyWorkspace = async (input) => calls.push(['destroy-retry', input]);
    const cleaned = await service.cleanup(userId, { jobId: result.runId }); assert.isFalse(cleaned.cleanupPending);
    assert.match(calls.find(([kind]) => kind === 'destroy-retry')[1].workspaceId, /^constellation-run-[a-f0-9]{32}$/);
  });
  it('retains cleanup uncertainty when a lost create response races a delete404', async () => {
    adapter.createWorkspace = async () => { const error = new Error('lost create'); error.creationUncertain = true; throw error; };
    const result = await service.run(context, sample()); assert.strictEqual(result.status, 'unknown'); assert.isTrue(result.cleanupPending);
    assert.isFalse(calls.some(([kind]) => kind === 'run'));
    await rejected(service.cleanup(userId, { jobId: result.runId }), 'execution-cleanup-settling');
    await service.run(context, sample()); assert.isFalse(calls.some(([kind]) => kind === 'run'));
  });
  it('reserves mission budgets durably and treats repeated tool IDs as one run', async () => {
    await service.saveSettings(userId, { limits: { maxRunsPerMission: 1 } });
    await service.run(context, sample()); await service.run(context, sample());
    await rejected(service.run({ ...context, toolCallId: 'new-call' }, sample()), 'execution-run-limit');
    assert.strictEqual(calls.filter(([kind]) => kind === 'run').length, 1);
  });
  it('recovers interrupted jobs as unknown, cleans scratch, and never reruns code', async () => {
    const result = await service.run(context, sample());
    await executionModule.ExecutionJobs.updateAsync(result.runId, { $set: { status: 'running', cleanupPending: true } });
    await service.recover({ userId });
    const job = (await service.history(userId))[0]; assert.strictEqual(job.status, 'unknown'); assert.isFalse(job.cleanupPending);
    await service.run(context, sample()); assert.strictEqual(calls.filter(([kind]) => kind === 'run').length, 1);
    assert.notProperty(job, 'credentialHash'); assert.notProperty(job, 'fingerprint'); assert.notProperty(job, 'userId');
  });
  it('requires the exact framework approval receipt after automatic access is tightened', async () => {
    assert.strictEqual(await service.toolEntitlement(context, 'atlas'), true);
    await service.setAgentPolicy(userId, { agent: 'atlas', policy: { run: 'ask' } });
    await rejected(service.run(context, sample()), 'execution-approval-required');
    host.getSession = async () => ({ userId, agent: 'atlas', pending: { name: 'run_code', toolCallId: context.toolCallId, verdict: 'approved', args: sample() } });
    const approved = await service.run(context, sample()); assert.strictEqual(approved.status, 'completed');
    host.getSession = async () => ({ userId, agent: 'wrong-agent', pending: { name: 'run_code', toolCallId: 'next', verdict: 'approved', args: sample() } });
    await rejected(service.run({ ...context, toolCallId: 'next' }, sample()), 'execution-approval-required');
  });
  it('serializes token rotation with the durable workspace reservation', async () => {
    let releaseToken; let tokenRead = false; let releaseRun;
    host.decryptSecret = async () => { tokenRead = true; await new Promise((resolve) => { releaseToken = resolve; }); return 'private-fixture-token'; };
    execute = async () => { await new Promise((resolve) => { releaseRun = resolve; }); return { exitCode: 0 }; };
    const run = service.run(context, sample()); await waitFor(() => tokenRead);
    const rotation = service.saveSettings(userId, { token: 'other-account-token' }).then(() => null, (error) => error);
    releaseToken(); const error = await rotation; assert.strictEqual(error?.error, 'execution-cleanup-required');
    await waitFor(() => !!releaseRun); releaseRun(); assert.strictEqual((await run).status, 'completed');
  });
  it('retains provisioning uncertainty across a process restart before the create response', async () => {
    const result = await service.run(context, sample()); const deletes = calls.filter(([kind]) => kind === 'destroy').length;
    await executionModule.ExecutionJobs.updateAsync(result.runId, { $set: { status: 'preparing', provisioningRequestedAt: new Date(), cleanupPending: true }, $unset: { provisioningConfirmedAt: '' } });
    await service.recover({ userId }); const recovered = (await service.history(userId))[0];
    assert.strictEqual(recovered.status, 'unknown'); assert.isTrue(recovered.creationUncertain); assert.isTrue(recovered.cleanupPending);
    assert.strictEqual(calls.filter(([kind]) => kind === 'destroy').length, deletes, 'do not accept a racing delete404 as proof of cleanup');
  });
  it('honors Stop during the reservation-to-controller gap before any provider request', async () => {
    const original = executionModule.ExecutionJobs.insertAsync; let inserted; let release;
    executionModule.ExecutionJobs.insertAsync = async function (doc, ...args) {
      const result = await original.call(this, doc, ...args);
      if (doc.userId === userId) { inserted = doc._id; await new Promise((resolve) => { release = resolve; }); }
      return result;
    };
    let run;
    try {
      run = service.run(context, sample()); await waitFor(() => !!inserted);
      await service.stop(userId, { jobId: inserted }); release();
      assert.strictEqual((await run).status, 'cancelled'); assert.isFalse(calls.some(([kind]) => kind === 'create' || kind === 'run'));
    } finally { release?.(); if (run) await run; executionModule.ExecutionJobs.insertAsync = original; }
  });
  it('reports a time limit, not user cancellation, when cleanup takes longer than polling', async () => {
    await service.saveSettings(userId, { limits: { timeoutSeconds: 1 } });
    execute = async (_request, { signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 40)); return { exitCode: null };
    };
    const result = await service.run(context, sample()); assert.strictEqual(result.status, 'failed'); assert.include(result.error, 'time limit');
  });
  it('erases source and output data but retains a minimal owned cleanup receipt', async () => {
    adapter.destroyWorkspace = async () => { throw new Error('unconfirmed'); };
    const result = await service.run(context, sample({ title: 'Private analysis', code: 'print("private-source")' }));
    await service.scrubSession('mission'); const receipt = await executionModule.ExecutionJobs.findOneAsync(result.runId);
    assert.lengthOf(await service.history(userId), 0, 'erased cleanup receipts are not ordinary run history');
    assert.isTrue(receipt.cleanupPending); assert.ok(receipt.erasedAt);
    for (const field of ['code', 'stdout', 'stderr', 'inputFiles', 'outputPaths', 'artifacts', 'language']) assert.notProperty(receipt, field);
    assert.notInclude(JSON.stringify(receipt), 'Private analysis'); assert.notInclude(JSON.stringify(receipt), 'private-source');
    assert.strictEqual(await executionModule.ExecutionBudgets.find({ userId }).countAsync(), 0);
    adapter.destroyWorkspace = async () => {}; await service.cleanup(userId, { jobId: result.runId }); assert.lengthOf(await service.history(userId), 0);
  });
  it('does not resurrect late execution output after conversation erasure', async () => {
    execute = async (_request, { signal, onOutput }) => {
      onOutput({ stream: 'stdout', text: 'private-output' });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); return { exitCode: null };
    };
    adapter.destroyWorkspace = async () => { throw new Error('unconfirmed'); };
    const run = service.run(context, sample()); await waitFor(() => calls.some(([kind]) => kind === 'run'));
    await service.scrubSession('mission'); const result = await run; const receipt = await executionModule.ExecutionJobs.findOneAsync(result.runId);
    assert.lengthOf(await service.history(userId), 0);
    assert.notProperty(receipt, 'stdout'); assert.notProperty(receipt, 'code'); assert.notInclude(JSON.stringify(receipt), 'private-output');
  });
  it('does not overwrite a completed job when Stop loses the final-state race', async () => {
    const result = await service.run(context, sample());
    await executionModule.ExecutionJobs.updateAsync(result.runId, { $set: { status: 'running' } });
    const original = executionModule.ExecutionJobs.updateAsync;
    executionModule.ExecutionJobs.updateAsync = async function (selector, modifier, ...args) {
      if (selector?._id === result.runId && modifier?.$set?.status === 'stopping') {
        await original.call(this, result.runId, { $set: { status: 'completed' } });
      }
      return original.call(this, selector, modifier, ...args);
    };
    try { const stopped = await service.stop(userId, { jobId: result.runId }); assert.strictEqual(stopped.status, 'completed'); }
    finally { executionModule.ExecutionJobs.updateAsync = original; }
  });
  it('returns owned code runs across missions and applies an exact mission filter', async () => {
    const missionIds = ['mission', 'mission-two'];
    host.rootMissionSession = async (id) => missionIds.includes(id)
      ? { _id: id, userId, agent: 'orchestrator' }
      : id === 'foreign-mission' ? { _id: id, userId: 'other-owner', agent: 'orchestrator' } : null;
    const now = Date.now(); const foreignId = `foreign-execution-${Random.id()}`;
    const insert = (id, ownerId, missionId, offset, extra = {}) => executionModule.ExecutionJobs.insertAsync({
      _id: id, userId: ownerId, missionId, sessionId: `${id}-session`, toolCallId: `${id}-tool`,
      title: id, status: 'completed', createdAt: new Date(now + offset),
      fingerprint: 'private-request', credentialHash: 'private-credential-hash', ...extra,
    });
    const first = `workspace-first-${Random.id()}`; const second = `workspace-second-${Random.id()}`; const erased = `workspace-erased-${Random.id()}`;
    try {
      await insert(first, userId, 'mission', 1); await insert(second, userId, 'mission-two', 2);
      await insert(erased, userId, 'mission', 3, { erasedAt: new Date(), cleanupPending: true });
      await insert(foreignId, 'other-owner', 'foreign-mission', 4);
      const all = await service.history(userId, { limit: 100 });
      assert.deepEqual(all.map((job) => job._id), [second, first]);
      assert.deepEqual((await service.history(userId, { missionId: 'mission', limit: 100 })).map((job) => job._id), [first]);
      assert.deepEqual((await service.history(userId, { missionId: 'mission-two', limit: 100 })).map((job) => job._id), [second]);
      for (const job of all) for (const field of ['userId', 'credentialHash', 'fingerprint']) assert.notProperty(job, field);
      await rejected(service.history(userId, { missionId: 'foreign-mission' }), 'execution-mission-unavailable');
      await rejected(service.history(null), 'not-authorized');
      await rejected(service.history('other-owner'), 'not-authorized');
    } finally { await executionModule.ExecutionJobs.removeAsync(foreignId); }
  });
  it('publishes only the latest 100 owned non-erased workspace jobs through its guarded cursor', async () => {
    const now = Date.now(); const ids = []; const foreignId = `foreign-published-execution-${Random.id()}`;
    try {
      for (let index = 0; index < 101; index += 1) {
        const id = `published-execution-${Random.id()}`; ids.push(id);
        await executionModule.ExecutionJobs.insertAsync({ _id: id, userId, missionId: index % 2 ? 'mission-two' : 'mission',
          sessionId: `${id}-session`, toolCallId: `${id}-tool`, status: 'completed', createdAt: new Date(now + index),
          fingerprint: 'private-request', credentialHash: 'private-credential-hash' });
      }
      await executionModule.ExecutionJobs.insertAsync({ _id: foreignId, userId: 'other-owner', missionId: 'foreign-mission',
        sessionId: `${foreignId}-session`, toolCallId: 'foreign-tool', status: 'completed', createdAt: new Date(now + 1000) });
      await executionModule.ExecutionJobs.insertAsync({ _id: `erased-published-execution-${Random.id()}`, userId, missionId: 'mission',
        sessionId: 'erased-session', toolCallId: 'erased-tool', status: 'unknown', erasedAt: new Date(), cleanupPending: true, createdAt: new Date(now + 2000) });
      const published = await (await service.workspaceJobsCursor(userId)).fetchAsync();
      assert.lengthOf(published, 100); assert.strictEqual(published[0]._id, ids[100]); assert.strictEqual(published[99]._id, ids[1]);
      assert.notInclude(published.map((job) => job._id), foreignId);
      for (const job of published) for (const field of ['userId', 'credentialHash', 'fingerprint', 'erasedAt']) assert.notProperty(job, field);
      await rejected(service.workspaceJobsCursor(null), 'not-authorized');
      await rejected(service.workspaceJobsCursor('other-owner'), 'not-authorized');
    } finally { await executionModule.ExecutionJobs.removeAsync(foreignId); }
  });
});
