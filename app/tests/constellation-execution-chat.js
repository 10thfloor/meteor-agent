import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';

if (Meteor.isClient) describe('Code execution chat timeline', function () {
  let initialize; let fixture;
  const flush = () => Tracker.flush();
  const job = (overrides = {}) => ({ _id: 'job-one', missionId: 'mission-one', title: 'Calculate result', agent: 'orchestrator',
    language: 'python', status: 'running', createdAt: new Date(1000), startedAt: new Date(1500), ...overrides });
  before(async () => { ({ initializeExecutionChat: initialize } = await import('../client/execution-chat')); });
  beforeEach(() => {
    const dependency = new Tracker.Dependency(); const jobs = new Mongo.Collection(null);
    fixture = { dependency, jobs, mission: 'mission-one', connected: true, ready: true, now: 3000,
      cards: [], ticks: new Map(), sequence: 0, timelineWrites: 0, opened: [], stopped: [], subscriptions: [],
      stop: async () => {}, items: [] };
    const chat = { get timelineItems() { return fixture.items; }, set timelineItems(value) { fixture.items = value; fixture.timelineWrites += 1; } };
    fixture.chat = chat;
    fixture.controller = initialize({ chat, jobs,
      currentMission: () => { dependency.depend(); return fixture.mission; },
      connectionStatus: () => { dependency.depend(); return { connected: fixture.connected }; },
      agentName: () => 'Atlas', now: () => fixture.now,
      subscribe: (name, mission, callbacks) => {
        const item = { name, mission, callbacks, stopped: false }; fixture.subscriptions.push(item);
        return { ready: () => { dependency.depend(); return fixture.ready; }, stop: () => { item.stopped = true; } };
      },
      setInterval: (callback) => { const id = ++fixture.sequence; fixture.ticks.set(id, callback); return id; },
      clearInterval: (id) => fixture.ticks.delete(id),
      openRun: (...args) => fixture.opened.push(args),
      stopRun: (id) => { fixture.stopped.push(id); return fixture.stop(id); },
      createCard: (actions) => {
        const card = { element: document.createElement('article'), actions, values: [], disposed: false,
          update(value) { this.values.push(value); this.value = value; }, dispose() { this.disposed = true; this.element.remove(); } };
        fixture.cards.push(card); return card;
      },
    });
  });
  afterEach(() => { fixture.controller.dispose(); flush(); fixture = null; });

  it('uses exact mission receipts, updates one card, and never places technical payloads in its model', () => {
    fixture.jobs.insert(job({ code: 'secret source', stdout: '{"private":"trace"}', stderr: 'private output' }));
    fixture.jobs.insert(job({ _id: 'other', missionId: 'another-mission' })); flush();
    assert.lengthOf(fixture.items, 1); assert.lengthOf(fixture.cards, 1);
    const card = fixture.cards[0]; assert.equal(card.value.agentDisplayName, 'Atlas');
    assert.notProperty(card.value, 'code'); assert.notProperty(card.value, 'stdout'); assert.notProperty(card.value, 'stderr');
    const writes = fixture.timelineWrites;
    fixture.jobs.update('job-one', { $set: { status: 'completed', completedAt: new Date(4000), artifacts: [{ id: 'file-one' }] } }); flush();
    assert.strictEqual(fixture.items[0].element, card.element); assert.equal(card.value.status, 'completed');
    assert.equal(fixture.timelineWrites, writes, 'state changes do not remount the conversation');
    assert.equal(card.value.elapsedMs, 3000); assert.equal(fixture.ticks.size, 0);
    card.actions.onView(); assert.deepEqual(fixture.opened, [['job-one', 'mission-one']]);
  });

  it('ticks only active connected work without republishing the timeline or inventing completion', () => {
    fixture.jobs.insert(job()); flush(); const card = fixture.cards[0]; const writes = fixture.timelineWrites;
    assert.equal(card.value.elapsedMs, 2000); assert.equal(fixture.ticks.size, 1);
    fixture.now = 7000; [...fixture.ticks.values()][0]();
    assert.equal(card.value.elapsedMs, 6000); assert.equal(fixture.timelineWrites, writes);
    fixture.connected = false; fixture.dependency.changed(); flush();
    assert.equal(card.value.connectionState, 'reconnecting'); assert.equal(fixture.ticks.size, 0);
    fixture.now = 12000; fixture.jobs.remove('job-one'); flush();
    assert.lengthOf(fixture.items, 1); assert.equal(card.value.status, 'running'); assert.equal(card.value.elapsedMs, 6000);
    fixture.connected = true; fixture.dependency.changed(); flush();
    assert.isEmpty(fixture.items); assert.isTrue(card.disposed);
  });

  it('fences exact stop requests and drops stale callbacks when the mission changes', async () => {
    fixture.jobs.insert(job()); flush(); const card = fixture.cards[0]; let finish;
    fixture.stop = () => new Promise((resolve) => { finish = resolve; });
    const stopped = card.actions.onStop(); card.actions.onStop();
    assert.deepEqual(fixture.stopped, ['job-one']); assert.isTrue(card.value.stopping);
    fixture.mission = 'mission-two'; fixture.dependency.changed(); flush();
    assert.isEmpty(fixture.items); assert.equal(fixture.ticks.size, 0); assert.isTrue(fixture.subscriptions[0].stopped);
    finish(); await stopped; card.actions.onView(); await card.actions.onStop();
    assert.isEmpty(fixture.opened); assert.deepEqual(fixture.stopped, ['job-one']); assert.isEmpty(fixture.items);
  });

  it('removes an explicitly erased receipt even while reconnecting', () => {
    fixture.jobs.insert(job()); flush(); const card = fixture.cards[0];
    fixture.connected = false; fixture.dependency.changed(); flush();
    fixture.jobs.update('job-one', { $set: { erasedAt: new Date() } }); flush();
    assert.isEmpty(fixture.items); assert.isTrue(card.disposed);
  });

  it('shows a safe stop error and never converts an unconfirmed result to stopped', async () => {
    fixture.jobs.insert(job()); flush(); const card = fixture.cards[0];
    fixture.stop = async () => { throw new Error('raw provider JSON or credential'); };
    await card.actions.onStop();
    assert.equal(card.value.status, 'running'); assert.include(card.value.actionError, 'Could not confirm');
    assert.notInclude(card.value.actionError, 'credential'); assert.isFalse(card.value.stopping);
  });

  it('keeps active older runs and other timeline sources through subscription failure and disposal', async () => {
    const { setChatTimelineSource } = await import('../client/chat-timeline');
    setChatTimelineSource(fixture.chat, 'plans', [{ id: 'plan', element: document.createElement('article'), createdAt: new Date() }]);
    for (let index = 0; index < 45; index += 1) fixture.jobs.insert(job({ _id: `done-${index}`, status: 'completed', createdAt: new Date(5000 + index), completedAt: new Date(6000 + index) }));
    fixture.jobs.insert(job()); flush(); assert.lengthOf(fixture.items, 42);
    fixture.subscriptions[0].callbacks.onError(); flush();
    const running = fixture.cards.find((card) => card.value._id === 'job-one');
    assert.equal(running.value.connectionState, 'unavailable'); await running.actions.onStop(); assert.isEmpty(fixture.stopped);
    fixture.controller.dispose(); assert.deepEqual(fixture.items.map((item) => item.id), ['plan']); assert.equal(fixture.ticks.size, 0);
  });
});
