import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { sanitizeCleanAssistantContent } from 'meteor/10thfloor:agent';
import { escapeHtml as esc, element as $, dateLabel, stateBadge, createDialog, showDialog, busyAction } from './operations';

export function initializeLab(host) {
  const Datasets = new Mongo.Collection('constellation_eval_datasets');
  const Scenarios = new Mongo.Collection('constellation_eval_scenarios');
  const Experiments = new Mongo.Collection('constellation_eval_experiments');
  const Results = new Mongo.Collection('constellation_eval_results');
  let selectedDatasetId = null;
  let selectedExperimentId = null;
  let compareExperimentId = null;
  let editingScenario = null;
  let editingDataset = null;
  let selectedAgentIds = new Set();
  let renderSignature = '';
  const subscription = Meteor.subscribe('constellation.evaluations', {
    onError(error) { host.toast(error.reason || 'Could not load evaluations.', 'error'); },
  });
  const root = $('lab-root');
  root.innerHTML = `<div class="op-lab-toolbar"><label>Scenario set<select id="lab-dataset" aria-label="Scenario set"></select></label><button id="lab-new-dataset" type="button" class="secondary-action">+ New set</button><button id="lab-edit-dataset" type="button" class="op-link">Edit set</button><button id="lab-remove-dataset" type="button" class="op-link">Remove set</button><span id="lab-dataset-version" class="op-muted"></span></div>
    <div class="op-lab-layout"><section class="op-lab-scenarios"><div class="op-section-heading"><h3>Scenarios</h3><span id="lab-scenario-count" class="op-muted"></span></div><div id="lab-scenarios"></div></section>
    <section class="op-lab-execution"><form id="lab-run-form"><div class="op-section-heading"><h3>Run evaluation</h3><span class="op-isolation-label">Isolated memory</span></div><fieldset class="op-agent-choices"><legend>Agents to compare</legend><div id="lab-agent-choices"></div></fieldset><p class="op-hint">Uses current agent settings and optional test memory. Tools are simulated; live data and learning stay untouched.</p><div class="op-inline-actions"><button id="lab-run" class="primary-action" type="submit">Run evaluation</button><span id="lab-run-hint" class="op-hint"></span></div></form>
    <div class="op-section-heading op-history-heading"><h3>Results</h3><label class="op-inline-select"><span class="op-sr-only">Evaluation run</span><select id="lab-experiment"></select></label></div><div id="lab-results"></div></section></div>`;
  const scenarioDialog = createDialog('lab-scenario-dialog', 'Scenario', `<form id="lab-scenario-form"><div class="op-scroll"><label>Name<input id="lab-scenario-name" maxlength="96" required></label><label>Task<textarea id="lab-scenario-prompt" rows="4" maxlength="12000" required></textarea></label><fieldset class="op-gates"><legend>Pass criteria</legend><label>Must contain<textarea id="lab-scenario-contains" rows="2" placeholder="One phrase per line"></textarea></label><label>Must avoid<textarea id="lab-scenario-avoids" rows="2" placeholder="One phrase per line"></textarea></label><label>Must select tool<input id="lab-scenario-tool" list="lab-tool-options" placeholder="Choose a tool (optional)" maxlength="160"></label><p class="op-hint">Every criterion must pass. Phrase matching ignores case.</p><datalist id="lab-tool-options"></datalist></fieldset><details class="op-details"><summary>Test memory (optional)</summary><p class="op-hint">Synthetic context for this scenario only. One entry per line; never saved to the agent.</p><label>Facts<textarea id="lab-fixture-facts" rows="2"></textarea></label><label>Experiences<textarea id="lab-fixture-experiences" rows="2"></textarea></label><label>Practices<textarea id="lab-fixture-practices" rows="2"></textarea></label><label>Constitution<textarea id="lab-fixture-constitution" rows="2" maxlength="2000"></textarea></label></details><div id="lab-scenario-error"></div></div><footer class="op-footer"><span id="lab-scenario-version" class="op-muted"></span><button class="primary-action" type="submit">Save scenario</button></footer></form>`);
  const datasetDialog = createDialog('lab-dataset-dialog', 'New scenario set', `<form id="lab-dataset-form"><div class="op-scroll"><label>Name<input id="lab-new-dataset-name" maxlength="96" required placeholder="e.g. Research quality"></label><label>Description<textarea id="lab-new-dataset-description" rows="2" maxlength="500"></textarea></label><div id="lab-dataset-error"></div></div><footer class="op-footer"><button type="submit" class="primary-action">Create set</button></footer></form>`);
  const removeDialog = createDialog('lab-remove-dialog', 'Remove scenario', `<div class="op-scroll"><p id="lab-remove-copy"></p><p class="op-hint">Previous evaluation results keep their saved scenario version.</p><div id="lab-remove-error"></div></div><footer class="op-footer"><button id="lab-remove-cancel" type="button" class="secondary-action">Keep scenario</button><button id="lab-remove-confirm" type="button" class="danger-button">Remove scenario</button></footer>`);
  let removingScenario = null;
  const agentLabel = (id) => host.crew().find((row) => row.agent === id || row._id === id)?.displayName ?? id;
  const activeAgents = () => host.crew().filter((row) => row.enabled);
  const lines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);

  function openScenario(row = null) {
    if (!selectedDatasetId) { openDataset(); $('lab-new-dataset-name').focus(); return; }
    editingScenario = row;
    $('lab-scenario-dialog-title').textContent = row ? 'Edit scenario' : 'New scenario';
    $('lab-scenario-name').value = row?.name ?? '';
    $('lab-scenario-prompt').value = row?.prompt ?? '';
    $('lab-scenario-contains').value = row?.expected?.contains?.join('\n') ?? '';
    $('lab-scenario-avoids').value = row?.expected?.avoids?.join('\n') ?? '';
    $('lab-scenario-tool').value = row?.expected?.requiredTool ?? '';
    for (const key of ['facts', 'experiences', 'practices']) $('lab-fixture-' + key).value = row?.fixtures?.[key]?.join('\n') ?? '';
    $('lab-fixture-constitution').value = row?.fixtures?.constitution ?? '';
    $('lab-scenario-version').textContent = row ? `Version ${row.revision}` : 'New scenario';
    $('lab-scenario-error').replaceChildren();
    showDialog(scenarioDialog); $('lab-scenario-name').focus();
  }
  $('lab-new-scenario').addEventListener('click', () => openScenario());
  function openDataset(row = null) {
    editingDataset = row; $('lab-dataset-form').reset();
    $('lab-dataset-dialog-title').textContent = row ? 'Edit scenario set' : 'New scenario set';
    $('lab-new-dataset-name').value = row?.name ?? '';
    $('lab-new-dataset-description').value = row?.description ?? '';
    $('lab-dataset-form').querySelector('[type="submit"]').textContent = row ? 'Save set' : 'Create set';
    $('lab-dataset-error').replaceChildren(); showDialog(datasetDialog);
  }
  $('lab-new-dataset').addEventListener('click', () => openDataset());
  $('lab-edit-dataset').addEventListener('click', () => openDataset(Datasets.findOne(selectedDatasetId)));
  $('lab-remove-dataset').addEventListener('click', () => {
    removingScenario = { ...Datasets.findOne(selectedDatasetId), isDataset: true };
    $('lab-remove-dialog-title').textContent = 'Remove scenario set';
    $('lab-remove-copy').textContent = `Remove “${removingScenario.name}” and its scenarios? Previous results are preserved.`;
    $('lab-remove-confirm').textContent = 'Remove set'; $('lab-remove-cancel').textContent = 'Keep set';
    showDialog(removeDialog);
  });
  $('lab-dataset-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(event.submitter, $('lab-dataset-error'), 'Saving…', async () => {
      const patch = { name: $('lab-new-dataset-name').value.trim(), description: $('lab-new-dataset-description').value.trim() };
      const result = editingDataset
        ? await Meteor.callAsync('constellation.evalDatasetUpdate', { datasetId: editingDataset._id, expectedRevision: editingDataset.revision, patch })
        : await Meteor.callAsync('constellation.evalDatasetCreate', patch);
      selectedDatasetId = result.datasetId ?? result._id ?? result; selectedExperimentId = null;
      datasetDialog.close(); renderSignature = ''; render();
    });
  });
  $('lab-scenario-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(event.submitter, $('lab-scenario-error'), 'Saving…', async () => {
      const patch = { name: $('lab-scenario-name').value.trim(), prompt: $('lab-scenario-prompt').value.trim(),
        expected: { contains: lines($('lab-scenario-contains').value), avoids: lines($('lab-scenario-avoids').value),
          ...($('lab-scenario-tool').value.trim() ? { requiredTool: $('lab-scenario-tool').value.trim() } : {}) } };
      if (!patch.expected.contains.length && !patch.expected.avoids.length && !patch.expected.requiredTool) throw new Error('Add at least one pass criterion.');
      patch.fixtures = { constitution: $('lab-fixture-constitution').value.trim() };
      for (const key of ['facts', 'experiences', 'practices']) patch.fixtures[key] = lines($('lab-fixture-' + key).value);
      if (editingScenario) await Meteor.callAsync('constellation.evalScenarioUpdate', { scenarioId: editingScenario._id, expectedRevision: editingScenario.revision, patch });
      else await Meteor.callAsync('constellation.evalScenarioCreate', { datasetId: selectedDatasetId, ...patch });
      scenarioDialog.close(); host.toast('Scenario saved.');
    });
  });
  $('lab-remove-cancel').addEventListener('click', () => removeDialog.close());
  $('lab-remove-confirm').addEventListener('click', (event) => void busyAction(event.currentTarget, $('lab-remove-error'), 'Removing…', async () => {
    if (removingScenario.isDataset) await Meteor.callAsync('constellation.evalDatasetRemove', { datasetId: removingScenario._id, expectedRevision: removingScenario.revision });
    else await Meteor.callAsync('constellation.evalScenarioRemove', { scenarioId: removingScenario._id, expectedRevision: removingScenario.revision });
    removeDialog.close(); host.toast('Removed. Previous results are preserved.');
  }));
  $('lab-dataset').addEventListener('change', (event) => { selectedDatasetId = event.target.value; selectedExperimentId = null; compareExperimentId = null; renderSignature = ''; render(); });
  $('lab-experiment').addEventListener('change', (event) => { selectedExperimentId = event.target.value; renderSignature = ''; render(); });
  $('lab-run-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(event.submitter, $('lab-run-form'), 'Starting…', async () => {
      const result = await Meteor.callAsync('constellation.evalRun', { datasetId: selectedDatasetId, agentIds: [...selectedAgentIds] });
      selectedExperimentId = result.experimentId; renderSignature = ''; render();
    });
  });

  function render() {
    const datasets = Datasets.find({ archivedAt: { $exists: false } }, { sort: { createdAt: -1 } }).fetch();
    const agents = activeAgents();
    const toolNames = [...new Set(host.tools().map((row) => row.name).filter(Boolean))].sort();
    if (!datasets.some((row) => row._id === selectedDatasetId)) selectedDatasetId = datasets[0]?._id;
    const dataset = datasets.find((row) => row._id === selectedDatasetId);
    const scenarios = Scenarios.find({ datasetId: selectedDatasetId, archivedAt: { $exists: false } }, { sort: { createdAt: 1 } }).fetch();
    const experiments = Experiments.find({ datasetId: selectedDatasetId }, { sort: { createdAt: -1 }, limit: 40 }).fetch();
    if (!experiments.some((row) => row._id === selectedExperimentId)) selectedExperimentId = experiments[0]?._id;
    const experiment = experiments.find((row) => row._id === selectedExperimentId);
    const results = Results.find({ experimentId: selectedExperimentId }, { sort: { createdAt: 1 } }).fetch();
    const comparison = compareExperimentId ? Results.find({ experimentId: compareExperimentId }).fetch() : [];
    const ready = subscription.ready();
    const next = JSON.stringify({ ready, toolNames, datasets, agents, scenarios, experiments, results, comparison, selectedDatasetId, selectedExperimentId });
    if (renderSignature === next) return;
    renderSignature = next;
    $('lab-tool-options').innerHTML = toolNames.map((name) => `<option value="${esc(name)}"></option>`).join('');
    $('lab-dataset').innerHTML = datasets.map((row) => `<option value="${esc(row._id)}" ${row._id === selectedDatasetId ? 'selected' : ''}>${esc(row.name)}</option>`).join('') || '<option>No scenario sets</option>';
    $('lab-edit-dataset').disabled = !dataset; $('lab-remove-dataset').disabled = !dataset;
    $('lab-dataset-version').textContent = dataset ? `Version ${dataset.revision}` : '';
    $('lab-scenario-count').textContent = `${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`;
    $('lab-scenarios').innerHTML = !subscription.ready() ? '<div class="op-loading" role="status"><span></span>Loading scenarios…</div>' : scenarios.length ? scenarios.map((row) => `<article class="op-scenario-card"><header><strong>${esc(row.name)}</strong><span class="op-muted">v${esc(row.revision)}</span></header><p>${esc(row.prompt)}</p><div class="op-criterion-chips">${row.expected?.contains?.map((phrase) => `<span>Contains “${esc(phrase)}”</span>`).join('') ?? ''}${row.expected?.avoids?.map((phrase) => `<span>Avoids “${esc(phrase)}”</span>`).join('') ?? ''}${row.expected?.requiredTool ? `<span>Selects ${esc(row.expected.requiredTool)}</span>` : ''}</div><div class="op-inline-actions"><button data-edit-scenario="${esc(row._id)}" type="button" class="op-link">Edit</button><button data-remove-scenario="${esc(row._id)}" type="button" class="op-link">Remove</button></div></article>`).join('') : `<div class="op-empty"><strong>${dataset ? 'No scenarios yet' : 'Create a scenario set'}</strong><p>${dataset ? 'Add a task and the criteria its answer must meet.' : 'Group tasks and pass criteria to test across your crew.'}</p><button class="primary-action" id="lab-empty-create" type="button">${dataset ? '+ New scenario' : '+ New set'}</button></div>`;
    $('lab-empty-create')?.addEventListener('click', () => dataset ? openScenario() : openDataset());
    $('lab-scenarios').querySelectorAll('[data-edit-scenario]').forEach((button) => button.addEventListener('click', () => openScenario(scenarios.find((row) => row._id === button.dataset.editScenario))));
    $('lab-scenarios').querySelectorAll('[data-remove-scenario]').forEach((button) => button.addEventListener('click', () => {
      $('lab-remove-dialog-title').textContent = 'Remove scenario';
      $('lab-remove-confirm').textContent = 'Remove scenario'; $('lab-remove-cancel').textContent = 'Keep scenario';
      removingScenario = scenarios.find((row) => row._id === button.dataset.removeScenario);
      $('lab-remove-copy').textContent = `Remove “${removingScenario.name}” from this set?`;
      showDialog(removeDialog);
    }));
    selectedAgentIds = new Set([...selectedAgentIds].filter((id) => agents.some((row) => row.agent === id)));
    if (!selectedAgentIds.size && agents.length) selectedAgentIds.add(agents[0].agent);
    $('lab-agent-choices').innerHTML = agents.map((row) => `<label class="op-agent-choice"><input type="checkbox" value="${esc(row.agent)}" ${selectedAgentIds.has(row.agent) ? 'checked' : ''}><span><strong>${esc(row.displayName)}</strong><small>${esc(row.role)}</small></span></label>`).join('');
    const updateRunDisabled = () => {
      $('lab-run').disabled = !scenarios.length || !selectedAgentIds.size;
      $('lab-run-hint').textContent = !scenarios.length ? 'Add a scenario to run.' : !selectedAgentIds.size ? 'Select at least one agent.' : `${scenarios.length * selectedAgentIds.size} test case${scenarios.length * selectedAgentIds.size === 1 ? '' : 's'}`;
    };
    $('lab-agent-choices').querySelectorAll('input').forEach((input) => input.addEventListener('change', () => { if (input.checked) selectedAgentIds.add(input.value); else selectedAgentIds.delete(input.value); updateRunDisabled(); }));
    updateRunDisabled();
    $('lab-experiment').innerHTML = experiments.map((row) => `<option value="${esc(row._id)}" ${row._id === selectedExperimentId ? 'selected' : ''}>${esc(dateLabel(row.createdAt))} · ${esc(row.status)}</option>`).join('') || '<option>No runs yet</option>';
    if (!experiment) { $('lab-results').innerHTML = '<div class="op-empty"><strong>No evaluation results yet</strong><p>Select agents and run this scenario set.</p></div>'; return; }
    const passed = results.filter((row) => row.status === 'passed' || row.passed === true || (row.scores?.length && row.scores.every((score) => score.pass))).length;
    $('lab-results').innerHTML = `<div class="op-result-summary">${stateBadge(experiment.status)}${experiment.status === 'running' ? '<button id="lab-stop" class="secondary-action" type="button">Stop evaluation</button>' : ''}<strong>${passed} / ${results.length} passed</strong><label class="op-inline-select"><span>Compare with</span><select id="lab-compare"><option value="">No comparison</option>${experiments.filter((row) => row._id !== selectedExperimentId).map((row) => `<option value="${esc(row._id)}" ${row._id === compareExperimentId ? 'selected' : ''}>${esc(dateLabel(row.createdAt))}</option>`).join('')}</select></label></div>
      ${['queued', 'running'].includes(experiment.status) ? '<div class="op-loading" role="status"><span></span>Evaluating agents…</div>' : ''}
      ${experiment.status === 'cancelled' ? '<p class="op-hint">Stopped. The current model call may finish; no more results will be saved.</p>' : ''}${experiment.error ? `<div class="op-error">${esc(experiment.error?.reason ?? experiment.error)}</div>` : ''}
      <div class="op-eval-cases">${results.map((row) => {
        const previous = comparison.find((item) => item.scenarioId === row.scenarioId && item.agentId === row.agentId);
        const scenario = scenarios.find((item) => item._id === row.scenarioId);
        return `<details class="op-eval-case"><summary><span><strong>${esc(row.scenarioName ?? scenario?.name ?? 'Scenario')}</strong><small>${esc(agentLabel(row.agentId))}${row.agentConfigRevision ? ` · agent v${esc(row.agentConfigRevision)}` : ''} · ${Math.round(row.durationMs ?? 0)} ms · scenario v${esc(row.scenarioRevision ?? 1)}</small></span>${stateBadge(row.status)}${previous ? `<small>Previous: ${esc(previous.status)} · scenario v${esc(previous.scenarioRevision ?? 1)}</small>` : ''}</summary><div class="op-case-body"><ul class="op-score-list">${row.scores?.map((score) => `<li><span>${score.pass ? '✓' : '×'}</span><div><strong>${esc(score.id.startsWith('contains:') ? 'Required phrase' : score.id.startsWith('avoids:') ? 'Disallowed phrase' : score.id === 'required-tool' ? 'Tool selection' : score.id)}</strong><p>${esc(score.reason)}</p></div>${stateBadge(score.pass ? 'passed' : 'failed')}</li>`).join('') ?? ''}</ul>${row.error ? `<p class="op-error">${esc(row.error?.reason ?? row.error)}</p>` : ''}${row.model ? `<p class="op-hint">Model: ${esc(row.model)}</p>` : ''}<h4>Agent response</h4><div class="op-result">${esc(sanitizeCleanAssistantContent(row.output ?? ''))}</div>${previous ? `<h4>Previous response</h4><div class="op-result">${esc(sanitizeCleanAssistantContent(previous.output ?? ''))}</div>` : ''}</div></details>`;
      }).join('')}</div>`;
    $('lab-stop')?.addEventListener('click', (event) => void busyAction(event.currentTarget, $('lab-results'), 'Stopping…', () => Meteor.callAsync('constellation.evalCancel', { experimentId: experiment._id })));
    $('lab-compare').addEventListener('change', (event) => { compareExperimentId = event.target.value || null; renderSignature = ''; render(); });
  }
  Tracker.autorun(render);
}
