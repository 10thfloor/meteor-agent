import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Agent, AgentSessions, AgentWorkflowRuns } from 'meteor/10thfloor:agent';

if (Meteor.isServer) describe('Constellation workflow authorization and revisions', function () {
  this.timeout(30_000);
  let runtime;
  let workflowRuntime;
  let ownerId;
  let temporaryWorkspace = false;
  let primaryFixtureId;
  const fixtures = [];

  before(async () => {
    runtime = await import('../server/main.js');
    workflowRuntime = await import('../server/mission-workflows.js');
    let workspace = await runtime.WorkspaceState.findOneAsync('local');
    if (!workspace) {
      temporaryWorkspace = true;
      workspace = { _id: 'local', ownerUserId: `workflow-owner-${Random.id()}`, createdAt: new Date() };
      await runtime.WorkspaceState.insertAsync(workspace);
    }
    ownerId = workspace.ownerUserId;
    if (!await runtime.CrewConfigs.findOneAsync({ userId: ownerId, agent: 'orchestrator', enabled: true, status: { $ne: 'archived' } })) {
      primaryFixtureId = `workflow-primary-${Random.id()}`;
      await runtime.CrewConfigs.insertAsync({ _id: primaryFixtureId, userId: ownerId, agent: 'orchestrator',
        primary: true, enabled: true, status: 'available', revision: 1, displayName: 'Workflow coordinator' });
    }
  });

  after(async () => {
    for (const row of fixtures) {
      // All test executions are review checkpoints: no external provider or
      // tool can race this owner-scoped fixture cleanup.
      await new Agent('orchestrator').erase(row.sessionId, { userId: row.userId });
      await workflowRuntime.MissionWorkflows.removeAsync({ _id: row.sessionId, userId: row.userId });
      await AgentWorkflowRuns.removeAsync({ missionId: row.sessionId, userId: row.userId });
      await runtime.MissionConfigs.removeAsync({ _id: row.sessionId, userId: row.userId });
      await runtime.CrewConfigs.removeAsync({ _id: row.agentId, userId: row.userId });
    }
    if (primaryFixtureId) await runtime.CrewConfigs.removeAsync({ _id: primaryFixtureId, userId: ownerId });
    if (temporaryWorkspace) await runtime.WorkspaceState.removeAsync({ _id: 'local', ownerUserId: ownerId });
  });

  const invoke = (name, args, userId = ownerId) => {
    const handler = Meteor.server.method_handlers[`constellation.${name}`];
    assert.isFunction(handler);
    return handler.call({ userId, connection: null }, args);
  };
  const rejected = async (work, code) => {
    let failure;
    try { await work; } catch (error) { failure = error; }
    assert.isDefined(failure, `Expected ${code}`);
    assert.equal(failure.error, code);
  };
  const awaitStatus = async (runId, status) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const run = await AgentWorkflowRuns.findOneAsync({ _id: runId, userId: ownerId });
      if (run?.status === status && !run.lease) return run;
      if (run?.status === 'failed') assert.fail(run.error);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`Run did not become ${status}`);
  };
  async function fixture(userId = ownerId) {
    const key = Random.id();
    const row = { sessionId: `workflow-app-${key}`, agentId: `workflow-app-identity-${key}`,
      agent: `workflow-app-agent-${key}`, userId };
    fixtures.push(row);
    const now = new Date();
    await runtime.CrewConfigs.insertAsync({ _id: row.agentId, userId, agent: row.agent,
      enabled: true, status: 'available', revision: 1, displayName: 'Workflow specialist' });
    await AgentSessions.insertAsync({ _id: row.sessionId, userId, agent: 'orchestrator', model: 'mock',
      phase: 'idle', nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 }, createdAt: now, updatedAt: now });
    await runtime.MissionConfigs.insertAsync({ _id: row.sessionId, sessionId: row.sessionId, userId,
      title: 'Workflow test', objective: 'Review the supplied result.', agents: [row.agent],
      status: 'active', revision: 1, debugTraces: false, budget: { turns: 4, toolCalls: 2, spend: 1 },
      createdAt: now, updatedAt: now });
    return row;
  }
  const review = (id = 'review', dependsOn = []) => ({
    id, label: 'Review results', primitive: 'approval', prompt: 'Check the result.', dependsOn,
  });
  const plan = (row, extra = {}) => ({
    missionId: row.sessionId, expectedRevision: 0, name: 'Review plan', strategy: 'workflow',
    steps: [review()], budget: { steps: 16, timeoutMs: 60_000, turns: 4, toolCalls: 2, spend: 1 }, ...extra,
  });

  it('rejects another account and an unrelated mission before saving or returning data', async () => {
    const own = await fixture();
    const foreign = await fixture(`workflow-foreign-${Random.id()}`);
    await invoke('workflowSave', plan(own));
    await rejected(invoke('workflowGet', { missionId: own.sessionId }, foreign.userId), 'workspace-owned');
    await rejected(invoke('workflowSave', plan(own), foreign.userId), 'workspace-owned');
    await rejected(invoke('workflowGet', { missionId: foreign.sessionId }), 'no-session');
    await rejected(invoke('workflowSave', plan(foreign)), 'no-session');
    assert.equal((await workflowRuntime.MissionWorkflows.findOneAsync(own.sessionId)).revision, 1);
    assert.notExists(await workflowRuntime.MissionWorkflows.findOneAsync(foreign.sessionId));
  });

  it('keeps saves revision-checked and refuses to start a stale plan version', async () => {
    const own = await fixture();
    assert.equal((await invoke('workflowSave', plan(own))).revision, 1);
    await rejected(invoke('workflowSave', plan(own, { name: 'Stale overwrite' })), 'workflow-conflict');
    assert.equal((await invoke('workflowSave', plan(own, { expectedRevision: 1, name: 'Updated plan' }))).revision, 2);
    await rejected(invoke('workflowRun', { missionId: own.sessionId, definitionRevision: 1, requestKey: Random.id() }), 'workflow-conflict');
    const current = await invoke('workflowGet', { missionId: own.sessionId });
    assert.equal(current.definition.name, 'Updated plan');
    assert.equal(current.definition.revision, 2);
    assert.notProperty(current.definition, 'definition');
    assert.lengthOf(current.runs, 0);
  });

  it('pins the current Crew revision and refuses removed agents or changed agent settings', async () => {
    const own = await fixture();
    const input = plan(own, { steps: [review(), { id: 'work', label: 'Specialist task', primitive: 'agent',
      agent: own.agent, prompt: 'Complete the reviewed work.', dependsOn: ['review'] }] });
    await invoke('workflowSave', input);
    await runtime.CrewConfigs.updateAsync(own.agentId, { $set: { revision: 2 } });
    await rejected(invoke('workflowRun', { missionId: own.sessionId, definitionRevision: 1, requestKey: Random.id() }), 'workflow-not-authorized');
    assert.equal(await AgentWorkflowRuns.find({ missionId: own.sessionId }).countAsync(), 0);
    await invoke('workflowSave', { ...input, expectedRevision: 1 });
    const saved = await workflowRuntime.MissionWorkflows.findOneAsync(own.sessionId);
    assert.equal(saved.definition.steps[1].input.revision, 2);
    await runtime.MissionConfigs.updateAsync(own.sessionId, { $set: { agents: [] } });
    await rejected(invoke('workflowSave', { ...input, expectedRevision: 2 }), 'workflow-agent-unavailable');
    assert.equal((await workflowRuntime.MissionWorkflows.findOneAsync(own.sessionId)).revision, 2);
  });

  it('normalizes coordination dependencies and bounds budgets by the Mission settings', async () => {
    const own = await fixture();
    await invoke('workflowSave', plan(own, { strategy: 'council', steps: [review('one'), review('two', ['one']), review('join', ['two'])],
      budget: { steps: 16, timeoutMs: 60_000, turns: 100, toolCalls: 100, spend: 100 } }));
    const { definition } = await invoke('workflowGet', { missionId: own.sessionId });
    assert.deepEqual(definition.steps.map((step) => step.dependsOn), [[], [], ['one', 'two']]);
    assert.deepInclude(definition.budget, { turns: 4, toolCalls: 2, spend: 1 });
    await rejected(invoke('workflowSave', plan(own, { expectedRevision: 1,
      budget: { ...definition.budget, timeoutMs: 61 * 60_000 } })), 'invalid-workflow');
  });

  it('deduplicates a run request and binds checkpoint approval to the exact owner and fingerprint', async () => {
    const own = await fixture();
    await invoke('workflowSave', plan(own));
    const request = { missionId: own.sessionId, definitionRevision: 1, requestKey: Random.id() };
    const { runId } = await invoke('workflowRun', request);
    assert.equal((await invoke('workflowRun', request)).runId, runId);
    const waiting = await awaitStatus(runId, 'awaiting');
    assert.equal(waiting.states.review.waitReason, 'approval');
    const pending = await invoke('workflowGet', { missionId: own.sessionId });
    assert.equal(pending.runs[0].steps[0].waitReason, 'approval');
    await rejected(invoke('workflowApprove', { runId, stepId: 'review', approved: true,
      fingerprint: waiting.states.review.fingerprint }, `another-${Random.id()}`), 'workspace-owned');
    await rejected(invoke('workflowApprove', { runId, stepId: 'review', approved: true, fingerprint: 'stale' }), 'workflow-review-changed');
    await invoke('workflowApprove', { runId, stepId: 'review', approved: true, fingerprint: waiting.states.review.fingerprint });
    await awaitStatus(runId, 'completed');
    const { runs } = await invoke('workflowGet', { missionId: own.sessionId });
    assert.lengthOf(runs, 1);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].steps[0].approval.userId, ownerId);
    assert.notProperty(runs[0].steps[0], 'waitReason');
    assert.notProperty(runs[0], 'definition');
    assert.notProperty(runs[0].steps[0], 'receipt');
    assert.notProperty(runs[0].steps[0], 'output');
  });
});
