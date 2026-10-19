import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { escapeHtml as esc, element as $, dateLabel, stateBadge, createDialog, showDialog, busyAction, wireTabs } from './operations';
import { setChatTimelineSource } from './chat-timeline';

const questionTypes = { choice: 'Choose an option', noul: 'Yes or no', score: 'Rate on a scale' };
const percent = (value) => `${Math.round(Number(value) * 100)}%`;
const defaultFields = () => [{ key: 'context', label: 'Context', type: 'text', required: true }];
const fieldsFor = (node) => node?.inputFields?.length ? node.inputFields : defaultFields();
const safeKey = (value) => String(value).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
const clone = (value) => JSON.parse(JSON.stringify(value));
const loading = (label) => `<div class="op-loading" role="status"><span></span>${esc(label)}</div>`;
const notice = 'Input is sent to TypeSafe for evaluation. Live tests use your TypeSafe account.';
const instructionText = (value) => typeof value === 'string' ? value : value == null ? '' : Array.isArray(value) ? value.map(instructionText).join('\n') : Object.entries(value).map(([key, child]) => `${key}: ${instructionText(child)}`).join('\n');

/** Human-readable inspection preserves every value without exposing raw JSON. */
export function decisionValueMarkup(value) {
  if (value === null || value === undefined) return '<span class="op-muted">Not provided</span>';
  if (Array.isArray(value)) return `<ol class="decision-value-list">${value.map((item) => `<li>${decisionValueMarkup(item)}</li>`).join('')}</ol>`;
  if (typeof value === 'object') return `<dl class="decision-values">${Object.entries(value).map(([key, item]) => `<div><dt>${esc(key)}</dt><dd>${decisionValueMarkup(item)}</dd></div>`).join('')}</dl>`;
  return `<span class="decision-text-value">${esc(typeof value === 'boolean' ? value ? 'Yes' : 'No' : value)}</span>`;
}

export function decisionAnswerMarkup(question, answer) {
  if (answer == null) return '<span class="op-muted">No result</span>';
  const value = typeof answer === 'object' ? answer.value ?? answer.answer ?? answer.choice ?? answer.score ?? answer.noul ?? answer.probability : answer;
  if (question?.type === 'noul') return `<strong>${esc(percent(value))} probability of yes</strong>`;
  if (question?.type === 'score') return `<strong>${esc(typeof value === 'number' ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : value)} / ${Math.max(1, (question.criteria?.length ?? 2) - 1)}</strong>${answer.confidence == null ? '' : `<span class="op-muted">${esc(percent(answer.confidence))} confidence</span>`}`;
  const label = question?.criteria?.[value] ?? value;
  return `<strong>${esc(instructionText(label))}</strong>${answer.confidence == null ? '' : `<span class="op-muted">${esc(percent(answer.confidence))} confidence</span>`}`;
}

export function initializeDecisions(host) {
  const Nodes = host.nodes ?? Mongo.getCollection?.('constellation_decision_nodes') ?? new Mongo.Collection('constellation_decision_nodes');
  const Settings = host.settings ?? Mongo.getCollection?.('constellation_decision_settings') ?? new Mongo.Collection('constellation_decision_settings');
  const Runs = host.runs ?? Mongo.getCollection?.('constellation_decision_runs') ?? new Mongo.Collection('constellation_decision_runs');
  const Budgets = host.budgets ?? Mongo.getCollection?.('constellation_decision_budgets') ?? new Mongo.Collection('constellation_decision_budgets');
  const subscription = host.subscribe === false ? { ready: () => true, stop() {} } : Meteor.subscribe('constellation.decisions', {
    onError(error) { host.toast(error.reason || 'Could not load decisions.', 'error'); },
  });
  let selectedId = null;
  let selectedTab = 'overview';
  let editing = null;
  let fixtureSource = [];
  let signature = '';
  let detailSignature = '';
  let historyGeneration = 0;
  let runPending = false;
  let disposed = false;
  let sharingNode = null;
  let sharingAgents = [];
  let sharingSelection = new Set();
  let sharingGeneration = 0;
  let sharingLoading = false;
  const reviewFeedback = new Map();
  const reviewing = new Set();
  const historyOpen = new Set();
  const currentMission = () => host.currentMission?.() ?? host.mission?.();
  const settings = () => Settings.findOne() ?? {};
  const crew = () => host.crew?.() ?? [];
  const selected = () => Nodes.findOne(selectedId);
  const method = (name, args = {}) => Meteor.callAsync(`constellation.decisions.${name}`, args);
  const available = () => settings().enabled === true && settings().providerConfigured === true;
  const agentLabel = (id) => crew().find((row) => (row.agent ?? row._id) === id)?.displayName ?? id;
  const scopeLabel = (row) => row.scope === 'workspace' ? 'Workspace' : host.missions?.().find((mission) => mission._id === row.missionId)?.title ?? 'Mission only';

  const editor = createDialog('decision-editor', 'New decision', `<form id="decision-editor-form"><div class="op-scroll decision-form-stack">
    <label>Name<input id="decision-name" required maxlength="120" placeholder="e.g. Check source support"></label>
    <label>When to use it<textarea id="decision-description" rows="2" maxlength="1000" placeholder="Use before publishing a claim that needs evidence."></textarea></label>
    <div class="op-form-row"><label>Available in<select id="decision-scope"><option value="mission">One mission</option><option value="workspace">Workspace</option></select></label><label id="decision-mission-label">Mission<select id="decision-mission"></select></label></div>
    <fieldset class="decision-fieldset"><legend>Input fields</legend><p class="op-hint">Name the information the decision needs. Refer to a field as <code>\`context\`</code> in a question.</p><div id="decision-field-rows"></div><button class="secondary-action" id="decision-add-field" type="button">+ Input field</button></fieldset>
    <fieldset class="decision-fieldset"><legend>Questions</legend><div id="decision-question-rows"></div><button class="secondary-action" id="decision-add-question" type="button">+ Question</button></fieldset>
    <fieldset class="decision-fieldset"><legend>Sharing</legend><p id="decision-editor-sharing" class="op-hint"></p></fieldset>
    <label class="op-check"><input id="decision-enabled" type="checkbox" checked>Enabled</label>
    <div id="decision-editor-errors"></div></div><footer class="op-footer"><span id="decision-editor-version"></span><button type="button" class="secondary-action" id="decision-editor-cancel">Cancel</button><button type="submit" class="primary-action">Save decision</button></footer></form>`, 'decision-dialog');
  const connection = createDialog('decision-connection-dialog', 'Jev connection', `<form id="decision-connection-form"><div class="op-scroll decision-form-stack">
    <div id="decision-connection-state"></div><div id="decision-budget-usage"></div><label class="op-check op-prominent-check"><input id="decision-provider-enabled" type="checkbox">Allow TypeSafe evaluations</label>
    <label>TypeSafe API key<input id="decision-api-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="Leave blank to keep the current key"></label>
    <p class="op-hint" id="decision-key-source"></p><p class="decision-privacy-note">${notice} Keys stay on this computer’s server and are never given to agents.</p>
    <fieldset class="decision-fieldset"><legend>Mission limits</legend><div class="op-form-row"><label>Evaluations<input id="decision-limit-calls" type="number" min="1" max="200" required></label><label>Total tokens<input id="decision-limit-tokens" type="number" min="1000" max="2000000" step="1000" required></label></div><label>Input characters per evaluation<input id="decision-limit-input" type="number" min="256" max="32000" required></label></fieldset>
    <div id="decision-connection-errors"></div></div><footer class="op-footer"><button class="op-link" type="button" id="decision-clear-key">Remove saved key</button><button class="primary-action" type="submit">Save connection</button></footer></form>`);
  const access = createDialog('decision-access-dialog', 'Decision access', `<form id="decision-access-form"><div class="op-scroll decision-form-stack"><label>Agent<select id="decision-access-agent"></select></label><div id="decision-access-connection"></div><fieldset class="decision-permission-group"><legend>Use</legend><label class="op-check decision-permission-check"><input id="decision-access-use" type="checkbox" aria-describedby="decision-access-use-hint"><span><strong>Use shared decisions</strong><small id="decision-access-use-hint">Evaluate decisions shared with this agent. Inputs go to TypeSafe.</small></span></label></fieldset><fieldset class="decision-permission-group"><legend>Create</legend><label>New decisions during a mission<select id="decision-access-create" aria-describedby="decision-access-create-hint"><option value="disabled">Not allowed</option><option value="ask">Ask for approval</option><option value="auto">Allow automatically</option></select></label><p id="decision-access-create-hint" class="op-hint"></p></fieldset><p class="decision-privacy-note">These permissions apply across the workspace. New decisions stay in their mission; sharing and workspace reuse need a person’s approval. Existing action approvals remain in place.</p><div id="decision-access-errors"></div></div><footer class="op-footer"><span id="decision-access-save-state" role="status"></span><button class="primary-action" type="submit">Save permissions</button></footer></form>`);
  const sharing = createDialog('decision-sharing-dialog', 'Share with crew', `<form id="decision-sharing-form"><div class="op-scroll decision-form-stack"><div id="decision-sharing-connection"></div><p class="op-hint" id="decision-sharing-scope"></p><div id="decision-sharing-agents" class="decision-sharing-agents" aria-live="polite"></div><div id="decision-sharing-unavailable"></div><div id="decision-sharing-errors"></div></div><footer class="op-footer"><span id="decision-sharing-count" role="status"></span><button class="secondary-action" type="button" id="decision-sharing-cancel">Cancel</button><button class="primary-action" id="decision-sharing-submit" type="submit" disabled>Save sharing</button></footer></form>`);
  const confirm = createDialog('decision-confirm-dialog', 'Remove decision', `<div class="op-scroll"><p id="decision-confirm-copy"></p><div id="decision-confirm-errors"></div></div><footer class="op-footer"><button class="secondary-action" id="decision-confirm-cancel" type="button">Cancel</button><button class="danger-button" id="decision-confirm-submit" type="button">Remove decision</button></footer>`);
  let confirmAction = null;

  function inputRow(field = { key: '', label: '', type: 'text', required: true }) {
    const row = document.createElement('div');
    row.className = 'decision-input-row';
    row.innerHTML = `<label>Field name<input data-field-key required maxlength="64" pattern="[a-zA-Z][a-zA-Z0-9_-]*" placeholder="context" value="${esc(field.key)}"></label><label>Label<input data-field-label maxlength="120" placeholder="Context" value="${esc(field.label)}"></label><label>Type<select data-field-type><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes / no</option></select></label><label class="op-check"><input type="checkbox" data-field-required ${field.required ? 'checked' : ''}>Required</label><button type="button" class="decision-remove" aria-label="Remove input field">×</button>`;
    row.querySelector('[data-field-type]').value = field.type;
    row.querySelector('button').addEventListener('click', () => row.remove());
    $('decision-field-rows').append(row);
    return row;
  }

  function questionRow(id = '', question = { type: 'choice', instructions: '', criteria: { supported: 'Supported by the evidence', unsupported: 'Not supported', insufficient: 'Not enough information' } }) {
    const row = document.createElement('section');
    row.className = 'decision-question-editor';
    row.innerHTML = `<div class="decision-question-heading"><label>Question name<input data-question-id value="${esc(id)}" required maxlength="64" pattern="[a-zA-Z][a-zA-Z0-9_-]*" placeholder="source_support"></label><button class="decision-remove" type="button" aria-label="Remove question">×</button></div><label>Answer type<select data-question-type>${Object.entries(questionTypes).map(([key, value]) => `<option value="${key}">${value}</option>`).join('')}</select></label><label>Question and criteria<textarea data-question-instructions rows="3" required maxlength="8000" placeholder="Does the evidence in \`context\` support the claim? Choose insufficient if evidence is missing.">${esc(instructionText(question.instructions))}</textarea></label><div data-question-options><p class="op-hint" data-options-hint></p><div data-option-rows></div><button data-option-add class="secondary-action" type="button">+ Option</button></div><div data-noul-meanings class="op-form-row"><label>Yes means (optional)<textarea data-meaning-yes rows="2" maxlength="8000">${esc(instructionText(question.type === 'noul' ? question.criteria?.true : ''))}</textarea></label><label>No means (optional)<textarea data-meaning-no rows="2" maxlength="8000">${esc(instructionText(question.type === 'noul' ? question.criteria?.false : ''))}</textarea></label></div>`;
    row._originalQuestion = clone(question);
    // Compare with the initialized controls, not a re-created string: textareas
    // normalize line endings, while surrounding whitespace remains meaningful
    // inside an otherwise unchanged structured definition.
    row._originalInstructionDisplay = row.querySelector('[data-question-instructions]').value;
    row._originalMeaningDisplay = {
      true: row.querySelector('[data-meaning-yes]').value,
      false: row.querySelector('[data-meaning-no]').value,
    };
    const typeSelect = row.querySelector('[data-question-type]');
    typeSelect.value = question.type;
    row.querySelector('.decision-remove').addEventListener('click', () => row.remove());
    const addOption = (value = '', key = '') => {
      const option = document.createElement('div'); option.className = 'decision-option-row';
      option._originalDisplay = value == null ? key : instructionText(value);
      // A single-line input silently removes newlines from structured criteria.
      // Keep its readable multiline form intact so an unrelated edit cannot
      // replace the original criteria object with flattened text.
      option.innerHTML = `<span class="decision-option-index" aria-hidden="true"></span><label><span class="op-sr-only">Option label</span><textarea data-option-label rows="${option._originalDisplay.includes('\n') ? 3 : 1}" required maxlength="8000" placeholder="Describe this outcome">${esc(option._originalDisplay)}</textarea></label><label class="decision-option-key"><span class="op-sr-only">Option ID</span><input data-option-key maxlength="64" placeholder="ID" value="${esc(key)}"></label><button type="button" class="decision-remove" aria-label="Remove option">×</button>`;
      option._originalValue = value;
      option._originalDisplay = option.querySelector('[data-option-label]').value;
      option.querySelector('button').addEventListener('click', () => { option.remove(); updateType(); });
      row.querySelector('[data-option-rows]').append(option); updateType(); return option;
    };
    const updateType = () => {
      const type = typeSelect.value;
      row.querySelector('[data-question-options]').hidden = type === 'noul';
      row.querySelector('[data-noul-meanings]').hidden = type !== 'noul';
      row.querySelector('[data-options-hint]').textContent = type === 'score' ? 'Order 2–10 concrete levels from lowest to highest. Level scores start at 0.' : 'Include an option for missing evidence or no suitable match.';
      row.querySelector('[data-option-add]').textContent = type === 'score' ? '+ Level' : '+ Option';
      [...row.querySelectorAll('.decision-option-row')].forEach((option, index) => {
        option.querySelector('.decision-option-index').textContent = String(type === 'score' ? index : index + 1);
        option.querySelector('.decision-option-key').hidden = type !== 'choice';
        option.querySelector('[data-option-label]').required = type !== 'noul';
      });
    };
    typeSelect.addEventListener('change', updateType);
    row.querySelector('[data-option-add]').addEventListener('click', () => addOption().querySelector('[data-option-label]').focus());
    if (question.type !== 'noul') {
      if (Array.isArray(question.criteria)) question.criteria.forEach((value) => addOption(value));
      else Object.entries(question.criteria ?? {}).forEach(([key, value]) => addOption(value, key));
    }
    updateType(); $('decision-question-rows').append(row); return row;
  }

  function editorInput() {
    const questions = {};
    for (const row of $('decision-question-rows').children) {
      const id = row.querySelector('[data-question-id]').value.trim();
      if (Object.hasOwn(questions, id)) throw new Error('Give each question a different name.');
      const type = row.querySelector('[data-question-type]').value;
      const enteredInstructions = row.querySelector('[data-question-instructions]').value;
      const question = { type, instructions: enteredInstructions === row._originalInstructionDisplay ? row._originalQuestion.instructions : enteredInstructions.trim() };
      if (type === 'noul') {
        const meanings = {};
        for (const [key, suffix] of [['true', 'yes'], ['false', 'no']]) {
          const value = row.querySelector(`[data-meaning-${suffix}]`).value;
          if (value.trim()) meanings[key] = value === row._originalMeaningDisplay[key] ? row._originalQuestion.criteria[key] : value.trim();
        }
        if (Object.keys(meanings).length) question.criteria = meanings;
      }
      if (type !== 'noul') {
        const options = [...row.querySelectorAll('.decision-option-row')];
        if (options.length < 2) throw new Error('Add at least two options or levels.');
        if (type === 'score' && options.length > 10) throw new Error('Use no more than 10 scale levels.');
        if (type === 'choice') {
          question.criteria = {};
          options.forEach((option, index) => {
            const label = option.querySelector('[data-option-label]').value;
            const key = option.querySelector('[data-option-key]').value.trim() || safeKey(label) || `option_${index + 1}`;
            if (Object.hasOwn(question.criteria, key)) throw new Error('Give each option a different ID.');
            question.criteria[key] = label === option._originalDisplay ? option._originalValue : label.trim();
          });
        } else question.criteria = options.map((option) => { const label = option.querySelector('[data-option-label]').value; return label === option._originalDisplay ? option._originalValue : label.trim(); });
      }
      questions[id] = question;
    }
    if (!Object.keys(questions).length) throw new Error('Add at least one question.');
    const inputFields = [...$('decision-field-rows').children].map((row) => ({ key: row.querySelector('[data-field-key]').value.trim(), label: row.querySelector('[data-field-label]').value.trim() || row.querySelector('[data-field-key]').value.trim(), type: row.querySelector('[data-field-type]').value, required: row.querySelector('[data-field-required]').checked }));
    if (new Set(inputFields.map((field) => field.key)).size !== inputFields.length) throw new Error('Give each input field a different name.');
    return { name: $('decision-name').value.trim(), description: $('decision-description').value.trim(), scope: $('decision-scope').value,
      ...($('decision-scope').value === 'mission' ? { missionId: $('decision-mission').value } : {}), enabled: $('decision-enabled').checked,
      agentIds: editing?.agentIds ?? [],
      inputFields, definition: { model: editing?.definition?.model ?? 'jev-latest', questions }, fixtures: fixtureSource };
  }

  function openEditor(row = null) {
    editing = row ? clone(row) : null;
    fixtureSource = clone(row?.fixtures ?? []);
    $('decision-editor-title').textContent = row ? 'Edit decision' : 'New decision';
    $('decision-name').value = row?.name ?? '';
    $('decision-description').value = row?.description ?? '';
    const missions = host.missions?.() ?? [];
    $('decision-mission').innerHTML = missions.map((mission) => `<option value="${esc(mission._id)}">${esc(mission.title || 'Untitled mission')}</option>`).join('');
    $('decision-mission').value = row?.missionId ?? currentMission() ?? missions[0]?._id ?? '';
    $('decision-scope').value = row?.scope ?? (missions.length ? 'mission' : 'workspace');
    $('decision-scope').disabled = !!row;
    $('decision-mission').disabled = !!row;
    $('decision-scope').querySelector('[value="mission"]').disabled = !missions.length;
    updateEditorScope();
    $('decision-enabled').checked = row?.enabled ?? true;
    $('decision-field-rows').replaceChildren(); fieldsFor(row).forEach(inputRow);
    $('decision-question-rows').replaceChildren();
    if (row) Object.entries(row.definition?.questions ?? {}).forEach(([id, question]) => questionRow(id, question));
    else questionRow('judgment');
    $('decision-editor-sharing').textContent = row?.agentIds?.length ? `Shared with ${row.agentIds.map(agentLabel).join(', ')}. Use “Share with crew” to change access after saving.` : 'Manual use only. Save this decision, then use “Share with crew” to give agents access.';
    $('decision-editor-version').textContent = row ? `Editing revision ${row.revision}. Saving requires new tests.` : 'Not saved';
    $('decision-editor-errors').replaceChildren(); showDialog(editor); $('decision-name').focus();
  }
  function updateEditorScope() {
    $('decision-mission-label').hidden = $('decision-scope').value !== 'mission';
    $('decision-mission').required = $('decision-scope').value === 'mission';
  }
  $('decision-scope').addEventListener('change', updateEditorScope);
  $('decision-add-field').addEventListener('click', () => inputRow().querySelector('input').focus());
  $('decision-add-question').addEventListener('click', () => questionRow(`question_${$('decision-question-rows').children.length + 1}`).querySelector('input').focus());
  $('decision-new').addEventListener('click', () => openEditor());
  $('decision-editor-cancel').addEventListener('click', () => editor.close());
  $('decision-editor-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(event.submitter, $('decision-editor-errors'), 'Saving…', async () => {
      const result = await method('save', { ...(editing ? { nodeId: editing._id, expectedRevision: editing.revision } : {}), input: editorInput() });
      selectedId = result.nodeId ?? result._id; selectedTab = 'overview'; editor.close(); detailSignature = ''; render(); host.toast('Decision saved.');
    });
  });

  function openConnection() {
    const config = settings();
    $('decision-provider-enabled').checked = config.enabled === true;
    $('decision-api-key').value = '';
    $('decision-connection-state').innerHTML = stateBadge(config.providerConfigured ? 'Key available' : 'Not connected');
    $('decision-api-key').disabled = config.canStoreSecret === false;
    $('decision-api-key').placeholder = config.providerConfigured ? 'Leave blank to keep the current key' : 'Enter your TypeSafe API key';
    $('decision-key-source').textContent = config.canStoreSecret === false ? 'To save a key securely, open the Electron desktop app. You can also launch with TYPESAFE_API_KEY in your shell.' : config.providerConfigured ? config.keySource === 'shell' ? 'Using TYPESAFE_API_KEY from the server environment.' : 'A saved API key is available. Leave the field blank to keep it.' : 'Add a TypeSafe API key to run decisions.';
    $('decision-limit-calls').value = config.limits?.callsPerMission ?? 20;
    $('decision-limit-tokens').value = config.limits?.tokensPerMission ?? 100000;
    $('decision-limit-input').value = config.limits?.maxInputChars ?? 12000;
    $('decision-clear-key').hidden = !config.providerConfigured || config.keySource === 'shell';
    $('decision-connection-errors').replaceChildren(); showDialog(connection);
    renderBudget();
  }
  function renderBudget() {
    const missionId = currentMission();
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const pools = [
      ...(missionId ? [{ label: 'Current mission budget', usage: Budgets.findOne({ missionId }, { sort: { createdAt: -1 } }) }] : []),
      { label: 'Workspace test budget · today (UTC)', usage: Budgets.findOne({ missionId: null, createdAt: { $gte: today, $lt: tomorrow } }, { sort: { createdAt: -1 } }) },
    ];
    const limits = settings().limits ?? { callsPerMission: 20, tokensPerMission: 100000 };
    $('decision-budget-usage').innerHTML = pools.map(({ label, usage }) => `<div class="decision-budget-usage"><strong>${label}</strong><span>${Number(usage?.calls ?? 0)} / ${Number(limits.callsPerMission)} requests</span><span>${Number((usage?.tokens ?? 0) + (usage?.reservedTokens ?? 0)).toLocaleString()} / ${Number(limits.tokensPerMission).toLocaleString()} tokens used or reserved</span></div>`).join('') + '<p class="op-hint">Includes pending requests and unconfirmed usage. Retries use another request. Workspace tests share a daily budget.</p>';
  }
  $('decision-connection').addEventListener('click', openConnection);
  connection.addEventListener('close', () => { $('decision-api-key').value = ''; });
  $('decision-connection-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(event.submitter, $('decision-connection-errors'), 'Saving…', async () => {
      const apiKey = $('decision-api-key').value.trim();
      await method('saveSettings', { enabled: $('decision-provider-enabled').checked, ...(apiKey ? { apiKey } : {}), limits: { callsPerMission: Number($('decision-limit-calls').value), tokensPerMission: Number($('decision-limit-tokens').value), maxInputChars: Number($('decision-limit-input').value) } });
      $('decision-api-key').value = ''; connection.close(); host.toast('Jev connection saved.');
    });
  });
  $('decision-clear-key').addEventListener('click', (event) => void busyAction(event.currentTarget, $('decision-connection-errors'), 'Removing…', async () => {
    await method('saveSettings', { enabled: false, clearApiKey: true }); connection.close(); host.toast('Saved TypeSafe key removed.');
  }));
  function connectionReadinessMarkup() {
    const config = settings();
    if (config.providerConfigured && config.enabled) return '<div class="decision-readiness" data-ready="true"><span class="decision-readiness-dot" aria-hidden="true"></span><span><strong>Jev configured</strong><small>Live evaluations use your TypeSafe account.</small></span></div>';
    return `<div class="decision-readiness" data-ready="false"><span class="decision-readiness-dot" aria-hidden="true"></span><span><strong>${config.providerConfigured ? 'Evaluations paused' : 'TypeSafe key needed'}</strong><small>${config.providerConfigured ? 'Enable evaluations before agents can use decisions.' : 'Connect Jev before agents can use decisions.'}</small></span><button type="button" class="op-link" data-decision-connect>${config.providerConfigured ? 'Enable evaluations' : 'Connect Jev'}</button></div>`;
  }
  function renderReadiness(mount) {
    const markup = connectionReadinessMarkup();
    if (mount._readinessMarkup === markup) return;
    mount._readinessMarkup = markup; mount.innerHTML = markup;
    mount.querySelector('[data-decision-connect]')?.addEventListener('click', openConnection);
  }
  function updateAccessHints() {
    const agent = $('decision-access-agent').value;
    const use = $('decision-access-use').checked;
    const create = $('decision-access-create').value;
    const policy = settings().agentPolicies?.[agent] ?? { use: false, create: 'disabled' };
    const label = create === 'auto' ? 'The agent can create and use new mission decisions without asking first.' : create === 'ask' ? 'Approve a new decision before the agent can use it. Approval queues the requesting agent to continue when its conversation is ready.' : 'The agent can only use decisions already shared with it.';
    $('decision-access-create-hint').textContent = !use ? create !== 'disabled' ? `Creation is paused while Use is off. ${label}` : 'This agent cannot use or create decisions.' : label;
    $('decision-access-save-state').textContent = !agent ? 'Add an agent first.' : use !== (policy.use === true) || create !== (policy.create ?? 'disabled') ? 'Unsaved changes' : `Use ${use ? 'on' : 'off'} · Create ${create === 'auto' ? 'automatically' : create === 'ask' ? 'with approval' : 'off'}`;
    const save = $('decision-access-form').querySelector('[type="submit"]');
    if (save.dataset.loading !== 'true') save.disabled = !agent;
    renderReadiness($('decision-access-connection'));
  }
  function loadAgentPolicy() {
    const policy = settings().agentPolicies?.[$('decision-access-agent').value] ?? {};
    $('decision-access-use').checked = policy.use === true;
    $('decision-access-create').value = policy.create ?? 'disabled';
    updateAccessHints();
  }
  function openAgentPolicy(agentId) {
    $('decision-access-agent').innerHTML = crew().map((row) => `<option value="${esc(row.agent ?? row._id)}">${esc(row.displayName ?? row.agent)}</option>`).join('');
    if (agentId) $('decision-access-agent').value = agentId;
    loadAgentPolicy(); $('decision-access-errors').replaceChildren(); showDialog(access);
  }
  $('decision-agent-access').addEventListener('click', () => openAgentPolicy());
  $('decision-access-agent').addEventListener('change', loadAgentPolicy);
  $('decision-access-use').addEventListener('change', updateAccessHints);
  $('decision-access-create').addEventListener('change', updateAccessHints);
  $('decision-access-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(event.submitter, $('decision-access-errors'), 'Saving…', async () => {
      if (!$('decision-access-agent').value) throw new Error('Add an agent to the workspace first.');
      await method('setAgentPolicy', { agent: $('decision-access-agent').value, policy: { use: $('decision-access-use').checked, create: $('decision-access-create').value } });
      access.close(); host.toast('Agent decision permissions saved.');
      if (sharing.open) await loadSharing(false);
    });
  });
  function updateSharingCount() {
    const count = sharingSelection.size;
    const off = sharingAgents.filter((row) => sharingSelection.has(row.agent) && !row.policy?.use).length;
    $('decision-sharing-count').textContent = `${count} agent${count === 1 ? '' : 's'} selected${off ? ` · ${off} with Use off` : ''}`;
  }
  function renderSharingAgents() {
    const focusAgent = document.activeElement?.dataset.sharingConfigure;
    $('decision-sharing-agents').innerHTML = sharingAgents.length ? sharingAgents.map((row) => `<div class="decision-sharing-agent"><label class="op-check"><input type="checkbox" data-sharing-agent="${esc(row.agent)}" ${sharingSelection.has(row.agent) ? 'checked' : ''}><span><strong>${esc(row.displayName || agentLabel(row.agent))}</strong><small>${esc(row.role || 'Agent')}</small></span></label><span class="decision-use-state" data-enabled="${row.policy?.use === true}">Use ${row.policy?.use ? 'on' : 'off'}</span><button type="button" class="op-link" data-sharing-configure="${esc(row.agent)}">Permissions</button></div>`).join('') : '<div class="op-empty"><strong>No eligible agents</strong><p>Add an enabled agent to this mission’s crew before sharing.</p></div>';
    $('decision-sharing-agents').querySelectorAll('[data-sharing-agent]').forEach((input) => input.addEventListener('change', () => { if (input.checked) sharingSelection.add(input.dataset.sharingAgent); else sharingSelection.delete(input.dataset.sharingAgent); updateSharingCount(); }));
    $('decision-sharing-agents').querySelectorAll('[data-sharing-configure]').forEach((button) => button.addEventListener('click', () => openAgentPolicy(button.dataset.sharingConfigure)));
    if (focusAgent) [...$('decision-sharing-agents').querySelectorAll('[data-sharing-configure]')].find((button) => button.dataset.sharingConfigure === focusAgent)?.focus({ preventScroll: true });
    updateSharingCount();
  }
  async function loadSharing(reset = true) {
    const generation = ++sharingGeneration;
    const node = sharingNode;
    sharingLoading = true; $('decision-sharing-submit').disabled = true;
    $('decision-sharing-agents').innerHTML = loading('Loading eligible crew…');
    $('decision-sharing-errors').replaceChildren();
    try {
      const result = await method('eligibleAgents', { nodeId: node._id });
      if (generation !== sharingGeneration || !sharing.open) return;
      sharingAgents = Array.isArray(result) ? result : result.agents ?? [];
      const eligible = new Set(sharingAgents.map((row) => row.agent));
      sharingSelection = new Set([...(reset ? node.agentIds ?? [] : sharingSelection)].filter((id) => eligible.has(id)));
      const unavailable = (node.agentIds ?? []).filter((id) => !eligible.has(id));
      $('decision-sharing-unavailable').innerHTML = unavailable.length ? `<p class="op-hint">${esc(unavailable.map(agentLabel).join(', '))} ${unavailable.length === 1 ? 'is' : 'are'} no longer eligible. Saving removes ${unavailable.length === 1 ? 'that assignment' : 'those assignments'}.</p>` : '';
      renderSharingAgents(); $('decision-sharing-submit').disabled = false;
    } catch (error) {
      if (generation !== sharingGeneration || !sharing.open) return;
      $('decision-sharing-agents').replaceChildren();
      $('decision-sharing-errors').innerHTML = `<div class="op-error" role="alert">${esc(error.reason || error.message || 'Could not load the crew.')}</div><button type="button" class="secondary-action" id="decision-sharing-retry">Try again</button>`;
      $('decision-sharing-retry').addEventListener('click', () => void loadSharing(reset));
    } finally { if (generation === sharingGeneration) sharingLoading = false; }
  }
  function openSharing(node = selected()) {
    if (!node || node.status === 'archived') return;
    sharingNode = clone(node); sharingSelection = new Set(node.agentIds ?? []);
    $('decision-sharing-dialog-title').textContent = 'Share with crew';
    $('decision-sharing-dialog-scope').textContent = `${node.name} · ${scopeLabel(node)}`;
    $('decision-sharing-scope').textContent = node.scope === 'mission' ? 'Choose agents in this mission. Sharing does not turn on their Use permission or make this decision available in other missions.' : 'Choose workspace agents. Sharing does not turn on their Use permission.';
    $('decision-sharing-unavailable').replaceChildren(); $('decision-sharing-count').textContent = '';
    renderReadiness($('decision-sharing-connection')); showDialog(sharing); void loadSharing();
  }
  $('decision-sharing-cancel').addEventListener('click', () => sharing.close());
  sharing.addEventListener('close', () => { sharingGeneration += 1; sharingLoading = false; });
  $('decision-sharing-form').addEventListener('submit', (event) => {
    event.preventDefault(); if (sharingLoading) return;
    void busyAction(event.submitter, $('decision-sharing-errors'), 'Saving sharing…', async () => {
      await method('setAssignments', { nodeId: sharingNode._id, expectedRevision: sharingNode.revision, agentIds: [...sharingSelection] });
      sharing.close(); host.toast(sharingSelection.size ? 'Decision sharing saved.' : 'Decision is now for manual use only.');
    });
  });
  $('decision-confirm-cancel').addEventListener('click', () => confirm.close());
  $('decision-confirm-submit').addEventListener('click', (event) => void busyAction(event.currentTarget, $('decision-confirm-errors'), 'Removing…', async () => { await confirmAction?.(); confirm.close(); }));
  $('decision-scope-filter').addEventListener('change', () => { signature = ''; render(); });
  $('capability-search')?.addEventListener('input', () => { if (!$('capability-panel-decisions').hidden) render(); });

  function render() {
    if (disposed) return;
    // Tabs are switched by event handlers, outside a Tracker computation.
    // Always observe summary changes so opening History still responds to
    // completion, even if no run was read by the initial render.
    Runs.find({}, { fields: { nodeId: 1, status: 1, completedAt: 1 } }).fetch();
    const nodes = Nodes.find({ status: { $ne: 'archived' } }, { sort: { updatedAt: -1, createdAt: -1 } }).fetch();
    const config = settings();
    renderBudget();
    if (access.open) updateAccessHints();
    if (sharing.open) renderReadiness($('decision-sharing-connection'));
    const query = $('capability-search')?.value.trim().toLowerCase() ?? '';
    const filter = $('decision-scope-filter').value;
    const source = filter === 'archived' ? Nodes.find({ status: 'archived' }, { sort: { archivedAt: -1 } }).fetch() : nodes;
    const visible = source.filter((row) => (['all', 'archived'].includes(filter) || (filter === 'workspace' ? row.scope === 'workspace' : filter === 'pending' ? row.status === 'pending' : row.missionId === currentMission())) && (!query || `${row.name} ${row.description ?? ''}`.toLowerCase().includes(query)));
    if (!visible.some((row) => row._id === selectedId)) { selectedId = visible[0]?._id ?? null; detailSignature = ''; }
    $('decision-tab-count').textContent = String(nodes.length);
    $('decision-enabled-count').textContent = String(nodes.filter((row) => row.enabled && row.status === 'active').length);
    $('decision-pending-count').textContent = String(nodes.filter((row) => row.status === 'pending').length);
    $('decision-provider-state').textContent = !subscription.ready() ? 'Checking…' : !config.providerConfigured ? 'Not connected' : !config.enabled ? 'Paused' : 'Key available';
    const next = JSON.stringify({ visible, selectedId, config, ready: subscription.ready(), crew: crew(), filter, query });
    if (next !== signature) {
      signature = next;
      $('decision-page-notice').innerHTML = subscription.ready() && !available() ? `<div class="decision-notice"><span>${config.providerConfigured ? 'Evaluations are paused.' : 'Connect Jev to test and use decisions.'}</span><button class="op-link" id="decision-connect-inline" type="button">${config.providerConfigured ? 'Manage connection' : 'Connect Jev'}</button></div>` : '';
      $('decision-connect-inline')?.addEventListener('click', openConnection);
      const focusId = document.activeElement?.dataset.selectDecision;
      $('decision-list').innerHTML = !subscription.ready() ? loading('Loading decisions…') : visible.length ? visible.map((row) => `<button class="decision-list-item ${row._id === selectedId ? 'selected' : ''}" data-select-decision="${esc(row._id)}" aria-pressed="${row._id === selectedId}" type="button"><span class="decision-item-heading"><strong>${esc(row.name)}</strong>${stateBadge(row.status === 'archived' ? 'Removed' : row.status === 'pending' ? 'proposed' : row.enabled ? 'enabled' : 'disabled')}</span><span class="decision-item-description">${esc(instructionText(row.description || Object.values(row.definition?.questions ?? {})[0]?.instructions || ''))}</span><span class="decision-item-meta">${esc(scopeLabel(row))}<span>Revision ${esc(row.revision)}</span></span></button>`).join('') : `<div class="op-empty"><strong>${nodes.length ? 'No matching decisions' : 'No decisions yet'}</strong><p>${nodes.length ? 'Try another search or scope.' : 'Create a reusable check for your crew, such as whether a claim has enough evidence.'}</p>${nodes.length ? '' : '<button class="primary-action" id="decision-empty-create" type="button">Create decision</button>'}</div>`;
      $('decision-empty-create')?.addEventListener('click', () => openEditor());
      $('decision-list').querySelectorAll('[data-select-decision]').forEach((button) => button.addEventListener('click', () => { selectedId = button.dataset.selectDecision; selectedTab = 'overview'; detailSignature = ''; render(); }));
      if (focusId) [...$('decision-list').querySelectorAll('[data-select-decision]')].find((button) => button.dataset.selectDecision === focusId)?.focus({ preventScroll: true });
    }
    renderDetail();
  }

  function renderDetail() {
    const node = selected();
    const recentRuns = selectedTab === 'history' && node ? Runs.find({ nodeId: node._id }, { fields: { status: 1, completedAt: 1 } }).fetch() : null;
    const next = JSON.stringify({ node, selectedTab, config: settings(), agents: crew(), recentRuns, review: reviewFeedback.get(node?._id), reviewing: reviewing.has(node?._id) });
    if (next === detailSignature || (runPending && $('decision-detail').dataset.nodeId === node?._id && $('decision-detail').dataset.tab === selectedTab)) return;
    detailSignature = next; historyGeneration += 1;
    const root = $('decision-detail');
    for (const disclosure of root.querySelectorAll('[data-history-key]')) {
      if (disclosure.open) historyOpen.add(disclosure.dataset.historyKey);
      else historyOpen.delete(disclosure.dataset.historyKey);
    }
    root.dataset.nodeId = node?._id ?? ''; root.dataset.tab = selectedTab;
    if (!node) { root.innerHTML = ''; root.hidden = true; return; }
    root.hidden = false;
    root.innerHTML = `<header class="decision-detail-heading"><div><span class="decision-eyebrow">${esc(scopeLabel(node))} · Revision ${esc(node.revision)}</span><h3>${esc(node.name)}</h3></div>${stateBadge(node.status === 'archived' ? 'Removed' : node.status === 'pending' ? 'proposed' : node.enabled ? 'enabled' : 'disabled')}</header>
      <p class="decision-description">${esc(node.description)}</p><div class="decision-detail-actions" ${node.status === 'archived' ? 'hidden' : ''}><button class="secondary-action" data-decision-share type="button" aria-haspopup="dialog">Share with crew</button><button class="secondary-action" data-decision-edit type="button">Edit</button><button class="secondary-action" data-decision-toggle type="button" ${node.status === 'pending' ? 'disabled' : ''}>${node.enabled ? 'Disable' : 'Enable'}</button><button class="op-link" data-decision-remove type="button">Remove</button></div>
      ${node.status === 'pending' && !reviewing.has(node._id) ? `<section class="decision-review-notice"><strong>${esc(agentLabel(node.createdBy?.agent) || 'An agent')} requested this decision</strong><p>Approve use in this mission after reviewing its questions and inputs.${node.createdBy?.sessionId ? ' The requesting agent will continue when its conversation is ready.' : ''}</p><div class="op-inline-actions"><button data-decision-review="true" class="primary-action" type="button">${node.createdBy?.sessionId ? 'Approve & continue' : 'Approve for this mission'}</button><button data-decision-review="false" class="secondary-action" type="button">Decline</button></div></section>` : ''}${reviewNoticeMarkup(node)}
      <div class="op-tabs decision-detail-tabs" role="tablist" aria-label="Decision detail">${[['overview', 'Definition'], ['test', 'Test'], ['history', 'History']].map(([key, label]) => `<button id="decision-tab-${key}" data-decision-tab="${key}" type="button" role="tab" aria-selected="${selectedTab === key}" aria-controls="decision-content" tabindex="${selectedTab === key ? 0 : -1}">${label}</button>`).join('')}</div><div id="decision-action-errors"></div><section id="decision-content" class="decision-content" role="tabpanel" aria-labelledby="decision-tab-${selectedTab}"></section>`;
    root.querySelector('[data-decision-edit]').addEventListener('click', () => openEditor(node));
    root.querySelector('[data-decision-share]').addEventListener('click', () => openSharing(node));
    root.querySelector('[data-decision-toggle]').addEventListener('click', (event) => void busyAction(event.currentTarget, $('decision-action-errors'), node.enabled ? 'Disabling…' : 'Enabling…', async () => { await method('setEnabled', { nodeId: node._id, expectedRevision: node.revision, enabled: !node.enabled }); host.toast(node.enabled ? 'Decision disabled.' : 'Decision enabled.'); }));
    root.querySelector('[data-decision-remove]').addEventListener('click', () => {
      $('decision-confirm-copy').textContent = `Remove “${node.name}”? Agents will no longer be able to use it. Saved results remain in history.`;
      $('decision-confirm-errors').replaceChildren(); confirmAction = () => method('remove', { nodeId: node._id, expectedRevision: node.revision }); showDialog(confirm);
    });
    root.querySelectorAll('[data-decision-review]').forEach((button) => button.addEventListener('click', () => void reviewDecision(node, button)));
    root.querySelector('[data-decision-continuation-work]')?.addEventListener('click', (event) => {
      const continuation = continuationFor(node);
      if (continuation?.sessionId) void busyAction(event.currentTarget, $('decision-action-errors'), 'Opening…',
        () => host.openWork?.(continuation.sessionId, continuation.agent || node.createdBy?.agent, continuation));
    });
    wireTabs(root, 'data-decision-tab', (tab) => { selectedTab = tab; renderDetail(); root.querySelector(`[data-decision-tab="${tab}"]`)?.focus(); });
    if (selectedTab === 'overview') renderOverview(node);
    else if (selectedTab === 'test') renderTest(node);
    else void renderHistory(node);
  }

  function continuationFor(node) {
    const feedback = reviewFeedback.get(node._id);
    if (feedback?.status === 'working') return feedback;
    return node.continuation ? { ...node.continuation, approve: feedback?.approve ?? node.status !== 'archived' } : feedback;
  }
  function continuationText(continuation, approve) {
    const result = approve ? 'Approved' : 'Declined';
    const agent = agentLabel(continuation?.agent) || 'Agent';
    const states = {
      working: { title: 'Saving review…', detail: 'Checking the requesting conversation.' },
      preparing: { title: 'Preparing continuation…', detail: `Checking ${agent}’s requesting conversation.` },
      'review-error': { title: 'Review not saved', detail: 'Try approving or declining again.' },
      queued: { title: `${result} · ${agent} queued to continue`, detail: 'Waiting for the requesting conversation to be ready.' },
      resumed: { title: `${result} · ${agent} continuing`, detail: '' },
      completed: { title: `${agent} finished`, detail: 'Open the requesting agent’s work to review the result.' },
      waiting: { title: `${agent} needs approval`, detail: 'Open the requesting agent’s work to review the next action.' },
      stopped: { title: `${agent} stopped`, detail: 'The continuation was stopped. Open its work before restarting.' },
      failed: { title: `${agent} could not finish`, detail: 'Open the requesting agent’s work for details.' },
      manual: { title: `${result} · ${agent} not resumed`, detail: 'Return to the conversation to continue when ready.' },
      uncertain: { title: `${result} · continuation unconfirmed`, detail: 'Check the conversation before asking the agent to continue again.' },
    };
    const state = states[continuation?.status] ?? states.manual;
    return { ...state, detail: continuation?.reason || state.detail };
  }
  function reviewNoticeMarkup(node) {
    const feedback = continuationFor(node);
    if (!feedback) return '';
    const copy = continuationText(feedback, feedback.approve !== false);
    return `<section class="decision-continuation" data-continuation-state="${esc(feedback.status)}" role="${feedback.status === 'review-error' ? 'alert' : 'status'}">${['working', 'preparing', 'queued', 'resumed'].includes(feedback.status) ? '<span class="decision-continuation-spinner" aria-hidden="true"></span>' : ''}<div><strong>${esc(copy.title)}</strong>${copy.detail ? `<p>${esc(copy.detail)}</p>` : ''}</div>${feedback.sessionId && host.openWork ? '<button type="button" class="secondary-action" data-decision-continuation-work>View work</button>' : ''}</section>`;
  }
  async function reviewDecision(node, button) {
    if (reviewing.has(node._id)) return;
    const approve = button.dataset.decisionReview === 'true';
    reviewing.add(node._id); reviewFeedback.set(node._id, { status: 'working', approve });
    renderDetail();
    try {
      const result = await method('review', { nodeId: node._id, expectedRevision: node.revision, approve });
      const continuation = result?.continuation ?? { status: 'manual', reason: approve ? 'Approved for this mission. No requesting conversation was resumed.' : 'The decision was declined. No requesting conversation was resumed.' };
      reviewFeedback.set(node._id, { ...continuation, approve });
      host.toast(continuationText(continuation, approve).title);
    } catch (error) {
      const message = error.reason || error.message || 'Could not save the review. Try again.';
      reviewFeedback.set(node._id, { status: 'review-error', reason: message, approve });
      host.toast(message, 'error');
    } finally {
      reviewing.delete(node._id); renderDetail(); updateChat();
    }
  }

  function renderOverview(node) {
    const questions = Object.entries(node.definition?.questions ?? {});
    const tested = node.lastTest?.revision === node.revision && node.lastTest?.status === 'passed';
    $('decision-content').innerHTML = `<div class="decision-question-list">${questions.map(([id, question]) => `<section class="decision-question"><header><strong>${esc(id.replace(/_/g, ' '))}</strong><span class="op-muted">${esc(questionTypes[question.type] ?? question.type)}</span></header><p>${esc(instructionText(question.instructions))}</p>${question.type === 'noul' ? `<span class="op-hint">Result: probability of yes, from 0 to 1.</span>${question.criteria ? decisionValueMarkup(question.criteria) : ''}` : `<ol ${question.type === 'score' ? 'start="0"' : ''}>${Object.entries(question.criteria ?? {}).map(([key, label]) => `<li>${esc(instructionText(label ?? key))}</li>`).join('')}</ol>`}</section>`).join('')}</div>
      <section class="decision-section"><h4>Inputs</h4><div class="decision-input-chips">${fieldsFor(node).map((field) => `<span><strong>${esc(field.label || field.key)}</strong><code>${esc(field.key)}</code><small>${field.type === 'boolean' ? 'Yes / no' : esc(field.type)}${field.required ? ' · required' : ''}</small></span>`).join('')}</div></section>
      <section class="decision-section"><div class="op-section-heading"><h4>Shared with</h4>${node.status !== 'archived' ? '<button class="op-link" data-decision-share-section type="button">Change sharing</button>' : ''}</div><div class="decision-assignment-list">${node.agentIds?.length ? node.agentIds.map((id) => { const policy = settings().agentPolicies?.[id]; const agent = crew().find((row) => row.agent === id); return `<button class="decision-assignment" type="button" data-decision-agent="${esc(id)}" aria-label="Permissions for ${esc(agentLabel(id))}"><strong>${esc(agentLabel(id))}</strong><span>${!agent?.enabled ? 'Agent disabled' : !policy?.use ? 'Use off' : !available() ? 'Use on · connection needed' : 'Use on'}</span></button>`; }).join('') : '<p class="op-hint">Manual use only. Share with crew to give agents access.</p>'}</div></section>
      ${node.scope === 'mission' && node.status === 'active' ? `<section class="decision-section decision-promotion"><div><h4>Reuse across the workspace</h4><p class="op-hint">${tested ? 'Saved tests passed for this revision. Review the definition before sharing.' : 'Add examples with expected results, then run the saved tests before sharing.'}</p></div><button id="decision-promote" class="secondary-action" type="button" ${tested ? '' : 'disabled'}>Approve workspace reuse</button></section>` : ''}
      <p class="op-hint">Confidence describes the model’s certainty, not proof that a result is correct. Action approvals remain unchanged.</p>`;
    $('decision-content').querySelectorAll('[data-decision-agent]').forEach((button) => button.addEventListener('click', () => openAgentPolicy(button.dataset.decisionAgent)));
    $('decision-content').querySelector('[data-decision-share-section]')?.addEventListener('click', () => openSharing(node));
    $('decision-promote')?.addEventListener('click', (event) => void busyAction(event.currentTarget, $('decision-action-errors'), 'Sharing…', async () => { await method('promote', { nodeId: node._id, expectedRevision: node.revision }); host.toast('Decision approved for workspace reuse.'); }));
  }

  function stateControls(node, state = {}) {
    return fieldsFor(node).map((field) => `<label>${esc(field.label || field.key)}${field.required ? '' : ' (optional)'}${field.type === 'boolean' ? `<select data-state-key="${esc(field.key)}" data-state-type="boolean" ${field.required ? 'required' : ''}><option value="">Choose…</option><option value="true" ${state[field.key] === true ? 'selected' : ''}>Yes</option><option value="false" ${state[field.key] === false ? 'selected' : ''}>No</option></select>` : field.type === 'number' ? `<input type="number" step="any" data-state-key="${esc(field.key)}" data-state-type="number" ${field.required ? 'required' : ''} value="${esc(state[field.key] ?? '')}">` : `<textarea rows="4" maxlength="32000" data-state-key="${esc(field.key)}" data-state-type="text" ${field.required ? 'required' : ''}>${esc(state[field.key] ?? '')}</textarea>`}</label>`).join('');
  }
  function readState(root) {
    const state = {};
    root.querySelectorAll('[data-state-key]').forEach((input) => {
      if (input.value !== '') state[input.dataset.stateKey] = input.dataset.stateType === 'number' ? Number(input.value) : input.dataset.stateType === 'boolean' ? input.value === 'true' : input.value;
    });
    return state;
  }
  function expectedControls(node) {
    return Object.entries(node.definition.questions).map(([id, question]) => { const max = question.type === 'score' ? question.criteria.length - 1 : 1; return `<div class="decision-expected-row"><strong>${esc(id.replace(/_/g, ' '))}</strong>${question.type === 'choice' ? `<label>Expected option<select data-expected-choice="${esc(id)}" required><option value="">Choose…</option>${Object.entries(question.criteria).map(([key, label]) => `<option value="${esc(key)}">${esc(instructionText(label ?? key))}</option>`).join('')}</select></label>` : `<div class="op-form-row"><label>Minimum ${question.type === 'noul' ? 'probability' : 'score'}<input data-expected-min="${esc(id)}" type="number" min="0" max="${max}" step="any" placeholder="0" required></label><label>Maximum<input data-expected-max="${esc(id)}" type="number" min="0" max="${max}" step="any" placeholder="${max}" required></label></div>`}</div>`; }).join('');
  }
  function readExpected(root) {
    const expected = {};
    root.querySelectorAll('[data-expected-choice]').forEach((input) => { if (!input.value) throw new Error('Choose an expected result for every question.'); expected[input.dataset.expectedChoice] = input.value; });
    root.querySelectorAll('[data-expected-min]').forEach((input) => {
      const maximum = [...root.querySelectorAll('[data-expected-max]')].find((item) => item.dataset.expectedMax === input.dataset.expectedMin);
      if (!input.value || !maximum.value) throw new Error('Set a minimum and maximum expected result.');
      const min = Number(input.value); const max = Number(maximum.value);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > Number(input.max) || min > max) throw new Error(`Expected results must be between 0 and ${input.max}, with minimum no higher than maximum.`);
      expected[input.dataset.expectedMin] = { min, max };
    });
    return expected;
  }
  function resultMarkup(run) {
    if (run.status === 'failed') return `<div class="op-error" role="alert">${esc(run.error?.reason ?? 'Evaluation could not finish.')}</div>${run.uncertainUsage ? '<p class="op-hint">Usage unconfirmed. The provider may have charged for this request; its token reservation remains held.</p>' : ''}`;
    const questions = run.definition?.questions ?? selected()?.definition?.questions ?? {};
    return `<div class="decision-answers">${Object.entries(questions).map(([id, question]) => `<div class="decision-answer"><span>${esc(id.replace(/_/g, ' '))}</span>${decisionAnswerMarkup(question, run.answers?.[id])}</div>`).join('')}</div><p class="op-hint">${esc(run.model ?? 'Jev')}${run.usage ? ` · ${Number(run.usage.input_tokens ?? 0) + Number(run.usage.output_tokens ?? 0)} tokens` : ''} · Revision ${esc(run.nodeRevision ?? '')}</p>`;
  }
  function renderTest(node) {
    const ready = available() && node.enabled && node.status === 'active';
    $('decision-content').innerHTML = `<p class="decision-privacy-note">${notice}</p>${ready ? '' : `<p class="op-hint">${!available() ? 'Connect and enable Jev to run a test.' : node.status === 'pending' ? 'Approve this decision before testing.' : 'Enable this decision before testing.'}</p>`}
      <form id="decision-test-form" class="decision-form-stack"><div id="decision-test-fields" class="decision-form-stack">${stateControls(node)}</div><button id="decision-run-test" type="submit" class="primary-action" ${ready ? '' : 'disabled'}>Run live test</button></form><div id="decision-test-result" aria-live="polite"></div>
      <section class="decision-section"><div class="op-section-heading"><h4>Saved tests</h4><span class="op-muted">${node.fixtures?.length ?? 0} examples</span></div><p class="op-hint">Use representative examples, including missing evidence and cases that should not match.</p><div id="decision-fixtures">${node.fixtures?.length ? node.fixtures.map((fixture) => `<div class="decision-fixture"><button class="op-link" data-load-fixture="${esc(fixture.id)}" type="button">${esc(fixture.name)}</button><button class="op-link decision-danger-link" data-remove-fixture="${esc(fixture.id)}" type="button" aria-label="Remove test ${esc(fixture.name)}">Remove</button></div>`).join('') : '<p class="op-hint">No saved examples.</p>'}</div><button id="decision-run-fixtures" type="button" class="secondary-action" ${ready && node.fixtures?.length ? '' : 'disabled'}>Run saved tests</button><div id="decision-fixture-result" aria-live="polite">${node.lastTest?.revision === node.revision ? reportMarkup(node.lastTest) : ''}</div>
      <details class="decision-save-example"><summary>Save these inputs as a test</summary><form id="decision-fixture-form" class="decision-form-stack"><label>Test name<input id="decision-fixture-name" maxlength="120" required placeholder="e.g. Missing source evidence"></label>${expectedControls(node)}<p class="op-hint">Uses the inputs above. Saving creates a new revision; rerun tests before sharing.</p><button type="submit" class="secondary-action">Save test example</button><div id="decision-fixture-errors"></div></form></details></section>`;
    $('decision-test-form').addEventListener('submit', (event) => {
      event.preventDefault(); void busyAction(event.submitter, $('decision-test-result'), 'Evaluating…', async () => {
        runPending = true; $('decision-test-result').innerHTML = loading('Jev is evaluating…');
        try {
          const run = await method('evaluate', { nodeId: node._id, revision: node.revision, requestKey: window.crypto.randomUUID(), state: readState($('decision-test-fields')), ...(node.missionId ? { missionId: node.missionId } : {}) });
          if (selectedId === node._id && selectedTab === 'test') $('decision-test-result').innerHTML = resultMarkup(run);
        } finally { runPending = false; $('decision-test-result')?.querySelector('.op-loading')?.remove(); }
      });
    });
    $('decision-fixture-form').addEventListener('submit', (event) => {
      event.preventDefault(); void busyAction(event.submitter, $('decision-fixture-errors'), 'Saving…', async () => {
        if (!$('decision-test-form').reportValidity()) throw new Error('Fill in the required inputs above.');
        const fixture = { id: `test_${window.crypto.randomUUID()}`, name: $('decision-fixture-name').value.trim(), state: readState($('decision-test-fields')), expected: readExpected($('decision-fixture-form')) };
        await saveFixtures(node, [...(node.fixtures ?? []), fixture]); host.toast('Test example saved.');
      });
    });
    $('decision-run-fixtures').addEventListener('click', (event) => void busyAction(event.currentTarget, $('decision-fixture-result'), 'Testing…', async () => {
      runPending = true; $('decision-fixture-result').innerHTML = loading('Running saved tests…');
      try { const report = await method('testFixtures', { nodeId: node._id, revision: node.revision, requestKey: window.crypto.randomUUID() }); if (selectedId === node._id) $('decision-fixture-result').innerHTML = reportMarkup(report); }
      finally { runPending = false; $('decision-fixture-result')?.querySelector('.op-loading')?.remove(); }
    }));
    $('decision-fixtures').querySelectorAll('[data-load-fixture]').forEach((button) => button.addEventListener('click', () => {
      const fixture = node.fixtures.find((item) => item.id === button.dataset.loadFixture);
      $('decision-test-fields').innerHTML = stateControls(node, fixture.state); $('decision-test-fields').querySelector('input,textarea,select')?.focus();
    }));
    $('decision-fixtures').querySelectorAll('[data-remove-fixture]').forEach((button) => button.addEventListener('click', () => void busyAction(button, $('decision-fixture-result'), 'Removing…', () => saveFixtures(node, node.fixtures.filter((item) => item.id !== button.dataset.removeFixture)))));
  }
  function saveFixtures(node, fixtures) {
    const { name, description, scope, missionId, enabled, agentIds, inputFields, definition } = node;
    return method('save', { nodeId: node._id, expectedRevision: node.revision, input: { name, description, scope, ...(missionId ? { missionId } : {}), enabled, agentIds, inputFields, definition, fixtures } });
  }
  function reportMarkup(report) {
    return `<div class="decision-test-report">${stateBadge(report.status)}<strong>${Number(report.passed ?? 0)} / ${Number(report.total ?? 0)} tests passed</strong>${report.results?.map((row) => `<details><summary><span>${row.passed ? '✓' : '×'} ${esc(row.name)}</span></summary><div>${row.assertions?.map((assertion) => `<p><strong>${esc(assertion.questionId)}</strong> — ${assertion.passed ? 'Passed' : 'Did not match'}</p><dl class="decision-values"><div><dt>Expected</dt><dd>${decisionValueMarkup(assertion.expected)}</dd></div><div><dt>Actual</dt><dd>${decisionValueMarkup(assertion.actual)}</dd></div></dl>`).join('') ?? ''}</div></details>`).join('') ?? ''}</div>`;
  }
  async function renderHistory(node) {
    const generation = ++historyGeneration;
    $('decision-content').innerHTML = loading('Loading decision history…');
    try {
      const [result, versions] = await Promise.all([method('history', { nodeId: node._id }), method('versions', { nodeId: node._id })]);
      if (generation !== historyGeneration || disposed) return;
      const rows = Array.isArray(result) ? result : result.runs ?? [];
      const labels = { created: 'Created', proposed: 'Proposed by agent', updated: 'Edited', approved: 'Approved for mission', rejected: 'Declined', promoted: 'Approved for workspace', enabled: 'Enabled', disabled: 'Disabled', archived: 'Removed', 'assignments-changed': 'Crew sharing changed' };
      $('decision-content').innerHTML = `<details class="decision-changes" data-history-key="changes-${esc(node._id)}"><summary>Changes <span class="op-muted">${versions.length}</span></summary><div>${versions.map((version) => `<details class="decision-change" data-history-key="version-${esc(version._id)}"><summary><strong>Revision ${esc(version.revision)} · ${esc(labels[version.action] ?? version.action)}</strong><span>${esc(version.actor?.kind === 'agent' ? agentLabel(version.actor.agent) : 'You')} · ${esc(dateLabel(version.createdAt))}</span></summary><div>${version.snapshot?.description ? `<p>${esc(version.snapshot.description)}</p>` : ''}${Object.entries(version.snapshot?.definition?.questions ?? {}).map(([id, question]) => `<section class="decision-question"><strong>${esc(id.replace(/_/g, ' '))}</strong><p>${esc(instructionText(question.instructions))}</p>${question.criteria ? decisionValueMarkup(question.criteria) : ''}</section>`).join('')}</div></details>`).join('') || '<p class="op-hint">No recorded changes.</p>'}</div></details>` + (rows.length ? rows.map((run) => `<details class="decision-history-row" data-history-key="run-${esc(run._id)}"><summary><span><strong>${esc(dateLabel(run.createdAt))}</strong><small>${esc(run.purpose === 'fixture' ? 'Saved test' : run.purpose === 'test' ? 'Manual test' : run.purpose === 'workflow' ? 'Plan step' : agentLabel(run.agent) || 'Agent evaluation')} · revision ${esc(run.nodeRevision)}</small></span>${stateBadge(run.status)}</summary><div class="decision-history-body">${run.status === 'running' ? loading('Evaluating…') : resultMarkup(run)}<details class="decision-history-inputs" data-history-key="input-${esc(run._id)}"><summary>Exact inputs</summary>${decisionValueMarkup(run.state)}</details><details class="decision-history-inputs" data-history-key="questions-${esc(run._id)}"><summary>Questions used</summary>${Object.entries(run.definition?.questions ?? {}).map(([id, question]) => `<section class="decision-question"><strong>${esc(id)}</strong><p>${esc(instructionText(question.instructions))}</p>${question.criteria ? decisionValueMarkup(question.criteria) : ''}</section>`).join('')}</details></div></details>`).join('') : '<div class="op-empty"><strong>No evaluations yet</strong><p>Run a test or let an assigned agent use this decision.</p></div>');
      [...$('decision-content').querySelectorAll('.decision-change')].forEach((change, index) => {
        const agents = versions[index]?.snapshot?.agentIds;
        if (!Array.isArray(agents)) return;
        const sharingSummary = document.createElement('p');
        sharingSummary.className = 'op-hint decision-sharing-history';
        sharingSummary.textContent = `Shared with: ${agents.length ? agents.map(agentLabel).join(', ') : 'No agents (manual use only)'}`;
        change.querySelector(':scope > div').prepend(sharingSummary);
      });
      for (const disclosure of $('decision-content').querySelectorAll('[data-history-key]')) disclosure.open = historyOpen.has(disclosure.dataset.historyKey);
    } catch (error) { if (generation === historyGeneration) $('decision-content').innerHTML = `<div class="op-error" role="alert">${esc(error.reason || error.message)}</div><button id="decision-history-retry" class="secondary-action" type="button">Try again</button>`; $('decision-history-retry')?.addEventListener('click', () => void renderHistory(node)); }
  }

  const cards = new Map();
  function updateChat() {
    if (!host.chat) return;
    const missionId = currentMission();
    const nodes = missionId ? Nodes.find({ missionId, $or: [{ status: { $ne: 'archived' } }, { continuation: { $exists: true } }] }).fetch() : [];
    const runs = missionId ? Runs.find({ missionId, purpose: { $in: ['agent', 'workflow'] } }, { sort: { createdAt: 1 }, limit: 100 }).fetch() : [];
    const activities = [
      ...nodes.filter((row) => row.createdBy?.kind === 'agent' || row.status === 'pending').map((row) => {
        const continuation = continuationFor(row);
        const status = continuation?.status;
        const state = status === 'queued' ? 'queued' : ['preparing', 'resumed', 'working'].includes(status) ? 'running' : status === 'waiting' ? 'awaiting' : ['manual', 'uncertain', 'review-error'].includes(status) ? 'blocked' : status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : row.status === 'pending' ? 'proposed' : 'completed';
        return { id: `decision-created-${row._id}`, nodeId: row._id, title: row.name, status: state, subtitle: continuation ? continuationText(continuation, continuation.approve !== false).title : row.status === 'pending' ? 'Decision needs approval' : 'Decision created for this mission', createdAt: row.createdAt, workSessionId: continuation?.sessionId, workAgent: continuation?.agent || row.createdBy?.agent, continuation };
      }),
      ...runs.map((run) => ({ id: `decision-run-${run._id}`, nodeId: run.nodeId, title: run.nodeName ?? 'Decision', status: run.status, subtitle: run.status === 'running' ? 'Jev is evaluating…' : run.status === 'failed' ? 'Evaluation failed · inspect details' : run.summary ?? 'Decision evaluated', createdAt: run.createdAt })),
    ];
    const active = new Set(activities.map((item) => item.id));
    for (const id of cards.keys()) if (!active.has(id)) cards.delete(id);
    const items = activities.map((item) => {
      let entry = cards.get(item.id);
      if (!entry) {
        const element = document.createElement('article'); element.className = 'decision-chat-card';
        element.dataset.decisionNode = item.nodeId;
        element.innerHTML = '<span class="decision-chat-symbol" aria-hidden="true">◇</span><div><strong></strong><span class="decision-chat-description"></span></div><span class="decision-chat-status"></span><button type="button" class="secondary-action" data-decision-chat-inspect>Inspect</button><button type="button" class="secondary-action" data-decision-chat-work hidden>View work</button>';
        element.querySelector('[data-decision-chat-inspect]').addEventListener('click', () => open({ nodeId: item.nodeId, missionId }));
        element.querySelector('[data-decision-chat-work]').addEventListener('click', (event) => {
          void busyAction(event.currentTarget, element, 'Opening…',
            () => host.openWork?.(entry.activity.workSessionId, entry.activity.workAgent, entry.activity.continuation));
        });
        entry = { element, signature: '' }; cards.set(item.id, entry);
      }
      const next = JSON.stringify(item);
      entry.activity = item;
      if (entry.signature !== next) {
        entry.signature = next; entry.element.querySelector('strong').textContent = item.title;
        entry.element.querySelector('.decision-chat-description').textContent = item.subtitle;
        entry.element.querySelector('.decision-chat-status').innerHTML = stateBadge(item.status);
        entry.element.querySelector('[data-decision-chat-inspect]').textContent = item.status === 'proposed' ? 'Review decision' : 'Inspect';
        entry.element.querySelector('[data-decision-chat-work]').hidden = !item.workSessionId || !host.openWork;
      }
      return { id: item.id, createdAt: item.createdAt, element: entry.element };
    });
    setChatTimelineSource(host.chat, 'decisions', items);
  }
  function open({ nodeId, missionId } = {}) {
    host.openCapabilities?.();
    $('capability-search').value = '';
    $('decision-scope-filter').value = nodeId && Nodes.findOne(nodeId)?.status === 'archived' ? 'archived' : 'all';
    if (nodeId) selectedId = nodeId;
    selectedTab = 'overview'; signature = ''; detailSignature = ''; render();
    $('decision-detail').scrollIntoView({ block: 'nearest' });
  }
  const computation = Tracker.autorun(render);
  const chatComputation = Tracker.autorun(updateChat);
  return { render, open, openAgentPolicy, openConnection, openEditor, openSharing, nodes: Nodes, settings: Settings, runs: Runs,
    dispose() { disposed = true; historyGeneration += 1; sharingGeneration += 1; computation.stop(); chatComputation.stop(); subscription.stop(); for (const dialog of [editor, connection, access, sharing, confirm]) dialog.remove(); if (host.chat) setChatTimelineSource(host.chat, 'decisions', []); cards.clear(); } };
}
