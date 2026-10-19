import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import {
  Agent, AgentSessions, AgentMessages, AgentObservations, AgentWorkflowRuns,
  startAgentTrace, finishAgentTrace, startEvidenceSpan, finishEvidenceSpan,
  captureToolAudit, captureTurnManifest, captureObservations,
} from 'meteor/10thfloor:agent';
import { LOCAL_MODEL } from '../imports/constellation/models.js';

const draft = {
  expectationBasis: 'explicit', expected: 'The reference URL would resolve.',
  observed: 'The reference URL returned 404.', difference: 'The reference moved.',
  lesson: 'Verify references before citing them.', context: 'reference checks', confidence: 0.95,
};

if (Meteor.isServer) describe('Constellation evidence authorization and review', function () {
  this.timeout(30000);
  let runtime; let ownerId; let temporaryWorkspace = false;
  const fixtures = [];

  before(async () => {
    runtime = await import('../server/main.js');
    let workspace = await runtime.WorkspaceState.findOneAsync('local');
    if (!workspace) {
      temporaryWorkspace = true;
      workspace = { _id: 'local', ownerUserId: `evidence-owner-${Random.id()}`, createdAt: new Date() };
      await runtime.WorkspaceState.insertAsync(workspace);
    }
    ownerId = workspace.ownerUserId;
  });
  after(async () => {
    for (const fixture of fixtures) {
      await new Agent(fixture.agent).erase(fixture.sessionId, { userId: fixture.userId });
      await runtime.CrewConfigs.removeAsync(fixture.agentId);
      await runtime.MissionConfigs.removeAsync(fixture.sessionId);
    }
    if (temporaryWorkspace) await runtime.WorkspaceState.removeAsync({ _id: 'local', ownerUserId: ownerId });
  });

  const invoke = (name, args, userId = ownerId) => {
    const handler = Meteor.server.method_handlers[`constellation.${name}`];
    assert.isFunction(handler);
    return handler.call({ userId, connection: null }, args);
  };
  async function denied(work) {
    let failure;
    try { await work; } catch (error) { failure = error; }
    assert.isDefined(failure, 'the inaccessible target must be rejected');
    assert.include(['not-found', 'not-authorized', 'workspace-owned'], failure.error);
  }

  async function fixture(userId = ownerId) {
    const key = Random.id(); const sessionId = `app-evidence-${key}`;
    const agent = `app-evidence-agent-${key}`; const agentId = `app-evidence-identity-${key}`;
    const now = new Date();
    const record = { sessionId, agent, agentId, userId };
    fixtures.push(record);
    await runtime.CrewConfigs.insertAsync({ _id: agentId, agent, userId,
      enabled: true, status: 'active', experience: { record: true, reflect: false, approval: 'ask' } });
    await AgentSessions.insertAsync({ _id: sessionId, agent, userId, phase: 'stopped', model: 'mock', nextSeq: 3,
      usage: { input: 0, output: 0, cost: 0 }, budgetSpent: { turns: 0, toolCalls: 0 }, createdAt: now, updatedAt: now });
    await runtime.MissionConfigs.insertAsync({ _id: sessionId, sessionId, userId, title: 'Evidence test', debugTraces: false, status: 'active' });
    const messages = [
      { _id: `${sessionId}:0`, sessionId, role: 'user', seq: 0, content: 'Check the reference.', createdAt: now },
      { _id: `${sessionId}:1`, sessionId, role: 'tool', seq: 1, toolCallId: 'check-reference',
        content: '{"privateTransportPayload":"never-in-normal-source"}', displayContent: 'Reference checked', createdAt: now },
      { _id: `${sessionId}:2`, sessionId, role: 'assistant', seq: 2, content: 'The supplied reference returned 404.', createdAt: now },
    ];
    for (const message of messages) await AgentMessages.insertAsync(message);
    await Agent.learning.ensureIdentity({ id: agentId, name: agent });
    const { value: frame } = await Agent.learning.freezeFrame({ sessionId, agentId, triggerSeq: 0,
      context: 'reference checks', audience: { scope: 'owner', key: userId },
      learningPolicy: { experienceRecording: true, experienceRecallLimit: 0, experienceAdmission: 'reviewed',
        practiceAcquisition: 'disabled', allowScopedEvidencePromotion: false } });
    const trace = await startAgentTrace({ sessionId, agent, agentId, memoryFrameId: frame._id, triggerSeq: 0 });
    await captureTurnManifest({ traceId: trace._id, sessionId, agent, model: 'mock', tools: [], frame, messages });
    const span = await startEvidenceSpan({ sessionId, traceId: trace._id, kind: 'tool', name: 'reference', summary: 'Reference checked' });
    await captureToolAudit(span, { internalDetails: 'visible-only-in-explicit-debug', apiKey: 'never-expose-test-key' });
    await finishEvidenceSpan(span, { status: 'completed', summary: 'Reference checked' });
    await finishAgentTrace(trace._id, 'completed');
    const observation = await captureObservations({ sessionId, agentId, frameId: frame._id, throughSeq: 2 });
    return { ...record, traceId: trace._id, observationId: observation._id };
  }

  async function completedWorkflow() {
    const child = await fixture();
    const rootId = `reflection-root-${Random.id()}`;
    const runId = `reflection-run-${Random.id()}`;
    const now = new Date();
    fixtures.push({ sessionId: rootId, userId: ownerId, agent: 'orchestrator', agentId: `unused-${Random.id()}` });
    await AgentSessions.insertAsync({ _id: rootId, userId: ownerId, agent: 'orchestrator', model: LOCAL_MODEL,
      phase: 'idle', nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 }, createdAt: now, updatedAt: now });
    await runtime.MissionConfigs.insertAsync({ _id: rootId, sessionId: rootId, userId: ownerId,
      title: 'Completed reflection test', status: 'active', revision: 1, agents: [child.agent],
      budget: { turns: 4, toolCalls: 2, spend: 1 }, createdAt: now, updatedAt: now });
    await runtime.CrewConfigs.updateAsync(child.agentId, { $set: {
      revision: 1, model: LOCAL_MODEL, budget: { spend: 1 }, 'experience.reflect': true,
    } });
    await AgentSessions.updateAsync(child.sessionId, { $set: { phase: 'idle',
      parent: { sessionId: rootId, toolCallId: `workflow:${runId}:answer` } } });
    await AgentWorkflowRuns.insertAsync({ _id: runId, namespace: 'constellation', userId: ownerId,
      missionId: rootId, status: 'completed', definitionRevision: 1, name: 'Reflection test',
      strategy: 'workflow', executions: 1, activeMs: 10, createdAt: now, updatedAt: now, finishedAt: now,
      definition: { id: rootId, revision: 1, name: 'Reflection test', strategy: 'workflow',
        budget: { steps: 4, timeoutMs: 60000, turns: 4, toolCalls: 2, spend: 1 },
        steps: [{ id: 'answer', label: 'Answer', primitive: 'agent', version: 1,
          input: { agent: child.agent, prompt: 'Check the reference.', revision: 1 }, dependsOn: [] }] },
      states: { answer: { id: 'answer', label: 'Answer', primitive: 'agent', agent: child.agent,
        status: 'completed', attempts: 1, fingerprint: 'reflection-fixture', childSessionId: child.sessionId,
        completedAt: now } },
    });
    return { ...child, rootId, runId };
  }

  async function rejectsCode(work, code) {
    let failure;
    try { await work; } catch (error) { failure = error; }
    assert.equal(failure?.error, code);
  }

  it('requires both explicit debug request and the owning Mission debug setting', async () => {
    const current = await fixture();
    const normal = await invoke('sessionEvidence', { sessionId: current.sessionId });
    assert.notProperty(normal, 'debug');
    const disabled = await invoke('sessionEvidence', { sessionId: current.sessionId, includeDebug: true });
    assert.notProperty(disabled, 'debug');
    await runtime.MissionConfigs.updateAsync(current.sessionId, { $set: { debugTraces: true } });
    const stillNormal = await invoke('sessionEvidence', { sessionId: current.sessionId });
    assert.notProperty(stillNormal, 'debug');
    const debug = await invoke('sessionEvidence', { sessionId: current.sessionId, includeDebug: true });
    assert.include(JSON.stringify(debug.debug), 'visible-only-in-explicit-debug');
    assert.notInclude(JSON.stringify(debug), 'never-expose-test-key');
    await denied(invoke('sessionEvidence', { sessionId: current.sessionId, includeDebug: true }, `other-${Random.id()}`));
  });

  it('rejects foreign sessions and observation IDs even when the caller owns the supplied session', async () => {
    const own = await fixture(); const foreign = await fixture(`foreign-${Random.id()}`);
    await denied(invoke('sessionEvidence', { sessionId: foreign.sessionId }));
    for (const method of ['observationSources', 'observationReflect', 'observationAdmit', 'observationDismiss']) {
      await denied(invoke(method, { sessionId: own.sessionId, observationId: foreign.observationId, draft }));
    }
    assert.equal((await AgentObservations.findOneAsync(foreign.observationId)).status, 'recorded');
  });

  it('returns human source projections and binds feedback to the supplied conversation', async () => {
    const own = await fixture(); const other = await fixture();
    const source = await invoke('observationSources', { sessionId: own.sessionId, observationId: own.observationId });
    assert.equal(source.messages.find((message) => message.role === 'tool').content, 'Reference checked');
    assert.notInclude(JSON.stringify(source), 'never-in-normal-source');
    assert.notInclude(JSON.stringify(source), 'toolCallId');
    await denied(invoke('evidenceFeedback', { sessionId: own.sessionId, traceId: other.traceId, rating: 'positive' }));
    await invoke('evidenceFeedback', { sessionId: own.sessionId, traceId: own.traceId, rating: 'positive' });
    const evidence = await invoke('sessionEvidence', { sessionId: own.sessionId });
    assert.lengthOf(evidence.feedback, 1);
    assert.equal(evidence.feedback[0].actorId, ownerId);
  });

  it('keeps a human-edited draft pending until explicit reviewed admission', async () => {
    const own = await fixture();
    const candidate = await invoke('observationReflect', { sessionId: own.sessionId,
      observationId: own.observationId, draft: { ...draft, admission: 'automatic' } });
    assert.equal(candidate.status, 'candidate');
    assert.equal(await Agent.learning.read.experiences([own.agentId]).countAsync(), 0);
    const admitted = await invoke('observationAdmit', { sessionId: own.sessionId, observationId: own.observationId });
    assert.equal(admitted.status, 'admitted');
    const experiences = await Agent.learning.read.experiences([own.agentId]).fetchAsync();
    assert.lengthOf(experiences, 1);
    assert.equal(experiences[0].admission, 'reviewed');
    assert.equal(experiences[0].source.actorId, ownerId);
  });

  it('reflects after a successful workflow finishes without reopening planning or tool execution', async () => {
    const own = await completedWorkflow();
    await rejectsCode(runtime.requireActiveMissionExecution(own.sessionId, own.agent), 'workflow-inactive');
    const reflected = await invoke('observationReflect', { sessionId: own.sessionId, observationId: own.observationId });
    assert.equal(reflected.status, 'recorded', 'offline reflection preserves the source without inventing a lesson');
    assert.isFalse(reflected.processing);
    const config = await runtime.CrewConfigs.findOneAsync(own.agentId);
    const provider = await runtime.reflectionProviderFor(config, own.sessionId);
    assert.isTrue(provider.scripted);
    const attempt = provider.provider.stream(provider.request({ model: LOCAL_MODEL, system: '', messages: [],
      tools: [{ name: 'forbidden', description: 'Must not run', args: { type: 'object' } }] }));
    await rejectsCode(attempt.next(), 'reflection-tools-forbidden');
    for (const status of ['failed', 'cancelled']) {
      await AgentWorkflowRuns.updateAsync(own.runId, { $set: { status } });
      await rejectsCode(invoke('observationReflect', { sessionId: own.sessionId, observationId: own.observationId }), 'workflow-inactive');
    }
  });

  it('retains live owner, Mission, Crew revision, membership, and spend fences for completed reflection', async () => {
    const own = await completedWorkflow();
    const check = () => runtime.reflectionProviderFor({ agent: own.agent, model: LOCAL_MODEL }, own.sessionId);
    await runtime.CrewConfigs.updateAsync(own.agentId, { $set: { revision: 2 } });
    await rejectsCode(check(), 'workflow-not-authorized');
    await runtime.CrewConfigs.updateAsync(own.agentId, { $set: { revision: 1, enabled: false } });
    await rejectsCode(check(), 'workflow-not-authorized');
    await runtime.CrewConfigs.updateAsync(own.agentId, { $set: { enabled: true } });
    await runtime.MissionConfigs.updateAsync(own.rootId, { $set: { status: 'paused' } });
    await rejectsCode(check(), 'workflow-not-authorized');
    await runtime.MissionConfigs.updateAsync(own.rootId, { $set: { status: 'active', agents: [] } });
    await rejectsCode(check(), 'workflow-not-authorized');
    await runtime.MissionConfigs.updateAsync(own.rootId, { $set: { agents: [own.agent] } });
    await AgentSessions.updateAsync(own.sessionId, { $set: { 'usage.cost': 1 } });
    await rejectsCode(check(), 'workflow-budget');
    await AgentSessions.updateAsync(own.sessionId, { $set: { 'usage.cost': 0 } });
    await AgentWorkflowRuns.updateAsync(own.runId, { $set: { userId: `another-${Random.id()}` } });
    await rejectsCode(check(), 'workflow-unavailable');
    await AgentWorkflowRuns.updateAsync(own.runId, { $set: { userId: ownerId } });
  });
});
