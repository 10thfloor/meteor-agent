import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';
import { defineAgentChat } from 'meteor/10thfloor:agent';

if (Meteor.isClient) describe('Constellation plan run timeline', function () {
  this.timeout(15_000);
  let createPlanRunTimeline;
  let fixture;
  let originalCall;
  const waitUntil = async (condition, message) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      assert.isBelow(Date.now(), deadline, message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
  };
  const visible = (element) => !!element && !element.closest('[hidden]');
  const cardFor = (id) => fixture.chat.timelineItems.find((item) => item.id === `plan-run-${id}`)?.element;
  const run = (overrides = {}) => ({
    _id: `${fixture.id}-run`, missionId: fixture.id, name: 'Release review', definitionRevision: 3,
    createdAt: new Date('2026-09-10T17:00:00Z'), status: 'running', steps: [
      { id: 'prepare', label: 'Check the release', primitive: 'agent', agent: 'researcher', status: 'completed',
        summary: 'The release checklist is ready.', childSessionId: `${fixture.id}-source`, dependsOn: [] },
      { id: 'finish', label: 'Review the result', primitive: 'agent', agent: 'reviewer', status: 'running',
        childSessionId: `${fixture.id}-child`, dependsOn: ['prepare'] },
    ], ...overrides,
  });
  const checkpointRun = (overrides = {}) => run({ status: 'awaiting', steps: [
    { id: 'prepare', label: 'Check the release', primitive: 'agent', agent: 'researcher', status: 'completed',
      summary: 'All required evidence is present. No blocking issues remain.', childSessionId: `${fixture.id}-source`, dependsOn: [] },
    { id: 'review', label: 'Approve the review', primitive: 'approval', status: 'awaiting', waitReason: 'approval',
      fingerprint: 'exact-review-v1', prompt: 'Are the sources sufficient to continue?', dependsOn: ['prepare'] },
  ], ...overrides });
  before(async () => {
    ({ createPlanRunTimeline } = await import('../client/plan-chat-runs.js'));
    defineAgentChat('agent-chat');
  });
  beforeEach(() => {
    const id = `run-timeline-${Random.id()}`;
    const mount = document.createElement('section');
    mount.style.cssText = 'position:fixed;inset:40px;z-index:100000;background:#101512;';
    const chat = document.createElement('agent-chat');
    chat.setAttribute('agent', id); chat.setAttribute('session-id', id);
    mount.append(chat); document.body.append(mount);
    const dependency = new Tracker.Dependency();
    fixture = { id, mount, chat, currentId: id, dependency, runs: new Mongo.Collection(null), configs: new Mongo.Collection(null),
      calls: [], opened: [], children: [], request: async () => ({ ok: true }) };
    fixture.configs.insert({ _id: id, title: 'Current mission', status: 'active' });
    originalCall = Meteor.callAsync;
    Meteor.callAsync = function timelineTransport(method, args, ...rest) {
      if (['constellation.workflowApprove', 'constellation.workflowCancel'].includes(method)
        && String(args?.runId).startsWith(fixture.id)) {
        fixture.calls.push({ method, args });
        return Promise.resolve().then(() => fixture.request(method, args));
      }
      return originalCall.call(this, method, args, ...rest);
    };
    fixture.surface = createPlanRunTimeline({ chat,
      currentMission: () => { dependency.depend(); return fixture.currentId; },
      missionConfig: (missionId) => fixture.configs.findOne(missionId), runs: fixture.runs,
      openContext: (...args) => fixture.opened.push(args), openChild: (...args) => fixture.children.push(args), toast: () => {},
    });
  });
  afterEach(() => {
    fixture.surface.dispose(); fixture.mount.remove(); Tracker.flush(); Meteor.callAsync = originalCall; fixture = undefined;
  });

  it('places every run in the conversation while the rail prioritizes review and exposes every active run', () => {
    const target = `${fixture.id}-target`;
    fixture.configs.insert({ _id: target, title: 'Release mission', status: 'active' });
    const attention = checkpointRun({ _id: `${fixture.id}-attention`, missionId: target, originChatId: fixture.id });
    fixture.runs.insert(attention);
    for (let index = 0; index < 3; index += 1) fixture.runs.insert(run({ _id: `${fixture.id}-active-${index}`,
      name: `Another run ${index + 1}`, createdAt: new Date(`2026-09-10T17:0${index + 1}:00Z`) }));
    fixture.runs.insert(run({ _id: `${fixture.id}-unrelated`, missionId: 'unrelated' }));
    Tracker.flush();
    assert.lengthOf(fixture.chat.timelineItems, 4, 'the fourth run must not disappear');
    assert.equal(fixture.surface.activity.slot, 'activity');
    assert.lengthOf(fixture.surface.activity.querySelectorAll('[data-chat-run]'), 0, 'the rail contains no history cards');
    assert.include(fixture.surface.activity.querySelector('.plan-run-rail-title').textContent, attention.name);
    assert.include(fixture.surface.activity.querySelector('[data-plan-rail-count]').textContent, '4 active');
    assert.lengthOf(fixture.surface.activity.querySelectorAll('[data-plan-rail-run]'), 4);
    const count = fixture.surface.activity.querySelector('[data-plan-rail-count]');
    const popover = fixture.surface.activity.querySelector('[popover]');
    count.click();
    assert.isTrue(popover.matches(':popover-open'));
    const bounds = popover.getBoundingClientRect();
    assert.isAtLeast(bounds.top, 0);
    assert.isAtMost(bounds.bottom, window.innerHeight, 'active runs stay inside the window');
    assert.isAtMost(bounds.right, window.innerWidth);
    const choices = [...popover.querySelectorAll('button')];
    choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, choices[1]);
    choices[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.isFalse(popover.matches(':popover-open'));
    assert.equal(document.activeElement, count);
    const card = cardFor(attention._id);
    assert.isTrue(card.querySelector('.plan-run-body').hidden, 'history begins compact');
    assert.isFalse(visible(card.querySelector('[data-chat-plan-approve]')), 'approval is not a blind action');
    fixture.surface.activity.querySelector('[data-plan-rail-main]').click();
    assert.isFalse(card.querySelector('.plan-run-body').hidden);
    assert.isTrue(visible(card.querySelector('.plan-run-review')));
    assert.include(card.querySelector('.plan-run-evidence').textContent, 'All required evidence is present.');
    assert.include(card.querySelector('.plan-run-review-question').textContent, 'Are the sources sufficient');
    assert.include(card.querySelector('.plan-run-meta').textContent, 'Release mission');
    card.querySelector('[data-chat-run-open]').click();
    assert.deepEqual(fixture.opened[0].slice(0, 3), [target, 'runs', attention._id]);
    assert.isEmpty(fixture.calls);
  });

  it('preserves card identity, disclosure and keyboard focus during work and shows the last agent result on completion', () => {
    const row = run(); fixture.runs.insert(row); Tracker.flush();
    const card = cardFor(row._id);
    const toggle = card.querySelector('[data-chat-run-toggle]');
    card.querySelector('.plan-run-chevron').click();
    assert.isFalse(card.querySelector('.plan-run-body').hidden, 'the visible chevron is part of the disclosure target');
    toggle.focus();
    fixture.runs.update(row._id, { $set: { status: 'awaiting', 'steps.1.status': 'awaiting', 'steps.1.waitReason': 'processing' } });
    Tracker.flush();
    assert.strictEqual(cardFor(row._id), card);
    assert.equal(document.activeElement, toggle);
    assert.isFalse(card.querySelector('.plan-run-body').hidden);
    assert.equal(card.dataset.state, 'working', 'processing does not request human review');
    assert.isFalse(visible(card.querySelector('[data-chat-plan-review]')));
    assert.isFalse(visible(card.querySelector('[data-chat-tool-review]')));
    fixture.runs.update(row._id, { $set: { status: 'completed', steps: [
      { id: 'answer', label: 'Release recommendation', primitive: 'agent', status: 'completed',
        summary: 'Ready to release after the scheduled backup.', dependsOn: [] },
      { id: 'approval', label: 'Final approval', primitive: 'approval', status: 'completed',
        summary: 'APPROVAL PROMPT IS NOT A RESULT', prompt: 'Confirm this review.', dependsOn: ['answer'] },
    ] } });
    Tracker.flush();
    assert.equal(card.dataset.state, 'completed');
    assert.include(card.querySelector('.plan-run-current').textContent, 'Ready to release');
    assert.include(card.querySelector('.plan-run-result').textContent, 'Ready to release');
    assert.notInclude(card.textContent, 'APPROVAL PROMPT IS NOT A RESULT');
    assert.isTrue(fixture.surface.activity.hidden, 'completed history leaves the active rail');
    toggle.click();
    assert.isTrue(card.querySelector('.plan-run-body').hidden);
    assert.isTrue(card.querySelector('progress').hidden);
  });

  it('counts skipped branches as settled without removing decision timeline cards', async () => {
    const { setChatTimelineSource } = await import('../client/chat-timeline.js');
    const decisionCard = document.createElement('article');
    decisionCard.textContent = 'Routing decision: review';
    setChatTimelineSource(fixture.chat, 'decisions', [{ id: 'decision-test-card', element: decisionCard, createdAt: new Date() }]);
    fixture.runs.insert(run({ steps: [
      { id: 'decide', label: 'Choose route', primitive: 'decision', status: 'completed' },
      { id: 'research', label: 'Research', primitive: 'agent', status: 'skipped' },
      { id: 'review', label: 'Review', primitive: 'agent', status: 'running' },
    ] }));
    Tracker.flush();
    const card = cardFor(`${fixture.id}-run`);
    assert.equal(card.querySelector('progress').value, 2);
    assert.include(card.textContent, '1 skipped');
    assert.strictEqual(fixture.chat.timelineItems.find((item) => item.id === 'decision-test-card').element, decisionCard);
    fixture.surface.dispose();
    assert.deepEqual(fixture.chat.timelineItems.map((item) => item.id), ['decision-test-card']);
    setChatTimelineSource(fixture.chat, 'decisions', []);
  });

  it('requires reviewing source results before an exact fingerprint verdict and retains asynchronous errors', async () => {
    const pending = deferred(); fixture.request = () => pending.promise;
    const row = checkpointRun(); fixture.runs.insert(row); Tracker.flush();
    const card = cardFor(row._id);
    const approve = card.querySelector('[data-chat-plan-approve="true"]');
    approve.click(); assert.isEmpty(fixture.calls, 'a hidden verdict is inert before review');
    card.querySelector('[data-chat-plan-review]').click();
    card.querySelector('.plan-run-evidence [type="button"]').click();
    assert.deepEqual(fixture.children[0], [`${fixture.id}-source`, 'researcher']);
    approve.click();
    assert.equal(approve.dataset.loading, 'true');
    assert.isTrue([...card.querySelectorAll('button')].every((button) => button.disabled));
    card.querySelector('[data-chat-plan-approve="false"]').click();
    assert.lengthOf(fixture.calls, 1);
    assert.deepEqual(fixture.calls[0], { method: 'constellation.workflowApprove', args: {
      runId: row._id, stepId: 'review', fingerprint: 'exact-review-v1', approved: true,
    } });
    pending.reject(new Error('The review changed. Refresh this run.'));
    await waitUntil(() => !card.querySelector('[data-chat-plan-approve="true"]').disabled, 'verdict did not leave its pending state');
    fixture.runs.update(row._id, { $set: { updatedAt: new Date() } }); Tracker.flush();
    assert.strictEqual(cardFor(row._id), card);
    assert.isTrue(visible(card.querySelector('[role="alert"]')));
    assert.include(card.querySelector('[role="alert"]').textContent, 'The review changed. Refresh this run.');
    assert.isFalse(card.querySelector('.plan-run-body').hidden);
  });

  it('requires a fresh review when the checkpoint fingerprint changes under an open card', () => {
    const row = checkpointRun(); fixture.runs.insert(row); Tracker.flush();
    const card = cardFor(row._id);
    card.querySelector('[data-chat-plan-review]').click();
    const approve = card.querySelector('[data-chat-plan-approve="true"]'); approve.focus();
    fixture.runs.update(row._id, { $set: { 'steps.1.fingerprint': 'new-review-v2', 'steps.1.prompt': 'Review the corrected result.' } });
    Tracker.flush();
    assert.isFalse(visible(approve));
    assert.isTrue(visible(card.querySelector('[data-chat-plan-review]')));
    assert.include(card.textContent, 'This review changed.');
    approve.click(); assert.isEmpty(fixture.calls);
    card.querySelector('[data-chat-plan-review]').click();
    assert.isTrue(visible(approve));
    assert.include(card.querySelector('.plan-run-review-question').textContent, 'corrected result');
  });

  it('routes tool review to its existing conversation and keeps JSON and approval prompts out of results', () => {
    const row = run({ status: 'awaiting', steps: [{ id: 'tool', label: 'Check references', primitive: 'agent', agent: 'reviewer',
      status: 'awaiting', waitReason: 'approval', childSessionId: `${fixture.id}-tool-child` }] });
    fixture.runs.insert(row); Tracker.flush();
    const card = cardFor(row._id);
    assert.isFalse(visible(card.querySelector('[data-chat-plan-review]')));
    card.querySelector('[data-chat-tool-review]').click();
    assert.deepEqual(fixture.children[0], [`${fixture.id}-tool-child`, 'reviewer']);
    fixture.runs.update(row._id, { $set: { status: 'completed', 'steps.0.status': 'completed',
      'steps.0.summary': '{"privateTrace":"never-show-this"}' } }); Tracker.flush();
    assert.notInclude(card.textContent, 'never-show-this');
    assert.notInclude(card.textContent, 'Structured data hidden');
    assert.include(card.querySelector('.plan-run-current').textContent, '1 of 1 steps complete');
    fixture.runs.update(row._id, { $set: { 'steps.0.summary': '```json\n{"privateTrace":"never-show-this"}\n```' } });
    Tracker.flush();
    assert.include(card.querySelector('.plan-run-current').textContent, '1 of 1 steps complete');
    assert.notInclude(card.textContent, 'Structured data hidden');
    assert.isTrue(fixture.surface.activity.hidden);
    assert.isEmpty(fixture.calls);
  });

  it('positions chat launches after posting and clears old cards and rail state when the mission changes', () => {
    const row = run({ originChatId: fixture.id, chatPostedAt: new Date('2026-09-10T17:00:01Z') });
    fixture.runs.insert(row); Tracker.flush();
    assert.equal(new Date(fixture.chat.timelineItems[0].createdAt).getTime(), row.chatPostedAt.getTime());
    cardFor(row._id).querySelector('[data-chat-run-toggle]').click();
    fixture.currentId = `${fixture.id}-next`; fixture.chat.setAttribute('session-id', fixture.currentId); fixture.dependency.changed();
    Tracker.flush();
    assert.lengthOf(fixture.chat.timelineItems, 0);
    assert.isTrue(fixture.surface.activity.hidden);
    fixture.currentId = fixture.id; fixture.chat.setAttribute('session-id', fixture.id); fixture.dependency.changed(); Tracker.flush();
    assert.isTrue(cardFor(row._id).querySelector('.plan-run-body').hidden);
  });
});
