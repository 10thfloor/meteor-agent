import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';

if (Meteor.isClient) describe('Constellation code execution entry points', function () {
  this.timeout(20_000);
  const $ = (id) => document.getElementById(id);
  const flush = async () => { Tracker.flush(); await new Promise(requestAnimationFrame); };
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail('Code execution entry points did not become ready.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let catalog; let crew; let originalCall; let executionCalls; let historyCalls;
  before(async () => {
    await waitUntil(() => Meteor.userId() && $('app-frame')?.dataset.startupState === 'ready');
    catalog = Mongo.getCollection('constellation_tool_catalog');
    crew = Mongo.getCollection('constellation_crew_configs');
    await waitUntil(() => catalog.findOne({ name: 'run_code', category: 'execution' }));
  });
  beforeEach(async () => {
    executionCalls = []; historyCalls = []; originalCall = Meteor.callAsync;
    Meteor.callAsync = function (name, ...args) {
      if (name === 'constellation.execution.historyPage') {
        historyCalls.push({ name, args });
        return Promise.resolve({ rows: [], nextCursor: null });
      }
      if (name.startsWith('constellation.execution.')) {
        executionCalls.push({ name, args });
        return Promise.reject({ reason: 'Execution calls are disabled in this navigation test.' });
      }
      return originalCall.call(this, name, ...args);
    };
    document.querySelector('[data-view="capabilities"]').click();
    $('capability-tab-tools').click(); $('clear-tool-filters').click();
    document.querySelector('[data-tool-view="tools"]').click();
    await flush();
  });
  afterEach(async () => {
    try {
      for (const dialog of document.querySelectorAll('dialog.execution-dialog[open]')) dialog.close();
      await flush();
      if ($('crew-dialog').open) $('cancel-crew-edit').click();
      $('clear-tool-filters').click();
      document.querySelector('[data-view="missions"]').click();
      await flush();
      assert.isEmpty(executionCalls, 'catalog navigation must not save settings, test credentials, or start remote work');
    } finally { Meteor.callAsync = originalCall; }
  });

  it('publishes the real run_code tool and leads from its details to Code access', async () => {
    const tool = catalog.findOne({ name: 'run_code', category: 'execution' });
    assert.equal(tool.source, 'app');
    assert.equal(tool.displayName, 'Run code');
    assert.sameMembers(tool.inputSchema.properties.language.enum, ['python', 'javascript', 'shell']);
    assert.include(tool.inputSchema.required, 'code');
    $('capability-search').value = 'run_code';
    $('capability-search').dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    const entry = $('tool-catalog-list').querySelector(`[data-tool-id="${CSS.escape(tool._id)}"]`);
    assert.ok(entry, 'an unconfigured built-in tool must remain discoverable');
    entry.click(); await flush();
    assert.equal($('open-tool-source').textContent, 'Manage code access');
    assert.isFalse($('open-tool-source').disabled);
    $('open-tool-source').click(); await flush();
    assert.equal($('capability-tab-execution').getAttribute('aria-selected'), 'true');
    assert.isFalse($('capability-panel-execution').hidden);
    assert.ok($('execution-panel').querySelector('[data-execution="crew"] select'));
    $('execution-panel').querySelector('[data-execution="open-settings"]').click();
    const dialog = document.querySelector('dialog.execution-dialog[open]');
    assert.ok(dialog); assert.equal(dialog.querySelector('h2').textContent, 'Sprites connection');
    assert.equal(dialog.querySelector('[data-execution="token"]').type, 'password');
    assert.equal(dialog.querySelector('[data-execution="token"]').value, '');
  });

  it('opens code permissions from the selected agent’s Tools tab and returns to that context', async () => {
    const agent = crew.findOne({ agent: 'orchestrator' });
    document.querySelector('[data-view="missions"]').click(); $('configure-crew').click();
    $('crew-directory-tab-agents').click();
    $('crew-settings-list').querySelector(`[data-config-id="${CSS.escape(agent._id)}"]`).click();
    const name = $('crew-name'); const draftName = `${agent.displayName} draft`;
    name.value = draftName; name.dispatchEvent(new Event('input', { bubbles: true }));
    $('agent-detail-tab-tools').click(); await flush();
    const opener = $('crew-execution-access'); opener.focus();
    assert.isFalse(opener.disabled); assert.equal(opener.closest('[role="tabpanel"]').id, 'agent-detail-panel-tools');
    opener.click(); await flush();
    assert.isNull(document.querySelector('[data-execution="access-form"]'), 'there is no second permission editor');
    assert.isFalse($('crew-dialog').open);
    assert.equal($('capability-tab-execution').getAttribute('aria-selected'), 'true');
    const row = $('execution-panel').querySelector('[data-agent="orchestrator"]');
    const select = row.querySelector('[data-execution="policy"]');
    assert.sameMembers([...select.options].map((option) => option.value), ['disabled', 'ask', 'auto']);
    assert.strictEqual(document.activeElement, select);
    assert.equal(name.value, draftName, 'navigation keeps the unsaved agent draft');
    const back = $('execution-panel').querySelector('[data-execution="return-environment"]');
    assert.include(back.textContent, 'Back to'); back.click(); await flush();
    assert.strictEqual(document.activeElement, opener);
    assert.isTrue($('crew-dialog').open);
    assert.equal($('agent-detail-tab-tools').getAttribute('aria-selected'), 'true');
    assert.equal(name.value, draftName, 'returning does not overwrite unsaved edits');
  });

  it('opens workspace-wide Code runs from the global Code tab instead of the last mission', async () => {
    $('capability-tab-execution').click(); await flush();
    const opener = $('execution-panel').querySelector('[data-execution="open-work"]');
    assert.equal(opener.textContent, 'View code runs'); assert.isFalse(opener.disabled);
    opener.focus(); opener.click(); await flush();
    const dialog = document.querySelector('dialog.code-runs-global-dialog[open]');
    assert.ok(dialog); assert.equal(dialog.querySelector('h2').textContent, 'All code runs');
    assert.equal(dialog.querySelector('.op-dialog-scope').textContent, 'All missions');
    assert.isFalse(dialog.querySelector('[data-runs="mission-field"]').hidden);
    const filter = dialog.querySelector('[data-runs="mission"]');
    assert.equal(filter.value, ''); assert.equal(filter.selectedOptions[0].textContent, 'All missions');
    assert.deepEqual(historyCalls, [{ name: 'constellation.execution.historyPage', args: [{ limit: 25 }] }]);
    const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    dialog.close(); await closed;
    assert.strictEqual(document.activeElement, opener);
    assert.equal($('capability-tab-execution').getAttribute('aria-selected'), 'true');
  });
});
