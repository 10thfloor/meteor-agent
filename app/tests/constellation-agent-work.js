import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentSessions, AgentMessages, AgentWorkflowRuns } from 'meteor/10thfloor:agent';

if (Meteor.isServer) describe('Constellation agent work discovery', function () {
  this.timeout(20_000);
  let serviceModule;
  let service;
  let owner;
  let other;
  let root;
  let sessionIds;
  let crew;
  const at = (offset = 0) => new Date(Date.now() - 60_000 + offset);
  const rejects = async (promise, code) => {
    let caught;
    try { await promise; } catch (error) { caught = error; }
    assert.equal(caught?.error, code);
  };
  const session = async (patch = {}) => {
    const row = { _id: `work-test-${Random.id()}`, userId: owner, agent: 'researcher', phase: 'idle',
      createdAt: at(), updatedAt: at(), parent: { sessionId: root, toolCallId: `call-${Random.id()}` }, ...patch };
    sessionIds.push(row._id);
    await AgentSessions.insertAsync(row);
    return row;
  };
  const message = async (sessionId, patch) => {
    await AgentMessages.insertAsync({ _id: Random.id(), sessionId, seq: 0, role: 'user', createdAt: at(), ...patch });
  };
  const receipt = async (child, patch = {}) => message(child.parent.sessionId, {
    role: 'tool', childSessionId: child._id, toolCallId: child.parent.toolCallId, content: JSON.stringify('Evidence grouped.'), ...patch,
  });
  before(async () => { serviceModule = await import('../server/constellation-agent-work'); });
  beforeEach(async () => {
    owner = `work-owner-${Random.id()}`; other = `work-other-${Random.id()}`; sessionIds = [];
    crew = [{ agent: 'orchestrator', displayName: 'Atlas' }, { agent: 'researcher', displayName: 'Signal' }, { agent: 'critic', displayName: 'Vela', status: 'archived' }];
    service = serviceModule.createConstellationAgentWorkService({
      requireUser: async (userId) => { if (userId !== owner) throw new Meteor.Error('not-authorized', 'Not allowed.'); },
      CrewConfigs: { find: ({ userId }) => ({ fetchAsync: async () => userId === owner ? crew : [] }) },
    });
    root = `work-mission-${Random.id()}`;
    await session({ _id: root, agent: 'orchestrator', parent: undefined });
  });
  afterEach(async () => {
    await AgentMessages.removeAsync({ sessionId: { $in: sessionIds } });
    await AgentSessions.removeAsync({ _id: { $in: sessionIds } });
    await AgentWorkflowRuns.removeAsync({ userId: owner });
  });

  it('discovers old and nested work independently of recent activity or the active roster', async () => {
    const expected = [];
    for (let index = 0; index < 22; index += 1) expected.push((await session({ createdAt: at(index) }))._id);
    const parent = await session({ agent: 'critic', createdAt: at(30) }); expected.push(parent._id);
    const nested = await session({ agent: 'retired-agent', parent: { sessionId: parent._id, toolCallId: 'nested' }, createdAt: at(31),
      participants: [{ kind: 'model', agent: 'retired-agent', displayName: 'Former specialist' }] }); expected.push(nested._id);
    const first = await service.list(owner, { missionId: root, limit: 10 });
    const second = await service.list(owner, { missionId: root, limit: 10, cursor: first.nextCursor });
    const third = await service.list(owner, { missionId: root, limit: 10, cursor: second.nextCursor });
    assert.sameMembers([...first.items, ...second.items, ...third.items].map((row) => row.sessionId), expected);
    assert.isNull(third.nextCursor);
    assert.equal(first.items.find((row) => row.sessionId === nested._id).displayName, 'Former specialist');
    const filtered = await service.list(owner, { missionId: root, agent: 'researcher', limit: 1 });
    assert.includeDeepMembers(filtered.agents, [{ agent: 'retired-agent', displayName: 'Former specialist' }]);
    const detail = await service.detail(owner, { missionId: root, sessionId: nested._id });
    assert.equal(detail.requester.displayName, 'Vela');
    assert.equal(detail.parentSessionId, parent._id);
  });

  it('uses stable keyset pages at identical timestamps and excludes newly arriving work until refresh', async () => {
    const time = at();
    const children = await Promise.all([session({ createdAt: time }), session({ createdAt: time }), session({ createdAt: time })]);
    const first = await service.list(owner, { missionId: root, limit: 1 });
    await session({ createdAt: new Date(Date.now() + 1000) });
    const second = await service.list(owner, { missionId: root, limit: 1, cursor: first.nextCursor });
    const third = await service.list(owner, { missionId: root, limit: 1, cursor: second.nextCursor });
    assert.sameMembers([first, second, third].flatMap((page) => page.items.map((row) => row.sessionId)), children.map((row) => row._id));
    assert.isNull(third.nextCursor);
    await rejects(service.list(owner, { missionId: root, agent: 'critic', cursor: first.nextCursor }), 'invalid-agent-work');
  });

  it('requires the owner, excludes foreign or erased ancestry, and refuses unrelated detail ids', async () => {
    const foreign = await session({ userId: other });
    const mixed = await session({ parent: { sessionId: foreign._id, toolCallId: 'mixed' } });
    const erased = await session({ erasingAt: new Date() });
    await session({ parent: { sessionId: erased._id, toolCallId: 'under-erased' } });
    const purging = await session({ purgingAt: new Date() });
    await session({ parent: { sessionId: purging._id, toolCallId: 'under-purging' } });
    const unrelatedRoot = await session({ agent: 'orchestrator', parent: undefined });
    const unrelated = await session({ parent: { sessionId: unrelatedRoot._id, toolCallId: 'other-mission' } });
    assert.isEmpty((await service.list(owner, { missionId: root })).items);
    await rejects(service.list(null, { missionId: root }), 'not-authorized');
    await rejects(service.list(other, { missionId: root }), 'not-authorized');
    for (const child of [foreign, mixed, erased, purging, unrelated]) await rejects(service.detail(owner, { missionId: root, sessionId: child._id }), 'no-session');
    await rejects(service.detail(owner, { missionId: root, sessionId: root }), 'no-session');
    await AgentSessions.updateAsync(root, { $set: { purgingAt: new Date() } });
    await rejects(service.list(owner, { missionId: root }), 'no-session');
  });

  it('shows the actual assignment and parent receipt without system instructions or private reasoning', async () => {
    const child = await session();
    await message(child._id, { role: 'system', seq: -1, content: 'SECRET SYSTEM INSTRUCTIONS' });
    await message(child._id, { content: 'Group items 1–6 by theme.' });
    await message(child._id, { role: 'assistant', seq: 1, content: 'An unreturned later answer.', thinking: 'PRIVATE REASONING' });
    await receipt(child, { content: JSON.stringify('The actual result returned to Atlas.'), displayContent: 'A shorter display projection.', transcriptContent: 'A different transcript projection.' });
    const detail = await service.detail(owner, { missionId: root, sessionId: child._id });
    assert.equal(detail.assignment, 'Group items 1–6 by theme.');
    assert.equal(detail.result.state, 'returned');
    assert.equal(detail.result.text, 'The actual result returned to Atlas.');
    assert.equal(detail.status, 'completed');
    assert.notInclude(JSON.stringify(detail), 'PRIVATE REASONING');
    assert.notInclude(JSON.stringify(detail), 'SECRET SYSTEM');
    assert.notInclude(JSON.stringify(detail), 'unreturned later');
  });

  it('does not pass a completed child reply off as a result returned after a parked or failed handoff', async () => {
    const parked = await session();
    const failed = await session({ phase: 'error' });
    await message(parked._id, { role: 'assistant', content: 'A reply after approval was granted.' });
    await receipt(parked, { error: { error: 'subagent-parked', reason: 'Waiting for tool approval.' } });
    await receipt(failed, { error: { error: 'delegation-rejected', reason: 'RAW PRIVATE ERROR' } });
    const parkedDetail = await service.detail(owner, { missionId: root, sessionId: parked._id });
    assert.equal(parkedDetail.status, 'completed');
    assert.equal(parkedDetail.result.state, 'awaiting');
    assert.isFalse(parkedDetail.resultReturned);
    assert.notInclude(parkedDetail.result.text, 'reply after');
    const failedDetail = await service.detail(owner, { missionId: root, sessionId: failed._id });
    assert.equal(failedDetail.status, 'failed');
    assert.equal(failedDetail.result.state, 'failed');
    assert.notInclude(JSON.stringify(failedDetail), 'PRIVATE ERROR');
  });

  it('identifies plan work and uses the exact plan checkpoint rather than a child final reply', async () => {
    const runId = `work-plan-${Random.id()}`;
    const child = await session({ parent: { sessionId: root, toolCallId: `workflow:${runId}:review` } });
    await message(child._id, { content: 'Review the draft.' });
    await message(child._id, { role: 'assistant', content: 'Raw child result.' });
    await AgentWorkflowRuns.insertAsync({ _id: runId, userId: owner, namespace: 'constellation', missionId: root,
      name: 'Launch review', status: 'running', states: { review: { id: 'review', label: 'Review evidence', childSessionId: child._id, status: 'running' } } });
    const pending = await service.detail(owner, { missionId: root, sessionId: child._id });
    assert.equal(pending.source, 'plan');
    assert.equal(pending.requester.displayName, 'Launch review');
    assert.equal(pending.result.state, 'pending');
    await AgentWorkflowRuns.updateAsync(runId, { $set: { 'states.review.status': 'completed', 'states.review.output': 'Saved plan result.', 'states.review.completedAt': new Date() } });
    const completed = await service.detail(owner, { missionId: root, sessionId: child._id });
    assert.equal(completed.result.text, 'Saved plan result.');
    assert.equal(completed.result.state, 'returned');
    assert.equal(completed.label, 'Review evidence');
  });

  it('filters canonical statuses and agents while retaining archived agents', async () => {
    const waiting = await session({ agent: 'critic', phase: 'awaiting' });
    await session({ phase: 'streaming' });
    await session({ phase: 'stopped' });
    const filtered = await service.list(owner, { missionId: root, agent: 'critic', status: 'waiting' });
    assert.deepEqual(filtered.items.map((row) => row.sessionId), [waiting._id]);
    assert.equal(filtered.items[0].statusLabel, 'Needs approval');
    assert.includeDeepMembers(filtered.agents, [{ agent: 'critic', displayName: 'Vela' }]);
    await rejects(service.list(owner, { missionId: root, status: 'garbage' }), 'invalid-agent-work');
    await rejects(service.list(owner, { missionId: root, limit: 5000 }), 'invalid-agent-work');
    await rejects(service.list(owner, { missionId: root, cursor: 'broken' }), 'invalid-agent-work');
    await rejects(service.list(owner, null), 'invalid-agent-work');
    await rejects(service.detail(owner, []), 'invalid-agent-work');
  });

  it('omits raw structured payloads and strips reasoning blocks from display summaries', async () => {
    assert.isNull(serviceModule.agentWorkProse('{"secret":true}'));
    assert.equal(serviceModule.agentWorkProse('<think>private deliberation</think>Visible conclusion.'), 'Visible conclusion.');
    assert.equal(serviceModule.agentWorkProse('Answer.\n```json\n{"debug":true}\n```'), 'Answer.\n[Structured data omitted.]');
    const child = await session();
    await message(child._id, { content: '{"raw":"assignment"}' });
    await receipt(child, { content: JSON.stringify({ debug: 'NEVER SHOW' }) });
    const detail = await service.detail(owner, { missionId: root, sessionId: child._id });
    assert.equal(detail.assignment, 'Assignment unavailable.');
    assert.equal(detail.result.text, 'Result recorded.');
    assert.notInclude(JSON.stringify(detail), 'NEVER SHOW');
    assert.isNull((await service.list(owner, { missionId: root })).items[0].result.text);
  });
});
