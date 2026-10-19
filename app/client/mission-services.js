import { Tracker } from 'meteor/tracker';
import { createDialog, showDialog } from './operations';
import './mission-services.css';

const field = (root, name) => root.querySelector(`[data-services="${name}"]`);
const failure = (value, fallback) => typeof value?.reason === 'string' && value.reason.trim() ? value.reason : fallback;
const states = { 'not-started': 'Not started', running: 'Running', stopped: 'Stopped', starting: 'Starting', stopping: 'Stopping', failed: 'Failed', exited: 'Exited', missing: 'Not found', unknown: 'Status unknown' };

/** Explicit lifecycle controls for named HTTP services in a mission's Sprite. */
export function initializeMissionServices(host) {
  const root = host.root;
  if (!root) return { setActive() {}, open() {}, dispose() {} };
  const changed = new Tracker.Dependency();
  root.classList.add('mission-services');
  root.innerHTML = `<header class="mission-services-toolbar"><div><h2>Services</h2><p>Open apps running in this mission’s Sprite.</p></div><div><button type="button" class="secondary-action" data-services="settings">Environment settings</button><button type="button" class="secondary-action" data-services="refresh">Refresh</button><button type="button" class="primary-action" data-services="add">Add service</button></div></header>
    <p class="mission-services-notice" data-services="notice" role="status" hidden></p><div class="mission-services-content"><div class="mission-services-empty" data-services="empty" hidden><strong>No services yet</strong><p>Add an HTTP server or web app from your working files. Creating a service does not start it.</p></div><ul class="mission-service-list" data-services="list" aria-label="Mission services"></ul>
    <section class="mission-service-editor" data-services="editor" hidden><header><h3 data-services="editor-title">Add service</h3><button type="button" class="op-close" data-services="close-editor" aria-label="Close service configuration">×</button></header><form data-services="form"><fieldset data-services="fields"><div class="mission-service-fields"><label>Name<input data-services="name" required maxlength="40" placeholder="my-app" pattern="[a-z][a-z0-9-]*" spellcheck="false"></label><label>Working directory<input data-services="directory" value="/workspace" required spellcheck="false"></label><label>Command<input data-services="command" required placeholder="python" spellcheck="false"></label><label>HTTP port<input data-services="port" type="number" min="1024" max="65535" value="8080" required></label></div><details class="mission-service-arguments"><summary>Arguments</summary><label>One argument per line<textarea data-services="args" rows="4" spellcheck="false" placeholder="-m&#10;http.server&#10;8080"></textarea></label></details><p class="op-hint">Save first, then choose Start. The service continues after a code run ends.</p><footer><button type="button" class="secondary-action" data-services="cancel">Cancel</button><button type="submit" class="primary-action" data-services="save">Create service</button></footer></fieldset></form></section>
    <p class="mission-services-footnote">Starting or opening a service may wake the Sprite and incur usage. Links are private to authorized Sprites organization members; your browser may ask you to sign in. Stop run does not stop services.</p></div>`;
  const confirmation = createDialog(`${host.prefix}-service-delete`, 'Delete service?', '<div class="op-scroll"><p data-services="delete-description"></p><p class="op-hint">The service is stopped and its definition is removed. Working files and saved mission files stay unchanged.</p><p data-services="delete-error" role="alert" hidden></p></div><footer class="op-footer"><button type="button" class="secondary-action" data-services="delete-cancel">Cancel</button><button type="button" class="danger-button" data-services="delete-confirm">Delete service</button></footer>', 'execution-dialog');
  let active = false; let disposed = false; let missionId = null; let generation = 0; let loading = false; let busy = null; let error = ''; let message = '';
  let environment = null; let services = []; let editName = null; let deleting = null;
  const nodes = new Map();
  const connected = () => host.connected?.() !== false;
  const current = (captured, id) => !disposed && active && generation === captured && missionId === id;
  const usable = () => connected() && !loading && !busy && environment?.status === 'ready' && !environment?.erasedAt;
  const inspectable = () => connected() && !loading && !busy && !!environment?.workspaceId && !environment?.erasedAt && !['busy', 'deleting'].includes(environment?.status);
  const setEditor = (service = null) => {
    editName = service?.name || null; field(root, 'form').reset();
    for (const [name, value] of Object.entries({ name: service?.name || '', command: service?.command || '', args: (service?.args || []).join('\n'), directory: service?.directory || '/workspace', port: service?.httpPort || 8080 })) field(root, name).value = value;
    field(root, 'name').readOnly = !!service;
    field(root, 'editor').hidden = false; field(root, 'editor-title').textContent = service ? `Configure ${service.name}` : 'Add service';
    root.querySelector('.mission-service-arguments').open = !!service?.args?.length; render(); field(root, service ? 'command' : 'name').focus();
  };
  function render() {
    if (disposed) return;
    const notice = field(root, 'notice'); notice.textContent = !connected() ? 'Reconnecting… Service status may be out of date.' : error || message || (loading ? 'Checking services…' : environment?.erasedAt ? 'This mission was deleted. Remove its environment in Environment settings.'
      : environment?.status === 'not-created' ? environment.keepFiles ? 'Run code once to create this mission’s environment, then add a service.' : 'Turn on Keep working files in Environment settings, then run code before adding a service.'
        : environment?.status === 'busy' ? 'A code run is using this environment. Refresh when it finishes.' : environment?.status === 'needs-attention' ? 'Check the environment status in Environment settings. Existing services can still be stopped or deleted.' : '');
    notice.hidden = !notice.textContent; notice.setAttribute('role', error ? 'alert' : 'status');
    field(root, 'empty').hidden = loading || !!services.length || environment?.status !== 'ready';
    field(root, 'refresh').disabled = loading || !!busy || !connected(); field(root, 'refresh').textContent = loading ? 'Checking…' : 'Refresh'; field(root, 'refresh').dataset.loading = String(loading);
    field(root, 'add').disabled = !usable(); field(root, 'fields').disabled = !usable();
    field(root, 'save').textContent = busy?.name === 'savePreview' ? 'Saving…' : editName ? 'Save changes' : 'Create service';
    field(root, 'close-editor').disabled = !!busy; field(root, 'cancel').disabled = !!busy;
    const ids = new Set(services.map((service) => service.name));
    for (const [id, row] of nodes) if (!ids.has(id)) { row.remove(); nodes.delete(id); }
    for (const service of services) {
      let row = nodes.get(service.name);
      if (!row) {
        row = document.createElement('li'); row.dataset.serviceName = service.name;
        row.innerHTML = '<div class="mission-service-info"><strong></strong><span class="mission-service-location"></span></div><span class="execution-status" data-service-state></span><div class="mission-service-actions"><button type="button" class="secondary-action" data-service-action="open">Open ↗</button><button type="button" class="secondary-action" data-service-action="start">Start</button><button type="button" class="secondary-action" data-service-action="stop">Stop</button><button type="button" class="op-link" data-service-action="configure">Configure</button><button type="button" class="op-link" data-service-action="delete">Delete…</button></div>';
        const name = service.name;
        row.querySelector('[data-service-action="configure"]').addEventListener('click', () => { const latest = services.find((item) => item.name === name); if (latest && usable()) setEditor(latest); });
        row.querySelector('[data-service-action="start"]').addEventListener('click', () => void mutate('startPreview', { name }, 'Start requested. Refresh to check the service.', (result) => update(result, name)));
        row.querySelector('[data-service-action="stop"]').addEventListener('click', () => void mutate('stopPreview', { name }, 'Stop requested. Refresh to check the service.', (result) => update(result, name)));
        row.querySelector('[data-service-action="open"]').addEventListener('click', () => void mutate('privatePreview', { name }, '', (result) => {
          let url; try { url = new URL(result?.url); } catch { throw { reason: 'Sprites did not return a valid service link.' }; }
          if (url.protocol !== 'https:' || !url.hostname.endsWith('.sprites.app') || url.username || url.password || url.search || url.hash || result.auth !== 'sprite' || result.privateAccess !== 'admins') throw { reason: 'Private access could not be confirmed. Check the service in Sprites.' };
          if (host.openPreview) host.openPreview(url.href); else window.open(url.href, '_blank', 'noopener,noreferrer');
        }));
        row.querySelector('[data-service-action="delete"]').addEventListener('click', () => {
          if (!inspectable()) return; deleting = { missionId, name, generation };
          field(confirmation, 'delete-description').textContent = `Delete “${name}”?`; field(confirmation, 'delete-error').hidden = true; showDialog(confirmation); field(confirmation, 'delete-cancel').focus();
        });
        nodes.set(name, row); field(root, 'list').append(row);
      }
      row.querySelector('strong').textContent = service.name;
      row.querySelector('.mission-service-location').textContent = `${service.directory || '/workspace'} · Port ${service.httpPort || 'not set'}`;
      const state = row.querySelector('[data-service-state]'); state.textContent = states[service.status] || 'Status unknown'; state.dataset.state = service.status;
      for (const action of row.querySelectorAll('button')) { action.disabled = !usable(); action.dataset.loading = 'false'; }
      const start = row.querySelector('[data-service-action="start"]'); start.textContent = busy?.name === 'startPreview' && busy.target === service.name ? 'Starting…' : service.pendingChanges && service.status === 'running' ? 'Apply & restart' : 'Start';
      start.disabled = !usable() || ['starting', 'stopping'].includes(service.status) || service.status === 'running' && !service.pendingChanges;
      const stop = row.querySelector('[data-service-action="stop"]'); stop.disabled = !inspectable() || !['running', 'starting', 'unknown'].includes(service.status); stop.textContent = busy?.name === 'stopPreview' && busy.target === service.name ? 'Stopping…' : 'Stop';
      row.querySelector('[data-service-action="delete"]').disabled = !inspectable();
      const open = row.querySelector('[data-service-action="open"]'); open.disabled = !usable() || service.status !== 'running' || !service.httpPort; open.textContent = busy?.name === 'privatePreview' && busy.target === service.name ? 'Checking access…' : 'Open ↗';
      if (busy?.target === service.name) {
        const pendingAction = ({ startPreview: 'start', stopPreview: 'stop', privatePreview: 'open' })[busy.name];
        if (pendingAction) row.querySelector(`[data-service-action="${pendingAction}"]`).dataset.loading = 'true';
      }
    }
    field(root, 'list').setAttribute('aria-busy', String(loading));
    field(confirmation, 'delete-confirm').disabled = !!busy || !inspectable(); field(confirmation, 'delete-confirm').textContent = busy?.name === 'deletePreview' ? 'Deleting…' : 'Delete service';
  }
  function update(value, name) { if (value && typeof value.name === 'string') services = [...services.filter((service) => service.name !== name), value]; }
  async function load() {
    if (!active || !missionId || !connected()) { render(); return; }
    const captured = ++generation; const id = missionId; loading = true; error = ''; message = ''; render();
    try {
      const value = await host.method('getEnvironment', { missionId: id }); if (!current(captured, id)) return; environment = value;
      if (!value?.workspaceId || value.erasedAt || ['busy', 'deleting'].includes(value.status)) { services = []; return; }
      const result = await host.method('listPreviews', { missionId: id }); if (!current(captured, id)) return;
      services = Array.isArray(result) ? result.filter((service) => service && typeof service.name === 'string') : [];
    } catch (value) { if (current(captured, id)) error = failure(value, 'Could not check services. Try Refresh.'); }
    finally { if (current(captured, id)) { loading = false; render(); } }
  }
  async function mutate(name, input, success, onResult) {
    if ((['stopPreview', 'deletePreview'].includes(name) ? !inspectable() : !usable())) return;
    const captured = generation; const id = missionId; const operation = {}; busy = { name, target: input.name, operation }; error = ''; message = ''; render();
    try {
      const result = await host.method(name, { missionId: id, ...input }); if (!current(captured, id) || busy?.operation !== operation) return;
      onResult?.(result); message = success;
      if (name === 'savePreview') { field(root, 'editor').hidden = true; editName = null; }
      if (name === 'deletePreview') { services = services.filter((service) => service.name !== input.name); confirmation.close(); deleting = null; }
    } catch (value) { if (current(captured, id) && busy?.operation === operation) { error = failure(value, 'Could not update this service. Try again.'); if (confirmation.open) { field(confirmation, 'delete-error').hidden = false; field(confirmation, 'delete-error').textContent = error; } } }
    finally { if (current(captured, id) && busy?.operation === operation) { busy = null; render(); } }
  }
  function open(id) {
    if (!id || disposed) return;
    const same = active && missionId === id; active = true;
    if (same) { render(); return; }
    const changedMission = missionId !== id; missionId = id; busy = null; changed.changed();
    if (changedMission) { environment = null; services = []; field(root, 'editor').hidden = true; editName = null; }
    if (confirmation.open) confirmation.close(); deleting = null; void load();
  }
  function setActive(state) { if (state?.tab === 'services' && state.missionId) open(state.missionId); else { active = false; generation += 1; loading = false; busy = null; if (confirmation.open) confirmation.close(); deleting = null; } }
  field(root, 'refresh').addEventListener('click', () => void load()); field(root, 'settings').addEventListener('click', () => host.openEnvironment(missionId, 'settings'));
  field(root, 'add').addEventListener('click', () => { if (usable()) setEditor(); });
  for (const name of ['cancel', 'close-editor']) field(root, name).addEventListener('click', () => { field(root, 'editor').hidden = true; editName = null; });
  field(root, 'form').addEventListener('submit', (event) => {
    event.preventDefault(); if (!usable()) return;
    const name = field(root, 'name').value.trim(); const command = field(root, 'command').value.trim(); if (!name || !command) return;
    void mutate('savePreview', { name, command, args: field(root, 'args').value.split('\n').filter((arg) => arg !== ''), directory: field(root, 'directory').value.trim(), httpPort: Number(field(root, 'port').value) }, 'Service saved. Choose Start when you are ready.', (result) => update(result, name));
  });
  field(confirmation, 'delete-cancel').addEventListener('click', () => confirmation.close());
  field(confirmation, 'delete-confirm').addEventListener('click', () => { if (deleting && current(deleting.generation, deleting.missionId)) void mutate('deletePreview', { name: deleting.name, confirm: true }, 'Service deleted. Working files are unchanged.'); });
  confirmation.addEventListener('close', () => { if (!confirmation.open) deleting = null; });
  const computation = Tracker.autorun(() => {
    changed.depend(); host.connected?.();
    const published = missionId && host.environments?.findOne({ missionId });
    if (published && environment && new Date(published.updatedAt || 0) > new Date(environment.updatedAt || 0)) environment = published;
    render();
  }); render();
  return { open, setActive, dispose() { disposed = true; active = false; generation += 1; computation.stop(); if (confirmation.open) confirmation.close(); confirmation.remove(); root.replaceChildren(); } };
}
