import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';

if (Meteor.isClient) describe('Constellation agent capability navigation', function () {
  this.timeout(20_000);
  const $ = (id) => document.getElementById(id);
  const flush = async () => { Tracker.flush(); await new Promise(requestAnimationFrame); };
  const waitUntil = async (condition) => {
    const until = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > until) assert.fail('Agent capability controls did not become ready.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  let crew; let skills; let catalog; let primary; let fixtureId; let toolFixtureId; let originalCall; let writes;
  before(async () => {
    await waitUntil(() => Meteor.userId() && $('app-frame')?.dataset.startupState === 'ready');
    crew = Mongo.getCollection('constellation_crew_configs');
    skills = Mongo.getCollection('constellation_skills');
    catalog = Mongo.getCollection('constellation_tool_catalog');
  });
  beforeEach(async () => {
    primary = crew.findOne({ agent: 'orchestrator' });
    writes = [];
    originalCall = Meteor.callAsync;
    Meteor.callAsync = function (method, ...args) {
      if (['constellation.skillSave', 'constellation.skillCreate'].includes(method)) {
        writes.push({ method, args });
        return Promise.resolve('test-skill-save');
      }
      return originalCall.call(this, method, ...args);
    };
    document.querySelector('[data-view="missions"]').click();
    $('configure-crew').click();
    $('crew-directory-tab-agents').click();
    $('crew-settings-list').querySelector(`[data-config-id="${CSS.escape(primary._id)}"]`).click();
    $('agent-detail-tab-profile').click();
    await flush();
  });
  afterEach(async () => {
    if ($('skill-dialog').open) $('skill-dialog').close();
    await flush();
    if ($('crew-dialog').open) $('cancel-crew-edit').click();
    if (fixtureId) skills._collection.remove(fixtureId);
    if (toolFixtureId) catalog._collection.remove(toolFixtureId);
    fixtureId = null;
    toolFixtureId = null;
    $('clear-tool-filters').click();
    document.querySelector('[data-tool-view="tools"]').click();
    Meteor.callAsync = originalCall;
    await flush();
  });

  it('supports keyboard tabs and keeps app tool switches in Tools with a visible save action', async () => {
    $('agent-detail-tab-profile').focus();
    $('agent-detail-tab-profile').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement.id, 'agent-detail-tab-skills');
    assert.isFalse($('agent-detail-panel-skills').hidden);
    $('agent-detail-tab-skills').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement.id, 'agent-detail-tab-tools');
    assert.isFalse($('crew-form-actions').hidden);
    assert.equal($('crew-cap-inspect').closest('[role="tabpanel"]').id, 'agent-detail-panel-tools');
    const prior = $('crew-cap-inspect').checked;
    $('crew-cap-inspect').click();
    assert.include($('crew-inspect-state').textContent, 'on save');
    assert.equal($('crew-edit-state').textContent, 'Unsaved changes');
    assert.isFalse($('crew-form').querySelector('[type="submit"]').disabled);
    $('crew-cap-inspect').click();
    assert.equal($('crew-cap-inspect').checked, prior);
    assert.equal($('crew-edit-state').textContent, 'Saved');
  });

  it('creates an assigned skill without losing the agent tab or an unsaved profile', async () => {
    $('crew-name').value = 'Unsaved agent name';
    $('crew-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('agent-detail-tab-skills').click();
    await flush();
    const create = $('agent-skills-content').querySelector('[data-agent-create-skill]');
    assert.ok(create);
    create.click();
    assert.isTrue($('crew-dialog').open);
    assert.isTrue($('skill-dialog').open);
    assert.isTrue($('skill-agent-options').querySelector(`input[value="${primary.agent}"]`).checked);
    assert.include($('skill-shared-edit-hint').textContent, primary.displayName);
    $('skill-name').value = 'Agent-created skill';
    $('skill-description').value = 'Useful instructions';
    $('skill-instructions').value = 'Check the supplied facts before replying.';
    $('skill-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('skill-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => !$('skill-dialog').open);
    await flush();
    assert.equal(writes[0].method, 'constellation.skillCreate');
    assert.deepEqual(writes[0].args[0].agents, [primary.agent]);
    assert.equal($('agent-detail-tab-skills').getAttribute('aria-selected'), 'true');
    assert.equal($('crew-name').value, 'Unsaved agent name');
    assert.equal($('crew-edit-state').textContent, 'Unsaved changes');
    assert.isTrue(document.activeElement.hasAttribute('data-agent-create-skill'));
  });

  it('exposes mission file access in the existing Tools settings without saving on view', async () => {
    $('agent-detail-tab-tools').click(); await flush();
    const control = $('crew-cap-files');
    assert.equal(control.closest('[role="tabpanel"]').id, 'agent-detail-panel-tools');
    assert.equal(control.checked, primary.capabilities?.files !== false);
    assert.equal($('crew-edit-state').textContent, 'Saved');
    const original = control.checked; control.click();
    assert.include($('crew-files-state').textContent, 'on save');
    assert.equal($('crew-edit-state').textContent, 'Unsaved changes');
    control.click(); assert.equal(control.checked, original);
    assert.equal($('crew-edit-state').textContent, 'Saved');
  });

  it('edits the existing shared skill and returns to the same agent without replacing assignments', async () => {
    const specialist = crew.findOne({ agent: { $ne: primary.agent }, status: { $ne: 'archived' } });
    fixtureId = `agent-config-skill-${Random.id()}`;
    skills._collection.insert({ _id: fixtureId, name: 'Shared skill fixture', slug: 'shared-skill-fixture',
      description: 'Shared instructions', content: 'Original instructions', enabled: false, revision: 7,
      agents: [primary.agent, specialist.agent] });
    $('agent-detail-tab-skills').click();
    await flush();
    $('agent-skills-content').querySelector(`[data-skill-edit="${fixtureId}"]`).click();
    assert.equal($('skill-dialog-title').textContent, 'Edit skill');
    assert.include($('skill-shared-edit-hint').textContent, 'all 2 assigned agents');
    $('skill-instructions').value = 'Revised shared instructions';
    $('skill-instructions').dispatchEvent(new Event('input', { bubbles: true }));
    $('skill-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => !$('skill-dialog').open);
    await flush();
    const [id, revision, patch] = writes[0].args;
    assert.equal(id, fixtureId);
    assert.equal(revision, 7);
    assert.equal(patch.content, 'Revised shared instructions');
    assert.sameMembers(patch.agents, [primary.agent, specialist.agent]);
    assert.isFalse(patch.enabled, 'Editing must not silently enable a disabled skill.');
    assert.isTrue($('crew-dialog').open);
    assert.equal(document.activeElement.dataset.skillEdit, fixtureId);
  });

  it('shows inherited memory without turning it into an explicit new grant', async () => {
    const specialist = crew.findOne({ agent: { $ne: primary.agent }, enabled: true, 'capabilities.memory': false });
    assert.ok(specialist);
    assert.isTrue(primary.capabilities.memory);
    $('crew-settings-list').querySelector(`[data-config-id="${CSS.escape(specialist._id)}"]`).click();
    $('agent-detail-tab-tools').click();
    await flush();
    assert.isTrue($('crew-cap-memory').hidden);
    assert.isFalse($('crew-cap-memory').checked);
    assert.include($('crew-memory-state').textContent, `Inherited from ${primary.displayName}`);
    assert.isFalse($('crew-memory-source').hidden);
    assert.equal($('crew-edit-state').textContent, 'Saved');
    $('crew-memory-source').click();
    await flush();
    assert.equal($('crew-form-title').textContent, primary.displayName);
    assert.equal($('agent-detail-tab-tools').getAttribute('aria-selected'), 'true');
    assert.isFalse($('crew-cap-memory').hidden);
  });

  it('opens the relevant agent tab directly from catalog access links', async () => {
    $('cancel-crew-edit').click();
    document.querySelector('[data-view="capabilities"]').click();
    $('capability-tab-tools').click();
    $('clear-tool-filters').click();
    $('tool-agent-filter').value = primary.agent;
    $('tool-agent-filter').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-tool-view="agents"]').click();
    await flush();
    $('tool-catalog-by-agent').querySelector('.tool-agent-group header button').click();
    assert.equal($('crew-form-title').textContent, primary.displayName);
    assert.equal($('agent-detail-tab-tools').getAttribute('aria-selected'), 'true');
    $('cancel-crew-edit').click();
    document.querySelector('[data-tool-view="tools"]').click();

    toolFixtureId = `agent-config-tool-${Random.id()}`;
    catalog._collection.insert({ _id: toolFixtureId, name: 'inspect_workspace', source: 'app',
      displayName: 'Agent access navigation fixture', status: 'ready', agents: [primary.agent] });
    $('capability-search').value = 'Agent access navigation fixture';
    $('capability-search').dispatchEvent(new Event('input', { bubbles: true }));
    for (const [patch, tab] of [
      [{}, 'tools'],
      [{ source: 'workspace-mcp', serverId: 'navigation-server' }, 'tools'],
      [{ source: 'framework', category: 'skills', serverId: null }, 'skills'],
    ]) {
      if (Object.keys(patch).length) catalog._collection.update(toolFixtureId, { $set: patch });
      await flush();
      assert.equal($('open-tool-source').textContent, 'Manage crew access');
      $('open-tool-source').click();
      assert.isTrue($('crew-dialog').open);
      assert.equal($('crew-form-title').textContent, primary.displayName);
      assert.equal($(`agent-detail-tab-${tab}`).getAttribute('aria-selected'), 'true', `Expected ${tab} for the displayed tool`);
      $('crew-directory-tab-people').click();
      $('cancel-crew-edit').click();
    }
    $('tool-agent-filter').value = 'all';
    $('tool-agent-filter').dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    $('open-tool-source').click();
    assert.equal($('crew-directory-tab-agents').getAttribute('aria-selected'), 'true');
    assert.equal($('agent-detail-tab-skills').getAttribute('aria-selected'), 'true');
  });
});
