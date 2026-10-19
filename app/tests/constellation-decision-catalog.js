import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';
import { DECISION_TOOL_NAMES } from '../imports/constellation/decisions';
import { decisionToolAccess, decisionAgentAccessSummary } from '../imports/constellation/decision-access';

describe('Constellation decision tool access', function () {
  const crew = [{ agent: 'orchestrator', enabled: true }, { agent: 'researcher', enabled: true },
    { agent: 'disabled', enabled: false }, { agent: 'archived', enabled: true, status: 'archived' }];
  it('keeps unconfigured tools inspectable without granting access', () => {
    for (const name of DECISION_TOOL_NAMES) {
      const row = decisionToolAccess(name, crew);
      assert.deepEqual(row.agents, []);
      assert.equal(row.statusLabel, 'Connection off');
      assert.equal(row.decisionAction, 'connection');
    }
  });
  it('separates definition authoring from paid evaluation readiness', () => {
    const settings = { enabled: true, providerConfigured: false, agentPolicies: {
      orchestrator: { use: true, create: 'ask' }, researcher: { use: true, create: 'disabled' },
    } };
    assert.deepEqual(decisionToolAccess('find_decision_nodes', crew, settings).agents, ['orchestrator', 'researcher']);
    assert.deepEqual(decisionToolAccess('create_decision_node', crew, settings).agents, ['orchestrator']);
    const evaluate = decisionToolAccess('evaluate_decision_node', crew, settings);
    assert.deepEqual(evaluate.agents, []);
    assert.deepEqual(evaluate.assignedAgents, ['orchestrator', 'researcher']);
    assert.equal(evaluate.statusLabel, 'Needs key');
  });
  it('respects explicit grants and excludes inactive agents', () => {
    const settings = { enabled: true, providerConfigured: true, agentPolicies: Object.fromEntries(crew.map(({ agent }) => [agent, { use: true, create: 'auto' }])) };
    for (const name of DECISION_TOOL_NAMES) assert.deepEqual(decisionToolAccess(name, crew, settings).agents, ['orchestrator', 'researcher']);
    settings.agentPolicies.orchestrator.use = false;
    settings.agentPolicies.researcher.create = 'disabled';
    const create = decisionToolAccess('create_decision_node', crew, settings);
    assert.deepEqual(create.agents, []);
    assert.equal(create.statusLabel, 'No access');
    assert.equal(create.decisionAction, 'access');
  });
  it('makes use and creation permissions separately readable', () => {
    assert.equal(decisionAgentAccessSummary().text, 'Use: Off · Create: Off');
    assert.equal(decisionAgentAccessSummary({ use: false, create: 'auto' }).text, 'Use: Off · Create: Off');
    assert.include(decisionAgentAccessSummary({ use: true, create: 'ask' }).text, 'Create: Ask for approval');
    assert.include(decisionAgentAccessSummary({ use: true, create: 'auto' }).text, 'Create: Automatic');
  });
});

if (Meteor.isClient) describe('Constellation decision catalog UI', function () {
  this.timeout(20_000);
  const $ = (id) => document.getElementById(id);
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail('The decision catalog did not update.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const flush = async () => { Tracker.flush(); await new Promise(requestAnimationFrame); };
  let catalog; let fixtureId;
  before(async () => {
    await waitUntil(() => Meteor.userId() && $('app-frame')?.dataset.startupState === 'ready');
    catalog = Mongo.getCollection('constellation_tool_catalog');
  });
  beforeEach(async () => {
    document.querySelector('[data-view="capabilities"]').click();
    $('capability-tab-tools').click();
    $('clear-tool-filters').click();
    document.querySelector('[data-tool-view="tools"]').click();
    await flush();
  });
  afterEach(async () => {
    if (fixtureId) catalog._collection.remove(fixtureId);
    fixtureId = null;
    for (const id of ['decision-connection-dialog', 'decision-access-dialog']) if ($(id)?.open) $(id).close();
    $('clear-tool-filters').click();
    document.querySelector('[data-view="missions"]').click();
    await flush();
  });
  it('publishes all three built-in Jev tools even with default access off', async () => {
    await waitUntil(() => catalog.find({ category: 'decisions' }).count() === 3);
    assert.sameMembers(catalog.find({ category: 'decisions' }).fetch().map((tool) => tool.name), DECISION_TOOL_NAMES);
    const create = catalog.findOne({ name: 'create_decision_node' });
    assert.deepEqual(create.inputSchema.properties.definition.properties.questions.additionalProperties.properties.type.enum,
      ['choice', 'score', 'noul'], 'the catalog must preserve the nested built-in schema');
    $('capability-search').value = 'Jev';
    $('capability-search').dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    assert.equal($('tool-catalog-list').querySelectorAll('[data-tool-id]').length, 3);
    assert.include($('tool-detail-source').textContent, 'JEV DECISIONS');
    assert.isFalse($('open-tool-source').disabled);
  });
  it('links a missing connection directly to settings without changing access', async () => {
    fixtureId = `decision_catalog_${Random.id()}`;
    catalog._collection.insert({ _id: fixtureId, source: 'app', category: 'decisions', name: 'evaluate_decision_node',
      displayName: 'Catalog readiness fixture', agents: [], assignedAgents: [], approval: 'auto',
      status: 'unavailable', statusLabel: 'Needs key', decisionAction: 'connection',
      availabilityNote: 'Add a TypeSafe key to evaluate decisions.' });
    $('capability-search').value = 'Catalog readiness fixture';
    $('capability-search').dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    assert.equal($('tool-detail-status').textContent, 'Needs key');
    assert.equal($('tool-detail-agents').textContent, 'No access');
    assert.equal($('open-tool-source').textContent, 'Configure Jev connection');
    $('open-tool-source').click();
    assert.isTrue($('decision-connection-dialog').open);
    $('decision-connection-dialog').close();
    catalog._collection.update(fixtureId, { $set: { status: 'disabled', statusLabel: 'No access', decisionAction: 'access' } });
    await flush();
    $('open-tool-source').click();
    assert.isTrue($('decision-access-dialog').open);
  });
});
