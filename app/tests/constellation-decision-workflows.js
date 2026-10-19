import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentWorkflowRuns, WorkflowEngine } from 'meteor/10thfloor:agent';
import { decisionBranchSchema, workflowConditionLabel } from '../imports/constellation/workflows';

if (Meteor.isServer) describe('Constellation typed decision workflow branches', function () {
  this.timeout(20_000);
  const namespace = 'decision-branch-tests';
  const owner = 'decision-branch-owner';
  const budget = { steps: 16, timeoutMs: 60_000, turns: 8, toolCalls: 8, spend: 2 };
  const questions = {
    route: { type: 'choice', criteria: { research: 'Find evidence', review: 'Review evidence', none: 'No action' } },
    ready: { type: 'noul' },
    quality: { type: 'score', criteria: ['Poor', 'Adequate', 'Strong'] },
  };
  const choice = (value = 'research', confidence = 0.95) => ({ answers: {
    route: { type: 'choice', choice: value, confidence },
    ready: { type: 'noul', noul: 0.92 }, quality: { type: 'score', score: 1.8, confidence: 0.9 },
  } });
  const decision = { id: 'decide', label: 'Route work', primitive: 'decision', version: 1, input: {}, dependsOn: [] };
  const work = (id, extra = {}) => ({ id, label: id, primitive: 'work', version: 1, input: {}, dependsOn: ['decide'], ...extra });
  const condition = (value, extra = {}) => ({ stepId: 'decide', questionId: 'route', type: 'choice', operator: 'eq', value, ...extra });
  const graph = (steps) => ({ id: 'decision-test-mission', revision: 1, name: 'Decision branches', strategy: 'workflow', steps, budget });
  const setup = (answer = choice(), authorize = async (userId) => userId === owner) => {
    const executed = [];
    const engine = new WorkflowEngine({ namespace, authorize });
    engine.wake = () => {};
    engine.register({ name: 'decision', version: 1, label: 'Decide', replay: 'safe', inputSchema: { type: 'object' },
      branchSchema: () => decisionBranchSchema(questions), async execute() { return { output: typeof answer === 'function' ? answer() : answer }; } });
    engine.register({ name: 'work', version: 1, label: 'Work', replay: 'safe', inputSchema: { type: 'object' },
      async execute(_input, context) { executed.push(context.step.id); return { output: context.step.id }; } });
    return { engine, executed };
  };
  const start = async (engine, steps) => {
    const id = await engine.start({ userId: owner, missionId: 'decision-test-mission', definition: graph(steps), requestKey: Random.id() });
    await engine.drive(id);
    return engine.get(id, owner);
  };
  const rejects = async (promise) => {
    let failure;
    try { await promise; } catch (error) { failure = error; }
    assert.equal(failure?.error, 'invalid-workflow');
  };
  afterEach(() => AgentWorkflowRuns.removeAsync({ namespace, userId: owner }));

  it('runs matching Choice branches, skips others and joins only completed branches', async () => {
    const { engine, executed } = setup();
    const run = await start(engine, [decision, work('research', { when: condition('research') }),
      work('review', { when: condition('review') }), work('fallback', { when: { stepId: 'decide', otherwise: true } }),
      work('join', { dependsOn: ['research', 'review', 'fallback'], dependencyMode: 'any' }),
      work('blocked', { dependsOn: ['review'] })]);
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(executed, ['research', 'join']);
    assert.equal(run.states.review.status, 'skipped');
    assert.equal(run.states.review.attempts, 0);
    assert.equal(run.states.blocked.status, 'skipped');
    assert.include(run.states.fallback.summary, 'another decision branch matched');
    assert.equal(run.executions, 3);
  });

  it('uses explicit fallback for unmatched or low-confidence choices', async () => {
    for (const result of [choice('none'), choice('research', 0.2)]) {
      const { engine, executed } = setup(result);
      const run = await start(engine, [decision, work('research', { when: condition('research', { minConfidence: 0.8 }) }),
        work('review', { when: { stepId: 'decide', otherwise: true }, requireApproval: true })]);
      assert.equal(run.status, 'awaiting');
      assert.equal(run.states.review.status, 'awaiting');
      assert.deepEqual(executed, []);
      assert.equal(run.states.research.status, 'skipped');
    }
  });

  it('compares Noul probability and Score levels without boolean coercion', async () => {
    const { engine, executed } = setup();
    const run = await start(engine, [decision,
      work('ready', { when: { stepId: 'decide', questionId: 'ready', type: 'noul', operator: 'gte', value: 0.9 } }),
      work('not_ready', { when: { stepId: 'decide', questionId: 'ready', type: 'noul', operator: 'lt', value: 0.9 } }),
      work('quality', { when: { stepId: 'decide', questionId: 'quality', type: 'score', operator: 'gte', value: 1.5, minConfidence: 0.8 } }),
    ]);
    assert.equal(run.status, 'completed', run.error);
    assert.sameMembers(executed, ['ready', 'quality']);
  });

  it('fails closed for malformed answers rather than running a fallback', async () => {
    const { engine, executed } = setup({ answers: { route: { type: 'choice', choice: 1 } } });
    const run = await start(engine, [decision, work('research', { when: condition('research') }),
      work('fallback', { when: { stepId: 'decide', otherwise: true } })]);
    assert.equal(run.status, 'failed');
    assert.deepEqual(executed, []);
  });

  it('rejects nonexistent answers, mismatched types, invalid values and fallback-only graphs', async () => {
    const { engine } = setup();
    for (const when of [condition('unknown'), condition('research', { operator: 'gt' }),
      condition('research', { questionId: 'missing' }), condition('research', { type: 'noul' }),
      { stepId: 'decide', questionId: 'ready', type: 'noul', operator: 'gte', value: 0.5, minConfidence: 0.8 },
      { stepId: 'decide', questionId: 'quality', type: 'score', operator: 'gte', value: 3 },
      { stepId: 'decide', otherwise: true }]) {
      await rejects(engine.validate(graph([decision, work('branch', { when })])));
    }
    await rejects(engine.validate(graph([decision, work('branch', { when: condition('research'), dependsOn: [] })])));
    await rejects(engine.validate(graph([decision, work('branch', { when: condition('research') }),
      work('fallback1', { when: { stepId: 'decide', otherwise: true } }), work('fallback2', { when: { stepId: 'decide', otherwise: true } })])));
  });

  it('replays a decision and recalculates its branches while preserving unrelated skipped states', async () => {
    let answer = choice('research');
    const { engine } = setup(() => answer);
    const prior = await start(engine, [decision, work('research', { when: condition('research') }), work('review', { when: condition('review') })]);
    const branchReplay = await engine.replay({ runId: prior._id, userId: owner, stepId: 'research', requestKey: Random.id() });
    await engine.drive(branchReplay);
    assert.equal((await engine.get(branchReplay, owner)).states.review.status, 'skipped');
    answer = choice('review');
    const fullReplay = await engine.replay({ runId: prior._id, userId: owner, stepId: 'decide', requestKey: Random.id() });
    await engine.drive(fullReplay);
    const replayed = await engine.get(fullReplay, owner);
    assert.equal(replayed.status, 'completed', replayed.error);
    assert.equal(replayed.states.research.status, 'skipped');
    assert.equal(replayed.states.review.status, 'completed');
  });

  it('rechecks a conditional branch’s decision after approval waits and immediately before dispatch', async () => {
    for (const revokeBeforeApproval of [true, false]) {
      let decisionAllowed = true;
      const { engine, executed } = setup(choice(), async (userId, _missionId, step) => userId === owner && (step?.id !== 'decide' || decisionAllowed));
      const waiting = await start(engine, [decision, work('act', { when: condition('research'), requireApproval: true })]);
      assert.equal(waiting.status, 'awaiting');
      if (revokeBeforeApproval) decisionAllowed = false;
      let error;
      try { await engine.approve({ runId: waiting._id, userId: owner, stepId: 'act', fingerprint: waiting.states.act.fingerprint, approved: true }); }
      catch (failure) { error = failure; }
      if (revokeBeforeApproval) assert.equal(error?.error, 'workflow-not-authorized');
      else {
        assert.notExists(error);
        decisionAllowed = false;
        await engine.drive(waiting._id);
        assert.equal((await engine.get(waiting._id, owner)).status, 'failed');
      }
      assert.deepEqual(executed, []);
      assert.equal((await engine.get(waiting._id, owner)).states.decide.status, 'completed', 'retain the historical judgment');
    }
  });

  it('provides readable condition labels without serializing results', () => {
    assert.equal(workflowConditionLabel(condition('research', { minConfidence: 0.8 }), [decision]), 'Route work · route is research · confidence ≥ 80%');
    assert.equal(workflowConditionLabel({ stepId: 'decide', otherwise: true }, [decision]), 'Route work: no other branch matches');
  });
});

if (Meteor.isServer) describe('Constellation decision workflow adapter', function () {
  let workflowDecisionPrimitive;
  let workflowDecisionState;
  let withWorkflowDecisionFailure;
  const definition = { model: 'jev-latest', questions: { route: { type: 'choice', instructions: 'Choose a route.', criteria: { act: 'Act', review: 'Review' } } } };
  const inputFields = [
    { key: 'context', label: 'Context', type: 'text', required: true },
    { key: 'count', label: 'Count', type: 'number', required: true },
    { key: 'verified', label: 'Verified', type: 'boolean', required: true },
  ];
  const input = () => ({ nodeId: 'node', revision: 1, nodeName: 'Route', agent: 'orchestrator', agentRevision: 1,
    definition, inputFields, state: { context: 'Current task', count: 2, verified: false }, context: 'dependencies', contextField: 'context' });
  before(async () => ({ workflowDecisionPrimitive, workflowDecisionState, withWorkflowDecisionFailure } = await import('../server/decision-workflows.js')));

  it('keeps typed fields and adds dependency results only to the selected text input', () => {
    const state = workflowDecisionState(input(), { work: 'Evidence from specialist' });
    assert.equal(state.count, 2);
    assert.isFalse(state.verified);
    assert.include(state.context, 'Evidence from specialist');
    assert.sameMembers(Object.keys(state), ['context', 'count', 'verified']);
    assert.throws(() => workflowDecisionState({ ...input(), contextField: 'count' }, { work: 'Evidence' }), 'Choose a text input');
    assert.throws(() => workflowDecisionState({ ...input(), state: { context: 'Only text' } }), 'Count is required');
  });

  it('pins the node, threads durable request keys and never exposes a raw result as its summary', async () => {
    let observed;
    let checks = 0;
    const primitive = workflowDecisionPrimitive({
      async resolveNode(context, id, revision) { assert.equal(context.sessionId, 'mission'); assert.equal(id, 'node'); assert.equal(revision, 1); return { definition, inputFields }; },
      async evaluate(context, request) {
        observed = request; assert.equal(context.workflowRunId, 'run');
        return { _id: 'receipt', status: 'completed', model: 'jev-test', answers: { route: { type: 'choice', choice: 'review', confidence: 0.9 } } };
      },
    });
    const result = await primitive.execute(input(), { userId: 'owner', missionId: 'mission', run: { _id: 'run' }, step: { id: 'decide' },
      idempotencyKey: 'stable-key', signal: new AbortController().signal, outputs: { work: 'Evidence' }, async assertActive() { checks += 1; } });
    assert.equal(observed.requestKey, 'stable-key');
    assert.include(observed.state.context, 'Evidence');
    assert.equal(observed.state.count, 2);
    assert.isAtLeast(checks, 2);
    assert.equal(result.summary, 'route: review · 90% confidence');
    assert.equal(result.receipt.nodeRevision, 1);
    assert.notInclude(result.summary, '{');
  });

  it('rejects edited definitions before remote work, regardless of object key order', async () => {
    let calls = 0;
    const primitive = workflowDecisionPrimitive({
      async resolveNode() { return { definition: { ...definition, model: 'jev-changed' }, inputFields }; },
      async evaluate() { calls += 1; },
    });
    let failure;
    try { await primitive.execute(input(), { userId: 'owner', missionId: 'mission', run: { _id: 'run' }, step: { id: 'decide' }, outputs: {}, async assertActive() {} }); }
    catch (error) { failure = error; }
    assert.equal(failure?.error, 'workflow-decision-changed');
    assert.equal(calls, 0);
  });

  it('maps actionable service failures without leaking raw error details', async () => {
    for (const [code, text] of [['decision-key-missing', 'TypeSafe API key'], ['decision-revision-changed', 'Save the plan'], ['decision-budget-exhausted', 'limit']]) {
      let failure;
      try { await withWorkflowDecisionFailure(async () => { throw new Meteor.Error(code, 'sensitive-provider-payload'); }); }
      catch (error) { failure = error; }
      assert.match(failure.error, /^workflow-/);
      assert.include(failure.reason, text);
      assert.notInclude(failure.reason, 'sensitive');
    }
  });
});

if (Meteor.isClient) describe('Constellation decision plan editor', function () {
  this.timeout(20_000);
  const byId = (id) => document.getElementById(id);
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { if (Date.now() > deadline) assert.fail('Decision plan editor did not become ready'); await new Promise((resolve) => setTimeout(resolve, 20)); }
  };
  const change = (control, value) => { control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })); };
  let originalCall;
  let fixture;
  let saved;
  const node = {
    _id: 'decision-editor-node', name: 'Route incoming work', revision: 3, availableAgents: ['orchestrator'],
    inputFields: [{ key: 'context', label: 'Source text', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'number', required: true }, { key: 'urgent', label: 'Urgent', type: 'boolean', required: true }],
    questions: { route: { type: 'choice', criteria: { work: 'Execute', review: 'Review' } }, ready: { type: 'noul' } },
  };
  const fresh = () => ({ revision: 1, name: 'Decision editor fixture', strategy: 'workflow', steps: [
    { id: 'decide', primitive: 'decision', label: 'Route', agent: 'orchestrator', nodeId: node._id, nodeRevision: 3,
      nodeName: node.name, questions: node.questions, inputFields: node.inputFields, state: { context: 'A new request', amount: 5, urgent: false },
      context: 'none', contextField: 'context', dependsOn: [], requireApproval: true },
    { id: 'work', primitive: 'agent', label: 'Do the work', agent: 'orchestrator', prompt: 'Complete the task.', context: 'dependencies', dependsOn: ['decide'] },
    { id: 'review', primitive: 'approval', label: 'Review', prompt: 'Review uncertain requests.', dependsOn: ['work'] },
  ], budget: { steps: 20, timeoutMs: 600000, turns: 20, toolCalls: 20, spend: 5 } });
  before(async () => waitFor(() => Meteor.userId() && byId('app-frame')?.dataset.startupState === 'ready' && byId('mission-plan-dialog')));
  beforeEach(async () => {
    fixture = fresh(); saved = null; originalCall = Meteor.callAsync;
    Meteor.callAsync = async (method, ...args) => {
      if (method === 'constellation.workflowGet') return { definition: structuredClone(fixture), runs: [], decisionNodes: [node] };
      if (method === 'constellation.workflowSave') { saved = structuredClone(args[0]); fixture = { ...saved, revision: 2 }; return { definition: fixture }; }
      return originalCall.call(Meteor, method, ...args);
    };
    document.querySelector('[data-view="missions"]').click();
    byId('open-mission-plan').click();
    await waitFor(() => byId('mission-plan-dialog').open && !byId('op-plan-form').inert && byId('op-plan-steps').querySelector('[data-step-id="decide"]'));
  });
  afterEach(async () => {
    try {
      // Discard only the isolated fixture draft before restoring real methods.
      fixture = null;
      change(byId('op-plan-name'), 'Reset fixture');
      byId('op-discard-plan').click();
      await waitFor(() => !byId('op-plan-form').inert && byId('op-discard-plan').hidden);
      byId('mission-plan-dialog').close();
    } finally { Meteor.callAsync = originalCall; }
  });
  const row = (id) => byId('op-plan-steps').querySelector(`[data-step-id="${id}"]`);

  it('renders typed inputs, keeps false distinct from empty, and pins the selected node version', async () => {
    assert.equal(row('decide').querySelector('[data-decision-input="amount"]').type, 'number');
    assert.equal(row('decide').querySelector('[data-decision-input="urgent"]').value, 'false');
    change(row('decide').querySelector('[data-decision-input="amount"]'), '12');
    byId('op-save-plan').click();
    await waitFor(() => !!saved && !byId('op-plan-form').inert);
    assert.equal(saved.steps[0].state.amount, 12);
    assert.isFalse(saved.steps[0].state.urgent);
    assert.equal(saved.steps[0].nodeRevision, 3);
    assert.isTrue(saved.steps[0].requireApproval);
  });

  it('creates a fallback depending on the decision, not on the skipped sibling', async () => {
    change(row('work').querySelector('[data-branch-field="source"]'), 'decide');
    change(row('review').querySelector('[data-branch-field="source"]'), 'decide');
    change(row('review').querySelector('[data-branch-field="mode"]'), 'otherwise');
    byId('op-save-plan').click();
    await waitFor(() => !!saved && !byId('op-plan-form').inert);
    assert.deepEqual(saved.steps[2].dependsOn, ['decide']);
    assert.deepEqual(saved.steps[2].when, { stepId: 'decide', otherwise: true });
    assert.deepEqual(saved.steps[1].when, { stepId: 'decide', questionId: 'route', type: 'choice', operator: 'eq', value: 'work' });
  });

  it('does not silently turn a conditional action into an unconditional action when removing its decision', () => {
    change(row('work').querySelector('[data-branch-field="source"]'), 'decide');
    row('decide').querySelector('[data-step-remove]').click();
    assert.exists(row('decide'));
    assert.equal(row('work').querySelector('[data-branch-field="source"]').value, 'decide');
  });
});
