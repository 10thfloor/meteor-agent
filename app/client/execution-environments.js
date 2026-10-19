import { Tracker } from 'meteor/tracker';
import { createDialog, showDialog, dateLabel, wireTabs } from './operations';
import { initializeMissionFiles } from './mission-files';
import { initializeMissionServices } from './mission-services';

const find = (root, name) => root.querySelector(`[data-execution="${name}"]`);
const agentId = (agent) => agent.agent ?? agent._id;
const states = { 'not-created': 'Not created', ready: 'Ready', busy: 'In use',
  'needs-attention': 'Needs attention', deleting: 'Deleting' };
const reason = (error, fallback) => typeof error?.reason === 'string' && error.reason.trim() ? error.reason : fallback;
const initial = () => ({ keepFiles: false, allowedAgents: [], retention: 'keep', status: 'not-created', savePoints: [] });

/** Mission filesystem settings. Provisioning requires an explicit enable action. */
export function initializeExecutionEnvironments(host) {
  const { environments, method, subscribe, prefix } = host;
  const changed = new Tracker.Dependency();
  let disposed = false; let missionId = null; let generation = 0; let loadGeneration = 0;
  let environment = null; let tab = 'settings'; let loading = false; let metadataLoaded = false; let busy = null;
  let error = ''; let message = ''; let pendingConfirmation = null;
  let observedPublication = null;
  let subscriptionError = false;
  let pendingSettingsDraft = null;
  const retainedNodes = new Map(); const agentNodes = new Map(); const pointNodes = new Map();
  const dialog = createDialog(`${prefix}-environment`, 'Mission filesystem', `
    <div class="execution-environment-status"><div><span class="execution-status" data-execution="env-status" role="status"></span><p data-execution="env-status-hint"></p></div><button type="button" class="secondary-action" data-execution="env-reload" hidden>Try again</button><button type="button" class="secondary-action" data-execution="env-reconcile" hidden>Check status</button></div>
    <div class="op-tabs" role="tablist" aria-label="Mission filesystem">
      <button type="button" id="${prefix}-env-points-tab" data-env-tab="points" role="tab" aria-controls="${prefix}-env-points">Save points</button>
      <button type="button" id="${prefix}-env-settings-tab" data-env-tab="settings" role="tab" aria-controls="${prefix}-env-settings">Settings</button>
    </div>
    <div class="execution-environment-notice" data-execution="env-errors" role="alert" hidden></div><p class="execution-environment-notice" data-execution="env-message" role="status" hidden></p>
    <section class="execution-environment-tab" id="${prefix}-env-points" data-env-panel="points" role="tabpanel" aria-labelledby="${prefix}-env-points-tab" hidden>
      <div class="execution-environment-scroll" tabindex="0" aria-label="Save points"><p class="op-hint">Save the whole filesystem, including uploads, generated files and installed packages. Chat history is not included.</p>
      <form class="execution-save-point" data-execution="env-point-form"><label>Save point label<input data-execution="env-point-label" maxlength="120" required placeholder="Before updating the analysis"></label><button class="primary-action" type="submit" data-execution="env-save-point">Save point</button></form>
      <div class="execution-points-tools"><p class="op-hint">Browse files from save points Sprites currently mounts. Some recent or older save points may require a full restore.</p><button type="button" class="secondary-action" data-execution="env-refresh-points">Check availability</button></div><p class="execution-access-hint" data-execution="env-point-deletion-unavailable" hidden></p><p class="execution-access-hint" data-execution="env-points-limit" hidden></p><p class="execution-empty" data-execution="env-points-empty"></p><ul class="execution-point-list" data-execution="env-points"></ul></div>
    </section>
    <section class="execution-environment-tab" id="${prefix}-env-settings" data-env-panel="settings" role="tabpanel" aria-labelledby="${prefix}-env-settings-tab" hidden>
      <form data-execution="env-settings-form"><div class="execution-environment-scroll execution-form"><fieldset class="execution-fields" data-execution="env-settings-fields" disabled>
        <div class="execution-environment-connection" data-execution="env-connection" hidden><p data-execution="env-connection-hint"></p><button type="button" class="secondary-action" data-execution="env-open-connection">Connect Sprites</button></div>
        <label class="op-check"><input type="checkbox" data-execution="env-keep-files">Mission filesystem</label><p class="op-hint">Shared files in Sprites. Turning this off keeps existing files.</p>
        <fieldset class="execution-agent-access"><legend>Share files with</legend><p class="op-hint">Selected agents can use this mission’s files when their file or code permissions allow it.</p><div class="execution-environment-agents" data-execution="env-agents"></div><p class="op-hint" data-execution="env-agents-empty" hidden>No agents are available in this mission.</p><p class="execution-access-hint" data-execution="env-no-grants" role="status" hidden>Select an agent to share this filesystem with.</p><div class="execution-permission-shortcut"><p>Agent permissions apply across all missions.</p><button type="button" class="op-link" data-execution="env-manage-permissions">Manage permissions ↗</button></div><p class="execution-data-note">Code can change files, packages, services and save points in this mission filesystem. It cannot access your computer.</p></fieldset>
        <label>Keep filesystem<select data-execution="env-retention"><option value="keep">Until I delete the environment</option><option value="delete-on-completion">Delete when the mission is completed</option></select></label>
        <p class="execution-data-note">Files and save points are stored in Fly.io’s Sprites. Enabling this filesystem may incur Sprites charges.</p>
      </fieldset><section class="execution-environment-danger" data-execution="env-delete-section" hidden><div><h3>Delete environment</h3><p>Delete all mission files, uploads, generated results and save points. Chat history remains, but its file links will no longer open.</p></div><button type="button" class="danger-button" data-execution="env-delete">Delete environment…</button></section></div>
      <footer class="op-footer"><button type="submit" class="primary-action" data-execution="env-save-settings">Save settings</button></footer></form>
    </section>`, 'execution-dialog execution-environment-dialog');
  const confirmation = createDialog(`${prefix}-environment-confirm`, 'Confirm environment change', `
    <div class="op-scroll execution-confirm-copy"><p data-execution="env-confirm-description"></p><p class="op-hint" data-execution="env-confirm-detail"></p><div data-execution="env-confirm-errors" role="alert" hidden></div></div>
    <footer class="op-footer"><button type="button" class="secondary-action" data-execution="env-confirm-cancel">Cancel</button><button type="button" class="danger-button" data-execution="env-confirm-action">Confirm</button></footer>`, 'execution-dialog execution-environment-confirm');
  const current = (captured) => !disposed && dialog.open && generation === captured;
  const availableAgents = () => host.missionCrew?.(missionId) ?? host.crew();
  const canUseFiles = () => metadataLoaded && environment?.status === 'ready' && !environment?.erasedAt && !loading && !busy;
  const recoveryReadable = () => environment?.status === 'needs-attention' && ['save', 'restore', 'policies', 'checkpoint-delete', 'preview', 'files'].includes(environment.recoveryKind);
  const canBrowseFiles = () => metadataLoaded && (environment?.status === 'ready' || recoveryReadable()) && !environment?.erasedAt && !loading && !busy;
  const busyEnvironment = () => ['busy', 'deleting'].includes(environment?.status);
  const title = (id, value) => value?.erasedAt ? 'Deleted mission' : host.missionName(id);

  function accept(value) {
    if (!value || typeof value !== 'object' || (value.missionId && value.missionId !== missionId)) return;
    if (environment?.updatedAt && value.updatedAt && new Date(value.updatedAt) < new Date(environment.updatedAt)) return;
    environment = { ...initial(), ...value, missionId };
  }

  function populateSettings() {
    const value = environment ?? initial();
    find(dialog, 'env-keep-files').checked = value.keepFiles === true;
    find(dialog, 'env-retention').value = value.retention === 'delete-on-completion' ? value.retention : 'keep';
    for (const input of find(dialog, 'env-agents').querySelectorAll('input')) input.checked = value.allowedAgents?.includes(input.value) === true;
  }

  function renderAgents() {
    const members = availableAgents();
    const policies = host.config().agentPolicies ?? {};
    const ids = new Set([...members.map(agentId), ...(environment?.allowedAgents ?? [])]);
    for (const [id, node] of agentNodes) if (!ids.has(id)) { node.remove(); agentNodes.delete(id); }
    for (const id of ids) {
      let node = agentNodes.get(id);
      if (!node) {
        node = document.createElement('div'); node.className = 'execution-environment-agent';
        const label = document.createElement('label'); label.className = 'op-check';
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = id;
        input.checked = environment?.allowedAgents?.includes(id) === true;
        const name = document.createElement('span'); name.innerHTML = '<strong></strong><small></small>';
        label.append(input, name);
        node.append(label); agentNodes.set(id, node); find(dialog, 'env-agents').append(node);
      }
      const member = members.find((agent) => agentId(agent) === id);
      const name = member?.displayName ?? `${id} · no longer in this mission`;
      node.querySelector('strong').textContent = name;
      node.querySelector('small').textContent = !member ? 'Not in this mission’s crew' : `${member.capabilities?.files === false ? 'Files disabled' : 'Files enabled'} · ${policies[id]?.run === 'ask' ? 'Code asks first' : policies[id]?.run === 'auto' ? 'Code allowed' : 'Code off'}`;
    }
    find(dialog, 'env-agents-empty').hidden = !!ids.size;
  }

  function renderPoints() {
    const points = environment?.savePoints ?? [];
    const ids = new Set(points.map((point) => point.id));
    for (const [id, node] of pointNodes) if (!ids.has(id)) { node.remove(); pointNodes.delete(id); }
    for (const point of points) {
      let row = pointNodes.get(point.id);
      if (!row) {
        row = document.createElement('li'); row.dataset.savePointId = point.id;
        row.innerHTML = '<div><strong></strong><span></span></div><div class="execution-inline-actions"><button type="button" class="secondary-action" data-point-action="restore">Restore…</button><button type="button" class="secondary-action" data-point-action="browse">Browse files</button><button type="button" class="op-link" data-point-action="remove">Delete…</button></div>';
        row.querySelector('[data-point-action="restore"]').addEventListener('click', () => confirmChange('restore', point.id));
        row.querySelector('[data-point-action="browse"]').addEventListener('click', () => {
          const id = missionId; dialog.close(); openFiles(id, { location: 'working', savePointId: point.id });
        });
        row.querySelector('[data-point-action="remove"]').addEventListener('click', () => confirmChange('remove-point', point.id));
        pointNodes.set(point.id, row); find(dialog, 'env-points').append(row);
      }
      row.querySelector('strong').textContent = point.label || 'Save point';
      row.querySelector('span').textContent = [dateLabel(point.createdAt), point.available === false ? 'No longer available' : point.healthy === false ? 'Unavailable' : ''].filter(Boolean).join(' · ');
      row.querySelector('[data-point-action="restore"]').disabled = !canUseFiles() || points.length >= 50 || point.healthy === false || point.available === false;
      row.querySelector('[data-point-action="remove"]').disabled = !canBrowseFiles() || environment?.checkpointDeletionSupported === false;
      row.querySelector('[data-point-action="browse"]').disabled = !canBrowseFiles() || point.available === false || point.healthy === false;
    }
    const empty = find(dialog, 'env-points-empty'); empty.hidden = !!points.length;
    const deletionUnavailable = environment?.checkpointDeletionSupported === false;
    find(dialog, 'env-point-deletion-unavailable').hidden = !deletionUnavailable;
    find(dialog, 'env-point-deletion-unavailable').textContent = 'Deleting individual save points is unavailable on this Sprites connection.'
      + (points.length < 50 ? ' Existing save points can still be restored.' : '');
    find(dialog, 'env-points-limit').hidden = points.length < 50;
    find(dialog, 'env-points-limit').textContent = deletionUnavailable
      ? 'The 50-save-point limit is reached. New saves and restores are paused; restores need room for a safety save point. Existing points are kept and nothing is deleted automatically.'
      : 'The list holds 50 save points. Delete one before saving or restoring; restoring needs room for a safety save point.';
    empty.textContent = loading ? 'Loading save points…' : environment?.erasedAt ? 'This mission was deleted. You can still remove its remote environment in Settings.'
      : environment?.status === 'not-created' ? 'Enable the mission filesystem in Settings to create save points.' : 'No save points yet.';
  }

  function render() {
    if (!dialog.open || !missionId) return;
    const value = environment ?? initial(); const locked = loading || !metadataLoaded || !!busy || busyEnvironment();
    dialog.querySelector('.op-dialog-scope').textContent = title(missionId, value);
    const status = find(dialog, 'env-status');
    const operationLabel = { saveEnvironment: 'Saving settings…', enableFilesystem: 'Enabling filesystem…', savePoint: 'Saving point…', restoreSavePoint: 'Restoring…', deleteSavePoint: 'Deleting save point…', refreshSavePoints: 'Checking save points…', reconcileEnvironment: 'Checking status…', deleteEnvironment: 'Deleting…' };
    status.textContent = loading ? 'Loading…' : busy ? operationLabel[busy.name] || 'Updating…' : states[value.status] ?? 'Needs attention'; status.dataset.state = loading || busy ? 'preparing' : value.status;
    find(dialog, 'env-status-hint').textContent = value.erasedAt ? 'This mission was deleted. Its remote environment can still be removed.'
      : value.status === 'busy' ? value.currentJobId ? 'A run is using these files. Stop the run from Code runs if needed; stopping does not delete saved files.' : 'Updating the environment…'
        : value.status === 'deleting' ? 'Remote working files and save points are being removed.'
          : value.status === 'needs-attention' ? (typeof value.error === 'string' && value.error.trim() ? value.error : reason(value.error, 'The remote environment needs a status check before you continue.'))
            : value.status === 'not-created' ? 'Enable the mission filesystem to create and share files.'
              : 'Files are stored in Sprites.';
    find(dialog, 'env-reconcile').hidden = !['needs-attention', 'deleting'].includes(value.status);
    find(dialog, 'env-reconcile').disabled = loading || !metadataLoaded || !!busy;
    find(dialog, 'env-reconcile').textContent = busy?.name === 'reconcileEnvironment' ? 'Checking…' : 'Check status';
    find(dialog, 'env-reload').hidden = loading || metadataLoaded;
    find(dialog, 'env-errors').textContent = error; find(dialog, 'env-errors').hidden = !error;
    find(dialog, 'env-message').textContent = message; find(dialog, 'env-message').hidden = !message;
    for (const button of dialog.querySelectorAll('[data-env-tab]')) {
      const selected = button.dataset.envTab === tab;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; button.disabled = !!busy;
    }
    for (const panel of dialog.querySelectorAll('[data-env-panel]')) panel.hidden = panel.dataset.envPanel !== tab;
    renderAgents(); renderPoints();
    const config = host.config();
    find(dialog, 'env-connection').hidden = !!value.erasedAt || (config.providerConfigured && config.connectionStatus === 'connected');
    find(dialog, 'env-open-connection').textContent = config.providerConfigured ? 'Connection settings' : 'Connect Sprites';
    find(dialog, 'env-connection-hint').textContent = !config.providerConfigured ? 'Connect Sprites to enable this filesystem.' : 'Test your Sprites connection before enabling this filesystem.';
    find(dialog, 'env-no-grants').hidden = !find(dialog, 'env-keep-files').checked || !!find(dialog, 'env-agents').querySelector('input:checked');
    find(dialog, 'env-settings-fields').disabled = locked || !!value.erasedAt;
    find(dialog, 'env-save-settings').disabled = locked || !!value.erasedAt;
    const willEnable = find(dialog, 'env-keep-files').checked && value.status === 'not-created';
    find(dialog, 'env-save-settings').textContent = busy?.name === 'enableFilesystem' ? 'Enabling…' : busy?.name === 'saveEnvironment' ? 'Saving…' : willEnable ? 'Enable filesystem' : 'Save settings';
    find(dialog, 'env-settings-form').setAttribute('aria-busy', String(['saveEnvironment', 'enableFilesystem'].includes(busy?.name)));
    find(dialog, 'env-point-label').disabled = !canUseFiles();
    find(dialog, 'env-save-point').disabled = !canUseFiles() || (value.savePoints?.length ?? 0) >= 50;
    find(dialog, 'env-save-point').textContent = busy?.name === 'savePoint' ? 'Saving…' : 'Save point';
    find(dialog, 'env-refresh-points').disabled = !canBrowseFiles();
    find(dialog, 'env-delete-section').hidden = !value.workspaceId && !value.erasedAt && !['ready', 'busy', 'needs-attention', 'deleting'].includes(value.status);
    find(dialog, 'env-delete').disabled = locked;
    if (confirmation.open) {
      const confirm = find(confirmation, 'env-confirm-action');
      confirm.disabled = locked || pendingConfirmation?.kind === 'remove-point' && value.checkpointDeletionSupported === false;
      confirm.textContent = busy ? busy.name === 'restoreSavePoint' ? 'Restoring…' : 'Deleting…'
        : pendingConfirmation?.kind === 'restore' ? 'Restore environment' : pendingConfirmation?.kind === 'remove-point' ? 'Delete save point' : 'Delete environment';
      confirm.setAttribute('aria-busy', String(!!busy));
    }
  }

  async function loadEnvironment(captured = generation) {
    const request = ++loadGeneration; const id = missionId;
    loading = true; error = ''; changed.changed();
    try {
      const result = await method('getEnvironment', { missionId: id });
      if (!current(captured) || loadGeneration !== request) return;
      accept(result); metadataLoaded = true; renderAgents(); populateSettings();
      if (pendingSettingsDraft) {
        find(dialog, 'env-keep-files').checked = pendingSettingsDraft.keepFiles;
        find(dialog, 'env-retention').value = pendingSettingsDraft.retention;
        for (const input of find(dialog, 'env-agents').querySelectorAll('input')) input.checked = pendingSettingsDraft.allowedAgents.includes(input.value);
        pendingSettingsDraft = null;
      }
    } catch (value) {
      if (current(captured) && loadGeneration === request) {
        metadataLoaded = false; error = reason(value, 'Could not load this environment. Try again.');
      }
    } finally {
      if (current(captured) && loadGeneration === request) {
        loading = false; changed.changed();
      }
    }
  }

  async function mutate(name, input, success, options = {}) {
    if (busy || loading || !metadataLoaded || busyEnvironment() && name !== 'reconcileEnvironment') return;
    const captured = generation; const id = missionId; const operation = {};
    busy = { name, operation, targetName: input.name }; error = ''; message = '';
    find(confirmation, 'env-confirm-errors').hidden = true; render();
    try {
      let result = await method(name, { missionId: id, ...input });
      if (!current(captured) || busy?.operation !== operation) return;
      if (name === 'saveEnvironment' && input.keepFiles && result?.status === 'not-created') {
        accept(result); busy.name = 'enableFilesystem'; render();
        result = await method('enableFilesystem', { missionId: id });
        if (!current(captured) || busy?.operation !== operation) return;
      }
      if (options.resultIsEnvironment !== false) accept(result);
      options.onResult?.(result);
      if (name === 'deleteEnvironment' && result && result.status !== 'not-created') {
        throw { reason: typeof result.error === 'string' ? result.error : 'The remote environment could not be confirmed deleted. Check its status and try again.' };
      }
      if (['reconcileEnvironment', 'restoreSavePoint', 'savePoint'].includes(name) && result?.status === 'needs-attention') {
        throw { reason: typeof result.error === 'string' ? result.error : 'The environment still needs attention. Check its status before trying again.' };
      }
      if (name === 'deleteEnvironment' && !result) accept(initial());
      message = success;
      if (name === 'saveEnvironment') { renderAgents(); populateSettings(); }
      if (name === 'savePoint') find(dialog, 'env-point-label').value = '';
      if (['restoreSavePoint', 'deleteEnvironment'].includes(name)) files.refresh();
      if (options.confirm && pendingConfirmation?.generation === captured) { confirmation.close(); pendingConfirmation = null; }
    } catch (value) {
      if (!current(captured) || busy?.operation !== operation) return;
      const text = reason(value, 'Could not update this environment. Try again.');
      if (options.confirm && confirmation.open) {
        find(confirmation, 'env-confirm-errors').textContent = text; find(confirmation, 'env-confirm-errors').hidden = false;
      } else error = text;
    } finally {
      if (current(captured) && busy?.operation === operation) { busy = null; changed.changed(); }
    }
  }

  function confirmChange(kind, pointId) {
    if (loading || busy || busyEnvironment() || !environment) return;
    const point = environment.savePoints?.find((item) => item.id === pointId);
    if (kind === 'restore' && (!point || !canUseFiles())) return;
    if (kind === 'remove-point' && (!point || !canBrowseFiles() || environment.checkpointDeletionSupported === false)) return;
    if (kind === 'restore' && ((environment.savePoints?.length ?? 0) >= 50 || point.healthy === false || point.available === false)) return;
    pendingConfirmation = { kind, pointId, generation, missionId };
    confirmation.querySelector('h2').textContent = kind === 'restore' ? 'Restore save point?' : kind === 'remove-point' ? 'Delete save point?' : 'Delete environment?';
    confirmation.querySelector('.op-dialog-scope').textContent = title(missionId, environment);
    find(confirmation, 'env-confirm-description').textContent = kind === 'restore' ? `Restore “${point.label || 'Save point'}”? This replaces the whole filesystem, including uploads, generated files and installed packages.`
      : kind === 'remove-point' ? `Permanently delete “${point.label || 'Save point'}” from Sprites? This cannot be undone.`
      : 'Permanently delete all files, uploads, generated results and save points in this mission’s Sprite? This cannot be undone.';
    find(confirmation, 'env-confirm-detail').textContent = kind === 'restore' ? 'A safety save point is saved first. Chat history stays unchanged; linked files revert with the filesystem.'
      : kind === 'remove-point' ? 'Current files, other save points and chats stay unchanged.'
      : 'Chat history remains, but its file links will no longer open. The mission filesystem will be turned off. You can enable it again to start a new environment.';
    find(confirmation, 'env-confirm-action').textContent = kind === 'restore' ? 'Restore environment' : kind === 'remove-point' ? 'Delete save point' : 'Delete environment';
    find(confirmation, 'env-confirm-errors').hidden = true;
    showDialog(confirmation); find(confirmation, 'env-confirm-cancel').focus(); render();
  }

  function selectTab(next) {
    if (busy || !['settings', 'points'].includes(next)) return;
    tab = next; render();
  }

  function openEnvironment(id, selectedTab = 'settings', settingsDraft = null) {
    if (disposed) return null;
    if (!id) { host.toast?.('Open a mission to manage its environment.'); return null; }
    if (confirmation.open) confirmation.close(); pendingConfirmation = null;
    generation += 1; loadGeneration += 1; missionId = id;
    pendingSettingsDraft = settingsDraft;
    tab = ['points', 'settings'].includes(selectedTab) ? selectedTab : 'settings';
    const published = environments.findOne({ missionId: id });
    environment = published ?? initial(); observedPublication = JSON.stringify(published ?? null);
    loading = true; metadataLoaded = false; busy = null; error = ''; message = ''; agentNodes.clear(); pointNodes.clear();
    find(dialog, 'env-agents').replaceChildren(); find(dialog, 'env-points').replaceChildren();
    find(dialog, 'env-point-label').value = '';
    renderAgents(); populateSettings(); showDialog(dialog); render(); void loadEnvironment();
    return dialog;
  }

  wireTabs(dialog, 'data-env-tab', selectTab);
  find(dialog, 'env-settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (find(dialog, 'env-settings-fields').disabled) return;
    void mutate('saveEnvironment', { keepFiles: find(dialog, 'env-keep-files').checked,
      allowedAgents: [...find(dialog, 'env-agents').querySelectorAll('input:checked')].map((input) => input.value),
      retention: find(dialog, 'env-retention').value }, 'Settings saved.');
  });
  find(dialog, 'env-settings-form').addEventListener('change', render);
  find(dialog, 'env-manage-permissions').addEventListener('click', () => {
    if (loading || busy || !metadataLoaded || !missionId) return;
    const id = missionId;
    const returnFocus = dialog._returnFocus;
    const draft = { keepFiles: find(dialog, 'env-keep-files').checked, retention: find(dialog, 'env-retention').value,
      allowedAgents: [...find(dialog, 'env-agents').querySelectorAll('input:checked')].map((input) => input.value) };
    const selectedAgent = draft.allowedAgents.find((agent) => availableAgents().some((member) => agentId(member) === agent));
    dialog.close();
    host.openAgentAccess(selectedAgent, { label: `Back to ${host.missionName(id)} settings`,
      description: 'Your mission settings draft is kept.', onReturn: () => {
        const restored = openEnvironment(id, 'settings', draft);
        // Parent showModal may temporarily focus its first field. Preserve the
        // actual Environment opener when returning through the central editor.
        if (restored && returnFocus?.isConnected) restored._returnFocus = returnFocus;
      } });
  });
  find(dialog, 'env-open-connection').addEventListener('click', () => host.openSettings());
  find(dialog, 'env-point-form').addEventListener('submit', (event) => {
    event.preventDefault(); const label = find(dialog, 'env-point-label').value.trim();
    if (!label || !canUseFiles() || (environment.savePoints?.length ?? 0) >= 50) return;
    void mutate('savePoint', { label }, 'Save point saved.');
  });
  find(dialog, 'env-reconcile').addEventListener('click', () => void mutate('reconcileEnvironment', {}, 'Environment status updated.'));
  find(dialog, 'env-reload').addEventListener('click', () => void loadEnvironment());
  find(dialog, 'env-refresh-points').addEventListener('click', () => void mutate('refreshSavePoints', {}, 'Save point availability updated.'));
  find(dialog, 'env-delete').addEventListener('click', () => confirmChange('delete'));
  find(confirmation, 'env-confirm-cancel').addEventListener('click', () => confirmation.close());
  find(confirmation, 'env-confirm-action').addEventListener('click', () => {
    const target = pendingConfirmation;
    if (!target || !current(target.generation) || target.missionId !== missionId) return;
    if (target.kind === 'restore') void mutate('restoreSavePoint', { savePointId: target.pointId, confirm: true }, 'Filesystem restored. Chat history was not changed.', { confirm: true });
    else if (target.kind === 'remove-point') {
      if (environment?.checkpointDeletionSupported !== false) void mutate('deleteSavePoint', { savePointId: target.pointId, confirm: true }, 'Save point deleted.', { confirm: true });
    }
    else void mutate('deleteEnvironment', { confirm: true }, 'Remote environment deleted. Chat history was not changed; its file links are now unavailable.', { confirm: true });
  });
  confirmation.addEventListener('close', () => { if (!confirmation.open) pendingConfirmation = null; });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    generation += 1; loadGeneration += 1; missionId = null; busy = null;
    if (confirmation.open) confirmation.close(); pendingConfirmation = null;
  });

  const subscription = subscribe('constellation.execution.environments', {
    onError() { if (!disposed) { subscriptionError = true; changed.changed(); } },
  });
  const computation = Tracker.autorun(() => {
    changed.depend();
    const retained = environments.find().fetch().filter((value) => value.keepFiles || value.workspaceId || value.erasedAt || value.status !== 'not-created');
    const list = find(host.root, 'environment-list');
    find(host.root, 'retained-environments').hidden = !retained.length && !subscriptionError;
    const notice = find(host.root, 'environment-list-error'); notice.hidden = !subscriptionError;
    const ids = new Set(retained.map((value) => value.missionId));
    for (const [id, row] of retainedNodes) if (!ids.has(id)) { row.remove(); retainedNodes.delete(id); }
    for (const value of retained) {
      let row = retainedNodes.get(value.missionId);
      if (!row) {
        row = document.createElement('div'); row.className = 'execution-cleanup-row'; row.dataset.missionId = value.missionId;
        row.innerHTML = '<div><strong></strong><span></span></div><button type="button" class="secondary-action">Open environment</button>';
        row.querySelector('button').addEventListener('click', () => openEnvironment(value.missionId));
        retainedNodes.set(value.missionId, row); list.append(row);
      }
      row.querySelector('strong').textContent = title(value.missionId, value);
      row.querySelector('span').textContent = states[value.status] ?? 'Needs attention';
    }
    if (dialog.open && missionId) {
      const published = environments.findOne({ missionId });
      const signature = JSON.stringify(published ?? null);
      if (signature !== observedPublication) {
        observedPublication = signature;
        if (published) accept(published);
      }
      render();
    }
  });

  const sharedHost = { method, environments, config: host.config, openConnection: host.openSettings,
    enableFilesystem: (id) => method('enableFilesystem', { missionId: id }),
    connected: host.connected, prefix, openEnvironment, openRun: host.openRun, downloadFile: host.downloadFile, openPreview: host.openPreview };
  const files = initializeMissionFiles({ ...sharedHost, root: host.filesRoot });
  const services = initializeMissionServices({ ...sharedHost, root: host.servicesRoot });
  function openFiles(id, options = {}) {
    if (!id || disposed) return null;
    host.navigateToMissionWork?.('files', id, options); services.setActive(null); files.open(id, options); return host.filesRoot;
  }
  function openServices(id) {
    if (!id || disposed) return null;
    host.navigateToMissionWork?.('services', id); files.setActive(null); services.open(id); return host.servicesRoot;
  }
  function setActive(state) { files.setActive(state); services.setActive(state); }

  return { openEnvironment, openFiles, openServices, setActive, environments, dialogs: { environment: dialog, environmentConfirm: confirmation },
    dispose() {
      disposed = true; generation += 1; computation.stop(); subscription.stop(); files.dispose(); services.dispose();
      for (const target of [confirmation, dialog]) {
        const toast = target.querySelector('#toast-region'); if (toast) document.body.append(toast);
        if (target.open) target.close(); target.remove();
      }
    },
  };
}
