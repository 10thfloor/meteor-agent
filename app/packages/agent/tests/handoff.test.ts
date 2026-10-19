import { assert } from 'chai';
import { Random } from 'meteor/random';
import type { AgentSession, AgentToolCall, SessionParticipant } from '../common/types';
import { AgentMessages, AgentSessions, AgentDeltas } from '../common/collections';
import { Agent } from '../server/agent';
import { mockProvider } from '../server/providers/mock';
import { modelFrom, participantsBlock } from '../common/participants';
import { prepareToolRuntime } from '../server/tool-runtime';
import { dispatchCalls, type DispatchLimits } from '../server/dispatch';
import { HANDOFF_TOOL_NAME, HANDOFF_MESSAGE_MAX, commitHandoff } from '../server/handoff';
import { SERVER_ID } from '../server/lease';
import { commitLeasedMessage, toProviderMessages } from '../server/transcript';

const participant = (agent: string): SessionParticipant => ({
  id: `m:${agent}`, agent, kind: 'model', role: 'member', displayName: agent, joinedAt: new Date(),
});
const waitFor = async (condition: () => Promise<boolean>, label: string) => {
  const until = Date.now() + 15000;
  while (!(await condition())) {
    if (Date.now() > until) assert.fail(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('structured conversation handoff', function () {
  this.timeout(25000);
  let session: AgentSession;
  let source: string;
  let target: string;
  let messageId: string;
  let calls: AgentToolCall[];
  const call = (args: unknown): AgentToolCall => ({ id: Random.id(), name: HANDOFF_TOOL_NAME, args });
  beforeEach(async () => {
    source = `handoff-a-${Random.id(6)}`; target = `handoff-b-${Random.id(6)}`; messageId = Random.id();
    new Agent(source, { model: 'mock', instructions: '', tools: [], provider: mockProvider(() => ({ text: 'source final' })) });
    new Agent(target, { model: 'mock', instructions: '', tools: [], provider: mockProvider(() => ({ text: 'target final' })) });
    session = {
      _id: Random.id(), agent: source, userId: 'handoff-owner', phase: 'calling', model: 'mock', nextSeq: 1,
      usage: { input: 0, output: 0, cost: 0 }, budgetSpent: { turns: 1, toolCalls: 0 },
      participants: [participant(source), { ...participant(target), displayName: 'Reviewer' }],
      lease: { serverId: SERVER_ID, until: new Date(Date.now() + 120000) }, createdAt: new Date(), updatedAt: new Date(),
    };
    calls = [call({ agent: target, message: 'Please review the evidence.' })];
    await AgentSessions.insertAsync(session);
  });
  afterEach(async () => {
    await AgentSessions.removeAsync(session._id);
    await AgentMessages.removeAsync({ sessionId: session._id });
    await AgentDeltas.removeAsync({ sessionId: session._id });
    const { AgentIdentities, AgentConstitutions, AgentLearningEvents, AgentMemoryFrames } = await import('../server/learning-collections');
    await AgentMemoryFrames.removeAsync({ sessionId: session._id });
    await AgentLearningEvents.removeAsync({ agentId: `identity-${session._id}` });
    await AgentConstitutions.removeAsync({ agentId: `identity-${session._id}` });
    await AgentIdentities.removeAsync(`identity-${session._id}`);
  });
  const dispatch = async (options: { specs?: any[]; limits?: Partial<DispatchLimits>; budget?: { relay?: number; toolCalls?: number } } = {}) => {
    await AgentMessages.insertAsync({ _id: messageId, sessionId: session._id, seq: 0, role: 'assistant',
      content: '', toolCalls: calls, from: modelFrom(source), createdAt: new Date() });
    const runtime = await prepareToolRuntime({ specs: options.specs ?? [], conversation: { session, agent: source } });
    return dispatchCalls(session._id, calls, runtime.tools, {
      userId: session.userId, agent: source, messageId, assistantSeq: 0, batchIds: calls.map((row) => row.id), from: modelFrom(source),
    }, options.budget, { maxResultChars: 8000, ...options.limits }, async () => { assert.fail('Handoff must not create a child or directly invoke another turn.'); });
  };

  it('advertises only for shared rostered conversations and reserves its name', async () => {
    const prepare = (patch: Partial<AgentSession>) => prepareToolRuntime({ specs: [], conversation: { session: { ...session, ...patch }, agent: source } });
    assert.include((await prepare({})).schemas.map((row) => row.name), HANDOFF_TOOL_NAME);
    for (const patch of [{ participants: [participant(source)] }, { parent: { sessionId: 'parent', toolCallId: 'call' } }, { ephemeral: true }] as Partial<AgentSession>[]) {
      assert.notInclude((await prepare(patch)).schemas.map((row) => row.name), HANDOFF_TOOL_NAME);
    }
    let refused = false;
    try { await prepareToolRuntime({ specs: [{ name: HANDOFF_TOOL_NAME, args: {}, description: '', run: async () => 'spoof' }] }); }
    catch (error) { refused = true; assert.include(String(error), 'reserved'); }
    assert.isTrue(refused);
    const prompt = participantsBlock(session, source);
    assert.include(prompt, HANDOFF_TOOL_NAME); assert.include(prompt, `agent="${target}"`);
    assert.notInclude(prompt, 'starting your reply');
  });

  it('atomically records the addressed message, activation and both budget charges', async () => {
    assert.equal(await dispatch(), 'ended');
    const receipt = (await AgentMessages.findOneAsync({ sessionId: session._id, kind: 'handoff' }))!;
    assert.equal(receipt.role, 'tool'); assert.equal(receipt.toolCallId, calls[0].id);
    assert.equal(receipt.to, `m:${target}`); assert.deepEqual(receipt.from, modelFrom(source));
    assert.equal(receipt.displayContent, 'Sent to Reviewer'); assert.equal(receipt.transcriptContent, 'Please review the evidence.');
    const after = (await AgentSessions.findOneAsync(session._id))!;
    assert.equal(after.pendingRelay?.agent, target); assert.equal(after.relay, 1); assert.equal(after.budgetSpent.toolCalls, 1);
    assert.notProperty(receipt, 'childSessionId'); assert.isUndefined(after.activeChild);
  });

  it('keeps retries idempotent without scheduling or charging a second handoff', async () => {
    await dispatch(); const before = (await AgentSessions.findOneAsync(session._id))!;
    const outcome = await commitHandoff({ sessionId: session._id, sourceAgent: source, userId: session.userId,
      messageId, toolCallId: calls[0].id, args: calls[0].args, relayCap: 4, authorize: async () => true });
    assert.equal(outcome.kind, 'committed');
    const after = (await AgentSessions.findOneAsync(session._id))!;
    assert.deepEqual(after.pendingRelay, before.pendingRelay); assert.equal(after.relay, 1); assert.equal(after.budgetSpent.toolCalls, 1);
    assert.equal(await AgentMessages.find({ sessionId: session._id, kind: 'handoff' }).countAsync(), 1);
  });

  it('refuses self, unrostered and unregistered targets without spending a hop', async () => {
    for (const invalid of [source, 'someone-else', 'missing-registration']) {
      if (invalid === 'missing-registration') await AgentSessions.updateAsync(session._id, { $push: { participants: participant(invalid) } });
      const result = await commitHandoff({ sessionId: session._id, sourceAgent: source, userId: session.userId,
        messageId, toolCallId: calls[0].id, args: { agent: invalid, message: 'Hello' }, relayCap: 4, authorize: async () => true });
      assert.equal(result.kind, 'refused');
    }
    const after = (await AgentSessions.findOneAsync(session._id))!;
    assert.isUndefined(after.pendingRelay); assert.isUndefined(after.relay); assert.equal(after.budgetSpent.toolCalls, 0);
  });

  it('rejects empty, oversized and extra-field arguments', async () => {
    for (const args of [null, { agent: target, message: ' ' }, { agent: target, message: 'x'.repeat(HANDOFF_MESSAGE_MAX + 1) }, { agent: target, message: 'Hi', sessionId: 'elsewhere' }]) {
      const result = await commitHandoff({ sessionId: session._id, sourceAgent: source, userId: session.userId,
        messageId, toolCallId: calls[0].id, args, relayCap: 4, authorize: async () => true });
      assert.equal(result.kind, 'refused');
      if (result.kind === 'refused') assert.equal(result.result.error?.error, 'invalid-args');
    }
    assert.equal(await AgentMessages.find({ sessionId: session._id }).countAsync(), 0);
  });

  it('refuses mixed batches without executing any of their ordinary tools', async () => {
    let ran = false;
    calls.push({ id: 'ordinary', name: 'ordinary', args: {} });
    assert.equal(await dispatch({ specs: [{ name: 'ordinary', description: '', args: { type: 'object' }, run: async () => { ran = true; } }] }), 'completed');
    assert.isFalse(ran);
    const rows = await AgentMessages.find({ sessionId: session._id, role: 'tool' }).fetchAsync();
    assert.lengthOf(rows, 2); rows.forEach((row) => assert.equal(row.error?.error, 'handoff-batch'));
    assert.equal((await AgentSessions.findOneAsync(session._id))!.budgetSpent.toolCalls, 0);
  });

  it('enforces host entitlement and rechecks roster after awaited authority', async () => {
    let checks = 0;
    const outcome = await dispatch({ limits: { canUse: async () => {
      checks += 1;
      if (checks === 2) await AgentSessions.updateAsync(session._id, { $pull: { participants: { id: `m:${target}` } } });
      return true;
    } } });
    assert.equal(outcome, 'completed'); assert.equal(checks, 2);
    const row = (await AgentMessages.findOneAsync({ sessionId: session._id, role: 'tool' }))!;
    assert.equal(row.error?.error, 'handoff-unavailable'); assert.isUndefined(row.kind);
    assert.isUndefined((await AgentSessions.findOneAsync(session._id))!.pendingRelay);
  });

  it('does not route a call denied by the host', async () => {
    assert.equal(await dispatch({ limits: { canUse: () => false } }), 'completed');
    assert.equal((await AgentMessages.findOneAsync({ sessionId: session._id, role: 'tool' }))!.error?.error, 'not-allowed');
    assert.equal((await AgentSessions.findOneAsync(session._id))!.budgetSpent.toolCalls, 0);
  });

  it('stops a ping-pong chain at the primary relay cap without stopping the conversation', async () => {
    await AgentSessions.updateAsync(session._id, { $set: { relay: 1 } });
    assert.equal(await dispatch({ budget: { relay: 1 } }), 'ended');
    const after = (await AgentSessions.findOneAsync(session._id))!;
    assert.isUndefined(after.pendingRelay); assert.equal(after.relay, 1); assert.equal(after.budgetSpent.toolCalls, 0);
    assert.notEqual(after.phase, 'stopped'); assert.exists(await AgentMessages.findOneAsync({ sessionId: session._id, role: 'note', budget: 'relay' }));
  });

  it('honors a Stop arriving during entitlement checks', async () => {
    let checks = 0;
    assert.equal(await dispatch({ limits: { canUse: async () => {
      if (++checks === 2) await AgentSessions.updateAsync(session._id, { $set: { phase: 'stopped' } }); return true;
    } } }), 'abandoned');
    assert.isUndefined((await AgentSessions.findOneAsync(session._id))!.pendingRelay);
    assert.equal(await AgentMessages.find({ sessionId: session._id, kind: 'handoff' }).countAsync(), 0);
  });

  it('cannot hand off after the tool-call budget is exhausted', async () => {
    assert.equal(await dispatch({ budget: { toolCalls: 0 } }), 'abandoned');
    const after = (await AgentSessions.findOneAsync(session._id))!;
    assert.isUndefined(after.pendingRelay); assert.equal(after.budgetSpent.toolCalls, 0);
    assert.equal(await AgentMessages.find({ sessionId: session._id, kind: 'handoff' }).countAsync(), 0);
  });

  it('refuses an atomic commit when the recipient was removed after its snapshot', async () => {
    await AgentSessions.updateAsync(session._id, { $pull: { participants: { id: `m:${target}` } } });
    const committed = await commitLeasedMessage(session._id, { _id: Random.id(), role: 'tool', kind: 'handoff', to: `m:${target}`, createdAt: new Date() }, {
      expected: { participants: { $elemMatch: { id: `m:${target}`, kind: 'model' } } },
      inc: { 'budgetSpent.toolCalls': 1 }, set: { pendingRelay: { agent: target, token: 'must-not-commit' } },
    });
    assert.isNull(committed); assert.isUndefined((await AgentSessions.findOneAsync(session._id))!.pendingRelay);
    assert.equal(await AgentMessages.find({ sessionId: session._id }).countAsync(), 0);
  });

  it('projects the message as colleague speech while keeping other foreign tool results private', async () => {
    await dispatch(); const rows = await AgentMessages.find({ sessionId: session._id }, { sort: { seq: 1 } }).fetchAsync();
    const view = { primary: `m:${source}`, self: `m:${target}`, participants: session.participants! };
    const projected = toProviderMessages([...rows, { _id: 'private', sessionId: session._id, seq: 3, role: 'tool', content: 'private tool result', from: modelFrom(source), createdAt: new Date() }], view);
    assert.lengthOf(projected, 1); assert.equal(projected[0].role, 'user');
    assert.include(projected[0].content!, 'Please review the evidence.'); assert.include(projected[0].content!, 'Reviewer');
    assert.notInclude(JSON.stringify(projected), 'private tool result');
  });

  it('uses the addressed handoff receipt as the recipient memory-frame trigger', async () => {
    await dispatch(); const after = (await AgentSessions.findOneAsync(session._id))!;
    const { prepareTurnLearning } = await import('../server/learning-runtime');
    const learning = await prepareTurnLearning({ session: after, agentName: target,
      identity: { id: `identity-${session._id}`, name: target, displayName: 'Reviewer', constitution: 'Review the evidence.' } });
    assert.equal(learning!.triggerSeq, 1);
  });

  it('never reroutes a queued message with a removed explicit recipient to the primary', async () => {
    const { unansweredMessageAddressee } = await import('../server/participants');
    const { prepareTurnLearning } = await import('../server/learning-runtime');
    const user = { _id: Random.id(), sessionId: session._id, seq: 0, role: 'user' as const, to: 'm:removed', content: 'For the removed agent only', createdAt: new Date() };
    await AgentMessages.insertAsync(user);
    assert.isNull(await unansweredMessageAddressee(session, user));
    let refused = false;
    try { await prepareTurnLearning({ session, agentName: source, identity: { id: `identity-${session._id}`, name: source } }); }
    catch (error) { refused = true; assert.include(String(error), 'no durable trigger'); }
    assert.isTrue(refused);
  });

  it('hands off end-to-end in the same session and stops the source without a follow-up model call', async () => {
    let sourceCalls = 0; let targetSawMessage = false;
    new Agent(source, { model: 'mock', instructions: '', tools: [], provider: mockProvider(() => {
      sourceCalls += 1; return { text: 'I will ask the reviewer.', toolCalls: [call({ agent: target, message: 'Check the concrete evidence.' })] };
    }) });
    new Agent(target, { model: 'mock', instructions: '', tools: [], provider: mockProvider((request) => {
      targetSawMessage = JSON.stringify(request.messages).includes('Check the concrete evidence.'); return { text: 'Reviewed the evidence.' };
    }) });
    await AgentSessions.updateAsync(session._id, { $set: { phase: 'idle', nextSeq: 0 }, $unset: { lease: 1 } });
    const { sendToSession } = await import('../server/methods');
    await sendToSession(source, session._id, 'Please arrange a review.', session.userId);
    await waitFor(async () => (await AgentSessions.findOneAsync(session._id))?.phase === 'idle'
      && !!await AgentMessages.findOneAsync({ sessionId: session._id, content: 'Reviewed the evidence.' }), 'recipient response');
    assert.isTrue(targetSawMessage); assert.equal(sourceCalls, 1);
    assert.equal(await AgentSessions.find({ 'parent.sessionId': session._id }).countAsync(), 0);
    const after = (await AgentSessions.findOneAsync(session._id))!;
    assert.isUndefined(after.pendingRelay); assert.equal(after.relay, 1);
  });
});
