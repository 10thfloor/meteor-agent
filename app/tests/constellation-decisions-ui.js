import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';

// Client-only records and an intercepted transport exercise the shipped UI.
// Nothing in this suite calls TypeSafe or changes persisted workspace data.
if (Meteor.isClient) describe('Constellation Decisions UI', function () {
  this.timeout(20_000);
  const $ = (id) => document.getElementById(id);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const waitUntil = async (condition, message) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() >= deadline) assert.fail(message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let nodes; let settings; let runs; let budgets; let nodeId; let settingsBefore; let originalCall;
  let calls; let response; let originalQuery;
  const node = () => nodes.findOne(nodeId);
  const flush = async () => { Tracker.flush(); await nextFrame(); };
  const submit = (form) => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('[type="submit"]') }));
  const chooseTab = (name) => document.querySelector(`[data-decision-tab="${name}"]`).click();
  const updateNode = async (patch) => { nodes._collection.update(nodeId, { $set: patch }); await flush(); };
  const baseNode = () => ({ _id: nodeId, name: 'Decision UI fixture', description: 'Check source support.', scope: 'workspace',
    revision: 1, enabled: true, status: 'active', agentIds: [], createdAt: new Date(), updatedAt: new Date(),
    inputFields: [{ key: 'context', label: 'Evidence', type: 'text', required: true }],
    definition: { model: 'jev-latest', questions: { supported: { type: 'choice', instructions: 'Does `context` support the claim?', criteria: { supported: 'Supported', unknown: 'Not enough evidence' } } } }, fixtures: [] });
  before(async () => {
    await waitUntil(() => Meteor.userId() && $('app-frame')?.dataset.startupState === 'ready' && $('decision-editor'), 'the decision interface did not initialize');
    nodes = Mongo.getCollection('constellation_decision_nodes');
    settings = Mongo.getCollection('constellation_decision_settings');
    runs = Mongo.getCollection('constellation_decision_runs');
    budgets = Mongo.getCollection('constellation_decision_budgets');
    assert.ok(nodes); assert.ok(settings); assert.ok(runs);
  });
  beforeEach(async () => {
    nodeId = `decision_ui_${Random.id()}`; calls = [];
    settingsBefore = settings.find().fetch();
    originalQuery = $('capability-search').value;
    originalCall = Meteor.callAsync;
    response = async (name, input) => {
      if (name === 'history' || name === 'versions') return [];
      if (name === 'save') return { _id: nodeId, ...input.input, revision: 2 };
      return {};
    };
    Meteor.callAsync = function decisionUiTransport(method, ...args) {
      if (method.startsWith('constellation.decisions.')) {
        const name = method.slice('constellation.decisions.'.length);
        calls.push({ name, input: args[0] });
        return Promise.resolve().then(() => response(name, args[0]));
      }
      return originalCall.call(this, method, ...args);
    };
    settings._collection.remove({});
    settings._collection.insert({ _id: 'ui_fixture_settings', enabled: true, providerConfigured: true, canStoreSecret: true,
      keySource: 'shell', limits: { callsPerMission: 20, tokensPerMission: 100000, maxInputChars: 12000 }, agentPolicies: {} });
    nodes._collection.insert(baseNode());
    document.querySelector('[data-view="capabilities"]').click();
    $('capability-tab-decisions').click();
    $('capability-search').value = 'Decision UI fixture';
    $('capability-search').dispatchEvent(new Event('input', { bubbles: true }));
    $('decision-scope-filter').value = 'all'; $('decision-scope-filter').dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    document.querySelector(`[data-select-decision="${nodeId}"]`).click();
    await flush();
  });
  afterEach(async () => {
    try {
      for (const id of ['decision-editor', 'decision-connection-dialog', 'decision-access-dialog', 'decision-sharing-dialog', 'decision-confirm-dialog']) if ($(id).open) $(id).close();
      nodes._collection.remove(nodeId); runs._collection.remove({ nodeId });
      budgets._collection.remove({ uiFixture: nodeId });
      settings._collection.remove({}); settingsBefore.forEach((row) => settings._collection.insert(row));
      $('capability-search').value = originalQuery;
      $('decision-scope-filter').value = 'all'; $('decision-scope-filter').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-view="missions"]').click(); await flush();
    } finally { Meteor.callAsync = originalCall; }
  });

  it('keeps structured instructions and criteria intact when editing unrelated fields', async () => {
    const question = { type: 'choice', instructions: { task: 'Evaluate the claim', evidence: 'Use only `context`' },
      criteria: { supported: { meaning: 'Direct evidence', rule: 'No assumptions' }, unknown: 'Not enough evidence' } };
    await updateNode({ definition: { model: 'jev-latest', questions: { supported: question } } });
    assert.notInclude($('decision-detail').textContent, '[object Object]');
    document.querySelector('[data-decision-edit]').click();
    assert.include($('decision-editor').textContent, 'Question and criteria');
    assert.include(document.querySelector('[data-question-instructions]').value, 'Evaluate the claim');
    const option = document.querySelector('[data-option-label]');
    assert.strictEqual(option.tagName, 'TEXTAREA');
    assert.strictEqual(option.value, 'meaning: Direct evidence\nrule: No assumptions');
    $('decision-name').value = 'Decision UI fixture renamed';
    submit($('decision-editor-form'));
    await waitUntil(() => calls.some((call) => call.name === 'save'), 'the editor did not save');
    assert.deepEqual(calls.find((call) => call.name === 'save').input.input.definition.questions.supported, question);
  });

  it('shows typed inputs and an animated live evaluation state, then a readable probability', async () => {
    await updateNode({ inputFields: [{ key: 'context', label: 'Evidence', type: 'text', required: true }, { key: 'count', label: 'Sources', type: 'number', required: true }, { key: 'verified', label: 'Verified', type: 'boolean', required: true }],
      definition: { model: 'jev-latest', questions: { supported: { type: 'noul', instructions: 'Is the claim supported?' } } } });
    chooseTab('test');
    document.querySelector('[data-state-key="context"]').value = 'One source supports this.';
    document.querySelector('[data-state-key="count"]').value = '1';
    document.querySelector('[data-state-key="verified"]').value = 'false';
    let resolve;
    response = (name) => name === 'evaluate' ? new Promise((accept) => { resolve = accept; }) : Promise.resolve({});
    submit($('decision-test-form'));
    await waitUntil(() => resolve, 'the live test did not start');
    assert.isTrue($('decision-run-test').disabled);
    assert.strictEqual($('decision-run-test').dataset.loading, 'true');
    assert.ok($('decision-test-result').querySelector('.op-loading[role="status"]'));
    assert.include($('decision-content').textContent, 'Input is sent to TypeSafe');
    assert.deepEqual(calls.find((call) => call.name === 'evaluate').input.state, { context: 'One source supports this.', count: 1, verified: false });
    assert.match(calls.find((call) => call.name === 'evaluate').input.requestKey, /^[a-f0-9-]{36}$/, 'a paid request needs a stable replay key');
    resolve({ nodeRevision: 1, status: 'completed', definition: node().definition, answers: { supported: { type: 'noul', noul: .65 } }, model: 'jev-test', usage: { input_tokens: 10, output_tokens: 2 } });
    await waitUntil(() => !$('decision-run-test').disabled, 'the live test did not finish');
    assert.include($('decision-test-result').textContent, '65% probability of yes');
    assert.notInclude($('decision-test-result').textContent, 'NaN');
    assert.notInclude($('decision-test-result').textContent, '"noul"');
  });

  it('saves a typed fixture with a valid ID and the full score range', async () => {
    await updateNode({ definition: { model: 'jev-latest', questions: { quality: { type: 'score', instructions: 'Rate the evidence.', criteria: ['None', 'Partial', 'Direct'] } } } });
    chooseTab('test');
    document.querySelector('[data-state-key="context"]').value = 'The source states the claim directly.';
    const disclosure = document.querySelector('.decision-save-example'); disclosure.open = true;
    $('decision-fixture-name').value = 'Direct evidence';
    document.querySelector('[data-expected-min]').value = '1.5';
    document.querySelector('[data-expected-max]').value = '2';
    assert.strictEqual(document.querySelector('[data-expected-max]').max, '2');
    submit($('decision-fixture-form'));
    await waitUntil(() => calls.some((call) => call.name === 'save'), 'the fixture did not save');
    const fixture = calls.find((call) => call.name === 'save').input.input.fixtures[0];
    assert.match(fixture.id, /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
    assert.deepEqual(fixture.state, { context: 'The source states the claim directly.' });
    assert.deepEqual(fixture.expected, { quality: { min: 1.5, max: 2 } });
    assert.isFalse(calls.some((call) => call.name === 'evaluate'), 'saving a test must not spend tokens');
  });

  it('preserves Yes / no meanings on an unrelated edit', async () => {
    const question = { type: 'noul', instructions: 'Is the claim supported?', criteria: { true: { meaning: 'Direct support' }, false: 'Evidence missing' } };
    await updateNode({ definition: { model: 'jev-latest', questions: { supported: question } } });
    document.querySelector('[data-decision-edit]').click();
    assert.isFalse(document.querySelector('[data-noul-meanings]').hidden);
    $('decision-description').value = 'Changed description'; submit($('decision-editor-form'));
    await waitUntil(() => calls.some((call) => call.name === 'save'), 'the editor did not save');
    assert.deepEqual(calls.find((call) => call.name === 'save').input.input.definition.questions.supported, question);
  });

  it('preserves structured whitespace and original line endings after textarea normalization', async () => {
    const questions = {
      supported: { type: 'choice', instructions: { task: 'Read the evidence.\r\nKeep context.  ' },
        criteria: { supported: { meaning: 'Direct evidence\r\nwith context.  \t' }, unknown: null } },
      verified: { type: 'noul', instructions: { task: 'Check the source.  \r\n' },
        criteria: { true: { meaning: 'Verified source.\r\n  ' }, false: { meaning: 'No verification.  \t' } } },
      quality: { type: 'score', instructions: { task: 'Rate evidence quality.  ' },
        criteria: [{ meaning: 'No evidence.\r\n  ' }, { meaning: 'Direct support.  \t' }] },
    };
    await updateNode({ definition: { model: 'jev-latest', questions } });
    document.querySelector('[data-decision-edit]').click();
    const displayed = document.querySelector('[data-question-instructions]').value;
    assert.include(displayed, '\n', 'the editor must retain the readable line break');
    assert.notInclude(displayed, '\r', 'the browser normalizes textarea line endings');
    assert.isTrue(displayed.endsWith('  '), 'the unchanged control keeps trailing whitespace');
    $('decision-name').value = 'Decision UI fixture renamed'; submit($('decision-editor-form'));
    await waitUntil(() => calls.some((call) => call.name === 'save'), 'the editor did not save');
    assert.deepEqual(calls.find((call) => call.name === 'save').input.input.definition.questions, questions,
      'unrelated edits must preserve structured definitions byte-for-byte, including original whitespace');
  });

  it('keeps agent-authored hyphenated fields and null-meaning options configurable', async () => {
    await updateNode({ inputFields: [{ key: 'source-text', label: 'Source', type: 'text', required: true }], definition: { model: 'jev-latest', questions: { supported: { type: 'choice', instructions: 'Evaluate `source-text`.', criteria: { supported: 'Directly supported', unknown: null } } } } });
    assert.include($('decision-content').textContent, 'unknown', 'implicit options must have a visible label');
    document.querySelector('[data-decision-edit]').click();
    assert.isTrue(document.querySelector('[data-field-key]').checkValidity());
    $('decision-description').value = 'Edited description'; submit($('decision-editor-form'));
    await waitUntil(() => calls.some((call) => call.name === 'save'), 'the editor did not save');
    assert.strictEqual(calls.find((call) => call.name === 'save').input.input.definition.questions.supported.criteria.unknown, null);
    await waitUntil(() => !$('decision-editor').open, 'the editor did not close');
    chooseTab('test');
    assert.strictEqual(document.querySelector('[data-expected-choice] option[value="unknown"]').textContent, 'unknown');
  });

  it('gives each explicit saved-test run a replay key', async () => {
    await updateNode({ fixtures: [{ id: 'source_case', name: 'Direct evidence', state: { context: 'A direct source.' }, expected: { supported: 'supported' } }] });
    chooseTab('test');
    response = async (name) => name === 'testFixtures' ? { nodeId, revision: 1, status: 'passed', passed: 1, total: 1, results: [] } : {};
    $('decision-run-fixtures').click();
    await waitUntil(() => calls.some((call) => call.name === 'testFixtures') && !$('decision-run-fixtures').disabled, 'the fixture run did not finish');
    const first = calls.find((call) => call.name === 'testFixtures').input.requestKey;
    assert.match(first, /^[a-f0-9-]{36}$/);
    $('decision-run-fixtures').click();
    await waitUntil(() => calls.filter((call) => call.name === 'testFixtures').length === 2 && !$('decision-run-fixtures').disabled, 'the second fixture run did not finish');
    assert.notStrictEqual(calls.filter((call) => call.name === 'testFixtures')[1].input.requestKey, first, 'an intentional rerun is a new paid request');
  });

  it('shows the daily workspace test budget without carrying over yesterday’s usage', async () => {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    budgets._collection.insert({ _id: `yesterday_${nodeId}`, uiFixture: nodeId, missionId: null, calls: 199, tokens: 99000, reservedTokens: 0, createdAt: new Date(today.getTime() - 1) });
    budgets._collection.insert({ _id: `today_${nodeId}`, uiFixture: nodeId, missionId: null, calls: 13, tokens: 1200, reservedTokens: 300, createdAt: new Date(today.getTime() + 86_399_999) });
    await flush(); $('decision-connection').click();
    assert.include($('decision-budget-usage').textContent, 'Workspace test budget · today (UTC)');
    assert.include($('decision-budget-usage').textContent, '13 / 20 requests');
    assert.include($('decision-budget-usage').textContent, '1,500 / 100,000 tokens used or reserved');
    assert.notInclude($('decision-budget-usage').textContent, '199');
  });

  it('requires passed tests on the current revision before workspace reuse', async () => {
    await updateNode({ scope: 'mission', missionId: 'ui_fixture_mission', lastTest: { revision: 0, status: 'passed', passed: 1, total: 1 } });
    assert.isTrue($('decision-promote').disabled);
    await updateNode({ lastTest: { revision: 1, status: 'passed', passed: 1, total: 1 } });
    assert.isFalse($('decision-promote').disabled);
    $('decision-promote').click();
    await waitUntil(() => calls.some((call) => call.name === 'promote'), 'workspace approval did not submit');
    assert.deepEqual(calls.find((call) => call.name === 'promote').input, { nodeId, expectedRevision: 1 });
  });

  it('renders exact history safely and refreshes when a running evaluation completes', async () => {
    let run = { _id: 'ui_history_run', nodeId, nodeRevision: 1, purpose: 'test', status: 'running', createdAt: new Date(), definition: node().definition, state: { context: '<img src=x onerror=alert(1)>\nEvidence stays exact.' } };
    response = async (name) => name === 'history' ? [run] : [];
    runs._collection.insert({ _id: run._id, nodeId, status: 'running' }); await flush();
    chooseTab('history');
    await waitUntil(() => document.querySelector('.decision-history-row'), 'history did not load');
    document.querySelector('.decision-history-row').open = true;
    document.querySelector('.decision-history-inputs').open = true;
    assert.include($('decision-content').textContent, 'Evaluating…');
    assert.include($('decision-content').textContent, '<img src=x onerror=alert(1)>');
    assert.isNull($('decision-content').querySelector('img'));
    run = { ...run, status: 'completed', answers: { supported: { type: 'choice', choice: 'supported', confidence: .8 } } };
    runs._collection.update(run._id, { $set: { status: 'completed', completedAt: new Date() } }); await flush();
    await waitUntil(() => $('decision-content').textContent.includes('80% confidence'), 'history did not refresh on completion');
    assert.include($('decision-content').textContent, 'Supported');
    assert.isTrue(document.querySelector('.decision-history-row').open, 'an in-progress update must not collapse the result');
    assert.isTrue(document.querySelector('.decision-history-inputs').open, 'exact input stays open during updates');
  });

  it('keeps removed decisions inspectable without offering active-use controls', async () => {
    await updateNode({ status: 'archived', enabled: false, archivedAt: new Date() });
    $('decision-scope-filter').value = 'archived'; $('decision-scope-filter').dispatchEvent(new Event('change', { bubbles: true })); await flush();
    assert.ok(document.querySelector(`[data-select-decision="${nodeId}"]`));
    assert.isTrue(document.querySelector('.decision-detail-actions').hidden);
    assert.include($('decision-detail').textContent, 'Removed');
    chooseTab('history');
    await waitUntil(() => calls.some((call) => call.name === 'history'), 'removed node history was not accessible');
  });

  it('keeps editor sections spaced and all labels associated with controls', async () => {
    document.querySelector('[data-decision-edit]').click(); await nextFrame();
    const nameLabel = $('decision-name').closest('label');
    const descriptionLabel = $('decision-description').closest('label');
    assert.isAtLeast(descriptionLabel.getBoundingClientRect().top - nameLabel.getBoundingClientRect().bottom, 18);
    const question = document.querySelector('.decision-question-editor');
    assert.isAtLeast(parseFloat(getComputedStyle(question).paddingTop), 13);
    for (const input of $('decision-editor').querySelectorAll('input,select,textarea')) assert.isAtLeast(input.labels.length, 1, `${input.id || input.outerHTML} must have a label`);
    assert.isAtMost($('decision-editor').scrollWidth, $('decision-editor').clientWidth + 1);
  });

  it('navigates detail tabs with the keyboard', async () => {
    const tab = document.querySelector('[data-decision-tab="overview"]'); tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    assert.strictEqual(document.activeElement?.dataset.decisionTab, 'test');
    assert.strictEqual(document.activeElement?.getAttribute('aria-selected'), 'true');
    assert.strictEqual($('decision-content').getAttribute('aria-labelledby'), 'decision-tab-test');
  });

  it('shares with eligible crew without silently granting Use permission', async () => {
    await updateNode({ scope: 'mission', missionId: 'ui_sharing_mission', agentIds: ['first'] });
    response = async (name, input) => name === 'eligibleAgents' ? [
      { agent: 'first', displayName: 'First agent', role: 'Research', policy: { use: true, create: 'disabled' } },
      { agent: 'second', displayName: 'Second agent', role: 'Review', policy: { use: false, create: 'ask' } },
    ] : { ...node(), agentIds: input.agentIds, revision: 2 };
    document.querySelector('[data-decision-share]').click();
    await waitUntil(() => document.querySelectorAll('[data-sharing-agent]').length === 2, 'eligible crew did not load');
    assert.include($('decision-sharing-scope').textContent, 'Sharing does not turn on their Use permission');
    const second = document.querySelector('[data-sharing-agent="second"]');
    assert.include(second.closest('.decision-sharing-agent').textContent, 'Use off');
    second.checked = true; second.dispatchEvent(new Event('change', { bubbles: true }));
    assert.include($('decision-sharing-count').textContent, '1 with Use off');
    submit($('decision-sharing-form'));
    await waitUntil(() => calls.some((call) => call.name === 'setAssignments'), 'sharing did not save');
    assert.deepEqual(calls.find((call) => call.name === 'setAssignments').input, { nodeId, expectedRevision: 1, agentIds: ['first', 'second'] });
    assert.isFalse(calls.some((call) => call.name === 'setAgentPolicy'), 'sharing must not elevate agent permissions');
    assert.isFalse(calls.some((call) => call.name === 'save'), 'sharing must not rewrite the definition');
  });

  it('keeps Use and Create separate and explains paused connection and creation', async () => {
    settings._collection.update('ui_fixture_settings', { $set: { enabled: false } }); await flush();
    $('decision-agent-access').click();
    assert.ok($('decision-access-agent').value, 'the local crew supplies an agent to configure');
    assert.include($('decision-access-connection').textContent, 'Evaluations paused');
    $('decision-access-use').checked = false;
    $('decision-access-create').value = 'auto'; $('decision-access-create').dispatchEvent(new Event('change', { bubbles: true }));
    assert.include($('decision-access-create-hint').textContent, 'Creation is paused while Use is off');
    assert.strictEqual($('decision-access-save-state').textContent, 'Unsaved changes');
    submit($('decision-access-form'));
    await waitUntil(() => calls.some((call) => call.name === 'setAgentPolicy'), 'permissions did not save');
    assert.deepEqual(calls.find((call) => call.name === 'setAgentPolicy').input.policy, { use: false, create: 'auto' });
    assert.isFalse(calls.some((call) => call.name === 'saveSettings'), 'saving permissions must not enable the provider');
  });

  it('reports approved-but-not-resumed honestly and follows later continuation status', async () => {
    await updateNode({ status: 'pending', scope: 'mission', missionId: 'ui_review_mission', createdBy: { kind: 'agent', agent: 'researcher', sessionId: 'ui_requesting_work' } });
    let resolveReview;
    response = (name) => name === 'review' ? new Promise((resolve) => { resolveReview = resolve; }) : Promise.resolve([]);
    const approve = document.querySelector('[data-decision-review="true"]');
    assert.strictEqual(approve.textContent, 'Approve & continue'); approve.click();
    await waitUntil(() => resolveReview, 'review did not start');
    assert.ok(document.querySelector('.decision-continuation-spinner'));
    assert.isNull(document.querySelector('[data-decision-review]'), 'another review cannot race the pending request');
    resolveReview({ ...node(), status: 'active', continuation: { status: 'manual', agent: 'researcher', sessionId: 'ui_requesting_work', reason: 'This mission is stopped.' } });
    await waitUntil(() => document.querySelector('[data-continuation-state="manual"]'), 'the continuation outcome did not render');
    assert.include(document.querySelector('.decision-continuation').textContent, 'not resumed');
    assert.include(document.querySelector('.decision-continuation').textContent, 'This mission is stopped.');
    assert.ok(document.querySelector('[data-decision-continuation-work]'), 'the requesting work stays accessible');
    await updateNode({ status: 'active', continuation: { status: 'completed', agent: 'researcher', sessionId: 'ui_requesting_work' } });
    assert.include(document.querySelector('.decision-continuation').textContent, 'finished');
    assert.notInclude(document.querySelector('.decision-continuation').textContent, 'not resumed', 'published progress must replace an earlier method receipt');
  });

  it('reveals Atlas’s exact continuation from the chat card and detail view without clearing a note draft', async () => {
    const chat = $('mission-chat');
    const sessionId = chat.sessionId;
    const client = chat.agentInstance;
    assert.ok(sessionId); assert.ok(client);
    const originalMessages = client.messages;
    const originalReveal = chat.revealMessage;
    const draft = chat.draftText;
    const mode = chat.composerMode;
    const key = `decision-approved:${nodeId}:2`;
    const revealed = [];
    client.messages = () => ({ fetch: () => [
      { _id: `sys:${sessionId}:${key}`, sessionId, role: 'system', seq: 2 },
      { _id: 'exact-decision-result', sessionId, role: 'assistant', seq: 3, content: 'Billing', from: { participant: 'm:orchestrator' } },
    ] });
    chat.revealMessage = (id) => { revealed.push(id); return true; };
    try {
      chat.composerMode = 'note';
      chat.setDraft('Unfinished crew note');
      await updateNode({ scope: 'mission', missionId: sessionId, status: 'active',
        createdBy: { kind: 'agent', agent: 'orchestrator', sessionId },
        continuation: { key, sessionId, missionId: sessionId, agent: 'orchestrator', status: 'completed' } });
      document.querySelector('[data-view="missions"]').click();
      const card = chat.querySelector(`[data-decision-node="${nodeId}"]`);
      assert.ok(card, 'the decision must appear in the actual mission transcript');
      card.querySelector('[data-decision-chat-work]').click();
      await waitUntil(() => revealed.length === 1, 'the chat-card link did not reveal the continuation');
      assert.equal(revealed[0], 'exact-decision-result');
      assert.equal(chat.draftText, 'Unfinished crew note');
      assert.equal(chat.composerMode, 'note');
      document.querySelector('[data-view="capabilities"]').click();
      document.querySelector('[data-decision-continuation-work]').click();
      await waitUntil(() => revealed.length === 2, 'the decision-detail link did not reveal the continuation');
      assert.isTrue($('view-missions').classList.contains('active'));
      assert.equal(revealed[1], 'exact-decision-result');
      assert.equal(chat.draftText, 'Unfinished crew note');
      assert.equal(chat.composerMode, 'note');
      assert.isFalse(calls.some(({ name }) => ['review', 'evaluate', 'save'].includes(name)), 'viewing work must not rerun it');
    } finally {
      client.messages = originalMessages;
      chat.revealMessage = originalReveal;
      chat.composerMode = mode;
      chat.setDraft(draft);
    }
  });

  it('keeps a failed review actionable without claiming approval', async () => {
    await updateNode({ status: 'pending', createdBy: { kind: 'agent', agent: 'researcher', sessionId: 'ui_requesting_work' } });
    response = async (name) => { if (name === 'review') throw new Error('The decision changed. Review its latest revision.'); return []; };
    document.querySelector('[data-decision-review="true"]').click();
    await waitUntil(() => document.querySelector('[data-continuation-state="review-error"]'), 'the failed review was not shown');
    assert.include(document.querySelector('.decision-continuation').textContent, 'Review not saved');
    assert.ok(document.querySelector('[data-decision-review="true"]'), 'a failed review can be tried again');
    assert.notInclude(document.querySelector('.decision-continuation').textContent, 'Approved');
  });

  it('shows persisted preparing and resumed continuations as work in progress', async () => {
    await updateNode({ status: 'active', continuation: { status: 'preparing', agent: 'researcher', sessionId: 'ui_requesting_work' } });
    assert.include(document.querySelector('.decision-continuation').textContent, 'Preparing continuation…');
    assert.ok(document.querySelector('.decision-continuation-spinner'));
    assert.notInclude(document.querySelector('.decision-continuation').textContent, 'not resumed');
    await updateNode({ continuation: { status: 'resumed', agent: 'researcher', sessionId: 'ui_requesting_work' } });
    assert.include(document.querySelector('.decision-continuation').textContent, 'continuing');
    assert.ok(document.querySelector('.decision-continuation-spinner'));
    assert.notInclude(document.querySelector('.decision-continuation').textContent, 'finished');
  });

  it('audits crew sharing changes with the saved assignment list', async () => {
    response = async (name) => name === 'versions' ? [{ _id: 'ui_share_version', revision: 2, action: 'assignments-changed', actor: { kind: 'human' }, createdAt: new Date(), snapshot: { ...node(), agentIds: ['specific_reviewer'] } }] : [];
    chooseTab('history');
    await waitUntil(() => document.querySelector('.decision-sharing-history'), 'sharing history did not render');
    assert.include($('decision-content').textContent, 'Crew sharing changed');
    assert.include(document.querySelector('.decision-sharing-history').textContent, 'specific_reviewer');
    assert.notInclude($('decision-content').textContent, 'assignments-changed');
  });
});
