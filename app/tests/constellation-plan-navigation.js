import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';
import { LOCAL_MODEL } from '../imports/constellation/models';

// These are navigation fixtures only: no workflow, tool, or memory mutation is
// sent to the server. The real app dialogs and reactive renderers remain in use.
if (Meteor.isClient) describe('Constellation plan navigation', function () {
  this.timeout(20_000);
  const byId = (id) => document.getElementById(id);
  const waitUntil = async (condition, message) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() >= deadline) assert.fail(message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const closeAndWait = async (dialog, close) => {
    const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    close();
    await closed;
    await nextFrame();
  };
  let runs;
  let originalCall;
  let missionId;
  let runId;
  let fixtureIds;
  let draftName;
  let interceptedMethods;
  let oldDetailStyle;
  let oldListStyle;
  let evidenceFixture;
  let reflectionResult;
  let originalCrewModels;
  const stepId = 'navigation-step-5';
  const action = (attribute) => byId('op-run-detail')
    .querySelector(`[data-run-step="${stepId}"] [${attribute}]`);
  const selectedRun = () => byId('op-run-list').querySelector('[aria-pressed="true"]')?.dataset.runId;
  const assertParentContext = () => {
    assert.isTrue(byId('mission-plan-dialog').open, 'the plan must remain open');
    assert.strictEqual(byId('op-tab-runs').getAttribute('aria-selected'), 'true');
    assert.strictEqual(selectedRun(), runId, 'return to the selected older run, not the latest run');
    assert.strictEqual(byId('op-plan-name').value, draftName, 'retain the unsaved plan');
    assert.strictEqual(byId('op-plan-save-state').textContent, 'Unsaved changes');
  };
  const captureScroll = () => {
    const detail = byId('op-run-detail');
    const list = byId('op-run-list');
    detail.scrollTop = 180;
    list.scrollTop = 120;
    assert.isAbove(detail.scrollTop, 0, 'the fixture must exercise a scrolled run');
    assert.isAbove(list.scrollTop, 0, 'the fixture must exercise scrolled history');
    return { detail: detail.scrollTop, list: list.scrollTop };
  };
  const assertScroll = (positions) => {
    assert.strictEqual(byId('op-run-detail').scrollTop, positions.detail);
    assert.strictEqual(byId('op-run-list').scrollTop, positions.list);
  };
  const openEvidence = async () => {
    const control = action('data-run-evidence');
    control.focus({ preventScroll: true });
    control.click();
    await waitUntil(() => byId('run-evidence-dialog').open
      && byId('op-evidence-content').querySelector('[data-observation-draft]'), 'step evidence did not load');
    return byId('run-evidence-dialog');
  };
  const setLocalAgentModel = (model) => {
    const crew = Mongo.getCollection('constellation_crew_configs');
    const config = crew.findOne({ agent: 'orchestrator', status: { $ne: 'archived' } });
    assert.ok(config);
    if (!originalCrewModels.has(config._id)) originalCrewModels.set(config._id, config.model);
    crew._collection.update(config._id, { $set: { model } });
    Tracker.flush();
    return config;
  };

  before(async () => {
    await waitUntil(() => Meteor.userId()
      && byId('app-frame')?.dataset.startupState === 'ready'
      && byId('mission-plan-dialog'), 'the local app did not become ready');
    runs = Mongo.getCollection('constellation_workflow_runs');
    assert.ok(runs);
  });

  beforeEach(async () => {
    document.querySelector('[data-view="missions"]').click();
    missionId = byId('mission-chat').getAttribute('session-id');
    assert.ok(missionId);
    fixtureIds = [];
    interceptedMethods = [];
    reflectionResult = undefined;
    originalCrewModels = new Map();
    runId = `navigation-old-${Random.id()}`;
    draftName = `Unsaved navigation plan ${Random.id()}`;
    evidenceFixture = {
      traces: [{ _id: 'navigation-trace', agent: 'orchestrator', status: 'completed',
        summary: 'Navigation-only evidence', createdAt: new Date(0) }],
      manifests: [{ traceId: 'navigation-trace', memoryFrameId: 'navigation-frame',
        learningPolicy: { experienceAdmission: 'review' }, memory: {} }],
      spans: [], observations: [{ _id: 'navigation-observation', frameId: 'navigation-frame',
        status: 'recorded', summary: 'A navigation-only observation.', sourceMessageIds: [], createdAt: new Date(0) }],
    };
    originalCall = Meteor.callAsync;
    Meteor.callAsync = function navigationRead(method, ...args) {
      if (method === 'constellation.workflowGet') {
        interceptedMethods.push(method);
        return Promise.resolve({ definition: {
          name: 'Saved navigation plan', revision: 1, strategy: 'workflow', steps: [],
          budget: { steps: 20, timeoutMs: 600000, turns: 20, toolCalls: 20, spend: 5 },
        } });
      }
      if (method === 'constellation.sessionEvidence') {
        interceptedMethods.push(method);
        return Promise.resolve(evidenceFixture);
      }
      if (method === 'constellation.observationReflect' && reflectionResult !== undefined) {
        interceptedMethods.push(method);
        return Promise.resolve(reflectionResult);
      }
      if (/^constellation\.(workflow|observation|evidence)/.test(method)) {
        interceptedMethods.push(method);
        return Promise.reject(new Error(`Navigation tests must not mutate operational data: ${method}`));
      }
      return originalCall.call(this, method, ...args);
    };
    byId('open-mission-plan').click();
    await waitUntil(() => byId('mission-plan-dialog').open
      && !byId('op-plan-form').inert, 'the plan did not load');
    // A previous test can leave the draft dirty; use the real reload action to
    // establish a fresh edit without saving anything.
    if (!byId('op-discard-plan').hidden) {
      byId('op-discard-plan').click();
      await waitUntil(() => byId('op-plan-name').value === 'Saved navigation plan'
        && !byId('op-plan-form').inert, 'the prior draft did not reset');
    }
    byId('op-plan-name').value = draftName;
    byId('op-plan-name').dispatchEvent(new Event('input', { bubbles: true }));
    const steps = Array.from({ length: 10 }, (_, index) => ({
      id: `navigation-step-${index}`, primitive: 'agent', agent: 'orchestrator',
      label: `Navigation step ${index + 1}`, status: 'completed', attempts: 1,
      childSessionId: missionId, summary: 'Local fixture result. '.repeat(12),
    }));
    const baseDate = Date.now();
    for (let index = 0; index < 18; index += 1) {
      const id = index === 0 ? runId : `navigation-new-${Random.id()}`;
      fixtureIds.push(id);
      runs._collection.insert({ _id: id, missionId, name: `Navigation run ${index + 1}`,
        status: 'completed', definitionRevision: 1, createdAt: new Date(baseDate + index * 1000), steps });
    }
    Tracker.flush();
    byId('op-tab-runs').click();
    byId('op-run-list').querySelector(`[data-run-id="${runId}"]`).click();
    const detail = byId('op-run-detail');
    const list = byId('op-run-list');
    oldDetailStyle = detail.getAttribute('style');
    oldListStyle = list.getAttribute('style');
    // Fixed local viewport sizes make the scroll contract independent of the
    // headless browser's default window dimensions.
    detail.style.height = '300px';
    list.style.height = '300px';
    await nextFrame();
    assertParentContext();
  });

  afterEach(async () => {
    try {
      for (const id of ['observation-draft-dialog', 'run-evidence-dialog', 'run-dialog']) {
        const dialog = byId(id);
        if (dialog?.open) await closeAndWait(dialog, () => dialog.close());
      }
      const parent = byId('mission-plan-dialog');
      if (parent && !parent.open && !byId('op-discard-plan').hidden) {
        byId('open-mission-plan').click();
        await waitUntil(() => parent.open, 'the navigation draft did not reopen for cleanup');
      }
      if (parent?.open && !byId('op-discard-plan').hidden) {
        byId('op-discard-plan').click();
        await waitUntil(() => byId('op-plan-name').value === 'Saved navigation plan'
          && !byId('op-plan-form').inert, 'the navigation draft did not reset');
      }
      if (parent?.open) await closeAndWait(parent, () => parent.close());
      byId('inspector-tab-crew').click();
    } finally {
      for (const [id, style] of [['op-run-detail', oldDetailStyle], ['op-run-list', oldListStyle]]) {
        if (style == null) byId(id)?.removeAttribute('style');
        else byId(id)?.setAttribute('style', style);
      }
      for (const id of fixtureIds ?? []) runs?._collection.remove(id);
      const crew = Mongo.getCollection('constellation_crew_configs');
      for (const [id, model] of originalCrewModels ?? []) {
        crew._collection.update(id, model === undefined ? { $unset: { model: 1 } } : { $set: { model } });
      }
      Tracker.flush();
      Meteor.callAsync = originalCall;
    }
    const allowed = ['constellation.workflowGet', 'constellation.sessionEvidence'];
    if (reflectionResult !== undefined) allowed.push('constellation.observationReflect');
    assert.isTrue(interceptedMethods.every((name) => allowed.includes(name)),
      'navigation must not trigger workflow, approval, or memory writes');
  });

  it('returns from conversation X to the older run, draft, scroll, and live replacement opener', async () => {
    const positions = captureScroll();
    const opener = action('data-run-conversation');
    opener.focus({ preventScroll: true });
    opener.click();
    const child = byId('run-dialog');
    assert.isTrue(child.open);
    assert.isTrue(byId('mission-plan-dialog').open);
    runs._collection.update(runId, { $set: { name: 'Updated while conversation is open' } });
    Tracker.flush();
    assert.isFalse(opener.isConnected, 'exercise a reactive replacement while the child is open');
    byId('op-run-detail').scrollTop = 0;
    byId('op-run-list').scrollTop = 0;
    await closeAndWait(child, () => byId('close-run-dialog').click());
    assertParentContext();
    assertScroll(positions);
    assert.strictEqual(document.activeElement, action('data-run-conversation'));
    assert.strictEqual(byId('child-chat-mount').children.length, 0, 'close must still release the child chat');
  });

  it('shows practical plan guidance and includes that help in the dialog description', async () => {
    const dialog = byId('mission-plan-dialog');
    const explainer = byId('op-plan-explainer');
    assert.ok(explainer);
    assert.isTrue(explainer.checkVisibility(), 'the distinction must be visible without finding a tooltip');
    assert.include((dialog.getAttribute('aria-describedby') ?? '').split(/\s+/), explainer.id);
    assert.match(explainer.textContent, /multiple steps, agent handoffs, or approvals/i);
    assert.match(explainer.textContent, /add tasks, assign agents, then save and run/i);
    assert.match(explainer.textContent, /open runs to follow progress, handle approvals, and review results/i);
    assert.strictEqual(explainer.previousElementSibling, byId('mission-plan-dialog-scope'));
  });

  it('keeps the plan context when the tool-review conversation is dismissed with Escape semantics', async () => {
    runs._collection.update(runId, { $set: {
      status: 'awaiting', 'steps.5.status': 'awaiting', 'steps.5.waitReason': 'approval',
    } });
    Tracker.flush();
    const opener = action('data-run-conversation');
    assert.strictEqual(opener.textContent, 'Review tool request');
    opener.focus({ preventScroll: true });
    opener.click();
    const child = byId('run-dialog');
    assert.isFunction(child.requestClose, 'use the browser cancel/close path used by Escape');
    await closeAndWait(child, () => child.requestClose());
    assertParentContext();
    assert.strictEqual(document.activeElement, action('data-run-conversation'));
  });

  it('closes step evidence back to the run and restores the reusable evidence tab', async () => {
    const positions = captureScroll();
    const child = await openEvidence();
    assert.strictEqual(byId('op-panel-evidence').parentElement, child);
    assert.strictEqual(byId('op-panel-evidence').getAttribute('role'), 'region');
    assertParentContext();
    await closeAndWait(child, () => child.querySelector('[data-dialog-close]').click());
    assertParentContext();
    assertScroll(positions);
    assert.strictEqual(document.activeElement, action('data-run-evidence'));
    assert.strictEqual(byId('op-panel-evidence').parentElement, byId('mission-plan-dialog'));
    assert.strictEqual(byId('op-panel-evidence').getAttribute('role'), 'tabpanel');
    assert.isTrue(byId('op-panel-evidence').hidden);
  });

  it('returns nested drafts to evidence first, then returns evidence to the selected run', async () => {
    const evidence = await openEvidence();
    const observation = byId('op-evidence-content').querySelector('[data-observation-id]');
    observation.open = true;
    const opener = observation.querySelector('[data-observation-draft]');
    opener.focus({ preventScroll: true });
    opener.click();
    const draft = byId('observation-draft-dialog');
    assert.isTrue(draft.open);
    assert.isTrue(evidence.open);
    assertParentContext();
    await closeAndWait(draft, () => draft.requestClose());
    assert.isTrue(evidence.open, 'the nested close must not dismiss evidence');
    assert.strictEqual(document.activeElement, opener);
    await closeAndWait(evidence, () => evidence.requestClose());
    assertParentContext();
    assert.strictEqual(document.activeElement, action('data-run-evidence'));
  });

  it('separates the final draft fields and aligns their controls and admission hint', async () => {
    await openEvidence();
    const observation = byId('op-evidence-content').querySelector('[data-observation-id]');
    observation.open = true;
    observation.querySelector('[data-observation-draft]').click();
    assert.isTrue(byId('observation-draft-dialog').open);
    await nextFrame();
    const lesson = byId('observation-lesson').getBoundingClientRect();
    const row = byId('observation-context').closest('.op-form-row').getBoundingClientRect();
    const context = byId('observation-context').getBoundingClientRect();
    const confidence = byId('observation-confidence').getBoundingClientRect();
    const hint = byId('observation-admission-hint').getBoundingClientRect();
    assert.closeTo(row.top - lesson.bottom, 18, 0.1, 'Context and Confidence need a complete field gap after Lesson');
    assert.closeTo(context.height, 42, 0.1);
    assert.closeTo(confidence.height, 42, 0.1);
    assert.closeTo(context.top, confidence.top, 0.1);
    assert.closeTo(context.bottom, confidence.bottom, 0.1);
    assert.closeTo(hint.top - row.bottom, 12, 0.1, 'the policy hint has its own breathing room');
  });

  it('shows a compact observation preview only while collapsed and full source text only when expanded', async () => {
    const sourceText = '<b>Not markup</b> — A supported observation with enough source detail to wrap. '.repeat(12);
    evidenceFixture.observations[0].summary = sourceText;
    await openEvidence();
    const observation = byId('op-evidence-content').querySelector('[data-observation-id]');
    const summary = observation.querySelector(':scope > summary');
    const preview = summary.querySelector('.op-observation-preview');
    const body = observation.querySelector(':scope > .op-observation-body');
    observation.open = false;
    await nextFrame();
    assert.strictEqual(preview.textContent, sourceText, 'preserve the source text instead of truncating its data');
    assert.isNull(preview.querySelector('b'), 'source text must remain escaped');
    assert.strictEqual(getComputedStyle(preview).webkitLineClamp, '2');
    assert.isAtMost(preview.clientHeight, parseFloat(getComputedStyle(preview).lineHeight) * 2 + 1);
    assert.isTrue(preview.checkVisibility(), 'collapsed cards show the preview');
    assert.isFalse(body.checkVisibility(), 'native details hides the full body while collapsed');
    assert.strictEqual(summary.querySelector('.op-observation-chevron').getAttribute('aria-hidden'), 'true');
    const agent = Mongo.getCollection('constellation_crew_configs').findOne({ agent: 'orchestrator' });
    assert.strictEqual(summary.querySelector('.op-observation-heading strong').textContent, agent.displayName,
      'fall back to the turn agent when the observation has no agent key');

    summary.click();
    await nextFrame();
    assert.isTrue(observation.open, 'retain the native disclosure control');
    assert.strictEqual(getComputedStyle(preview).display, 'none', 'expanded cards must not repeat the source in the header');
    assert.isTrue(body.checkVisibility());
    assert.strictEqual(body.textContent, sourceText);
    assert.isNull(body.querySelector('b'));
    summary.click();
    await nextFrame();
    assert.isFalse(observation.open);
    assert.isTrue(preview.checkVisibility());
  });

  it('keeps the resolved agent, source count, date, and state together without repeated metadata', async () => {
    const crew = Mongo.getCollection('constellation_crew_configs');
    const operator = crew.findOne({ agent: 'operator', status: { $ne: 'archived' } });
    assert.ok(operator, 'the local crew provides a display name');
    evidenceFixture.observations[0].agent = operator.agent;
    evidenceFixture.observations[0].sourceMessageIds = ['source-one', 'source-two'];
    await openEvidence();
    const observation = byId('op-evidence-content').querySelector('[data-observation-id]');
    const summary = observation.querySelector(':scope > summary');
    assert.strictEqual(summary.querySelector('.op-observation-heading strong').textContent, operator.displayName);
    assert.match(summary.querySelector('.op-observation-heading small').textContent, /^2 source messages · /);
    assert.lengthOf(observation.querySelectorAll('.op-observation-heading small'), 1);
    assert.strictEqual(summary.querySelector(':scope > .op-state').textContent, 'Observation');
    assert.isFalse([...observation.querySelectorAll(':scope > p.op-hint')].some((row) => /source messages/.test(row.textContent)),
      'source metadata must not be repeated in the body');
    assert.notInclude(observation.parentElement.textContent, 'Source notes become experience through your agent’s learning policy.');
  });

  it('explains unavailable scripted reflection while keeping manual drafts available', async () => {
    setLocalAgentModel(LOCAL_MODEL);
    await openEvidence();
    const observation = byId('op-evidence-content').querySelector('[data-observation-id]');
    observation.open = true;
    const reflect = observation.querySelector('[data-observation-reflect]');
    const draft = observation.querySelector('[data-observation-draft]');
    assert.isTrue(reflect.disabled);
    const hint = byId(reflect.getAttribute('aria-describedby'));
    assert.ok(hint);
    assert.strictEqual(hint.textContent, 'Agent reflection needs a live model. You can draft an experience manually.');
    assert.isFalse(draft.disabled);
    reflect.click();
    await nextFrame();
    assert.notInclude(interceptedMethods, 'constellation.observationReflect');
    draft.click();
    assert.isTrue(byId('observation-draft-dialog').open, 'manual drafting still works in test mode');
  });

  for (const [status, message] of [
    ['recorded', 'Reflection complete. No new lesson identified.'],
    ['candidate', 'Draft experience ready for review.'],
    ['admitted', 'Experience recorded.'],
  ]) {
    it(`reports the ${status} reflection result without making a live model or memory call`, async () => {
      setLocalAgentModel('live/fixture');
      reflectionResult = { ...evidenceFixture.observations[0], status, processing: false };
      await openEvidence();
      const observation = byId('op-evidence-content').querySelector('[data-observation-id]');
      observation.open = true;
      const reflect = observation.querySelector('[data-observation-reflect]');
      assert.isFalse(reflect.disabled);
      reflect.click();
      await waitUntil(() => [...byId('toast-region').querySelectorAll('.toast span')]
        .some((copy) => copy.textContent === message), 'the reflection outcome was not shown');
      assert.lengthOf(interceptedMethods.filter((name) => name === 'constellation.observationReflect'), 1);
    });
  }

  it('falls back to the Runs tab when the evidence opener disappears during live updates', async () => {
    const child = await openEvidence();
    runs._collection.update(runId, { $pull: { steps: { id: stepId } } });
    Tracker.flush();
    assert.isNull(action('data-run-evidence'));
    await closeAndWait(child, () => child.requestClose());
    assertParentContext();
    assert.strictEqual(document.activeElement, byId('op-tab-runs'));
  });

  it('keeps direct mission evidence as a normal top-level dialog', async () => {
    const parent = byId('mission-plan-dialog');
    await closeAndWait(parent, () => parent.close());
    byId('inspector-tab-activity').click();
    byId('open-mission-evidence').focus({ preventScroll: true });
    byId('open-mission-evidence').click();
    await waitUntil(() => parent.open
      && byId('op-tab-evidence').getAttribute('aria-selected') === 'true', 'direct mission evidence did not open');
    assert.isFalse(byId('run-evidence-dialog').open);
    assert.strictEqual(byId('op-panel-evidence').parentElement, parent);
    await closeAndWait(parent, () => parent.requestClose());
    assert.isFalse(parent.open, 'direct evidence closes to the main mission, not a stale run context');
    assert.isFalse(byId('run-evidence-dialog').open);
    assert.strictEqual(document.activeElement, byId('open-mission-evidence'));
  });
});

// Exercise the shared learning controls in the actual workspace directory. Only
// tabs and native disclosures are changed; no constitution or practice is saved.
if (Meteor.isClient) describe('Constellation learning control visuals', function () {
  this.timeout(20_000);
  const byId = (id) => document.getElementById(id);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const waitUntil = async (condition, message) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() >= deadline) assert.fail(message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let originalOpen;

  before(async () => {
    await waitUntil(() => Meteor.userId()
      && byId('app-frame')?.dataset.startupState === 'ready'
      && byId('crew-dialog'), 'the local app did not become ready');
  });

  beforeEach(async () => {
    document.querySelector('[data-view="missions"]').click();
    byId('inspector-tab-crew').click();
    const config = Mongo.getCollection('constellation_crew_configs')
      .findOne({ agent: 'orchestrator', status: { $ne: 'archived' } });
    assert.ok(config, 'the seeded crew provides a saved agent');
    byId('crew-list').querySelector(`[data-config-id="${CSS.escape(config._id)}"] [data-crew-action="settings"]`).click();
    assert.isTrue(byId('crew-dialog').open);
    byId('agent-detail-tab-constitution').click();
    await waitUntil(() => byId('constitution-content').checkVisibility()
      && byId('constitution-compose').checkVisibility(), 'the constitution did not load');
    originalOpen = new Map(['constitution-compose', 'practice-compose']
      .map((id) => [id, byId(id).open]));
    await nextFrame();
  });

  afterEach(async () => {
    for (const [id, open] of originalOpen ?? []) byId(id).open = open;
    byId('agent-detail-tab-profile').click();
    if (byId('crew-dialog').open) {
      const closed = new Promise((resolve) => byId('crew-dialog')
        .addEventListener('close', resolve, { once: true }));
      byId('close-crew-dialog').click();
      await closed;
    }
    await nextFrame();
  });

  it('centers status pills consistently in the constitution header and history', () => {
    const headerPill = byId('constitution-state');
    assert.strictEqual(headerPill.textContent, 'Active');
    const pills = [...byId('constitution-content').querySelectorAll('.learning-status')];
    assert.isAtLeast(pills.length, 2, 'check the shared history pill as well as the panel header');
    for (const pill of pills) {
      const style = getComputedStyle(pill);
      // Flex-item blockification can report inline-flex as flex.
      assert.include(['flex', 'inline-flex'], style.display);
      assert.strictEqual(style.alignItems, 'center');
      assert.strictEqual(style.justifyContent, 'center');
      assert.strictEqual(style.paddingTop, '3px');
      assert.strictEqual(style.paddingBottom, style.paddingTop);
      assert.strictEqual(style.paddingLeft, '9px');
      assert.strictEqual(style.paddingRight, style.paddingLeft);
      assert.strictEqual(style.whiteSpace, 'nowrap');
      assert.strictEqual(style.flexShrink, '0');
      assert.closeTo(pill.getBoundingClientRect().height, 24, 0.1);
    }
  });

  for (const [tab, composeId] of [
    ['constitution', 'constitution-compose'],
    ['practices', 'practice-compose'],
  ]) {
    it(`keeps the ${tab} disclosure frame square and switches its plus to a minus`, async () => {
      byId(`agent-detail-tab-${tab}`).click();
      const compose = byId(composeId);
      await waitUntil(() => compose.checkVisibility(), `${tab} did not load`);
      const summary = compose.querySelector(':scope > summary');
      const icon = summary.querySelector(':scope > i');
      const vertical = icon.querySelector('.learning-compose-icon-vertical');
      const body = compose.querySelector(':scope > .learning-compose-body');
      assert.ok(vertical, 'the glyph must have an independently toggleable vertical stroke');
      assert.strictEqual(icon.getAttribute('aria-hidden'), 'true');
      assert.strictEqual(summary.tagName, 'SUMMARY', 'keep the native keyboard-accessible disclosure');
      const initialFields = [...body.querySelectorAll('input,textarea')].map((field) => field.value);
      const assertFrame = () => {
        assert.strictEqual(getComputedStyle(icon).transform, 'none', 'the surrounding frame must not rotate');
        const rect = icon.getBoundingClientRect();
        assert.closeTo(rect.width, 26, 0.1);
        assert.closeTo(rect.height, 26, 0.1);
      };
      compose.open = false;
      await waitUntil(() => getComputedStyle(vertical).opacity === '1', 'collapsed glyph did not show a plus');
      assertFrame();
      assert.isFalse(body.checkVisibility());
      summary.focus();
      assert.strictEqual(document.activeElement, summary, 'the summary stays keyboard focusable');
      summary.click();
      await waitUntil(() => getComputedStyle(vertical).opacity === '0', 'expanded glyph did not show a minus');
      assert.isTrue(compose.open);
      assert.isTrue(body.checkVisibility());
      assertFrame();
      assert.closeTo(body.getBoundingClientRect().top - summary.getBoundingClientRect().bottom, 12, 0.1,
        'separate the expanded form divider from its disclosure header');
      summary.click();
      await waitUntil(() => getComputedStyle(vertical).opacity === '1', 'closing did not restore a plus');
      assert.isFalse(compose.open);
      assert.isFalse(body.checkVisibility());
      assertFrame();
      assert.deepEqual([...body.querySelectorAll('input,textarea')].map((field) => field.value), initialFields,
        'expanding and collapsing must not change the draft');
    });
  }
});
