import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { MongoInternals } from 'meteor/mongo';
import { Agent, AgentSessions } from 'meteor/10thfloor:agent';
import {
  conversationHop, isMissionRoot, normalizeTopicName, topicLabel, topicNameProblem,
} from '../imports/constellation/topics';
import { missionTotals } from '../imports/constellation/mission-health';

describe('Topics: names and totals', function () {
  it('turns what people type into a topic name', function () {
    assert.equal(normalizeTopicName('Pricing Tiers!'), 'pricing-tiers');
    assert.equal(normalizeTopicName('#Café  Plans_2026'), 'cafe-plans-2026');
    assert.equal(normalizeTopicName('--a---b--'), 'a-b');
    assert.equal(normalizeTopicName('x'.repeat(60)), 'x'.repeat(40));
    assert.equal(normalizeTopicName('!!!'), '');
    assert.equal(normalizeTopicName(42), '');
  });
  it('says why a name cannot be used', function () {
    assert.isNull(topicNameProblem('pricing', ['research']));
    assert.equal(topicNameProblem('', []), 'Use letters, numbers or dashes.');
    assert.equal(topicNameProblem('general', []), '#general already exists.');
    assert.equal(topicNameProblem('research', ['research']), '#research already exists.');
    assert.equal(topicLabel('pricing'), '#pricing');
    assert.equal(topicLabel(''), '#general');
  });
  it('knows a Mission from its topics and threads', function () {
    assert.isTrue(isMissionRoot({ agent: 'orchestrator' }));
    assert.isFalse(isMissionRoot({ agent: 'orchestrator', missionTopic: { missionId: 'm' } }));
    assert.isFalse(isMissionRoot({ agent: 'orchestrator', thread: { sessionId: 't' } }));
    assert.isFalse(isMissionRoot({ agent: 'orchestrator', parent: { sessionId: 'p' } }));
    assert.equal(conversationHop({ thread: { sessionId: 'topic' } }), 'topic');
    assert.equal(conversationHop({ missionTopic: { missionId: 'mission' } }), 'mission');
    assert.isNull(conversationHop({}));
  });
  it('adds up what every conversation of a Mission used', function () {
    const { usage, spent } = missionTotals([
      { usage: { input: 10, output: 5, cost: 0.5 }, budgetSpent: { turns: 2, toolCalls: 1 } },
      { usage: { input: 1, output: 2, cost: 0.25 }, budgetSpent: { turns: 1, toolCalls: 3 } },
      {},
    ]);
    assert.deepEqual(usage, { input: 11, output: 7, cost: 0.75 });
    assert.deepEqual(spent, { turns: 3, toolCalls: 4 });
  });
});

if (Meteor.isServer) describe('Topics on the server', function () {
  this.timeout(30_000);
  let runtime;
  let topics;
  let ownerId;
  let temporaryWorkspace = false;
  let primaryFixtureId;
  const sessions = [];
  const invoke = (name, ...args) => Meteor.server.method_handlers[`constellation.${name}`]
    .call({ userId: ownerId, connection: null }, ...args);
  const rejected = async (work, code) => {
    let failure;
    try { await work; } catch (caught) { failure = caught; }
    assert.isDefined(failure, `Expected ${code}`);
    assert.equal(failure.error, code);
    return failure;
  };
  const until = async (check, what, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const insertSession = async (extra = {}) => {
    const now = new Date();
    const _id = `topics-test-${Random.id()}`;
    sessions.push(_id);
    await AgentSessions.insertAsync({ _id, userId: ownerId, agent: 'orchestrator', model: 'mock', phase: 'idle',
      nextSeq: 1, usage: { input: 0, output: 0, cost: 0 }, budgetSpent: { turns: 0, toolCalls: 0 },
      participants: [{ id: 'm:orchestrator', kind: 'model', role: 'member', agent: 'orchestrator', displayName: 'Atlas', joinedAt: now }],
      createdAt: now, updatedAt: now, ...extra });
    return _id;
  };
  const mission = async () => {
    const missionId = await insertSession();
    const now = new Date();
    await runtime.MissionConfigs.insertAsync({ _id: missionId, sessionId: missionId, userId: ownerId,
      title: 'Topics mission', objective: '', agents: [], status: 'active', revision: 1, debugTraces: false,
      budget: { turns: 4, toolCalls: 2, spend: 1 }, continuity: true, approvals: true, autoTitle: false,
      createdAt: now, updatedAt: now });
    return missionId;
  };
  const created = async (missionId, name) => {
    const topic = await invoke('topicCreate', missionId, name);
    sessions.push(topic._id);
    return topic;
  };

  // The app's built-in crew and Pulses have fixed ids, made once for the workspace's owner. A stand-in owner says it
  // already has them, so preparing a Mission here never makes rows the real owner would collide with later.
  const raw = (name) => MongoInternals.defaultRemoteCollectionDriver().mongo.db.collection(name);
  const SET_UP = ['constellation_crew_states', 'constellation_pulse_states'];
  before(async function () {
    runtime = await import('../server/main.js');
    topics = await import('../server/mission-topics.js');
    let workspace = await runtime.WorkspaceState.findOneAsync('local');
    if (!workspace) {
      temporaryWorkspace = true;
      workspace = { _id: 'local', ownerUserId: `topics-owner-${Random.id()}`, createdAt: new Date() };
      for (const name of SET_UP) await raw(name).insertOne({ _id: Random.id(), userId: workspace.ownerUserId, initializedAt: new Date() });
      await runtime.WorkspaceState.insertAsync(workspace);
    }
    ownerId = workspace.ownerUserId;
    if (!await runtime.CrewConfigs.findOneAsync({ userId: ownerId, agent: 'orchestrator', enabled: true, status: { $ne: 'archived' } })) {
      primaryFixtureId = `topics-primary-${Random.id()}`;
      await runtime.CrewConfigs.insertAsync({ _id: primaryFixtureId, userId: ownerId, agent: 'orchestrator',
        primary: true, enabled: true, status: 'available', revision: 1, displayName: 'Atlas' });
    }
  });
  after(async function () {
    for (const id of sessions.reverse()) {
      await AgentSessions.updateAsync(id, { $unset: { erasingAt: 1 } });
      await new Agent('orchestrator').erase(id, { userId: ownerId }).catch(() => {});
      await runtime.MissionConfigs.removeAsync({ _id: id });
      await topics.MissionTopics.removeAsync({ $or: [{ _id: id }, { missionId: id }] });
    }
    if (primaryFixtureId) await runtime.CrewConfigs.removeAsync({ _id: primaryFixtureId, userId: ownerId });
    if (temporaryWorkspace) {
      for (const name of SET_UP) await raw(name).deleteMany({ userId: ownerId });
      await runtime.WorkspaceState.removeAsync({ _id: 'local', ownerUserId: ownerId });
    }
  });

  it('adds a topic as a session of the Mission with its crew and a clean name', async function () {
    const missionId = await mission();
    const topic = await created(missionId, 'Pricing Tiers!');
    assert.equal(topic.name, 'pricing-tiers');
    const session = await AgentSessions.findOneAsync(topic._id);
    assert.deepEqual(session.missionTopic, { missionId });
    assert.equal(session.title, '#pricing-tiers');
    assert.notExists(session.forkedFrom, 'a topic is not shown as a fork');
    assert.isAtLeast(session.nextSeq, 1);
    assert.deepEqual(session.participants.map((row) => row.id), ['m:orchestrator']);
    const row = await topics.MissionTopics.findOneAsync(topic._id);
    assert.include(row, { missionId, name: 'pricing-tiers', activeName: 'pricing-tiers' });
    // Topics have no settings of their own: work in one runs under its Mission's.
    await runtime.requireActiveMissionExecution(topic._id, 'orchestrator');
    assert.notExists(await runtime.MissionConfigs.findOneAsync(topic._id));
  });

  it('refuses names in use, #general, names with nothing left, and topics of topics', async function () {
    const missionId = await mission();
    const topic = await created(missionId, 'research');
    await rejected(invoke('topicCreate', missionId, 'Research'), 'invalid-topic');
    await rejected(invoke('topicCreate', missionId, 'general'), 'invalid-topic');
    await rejected(invoke('topicCreate', missionId, '!!!'), 'invalid-topic');
    await rejected(invoke('topicCreate', topic._id, 'deeper'), 'no-session');
    // A topic is renamed as a topic, never as a Mission.
    await rejected(invoke('renameSession', topic._id, 'Not a mission'), 'no-session');
    assert.equal(await invoke('topicRename', topic._id, 'Field Notes'), 'field-notes');
    assert.equal((await AgentSessions.findOneAsync(topic._id)).title, '#field-notes');
  });

  it('frees an archived name, and will not bring back a topic whose name was taken', async function () {
    const missionId = await mission();
    const first = await created(missionId, 'launch');
    await AgentSessions.updateAsync(first._id, { $set: { phase: 'streaming' } });
    await invoke('topicArchive', first._id);
    assert.equal((await AgentSessions.findOneAsync(first._id)).phase, 'stopped', 'archiving stops its work');
    assert.notProperty(await topics.MissionTopics.findOneAsync(first._id), 'activeName');
    const second = await created(missionId, 'launch');
    assert.equal(second.name, 'launch');
    await rejected(invoke('topicUnarchive', first._id), 'invalid-topic');
    await invoke('topicRename', second._id, 'launch-two');
    assert.equal(await invoke('topicUnarchive', first._id), 'launch');
  });

  it('places any session in its Mission: topics, their threads and the work under them', async function () {
    const missionId = await mission();
    const topic = await created(missionId, 'ops');
    const child = await insertSession({ agent: 'researcher', parent: { sessionId: topic._id, toolCallId: 'call-1' } });
    const thread = await insertSession({ thread: { sessionId: topic._id, seq: 0, messageId: 'm1', replies: 0, repliers: [] } });
    const threadChild = await insertSession({ agent: 'critic', parent: { sessionId: thread, toolCallId: 'call-2' } });
    const foreign = await insertSession({ userId: `someone-else-${Random.id()}` });
    const map = await invoke('sessionMissions', [missionId, topic._id, child, thread, threadChild, foreign, 'nothing-here']);
    assert.deepEqual(map, {
      [missionId]: missionId, [topic._id]: missionId, [child]: missionId, [thread]: missionId,
      [threadChild]: missionId, [foreign]: null, 'nothing-here': null,
    });
    assert.sameMembers(await topics.missionConversationIds(AgentSessions, ownerId, missionId), [missionId, topic._id, thread]);
  });

  it('keeps every topic and thread on the Mission’s crew', async function () {
    const missionId = await mission();
    const topic = await created(missionId, 'crew');
    const thread = await insertSession({ thread: { sessionId: missionId, seq: 0, messageId: 'm1', replies: 0, repliers: [] } });
    await Agent.participants.add(missionId, { id: 'm:critic', kind: 'model', role: 'member', agent: 'critic', displayName: 'Vela' });
    const has = async (id) => (await AgentSessions.findOneAsync(id)).participants?.some((row) => row.id === 'm:critic');
    await until(() => has(topic._id), 'the topic to gain the agent');
    await until(() => has(thread), 'the thread to gain the agent');
    await Agent.participants.remove(missionId, 'm:critic');
    await until(async () => !await has(topic._id), 'the topic to lose the agent');
  });

  // (Saving a Mission's settings also brings its crew up to date, which registers Agent identities: a test owner's
  // crew would take names the workspace's own crew needs. Archive stops a Mission without that.)
  it('stops every topic and thread when the Mission is archived', async function () {
    const missionId = await mission();
    const topic = await created(missionId, 'archived');
    const thread = await insertSession({ thread: { sessionId: topic._id, seq: 0, messageId: 'm1', replies: 0, repliers: [] } });
    await AgentSessions.updateAsync({ _id: { $in: [topic._id, thread] } }, { $set: { phase: 'streaming' } }, { multi: true });
    await invoke('missionArchive', missionId);
    assert.equal((await AgentSessions.findOneAsync(topic._id)).phase, 'stopped');
    assert.equal((await AgentSessions.findOneAsync(thread)).phase, 'stopped');
    await rejected(runtime.requireActiveMissionExecution(topic._id, 'orchestrator'), 'mission-inactive');
    await rejected(invoke('topicCreate', missionId, 'too-late'), 'mission-archived');
  });

  it('keeps one topic’s stop to that topic', async function () {
    const missionId = await mission();
    const topic = await created(missionId, 'busy');
    const child = await insertSession({ agent: 'orchestrator', parent: { sessionId: topic._id, toolCallId: 'call-3' } });
    // #general stopped: the topic's work carries on.
    await AgentSessions.updateAsync(missionId, { $set: { phase: 'stopped', stoppedAt: new Date() } });
    await runtime.requireActiveMissionExecution(child, 'orchestrator');
    // The topic itself stopped: its delegated work does not outrun the stop.
    await AgentSessions.updateAsync(topic._id, { $set: { phase: 'stopped', stoppedAt: new Date() } });
    await rejected(runtime.requireActiveMissionExecution(child, 'orchestrator'), 'mission-stopped');
  });

  it('publishes topic rows and what the list needs from their sessions', async function () {
    const missionId = await mission();
    const topic = await created(missionId, 'published');
    const handler = Meteor.server.publish_handlers['constellation.missionTopics'];
    const cursors = handler.call({ userId: ownerId, ready() {} });
    const [rows, topicSessions] = await Promise.all(cursors.map((cursor) => cursor.fetchAsync()));
    assert.ok(rows.find((row) => row._id === topic._id && row.missionId === missionId));
    const session = topicSessions.find((row) => row._id === topic._id);
    assert.deepEqual(session.missionTopic, { missionId });
    assert.hasAllKeys(session, ['_id', 'missionTopic', 'title', 'phase', 'nextSeq', 'updatedAt', 'createdAt', 'usage', 'budgetSpent']);
  });
});

if (Meteor.isClient) describe('Topics in the Mission list', function () {
  let renderMissionTree;
  let wireMissionTree;
  let root;
  const state = (key, label = key) => ({ key, label, detail: label });
  const model = (patch = {}) => ({
    query: '',
    missions: [
      { id: 'm1', title: 'Launch', time: 'now', state: state('ready', 'Ready'), waiting: 1, unread: true, folded: false, current: true,
        topics: [
          { id: 'm1', name: 'general', state: state('ready'), waiting: 0, unread: false, current: true },
          { id: 't1', name: 'pricing', state: state('working', 'Working'), waiting: 1, unread: true, current: false },
        ] },
      { id: 'm2', title: 'Hiring', time: '2h', state: state('ready'), waiting: 0, unread: true, folded: true, current: false,
        topics: [{ id: 'm2', name: 'general', state: state('ready'), waiting: 0, unread: true, current: false }] },
    ],
    ...patch,
  });
  const handlers = (log) => ({
    open: (id) => log.push(`open:${id}`), openMission: (id) => log.push(`mission:${id}`),
    toggle: (id, fold) => log.push(`toggle:${id}:${fold}`), createTopic: async () => {}, takenNames: () => ['pricing'],
    active: () => true,
  });
  before(async function () { ({ renderMissionTree, wireMissionTree } = await import('../client/mission-tree')); });
  beforeEach(function () { root = document.createElement('div'); document.body.append(root); });
  afterEach(function () { root.remove(); });

  it('draws Missions with their topics as a tree with one tab stop', function () {
    const log = [];
    renderMissionTree(root, model(), handlers(log));
    assert.equal(root.getAttribute('role'), 'tree');
    const items = [...root.querySelectorAll('[role="treeitem"]')];
    assert.deepEqual(items.map((item) => item.getAttribute('aria-level')), ['1', '2', '2', '2', '1']);
    assert.lengthOf(root.querySelectorAll('[tabindex="0"]'), 1);
    assert.equal(root.querySelector('[tabindex="0"]').dataset.sessionId, 'm1', 'the open topic takes the tab stop');
    const pricing = root.querySelector('.topic-row[data-session-id="t1"]');
    assert.isTrue(pricing.classList.contains('unread'));
    assert.equal(pricing.querySelector('.tree-badge').textContent, '1');
    assert.include(pricing.getAttribute('aria-label'), 'unread');
    // A folded Mission shows that something in it is unread.
    const hiring = root.querySelector('.mission-group-row[data-mission-id="m2"]');
    assert.equal(hiring.getAttribute('aria-expanded'), 'false');
    assert.isTrue(hiring.classList.contains('unread'));
    assert.ok(hiring.querySelector('.tree-unread-dot'));
    pricing.click();
    hiring.click();
    assert.deepEqual(log, ['open:t1', 'mission:m2']);
  });

  it('moves through the tree from the keyboard', function () {
    const log = [];
    wireMissionTree(root, handlers(log));
    renderMissionTree(root, model(), handlers(log));
    const header = root.querySelector('.mission-group-row');
    header.focus();
    const key = (value) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
    key('ArrowDown');
    assert.equal(document.activeElement.dataset.sessionId, 'm1');
    key('ArrowDown');
    assert.equal(document.activeElement.dataset.sessionId, 't1');
    key('Enter');
    key('ArrowLeft');
    assert.strictEqual(document.activeElement, header);
    key('ArrowLeft');
    key('End');
    assert.equal(document.activeElement.dataset.missionId, 'm2');
    key('ArrowRight');
    assert.deepEqual(log, ['open:t1', 'toggle:m1:true', 'toggle:m2:false']);
  });

  it('keeps the open topic in sight when its Mission is folded, and shows matches when searching', function () {
    const folded = model();
    folded.missions[0].folded = true;
    renderMissionTree(root, folded, handlers([]));
    assert.deepEqual([...root.querySelectorAll('.topic-row')].map((row) => row.dataset.sessionId), ['m1']);
    assert.notExists(root.querySelector('.topic-add-row'), 'no Add topic in a folded Mission');
    renderMissionTree(root, model({ query: 'pri' }), handlers([]));
    assert.notExists(root.querySelector('.topic-add-row'), 'no Add topic while searching');
  });

  it('adds a topic in place, says what the name will be, and refuses a name in use', async function () {
    const made = [];
    const log = [];
    const these = { ...handlers(log), createTopic: async (missionId, name) => { made.push([missionId, name]); } };
    wireMissionTree(root, { ...these, formClosed: () => renderMissionTree(root, model(), these) });
    renderMissionTree(root, model(), these);
    root.querySelector('.topic-add-row[data-mission-id="m1"]').click();
    const input = root.querySelector('.topic-add-form input');
    assert.strictEqual(document.activeElement, input);
    input.value = 'Pricing';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(root.querySelector('.topic-add-hint').textContent, '#pricing already exists.');
    input.value = 'Field Notes';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(root.querySelector('.topic-add-hint').textContent, 'Will be #field-notes');
    // The list re-renders while the name is typed; the field and its text survive.
    renderMissionTree(root, model(), these);
    assert.equal(root.querySelector('.topic-add-form input').value, 'Field Notes');
    root.querySelector('.topic-add-form').requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(made, [['m1', 'field-notes']]);
    renderMissionTree(root, model(), these);
    assert.notExists(root.querySelector('.topic-add-form'), 'the field closes once the topic is added');
  });
});

if (Meteor.isClient) describe('Topics: threads beside the chat', function () {
  let initializeThreads;
  let Mongo;
  let chat;
  let pane;
  let threads;
  let controls;
  const tag = 'constellation-thread-test';
  before(async function () {
    const { defineAgentChat } = await import('meteor/10thfloor:agent');
    defineAgentChat(tag);
    ({ Mongo } = await import('meteor/mongo'));
    ({ initializeThreads } = await import('../client/thread-panel'));
  });
  beforeEach(function () {
    chat = document.createElement(tag);
    chat.setAttribute('agent', 'orchestrator');
    chat.setAttribute('session-id', 'topic-1');
    pane = document.createElement('aside');
    pane.className = 'inspector-pane';
    document.body.append(chat, pane);
    chat.agentInstance.messages = () => ({ fetch: () => [{ _id: 'message-1', seq: 4, role: 'user' }] });
    threads = new Mongo.Collection(null);
    threads.insert({ _id: 'thread-1', agent: 'orchestrator', phase: 'idle', createdAt: new Date(),
      thread: { sessionId: 'topic-1', messageId: 'message-1', seq: 6, replies: 2, repliers: ['m:operator'], lastReplyAt: new Date() },
      participants: [{ id: 'm:orchestrator', kind: 'model', agent: 'orchestrator', displayName: 'Atlas' },
        { id: 'm:operator', kind: 'model', agent: 'operator', displayName: 'Relay' }] });
    controls = initializeThreads({
      workspace: { subscribeThreads: () => ({ stop() {} }), threads: (id) => threads.find({ 'thread.sessionId': id }), thread: async () => 'thread-1' },
      chat, pane, AgentSessions: threads, timeAgo: () => 'now', toast: () => {}, chatTag: tag,
      currentChat: () => 'topic-1', currentMission: () => 'mission-1', conversationIds: () => ['mission-1', 'topic-1'],
      topicName: () => 'pricing',
      recipientState: (session) => ({ session, primary: { label: 'Atlas' }, crew: [], userId: 'owner', writable: true, status: 'active' }),
      openInspector: () => {},
    });
  });
  afterEach(function () { controls.dispose(); chat.remove(); pane.remove(); });

  it('puts a summary of the thread under its message', function () {
    const [item] = chat.timelineItems.filter((row) => row.id === 'thread-thread-1');
    assert.equal(item.afterMessageId, 'message-1');
    assert.include(item.element.textContent, '2 replies');
    assert.include(item.element.textContent, 'Relay');
    assert.equal(item.element.getAttribute('aria-expanded'), 'false');
    assert.isTrue(chat.threadable, 'messages offer Reply in thread');
  });

  it('opens the thread beside the chat from its message, and closes it without starting anything', async function () {
    const [item] = chat.timelineItems;
    item.element.click();
    const panel = pane.querySelector('#thread-panel');
    assert.isFalse(panel.hidden);
    assert.isTrue(pane.classList.contains('thread-open'));
    const threadChat = pane.querySelector('#thread-chat');
    assert.equal(threadChat.getAttribute('session-id'), 'thread-1');
    assert.equal(threadChat.getAttribute('from-seq'), '4', 'shown from the message the thread was opened on');
    assert.equal(panel.querySelector('.thread-panel-topic').textContent, '#pricing');
    assert.equal(item.element.getAttribute('aria-expanded'), 'true');
    let sent;
    threadChat.agentInstance.send = async (...args) => { sent = args; return { sessionId: 'thread-1' }; };
    pane.querySelector('#thread-also-send').checked = true;
    await threadChat.submissionHandler({ sessionId: 'thread-1', text: 'Cut the middle tier?', mode: 'ask', recipient: 'm:operator' });
    assert.deepEqual(sent, ['thread-1', 'Cut the middle tier?', { to: 'm:operator', alsoToParent: true }]);
    assert.isFalse(pane.querySelector('#thread-also-send').checked, 'the choice is for one message');
    panel.querySelector('.thread-panel-close').click();
    assert.isTrue(panel.hidden);
    assert.notExists(pane.querySelector('#thread-chat'), 'a chat without a session would start one');
  });
});

if (Meteor.isClient) describe('Topics: reply in thread', function () {
  let initialize;
  let chat;
  let controls;
  let stored;
  const tag = 'constellation-reply-mode-test';
  before(async function () {
    const { defineAgentChat } = await import('meteor/10thfloor:agent');
    defineAgentChat(tag);
    ({ initializeMissionRecipients: initialize } = await import('../client/mission-recipients'));
  });
  const state = (patch = {}) => ({
    session: { _id: chat.getAttribute('session-id'), agent: 'orchestrator',
      participants: [{ id: 'm:orchestrator', agent: 'orchestrator', displayName: 'Atlas', kind: 'model' }] },
    primary: { label: 'Atlas', role: 'Orchestrator' }, crew: [], userId: 'owner', mode: 'ask', writable: true, status: 'active',
    ...patch,
  });
  beforeEach(function () {
    chat = document.createElement(tag);
    chat.setAttribute('agent', 'orchestrator');
    chat.setAttribute('session-id', `reply-test-${Random.id()}`);
    document.body.append(chat);
    chat.agentInstance.session = () => null;
    chat.agentInstance.messages = () => ({ fetch: () => [] });
    stored = new Map();
    controls = initialize({ chat, storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } });
  });
  afterEach(function () { controls.dispose(); chat.remove(); });
  const option = (value) => controls.menu.querySelector(`[data-recipient-choice="${value}"]`);

  it('offers Reply in this topic and Reply in thread, and remembers the choice per topic', function () {
    controls.update(state());
    assert.isUndefined(controls.replyIn());
    assert.equal(option('reply:chat').getAttribute('aria-checked'), 'true');
    assert.equal(option('reply:chat').textContent.includes('Reply in this topic'), true);
    controls.chooseReply('reply:thread', { focus: false });
    assert.equal(controls.replyIn(), 'thread');
    assert.equal(option('reply:thread').getAttribute('aria-checked'), 'true');
    assert.include(controls.button.getAttribute('aria-label'), 'reply in thread');
    assert.equal(stored.get(`constellation.reply-in:owner:${chat.getAttribute('session-id')}`), 'reply:thread');
    // Another topic starts with its own choice.
    const elsewhere = state({ session: { ...state().session, _id: `other-${Random.id()}` } });
    controls.update(elsewhere);
    assert.isUndefined(controls.replyIn());
  });

  it('has no reply choice for a crew note, or inside a thread', function () {
    controls.update(state());
    controls.chooseReply('reply:thread', { focus: false });
    controls.update(state({ mode: 'note' }));
    assert.isUndefined(controls.replyIn(), 'a note wakes nobody');
    assert.isTrue(controls.menu.querySelector('.mission-recipient-replies').hidden);
    controls.update(state({ replyModes: false }));
    assert.isUndefined(controls.replyIn());
    assert.isTrue(controls.menu.querySelector('.mission-recipient-replies').hidden);
  });
});
