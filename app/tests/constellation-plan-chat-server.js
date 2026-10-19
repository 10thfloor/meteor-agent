import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Agent, AgentSessions, AgentMessages, AgentWorkflowRuns, NAMES } from 'meteor/10thfloor:agent';
import { planHandleBase, planReferenceHandles, parsePlanRunCommand } from '../imports/constellation/plan-references';

describe('Constellation plan reference grammar', () => {
  it('recognizes only a complete, explicit run command', () => {
    assert.deepEqual(parsePlanRunCommand(' Run #launch-review! '), { handle: 'launch-review' });
    assert.deepEqual(parsePlanRunCommand('Run this mission’s plan.'), { currentMission: true });
    for (const message of ['#launch-review', 'Review #launch-review before we run it', '@Atlas run #launch-review',
      'Do not run #launch-review', 'Can you run #launch-review?', 'Run #launch-review if approved',
      '"Run #launch-review"', 'Run #launch-review and #another', 'Run #launch-review\nthen publish']) {
      assert.isNull(parsePlanRunCommand(message), message);
    }
  });
  it('provides stable readable slug bases and unambiguous mention tokens', () => {
    assert.equal(planHandleBase(' Launch Réview! '), 'launch-review');
    assert.equal(planHandleBase('🤝'), 'plan');
    assert.deepEqual(planReferenceHandles('Compare #Launch-review with (#another). #Launch-review'), ['launch-review', 'another']);
    assert.deepEqual(planReferenceHandles('https://example.com/#anchor user#name'), []);
  });
  it('ignores inline file/code spans with exact-length delimiters and preserves ordinary references', () => {
    assert.deepEqual(planReferenceHandles('Review #launch-review using `/workspace/report #another.md`.'), ['launch-review']);
    assert.deepEqual(planReferenceHandles('Files: ``/workspace/a `tick` #file.md``\nDiscuss #release.'), ['release']);
    assert.deepEqual(planReferenceHandles('Files: ```/workspace/one ``two`` #three.md```\n#real'), ['real']);
    assert.deepEqual(planReferenceHandles('`literal\n#not-a-plan` #real'), ['real']);
    assert.deepEqual(planReferenceHandles('`code`#adjacent and (#real)'), ['real'], 'code masking preserves token boundaries');
    assert.deepEqual(planReferenceHandles('An unmatched ` mark before #real'), ['real']);
    assert.deepEqual(planReferenceHandles('Escaped \\` delimiter before #real'), ['real']);
    assert.deepEqual(planReferenceHandles('`unclosed\n\n#real after a paragraph break'), ['real']);
  });
  it('ignores fenced code including longer, tilde, quoted, and unfinished fences', () => {
    assert.deepEqual(planReferenceHandles('#before\n```md\n#inside\n```\n#after'), ['before', 'after']);
    assert.deepEqual(planReferenceHandles('````\n```\n#inside\n`````\n#after'), ['after']);
    assert.deepEqual(planReferenceHandles('  ~~~text\r\n#inside\r\n  ~~~~\r\n#after'), ['after']);
    assert.deepEqual(planReferenceHandles('> ```\n> #inside\n> ```\n#after'), ['after']);
    assert.deepEqual(planReferenceHandles('#before\n```\n#unfinished'), ['before']);
    assert.deepEqual(planReferenceHandles('`unmatched\n```\n#inside\n```\n#outside `'), ['outside']);
  });
});

if (Meteor.isServer) describe('Constellation plan chat authorization and execution', function () {
  this.timeout(30_000);
  let runtime;
  let workflows;
  let ownerId;
  let temporaryWorkspace = false;
  let primaryFixtureId;
  const fixtures = [];
  const invoke = (name, args, userId = ownerId) => Meteor.server.method_handlers[`constellation.${name}`]
    .call({ userId, connection: null }, args);
  const rejected = async (work, code) => {
    let failure;
    try { await work; } catch (caught) { failure = caught; }
    assert.isDefined(failure, `Expected ${code}`);
    assert.equal(failure.error, code);
  };
  before(async () => {
    runtime = await import('../server/main.js');
    workflows = await import('../server/mission-workflows.js');
    let workspace = await runtime.WorkspaceState.findOneAsync('local');
    if (!workspace) {
      temporaryWorkspace = true;
      workspace = { _id: 'local', ownerUserId: `plan-chat-owner-${Random.id()}`, createdAt: new Date() };
      await runtime.WorkspaceState.insertAsync(workspace);
    }
    ownerId = workspace.ownerUserId;
    if (!await runtime.CrewConfigs.findOneAsync({ userId: ownerId, agent: 'orchestrator', enabled: true, status: { $ne: 'archived' } })) {
      primaryFixtureId = `plan-chat-primary-${Random.id()}`;
      await runtime.CrewConfigs.insertAsync({ _id: primaryFixtureId, userId: ownerId, agent: 'orchestrator',
        primary: true, enabled: true, status: 'available', revision: 1, displayName: 'Plan coordinator' });
    }
  });
  after(async () => {
    const runs = await AgentWorkflowRuns.find({ userId: ownerId, missionId: { $in: fixtures.map((row) => row.sessionId) } }).fetchAsync();
    for (const run of runs) await invoke('workflowCancel', { runId: run._id });
    const deadline = Date.now() + 5000;
    while (await AgentWorkflowRuns.find({ _id: { $in: runs.map((run) => run._id) }, lease: { $exists: true } }).countAsync()) {
      assert.isBelow(Date.now(), deadline, 'test workflow workers must settle before removing their workspace');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const row of fixtures) {
      await AgentSessions.updateAsync(row.sessionId, { $unset: { erasingAt: 1 } });
      await new Agent('orchestrator').erase(row.sessionId, { userId: row.userId });
      await workflows.MissionWorkflows.removeAsync({ _id: row.sessionId, userId: row.userId });
      await AgentWorkflowRuns.removeAsync({ missionId: row.sessionId, userId: row.userId });
      await workflows.MissionPlanChatRequests.removeAsync({ originChatId: row.sessionId, userId: row.userId });
      await runtime.MissionConfigs.removeAsync({ _id: row.sessionId, userId: row.userId });
    }
    if (primaryFixtureId) await runtime.CrewConfigs.removeAsync({ _id: primaryFixtureId, userId: ownerId });
    if (temporaryWorkspace) {
      await runtime.WorkspaceState.removeAsync({ _id: 'local', ownerUserId: ownerId });
      assert.notExists(await runtime.WorkspaceState.findOneAsync('local'));
    }
  });
  async function fixture(userId = ownerId) {
    const row = { sessionId: `plan-chat-${Random.id()}`, userId };
    fixtures.push(row);
    const now = new Date();
    await AgentSessions.insertAsync({ _id: row.sessionId, userId, agent: 'orchestrator', model: 'mock',
      phase: 'idle', nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 }, createdAt: now, updatedAt: now });
    await runtime.MissionConfigs.insertAsync({ _id: row.sessionId, sessionId: row.sessionId, userId,
      title: `Mission ${row.sessionId}`, objective: 'Review the supplied result.', agents: [],
      status: 'active', revision: 1, debugTraces: false, budget: { turns: 4, toolCalls: 2, spend: 1 },
      createdAt: now, updatedAt: now });
    return row;
  }
  const save = (row, extra = {}) => invoke('workflowSave', { missionId: row.sessionId, expectedRevision: 0,
    name: 'Review launch', strategy: 'workflow', steps: [{ id: 'review', label: 'Review results',
      primitive: 'approval', prompt: 'Check the unique launch evidence.', dependsOn: [] }],
    budget: { steps: 8, timeoutMs: 60_000, turns: 4, toolCalls: 2, spend: 1 }, ...extra });
  const reference = async (row) => {
    const { plans } = await invoke('workflowPlans', { missionId: row.sessionId });
    const plan = plans.find((item) => item.missionId === row.sessionId);
    return { handle: plan.handle, missionId: plan.missionId, revision: plan.revision };
  };
  const send = (row, text, references, extra = {}) => invoke('workflowChatSend', {
    missionId: row.sessionId, text, references, requestKey: Random.id(), ...extra,
  });

  it('lists only owned live roots, backfills stable handles, and distinguishes duplicate names', async () => {
    const first = await fixture();
    const second = await fixture();
    const erasing = await fixture();
    const foreign = await fixture(`plan-chat-foreign-${Random.id()}`);
    await save(first);
    await save(second);
    await save(erasing);
    await workflows.MissionWorkflows.updateAsync(first.sessionId, { $unset: { handle: 1 } });
    await workflows.MissionWorkflows.insertAsync({ _id: foreign.sessionId, userId: foreign.userId,
      missionId: foreign.sessionId, name: 'Private plan', revision: 1, steps: [] });
    await AgentSessions.updateAsync(erasing.sessionId, { $set: { erasingAt: new Date() } });
    const { plans } = await invoke('workflowPlans', { missionId: second.sessionId });
    assert.equal(plans[0].missionId, second.sessionId);
    const own = plans.find((item) => item.missionId === first.sessionId);
    assert.match(own.handle, /^review-launch(?:-[a-f0-9]{8})?$/);
    assert.notEqual(own.handle, plans[0].handle);
    assert.deepInclude(own, { stepCount: 1, status: 'active' });
    assert.notInclude(plans.map((item) => item.missionId), erasing.sessionId);
    assert.notInclude(plans.map((item) => item.missionId), foreign.sessionId);
    await save(first, { expectedRevision: 1, name: 'Renamed launch plan' });
    assert.equal((await reference(first)).handle, own.handle);
    await rejected(invoke('workflowPlans', {}, foreign.userId), 'workspace-owned');
    await rejected(invoke('workflowPlans', { missionId: foreign.sessionId }), 'no-session');
  });

  it('runs a referenced plan in its original mission exactly once and records one non-waking user message', async () => {
    const origin = await fixture();
    const target = await fixture();
    await save(target);
    const ref = await reference(target);
    const text = `Run #${ref.handle}`;
    const args = { missionId: origin.sessionId, text, references: [ref], requestKey: Random.id(), recipient: 'm:not-a-plan-override' };
    const outcomes = await Promise.all([invoke('workflowChatSend', args), invoke('workflowChatSend', args)]);
    assert.equal(outcomes[0].runId, outcomes[1].runId);
    assert.deepInclude(outcomes[0], { kind: 'run', missionId: target.sessionId, originChatId: origin.sessionId, definitionRevision: 1 });
    assert.equal(await AgentWorkflowRuns.find({ missionId: target.sessionId }).countAsync(), 1);
    assert.equal(await AgentWorkflowRuns.find({ missionId: origin.sessionId }).countAsync(), 0);
    const messages = await AgentMessages.find({ sessionId: origin.sessionId }).fetchAsync();
    assert.lengthOf(messages, 1);
    assert.deepInclude(messages[0], { role: 'user', kind: 'crew-note', content: text });
    assert.equal((await AgentSessions.findOneAsync(origin.sessionId)).budgetSpent.turns, 0);
    const run = await AgentWorkflowRuns.findOneAsync(outcomes[0].runId);
    assert.deepInclude(workflows.publicWorkflowRun(run), { originChatId: origin.sessionId, planHandle: ref.handle });
    assert.instanceOf(workflows.publicWorkflowRun(run).chatPostedAt, Date);
    assert.isAtLeast(run.chatPostedAt.getTime(), messages[0].createdAt.getTime(), 'chat position follows the committed request');
    await save(target, { expectedRevision: 1, name: 'New version' });
    assert.equal((await invoke('workflowChatSend', args)).runId, run._id, 'retry must not substitute version two');
    assert.equal((await invoke('workflowChatSend', { ...args, recipient: 'm:different-chat-selection' })).runId, run._id,
      'a chat recipient does not reroute or duplicate an explicitly launched plan');
    assert.notProperty(await workflows.MissionPlanChatRequests.findOneAsync({ originChatId: origin.sessionId }), 'recipient');
    assert.equal((await AgentWorkflowRuns.findOneAsync(run._id)).chatPostedAt.getTime(), run.chatPostedAt.getTime(),
      'retry must not move the run card to the end of the conversation');
    await rejected(invoke('workflowChatSend', { ...args, text: `Review #${ref.handle}` }), 'workflow-request-conflict');
    await invoke('workflowCancel', { runId: run._id });
  });

  it('refuses forged, stale, missing and paused plans without starting work', async () => {
    const origin = await fixture();
    const target = await fixture();
    await save(target);
    const ref = await reference(target);
    await rejected(send(origin, `Run #${ref.handle}`, [{ ...ref, missionId: origin.sessionId }]), 'workflow-conflict');
    await save(target, { expectedRevision: 1 });
    await rejected(send(origin, `Run #${ref.handle}`, [ref]), 'workflow-conflict');
    await rejected(send(origin, 'Run #not-an-accessible-plan', []), 'workflow-not-found');
    await rejected(send(origin, "Run this mission's plan", []), 'workflow-not-saved');
    await runtime.MissionConfigs.updateAsync(target.sessionId, { $set: { status: 'paused' } });
    let failure;
    try { await send(origin, `Run #${ref.handle}`, [await reference(target)]); } catch (caught) { failure = caught; }
    assert.isDefined(failure);
    assert.equal(await AgentWorkflowRuns.find({ missionId: target.sessionId }).countAsync(), 0);
    assert.equal(await AgentMessages.find({ sessionId: origin.sessionId }).countAsync(), 0);
    const denied = await workflows.MissionPlanChatRequests.findOneAsync({ originChatId: origin.sessionId, kind: 'run' });
    assert.isString(denied.recoveryError, 'a surfaced denial is excluded from automatic crash recovery');
    await runtime.MissionConfigs.updateAsync(target.sessionId, { $set: { status: 'active' } });
    assert.equal(await workflows.MissionPlanChatRequests.find({ _id: denied._id, completedAt: { $exists: false },
      recoveryError: { $exists: false } }).countAsync(), 0, 'reactivating a mission does not schedule its denied request');
  });

  it('treats run text in note mode as a note, never a launch', async () => {
    const own = await fixture();
    await save(own);
    const ref = await reference(own);
    const text = `Run #${ref.handle}`;
    const requestKey = Random.id();
    const result = await send(own, text, [ref], { mode: 'note', requestKey, recipient: 'm:not-on-the-roster' });
    assert.equal(result.kind, 'note');
    await send(own, text, [ref], { mode: 'note', requestKey });
    assert.equal(await AgentWorkflowRuns.find({ missionId: own.sessionId }).countAsync(), 0);
    assert.equal(await AgentMessages.find({ sessionId: own.sessionId }).countAsync(), 1);
    assert.notProperty(await workflows.MissionPlanChatRequests.findOneAsync({ originChatId: own.sessionId }), 'recipient');
    assert.notProperty(await AgentMessages.findOneAsync({ sessionId: own.sessionId }), 'to');
  });

  it('passes plan-context recipients through the framework send method and binds retries to that recipient', async () => {
    const own = await fixture(); await save(own); const ref = await reference(own);
    const originalSend = Meteor.server.method_handlers[NAMES.mSend]; const routed = [];
    Meteor.server.method_handlers[NAMES.mSend] = async function fakeSend(agent, sessionId, text, key, options) {
      routed.push({ agent, sessionId, text, key, options });
      // Exercise the real idempotent transcript path without scheduling a model.
      return Meteor.server.method_handlers[NAMES.mContribute].call(this, agent, sessionId, text, key);
    };
    try {
      const args = { missionId: own.sessionId, text: `Review #${ref.handle}`, references: [ref], requestKey: Random.id(), recipient: 'm:researcher' };
      const first = await invoke('workflowChatSend', args);
      assert.equal(first.kind, 'message'); assert.deepEqual(routed[0].options, { to: 'm:researcher' });
      assert.equal(routed[0].text, args.text); assert.equal(routed[0].agent, 'orchestrator');
      assert.equal((await workflows.MissionPlanChatRequests.findOneAsync({ originChatId: own.sessionId })).recipient, 'm:researcher');
      await invoke('workflowChatSend', args); assert.lengthOf(routed, 1, 'a completed retry must not send again');
      await rejected(invoke('workflowChatSend', { ...args, recipient: 'm:critic' }), 'workflow-request-conflict');
      await rejected(invoke('workflowChatSend', { ...args, recipient: undefined }), 'workflow-request-conflict');
      assert.lengthOf(routed, 1); assert.equal(await AgentMessages.find({ sessionId: own.sessionId }).countAsync(), 1);
    } finally { Meteor.server.method_handlers[NAMES.mSend] = originalSend; }
  });

  it('refuses unavailable or malformed plan-context recipients before any model wake or transcript input', async () => {
    const own = await fixture(); await save(own); const ref = await reference(own);
    await AgentSessions.updateAsync(own.sessionId, { $set: { participants: [
      { id: `h:${ownerId}`, kind: 'human', userId: ownerId, displayName: 'Owner' },
      { id: 'm:orchestrator', kind: 'model', agent: 'orchestrator', displayName: 'Atlas' },
    ] } });
    for (const recipient of ['m:not-in-mission', `h:${ownerId}`]) {
      await rejected(send(own, `Review #${ref.handle}`, [ref], { recipient }), 'recipient-unavailable');
    }
    for (const recipient of ['', 1, { to: 'm:orchestrator' }, 'm:' + 'a'.repeat(160), 'm:bad\nrecipient']) {
      await rejected(send(own, `Review #${ref.handle}`, [ref], { recipient }), 'invalid-plan-reference');
    }
    assert.equal(await AgentMessages.find({ sessionId: own.sessionId }).countAsync(), 0);
    assert.equal(await AgentWorkflowRuns.find({ missionId: own.sessionId }).countAsync(), 0);
    assert.equal((await AgentSessions.findOneAsync(own.sessionId)).budgetSpent.turns, 0);
  });

  it('passes frozen readable plan content to discussion without exposing it in the transcript or starting a plan', async () => {
    const own = await fixture();
    await save(own);
    const ref = await reference(own);
    const message = `@Atlas review #${ref.handle} before we run it`;
    const originalSend = Meteor.server.method_handlers[NAMES.mSend];
    let routedText;
    // Preserve the real transactional transcript path, but deliberately use a
    // note for this test so no real/scripted provider or external tool runs.
    Meteor.server.method_handlers[NAMES.mSend] = async function fakeSend(agent, sessionId, text, key) {
      routedText = text;
      return Meteor.server.method_handlers[NAMES.mContribute].call(this, agent, sessionId, text, key);
    };
    try {
      const result = await send(own, message, [ref]);
      assert.equal(result.kind, 'message');
      assert.equal(routedText, message);
      assert.equal(await AgentWorkflowRuns.find({ missionId: own.sessionId }).countAsync(), 0);
      const context = await workflows.planContextForRequest({ messages: [{ role: 'user', content: `[Owner]: ${message}` }] }, own.sessionId);
      assert.include(context, 'Check the unique launch evidence.');
      assert.include(context, 'saved version 1');
      assert.include(context, 'read-only context');
      const hooked = await runtime.withPlanReferences({ system: 'Base instructions.', messages: [{ role: 'user', content: message }] },
        { sessionId: own.sessionId, purpose: 'think' });
      assert.include(hooked.system, 'Base instructions.');
      assert.include(hooked.system, 'Check the unique launch evidence.');
      assert.notInclude((await AgentMessages.findOneAsync({ sessionId: own.sessionId })).content, 'unique launch evidence');
      await save(own, { expectedRevision: 1, steps: [{ id: 'review', label: 'New review', primitive: 'approval',
        prompt: 'Different evidence in version two.', dependsOn: [] }] });
      const frozen = await workflows.planContextForRequest({ messages: [{ role: 'user', content: message }] }, own.sessionId);
      assert.include(frozen, 'saved version 1');
      assert.notInclude(frozen, 'Different evidence in version two.');
      assert.equal(await workflows.planContextForRequest({ messages: [{ role: 'user', content: 'Unrelated question' }] }, own.sessionId), '');
    } finally { Meteor.server.method_handlers[NAMES.mSend] = originalSend; }
  });
});
