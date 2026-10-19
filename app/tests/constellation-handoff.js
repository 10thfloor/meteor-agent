import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

if (Meteor.isServer) describe('Shared-conversation handoff integration', function () {
  this.timeout(30_000);
  let api; let sessionId; let source; let target; let owner; let childIds;
  const waitFor = async (condition, message) => {
    const deadline = Date.now() + 15_000;
    while (!await condition()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const model = (agent) => ({ id: `m:${agent}`, kind: 'model', role: 'member', agent, displayName: agent, joinedAt: new Date() });
  const handoff = (agent = target, message = 'Review the evidence.') => ({ id: Random.id(), name: api.HANDOFF_TOOL_NAME, args: { agent, message } });
  const define = (name, reply, config = {}) => new api.Agent(name, {
    model: 'mock', instructions: '', tools: [], provider: { async *stream(request) {
      const turn = await reply(request);
      if (turn.text) yield { kind: 'text', chunk: turn.text };
      yield { kind: 'done', toolCalls: turn.toolCalls, usage: { input: 1, output: 1 } };
    } }, ...config,
  });
  const settle = () => waitFor(async () => {
    const session = await api.AgentSessions.findOneAsync(sessionId);
    return session?.phase === 'idle' && !session.lease && !session.pendingRelay;
  }, 'Conversation did not settle');
  const send = (text = 'Please arrange a review.') => new api.Agent(source).send(sessionId, text, { userId: owner });
  before(async () => { api = await import('meteor/10thfloor:agent'); await api.startupComplete; });
  beforeEach(async () => {
    sessionId = Random.id(); owner = `handoff-owner-${Random.id()}`;
    source = `handoff-source-${Random.id(6)}`; target = `handoff-target-${Random.id(6)}`; childIds = [];
    define(source, () => ({ text: 'Source finished.' })); define(target, () => ({ text: 'Recipient finished.' }));
    await api.AgentSessions.insertAsync({
      _id: sessionId, agent: source, userId: owner, phase: 'idle', model: 'mock', nextSeq: 0,
      participants: [{ id: `h:${owner}`, kind: 'human', role: 'owner', userId: owner, displayName: 'Owner', joinedAt: new Date() }, model(source), model(target)],
      usage: { input: 0, output: 0, cost: 0 }, budgetSpent: { turns: 0, toolCalls: 0 }, createdAt: new Date(), updatedAt: new Date(),
    });
  });
  afterEach(async () => {
    childIds = (await api.AgentSessions.find({ 'parent.sessionId': sessionId }).fetchAsync()).map((row) => row._id);
    await api.AgentSessions.removeAsync({ _id: { $in: [sessionId, ...childIds] } });
    await api.AgentMessages.removeAsync({ sessionId: { $in: [sessionId, ...childIds] } });
    await api.AgentDeltas.removeAsync({ sessionId: { $in: [sessionId, ...childIds] } });
  });

  it('hands off with ordinary preamble and delivers an attributed message in the same conversation', async () => {
    let sourceCalls = 0; let sawRequest = false;
    define(source, () => { sourceCalls += 1; return { text: 'I will ask my colleague to review this.', toolCalls: [handoff()] }; });
    define(target, (request) => { sawRequest = JSON.stringify(request.messages).includes('Review the evidence.'); return { text: 'Evidence reviewed.' }; });
    await send();
    await waitFor(async () => !!await api.AgentMessages.findOneAsync({ sessionId, content: 'Evidence reviewed.' }), 'The recipient did not respond');
    await settle();
    assert.equal(sourceCalls, 1); assert.isTrue(sawRequest);
    const receipt = await api.AgentMessages.findOneAsync({ sessionId, kind: 'handoff' });
    assert.equal(receipt.to, `m:${target}`); assert.equal(receipt.from.participant, `m:${source}`);
    assert.equal(receipt.transcriptContent, 'Review the evidence.'); assert.isUndefined(receipt.childSessionId);
    assert.equal((await api.AgentSessions.findOneAsync(sessionId)).budgetSpent.toolCalls, 1);
    assert.equal(await api.AgentSessions.find({ 'parent.sessionId': sessionId }).countAsync(), 0);
  });

  it('caps structured ping-pong, then accepts a new human request', async () => {
    define(source, () => ({ toolCalls: [handoff()] }), { budget: { relay: 1 } });
    define(target, () => ({ toolCalls: [handoff(source, 'Your turn.')] }));
    await send();
    await waitFor(async () => !!await api.AgentMessages.findOneAsync({ sessionId, kind: 'budget', budget: 'relay' }), 'Relay cap was not enforced');
    await settle();
    assert.equal(await api.AgentMessages.find({ sessionId, kind: 'handoff' }).countAsync(), 1);
    assert.equal((await api.AgentSessions.findOneAsync(sessionId)).relay, 1);
    define(source, () => ({ text: 'Human request accepted.' }));
    await send('Enough handoffs, summarize.');
    await waitFor(async () => !!await api.AgentMessages.findOneAsync({ sessionId, content: 'Human request accepted.' }), 'Human request was blocked');
    await settle(); assert.equal((await api.AgentSessions.findOneAsync(sessionId)).relay, 0);
  });

  it('refuses unrostered recipients without waking them', async () => {
    let sourceCalls = 0; let targetCalls = 0;
    define(source, () => ++sourceCalls === 1 ? { toolCalls: [handoff('absent-colleague')] } : { text: 'Choose another colleague.' });
    define(target, () => { targetCalls += 1; return { text: 'Should not run.' }; });
    await send();
    await waitFor(async () => !!await api.AgentMessages.findOneAsync({ sessionId, content: 'Choose another colleague.' }), 'Source did not receive refusal');
    await settle(); assert.equal(targetCalls, 0);
    assert.equal((await api.AgentMessages.findOneAsync({ sessionId, role: 'tool' })).error.error, 'handoff-unavailable');
    assert.equal(await api.AgentMessages.find({ sessionId, kind: 'handoff' }).countAsync(), 0);
  });

  it('rechecks a recipient removed while the source model was generating', async () => {
    let sourceCalls = 0; let targetCalls = 0;
    define(source, async () => {
      if (++sourceCalls !== 1) return { text: 'Colleague unavailable.' };
      await api.Agent.participants.remove(sessionId, `m:${target}`);
      return { text: 'I have a handoff ready.', toolCalls: [handoff()] };
    });
    define(target, () => { targetCalls += 1; return { text: 'Should not run.' }; });
    await send();
    await waitFor(async () => !!await api.AgentMessages.findOneAsync({ sessionId, content: 'Colleague unavailable.' }), 'Removed recipient was not refused');
    await settle(); assert.equal(targetCalls, 0);
    assert.equal(await api.AgentMessages.find({ sessionId, kind: 'handoff' }).countAsync(), 0);
  });

  it('rejects a mixed batch before any side effect and answers every call', async () => {
    let sourceCalls = 0; let ran = 0;
    define(source, () => ++sourceCalls === 1 ? { toolCalls: [handoff(), { id: 'ordinary', name: 'ordinary', args: {} }] } : { text: 'I will choose one action.' }, {
      tools: [{ name: 'ordinary', args: { type: 'object' }, description: '', run: async () => { ran += 1; return 'done'; } }],
    });
    await send();
    await waitFor(async () => !!await api.AgentMessages.findOneAsync({ sessionId, content: 'I will choose one action.' }), 'Batch did not settle');
    await settle(); assert.equal(ran, 0);
    const rows = await api.AgentMessages.find({ sessionId, role: 'tool' }).fetchAsync();
    assert.lengthOf(rows, 2); rows.forEach((row) => assert.equal(row.error.error, 'handoff-batch'));
  });

  it('does not expose handoff inside a delegated child session', async () => {
    let sourceCalls = 0; let childHadHandoff = false;
    define(source, () => ++sourceCalls === 1 ? { toolCalls: [{ id: 'delegate-one', name: 'delegate_review', args: { prompt: 'Review this privately.' } }] } : { text: 'Delegation finished.' }, {
      tools: [{ subagent: target, name: 'delegate_review', description: 'Private review' }],
    });
    define(target, (request) => { childHadHandoff = request.tools.some((tool) => tool.name === api.HANDOFF_TOOL_NAME); return { text: 'Private review done.' }; });
    await send();
    await waitFor(async () => !!await api.AgentMessages.findOneAsync({ sessionId, content: 'Delegation finished.' }), 'Delegation did not finish');
    await settle(); assert.isFalse(childHadHandoff);
    assert.equal(await api.AgentSessions.find({ 'parent.sessionId': sessionId }).countAsync(), 1);
  });

  it('never falls back to the primary when an explicitly addressed queued recipient is removed', async () => {
    let sourceCalls = 0; let targetCalls = 0;
    define(source, () => { sourceCalls += 1; return { text: 'Primary must not answer.' }; });
    define(target, () => { targetCalls += 1; return { text: 'Removed recipient must not answer.' }; });
    await api.AgentSessions.updateAsync(sessionId, { $set: { phase: 'awaiting', pending: {
      toolCallId: 'fixture-park', name: 'fixture', args: {}, agent: source, requestedAt: new Date(),
    } } });
    await Meteor.server.method_handlers['agent.send'].call({ userId: owner }, source, sessionId, 'For the selected colleague only.', undefined, { to: `m:${target}` });
    const queued = await api.AgentMessages.findOneAsync({ sessionId, role: 'user' });
    assert.equal(queued.to, `m:${target}`);
    await api.Agent.participants.remove(sessionId, `m:${target}`);
    await api.AgentSessions.updateAsync(sessionId, { $set: { phase: 'idle', updatedAt: new Date(Date.now() - 5000) }, $unset: { pending: 1 } });
    const watcher = api.startWatcher({ sweepMs: 20, verdictGraceMs: 1000 });
    try {
      await waitFor(async () => !(await api.AgentSessions.findOneAsync(sessionId)).pendingInputs?.length, 'Queued unavailable recipient was not reconciled');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sourceCalls, 0); assert.equal(targetCalls, 0);
      assert.equal(await api.AgentMessages.find({ sessionId, role: 'assistant' }).countAsync(), 0);
    } finally { await watcher.stop(); }
  });
});
