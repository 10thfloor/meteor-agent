import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Mongo } from 'meteor/mongo';
import { initializeLab } from './operations-lab';
import { initializeFederation } from './operations-federation';
import { decisionBranchSchema, workflowConditionLabel, workflowDependencies } from '../imports/constellation/workflows';
import { LOCAL_MODEL } from '../imports/constellation/models';
import { sanitizeCleanAssistantContent } from 'meteor/10thfloor:agent';
import { initializePlanChat } from './plan-chat';

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
export const element = (id) => document.getElementById(id);
export const dateLabel = (value) => value ? new Date(value).toLocaleString([], {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '—';
export const uniqueKey = () => window.crypto.randomUUID();
const states = {
  queued: 'Queued', pending: 'Not started', running: 'Running', streaming: 'Responding',
  awaiting: 'Needs review', completed: 'Completed', success: 'Passed', passed: 'Passed',
  failed: 'Failed', skipped: 'Skipped', cancelled: 'Stopped', stopped: 'Stopped', blocked: 'Needs attention',
  proposed: 'Needs review', admitted: 'Experience saved', recorded: 'Observation', observed: 'Observed',
  candidate: 'Draft experience', dismissed: 'Dismissed', reflecting: 'Reflecting', waiting: 'Waiting for approval',
  admitting: 'Recording experience', enabled: 'Enabled', disabled: 'Disabled', error: 'Error',
};
export const stateBadge = (status) => `<span class="op-state" data-state="${escapeHtml(status)}"><i aria-hidden="true"></i>${escapeHtml(states[status] ?? status ?? 'Ready')}</span>`;

export function createDialog(id, title, content, className = '') {
  const dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.className = `op-dialog ${className}`;
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.innerHTML = `<header class="op-dialog-header"><div><h2 id="${id}-title">${title}</h2><span class="op-dialog-scope" id="${id}-scope"></span></div><button type="button" class="op-close" data-dialog-close aria-label="Close ${title}">×</button></header>${content}`;
  document.body.append(dialog);
  dialog.querySelector('[data-dialog-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog._returnFocus?.focus?.({ preventScroll: true }));
  return dialog;
}

export function showDialog(dialog, control = document.activeElement) {
  dialog._returnFocus = control;
  if (!dialog.open) dialog.showModal();
}

export async function busyAction(control, region, label, operation) {
  if (control?.disabled) return;
  const oldLabel = control?.textContent;
  const oldAriaLabel = control?.getAttribute('aria-label');
  if (control) { control.disabled = true; control.dataset.loading = 'true'; control.dataset.loadingLabel = label; control.textContent = label; control.setAttribute('aria-label', label); }
  const error = region?.querySelector(':scope > .op-error');
  error?.remove();
  try { return await operation(); }
  catch (errorValue) {
    const message = document.createElement('div');
    message.className = 'op-error'; message.setAttribute('role', 'alert');
    message.textContent = errorValue?.reason || errorValue?.message || 'Could not complete this action. Try again.';
    region?.prepend(message);
    return undefined;
  } finally {
    if (control?.isConnected) {
      control.disabled = false; control.dataset.loading = 'false'; delete control.dataset.loadingLabel;
      if (control.textContent === label) control.textContent = oldLabel;
      if (oldAriaLabel === null) control.removeAttribute('aria-label');
      else if (oldAriaLabel !== undefined) control.setAttribute('aria-label', oldAriaLabel);
    }
  }
}

export function wireTabs(root, attribute, select) {
  const buttons = [...root.querySelectorAll(`[${attribute}]`)];
  for (const button of buttons) {
    button.addEventListener('click', () => select(button.getAttribute(attribute)));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(button);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click(); buttons[next].focus();
    });
  }
}

export function initializeOperations(host) {
  const Definitions = new Mongo.Collection('constellation_workflows');
  const Runs = new Mongo.Collection('constellation_workflow_runs');
  let workflowSubscription = null;
  let subscribedMission = null;
  let planGeneration = 0;
  let missionId;
  let evidenceSessionId;
  let definition = null;
  let decisionNodes = [];
  let plan = null;
  let dirty = false;
  let tab = 'plan';
  let selectedRunId = null;
  let evidence = null;
  let evidenceGeneration = 0;
  let evidenceLoading = false;
  let selectedTrace = null;
  let signature = '';
  const dialog = createDialog('mission-plan-dialog', 'Plan &amp; runs', `
    <div class="op-tabs" role="tablist" aria-label="Mission work">
      <button id="op-tab-plan" data-op-tab="plan" role="tab" aria-selected="true" aria-controls="op-panel-plan" type="button">Plan</button>
      <button id="op-tab-runs" data-op-tab="runs" role="tab" aria-selected="false" aria-controls="op-panel-runs" tabindex="-1" type="button">Runs <span id="op-run-count">0</span></button>
      <button id="op-tab-evidence" data-op-tab="evidence" role="tab" aria-selected="false" aria-controls="op-panel-evidence" tabindex="-1" type="button">Evidence &amp; memory</button>
    </div>
    <section id="op-panel-plan" class="op-panel" role="tabpanel" aria-labelledby="op-tab-plan">
      <form id="op-plan-form"><div class="op-scroll">
        <div class="op-form-row"><label>Plan name<input id="op-plan-name" maxlength="120" required></label><label>How the crew works<select id="op-plan-strategy"><option value="workflow">Follow these steps</option><option value="supervisor">Coordinator + specialists</option><option value="handoff">Pass between specialists</option><option value="council">Independent reviews + synthesis</option></select></label></div>
        <p id="op-strategy-hint" class="op-hint"></p>
        <div class="op-section-heading"><h3>Steps</h3><span id="op-plan-version" class="op-muted">Not saved</span></div>
        <div id="op-plan-steps"></div>
        <div class="op-inline-actions"><button id="op-add-step" class="secondary-action" type="button">+ Agent step</button><button id="op-add-decision" class="secondary-action" type="button">+ Decision</button><button id="op-add-review" class="secondary-action" type="button">+ Review checkpoint</button></div>
        <details class="op-details"><summary>Run limits</summary><div class="op-form-row three"><label>Maximum steps<input id="op-budget-steps" type="number" min="1" max="128" value="20" required></label><label>Time limit (minutes)<input id="op-budget-time" type="number" min="1" max="60" value="10" required></label><label>Agent spend limit ($)<input id="op-budget-spend" type="number" min="0" max="10000" step="any" value="5" required></label></div><div class="op-form-row"><label>Agent turns<input id="op-budget-turns" type="number" min="1" max="1000" value="20" required></label><label>Tool calls<input id="op-budget-tool-calls" type="number" min="0" max="1000" value="20" required></label></div><p class="op-hint">Mission limits also apply. Agent steps share these budgets. TypeSafe usage has separate call and token limits in Decisions settings.</p></details>
      </div><footer class="op-footer"><span id="op-plan-save-state" role="status">Not saved</span><button id="op-discard-plan" type="button" class="secondary-action" hidden>Reload saved plan</button><button id="op-save-plan" class="secondary-action" type="submit">Save plan</button><button id="op-run-plan" type="button" class="primary-action">Run plan</button></footer></form>
    </section>
    <section id="op-panel-runs" class="op-panel" role="tabpanel" aria-labelledby="op-tab-runs" hidden><div class="op-run-layout"><aside id="op-run-list" class="op-run-list" aria-label="Run history"></aside><div id="op-run-detail" class="op-run-detail"></div></div></section>
    <section id="op-panel-evidence" class="op-panel" role="tabpanel" aria-labelledby="op-tab-evidence" hidden><div class="op-scroll"><div class="op-section-heading"><label class="op-inline-select">Conversation<select id="op-evidence-session" aria-label="Evidence conversation"></select></label><label class="op-inline-select">Turn<select id="op-evidence-turn" aria-label="Turn evidence"></select></label><button id="op-refresh-evidence" class="secondary-action" type="button">Refresh</button></div><div id="op-evidence-content"></div></div></section>
    <div id="op-dialog-errors"></div>
  `, 'op-dialog-wide');
  const planExplainer = document.createElement('p');
  planExplainer.id = 'op-plan-explainer';
  planExplainer.className = 'op-dialog-explainer';
  planExplainer.textContent = 'Use a plan for work that needs multiple steps, agent handoffs, or approvals. Add tasks, assign agents, then save and run. Open Runs to follow progress, handle approvals, and review results.';
  element('mission-plan-dialog-scope').after(planExplainer);
  dialog.setAttribute('aria-describedby', planExplainer.id);
  const evidenceDialog = createDialog('run-evidence-dialog', 'Evidence &amp; memory', '', 'op-dialog-wide');
  const evidencePanel = element('op-panel-evidence');
  const evidenceHome = document.createComment('Mission evidence tab');
  evidencePanel.before(evidenceHome);
  let restoreEvidenceContext = null;
  const evidenceVisible = () => evidenceDialog.open || (dialog.open && tab === 'evidence');
  evidenceDialog.addEventListener('close', () => {
    evidenceHome.after(evidencePanel);
    evidencePanel.setAttribute('role', 'tabpanel');
    evidencePanel.setAttribute('aria-labelledby', 'op-tab-evidence');
    evidencePanel.hidden = tab !== 'evidence';
    restoreEvidenceContext?.();
    restoreEvidenceContext = null;
  });
  let editingObservation = null;
  const observationDialog = createDialog('observation-draft-dialog', 'Draft experience', `<form id="observation-draft-form"><div class="op-scroll"><label>Expected outcome<textarea id="observation-expected" rows="2" maxlength="2000" required></textarea></label><label>What happened<textarea id="observation-observed" rows="2" maxlength="2000" required></textarea></label><label>Difference<textarea id="observation-difference" rows="2" maxlength="2000" required></textarea></label><label>Lesson<textarea id="observation-lesson" rows="2" maxlength="2000" required></textarea></label><div class="op-form-row"><label>Context<input id="observation-context" maxlength="256" required></label><label>Confidence<select id="observation-confidence"><option value="0.5">Tentative</option><option value="0.75">Likely</option><option value="0.95">Well supported</option></select></label></div><p id="observation-admission-hint" class="op-hint"></p><div id="observation-errors"></div></div><footer class="op-footer"><button class="primary-action" type="submit" id="observation-save">Save draft</button></footer></form>`);
  element('observation-draft-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(event.submitter, element('observation-errors'), 'Saving…', async () => {
      const draft = { expectationBasis: editingObservation.candidate?.expectationBasis ?? 'retrospective', confidence: +element('observation-confidence').value };
      for (const field of ['expected', 'observed', 'difference', 'lesson', 'context']) draft[field] = element(`observation-${field}`).value.trim();
      const result = await Meteor.callAsync('constellation.observationReflect', { sessionId: evidenceSessionId ?? missionId, observationId: editingObservation._id, draft });
      observationDialog.close(); host.toast(result.status === 'admitted' ? 'Experience recorded.' : 'Draft experience saved.'); await loadEvidence();
    });
  });

  const strategyHints = {
    workflow: 'Each step starts after its dependencies finish.',
    supervisor: 'The first agent plans; specialists work; the final agent combines results.',
    handoff: 'Each specialist receives the previous specialist’s result.',
    council: 'Reviewers work independently; the final agent combines their results.',
  };
  const crew = () => host.crew().filter((row) => row.enabled && (row.primary || row.agent === 'orchestrator'
    || !Array.isArray(host.missionConfig(missionId)?.agents)
    || host.missionConfig(missionId).agents.includes(row.agent)));
  const agentName = (id) => host.crew().find((row) => row.agent === id || row._id === id)?.displayName ?? id ?? 'Agent';
  const selectTab = (next) => {
    tab = next;
    dialog.querySelectorAll('[data-op-tab]').forEach((button) => {
      const active = button.dataset.opTab === next;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    for (const name of ['plan', 'runs', 'evidence']) element(`op-panel-${name}`).hidden = name !== next;
    if (next === 'runs') renderRuns();
    if (next === 'evidence') { renderEvidenceSessions(); void loadEvidence(); }
  };
  wireTabs(dialog, 'data-op-tab', selectTab);

  function markDirty() {
    dirty = true;
    element('op-plan-save-state').textContent = 'Unsaved changes';
    element('op-discard-plan').hidden = false;
    element('op-run-plan').textContent = 'Save & run';
  }
  function defaultPlan() {
    return {
      name: host.missionConfig(missionId)?.title || 'Mission plan', strategy: 'workflow',
      steps: [], budget: { steps: 20, timeoutMs: 600000, turns: 20, toolCalls: 20, spend: 5 },
    };
  }
  function setPlanBusy(busy, label = '') {
    element('op-plan-form').inert = busy;
    element('op-plan-form').setAttribute('aria-busy', String(busy));
    element('op-panel-plan').setAttribute('aria-busy', String(busy));
    if (label) element('op-plan-save-state').textContent = label;
  }
  function subscribeToMission(id) {
    if (subscribedMission === id && workflowSubscription) return;
    workflowSubscription?.stop();
    subscribedMission = id;
    workflowSubscription = Meteor.subscribe('constellation.workflows', id, {
      onReady() { if (missionId === id && dialog.open && tab === 'runs') renderRuns(); },
      onError(error) { host.toast(error.reason || 'Could not load mission runs.', 'error'); },
    });
  }
  function setPlan(value) {
    plan = structuredClone(value ?? defaultPlan()); dirty = false;
    element('op-plan-name').value = plan.name;
    element('op-plan-strategy').value = plan.strategy;
    element('op-budget-steps').value = plan.budget?.steps ?? 20;
    element('op-budget-time').value = (plan.budget?.timeoutMs ?? 600000) / 60000;
    element('op-budget-spend').value = plan.budget?.spend ?? 5;
    element('op-budget-turns').value = plan.budget?.turns ?? 20;
    element('op-budget-tool-calls').value = plan.budget?.toolCalls ?? 20;
    element('op-plan-version').textContent = definition ? `Version ${definition.revision}` : 'Not saved';
    element('op-plan-save-state').textContent = definition ? 'All changes saved' : 'Not saved';
    element('op-discard-plan').hidden = true;
    element('op-run-plan').textContent = 'Run plan';
    renderSteps();
  }
  function collectPlan() {
    plan.name = element('op-plan-name').value.trim();
    plan.strategy = element('op-plan-strategy').value;
    plan.budget = { ...plan.budget, steps: +element('op-budget-steps').value,
      timeoutMs: +element('op-budget-time').value * 60000, spend: +element('op-budget-spend').value,
      turns: +element('op-budget-turns').value, toolCalls: +element('op-budget-tool-calls').value };
    return plan;
  }
  function branchFields(step) {
    const sources = plan.steps.filter((row) => row.primitive === 'decision' && row.id !== step.id);
    if (!sources.length && !step.when) return '';
    const source = sources.find((row) => row.id === step.when?.stepId);
    const schema = decisionBranchSchema(source?.questions);
    const field = schema[step.when?.questionId];
    const fallback = step.when?.otherwise;
    const changed = step.when && !fallback && (!field || field.type !== step.when.type
      || (field.type === 'choice' && !field.choices.includes(step.when.value)));
    if (changed) return `<fieldset class="op-branch"><legend>Run condition</legend><p class="op-hint" role="status">The saved condition no longer matches this decision. Update it before saving the plan.</p><button type="button" class="secondary-action" data-branch-reset ${!source || !Object.keys(schema).length ? 'disabled' : ''}>Update condition</button></fieldset>`;
    return `<fieldset class="op-branch"><legend>Run condition</legend><label class="op-sr-only" for="branch-${escapeHtml(step.id)}">Decision for ${escapeHtml(step.label)}</label><select id="branch-${escapeHtml(step.id)}" data-branch-field="source"><option value="">Always, after dependencies</option>${sources.map((row) => `<option value="${escapeHtml(row.id)}" ${row.id === step.when?.stepId ? 'selected' : ''}>Based on ${escapeHtml(row.label)}</option>`).join('')}</select>
      ${step.when ? `<label>Continue when<select data-branch-field="mode"><option value="match" ${!fallback ? 'selected' : ''}>The result matches</option><option value="otherwise" ${fallback ? 'selected' : ''}>No other branch matches (fallback)</option></select></label>
      ${!fallback ? `<div class="op-form-row"><label>Answer<select data-branch-field="question" required>${Object.entries(schema).map(([id, value]) => `<option value="${escapeHtml(id)}" ${id === step.when.questionId ? 'selected' : ''}>${escapeHtml(id)} · ${value.type === 'noul' ? 'Yes probability' : value.type === 'score' ? 'Score' : 'Choice'}</option>`).join('')}</select></label><label>Comparison<select data-branch-field="operator">${(field?.type === 'choice' ? [['eq', 'Is'], ['neq', 'Is not']] : [['gte', 'At least'], ['gt', 'Greater than'], ['lte', 'At most'], ['lt', 'Less than'], ['eq', 'Equals'], ['neq', 'Does not equal']]).map(([value, label]) => `<option value="${value}" ${value === step.when.operator ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <div class="op-form-row"><label>${field?.type === 'noul' ? 'Probability (0–1)' : field?.type === 'score' ? `Score (0–${field.max})` : 'Choice'}${field?.type === 'choice' ? `<select data-branch-field="value">${(field.choices ?? []).map((value) => `<option value="${escapeHtml(value)}" ${value === step.when.value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select>` : `<input data-branch-field="value" type="number" min="${field?.min ?? 0}" max="${field?.max ?? 1}" step="any" value="${escapeHtml(step.when.value)}" required>`}</label>${field && field.type !== 'noul' ? `<label>Minimum confidence (optional)<input data-branch-field="confidence" type="number" min="0" max="1" step="any" placeholder="0–1" value="${escapeHtml(step.when.minConfidence ?? '')}"></label>` : ''}</div>` : ''}
      <p class="op-hint">${fallback ? 'Use a review checkpoint here to handle unmatched or uncertain answers.' : 'Add a fallback branch for unmatched or uncertain answers.'}</p>` : ''}</fieldset>`;
  }
  function firstCondition(source, questionId = Object.keys(source?.questions ?? {})[0]) {
    const field = decisionBranchSchema(source?.questions)[questionId];
    return { stepId: source.id, questionId: questionId ?? '', type: field?.type ?? 'choice',
      operator: field?.type === 'choice' ? 'eq' : 'gte', value: field?.type === 'choice' ? field.choices[0] ?? '' : field?.type === 'noul' ? 0.8 : field?.max ?? 1 };
  }
  function decisionInputFields(step) {
    const fields = step.inputFields ?? [];
    return fields.map((field) => {
      const value = step.state?.[field.key];
      const fromPrevious = step.context !== 'none' && step.contextField === field.key && step.dependsOn?.length;
      const required = field.required && !fromPrevious ? 'required' : '';
      return `<label>${escapeHtml(field.label)}${field.required ? '' : ' (optional)'}${field.type === 'text'
        ? `<textarea data-decision-input="${escapeHtml(field.key)}" data-input-type="text" rows="2" maxlength="6000" ${required} placeholder="${fromPrevious ? 'Optional context; previous results will be added here.' : 'Enter the information to evaluate.'}">${escapeHtml(value ?? '')}</textarea>`
        : field.type === 'number' ? `<input data-decision-input="${escapeHtml(field.key)}" data-input-type="number" type="number" step="any" value="${escapeHtml(value ?? '')}" ${required}>`
          : `<select data-decision-input="${escapeHtml(field.key)}" data-input-type="boolean" ${required}><option value="">Choose…</option><option value="true" ${value === true ? 'selected' : ''}>Yes</option><option value="false" ${value === false ? 'selected' : ''}>No</option></select>`}</label>`;
    }).join('');
  }
  function selectDecisionNode(step, node, preserveValues = false) {
    const previous = step.state ?? {};
    step.nodeId = node?._id ?? ''; step.nodeRevision = node?.revision; step.nodeName = node?.name;
    step.questions = node?.questions ?? {}; step.inputFields = node?.inputFields ?? [];
    step.state = preserveValues ? Object.fromEntries(step.inputFields.filter((field) =>
      typeof previous[field.key] === (field.type === 'text' ? 'string' : field.type)).map((field) => [field.key, previous[field.key]])) : {};
    step.contextField = step.inputFields.find((item) => item.key === step.contextField && item.type === 'text')?.key
      ?? step.inputFields.find((item) => item.type === 'text')?.key ?? '';
  }
  function renderSteps(focusId) {
    plan.steps = workflowDependencies(plan.steps, plan.strategy);
    element('op-strategy-hint').textContent = strategyHints[plan.strategy];
    const agents = crew();
    const container = element('op-plan-steps');
    container.innerHTML = plan.steps.length ? plan.steps.map((step, index) => {
      const review = step.primitive === 'approval';
      const decision = step.primitive === 'decision';
      const nodes = decisionNodes.filter((row) => row.availableAgents.includes(step.agent));
      const selectedNode = nodes.find((row) => row._id === step.nodeId);
      const available = agents.some((row) => row.agent === step.agent);
      const previousIds = plan.steps.slice(0, index).map((row) => row.id);
      const allPrevious = previousIds.length > 1 && step.dependsOn?.length === previousIds.length
        && previousIds.every((id) => step.dependsOn.includes(id));
      const branchGroups = plan.steps.filter((row) => row.primitive === 'decision').map((row) => ({ ...row,
        branches: plan.steps.filter((branch) => branch.id !== step.id && branch.when?.stepId === row.id).map((branch) => branch.id),
      })).filter((row) => row.branches.length > 1);
      const selectedBranchGroup = branchGroups.find((row) => step.dependsOn?.length === row.branches.length && row.branches.every((id) => step.dependsOn.includes(id)));
      const selectedMultiple = step.dependsOn?.length > 1 && !allPrevious && !selectedBranchGroup;
      const dependencyField = `<label>Start after<select data-step-field="dependsOn" ${plan.strategy !== 'workflow' ? 'disabled' : ''}><option value="" ${!step.dependsOn?.length ? 'selected' : ''}>Run start</option>${selectedMultiple ? `<option value="__selected__" selected disabled>${step.dependsOn.length} selected steps</option>` : ''}${previousIds.length ? `<option value="__all__" ${allPrevious && !selectedBranchGroup ? 'selected' : ''}>All previous steps</option>` : ''}${branchGroups.map((row) => `<option value="__branches__:${escapeHtml(row.id)}" ${selectedBranchGroup?.id === row.id ? 'selected' : ''}>Branches of ${escapeHtml(row.label)}</option>`).join('')}${plan.steps.filter((row) => row.id !== step.id).map((previous) => `<option value="${escapeHtml(previous.id)}" ${step.dependsOn?.length === 1 && step.dependsOn.includes(previous.id) ? 'selected' : ''}>${escapeHtml(previous.label)}</option>`).join('')}</select>${selectedMultiple ? `<span class="op-hint">${escapeHtml(step.dependsOn.map((id) => plan.steps.find((row) => row.id === id)?.label ?? id).join(', '))}</span>` : ''}</label>`;
      return `<article class="op-step-editor" data-step-id="${escapeHtml(step.id)}">
        <div class="op-step-heading"><span class="op-step-number">${index + 1}</span><label class="op-step-title"><span class="op-sr-only">Step ${index + 1} name</span><input data-step-field="label" value="${escapeHtml(step.label)}" placeholder="${review ? 'Review checkpoint' : 'Step name'}" maxlength="120" required></label><div class="op-step-actions"><button data-step-move="-1" type="button" aria-label="Move step ${index + 1} up" ${index === 0 ? 'disabled' : ''}>↑</button><button data-step-move="1" type="button" aria-label="Move step ${index + 1} down" ${index === plan.steps.length - 1 ? 'disabled' : ''}>↓</button><button data-step-remove type="button" aria-label="Remove step ${index + 1}">×</button></div></div>
        <div class="op-step-body">${review ? `<div class="op-form-row"><span class="op-hint">Pauses until you approve or decline.</span>${dependencyField}</div>` : `<div class="op-form-row"><label>Agent<select data-step-field="agent" required>${!available && step.agent ? `<option value="${escapeHtml(step.agent)}" disabled selected>${escapeHtml(agentName(step.agent))} · unavailable</option>` : ''}${agents.map((row) => `<option value="${escapeHtml(row.agent)}" ${row.agent === step.agent ? 'selected' : ''}>${escapeHtml(row.displayName)}</option>`).join('')}</select></label>${dependencyField}</div>`}
        ${decision ? `<label>Decision node<select data-step-field="nodeId" required><option value="">Choose a decision</option>${step.nodeId && !selectedNode ? `<option value="${escapeHtml(step.nodeId)}" selected disabled>${escapeHtml(step.nodeName ?? 'Decision')} · unavailable</option>` : ''}${nodes.map((row) => `<option value="${escapeHtml(row._id)}" ${row._id === step.nodeId ? 'selected' : ''}>${escapeHtml(row.name)} · v${row.revision}</option>`).join('')}</select></label>${!nodes.length ? '<p class="op-hint">Create a decision in Capabilities → Decisions and grant this agent access.</p>' : ''}${selectedNode && selectedNode.revision !== step.nodeRevision ? `<div class="op-inline-actions"><span class="op-hint">Saved version ${escapeHtml(step.nodeRevision)} is out of date.</span><button data-node-refresh type="button" class="secondary-action">Use version ${selectedNode.revision}</button></div>` : ''}` : ''}
        ${decision ? decisionInputFields(step) : `<label>${review ? 'What to review' : 'Task'}<textarea data-step-field="prompt" rows="2" maxlength="6000" placeholder="${review ? 'Check the previous results before continuing.' : 'Describe the result this agent should produce.'}" ${review ? '' : 'required'}>${escapeHtml(step.prompt)}</textarea></label>`}
        ${review ? '' : `<label class="op-check"><input data-step-field="context" type="checkbox" ${step.context !== 'none' ? 'checked' : ''}>Include results from “Start after” steps</label><label class="op-check"><input data-step-field="requireApproval" type="checkbox" ${step.requireApproval ? 'checked' : ''}>Review before this step starts</label>`}
        ${decision && step.context !== 'none' ? `<label>Add previous results to<select data-step-field="contextField"><option value="">Choose a text input</option>${(step.inputFields ?? []).filter((field) => field.type === 'text').map((field) => `<option value="${escapeHtml(field.key)}" ${field.key === step.contextField ? 'selected' : ''}>${escapeHtml(field.label)}</option>`).join('')}</select></label>` : ''}
        ${step.dependsOn?.length > 1 ? `<label>After branches finish<select data-step-field="dependencyMode"><option value="all" ${step.dependencyMode !== 'any' ? 'selected' : ''}>Continue only if every dependency ran</option><option value="any" ${step.dependencyMode === 'any' ? 'selected' : ''}>Continue if any dependency ran</option></select></label>` : ''}
        ${branchFields(step)}</div>
      </article>`;
    }).join('') : `<div class="op-empty"><strong>No steps yet</strong><p>Add an agent task or a review checkpoint.</p></div>`;
    element('op-run-plan').disabled = !plan.steps.length;
    element('op-add-step').disabled = plan.steps.length >= 32;
    element('op-add-review').disabled = plan.steps.length >= 32;
    element('op-add-decision').disabled = plan.steps.length >= 32 || plan.strategy !== 'workflow';
    element('op-add-decision').title = plan.strategy !== 'workflow' ? 'Choose Follow these steps to add decisions.' : '';
    element('op-plan-strategy').disabled = plan.steps.some((row) => row.primitive === 'decision' || row.when);
    element('op-budget-steps').min = String(Math.max(1, plan.steps.length));
    element('op-budget-turns').min = String(Math.max(1, plan.steps.filter((row) => row.primitive === 'agent').length));
    container.querySelectorAll('[data-step-field]').forEach((input) => {
      input.addEventListener('input', () => {
        const step = plan.steps.find((row) => row.id === input.closest('[data-step-id]').dataset.stepId);
        const field = input.dataset.stepField;
        step[field] = field === 'dependsOn' ? (input.value.startsWith('__branches__:')
          ? plan.steps.filter((row) => row.id !== step.id && row.when?.stepId === input.value.slice('__branches__:'.length)).map((row) => row.id)
          : input.value === '__all__' ? plan.steps.slice(0, plan.steps.indexOf(step)).map((row) => row.id) : input.value ? [input.value] : [])
          : field === 'context' ? (input.checked ? 'dependencies' : 'none') : input.type === 'checkbox' ? input.checked : input.value;
        if (field === 'nodeId') {
          const node = decisionNodes.find((row) => row._id === input.value);
          selectDecisionNode(step, node);
        }
        if (step.when) step.dependsOn = [...new Set([...step.dependsOn, step.when.stepId])];
        markDirty();
        if (['nodeId', 'agent', 'dependsOn', 'context', 'contextField'].includes(field)) renderSteps();
      });
    });
    container.querySelectorAll('[data-node-refresh]').forEach((button) => button.addEventListener('click', () => {
      const step = plan.steps.find((row) => row.id === button.closest('[data-step-id]').dataset.stepId);
      selectDecisionNode(step, decisionNodes.find((row) => row._id === step.nodeId), true);
      markDirty(); renderSteps();
      host.toast('Decision version updated. Review its inputs and branch conditions before saving.');
    }));
    container.querySelectorAll('[data-decision-input]').forEach((input) => input.addEventListener('input', () => {
      const step = plan.steps.find((row) => row.id === input.closest('[data-step-id]').dataset.stepId);
      step.state ??= {};
      if (input.value === '') delete step.state[input.dataset.decisionInput];
      else step.state[input.dataset.decisionInput] = input.dataset.inputType === 'number' ? +input.value
        : input.dataset.inputType === 'boolean' ? input.value === 'true' : input.value;
      markDirty();
    }));
    container.querySelectorAll('[data-branch-field]').forEach((input) => input.addEventListener('input', () => {
      const step = plan.steps.find((row) => row.id === input.closest('[data-step-id]').dataset.stepId);
      const field = input.dataset.branchField;
      const source = plan.steps.find((row) => row.id === (field === 'source' ? input.value : step.when?.stepId));
      if (field === 'source') { if (source) { step.when = firstCondition(source); step.dependsOn = [source.id]; } else delete step.when; }
      else if (field === 'mode') step.when = input.value === 'otherwise' ? { stepId: source.id, otherwise: true } : firstCondition(source);
      else if (field === 'question') step.when = firstCondition(source, input.value);
      else if (field === 'operator') step.when.operator = input.value;
      else if (field === 'value') step.when.value = step.when.type === 'choice' ? input.value : +input.value;
      else if (field === 'confidence') { if (input.value === '') delete step.when.minConfidence; else step.when.minConfidence = +input.value; }
      if (step.when) step.dependsOn = [...new Set([...step.dependsOn, step.when.stepId])];
      markDirty(); if (['source', 'mode', 'question'].includes(field)) renderSteps();
    }));
    container.querySelectorAll('[data-branch-reset]').forEach((button) => button.addEventListener('click', () => {
      const step = plan.steps.find((row) => row.id === button.closest('[data-step-id]').dataset.stepId);
      step.when = firstCondition(plan.steps.find((row) => row.id === step.when.stepId));
      markDirty(); renderSteps();
    }));
    container.querySelectorAll('[data-step-remove]').forEach((button) => button.addEventListener('click', () => {
      const id = button.closest('[data-step-id]').dataset.stepId;
      if (plan.steps.some((row) => row.when?.stepId === id)) {
        host.toast('Remove this decision’s branch conditions before removing the decision.', 'error'); return;
      }
      const index = plan.steps.findIndex((row) => row.id === id);
      const removed = plan.steps.splice(index, 1)[0];
      plan.steps.forEach((row) => { row.dependsOn = [...new Set((row.dependsOn ?? []).flatMap((dep) => dep === id ? removed.dependsOn ?? [] : [dep]))]; });
      markDirty(); renderSteps(plan.steps[Math.min(index, plan.steps.length - 1)]?.id);
    }));
    container.querySelectorAll('[data-step-move]').forEach((button) => button.addEventListener('click', () => {
      const id = button.closest('[data-step-id]').dataset.stepId;
      const index = plan.steps.findIndex((row) => row.id === id);
      const destination = index + Number(button.dataset.stepMove);
      [plan.steps[index], plan.steps[destination]] = [plan.steps[destination], plan.steps[index]];
      // Display order never silently rewrites an explicitly configured workflow graph.
      markDirty(); renderSteps(id);
    }));
    if (focusId) container.querySelector(`[data-step-id="${CSS.escape(focusId)}"] input`)?.focus();
  }
  function addStep(primitive) {
    const step = { id: `step-${uniqueKey()}`, label: primitive === 'approval' ? 'Review results' : primitive === 'decision' ? 'Decision' : `Agent task ${plan.steps.filter((row) => row.primitive === 'agent').length + 1}`,
      primitive, ...(['agent', 'decision'].includes(primitive) ? { agent: crew()[0]?.agent ?? 'orchestrator' } : {}), prompt: '',
      ...(primitive === 'decision' ? { state: {}, nodeId: '', questions: {}, inputFields: [], contextField: '' } : {}),
      dependsOn: plan.steps.length ? [plan.steps.at(-1).id] : [], context: 'dependencies', requireApproval: primitive === 'decision' };
    plan.steps.push(step); markDirty(); renderSteps(step.id);
  }
  async function savePlan() {
    if (!plan || !element('op-plan-form').reportValidity()) return false;
    const requestedMission = missionId;
    const generation = planGeneration;
    const input = { ...collectPlan(), missionId: requestedMission, expectedRevision: definition?.revision ?? 0 };
    setPlanBusy(true, 'Saving…');
    try {
      const result = await Meteor.callAsync('constellation.workflowSave', input);
      const saved = result?.definition ?? (await Meteor.callAsync('constellation.workflowGet', { missionId: requestedMission })).definition;
      if (requestedMission !== missionId || generation !== planGeneration) return false;
      definition = saved; setPlan(definition); return true;
    } finally { if (requestedMission === missionId && generation === planGeneration) setPlanBusy(false, dirty ? 'Unsaved changes' : definition ? 'All changes saved' : 'Not saved'); }
  }
  element('op-add-step').addEventListener('click', () => addStep('agent'));
  element('op-add-review').addEventListener('click', () => addStep('approval'));
  element('op-add-decision').addEventListener('click', () => addStep('decision'));
  element('op-plan-strategy').addEventListener('change', () => { collectPlan(); element('op-strategy-hint').textContent = strategyHints[plan.strategy]; renderSteps(); });
  element('op-plan-form').addEventListener('input', markDirty);
  element('op-plan-form').addEventListener('change', markDirty);
  element('op-plan-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(element('op-save-plan'), element('op-dialog-errors'), 'Saving…', savePlan);
  });
  element('op-discard-plan').addEventListener('click', (event) => void busyAction(event.currentTarget, element('op-dialog-errors'), 'Loading…', async () => {
    const requestedMission = missionId;
    const generation = ++planGeneration;
    setPlanBusy(true, 'Loading…');
    try {
      const data = await Meteor.callAsync('constellation.workflowGet', { missionId: requestedMission });
      if (requestedMission !== missionId || generation !== planGeneration) return;
      decisionNodes = data.decisionNodes ?? [];
      definition = data.definition; setPlan(definition);
    } finally { if (requestedMission === missionId && generation === planGeneration) setPlanBusy(false, dirty ? 'Unsaved changes' : definition ? 'All changes saved' : 'Not saved'); }
  }));
  element('op-run-plan').addEventListener('click', (event) => void busyAction(event.currentTarget, element('op-dialog-errors'), 'Starting…', async () => {
    const requestedMission = missionId;
    const generation = planGeneration;
    if ((dirty || !definition) && !await savePlan()) return;
    if (requestedMission !== missionId || generation !== planGeneration) return;
    setPlanBusy(true, 'Starting…');
    try {
      const result = await Meteor.callAsync('constellation.workflowRun', { missionId: requestedMission, definitionRevision: definition.revision, requestKey: uniqueKey() });
      if (requestedMission !== missionId || generation !== planGeneration) return;
      selectedRunId = result?.runId ?? result?._id ?? result;
      selectTab('runs');
    } finally { if (requestedMission === missionId && generation === planGeneration) setPlanBusy(false, dirty ? 'Unsaved changes' : 'All changes saved'); }
  }));
  async function openPlan(next = 'plan', options = {}) {
    const requestedMission = options.missionId ?? host.currentMission();
    if (dirty && missionId !== requestedMission) {
      host.toast('Save or reload your open plan before opening another mission’s plan.', 'error');
      showDialog(dialog, options.control); return dialog;
    }
    if (dirty && missionId === requestedMission) {
      if (options.runId) selectedRunId = options.runId;
      showDialog(dialog, options.control); selectTab(next); return dialog;
    }
    const generation = ++planGeneration;
    missionId = requestedMission; evidenceSessionId = missionId; selectedRunId = options.runId ?? null; evidence = null; plan = null; definition = null; dirty = false;
    subscribeToMission(requestedMission);
    element('mission-plan-dialog-scope').textContent = host.missionConfig(missionId)?.title ?? 'Current mission';
    showDialog(dialog, options.control);
    selectTab('plan');
    element('op-plan-form').reset();
    element('op-plan-steps').innerHTML = '<div class="op-loading" role="status"><span></span>Loading plan…</div>';
    element('op-retry-plan-load')?.remove();
    setPlanBusy(true, 'Loading…');
    await busyAction(null, element('op-dialog-errors'), 'Loading…', async () => {
      const data = await Meteor.callAsync('constellation.workflowGet', { missionId: requestedMission });
      if (requestedMission !== missionId || generation !== planGeneration) return;
      decisionNodes = data.decisionNodes ?? [];
      definition = data.definition ?? null; setPlan(definition); selectTab(next);
    });
    if (requestedMission !== missionId || generation !== planGeneration) return;
    if (plan) setPlanBusy(false);
    else {
      element('op-plan-form').setAttribute('aria-busy', 'false');
      element('op-panel-plan').setAttribute('aria-busy', 'false');
      element('op-plan-save-state').textContent = 'Not loaded';
      element('op-plan-steps').innerHTML = '<div class="op-empty">The plan could not be loaded.</div>';
      const retry = document.createElement('button');
      retry.id = 'op-retry-plan-load'; retry.className = 'secondary-action'; retry.textContent = 'Reload plan';
      retry.addEventListener('click', () => void openPlan(next, { ...options, missionId: requestedMission }));
      element('op-dialog-errors').append(retry);
    }
    return dialog;
  }
  element('open-mission-plan').addEventListener('click', () => void openPlan());
  element('open-mission-evidence').addEventListener('click', () => void openPlan('evidence'));

  function rememberRunContext(stepId, action) {
    const originMission = missionId;
    const originRun = selectedRunId;
    const positions = [dialog, element('op-run-list'), element('op-run-detail')]
      .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    return () => {
      if (!dialog.open || missionId !== originMission) return;
      // Live run updates can replace the button while its child window is open.
      const control = selectedRunId === originRun
        ? element('op-run-detail').querySelector(`[data-run-step="${CSS.escape(stepId)}"] [${action}]`)
        : null;
      (control ?? element('op-tab-runs')).focus({ preventScroll: true });
      if (selectedRunId === originRun) for (const { node, top, left } of positions) {
        node.scrollTop = top; node.scrollLeft = left;
      }
    };
  }

  function openStepEvidence(run, step, control) {
    restoreEvidenceContext = rememberRunContext(step.id, 'data-run-evidence');
    evidenceSessionId = step.childSessionId; evidence = null; selectedTrace = null;
    element('run-evidence-dialog-scope').textContent = `${step.label} · ${dateLabel(run.createdAt)} · Plan v${run.definitionRevision}`;
    evidenceDialog.append(evidencePanel);
    evidencePanel.hidden = false;
    evidencePanel.setAttribute('role', 'region');
    evidencePanel.setAttribute('aria-labelledby', 'run-evidence-dialog-title');
    showDialog(evidenceDialog, control);
    evidencePanel.querySelector('.op-scroll').scrollTop = 0;
    renderEvidenceSessions();
    void loadEvidence();
  }

  function renderRuns() {
    const runs = Runs.find({ missionId }, { sort: { createdAt: -1 }, limit: 40 }).fetch();
    const stepStatus = (step) => step.status === 'awaiting' && step.waitReason === 'processing' ? 'running' : step.status;
    const runStatus = (run) => {
      const waiting = run.steps.filter((step) => step.status === 'awaiting');
      return run.status === 'awaiting' && waiting.length && waiting.every((step) => step.waitReason === 'processing')
        ? 'running' : run.status;
    };
    const needsToolReview = (step) => step.status === 'awaiting' && step.waitReason === 'approval';
    element('op-run-count').textContent = String(runs.length);
    if (!runs.length && workflowSubscription && !workflowSubscription.ready()) {
      element('op-run-list').innerHTML = '<div class="op-loading" role="status"><span></span>Loading runs…</div>';
      element('op-run-detail').innerHTML = '';
      return;
    }
    if (!runs.some((row) => row._id === selectedRunId)) selectedRunId = runs[0]?._id ?? null;
    element('op-run-list').innerHTML = runs.length ? runs.map((run) => `<button class="op-run-item ${run._id === selectedRunId ? 'selected' : ''}" data-run-id="${escapeHtml(run._id)}" type="button" aria-pressed="${run._id === selectedRunId}"><span>${escapeHtml(dateLabel(run.createdAt))}</span>${stateBadge(runStatus(run))}<small>Plan v${escapeHtml(run.definitionRevision)}${run.parentRunId ? ' · Restarted' : ''}</small></button>`).join('') : '<div class="op-empty"><strong>No runs yet</strong><p>Save a plan, then select Run plan.</p><button class="secondary-action" id="op-go-plan" type="button">Open plan</button></div>';
    element('op-go-plan')?.addEventListener('click', () => selectTab('plan'));
    element('op-run-list').querySelectorAll('[data-run-id]').forEach((button) => button.addEventListener('click', () => { selectedRunId = button.dataset.runId; renderRuns(); }));
    const run = runs.find((row) => row._id === selectedRunId);
    const detail = element('op-run-detail');
    if (!run) { detail.innerHTML = '<div class="op-empty"><strong>Run history</strong><p>Step results and review decisions appear here.</p></div>'; return; }
    const active = ['queued', 'running', 'awaiting'].includes(run.status);
    const summaryFor = (step) => step.primitive === 'agent' && !host.missionConfig(missionId)?.debugTraces
      ? sanitizeCleanAssistantContent(step.summary ?? '') : step.summary;
    detail.innerHTML = `<div class="op-section-heading"><div><h3>${escapeHtml(run.name)}</h3><p class="op-hint">${escapeHtml(dateLabel(run.createdAt))} · Plan v${escapeHtml(run.definitionRevision)}</p></div>${stateBadge(runStatus(run))}${active ? '<button id="op-stop-run" class="secondary-action" type="button">Stop run</button>' : ''}</div>
      ${run.error ? `<div class="op-error" role="alert">${escapeHtml(run.error?.reason ?? run.error)}</div>` : ''}
      <ol class="op-timeline">${run.steps.map((step, index) => `<li data-run-step="${escapeHtml(step.id)}" data-state="${escapeHtml(stepStatus(step))}"><span class="op-timeline-number">${index + 1}</span><article><header><div><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.primitive === 'decision' ? `${step.nodeName ?? 'Decision'} · v${step.nodeRevision} · ${agentName(step.agent)}` : step.agent ? agentName(step.agent) : 'Review checkpoint')}${step.attempts > 1 ? ` · Attempt ${step.attempts}` : ''}</small></div>${stateBadge(stepStatus(step))}</header>
      ${step.when ? `<p class="op-branch-summary">${escapeHtml(workflowConditionLabel(step.when, run.steps))}</p>` : ''}
      ${step.summary ? `<div class="op-result">${escapeHtml(summaryFor(step))}</div>` : ''}${step.error ? `<p class="op-error">${escapeHtml(step.error?.reason ?? step.error)}</p>` : ''}
      ${step.status === 'awaiting' && step.fingerprint && !step.childSessionId ? `<div class="op-approval"><strong>Review before continuing</strong><p>${escapeHtml(step.prompt ?? 'Check the task and previous results.')}</p><div class="op-inline-actions"><button type="button" class="primary-action" data-run-approve="true">Approve step</button><button type="button" class="secondary-action" data-run-approve="false">Decline</button></div></div>` : ''}
      <div class="op-inline-actions">${step.childSessionId ? `<button type="button" class="${needsToolReview(step) ? 'primary-action' : 'op-link'}" data-run-conversation>${needsToolReview(step) ? 'Review tool request' : 'View conversation'}</button><button type="button" class="op-link" data-run-evidence>View evidence</button>` : ''}${!active && step.status === 'failed' && step.retryAllowed === true ? '<button type="button" class="secondary-action" data-run-retry>Retry step</button>' : ''}${!active && step.replayAllowed === true ? '<button type="button" class="op-link" data-run-replay>Restart from here</button>' : ''}</div></article></li>`).join('')}</ol>`;
    element('op-stop-run')?.addEventListener('click', (event) => void busyAction(event.currentTarget, detail, 'Stopping…', () => Meteor.callAsync('constellation.workflowCancel', { runId: run._id })));
    detail.querySelectorAll('[data-run-step]').forEach((row) => {
      const step = run.steps.find((item) => item.id === row.dataset.runStep);
      row.querySelector('[data-run-conversation]')?.addEventListener('click', () => {
        const restore = rememberRunContext(step.id, 'data-run-conversation');
        const child = host.openChild(step.childSessionId, step.agent);
        child.addEventListener('close', restore, { once: true });
      });
      row.querySelector('[data-run-evidence]')?.addEventListener('click', (event) => openStepEvidence(run, step, event.currentTarget));
      row.querySelectorAll('[data-run-approve]').forEach((button) => button.addEventListener('click', () => void busyAction(button, detail, 'Saving…', () => Meteor.callAsync('constellation.workflowApprove', { runId: run._id, stepId: step.id, fingerprint: step.fingerprint, approved: button.dataset.runApprove === 'true' }))));
      row.querySelector('[data-run-retry]')?.addEventListener('click', (event) => void busyAction(event.currentTarget, detail, 'Retrying…', () => Meteor.callAsync('constellation.workflowRetry', { runId: run._id, stepId: step.id })));
      row.querySelector('[data-run-replay]')?.addEventListener('click', (event) => void busyAction(event.currentTarget, detail, 'Restarting…', async () => {
        const result = await Meteor.callAsync('constellation.workflowReplay', { runId: run._id, stepId: step.id, requestKey: uniqueKey() });
        selectedRunId = result?.runId ?? result?._id ?? result; renderRuns();
      }));
    });
  }

  function renderEvidenceSessions() {
    const steps = Runs.find({ missionId }, { sort: { createdAt: -1 }, limit: 40 }).fetch().flatMap((run) => run.steps.filter((step) => step.childSessionId).map((step) => ({ ...step, runDate: run.createdAt })));
    const sessions = [{ id: missionId, label: 'Main chat' }, ...steps.map((step) => ({ id: step.childSessionId, label: `${step.label} · ${dateLabel(step.runDate)}` }))];
    if (!sessions.some((row) => row.id === evidenceSessionId)) evidenceSessionId = missionId;
    element('op-evidence-session').innerHTML = sessions.map((row) => `<option value="${escapeHtml(row.id)}" ${row.id === evidenceSessionId ? 'selected' : ''}>${escapeHtml(row.label)}</option>`).join('');
  }
  element('op-evidence-session').addEventListener('change', (event) => {
    evidenceSessionId = event.target.value; evidence = null; selectedTrace = null; void loadEvidence();
  });
  async function loadEvidence() {
    if (evidenceLoading || !missionId) return;
    evidenceLoading = true;
    const requestedSessionId = evidenceSessionId ?? missionId;
    const generation = ++evidenceGeneration;
    const content = element('op-evidence-content');
    content.setAttribute('aria-busy', 'true');
    if (!evidence) content.innerHTML = '<div class="op-loading" role="status"><span></span>Loading evidence…</div>';
    await busyAction(null, content, 'Loading…', async () => {
      const result = await Meteor.callAsync('constellation.sessionEvidence', { sessionId: requestedSessionId, includeDebug: host.missionConfig(missionId)?.debugTraces === true });
      if (generation !== evidenceGeneration || requestedSessionId !== (evidenceSessionId ?? missionId)) return;
      if (JSON.stringify(evidence) === JSON.stringify(result)) return;
      evidence = result;
      const traces = evidence.traces ?? [];
      if (!traces.some((row) => row._id === selectedTrace)) selectedTrace = traces[0]?._id;
      element('op-evidence-turn').innerHTML = traces.map((trace) => `<option value="${escapeHtml(trace._id)}" ${trace._id === selectedTrace ? 'selected' : ''}>${escapeHtml(agentName(trace.agent))} · ${escapeHtml(dateLabel(trace.createdAt ?? trace.startedAt))}</option>`).join('') || '<option>No recorded turns</option>';
      renderEvidence();
    });
    content.setAttribute('aria-busy', 'false');
    evidenceLoading = false;
    if (evidenceVisible() && requestedSessionId !== (evidenceSessionId ?? missionId)) void loadEvidence();
  }
  function memoryList(items, fallback) {
    return items?.length ? `<ul class="op-memory-items">${items.map((row) => `<li>${escapeHtml(typeof row === 'string' ? row : row.title ?? row.text ?? row.name ?? row.id ?? row._id)}</li>`).join('')}</ul>` : `<p class="op-hint">${fallback}</p>`;
  }
  function renderEvidence() {
    const content = element('op-evidence-content');
    const expanded = [...content.querySelectorAll('details[open]')].map((row) => row.dataset.observationId).filter(Boolean);
    const trace = evidence?.traces?.find((row) => row._id === selectedTrace);
    const manifest = (evidence?.manifests ?? []).find((row) => row.traceId === selectedTrace)
      ?? (evidence?.manifests ?? []).find((row) => trace?.memoryFrameId && row.memoryFrameId === trace.memoryFrameId) ?? trace?.manifest;
    const spans = (evidence?.spans ?? []).filter((row) => row.traceId === selectedTrace);
    const observations = (evidence?.observations ?? []).filter((row) => !trace || row.frameId === manifest?.memoryFrameId);
    if (!trace) { content.innerHTML = '<div class="op-empty"><strong>No recorded turns yet</strong><p>Send a message or run a plan to capture activity and memory evidence.</p></div>'; return; }
    const memories = manifest?.memory ?? manifest?.memoryFrame ?? {};
    content.innerHTML = `<div class="op-section-heading"><div><h3>${escapeHtml(agentName(trace.agent))}</h3><p class="op-hint">${escapeHtml(trace.summary || 'Agent turn')}</p></div>${stateBadge(trace.status)}</div>
      <div class="op-evidence-grid"><section><h3>Memory at turn start</h3><p class="op-hint">Available to the agent. Memory searches appear in Activity.</p><h4>Practices</h4>${memoryList(memories.practices ?? manifest?.practices, 'No practices included.')}<h4>Facts</h4>${memoryList(memories.facts ?? manifest?.facts, 'No facts included.')}<h4>Experiences</h4>${memoryList(memories.experiences ?? manifest?.experiences, 'No experiences included.')}${memories.constitution ? `<details class="op-details"><summary>Constitution v${escapeHtml(memories.constitution.revision)}</summary><div class="op-result">${escapeHtml(memories.constitution.content ?? 'Exact version recorded.')}</div></details>` : ''}</section>
      <section><h3>Available capabilities</h3><h4>Tools</h4>${memoryList(manifest?.tools ?? manifest?.capabilities?.tools, 'No tool manifest available.')}<h4>Skills</h4>${memoryList(manifest?.skills ?? manifest?.capabilities?.skills, 'No skills included.')}<h4>Model</h4><p>${escapeHtml(manifest?.model ?? trace.model ?? 'Not recorded')}</p></section></div>
      <section class="op-evidence-section"><h3>Activity</h3><ol class="op-span-list">${spans.map((span) => `<li><div><strong>${escapeHtml(span.name ?? span.kind)}</strong><span>${escapeHtml(span.summary ?? '')}</span></div>${stateBadge(span.status)}<small>${span.durationMs != null ? `${Math.round(span.durationMs)} ms` : ''}</small></li>`).join('') || '<li>No additional activity recorded.</li>'}</ol></section>
      <section class="op-evidence-section"><h3>Observations</h3>${observations.length ? observations.map((observation) => {
        const sourceCount = (observation.sourceMessageIds ?? observation.sources ?? []).length;
        return `<details class="op-observation" data-observation-id="${escapeHtml(observation._id)}"><summary><span class="op-observation-chevron" aria-hidden="true">›</span><span class="op-observation-heading"><strong>${escapeHtml(agentName(observation.agent ?? trace.agent))}</strong><small>${sourceCount} source ${sourceCount === 1 ? 'message' : 'messages'} · ${escapeHtml(dateLabel(observation.createdAt))}</small></span>${stateBadge(observation.processing ? 'reflecting' : observation.status ?? 'observed')}<span class="op-observation-preview">${escapeHtml(observation.summary ?? 'Observation')}</span></summary><div class="op-result op-observation-body">${escapeHtml(observation.summary)}</div>${observation.error ? `<p class="op-error">${escapeHtml(observation.error)}</p>` : ''}${observation.candidate ? `<dl class="op-candidate"><dt>Expected</dt><dd>${escapeHtml(observation.candidate.expected)}</dd><dt>Observed</dt><dd>${escapeHtml(observation.candidate.observed)}</dd><dt>Lesson</dt><dd>${escapeHtml(observation.candidate.lesson)}</dd></dl>` : ''}<div class="op-inline-actions"><button class="secondary-action" data-observation-source="${escapeHtml(observation._id)}" type="button">View source</button>${observation.status === 'admitting' && !observation.processing ? `<button class="primary-action" data-observation-admit="${escapeHtml(observation._id)}" type="button">Retry recording</button>` : ''}${!['admitted', 'admitting', 'dismissed'].includes(observation.status) ? `<button class="secondary-action" data-observation-draft="${escapeHtml(observation._id)}" type="button">${observation.candidate ? 'Edit draft' : 'Draft experience'}</button><button class="op-link" data-observation-reflect="${escapeHtml(observation._id)}" type="button" ${observation.processing ? 'disabled' : ''}>Reflect with agent</button>${observation.status === 'candidate' ? `<button class="primary-action" data-observation-admit="${escapeHtml(observation._id)}" type="button">Approve experience</button>` : ''}<button class="op-link" data-observation-dismiss="${escapeHtml(observation._id)}" type="button">Dismiss</button>` : ''}</div></details>`;
      }).join('') : '<p class="op-hint">No observations for this turn.</p>'}</section>
      <div class="op-feedback"><span>Was this turn useful?</span><button data-evidence-feedback="positive" type="button" class="secondary-action">Yes</button><button data-evidence-feedback="negative" type="button" class="secondary-action">Needs work</button><span id="op-feedback-status" role="status"></span></div>
      ${host.missionConfig(missionId)?.debugTraces ? `<details class="op-details"><summary>Debug traces</summary><pre>${escapeHtml(JSON.stringify({ trace, manifest, spans, toolAudit: (evidence.debug ?? []).filter((row) => row.traceId === trace._id) }, null, 2))}</pre></details>` : ''}`;
    for (const id of expanded) { const row = content.querySelector(`[data-observation-id="${CSS.escape(id)}"]`); if (row) row.open = true; }
    content.querySelectorAll('[data-evidence-feedback]').forEach((button) => button.addEventListener('click', () => void busyAction(button, content, 'Saving…', async () => {
      await Meteor.callAsync('constellation.evidenceFeedback', { sessionId: evidenceSessionId ?? missionId, traceId: trace._id, rating: button.dataset.evidenceFeedback });
      element('op-feedback-status').textContent = 'Feedback saved';
    })));
    content.querySelectorAll('[data-observation-source]').forEach((button) => button.addEventListener('click', () => void busyAction(button, content, 'Loading…', async () => {
      const result = await Meteor.callAsync('constellation.observationSources', { sessionId: evidenceSessionId ?? missionId, observationId: button.dataset.observationSource });
      const area = document.createElement('div'); area.className = 'op-source-messages';
      area.innerHTML = (result.messages ?? result).map((row) => `<article><strong>${escapeHtml(row.from?.name ?? row.role)} · ${escapeHtml(dateLabel(row.createdAt))}</strong><p>${escapeHtml(row.content)}</p></article>`).join('') || '<p>Source messages are no longer available.</p>';
      button.replaceWith(area);
    })));
    content.querySelectorAll('[data-observation-draft]').forEach((button) => button.addEventListener('click', () => {
      editingObservation = observations.find((row) => row._id === button.dataset.observationDraft);
      for (const field of ['expected', 'observed', 'difference', 'lesson', 'context']) element(`observation-${field}`).value = editingObservation.candidate?.[field] ?? '';
      element('observation-confidence').value = String(editingObservation.candidate?.confidence ?? 0.75);
      const automatic = manifest?.learningPolicy?.experienceAdmission === 'automatic';
      element('observation-admission-hint').textContent = automatic ? 'This agent saves experiences automatically. Saving records this experience in its audit history.' : 'A draft needs your approval before it becomes an experience.';
      element('observation-save').textContent = automatic ? 'Record experience' : 'Save draft';
      showDialog(observationDialog, button);
    }));
    for (const [action, method, label] of [['reflect', 'observationReflect', 'Reflecting…'], ['admit', 'observationAdmit', 'Recording…'], ['dismiss', 'observationDismiss', 'Dismissing…']]) {
      content.querySelectorAll(`[data-observation-${action}]`).forEach((button) => {
        const observation = observations.find((row) => row._id === button.getAttribute(`data-observation-${action}`));
        const config = host.crew().find((row) => row._id === observation.agentId)
          ?? host.crew().find((row) => row.agent === (observation.agent ?? trace.agent));
        const model = config?.model === 'default' ? host.defaultModel?.() : config?.model;
        if (action === 'reflect' && model === LOCAL_MODEL) {
          const hint = document.createElement('p');
          hint.id = `observation-reflection-hint-${observation._id}`;
          hint.className = 'op-hint';
          hint.textContent = 'Agent reflection needs a live model. You can draft an experience manually.';
          button.disabled = true;
          button.setAttribute('aria-describedby', hint.id);
          button.closest('.op-inline-actions').after(hint);
          return;
        }
        button.addEventListener('click', () => void busyAction(button, content, label, async () => {
          const result = await Meteor.callAsync(`constellation.${method}`, { sessionId: evidenceSessionId ?? missionId, observationId: observation._id });
          if (action === 'reflect') {
            const message = result.processing ? 'Reflection is already running.'
              : result.status === 'admitted' ? 'Experience recorded.'
                : result.status === 'admitting' ? 'Experience is being recorded.'
                  : result.status === 'candidate' ? 'Draft experience ready for review.'
                    : result.status === 'dismissed' ? 'Observation dismissed.'
                      : 'Reflection complete. No new lesson identified.';
            host.toast(message);
          }
          await loadEvidence();
        }));
      });
    }
  }
  element('op-evidence-turn').addEventListener('change', (event) => { selectedTrace = event.target.value; renderEvidence(); });
  element('op-refresh-evidence').addEventListener('click', () => void loadEvidence());
  Meteor.setInterval(() => {
    if (evidenceVisible() && !observationDialog.open
      && !element('op-evidence-content').querySelector('[data-loading="true"]')) void loadEvidence();
  }, 2500);
  Tracker.autorun(() => {
    const id = host.currentMission();
    if (missionId !== id && !dialog.open) { missionId = id; plan = null; dirty = false; }
    const rows = Runs.find({ missionId }, { sort: { createdAt: -1 }, limit: 40 }).fetch();
    const next = JSON.stringify(rows);
    element('op-run-count').textContent = String(rows.length);
    if (signature !== next) { signature = next; if (dialog.open && tab === 'runs') renderRuns(); }
    const current = Definitions.findOne({ missionId });
    if (current && !dirty && plan && current.revision !== definition?.revision) { definition = current; setPlan(current); }
  });
  initializeLab(host);
  initializeFederation(host);
  const planChat = host.chat ? initializePlanChat({
    ...host, definitions: Definitions, runs: Runs,
    externalTrigger: host.externalPlanTrigger === true,
    openPlan: (id, next, runId, control) => openPlan(next, { missionId: id, runId, control }),
  }) : null;
  return { planChat };
}
