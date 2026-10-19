import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import {
  normalizeDecisionNode, normalizeDecisionState, normalizeDecisionDefinition,
  validateDecisionResponse, decisionAssertions,
} from '../imports/constellation/decisions';

const definition = { model: 'jev-latest', questions: {
  route: { type: 'choice', instructions: 'Which team should handle the request in `context`?', criteria: { support: 'Product help', billing: 'Payments', none: 'Neither team' } },
  urgent: { type: 'noul', instructions: 'Is a response needed today?' },
  impact: { type: 'score', instructions: 'How much work is blocked?', criteria: ['No work blocked', 'Some work blocked', 'All work blocked'] },
} };
const response = { model: 'jev-1.13.0', answers: {
  route: { type: 'choice', choice: 'support', confidence: 0.9, probabilities: { support: 0.96, billing: 0.03, none: 0.01 } },
  urgent: { type: 'noul', noul: 0.8 },
  impact: { type: 'score', score: 1.4, confidence: 0.8, probabilities: { 0: 0, 1: 0.6, 2: 0.4 }, legend: { 0: 'No work blocked', 1: 'Some work blocked', 2: 'All work blocked' } },
}, usage: { input_tokens: 200, output_tokens: 35 } };
const input = () => ({ name: 'Route requests', description: 'Select a team and assess urgency.', definition: structuredClone(definition), agentIds: ['tester'],
  fixtures: [{ id: 'help', name: 'Product help', state: { context: 'Help me use this product today.' }, expected: { route: 'support', urgent: { min: 0.7, max: 1 } } }] });

describe('Constellation Decisions validation', function () {
  it('validates batched independent typed questions and named inputs', () => {
    const node = normalizeDecisionNode(input());
    assert.lengthOf(Object.keys(node.definition.questions), 3);
    assert.deepEqual(normalizeDecisionState('Product help', node), { context: 'Product help' });
    assert.throws(() => normalizeDecisionState({ context: 'Help', secret: 'not-declared' }, node), /not declared/);
    assert.throws(() => normalizeDecisionState({}, node), /required/);
  });
  it('rejects unsafe schemas, unbounded definitions and incomplete expected answers', () => {
    assert.throws(() => normalizeDecisionDefinition({ questions: { bad: { type: 'score', instructions: 'Rate this', criteria: ['Only level'] } } }), /2–10/);
    assert.throws(() => normalizeDecisionNode({ ...input(), fixtures: [{ id: 'bad', state: 'x', expected: { absent: 'anything' } }] }), /unknown question/);
    assert.throws(() => normalizeDecisionNode({ ...input(), inputFields: [{ key: 'constructor', type: 'text' }] }), /Field name/);
    assert.throws(() => normalizeDecisionNode({ ...input(), definition: { ...definition, model: 'https://attacker.test' } }), /Jev model/);
  });
  it('checks actual answer types, distributions and token accounting', () => {
    assert.deepEqual(validateDecisionResponse(response, definition), response);
    const bad = structuredClone(response); bad.answers.route.choice = 'not-an-option';
    assert.throws(() => validateDecisionResponse(bad, definition), /unknown choice/);
    bad.answers.route.choice = 'support'; bad.usage.input_tokens = -1;
    assert.throws(() => validateDecisionResponse(bad, definition), /token usage/);
    assert.isTrue(decisionAssertions(input().fixtures[0].expected, response.answers).every((item) => item.passed));
  });
});

if (Meteor.isServer) describe('Constellation Decisions service', function () {
  this.timeout(20_000);
  let serviceModule;
  let service;
  let userId;
  let allowed;
  let providerCalls;
  let onProvider;
  let context;
  let host;
  let crew;
  let missionAgents;
  let sessions;
  let continuationCalls;
  let continuationResult;
  const rejected = async (work, code) => {
    let error; try { await work; } catch (failure) { error = failure; }
    assert.isDefined(error, `Expected ${code}`); assert.equal(error.error, code);
  };
  before(async () => { serviceModule = await import('../server/constellation-decisions'); });
  beforeEach(async () => {
    userId = `decision-test-${Random.id()}`; allowed = true; providerCalls = 0; onProvider = null;
    crew = [{ agent: 'tester', displayName: 'Test agent', enabled: true }, { agent: 'reviewer', displayName: 'Reviewer', enabled: true },
      { agent: 'outside', displayName: 'Other crew', enabled: true }];
    missionAgents = new Set(['tester', 'reviewer']);
    sessions = new Map(['mission-a', 'mission-b'].map((id) => [id, { _id: id, userId, agent: 'orchestrator', phase: 'idle',
      participants: [{ kind: 'model', agent: 'tester' }] }]));
    sessions.set('specialist-a', { _id: 'specialist-a', userId, agent: 'tester', phase: 'idle', parent: { sessionId: 'mission-a' } });
    continuationCalls = []; continuationResult = { ok: true, ran: false, parked: true };
    host = {
      requireUser: async (id) => { if (id !== userId) throw new Meteor.Error('not-authorized', 'Not allowed.'); },
      CrewConfigs: { findOneAsync: async (query) => query.userId === userId && allowed ? crew.find((row) => row.agent === query.agent && row.enabled) : null,
        find: (query) => ({ fetchAsync: async () => query.userId === userId ? crew.filter((row) => row.enabled && (!query.agent?.$in || query.agent.$in.includes(row.agent))) : [] }) },
      rootMissionSession: async (id) => sessions.get(sessions.get(id)?.parent?.sessionId ?? id),
      getSession: async (id) => sessions.get(id),
      missionAllowsAgent: async (_context, agent) => allowed && missionAgents.has(agent),
      requireActiveMissionExecution: async () => { if (!allowed) throw new Meteor.Error('mission-inactive', 'Mission is paused.'); },
      canStoreSecret: () => true, encryptSecret: async () => ({ encryptedTestMarker: true }), decryptSecret: async () => 'test-key-never-sent',
      startDecisionContinuation: async (...args) => { continuationCalls.push(args); return continuationResult; },
    };
    service = serviceModule.createConstellationDecisionService(host, { adapter: async (request) => {
      await request.beforeAttempt(); providerCalls += 1; await onProvider?.(); return structuredClone(response);
    } });
    context = { userId, sessionId: 'mission-a', agent: 'tester' };
    await service.saveSettings(userId, { enabled: true, apiKey: 'fake-test-key' });
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'auto' } });
  });
  afterEach(async () => {
    for (const collection of [serviceModule.DecisionNodes, serviceModule.DecisionVersions, serviceModule.DecisionRuns, serviceModule.DecisionSettings, serviceModule.DecisionSecrets, serviceModule.DecisionBudgets]) await collection.removeAsync({ userId });
  });
  it('creates and evaluates a node in the same prepared tool catalog', async () => {
    const tools = service.toolDefinitions('tester');
    const create = tools.find((tool) => tool.name === 'create_decision_node');
    const evaluate = tools.find((tool) => tool.name === 'evaluate_decision_node');
    const created = await create.run(input(), context);
    assert.equal(created.status, 'active');
    const result = await evaluate.run({ nodeId: created.nodeId, revision: created.revision, state: 'Help today' }, { ...context, toolCallId: 'one-call' });
    assert.equal(result.answers.route.choice, 'support');
    assert.equal(providerCalls, 1);
    const node = await service.resolveNode(context, created.nodeId, 1);
    assert.equal(node.scope, 'mission'); assert.equal(node.missionId, 'mission-a');
    assert.deepEqual(node.agentIds, ['tester']);
    assert.deepEqual(await service.getPolicy(userId, 'tester'), { use: true, create: 'auto' });
    const runs = await service.history(userId, { nodeId: created.nodeId });
    assert.deepEqual(runs[0].definition, definition);
    assert.deepEqual(runs[0].state, { context: 'Help today' });
    assert.deepEqual(runs[0].usage, response.usage);
    const same = await evaluate.run({ nodeId: created.nodeId, revision: 1, state: 'Help today' }, { ...context, toolCallId: 'one-call' });
    assert.equal(same.runId, result.runId); assert.equal(providerCalls, 1);
  });
  it('deduplicates agent creation retries without exposing workspace authoring', async () => {
    const requestContext = { ...context, toolCallId: 'create-once' };
    const created = await service.createNode(requestContext, input());
    const repeated = await service.createNode(requestContext, input());
    assert.equal(repeated.nodeId, created.nodeId);
    assert.equal(await serviceModule.DecisionNodes.find({ userId }).countAsync(), 1);
    await rejected(service.createNode(requestContext, { ...input(), name: 'Different question' }), 'decision-request-conflict');
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'disabled' } });
    await rejected(service.createNode(requestContext, input()), 'decision-creation-disabled');
  });
  it('requires durable IDs for paid UI methods and adopts completed manual evaluations on replay', async () => {
    const node = await service.save(userId, { input: input() });
    const handlers = serviceModule.createDecisionMethods(service);
    const evaluate = (args) => handlers['constellation.decisions.evaluate'].call({ userId }, args);
    const test = (args) => handlers['constellation.decisions.testFixtures'].call({ userId }, args);
    const request = { nodeId: node._id, revision: 1, state: { context: 'Manual UI request' }, requestKey: 'ui-evaluation-123' };
    await rejected(evaluate({ ...request, requestKey: undefined }), 'decision-request-id-required');
    await rejected(evaluate({ ...request, requestKey: 'bad request\nkey' }), 'decision-request-id-required');
    await rejected(test({ nodeId: node._id, revision: 1 }), 'decision-request-id-required');
    assert.equal(providerCalls, 0);
    const first = await evaluate(request);
    // A new handler table represents DDP retry after the original connection
    // is gone; durable Mongo receipts, not connection cache, provide adoption.
    const replayed = await serviceModule.createDecisionMethods(service)['constellation.decisions.evaluate'].call({ userId }, structuredClone(request));
    assert.equal(first._id, replayed._id);
    assert.equal(providerCalls, 1);
    await rejected(evaluate({ ...request, state: { context: 'Changed input' } }), 'decision-request-conflict');
    assert.equal(providerCalls, 1);
  });
  it('refuses a replay with an uncertain outcome instead of charging for another request', async () => {
    const node = await service.save(userId, { input: input() });
    const request = { nodeId: node._id, revision: 1, state: { context: 'Uncertain request' }, requestKey: 'ui-uncertain-123' };
    onProvider = async () => { throw new Error('connection lost after the provider accepted work'); };
    const handlers = serviceModule.createDecisionMethods(service);
    await rejected(handlers['constellation.decisions.evaluate'].call({ userId }, request), 'decision-failed');
    assert.equal(providerCalls, 1);
    onProvider = null;
    await rejected(serviceModule.createDecisionMethods(service)['constellation.decisions.evaluate'].call({ userId }, request), 'decision-request-unresolved');
    assert.equal(providerCalls, 1);
    const [run] = await service.history(userId, { nodeId: node._id });
    assert.equal(run.status, 'failed'); assert.isTrue(run.uncertainUsage);
    assert.notInclude(run.error.reason, 'provider accepted');
  });
  it('derives bounded per-fixture request IDs and reuses completed fixture receipts on replay', async () => {
    const firstFixture = input().fixtures[0];
    const node = await service.save(userId, { input: { ...input(), fixtures: [firstFixture,
      { ...firstFixture, id: 'second', name: 'Second example', state: { context: 'More product help today' } }] } });
    const request = { nodeId: node._id, revision: 1, requestKey: 'x'.repeat(240) };
    const handlers = serviceModule.createDecisionMethods(service);
    const first = await handlers['constellation.decisions.testFixtures'].call({ userId }, request);
    assert.equal(first.status, 'passed'); assert.equal(providerCalls, 2);
    const replayed = await serviceModule.createDecisionMethods(service)['constellation.decisions.testFixtures'].call({ userId }, request);
    assert.deepEqual(replayed.results.map((result) => result.runId), first.results.map((result) => result.runId));
    assert.equal(providerCalls, 2);
    assert.lengthOf(await service.history(userId, { nodeId: node._id }), 2);
  });
  it('will not replay an uncertain fixture inside the same suite', async () => {
    const node = await service.save(userId, { input: input() });
    const request = { nodeId: node._id, revision: 1, requestKey: 'uncertain-suite' };
    onProvider = async () => { throw new Error('unknown transport outcome'); };
    await rejected(serviceModule.createDecisionMethods(service)['constellation.decisions.testFixtures'].call({ userId }, request), 'decision-failed');
    onProvider = null;
    await rejected(serviceModule.createDecisionMethods(service)['constellation.decisions.testFixtures'].call({ userId }, request), 'decision-request-unresolved');
    assert.equal(providerCalls, 1);
  });
  it('honors ask creation and human review without allowing agent self-promotion', async () => {
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const created = await service.createNode(context, { ...input(), scope: 'workspace', agentIds: ['somebody-else'] });
    assert.equal(created.status, 'pending');
    await rejected(service.evaluate(context, { nodeId: created.nodeId, revision: 1, state: 'x' }), 'decision-access-denied');
    assert.equal(providerCalls, 0);
    const approved = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
    assert.equal(approved.revision, 2); assert.equal(approved.scope, 'mission');
    await rejected(service.promote(userId, { nodeId: created.nodeId, expectedRevision: 2 }), 'decision-tests-required');
    assert.isFalse(service.toolDefinitions('tester').some((tool) => tool.name.includes('promote')));
  });
  it('approves once and queues the original specialist with exact context, never a second primary turn', async () => {
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const created = await service.createNode({ ...context, sessionId: 'specialist-a' }, input());
    const request = { nodeId: created.nodeId, expectedRevision: 1, approve: true };
    const [approved, repeated] = await Promise.all([service.review(userId, request), service.review(userId, request)]);
    assert.equal(approved.continuation.status, 'queued');
    assert.deepEqual(repeated.continuation, approved.continuation);
    assert.lengthOf(continuationCalls, 1);
    const [sessionId, prompt, options] = continuationCalls[0];
    assert.equal(sessionId, 'specialist-a'); assert.equal(options.agent, 'tester');
    assert.equal(options.key, `decision-approved:${created.nodeId}:2`);
    assert.equal(options.source, 'decision-review');
    assert.include(prompt, 'revision 2'); assert.include(prompt, 'not any downstream action');
    assert.equal(providerCalls, 0, 'Approval schedules a normal agent turn, not a blind decision evaluation.');
    assert.lengthOf(await service.versions(userId, { nodeId: created.nodeId }), 2);
  });
  it('leaves stopped parents and stopped or failed creators stopped after approval', async () => {
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    for (const [id, phase] of [['mission-a', 'stopped'], ['specialist-a', 'stopped'], ['specialist-a', 'error']]) {
      const created = await service.createNode({ ...context, sessionId: 'specialist-a' }, input());
      sessions.get(id).phase = phase;
      const approved = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
      assert.equal(approved.status, 'active'); assert.equal(approved.continuation.status, 'manual');
      assert.equal(sessions.get(id).phase, phase); sessions.get(id).phase = 'idle';
    }
    assert.isEmpty(continuationCalls);
  });
  it('preserves approval but refuses continuation after policy or mission access is revoked', async () => {
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const created = await service.createNode(context, input());
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: false, create: 'disabled' } });
    const approved = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
    assert.equal(approved.continuation.status, 'manual'); assert.include(approved.continuation.reason, 'disabled');
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const next = await service.createNode(context, input()); allowed = false;
    const declined = await service.review(userId, { nodeId: next.nodeId, expectedRevision: 1, approve: true });
    assert.equal(declined.continuation.status, 'manual'); assert.isEmpty(continuationCalls);
  });
  it('never retries an uncertain continuation on a replayed approval click', async () => {
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const created = await service.createNode(context, input());
    host.startDecisionContinuation = async (...args) => { continuationCalls.push(args); throw new Error('private DB transport detail'); };
    const request = { nodeId: created.nodeId, expectedRevision: 1, approve: true };
    const approved = await service.review(userId, request);
    assert.equal(approved.continuation.status, 'uncertain'); assert.notInclude(approved.continuation.reason, 'private DB');
    await service.review(userId, request); assert.lengthOf(continuationCalls, 1);
    assert.equal(providerCalls, 0);
  });
  it('marks a queued continuation stopped even before a system trigger or trace exists', async () => {
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const created = await service.createNode({ ...context, sessionId: 'specialist-a' }, input());
    const approved = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
    assert.equal(approved.continuation.status, 'queued');
    sessions.get('mission-a').phase = 'stopped';
    await service.refreshContinuations('mission-a');
    const stopped = await serviceModule.DecisionNodes.findOneAsync(created.nodeId);
    assert.equal(stopped.continuation.status, 'stopped');
    assert.lengthOf(continuationCalls, 1, 'Status reconciliation must not schedule replacement work.');
  });
  it('treats inactive and exhausted plans as definite refusals, not ambiguous paid outcomes', async () => {
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    for (const code of ['workflow-inactive', 'workflow-budget', 'workflow-unavailable']) {
      const created = await service.createNode(context, input());
      host.requireActiveMissionExecution = async () => { throw new Meteor.Error(code, 'internal detail'); };
      // The injected host is copied at construction, so exercise the same
      // authority callback through the referenced control variable instead.
      const checkedService = serviceModule.createConstellationDecisionService(host);
      const approved = await checkedService.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
      assert.equal(approved.continuation.status, 'manual'); assert.include(approved.continuation.reason, 'plan run');
      host.requireActiveMissionExecution = async () => {};
    }
    assert.isEmpty(continuationCalls);
  });
  it('cancels a former specialist’s parked continuation and waits for its lease before mission reactivation', async () => {
    const { AgentSessions } = await import('meteor/10thfloor:agent');
    const missionId = `decision-stop-parent-${Random.id()}`; const childId = `decision-stop-child-${Random.id()}`;
    const grandchildId = `decision-stop-descendant-${Random.id()}`;
    sessions.set(missionId, { ...sessions.get('mission-a'), _id: missionId });
    sessions.set(childId, { ...sessions.get('specialist-a'), _id: childId, parent: { sessionId: missionId } });
    await AgentSessions.insertAsync({ ...sessions.get(childId), pendingSystem: { key: 'placeholder', source: 'decision-review', prompt: 'Approved', token: Random.id(), at: new Date() },
      activeChild: { sessionId: grandchildId, toolCallId: 'nested-delegation' }, lease: { serverId: 'stopping-test', until: new Date(Date.now() + 60_000) } });
    await AgentSessions.insertAsync({ _id: grandchildId, userId, agent: 'reviewer', phase: 'streaming', parent: { sessionId: childId },
      lease: { serverId: 'nested-stopping-test', until: new Date(Date.now() + 60_000) } });
    try {
      await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
      const created = await service.createNode({ ...context, sessionId: childId }, input());
      const approved = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
      await AgentSessions.updateAsync(childId, { $set: { 'pendingSystem.key': approved.continuation.key } });
      await service.stopMissionContinuations(userId, missionId);
      const stopped = await AgentSessions.findOneAsync(childId);
      assert.equal(stopped.phase, 'stopped'); assert.isUndefined(stopped.pendingSystem);
      assert.isFalse(await service.missionContinuationsQuiescent(userId, missionId));
      await AgentSessions.updateAsync(childId, { $unset: { lease: '' } });
      assert.equal((await AgentSessions.findOneAsync(grandchildId)).phase, 'stopped');
      assert.isFalse(await service.missionContinuationsQuiescent(userId, missionId), 'Nested work must release its lease too.');
      await AgentSessions.updateAsync(grandchildId, { $unset: { lease: '' } });
      assert.isTrue(await service.missionContinuationsQuiescent(userId, missionId));
      assert.equal((await serviceModule.DecisionNodes.findOneAsync(created.nodeId)).continuation.status, 'stopped');
      assert.lengthOf(continuationCalls, 1, 'Cancellation and reactivation must not re-dispatch the old request.');
    } finally { await AgentSessions.removeAsync({ _id: { $in: [childId, grandchildId] } }); }
  });
  it('cancels the exact queued approval after a fast Stop then Send without discarding a newer human turn or other scheduled work', async () => {
    const { AgentMessages, AgentSessions, AgentTraces } = await import('meteor/10thfloor:agent');
    const missionId = `decision-cutoff-${Random.id()}`;
    sessions.set(missionId, { ...sessions.get('mission-a'), _id: missionId });
    await AgentSessions.insertAsync({ ...sessions.get(missionId), nextSeq: 3 });
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const created = await service.createNode({ ...context, sessionId: missionId }, input());
    const approved = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
    const stopAt = new Date(approved.continuation.requestedAt.getTime() + 1);
    const triggerId = `sys:${missionId}:${approved.continuation.key}`; const traceId = Random.id(); const userMessageId = Random.id();
    try {
      // The momentary stopped phase has already been replaced by Send, but
      // its durable timestamp remains. The old system cause must stay dead.
      sessions.get(missionId).stoppedAt = stopAt;
      await AgentSessions.updateAsync(missionId, { $set: { phase: 'idle', stoppedAt: stopAt,
        pendingSystem: { key: approved.continuation.key, source: 'decision-review', token: Random.id(), at: stopAt } } });
      await service.refreshContinuations(missionId, stopAt);
      assert.isUndefined((await AgentSessions.findOneAsync(missionId)).pendingSystem);
      assert.equal((await AgentSessions.findOneAsync(missionId)).phase, 'idle');
      assert.equal((await serviceModule.DecisionNodes.findOneAsync(created.nodeId)).continuation.status, 'stopped');

      // A late dispatch that raced Stop still cannot start provider work.
      await AgentMessages.insertAsync({ _id: triggerId, sessionId: missionId, role: 'system', seq: 1, content: 'Approved decision', createdAt: stopAt });
      await AgentTraces.insertAsync({ _id: traceId, sessionId: missionId, agent: 'tester', kind: 'turn', triggerSeq: 1, status: 'running', summary: '', startedAt: stopAt });
      await rejected(service.assertContinuationExecution(missionId, 'tester'), 'decision-continuation-stopped');

      // A human send wins after the old-cause check but before the stop write.
      // The transcript CAS must protect that turn, not only the earlier read.
      await AgentSessions.updateAsync(missionId, { $set: { phase: 'streaming', nextSeq: 1 } });
      const originalUpdate = AgentSessions.updateAsync;
      let raced = false;
      AgentSessions.updateAsync = async function (selector, modifier, ...options) {
        if (!raced && selector?._id === missionId && modifier?.$set?.phase === 'stopped' && selector.nextSeq !== undefined) {
          raced = true;
          await AgentMessages.insertAsync({ _id: userMessageId, sessionId: missionId, role: 'user', seq: 2, content: 'A new explicit request', createdAt: new Date(stopAt.getTime() + 1) });
          await originalUpdate.call(this, missionId, { $set: { phase: 'streaming', nextSeq: 2 } });
        }
        return originalUpdate.call(this, selector, modifier, ...options);
      };
      try { await service.assertContinuationExecution(missionId, 'tester'); }
      finally { AgentSessions.updateAsync = originalUpdate; }
      assert.isTrue(raced, 'The test must insert a new human turn at the stop-write boundary.');
      assert.equal((await AgentSessions.findOneAsync(missionId)).phase, 'streaming');

      // Fresh user input outranks the old cause even while its trace unwinds.
      await AgentSessions.updateAsync(missionId, { $set: { phase: 'streaming', pendingSystem: { key: 'other-schedule', source: 'pulse', token: Random.id(), at: new Date() } } });
      await service.assertContinuationExecution(missionId, 'tester');
      const fresh = await AgentSessions.findOneAsync(missionId);
      assert.equal(fresh.phase, 'streaming'); assert.equal(fresh.pendingSystem.key, 'other-schedule');
    } finally {
      await AgentTraces.removeAsync(traceId); await AgentMessages.removeAsync({ _id: { $in: [triggerId, userMessageId] } });
      await AgentSessions.removeAsync(missionId);
    }
  });
  it('uses the real durable system-turn path to continue one fresh specialist session with its existing transcript', async function () {
    this.timeout(20_000);
    const { Agent, AgentMessages, AgentSessions, AgentTraces, AgentTraceSpans, AgentTurnManifests, mockProvider, startSystemTurn } = await import('meteor/10thfloor:agent');
    const agent = `decision-resume-${Random.id()}`;
    const missionId = `decision-parent-${Random.id()}`; const childId = `decision-child-${Random.id()}`;
    const requests = [];
    new Agent(agent, { model: 'mock', instructions: 'Continue the assigned task.', provider: mockProvider((request) => {
      requests.push(request); return { text: 'The approved decision is ready for the original assignment.' };
    }), budget: { turns: 4, systemTurns: 2, toolCalls: 4, spend: 1 } });
    crew.push({ agent, displayName: 'Continuation specialist', enabled: true }); missionAgents.add(agent);
    const now = new Date();
    const base = { userId, phase: 'idle', model: 'mock', usage: { input: 0, output: 0, cost: 0 }, budgetSpent: { turns: 1, systemTurns: 0, toolCalls: 0 }, createdAt: now, updatedAt: now };
    sessions.set(missionId, { ...base, _id: missionId, agent: 'orchestrator', nextSeq: 0 });
    sessions.set(childId, { ...base, _id: childId, agent, nextSeq: 2, parent: { sessionId: missionId, toolCallId: 'original-delegation' } });
    await AgentSessions.insertAsync(sessions.get(missionId)); await AgentSessions.insertAsync(sessions.get(childId));
    await AgentMessages.insertAsync({ _id: Random.id(), sessionId: childId, seq: 1, role: 'user', content: 'Original child assignment: classify the support queue.', createdAt: now });
    await AgentMessages.insertAsync({ _id: Random.id(), sessionId: childId, seq: 2, role: 'assistant', content: 'Waiting for decision approval.', answeredThrough: 1, createdAt: now });
    host.startDecisionContinuation = startSystemTurn;
    try {
      await service.setAgentPolicy(userId, { agent, policy: { use: true, create: 'ask' } });
      const created = await service.createNode({ userId, agent, sessionId: childId }, input());
      const reviewRequest = { nodeId: created.nodeId, expectedRevision: 1, approve: true };
      const approved = await service.review(userId, reviewRequest);
      assert.include(['resumed', 'queued'], approved.continuation.status);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const current = await AgentSessions.findOneAsync(childId);
        if (requests.length === 1 && current?.phase === 'idle' && !current.lease) break;
        if (Date.now() > deadline) assert.fail(`Continuation did not finish: ${current?.phase}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.include(JSON.stringify(requests[0].messages), 'Original child assignment');
      assert.include(JSON.stringify(requests[0].messages), created.nodeId);
      assert.equal(await AgentMessages.find({ sessionId: childId, role: 'system' }).countAsync(), 1);
      assert.equal(await AgentMessages.find({ sessionId: missionId }).countAsync(), 0, 'No extra primary-agent turn.');
      const current = await AgentSessions.findOneAsync(childId);
      assert.equal(current.budgetSpent.systemTurns, 1); assert.equal(current.budgetSpent.turns, 1);
      await service.review(userId, reviewRequest);
      assert.lengthOf(requests, 1); assert.equal(providerCalls, 0);
    } finally {
      const traces = await AgentTraces.find({ sessionId: childId }).fetchAsync();
      await AgentTraceSpans.removeAsync({ traceId: { $in: traces.map((trace) => trace._id) } });
      await AgentTurnManifests.removeAsync({ sessionId: childId });
      await AgentTraces.removeAsync({ sessionId: childId });
      await AgentMessages.removeAsync({ sessionId: { $in: [missionId, childId] } });
      await AgentSessions.removeAsync({ _id: { $in: [missionId, childId] } });
    }
  });
  it('fences a late descendant of a stopped continuation without blocking a genuinely new delegation', async () => {
    const { AgentMessages, AgentSessions, AgentTraces, AgentTraceSpans } = await import('meteor/10thfloor:agent');
    const rootId = `decision-lineage-root-${Random.id()}`; const creatorId = `decision-lineage-creator-${Random.id()}`;
    const lateId = `decision-lineage-late-${Random.id()}`; const freshId = `decision-lineage-fresh-${Random.id()}`;
    const now = new Date();
    sessions.set(rootId, { ...sessions.get('mission-a'), _id: rootId });
    sessions.set(creatorId, { ...sessions.get('specialist-a'), _id: creatorId, parent: { sessionId: rootId }, nextSeq: 5 });
    for (const id of [rootId, creatorId]) await AgentSessions.insertAsync(sessions.get(id));
    const oldTraceId = Random.id(); const newTraceId = Random.id(); const spanIds = [Random.id(), Random.id()];
    try {
      await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
      const created = await service.createNode({ ...context, sessionId: creatorId }, input());
      const approved = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
      const stopAt = new Date(approved.continuation.requestedAt.getTime() + 1);
      sessions.get(rootId).stoppedAt = stopAt;
      await AgentSessions.updateAsync(rootId, { $set: { phase: 'idle', stoppedAt: stopAt } });
      await AgentMessages.insertAsync({ _id: `sys:${creatorId}:${approved.continuation.key}`, sessionId: creatorId, seq: 1, role: 'system', content: 'Approved', createdAt: now });
      await AgentMessages.insertAsync({ _id: Random.id(), sessionId: creatorId, seq: 2, role: 'assistant', answeredThrough: 0,
        toolCalls: [{ id: 'old-delegate', name: 'reviewer', args: { prompt: 'Old work' } }], createdAt: now });
      await AgentMessages.insertAsync({ _id: Random.id(), sessionId: creatorId, seq: 3, role: 'user', content: 'A new human assignment', source: { kind: 'desktop' }, createdAt: new Date(stopAt.getTime() + 1) });
      await AgentMessages.insertAsync({ _id: Random.id(), sessionId: creatorId, seq: 4, role: 'assistant', answeredThrough: 3,
        toolCalls: [{ id: 'new-delegate', name: 'reviewer', args: { prompt: 'New work' } }], createdAt: new Date(stopAt.getTime() + 2) });
      await AgentTraces.insertAsync({ _id: oldTraceId, sessionId: creatorId, agent: 'tester', kind: 'turn', triggerSeq: 1, status: 'stopped', startedAt: now, summary: '' });
      await AgentTraces.insertAsync({ _id: newTraceId, sessionId: creatorId, agent: 'tester', kind: 'turn', triggerSeq: 3, status: 'running', startedAt: new Date(stopAt.getTime() + 1), summary: '' });
      await AgentTraceSpans.insertAsync({ _id: spanIds[0], sessionId: creatorId, traceId: oldTraceId, toolCallId: 'old-delegate', kind: 'tool', name: 'reviewer', status: 'running', summary: '', startedAt: now });
      await AgentTraceSpans.insertAsync({ _id: spanIds[1], sessionId: creatorId, traceId: newTraceId, toolCallId: 'new-delegate', kind: 'tool', name: 'reviewer', status: 'running', summary: '', startedAt: new Date(stopAt.getTime() + 2) });
      for (const [id, call] of [[lateId, 'old-delegate'], [freshId, 'new-delegate']]) await AgentSessions.insertAsync({ _id: id, userId, agent: 'reviewer', phase: 'streaming',
        parent: { sessionId: creatorId, toolCallId: call }, createdAt: new Date(stopAt.getTime() + 10) });
      await rejected(service.assertContinuationExecution(lateId, 'reviewer'), 'decision-continuation-stopped');
      await service.assertContinuationExecution(freshId, 'reviewer');
      assert.equal((await AgentSessions.findOneAsync(freshId)).phase, 'streaming');
      assert.equal((await AgentSessions.findOneAsync(rootId)).phase, 'idle');
      // Best-effort evidence absent: actual provider-history watermark still
      // allows the new delegation while withholding the ambiguous old one.
      await AgentTraceSpans.removeAsync({ _id: { $in: spanIds } });
      await rejected(service.assertContinuationExecution(lateId, 'reviewer'), 'decision-continuation-stopped');
      await service.assertContinuationExecution(freshId, 'reviewer');
    } finally {
      await AgentTraceSpans.removeAsync({ _id: { $in: spanIds } }); await AgentTraces.removeAsync({ _id: { $in: [oldTraceId, newTraceId] } });
      await AgentMessages.removeAsync({ sessionId: creatorId }); await AgentSessions.removeAsync({ _id: { $in: [rootId, creatorId, lateId, freshId] } });
    }
  });
  it('rejects a proposed decision without scheduling work', async () => {
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const created = await service.createNode(context, input());
    const rejectedNode = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: false });
    assert.equal(rejectedNode.status, 'archived'); assert.isUndefined(rejectedNode.continuation); assert.isEmpty(continuationCalls);
  });
  it('shares by exact revision only with enabled mission crew, without changing rubric or granting use', async () => {
    const created = await service.createNode(context, input());
    const shared = await service.setAssignments(userId, { nodeId: created.nodeId, expectedRevision: 1,
      agentIds: ['tester', 'reviewer'], definition: { malicious: true }, policy: { use: true, create: 'auto' } });
    assert.deepEqual(shared.definition, definition); assert.sameMembers(shared.agentIds, ['tester', 'reviewer']);
    assert.deepEqual(await service.getPolicy(userId, 'reviewer'), { use: false, create: 'disabled' });
    await rejected(service.resolveNode({ ...context, agent: 'reviewer' }, created.nodeId, 2), 'decision-access-denied');
    await rejected(service.setAssignments(userId, { nodeId: created.nodeId, expectedRevision: 1, agentIds: [] }), 'decision-revision-changed');
    await rejected(service.setAssignments(userId, { nodeId: created.nodeId, expectedRevision: 2, agentIds: ['outside'] }), 'decision-agent-unavailable');
    crew.find((row) => row.agent === 'reviewer').enabled = false;
    await rejected(service.setAssignments(userId, { nodeId: created.nodeId, expectedRevision: 2, agentIds: ['reviewer'] }), 'decision-agent-unavailable');
    const versions = await service.versions(userId, { nodeId: created.nodeId });
    assert.equal(versions[0].action, 'assignments-changed');
    assert.deepEqual(versions[0].actor, { kind: 'human', userId });
    assert.isFalse(service.toolDefinitions('tester').some((tool) => /assign|share/.test(tool.name)));
  });
  it('lists only eligible mission members and applies the same fence to definition saves', async () => {
    const created = await service.createNode(context, input());
    const eligible = await service.eligibleAgents(userId, { nodeId: created.nodeId });
    assert.sameMembers(eligible.map((row) => row.agent), ['tester', 'reviewer']);
    assert.equal(eligible.find((row) => row.agent === 'tester').displayName, 'Test agent');
    assert.deepEqual(eligible.find((row) => row.agent === 'reviewer').policy, { use: false, create: 'disabled' });
    const node = await service.resolveNode(context, created.nodeId, 1);
    await rejected(service.save(userId, { nodeId: created.nodeId, expectedRevision: 1, input: { ...node, agentIds: ['outside'] } }), 'decision-agent-unavailable');
  });
  it('updates continuation receipts only from a trace bound to the exact approval trigger', async () => {
    const { AgentMessages, AgentSessions, AgentTraces } = await import('meteor/10thfloor:agent');
    const missionId = `decision-trace-${Random.id()}`;
    sessions.set(missionId, { ...sessions.get('mission-a'), _id: missionId });
    context = { ...context, sessionId: missionId };
    await AgentSessions.insertAsync({ ...sessions.get(missionId), model: 'mock', nextSeq: 41,
      usage: { input: 0, output: 0, cost: 0 }, createdAt: new Date(), updatedAt: new Date() });
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: true, create: 'ask' } });
    const created = await service.createNode(context, input());
    const approved = await service.review(userId, { nodeId: created.nodeId, expectedRevision: 1, approve: true });
    const triggerId = `sys:${missionId}:${approved.continuation.key}`; const traceId = Random.id();
    try {
      await AgentMessages.insertAsync({ _id: triggerId, sessionId: missionId, role: 'system', content: 'Approved', seq: 40, createdAt: new Date() });
      await AgentTraces.insertAsync({ _id: traceId, sessionId: missionId, agent: 'tester', kind: 'turn', triggerSeq: 39,
        status: 'completed', summary: '', startedAt: new Date(), finishedAt: new Date() });
      await service.refreshContinuations(missionId);
      assert.equal((await service.resolveNode(context, created.nodeId)).continuation.status, 'queued');
      await AgentTraces.updateAsync(traceId, { $set: { triggerSeq: 40, status: 'waiting' } });
      await service.refreshContinuations(missionId);
      assert.equal((await service.resolveNode(context, created.nodeId)).continuation.status, 'waiting');
      await AgentTraces.updateAsync(traceId, { $set: { status: 'completed' } });
      await service.refreshContinuations(missionId);
      const completed = await service.resolveNode(context, created.nodeId);
      assert.equal(completed.continuation.status, 'completed'); assert.equal(completed.continuation.traceId, traceId);
    } finally { await AgentMessages.removeAsync(triggerId); await AgentTraces.removeAsync(traceId); await AgentSessions.removeAsync(missionId); }
  });
  it('rejects wrong owner, mission, stale revision and live access revocation before provider work', async () => {
    const created = await service.createNode(context, input());
    const request = { nodeId: created.nodeId, revision: 1, state: 'x' };
    await rejected(service.evaluate({ ...context, userId: 'not-owner' }, request), 'not-authorized');
    await rejected(service.evaluate({ ...context, sessionId: 'mission-b' }, request), 'decision-not-found');
    await rejected(service.evaluate(context, { ...request, revision: 2 }), 'decision-revision-changed');
    await service.setAgentPolicy(userId, { agent: 'tester', policy: { use: false, create: 'disabled' } });
    await rejected(service.evaluate(context, request), 'decision-access-denied');
    assert.equal(providerCalls, 0);
  });
  it('revokes assignment and deletion from prepared evaluation tools, retaining audited history', async () => {
    const created = await service.createNode(context, input());
    const tool = service.toolDefinitions('tester').find((entry) => entry.name === 'evaluate_decision_node');
    await tool.run({ nodeId: created.nodeId, revision: 1, state: 'Help today' }, context);
    const node = await service.resolveNode(context, created.nodeId, 1);
    const unassigned = await service.save(userId, { nodeId: node._id, expectedRevision: 1, input: { ...node, agentIds: [] } });
    await rejected(tool.run({ nodeId: node._id, revision: unassigned.revision, state: 'Help today' }, context), 'decision-access-denied');
    await service.remove(userId, { nodeId: node._id, expectedRevision: unassigned.revision });
    await rejected(tool.run({ nodeId: node._id, revision: unassigned.revision, state: 'Help today' }, context), 'decision-not-found');
    assert.equal(providerCalls, 1);
    assert.lengthOf(await service.history(userId, { nodeId: node._id }), 1);
    assert.lengthOf(await service.versions(userId, { nodeId: node._id }), 3);
  });
  it('keeps the exact receipt but withholds a result revoked during provider work', async () => {
    const created = await service.createNode(context, input());
    onProvider = async () => { allowed = false; };
    await rejected(service.evaluate(context, { nodeId: created.nodeId, revision: 1, state: 'x' }), 'decision-agent-unavailable');
    const [run] = await service.history(userId, { nodeId: created.nodeId });
    assert.equal(run.status, 'failed'); assert.deepEqual(run.answers, response.answers); assert.deepEqual(run.usage, response.usage);
    assert.isFalse(run.uncertainUsage);
  });
  it('invalidates passing fixture results after editing and caps agent-created nodes', async () => {
    const created = await service.createNode(context, input());
    await service.testFixtures(userId, { nodeId: created.nodeId, revision: 1 });
    const node = await service.resolveNode(context, created.nodeId, 1);
    const edited = await service.save(userId, { nodeId: node._id, expectedRevision: 1, input: { ...node, description: 'Changed rubric description' } });
    await rejected(service.promote(userId, { nodeId: edited._id, expectedRevision: edited.revision }), 'decision-tests-required');
    for (let index = 1; index < 20; index += 1) await service.createNode(context, { ...input(), name: `Decision ${index}` });
    await rejected(service.createNode(context, input()), 'decision-limit');
  });
  it('requires current revision fixture success to promote and invalidates tests after edit', async () => {
    const created = await service.createNode(context, input());
    // Agent tool deliberately omits fixture authoring. User supplies expected outputs.
    const original = await service.resolveNode(context, created.nodeId, 1);
    const saved = await service.save(userId, { nodeId: created.nodeId, expectedRevision: 1, input: { ...original, fixtures: input().fixtures } });
    const report = await service.testFixtures(userId, { nodeId: created.nodeId, revision: saved.revision });
    assert.equal(report.status, 'passed');
    const promoted = await service.promote(userId, { nodeId: created.nodeId, expectedRevision: saved.revision });
    assert.equal(promoted.scope, 'workspace');
    assert.equal(promoted.promotionTest.revision, saved.revision);
    assert.isUndefined(promoted.lastTest);
    const edited = await service.save(userId, { nodeId: promoted._id, expectedRevision: promoted.revision, input: { ...promoted, description: 'Updated' } });
    assert.equal(edited.scope, 'workspace');
  });
  it('caps provider calls and cannot silently simulate when no key is configured', async () => {
    const created = await service.createNode(context, input());
    await service.saveSettings(userId, { limits: { callsPerMission: 1, tokensPerMission: 100_000, maxInputChars: 12_000 } });
    await service.evaluate(context, { nodeId: created.nodeId, revision: 1, state: 'x' });
    await rejected(service.evaluate(context, { nodeId: created.nodeId, revision: 1, state: 'x again' }), 'decision-budget-exhausted');
    assert.equal(providerCalls, 1);
    const original = process.env.TYPESAFE_API_KEY;
    try {
      delete process.env.TYPESAFE_API_KEY;
      await service.saveSettings(userId, { clearApiKey: true });
      await rejected(service.evaluate(context, { nodeId: created.nodeId, revision: 1, state: 'x' }), 'decision-key-missing');
      assert.equal(providerCalls, 1);
    } finally { if (original !== undefined) process.env.TYPESAFE_API_KEY = original; }
  });
  it('keeps secrets out of settings and stores fixture provider usage separately', async () => {
    const settings = await service.getSettings(userId);
    assert.isTrue(settings.providerConfigured); assert.equal(settings.keySource, 'saved');
    assert.notInclude(JSON.stringify(settings), 'fake-test-key');
    assert.notInclude(JSON.stringify(settings), 'encryptedTestMarker');
    const node = await service.save(userId, { input: input() });
    const report = await service.testFixtures(userId, { nodeId: node._id, revision: 1 });
    const [run] = await service.history(userId, { nodeId: node._id });
    assert.equal(report.status, 'passed'); assert.equal(run.purpose, 'fixture');
    assert.deepEqual(run.usage, response.usage);
  });
  it('only retries documented rate limiting and never leaks remote error bodies', async () => {
    let calls = 0; let before = 0;
    const result = await serviceModule.requestTypeSafe({ apiKey: 'test', definition, state: 'help',
      beforeAttempt: async () => { before += 1; }, sleep: async () => {},
      fetchImpl: async () => { calls += 1; return calls === 1 ? new Response('sensitive body', { status: 429 }) : new Response(JSON.stringify(response), { status: 200 }); } });
    assert.equal(calls, 2); assert.equal(before, 2); assert.deepEqual(result.usage, response.usage);
    calls = 0;
    await rejected(serviceModule.requestTypeSafe({ apiKey: 'test', definition, state: 'help', fetchImpl: async () => { calls += 1; throw new Error('sensitive network detail'); } }), 'decision-network-error');
    assert.equal(calls, 1);
    let failure;
    try { await serviceModule.requestTypeSafe({ apiKey: 'test', definition, state: 'help', fetchImpl: async () => { throw new Meteor.Error('remote-error', 'secret test body'); } }); }
    catch (error) { failure = error; }
    assert.equal(failure.error, 'decision-network-error');
    assert.notInclude(failure.reason, 'secret test body');
  });
});

if (Meteor.isServer) describe('Constellation Decisions application wiring', function () {
  this.timeout(20_000);
  it('wires owner-only UI settings into the live catalog and final mission tool fence', async () => {
    const runtime = await import('../server/main');
    const decisions = await import('../server/constellation-decisions');
    const { AgentSessions } = await import('meteor/10thfloor:agent');
    let workspace = await runtime.WorkspaceState.findOneAsync('local');
    const temporaryWorkspace = !workspace;
    if (!workspace) {
      workspace = { _id: 'local', ownerUserId: `decision-wire-owner-${Random.id()}`, createdAt: new Date() };
      await runtime.WorkspaceState.insertAsync(workspace);
    }
    const ownerId = workspace.ownerUserId;
    const agent = `decision-wire-${Random.id()}`;
    const crewId = Random.id(); const missionId = Random.id();
    const previousSettings = await decisions.DecisionSettings.findOneAsync(ownerId);
    const catalogSelector = { userId: ownerId, source: { $in: ['app', 'framework'] } };
    const previousCatalog = await runtime.ToolCatalog.find(catalogSelector).fetchAsync();
    let nodeId;
    const invoke = (name, args, userId = ownerId) => Meteor.server.method_handlers[`constellation.decisions.${name}`].call({ userId, connection: null }, args);
    const context = { userId: ownerId, sessionId: missionId, agent };
    try {
      const now = new Date();
      await runtime.CrewConfigs.insertAsync({ _id: crewId, userId: ownerId, agent, displayName: 'Decision wiring test', role: 'Testing', enabled: true, status: 'available', revision: 1, capabilities: {}, createdAt: now, updatedAt: now });
      await AgentSessions.insertAsync({ _id: missionId, userId: ownerId, agent: 'orchestrator', phase: 'idle', model: 'mock', nextSeq: 0,
        participants: [{ id: `m:${agent}`, kind: 'model', agent }], usage: { input: 0, output: 0, cost: 0 }, createdAt: now, updatedAt: now });
      await runtime.MissionConfigs.insertAsync({ _id: missionId, sessionId: missionId, userId: ownerId, title: 'Decision wiring test', status: 'active', agents: [agent], debugTraces: false, revision: 1, createdAt: now, updatedAt: now });
      await invoke('saveSettings', { enabled: true });
      await invoke('setAgentPolicy', { agent, policy: { use: true, create: 'ask' } });
      const prepared = runtime.constellationDecisions.toolDefinitions(agent);
      assert.sameMembers(prepared.map((tool) => tool.name), ['find_decision_nodes', 'create_decision_node', 'evaluate_decision_node']);
      for (const tool of prepared) {
        assert.isTrue(await runtime.configuredToolEntitlement(tool.name, context, agent));
        const row = await runtime.ToolCatalog.findOneAsync({ userId: ownerId, name: tool.name });
        assert.include(row?.assignedAgents, agent, 'The developer tool catalog must show assigned decision access.');
        if (tool.name !== 'evaluate_decision_node' || (await runtime.constellationDecisions.getSettings(ownerId)).providerConfigured) {
          assert.include(row?.agents, agent, 'Ready decision tools must show their effective agent access.');
        }
      }
      const created = await prepared.find((tool) => tool.name === 'create_decision_node').run(input(), { ...context, toolCallId: 'application-wire' });
      nodeId = created.nodeId;
      assert.equal(created.status, 'pending');
      assert.isFalse(await runtime.constellationDecisions.authorizeNode(context, nodeId, 1));
      const approved = await invoke('review', { nodeId, expectedRevision: 1, approve: true });
      assert.isTrue(await runtime.constellationDecisions.authorizeNode(context, nodeId, approved.revision));
      assert.isFalse(await runtime.configuredToolEntitlement('evaluate_decision_node', { ...context, userId: 'not-the-owner' }, agent));
      let failure;
      try { await invoke('setAgentPolicy', { agent, policy: { use: true, create: 'auto' } }, 'not-the-owner'); } catch (error) { failure = error; }
      assert.equal(failure?.error, 'not-authorized');
      await invoke('setAgentPolicy', { agent, policy: { use: false, create: 'disabled' } });
      assert.isFalse(await runtime.configuredToolEntitlement('evaluate_decision_node', context, agent));
      assert.notInclude((await runtime.ToolCatalog.findOneAsync({ userId: ownerId, name: 'evaluate_decision_node' }))?.agents ?? [], agent);
      await invoke('setAgentPolicy', { agent, policy: { use: true, create: 'auto' } });
      await runtime.MissionConfigs.updateAsync(missionId, { $set: { status: 'paused' } });
      assert.isFalse(await runtime.configuredToolEntitlement('evaluate_decision_node', context, agent));
      await runtime.MissionConfigs.updateAsync(missionId, { $set: { status: 'active' } });
      await runtime.CrewConfigs.updateAsync(crewId, { $set: { enabled: false, status: 'archived' } });
      assert.isFalse(await runtime.configuredToolEntitlement('evaluate_decision_node', context, agent));
    } finally {
      if (nodeId) { await decisions.DecisionNodes.removeAsync(nodeId); await decisions.DecisionVersions.removeAsync({ nodeId }); }
      await runtime.CrewConfigs.removeAsync(crewId);
      await runtime.MissionConfigs.removeAsync(missionId);
      await AgentSessions.removeAsync(missionId);
      if (previousSettings) await decisions.DecisionSettings.rawCollection().replaceOne({ _id: ownerId }, previousSettings, { upsert: true });
      else await decisions.DecisionSettings.removeAsync(ownerId);
      await runtime.ToolCatalog.removeAsync(catalogSelector);
      for (const row of previousCatalog) await runtime.ToolCatalog.insertAsync(row);
      if (temporaryWorkspace) await runtime.WorkspaceState.removeAsync({ _id: 'local', ownerUserId: ownerId });
    }
  });
});
