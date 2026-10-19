import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { normalizeExecutionInput } from '../imports/constellation/execution';
import { missionFileAccess } from '../imports/constellation/mission-files';

describe('Mission file input contracts', () => {
  it('uses workspace files directly and rejects the retired Mongo library input IDs', () => {
    const input = { title: 'Read a file', language: 'python', code: 'print(1)', inputAttachmentIds: ['attachment', 'attachment'] };
    assert.deepEqual(normalizeExecutionInput(input).inputAttachmentIds, ['attachment']);
    assert.notProperty(normalizeExecutionInput(input), 'inputFileIds');
    for (const inputFileIds of [[], ['file-a'], 'file-a', null]) assert.throws(() => normalizeExecutionInput({ ...input, inputFileIds }));
    assert.throws(() => normalizeExecutionInput({ ...input, inputAttachmentIds: Array(9).fill('attachment') }));
    assert.isTrue(missionFileAccess({ capabilities: {} }));
    assert.isFalse(missionFileAccess({ capabilities: { files: false } }));
  });
});

if (Meteor.isServer) describe('Mission file agent tools', function () {
  let createTools; let tools; let service; let host; let session; let context; let crew; let mission; let root;
  let calls; let allowed; let stopped; let environment; let result; let codePolicyCalls; let beforeStorage; let afterStorage; let environmentReads;
  const reject = async (promise, code) => {
    let error; try { await promise; } catch (failure) { error = failure; }
    assert.ok(error, `Expected ${code}`); assert.equal(error.error, code);
  };
  before(async () => { ({ createMissionFileTools: createTools } = await import('../server/mission-file-tools')); });
  beforeEach(() => {
    session = { _id: 'child', userId: 'owner', agent: 'signal' };
    root = { _id: 'mission', userId: 'owner', agent: 'orchestrator' };
    context = { userId: 'owner', sessionId: 'child', agent: 'signal', toolCallId: 'call-1' };
    crew = { agent: 'signal', enabled: true, capabilities: { files: true } };
    mission = { approvals: true }; allowed = true; stopped = false; calls = []; codePolicyCalls = 0; environmentReads = 0;
    beforeStorage = async () => {}; afterStorage = async () => {};
    environment = { keepFiles: true, workspaceId: 'mission-sprite', allowedAgents: ['signal'] };
    result = { name: 'report.md', path: '/workspace/report.md', hash: 'a'.repeat(64), contentType: 'text/markdown', content: Buffer.from('hello').toString('base64'), size: 5 };
    const fail = (code, reason) => { throw new Meteor.Error(code, reason); };
    const record = (name) => async (userId, input, guards) => {
      await beforeStorage(name);
      if (guards?.assertActive) await guards.assertActive();
      calls.push({ name, userId, input, actor: guards?.actor, requestId: guards?.requestId });
      await afterStorage(name); return result;
    };
    host = {
      getSession: async () => session,
      CrewConfigs: { findOneAsync: async () => crew },
      MissionConfigs: { findOneAsync: async () => mission },
      missionAllowsAgent: async () => allowed,
      requireActiveMissionExecution: async () => { if (stopped) fail('mission-stopped', 'Stopped'); },
    };
    service = createTools(host, {
      fail, owner: async (id) => { if (id !== 'owner') fail('not-authorized', 'Owner only'); },
      rootMission: async () => root,
      // If the old code-policy dependency accidentally returns, this fixture
      // rejects every file request. File access is deliberately independent.
      authorizeWorking: async () => { codePolicyCalls += 1; fail('execution-access-off', 'Code access off'); },
      work: Object.fromEntries(['missionFiles', 'readMissionFile'].map((name) => [name, record(name)])),
      environments: { getEnvironment: async () => { environmentReads += 1; return environment; },
        ...Object.fromEntries(['environmentFiles', 'readEnvironmentFile', 'mutateEnvironmentFile'].map((name) => [name, record(name)])) },
    });
    tools = Object.fromEntries(service.fileToolDefinitions('signal').map((tool) => [tool.name, tool]));
  });
  const approve = (args, patch = {}) => { session.pending = { name: 'manage_mission_files', agent: 'signal', toolCallId: 'call-1', verdict: 'approved', args, ...patch }; };
  const write = (patch = {}) => ({ action: 'write', path: '/workspace/report.md', text: 'new', expectedHash: 'a'.repeat(64), ...patch });

  it('exposes exactly three bounded tools with no owner, mission, actor or confirmation parameters', () => {
    assert.sameMembers(Object.keys(tools), ['list_mission_files', 'read_mission_file', 'manage_mission_files']);
    for (const tool of Object.values(tools)) {
      assert.isFalse(tool.args.additionalProperties);
      for (const property of ['userId', 'missionId', 'agent', 'actor', 'confirm', 'requestId']) assert.notProperty(tool.args.properties, property);
    }
    assert.equal(tools.manage_mission_files.args.properties.text.maxLength, 200000);
    assert.deepEqual(tools.list_mission_files.args.properties.location.enum, ['workspace', 'attachments']);
    assert.notProperty(tools.manage_mission_files.args.properties, 'location');
    assert.include(tools.manage_mission_files.args.properties.action.enum, 'delete');
    for (const obsolete of ['trash', 'restore', 'restoreVersion', 'upload']) assert.notInclude(tools.manage_mission_files.args.properties.action.enum, obsolete);
  });
  it('defaults browsing and reading to the Sprite filesystem and derives the mission from context', async () => {
    await tools.list_mission_files.run({ path: '/workspace', missionId: 'foreign', userId: 'intruder' }, context);
    await tools.read_mission_file.run({ path: '/workspace/report.md', missionId: 'foreign' }, context);
    assert.deepEqual(calls.map((call) => call.name), ['environmentFiles', 'readEnvironmentFile']);
    for (const call of calls) { assert.equal(call.userId, 'owner'); assert.equal(call.input.missionId, 'mission'); assert.notProperty(call.input, 'userId'); }
    assert.equal(codePolicyCalls, 0);
  });
  it('reads immutable attachments and preserved copies without a Sprite or code permission', async () => {
    environment = null;
    await tools.list_mission_files.run({ location: 'attachments', search: 'report' }, context);
    await tools.read_mission_file.run({ location: 'attachments', attachmentId: 'original' }, context);
    await tools.read_mission_file.run({ location: 'attachments', legacyEntryId: 'preserved' }, context);
    assert.deepEqual(calls.map((call) => call.name), ['missionFiles', 'readMissionFile', 'readMissionFile']);
    assert.equal(calls[1].input.attachmentId, 'original'); assert.equal(calls[2].input.legacyEntryId, 'preserved');
    assert.isTrue(await tools.read_mission_file.gate({ ...context, args: { location: 'attachments', attachmentId: 'original' } }));
    assert.equal(environmentReads, 0); assert.equal(codePolicyCalls, 0);
  });
  it('requires a current crew file grant, enabled agent and mission membership', async () => {
    for (const patch of [{ capabilities: { files: false } }, { enabled: false }, { status: 'archived' }, { agent: 'atlas' }]) {
      const original = crew; crew = { ...crew, ...patch };
      assert.isFalse(await tools.read_mission_file.gate(context));
      await reject(tools.read_mission_file.run({ path: '/workspace/report.md' }, context), 'mission-file-access-off'); crew = original;
    }
    allowed = false; assert.isFalse(await tools.read_mission_file.gate(context));
    await reject(tools.list_mission_files.run({ location: 'attachments' }, context), 'mission-file-access-off'); assert.isEmpty(calls);
  });
  it('rejects stopped missions, erased or mismatched sessions, foreign roots and cancellation', async () => {
    for (const patch of [{ erasingAt: new Date() }, { erasedAt: new Date() }, { ephemeral: true }, { userId: 'foreign' }, { _id: 'other-session' }]) {
      session = { _id: 'child', userId: 'owner', agent: 'signal', ...patch };
      await reject(tools.read_mission_file.run({ path: '/workspace/report.md' }, context), 'mission-file-unavailable');
    }
    session = { _id: 'child', userId: 'owner', agent: 'signal' };
    root = { _id: 'mission', userId: 'foreign' }; await reject(tools.read_mission_file.run({}, context), 'mission-file-unavailable');
    root = { _id: 'mission', userId: 'owner', erasedAt: new Date() }; await reject(tools.read_mission_file.run({}, context), 'mission-file-unavailable');
    root = { _id: 'mission', userId: 'owner' };
    await reject(tools.read_mission_file.run({}, { ...context, signal: { aborted: true } }), 'mission-file-unavailable');
    stopped = true; await reject(tools.read_mission_file.run({}, context), 'mission-stopped'); assert.isEmpty(calls);
  });
  it('requires an enabled, provisioned filesystem and exact agent membership but never code-run access', async () => {
    for (const patch of [{ keepFiles: false }, { keepFiles: 'true' }, { workspaceId: null }, { allowedAgents: [] }, { allowedAgents: 'signal' }]) {
      const original = environment; environment = { ...environment, ...patch };
      await reject(tools.list_mission_files.run({}, context), 'execution-environment-access'); environment = original;
    }
    mission.approvals = false;
    assert.isTrue(await tools.manage_mission_files.gate({ ...context, args: write() }));
    await tools.manage_mission_files.run(write(), context);
    assert.equal(calls[0].name, 'mutateEnvironmentFile'); assert.equal(codePolicyCalls, 0);
  });
  it('rejects all attachment mutations and obsolete filesystem locations', async () => {
    mission.approvals = false;
    for (const location of ['attachments', 'saved', 'working', 'desktop']) await reject(tools.manage_mission_files.run(write({ location }), context), 'invalid-mission-file');
    for (const location of ['saved', 'working', 'desktop']) await reject(tools.list_mission_files.run({ location }, context), 'invalid-mission-file');
    assert.isEmpty(calls);
  });
  it('requires exact current human review for ordinary changes when mission approval is on', async () => {
    const input = write(); assert.equal(await tools.manage_mission_files.gate({ ...context, args: input }), 'ask');
    await reject(tools.manage_mission_files.run(input, context), 'mission-file-approval-required');
    for (const patch of [{ verdict: 'denied' }, { toolCallId: 'other' }, { agent: 'atlas' }, { name: 'run_code' }, { args: undefined }, { args: { ...input, text: 'different' } }]) {
      approve(input, patch); await reject(tools.manage_mission_files.run(input, context), 'mission-file-approval-required');
    }
    approve(input); await tools.manage_mission_files.run(input, context);
    assert.lengthOf(calls, 1); assert.equal(calls[0].name, 'mutateEnvironmentFile');
    assert.deepEqual(calls[0].actor, { kind: 'agent', agent: 'signal', sessionId: 'child', toolCallId: 'call-1' });
    assert.equal(calls[0].requestId, 'child:call-1'); assert.notProperty(calls[0].input, 'confirm');
  });
  it('allows non-deleting changes under mission auto-approval', async () => {
    mission.approvals = false;
    for (const action of ['createFolder', 'write', 'rename', 'move', 'copy']) {
      const input = { ...write(), action, destination: '/workspace/other.md' };
      assert.isTrue(await tools.manage_mission_files.gate({ ...context, args: input })); await tools.manage_mission_files.run(input, context);
    }
    assert.lengthOf(calls, 5);
  });
  it('always requires exact deletion approval even with mission auto-approval or a forged confirm flag', async () => {
    mission.approvals = false; const input = { action: 'delete', path: '/workspace/old-folder', confirm: true };
    assert.equal(await tools.manage_mission_files.gate({ ...context, args: input }), 'ask');
    await reject(tools.manage_mission_files.run(input, context), 'mission-file-approval-required');
    for (const patch of [{ verdict: 'denied' }, { toolCallId: 'other' }, { agent: 'atlas' }, { args: { ...input, path: '/workspace/different' } }]) {
      approve(input, patch); await reject(tools.manage_mission_files.run(input, context), 'mission-file-approval-required');
    }
    approve(input); await tools.manage_mission_files.run(input, context);
    assert.lengthOf(calls, 1); assert.isTrue(calls[0].input.confirm); assert.equal(calls[0].input.path, '/workspace/old-folder');
  });
  it('does not trust model-selected owner, mission, actor, request ID or confirmation metadata', async () => {
    mission.approvals = false;
    await tools.manage_mission_files.run(write({ userId: 'intruder', missionId: 'other', actor: { agent: 'atlas' }, requestId: 'forged', confirm: true }), { ...context, agent: 'forged' });
    const call = calls[0]; assert.equal(call.userId, 'owner'); assert.equal(call.input.missionId, 'mission');
    assert.equal(call.actor.agent, 'signal'); assert.equal(call.requestId, 'child:call-1');
    for (const key of ['userId', 'actor', 'requestId', 'confirm']) assert.notProperty(call.input, key);
  });
  it('maps createFile to a no-overwrite write and never forwards an overwrite hash', async () => {
    mission.approvals = false;
    await tools.manage_mission_files.run({ action: 'createFile', path: '/workspace/new.txt', expectedHash: 'a'.repeat(64) }, context);
    assert.deepEqual(calls[0].input, { missionId: 'mission', path: '/workspace/new.txt', action: 'write', text: '' });
  });
  it('rejects retired mutation actions instead of attempting a fallback', async () => {
    mission.approvals = false;
    for (const action of ['trash', 'restore', 'restoreVersion', 'upload', 'execute']) await reject(tools.manage_mission_files.run(write({ action }), context), 'invalid-mission-file');
    assert.isEmpty(calls);
  });
  it('rechecks file permission immediately before the provider mutation', async () => {
    const input = write(); approve(input); beforeStorage = async () => { crew.capabilities.files = false; };
    await reject(tools.manage_mission_files.run(input, context), 'mission-file-access-off'); assert.isEmpty(calls);
  });
  it('rechecks environment membership and mission state immediately before the provider mutation', async () => {
    const input = write(); approve(input); beforeStorage = async () => { environment.allowedAgents = []; };
    await reject(tools.manage_mission_files.run(input, context), 'execution-environment-access');
    environment.allowedAgents = ['signal']; beforeStorage = async () => { stopped = true; };
    await reject(tools.manage_mission_files.run(input, context), 'mission-stopped'); assert.isEmpty(calls);
  });
  it('rechecks the exact approved arguments before a delete reaches the provider', async () => {
    mission.approvals = false; const input = { action: 'delete', path: '/workspace/old.txt' }; approve(input);
    beforeStorage = async () => { session.pending.args = { ...input, path: '/workspace/other.txt' }; };
    await reject(tools.manage_mission_files.run(input, context), 'mission-file-approval-required'); assert.isEmpty(calls);
  });
  it('does not return attachment data after the agent loses file access during a read', async () => {
    environment = null; afterStorage = async () => { crew.capabilities.files = false; };
    await reject(tools.read_mission_file.run({ location: 'attachments', attachmentId: 'original' }, context), 'mission-file-access-off');
    crew.capabilities.files = true;
    await reject(tools.list_mission_files.run({ location: 'attachments' }, context), 'mission-file-access-off');
  });
  it('returns bounded decoded text, hashes and metadata without base64 blobs', async () => {
    let file = await tools.read_mission_file.run({ path: '/workspace/report.md' }, context);
    assert.equal(file.text, 'hello'); assert.notProperty(file, 'content'); assert.isFalse(file.truncated); assert.equal(file.hash, 'a'.repeat(64));
    result.content = Buffer.from('a'.repeat(120010)).toString('base64');
    file = await tools.read_mission_file.run({ path: '/workspace/report.md' }, context); assert.lengthOf(file.text, 120000); assert.isTrue(file.truncated);
    for (const bytes of [Buffer.from([0, 255, 0]), Buffer.from([255]), Buffer.from('text\0hidden')]) {
      result.content = bytes.toString('base64'); file = await tools.read_mission_file.run({ location: 'attachments', attachmentId: 'original' }, context);
      assert.notProperty(file, 'text'); assert.notProperty(file, 'content'); assert.include(file.notice, 'Binary');
    }
  });
});
