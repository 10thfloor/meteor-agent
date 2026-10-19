import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';

// Render the real Lab with client-only records. These layout checks never create
// a saved scenario, start an evaluation, or change an agent's memory.
if (Meteor.isClient) describe('Constellation Lab layout', function () {
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
  let datasets;
  let experiments;
  let datasetId;
  let experimentIds;
  let originalDatasetId;
  let originalCall;
  let attemptedMethods;
  let fixtureMount;
  let originalMemoryOpen;

  before(async () => {
    await waitUntil(() => Meteor.userId()
      && byId('app-frame')?.dataset.startupState === 'ready'
      && byId('lab-scenario-dialog'), 'the local app did not become ready');
    datasets = Mongo.getCollection('constellation_eval_datasets');
    experiments = Mongo.getCollection('constellation_eval_experiments');
    assert.ok(datasets);
    assert.ok(experiments);
  });

  beforeEach(async () => {
    attemptedMethods = [];
    originalCall = Meteor.callAsync;
    Meteor.callAsync = function labLayoutRead(method, ...args) {
      if (/^constellation\.eval/.test(method)) {
        attemptedMethods.push(method);
        return Promise.reject(new Error(`Layout tests must not mutate evaluations: ${method}`));
      }
      return originalCall.call(this, method, ...args);
    };
    originalDatasetId = byId('lab-dataset').value;
    originalMemoryOpen = byId('lab-scenario-dialog').querySelector('.op-details').open;
    datasetId = `lab-layout-set-${Random.id()}`;
    experimentIds = [Random.id(), Random.id()];
    datasets._collection.insert({ _id: datasetId, name: 'Layout-only scenario set',
      revision: 1, createdAt: new Date() });
    for (const [index, id] of experimentIds.entries()) {
      experiments._collection.insert({ _id: id, datasetId, status: 'completed',
        createdAt: new Date(Date.now() - index * 60_000) });
    }
    Tracker.flush();
    document.querySelector('[data-view="lab"]').click();
    byId('lab-dataset').value = datasetId;
    byId('lab-dataset').dispatchEvent(new Event('change', { bubbles: true }));
    await waitUntil(() => byId('lab-compare')?.checkVisibility(), 'fixture results did not render');
    await nextFrame();
  });

  afterEach(async () => {
    try {
      const dialog = byId('lab-scenario-dialog');
      dialog.querySelector('.op-details').open = originalMemoryOpen;
      if (dialog.open) {
        const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
        dialog.close();
        await closed;
      }
      fixtureMount?.remove();
      fixtureMount = undefined;
      for (const id of experimentIds ?? []) experiments._collection.remove(id);
      if (datasetId) datasets._collection.remove(datasetId);
      Tracker.flush();
      if ([...byId('lab-dataset').options].some((option) => option.value === originalDatasetId)) {
        byId('lab-dataset').value = originalDatasetId;
        byId('lab-dataset').dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('[data-view="missions"]').click();
      await nextFrame();
    } finally {
      Meteor.callAsync = originalCall;
    }
    assert.isEmpty(attemptedMethods, 'layout checks must not call evaluation methods');
  });

  it('separates Test memory fields while keeping each label close to its control', async () => {
    byId('lab-new-scenario').click();
    const dialog = byId('lab-scenario-dialog');
    assert.isTrue(dialog.open);
    const memory = dialog.querySelector('.op-details');
    memory.open = true;
    await nextFrame();
    const labels = [...memory.querySelectorAll(':scope > label')];
    assert.deepEqual(labels.map((label) => label.firstChild.textContent.trim()),
      ['Facts', 'Experiences', 'Practices', 'Constitution']);
    for (const [index, label] of labels.entries()) {
      const field = label.querySelector('textarea');
      assert.strictEqual(getComputedStyle(label).rowGap, '8px', 'keep label and control grouped');
      assert.strictEqual(label.control, field, 'retain the native field label');
      if (index > 0) {
        assert.closeTo(label.getBoundingClientRect().top
          - labels[index - 1].getBoundingClientRect().bottom, 18, 0.1,
        'leave space between the previous textarea and the next label');
      }
    }
  });

  it('keeps Compare with on one line and wraps its entire control without overflow', async () => {
    // Clone actual renderer output into a fixed-width local viewport; do not
    // duplicate production markup or alter the user's real Results layout.
    fixtureMount = document.createElement('div');
    fixtureMount.className = 'operations-lab';
    fixtureMount.style.cssText = 'position:fixed;left:0;top:0;z-index:100000;';
    const summary = byId('lab-results').querySelector('.op-result-summary').cloneNode(true);
    for (const element of summary.querySelectorAll('[id]')) element.removeAttribute('id');
    fixtureMount.append(summary);
    document.body.append(fixtureMount);
    const label = summary.querySelector('label');
    const text = label.querySelector(':scope > span');
    const select = label.querySelector('select');
    assert.ok(text, 'comparison text must be an independently sized label');
    assert.strictEqual(text.textContent, 'Compare with');
    assert.strictEqual(label.control, select);
    assert.include([...select.labels], label, 'the dropdown keeps its accessible name');
    for (const width of [320, 380, 600]) {
      fixtureMount.style.width = `${width}px`;
      await nextFrame();
      const textRange = document.createRange();
      textRange.selectNodeContents(text);
      assert.lengthOf([...textRange.getClientRects()], 1, `label stays on one line at ${width}px`);
      assert.strictEqual(getComputedStyle(text).flexShrink, '0');
      assert.strictEqual(getComputedStyle(text).whiteSpace, 'nowrap');
      assert.isAtMost(summary.scrollWidth, summary.clientWidth + 1, `no summary overflow at ${width}px`);
      assert.isAtMost(label.scrollWidth, label.clientWidth + 1, `no control overflow at ${width}px`);
      const bounds = summary.getBoundingClientRect();
      const control = label.getBoundingClientRect();
      assert.isAtLeast(control.left, bounds.left - 1);
      assert.isAtMost(control.right, bounds.right + 1);
      select.focus();
      assert.strictEqual(document.activeElement, select, 'the dropdown stays keyboard accessible');
    }
  });
});
