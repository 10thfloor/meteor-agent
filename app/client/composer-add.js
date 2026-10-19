import { Tracker } from 'meteor/tracker';
import './composer-add.css';

const icon = (name) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
  add: '<path d="M10 4v12M4 10h12"/>', upload: '<path d="M10 13V3m-4 4 4-4 4 4M4 12v5h12v-5"/>',
  file: '<path d="M11 2H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-5-5Z"/><path d="M11 2v5h5"/>',
  folder: '<path d="M2 5h6l2 2h8v9H2Z"/>', plan: '<rect x="4" y="2.5" width="12" height="15" rx="2"/><path d="M7 7h6M7 10h6M7 13h3"/>',
  back: '<path d="m11 5-5 5 5 5M6 10h10"/>', close: '<path d="m6 6 8 8M14 6l-8 8"/>',
}[name]}</svg>`;
const validPath = (value) => typeof value === 'string' && value.startsWith('/workspace/') && value.length <= 1024
  && !/[\\\x00-\x1f\x7f]/.test(value) && !value.split('/').slice(1).some((part) => !part || part === '.' || part === '..' || part.startsWith('.constellation'));
const scopeKey = (state) => JSON.stringify([state.userId, state.missionId, state.environment?.workspaceId]);
const sizeLabel = (size) => !Number.isFinite(size) ? '' : size < 1000 ? `${size} B` : size < 1_000_000 ? `${Math.ceil(size / 1000)} KB` : `${(size / 1_000_000).toFixed(1)} MB`;
let nextId = 0;

/** One entry point for message context. Browsing never writes files or sends. */
export function initializeComposerAdd(host) {
  const { chat, files } = host;
  const changed = new Tracker.Dependency();
  let disposed = false, opened = false, mode = 'menu', scope = null, generation = 0;
  let loading = false, path = '/workspace', entries = [], error = '', limitNotice = false;
  const add = document.createElement('button'); add.type = 'button'; add.slot = 'composer-toolbar';
  add.className = 'composer-add-button'; add.dataset.composerAdd = ''; add.innerHTML = `${icon('add')}<span>Add</span>`;
  add.setAttribute('aria-label', 'Add to message'); add.setAttribute('aria-haspopup', 'dialog'); add.setAttribute('aria-expanded', 'false');
  const popover = document.createElement('div'); popover.id = `composer-add-${++nextId}`; popover.className = 'composer-add-popover';
  popover.setAttribute('popover', 'auto'); popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', 'Add to message');
  add.setAttribute('aria-controls', popover.id);
  popover.innerHTML = `<section data-add="menu"><div class="composer-add-heading"><strong>Add to message</strong><button type="button" data-add="close" aria-label="Close add menu">${icon('close')}</button></div>
    <button type="button" class="composer-add-option" data-add="upload">${icon('upload')}<span><strong data-add="upload-label">Upload files</strong><small data-add="upload-hint">From your computer</small></span></button>
    <button type="button" class="composer-add-option" data-add="choose">${icon('folder')}<span><strong>Choose mission file</strong><small data-add="choose-hint">Already saved in this mission</small></span></button>
    <button type="button" class="composer-add-option" data-add="plan">${icon('plan')}<span><strong>Attach plan</strong><small>Use as context · does not run the plan</small></span></button></section>
    <section data-add="browser" hidden><header class="composer-add-heading"><button type="button" data-add="back" aria-label="Back to add menu">${icon('back')}</button><strong>Choose mission file</strong><button type="button" data-add="close-files" aria-label="Close file picker">${icon('close')}</button></header>
      <nav class="composer-file-folder" aria-label="Mission folder"><button type="button" data-add="root" title="/workspace">Mission files</button><span data-add="folder"></span><button type="button" data-add="up" aria-label="Parent folder" title="Parent folder">${icon('back')}</button></nav>
      <input type="search" data-add="search" aria-label="Search this folder" placeholder="Search this folder…" autocomplete="off" maxlength="120">
      <div class="composer-file-results" data-add="results"></div><footer class="composer-file-foot"><span>Select a file to add to your message</span><button type="button" data-add="refresh">Refresh</button></footer></section>`;
  chat.append(add); document.body.append(popover);
  const field = (name) => popover.querySelector(`[data-add="${name}"]`);
  const busy = () => chat.shadowRoot?.querySelector('.composer')?.getAttribute('aria-busy') === 'true';
  const disabled = (state) => disposed || !state.missionId || state.active === false || chat.getAttribute('aria-disabled') === 'true' || busy();
  const notify = () => { if (!disposed) changed.changed(); };
  const matchesScope = () => scope && scopeKey(scope) === scopeKey(host.snapshot());
  const fileReady = () => files.getReadiness();
  function position() {
    if (!opened) return;
    const anchor = add.getBoundingClientRect(); const width = Math.min(mode === 'files' ? 390 : 320, window.innerWidth - 24);
    popover.style.width = `${width}px`;
    popover.style.maxHeight = `${Math.max(120, Math.min(500, window.innerHeight - 24))}px`;
    const height = popover.getBoundingClientRect().height;
    popover.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
    popover.style.top = `${Math.max(12, Math.min(anchor.top - height - 8, window.innerHeight - height - 12))}px`;
  }
  function close(focus = false) {
    generation += 1; loading = false; opened = false; add.setAttribute('aria-expanded', 'false');
    if (popover.matches(':popover-open')) popover.hidePopover();
    if (focus && !disposed && add.isConnected) add.focus({ preventScroll: true });
  }
  function showMenu() {
    if (disabled(host.snapshot())) return;
    mode = 'menu'; generation += 1; loading = false; scope = host.snapshot(); opened = true;
    if (!popover.matches(':popover-open')) popover.showPopover();
    add.setAttribute('aria-expanded', 'true'); render();
    field('upload').focus({ preventScroll: true });
  }
  function renderFiles() {
    field('folder').textContent = path === '/workspace' ? '' : path.slice('/workspace/'.length);
    field('folder').title = path; field('root').disabled = loading || path === '/workspace'; field('up').hidden = path === '/workspace'; field('up').disabled = loading || path === '/workspace';
    const readiness = fileReady(); field('refresh').disabled = loading || !readiness.canUpload;
    field('search').disabled = loading;
    const results = field('results'); results.setAttribute('aria-busy', String(loading)); results.replaceChildren();
    if (loading || error) {
      const status = document.createElement('div'); status.className = 'composer-file-status'; status.setAttribute('role', error ? 'alert' : 'status');
      if (loading) { const spinner = document.createElement('span'); spinner.className = 'composer-file-spinner'; spinner.setAttribute('aria-hidden', 'true'); status.append(spinner); }
      const message = document.createElement('span'); message.textContent = error || 'Loading files…'; status.append(message);
      if (error) { const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again'; retry.dataset.add = 'retry'; retry.disabled = !readiness.canUpload; retry.addEventListener('click', () => void load(path)); status.append(retry); }
      results.append(status); return;
    }
    const query = field('search').value.trim().toLocaleLowerCase();
    const matching = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
    if (!matching.length) {
      const empty = document.createElement('p'); empty.className = 'composer-file-status'; empty.setAttribute('role', 'status');
      empty.textContent = query ? 'No files match. Try another name.' : 'This folder is empty.'; results.append(empty);
    }
    for (const entry of matching) {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'composer-file-option'; item.dataset.filePath = entry.path;
      item.innerHTML = icon(entry.type === 'directory' ? 'folder' : 'file');
      const name = document.createElement('span'); name.textContent = entry.name;
      const detail = document.createElement('small'); detail.textContent = entry.type === 'directory' ? 'Open folder' : sizeLabel(entry.size);
      item.append(name, detail); item.disabled = !readiness.canUpload;
      item.setAttribute('aria-label', `${entry.type === 'directory' ? 'Open folder' : 'Add file'} ${entry.name}`);
      item.addEventListener('click', () => {
        if (!matchesScope() || disabled(host.snapshot()) || !fileReady().canUpload) return;
        if (entry.type === 'directory') { field('search').value = ''; void load(entry.path); }
        else if (files.attachExisting([entry], scope)) { close(); chat.focusComposer?.(); }
      });
      results.append(item);
    }
    if (limitNotice) { const hint = document.createElement('p'); hint.className = 'composer-file-status'; hint.textContent = 'Showing the first 1,000 items. Use Files to organize larger folders.'; results.append(hint); }
  }
  function render() {
    changed.depend(); const state = host.snapshot(); const readiness = fileReady();
    add.disabled = disabled(state);
    if (opened && (!matchesScope() || add.disabled || mode === 'files' && !readiness.enabled)) close();
    field('menu').hidden = mode !== 'menu'; field('browser').hidden = mode !== 'files';
    popover.dataset.mode = mode; popover.setAttribute('aria-label', mode === 'files' ? 'Choose mission file' : 'Add to message');
    field('upload-label').textContent = readiness.enabled ? 'Upload files' : 'Enable mission filesystem';
    field('upload-hint').textContent = readiness.enabled ? readiness.reason || 'From your computer' : 'Set up files for this mission';
    field('upload').disabled = add.disabled || (readiness.enabled ? !readiness.canUpload : !host.enableFilesystem || state.connected === false);
    field('choose').disabled = add.disabled || !readiness.canUpload;
    field('choose-hint').textContent = readiness.enabled ? 'Already saved in this mission' : 'Enable the mission filesystem first';
    field('plan').disabled = add.disabled || !host.openPlans;
    if (opened && mode === 'files') renderFiles();
    position();
  }
  async function load(nextPath) {
    if (!opened || !matchesScope() || !fileReady().canUpload || disabled(host.snapshot())) return;
    const request = ++generation; path = nextPath; loading = true; error = ''; entries = []; limitNotice = false; render();
    try {
      const result = await host.listFiles({ missionId: scope.missionId, path });
      if (disposed || !opened || request !== generation || !matchesScope()) return;
      if (!Array.isArray(result?.entries) || result.path && result.path !== path) throw new Error('Invalid folder response');
      entries = result.entries.slice(0, 1000).filter((entry) => entry && ['file', 'directory'].includes(entry.type) && validPath(entry.path)
        && entry.path.slice(0, entry.path.lastIndexOf('/')) === path)
        .map((entry) => ({ path: entry.path, name: entry.path.slice(entry.path.lastIndexOf('/') + 1), type: entry.type, size: entry.size }));
      limitNotice = result.entries.length >= 1000;
    } catch (caught) {
      if (request === generation && matchesScope()) error = typeof caught?.reason === 'string' ? caught.reason : 'Could not load mission files. Try again.';
    } finally {
      if (!disposed && opened && request === generation && matchesScope()) { loading = false; render(); field('search').focus({ preventScroll: true }); }
    }
  }
  function showFiles() {
    if (disabled(host.snapshot()) || !fileReady().canUpload) return;
    mode = 'files'; scope = host.snapshot(); opened = true; field('search').value = '';
    if (!popover.matches(':popover-open')) popover.showPopover(); add.setAttribute('aria-expanded', 'true'); void load('/workspace');
  }
  add.addEventListener('click', () => opened ? close(true) : showMenu());
  field('close').addEventListener('click', () => close(true)); field('close-files').addEventListener('click', () => close(true));
  field('back').addEventListener('click', showMenu); field('choose').addEventListener('click', showFiles);
  field('upload').addEventListener('click', () => {
    const state = host.snapshot(); if (disabled(state)) return;
    const readiness = fileReady(); close();
    if (readiness.enabled) files.openPicker(); else host.enableFilesystem?.(state.missionId);
  });
  field('plan').addEventListener('click', () => { if (disabled(host.snapshot())) return; close(); host.openPlans?.(add); });
  field('root').addEventListener('click', () => { field('search').value = ''; void load('/workspace'); });
  field('up').addEventListener('click', () => { field('search').value = ''; void load(path.slice(0, path.lastIndexOf('/')) || '/workspace'); });
  field('refresh').addEventListener('click', () => void load(path)); field('search').addEventListener('input', () => { renderFiles(); position(); });
  const toggle = () => { if (!popover.matches(':popover-open') && opened) close(); };
  popover.addEventListener('toggle', toggle);
  popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target instanceof HTMLInputElement && event.key !== 'ArrowDown') return;
    const controls = [...(mode === 'menu' ? field('menu').querySelectorAll('.composer-add-option') : field('results').querySelectorAll('button'))].filter((control) => !control.disabled);
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
    event.preventDefault(); controls[next].focus({ preventScroll: true });
  });
  const observer = new MutationObserver(notify);
  observer.observe(chat, { attributes: true, attributeFilter: ['aria-disabled'] });
  if (chat.shadowRoot) observer.observe(chat.shadowRoot, { subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
  const resize = new ResizeObserver(position); resize.observe(popover); resize.observe(add);
  window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
  const computation = Tracker.autorun(render);
  return { showMenu, showFiles, close, control: add, dispose() {
    close(); disposed = true; observer.disconnect(); resize.disconnect(); computation.stop();
    window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
    add.remove(); popover.remove();
  } };
}
