import { assert } from 'chai';
import { Random } from 'meteor/random';
import { Agent } from '../server/agent';
import { AgentMessages, AgentSessions } from '../common/collections';
import { AgentWorkflowRuns, WorkflowEngine, workflowCanonical } from '../server/workflows';
import { assertWorkflowSessionExecution, readWorkflowAgentOutcome, workflowAgentPrimitive, workflowApprovalPrimitive } from '../server/workflows-agent';
import { mockProvider } from '../server/providers/mock';
import type { WorkflowDefinition, WorkflowStep } from '../common/workflows';

const OWNER = 'workflow-test-owner';
const MISSION = 'workflow-test-mission';
const namespace = 'workflow-tests';
const budget = { steps: 16, timeoutMs: 60_000, turns: 8, toolCalls: 8, spend: 2 };
const node = (id: string, dependsOn: string[] = [], extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id, label: id, primitive: 'echo', version: 1, input: { text: id }, dependsOn, ...extra,
});
const graph = (steps = [node('first'), node('second', ['first'])]): WorkflowDefinition => ({
  id: MISSION, revision: 1, name: 'Test workflow', strategy: 'workflow', steps, budget,
});
const rejects = async (work: Promise<unknown>, code: string) => {
  try { await work; } catch (error) {
    assert.equal((error as any).error, code);
    return;
  }
  assert.fail(`Expected ${code}`);
};
const waitFor = async (work: () => Promise<boolean>) => {
  for (let count = 0; count < 200; count += 1) {
    if (await work()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Workflow did not reach the expected state');
};
const engineFor = (authorize = async (userId: string) => userId === OWNER) => {
  const engine = new WorkflowEngine({ namespace, authorize });
  engine.wake = () => {};
  engine.register({
    name: 'echo', version: 1, label: 'Echo', replay: 'safe',
    inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
    outputSchema: { type: 'string' },
    async execute(input, context) {
      await context.assertActive();
      return { output: `${input.text}:${Object.values(context.outputs).join(',')}`, summary: String(input.text) };
    },
  });
  return engine;
};
const start = (engine: WorkflowEngine, definition = graph(), requestKey = Random.id()) => engine.start({
  userId: OWNER, missionId: MISSION, definition, requestKey,
});

describe('durable declarative workflows', function () {
  this.timeout(30_000);
  beforeEach(async () => {
    await AgentWorkflowRuns.removeAsync({ namespace });
    const owned = await AgentSessions.find({ userId: OWNER }).fetchAsync();
    await AgentMessages.removeAsync({ sessionId: { $in: owned.map((row) => row._id) } });
    await AgentSessions.removeAsync({ userId: OWNER });
  });

  it('rejects cycles, missing dependencies, unsafe JSON keys and invalid primitive inputs', async () => {
    const engine = engineFor();
    await rejects(engine.validate(graph([node('first', ['second']), node('second', ['first'])])), 'invalid-workflow');
    await rejects(engine.validate(graph([node('first', ['missing'])])), 'invalid-workflow');
    await rejects(engine.validate(graph([node('first', [], { input: { text: 4 } })])), 'invalid-workflow');
    assert.throws(() => workflowCanonical(JSON.parse('{"$where":"bad"}')), 'unsupported field');
    assert.throws(() => workflowCanonical(JSON.parse('{"__proto__":{}}')), 'unsupported field');
    await rejects(engine.validate(graph([node('first', [], { version: 99 })])), 'workflow-primitive-unavailable');
  });

  it('freezes a versioned graph, executes dependencies and deduplicates start requests', async () => {
    const engine = engineFor();
    const id = await start(engine, graph(), 'same-request');
    assert.equal(await start(engine, graph(), 'same-request'), id);
    await rejects(start(engine, { ...graph(), revision: 2 }, 'same-request'), 'workflow-request-conflict');
    await engine.drive(id);
    const run = await engine.get(id, OWNER);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.states.second.output, 'second:first:');
    assert.equal(run.executions, 2);
    await rejects(engine.get(id, 'another-user'), 'workflow-not-found');
  });

  it('runs independent nodes concurrently and commits the join after both finish', async () => {
    const engine = engineFor();
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    engine.register({
      name: 'parallel', version: 1, label: 'Parallel', replay: 'safe', inputSchema: { type: 'object' },
      async execute(_input, context) {
        started += 1;
        if (started === 2) release();
        await barrier;
        return { output: context.step.id };
      },
    });
    const id = await start(engine, graph([
      node('one', [], { primitive: 'parallel' }), node('two', [], { primitive: 'parallel' }), node('join', ['one', 'two']),
    ]));
    await engine.drive(id);
    assert.equal(started, 2);
    assert.equal((await engine.get(id, OWNER)).states.join.output, 'join:one,two');
  });

  it('requires the exact reviewed input and result fingerprint, then checks current authority again', async () => {
    let authorized = true;
    const engine = engineFor(async () => authorized);
    engine.register(workflowApprovalPrimitive());
    const id = await start(engine, graph([
      node('first'), node('review', ['first'], { primitive: 'approval', input: { prompt: 'Review the result' } }),
    ]));
    await engine.drive(id);
    const waiting = await engine.get(id, OWNER);
    assert.equal(waiting.status, 'awaiting');
    assert.equal(waiting.states.review.waitReason, 'approval');
    assert.equal(waiting.states.review.attempts, 0);
    await rejects(engine.approve({ runId: id, userId: OWNER, stepId: 'review', approved: true, fingerprint: 'old-review' }), 'workflow-review-changed');
    authorized = false;
    await rejects(engine.approve({ runId: id, userId: OWNER, stepId: 'review', approved: true, fingerprint: waiting.states.review.fingerprint }), 'workflow-not-authorized');
    authorized = true;
    await engine.approve({ runId: id, userId: OWNER, stepId: 'review', approved: true, fingerprint: waiting.states.review.fingerprint });
    await engine.drive(id);
    const completed = await engine.get(id, OWNER);
    assert.equal(completed.status, 'completed');
    assert.notProperty(completed.states.review, 'waitReason');
  });

  it('persists an explicit background-work wait and clears it when the step completes', async () => {
    let ready = false;
    const engine = engineFor().register({
      name: 'background', version: 1, label: 'Background work', replay: 'safe', inputSchema: { type: 'object' },
      async execute() {
        return ready ? { output: 'Finished' } : { waiting: true, waitReason: 'processing', summary: 'Work is underway.' };
      },
    });
    const id = await start(engine, graph([node('work', [], { primitive: 'background' })]));
    await engine.drive(id);
    const waiting = await engine.get(id, OWNER);
    assert.equal(waiting.status, 'awaiting');
    assert.equal(waiting.states.work.waitReason, 'processing');
    ready = true;
    await engine.retry(id, OWNER, 'work');
    await engine.drive(id);
    const completed = await engine.get(id, OWNER);
    assert.equal(completed.status, 'completed');
    assert.notProperty(completed.states.work, 'waitReason');
  });

  it('keeps the lease when an identical receipt checkpoint is a Mongo no-op', async () => {
    const engine = engineFor().register({
      name: 'checkpoint', version: 1, label: 'Checkpoint', replay: 'idempotent', inputSchema: { type: 'object' },
      async execute(_input, context) {
        await context.checkpoint({ receipt: 'unchanged' });
        await context.checkpoint({ receipt: 'unchanged' });
        return { output: 'Complete' };
      },
    });
    const collection = AgentWorkflowRuns.rawCollection();
    const originalCollection = AgentWorkflowRuns.rawCollection;
    const original = collection.updateOne;
    let noOpObserved = false;
    collection.updateOne = (async function (selector: any, modifier: any, options?: any) {
      if (modifier.$set?.['states.work.receipt']) {
        const current = await collection.findOne(selector);
        // Pin only the checkpoint timestamp to the preceding write's exact
        // millisecond, reproducing fast approval reconciliation deterministically.
        if (current) modifier.$set.updatedAt = current.updatedAt;
      }
      const result = await (original as any).call(collection, selector, modifier, options);
      if (modifier.$set?.['states.work.receipt'] && result.matchedCount === 1 && result.modifiedCount === 0) noOpObserved = true;
      return result;
    }) as typeof original;
    AgentWorkflowRuns.rawCollection = () => collection;
    try {
      const id = await start(engine, graph([node('work', [], { primitive: 'checkpoint' })]));
      await engine.drive(id);
      const run = await engine.get(id, OWNER);
      assert.equal(run.status, 'completed', run.states.work.error ?? run.error);
      assert.isTrue(noOpObserved, 'The regression must exercise a matched but unmodified write.');
    } finally {
      AgentWorkflowRuns.rawCollection = originalCollection;
      collection.updateOne = original;
    }
  });

  it('rechecks permission after an approval and does not dispatch a revoked step', async () => {
    let authorized = true;
    const engine = engineFor(async () => authorized);
    const id = await start(engine, graph([node('first', [], { requireApproval: true })]));
    await engine.drive(id);
    const waiting = await engine.get(id, OWNER);
    await engine.approve({ runId: id, userId: OWNER, stepId: 'first', approved: true, fingerprint: waiting.states.first.fingerprint });
    authorized = false;
    await engine.drive(id);
    const run = await engine.get(id, OWNER);
    assert.equal(run.status, 'failed');
    assert.equal(run.executions, 0);
  });

  it('recovers interrupted idempotent work with its original receipt and refuses uncertain external effects', async () => {
    const engine = engineFor();
    let effects = 0;
    engine.register({ name: 'external', version: 1, label: 'Publish', replay: 'never', inputSchema: { type: 'object' },
      async execute() { effects += 1; return { output: 'published' }; } });
    const id = await start(engine, graph([node('publish', [], { primitive: 'external' })]));
    await AgentWorkflowRuns.updateAsync(id, { $set: {
      status: 'running', 'states.publish.status': 'running', 'states.publish.attempts': 1,
      lease: { token: 'old-worker', until: new Date(0) },
    } } as any);
    await engine.drive(id);
    assert.equal((await engine.get(id, OWNER)).status, 'failed');
    assert.equal(effects, 0);
    await rejects(engine.retry(id, OWNER, 'publish'), 'workflow-replay-unsafe');
  });

  it('a stop wins over a late result and cancels the registered external work', async () => {
    const engine = engineFor();
    let begun!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { begun = resolve; });
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    let cancelled = 0;
    engine.register({ name: 'wait', version: 1, label: 'Wait', replay: 'safe', inputSchema: { type: 'object' },
      async execute() { begun(); await blocked; return { output: 'late' }; },
      async cancel() { cancelled += 1; finish(); },
    });
    const id = await start(engine, graph([node('waiting', [], { primitive: 'wait' })]));
    const worker = engine.drive(id);
    await entered;
    await engine.cancel(id, OWNER);
    await worker;
    const run = await engine.get(id, OWNER);
    assert.equal(cancelled, 1);
    assert.equal(run.status, 'cancelled');
    assert.notExists(run.states.waiting.output);
  });

  it('replays a safe branch from saved ancestor outputs and preserves the original run', async () => {
    const engine = engineFor();
    const id = await start(engine);
    await engine.drive(id);
    const replayId = await engine.replay({ runId: id, userId: OWNER, stepId: 'second', requestKey: 'replay-once' });
    assert.equal(await engine.replay({ runId: id, userId: OWNER, stepId: 'second', requestKey: 'replay-once' }), replayId);
    await engine.drive(replayId);
    const replay = await engine.get(replayId, OWNER);
    assert.equal(replay.status, 'completed');
    assert.equal(replay.executions, 1);
    assert.equal(replay.states.second.output, 'second:first:');
    assert.equal(replay.parentRunId, id);
    assert.equal((await engine.get(id, OWNER)).executions, 2);
  });

  it('runs a real Agent in an owned durable child Session and supports a safe model-only replay', async () => {
    const agent = new Agent('workflow-test-agent', {
      model: 'mock', instructions: 'Answer briefly.', tools: [],
      provider: mockProvider(() => ({ text: 'A real agent result.' })),
    });
    const now = new Date();
    await AgentSessions.insertAsync({ _id: MISSION, agent: agent.name, userId: OWNER, model: 'mock',
      phase: 'idle', nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 }, createdAt: now, updatedAt: now });
    const engine = engineFor().register(workflowAgentPrimitive());
    const definition = graph([node('answer', [], {
      primitive: 'agent', input: { agent: agent.name, prompt: 'Give an answer.', revision: 1 },
    })]);
    definition.budget = { ...budget, turns: 1 };
    const id = await start(engine, definition);
    await engine.drive(id);
    const run = await engine.get(id, OWNER);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.states.answer.output, 'A real agent result.');
    assert.isTrue(run.states.answer.replayAllowed);
    const child = await AgentSessions.findOneAsync(run.states.answer.childSessionId!);
    assert.equal(child?.parent?.sessionId, MISSION);
    assert.equal(child?.userId, OWNER);
    await rejects(assertWorkflowSessionExecution(child!._id), 'workflow-inactive');
    const replayId = await engine.replay({ runId: id, userId: OWNER, stepId: 'answer', requestKey: 'rerun-model' });
    await engine.drive(replayId);
    assert.equal((await engine.get(replayId, OWNER)).status, 'completed');
  });

  it('parks an Agent tool approval without charging repeated polling as new steps', async () => {
    let calls = 0;
    const agent = new Agent('workflow-approval-agent', {
      model: 'mock', instructions: '',
      tools: [{ name: 'publish', description: 'Publish test', args: { type: 'object', properties: {} }, gate: 'ask',
        run: async () => { calls += 1; return 'published'; } }],
      provider: mockProvider((request) => request.messages.some((message) => message.role === 'tool')
        ? { text: 'Published.' }
        : { toolCalls: [{ id: 'workflow-tool-approval', name: 'publish', args: {} }] }),
    });
    const now = new Date();
    await AgentSessions.insertAsync({ _id: MISSION, agent: agent.name, userId: OWNER, model: 'mock',
      phase: 'idle', nextSeq: 0, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 }, createdAt: now, updatedAt: now });
    let savedRevisionCurrent = true;
    const engine = engineFor(async () => savedRevisionCurrent).register(workflowAgentPrimitive());
    const id = await start(engine, graph([node('publish', [], {
      primitive: 'agent', input: { agent: agent.name, prompt: 'Publish.', revision: 1 },
    })]));
    await engine.drive(id);
    let run = await engine.get(id, OWNER);
    assert.equal(run.status, 'awaiting');
    assert.equal(run.states.publish.waitReason, 'approval');
    assert.equal(calls, 0);
    await engine.poll();
    await engine.drive(id);
    run = await engine.get(id, OWNER);
    assert.equal(run.executions, 1);
    assert.equal(run.states.publish.attempts, 1);
    const childId = run.states.publish.childSessionId!;
    savedRevisionCurrent = false;
    await rejects(assertWorkflowSessionExecution(childId, { toolCall: true }), 'workflow-not-authorized');
    savedRevisionCurrent = true;
    await agent.approve(childId, { userId: OWNER, expectedToolCallId: 'workflow-tool-approval' });
    // A verdict changes phase to idle before Activation owns/resumes the
    // parked call. Polling that checkpoint must never read the tool-use-only
    // assistant row as a failed or complete answer.
    await engine.poll();
    await engine.drive(id);
    const afterApproval = await engine.get(id, OWNER);
    const approvalChild = await AgentSessions.findOneAsync(childId);
    assert.notEqual(afterApproval.status, 'failed', JSON.stringify({
      run: afterApproval, child: approvalChild,
      messages: await AgentMessages.find({ sessionId: childId }, { sort: { seq: 1 } }).fetchAsync(),
    }));
    await waitFor(async () => {
      const child = await AgentSessions.findOneAsync(childId);
      return child?.phase === 'idle' && !child.pending && !child.lease;
    });
    await engine.poll();
    await engine.drive(id);
    run = await engine.get(id, OWNER);
    assert.equal(run.status, 'completed', run.states.publish.error ?? run.error);
    assert.notProperty(run.states.publish, 'waitReason');
    assert.equal(calls, 1);
    assert.isFalse(run.states.publish.replayAllowed);
    await rejects(engine.replay({ runId: id, userId: OWNER, stepId: 'publish', requestKey: 'unsafe-replay' }), 'workflow-replay-unsafe');
  });

  it('defers a stale empty outcome when approval completion changes the checkpoint between reads', async () => {
    const now = new Date();
    await AgentSessions.insertAsync({ _id: MISSION, agent: 'workflow-race-fixture', userId: OWNER, model: 'mock',
      phase: 'idle', nextSeq: 1, usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      createdAt: now, updatedAt: now });
    await AgentMessages.insertAsync({ _id: Random.id(), sessionId: MISSION, seq: 0, role: 'assistant',
      content: '', toolCalls: [{ id: 'reviewed-tool', name: 'publish', args: {} }], createdAt: now });
    const original = AgentMessages.findOneAsync;
    let intercepted = false;
    // Force the exact interleaving: the reader has the old empty assistant
    // row, then the resumed worker commits its answer and becomes idle before
    // the workflow's final Session read. No timers or scheduler luck needed.
    AgentMessages.findOneAsync = (async function (selector: any, options: any) {
      const result = await original.call(AgentMessages, selector, options);
      if (!intercepted && selector?.sessionId === MISSION && selector?.role === 'assistant') {
        intercepted = true;
        await AgentMessages.insertAsync({ _id: Random.id(), sessionId: MISSION, seq: 1, role: 'assistant',
          content: 'Published.', createdAt: new Date() });
        await AgentSessions.updateAsync(MISSION, { $set: { nextSeq: 2, updatedAt: new Date() } });
      }
      return result;
    }) as typeof original;
    try {
      assert.deepEqual(await readWorkflowAgentOutcome(MISSION), { ok: false, kind: 'processing' });
      assert.isTrue(intercepted);
    } finally { AgentMessages.findOneAsync = original; }
    assert.deepEqual(await readWorkflowAgentOutcome(MISSION), { ok: true, text: 'Published.' });
    await AgentMessages.updateAsync({ sessionId: MISSION, seq: 1 }, { $set: { content: '' } });
    assert.deepEqual(await readWorkflowAgentOutcome(MISSION), {
      ok: false, kind: 'failed', reason: 'The turn produced no reply.',
    }, 'An unchanged terminal failure must not be hidden as background work.');
  });
});
