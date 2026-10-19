import { Tracker } from 'meteor/tracker';
import { Meteor } from 'meteor/meteor';
import './mission-files.css';

const field = (root, name) => root.querySelector(`[data-files="${name}"]`);
const sizeLabel = (size) => Number.isFinite(size) ? size < 1024 ? `${size} B` : size < 1048576 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB` : '';
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const textTypes = /^(text\/|application\/(json|javascript|xml|x-yaml|toml))/;
const textNames = /\.(txt|md|csv|tsv|json|jsonl|js|jsx|ts|tsx|py|rb|rs|go|sh|bash|zsh|css|scss|html?|xml|svg|ya?ml|toml|ini|conf|sql|log|ipynb|r|c|cpp|h)$/i;
const failure = (value, fallback) => typeof value?.reason === 'string' && value.reason.trim() ? value.reason : fallback;
const keyOf = (entry) => entry?.path ?? entry?.id ?? entry?._id;
const isFolder = (entry) => entry?.type === 'directory' || entry?.kind === 'folder';
const toBase64 = (bytes) => { let value = ''; for (let index = 0; index < bytes.length; index += 32768) value += String.fromCharCode(...bytes.subarray(index, index + 32768)); return btoa(value); };
const svg = (body) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const icons = {
  close: svg('<path d="m6 6 8 8M14 6l-8 8"/>'),
  more: svg('<circle cx="4" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="16" cy="10" r=".8"/>'),
  folder: svg('<path d="M2.5 5h5l2 2h8v11h-15Z"/>'),
  file: svg('<path d="M4.5 2.5h7l4 4v11h-11Z"/><path d="M11.5 2.5v4h4M7.5 10h5M7.5 13h5"/>'),
  refresh: svg('<path d="M16.5 8a6.5 6.5 0 1 0-.5 5M16.5 3.5V8H12"/>'),
  plus: svg('<path d="M10 4v12M4 10h12"/>'),
  down: svg('<path d="m6 8 4 4 4-4"/>'),
  upload: svg('<path d="M10 13V3m-3 3 3-3 3 3M4 13v4h12v-4"/>'),
  search: svg('<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>'),
  check: svg('<path d="m4 10 4 4 8-8"/>'),
};
let browserId = 0;

/** The mission Sprite is the filesystem; file references retain chat provenance. */
export function initializeMissionFiles(host) {
  const root = host.root;
  if (!root) return { setActive() {}, open() {}, refresh() {}, dispose() {} };
  const changed = new Tracker.Dependency();
  const readAccount = () => host.userId ? host.userId() : Meteor.userId();
  let account = readAccount();
  root.classList.add('mission-files');
  root.innerHTML = `<section class="mission-file-browser"><header class="mission-files-toolbar"><nav class="mission-files-breadcrumbs" aria-label="Folder location"><ol data-files="breadcrumbs"></ol></nav><div class="mission-files-primary-controls"><button type="button" class="toolbar-button" data-files="new" aria-haspopup="menu" aria-expanded="false">${icons.plus}New${icons.down}</button><button type="button" class="toolbar-button" data-files="upload">${icons.upload}Upload</button><input type="file" data-files="upload-input" hidden><button type="button" class="toolbar-button icon-only" data-files="refresh" aria-label="Refresh folder" title="Refresh folder">${icons.refresh}</button></div></header>
    <div class="mission-files-history" data-files="history" hidden><span data-files="history-label"></span><button type="button" class="op-link" data-files="current">Current files</button></div>
    <p class="mission-files-notice" data-files="notice" role="status"></p><section class="mission-files-enable" data-files="enable-panel" hidden><h3>Mission filesystem</h3><p data-files="enable-hint"></p><button type="button" class="primary-action" data-files="enable">Enable mission filesystem</button></section><div class="mission-files-split"><div class="mission-files-list-pane"><ul class="mission-files-list" data-files="list" aria-label="Files"></ul><button type="button" class="secondary-action mission-files-more" data-files="more" hidden>Load more existing files</button></div>
    <section class="mission-file-viewer" aria-label="File preview" hidden><header data-files="viewer-header" hidden><div><strong data-files="viewer-name"></strong><small data-files="viewer-meta"></small></div><div><button type="button" class="op-link" data-files="origin" hidden>View code run</button><button type="button" class="toolbar-button icon-only" data-files="download" aria-label="Download file" title="Download file"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m-3-3 3 3 3-3M4 13v4h12v-4"/></svg></button><button type="button" class="toolbar-button" data-files="recover" hidden>Restore a copy</button><button type="button" class="toolbar-button icon-only" data-files="close-preview" aria-label="Close preview" title="Close preview">${icons.close}</button></div></header><p data-files="viewer-notice" role="status" hidden></p><div class="mission-file-content" data-files="content"></div></section></div><footer class="mission-files-footer"><span data-files="count"></span><span data-files="path" class="mission-files-folder-path"></span><div class="mission-files-utilities" role="group" aria-label="Environment tools"><button type="button" class="toolbar-button" data-files="settings" aria-haspopup="dialog"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h8M15 5h2M3 10h2M9 10h8M3 15h6M13 15h4"/><circle cx="13" cy="5" r="2"/><circle cx="7" cy="10" r="2"/><circle cx="11" cy="15" r="2"/></svg>Mission filesystem</button><button type="button" class="toolbar-button" data-files="points" aria-haspopup="dialog"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6.5a7 7 0 1 1-1 5M3.5 2.5v4h4"/><path d="M10 6v4l2.5 1.5"/></svg>Save points</button></div></footer></section>`;
  let disposed = false; let active = false; let missionId = null; let location = 'working'; let path = '/workspace'; let savePointId = null;
  let generation = 0; let readGeneration = 0; let loading = false; let reading = false; let recovering = false; let entries = []; let cursor = null;
  let selected = null; let content = null; let objectUrl = null; let error = ''; let viewerError = ''; let environment = null; let requestedAttachmentId = null; let filesStale = false; let loaded = false;
  let search = ''; let enabling = false;
  let references = [];
  let mutating = false; let mutationSequence = 0; let panel = null; let panelSequence = 0; let panelError = ''; let editing = null; let pendingNavigation = null;
  let menu = null; let renaming = null; let returnFocus = null; let pickerScope = null;
  const drafts = new Map();
  const fieldHere = (name) => field(root, name);
  const tools = document.createElement('div'); tools.className = 'mission-files-manage-toolbar';
  tools.innerHTML = `<label class="mission-files-search">${icons.search}<span class="mission-files-sr">Search this folder</span><input type="search" data-files="search" placeholder="Search this folder" maxlength="120"></label>`;
  root.querySelector('.mission-files-toolbar').after(tools);
  const draftBanner = document.createElement('div'); draftBanner.className = 'mission-files-draft-banner'; draftBanner.hidden = true; draftBanner.dataset.files = 'draft-banner';
  draftBanner.innerHTML = '<span data-files="draft-label"></span><button type="button" class="op-link" data-files="resume-draft">Resume edits</button>'; tools.after(draftBanner);
  const actionPanel = document.createElement('div'); actionPanel.className = 'mission-files-action-overlay'; actionPanel.dataset.files = 'action-panel'; actionPanel.hidden = true;
  const titleId = `mission-file-action-${++browserId}`;
  actionPanel.innerHTML = `<section class="mission-files-action-panel" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1"><header><h3 data-files="action-title" id="${titleId}"></h3><button type="button" class="toolbar-button icon-only" data-files="close-action" aria-label="Close file action">${icons.close}</button></header><p data-files="action-error" role="alert" hidden></p><div data-files="action-body"></div></section>`; root.append(actionPanel);
  const newMenu = document.createElement('div'); newMenu.className = 'mission-files-menu'; newMenu.dataset.files = 'new-menu'; newMenu.hidden = true; newMenu.setAttribute('role', 'menu'); newMenu.setAttribute('aria-label', 'New');
  newMenu.innerHTML = `<button type="button" data-files="new-folder" role="menuitem">${icons.folder}Folder</button><button type="button" data-files="new-file" role="menuitem">${icons.file}File</button>`;
  const rowMenu = document.createElement('div'); rowMenu.className = 'mission-files-menu'; rowMenu.dataset.files = 'row-menu'; rowMenu.hidden = true; rowMenu.setAttribute('role', 'menu'); root.append(newMenu, rowMenu);
  const viewerActions = fieldHere('download').parentElement;
  const editButton = document.createElement('button'); editButton.type = 'button'; editButton.className = 'toolbar-button'; editButton.dataset.files = 'edit'; editButton.textContent = 'Edit'; viewerActions.prepend(editButton);
  const moreButton = document.createElement('button'); moreButton.type = 'button'; moreButton.className = 'toolbar-button icon-only'; moreButton.dataset.files = 'file-actions'; moreButton.innerHTML = icons.more; moreButton.setAttribute('aria-label', 'File actions'); moreButton.setAttribute('aria-haspopup', 'menu'); moreButton.setAttribute('aria-expanded', 'false'); viewerActions.insertBefore(moreButton, fieldHere('close-preview'));
  const editbar = document.createElement('div'); editbar.className = 'mission-files-editor-toolbar'; editbar.dataset.files = 'editor-toolbar'; editbar.hidden = true;
  editbar.innerHTML = '<span data-files="editor-state" role="status">Editing</span><div><button type="button" class="op-link" data-files="download-draft">Download draft</button><button type="button" class="toolbar-button" data-files="cancel-edit">Cancel</button><button type="button" class="primary-action" data-files="save-edit">Save changes</button></div>'; fieldHere('viewer-notice').after(editbar);
  const current = (captured, id) => !disposed && active && generation === captured && missionId === id && account === readAccount();
  const connected = () => host.connected?.() !== false;
  const revoke = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  const resetViewer = () => { stashDraft(); editing = null; readGeneration += 1; selected = null; content = null; reading = false; recovering = false; viewerError = ''; revoke(); field(root, 'content').replaceChildren(); };
  const canBrowse = () => !!environment && !environment.erasedAt && (environment.status === 'ready' || environment.status === 'needs-attention' && ['save', 'restore', 'policies', 'checkpoint-delete', 'preview', 'files'].includes(environment.recoveryKind));
  const liveEnvironment = () => host.environments?.findOne({ missionId }) ?? environment;
  const protectedPath = (value = path) => /^\/workspace\/(?:runs|inputs|attachments|\.constellation)(?:\/|$)/.test(value);
  const filesystemEnabled = () => liveEnvironment()?.status === 'ready' && liveEnvironment()?.keepFiles !== false && !liveEnvironment()?.erasedAt;
  const writable = () => active && !!missionId && account === readAccount() && connected() && location === 'working' && !savePointId && filesystemEnabled() && !protectedPath();
  const blocked = () => loading || reading || recovering || mutating || enabling || !connected();
  const spriteConnected = () => { const config = host.config?.(); return !config || config.providerConfigured && config.connectionStatus === 'connected'; };
  const draftKey = (entry = selected) => `${missionId}:${location}:${keyOf(entry)}`;

  function editableText() {
    if (!content || content.editable === false || isFolder(selected)) return false;
    try {
      const bytes = Uint8Array.from(atob(content.content || ''), (char) => char.charCodeAt(0));
      if (bytes.length > 1_000_000 || bytes.includes(0)) return false;
      if (!textTypes.test(content.contentType || '') && !textNames.test(content.name || selected?.name || '')) return false;
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return location === 'working' && content.writable !== false && typeof content.hash === 'string';
    } catch { return false; }
  }
  const dirty = () => !!editing && editing.text !== editing.baseline;
  function stashDraft() {
    if (dirty()) drafts.set(draftKey(), { missionId, location, path, entry: { ...selected }, content: { ...content }, ...editing });
  }
  function closePanel() {
    panelSequence += 1; panel = null; panelError = ''; pendingNavigation = null;
    actionPanel.hidden = true; root.querySelector('.mission-file-browser').inert = false; fieldHere('action-body').replaceChildren(); render();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); returnFocus = null;
  }
  function showPanel(title, state = {}) {
    const source = menu?.trigger || (newMenu.contains(document.activeElement) ? fieldHere('new') : document.activeElement); closeMenus();
    if (!panel) returnFocus = source;
    panelSequence += 1; panel = { ...state, token: panelSequence }; panelError = '';
    fieldHere('action-title').textContent = title; fieldHere('action-body').replaceChildren(); actionPanel.hidden = false;
    root.querySelector('.mission-file-browser').inert = true;
    render(); return fieldHere('action-body');
  }
  function closeMenus(restoreFocus = false) {
    const trigger = menu?.trigger;
    trigger?.setAttribute('aria-expanded', 'false'); menu = null; newMenu.hidden = true; rowMenu.hidden = true;
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  function openMenu(element, trigger) {
    if (menu?.trigger === trigger) { closeMenus(true); return; }
    closeMenus(); menu = { element, trigger }; element.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    const bounds = root.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
    const width = element.offsetWidth, height = element.offsetHeight;
    element.style.left = `${Math.max(8, Math.min(anchor.right - bounds.left - width, bounds.width - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(anchor.bottom - bounds.top + 5, bounds.height - height - 8))}px`;
    element.querySelector('button:not(:disabled)')?.focus();
  }
  function button(label, handler, primary = false, key = '') {
    const element = document.createElement('button'); element.type = 'button'; element.className = primary ? 'primary-action' : 'toolbar-button';
    element.textContent = label; if (key) element.dataset.files = key;
    element.addEventListener('click', handler); return element;
  }
  function hint(text, target = fieldHere('action-body')) { const note = document.createElement('p'); note.className = 'mission-files-action-hint'; note.textContent = text; target.append(note); return note; }
  function inputField(label, value, target, name = 'action-name') {
    const wrapper = document.createElement('label'); wrapper.className = 'mission-files-action-field';
    const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement('input'); input.type = 'text'; input.value = value || ''; input.dataset.files = name; input.autocomplete = 'off';
    wrapper.append(title, input); target.append(wrapper); return input;
  }
  function discardEdits() {
    drafts.delete(draftKey()); editing = null; closePanel(); if (content) showContent(content); render();
  }
  function guardNavigation(action) {
    if (mutating || recovering || enabling) return;
    if (!dirty()) { if (editing) discardEdits(); closePanel(); closeMenus(); if (renaming) { renaming = null; renderEntries(); } action(); return; }
    const body = showPanel(`Save changes to ${selected.name}?`, { kind: 'dirty' }); pendingNavigation = action;
    hint('Your edits have not been saved.', body);
    const actions = document.createElement('div'); actions.className = 'mission-files-action-buttons';
    actions.append(button('Save & continue', async () => { const next = pendingNavigation; if (await saveEditor()) next?.(); }, true, 'save-continue'),
      button('Discard changes', () => { const next = pendingNavigation; discardEdits(); next?.(); }, false, 'discard-edits'),
      button('Keep editing', () => { closePanel(); fieldHere('editor')?.focus(); }, false, 'keep-editing'));
    body.append(actions); render(); fieldHere('keep-editing').focus();
  }
  function startEditing(draft) {
    if (!draft && (!writable() || !editableText() || blocked())) return;
    closePanel();
    editing = draft ? { baseline: draft.baseline, text: draft.text, expectedHash: draft.expectedHash }
      : { baseline: new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(content.content || ''), (char) => char.charCodeAt(0))), expectedHash: content.hash };
    if (editing.text === undefined) editing.text = editing.baseline;
    const editor = document.createElement('textarea'); editor.className = 'mission-file-editor'; editor.dataset.files = 'editor'; editor.value = editing.text;
    editor.spellcheck = false; editor.setAttribute('aria-label', `Edit ${selected.name}`);
    editor.addEventListener('input', () => { editing.text = editor.value; stashDraft(); if (!dirty()) drafts.delete(draftKey()); render(); });
    fieldHere('content').replaceChildren(editor); render(); editor.focus();
  }
  async function saveEditor() {
    if (!editing || !dirty() || !writable() || blocked()) return false;
    if (new TextEncoder().encode(editing.text).length > 1_000_000) { viewerError = 'Text editing is limited to 1 MB. Download your draft to keep these changes.'; render(); return false; }
    const key = draftKey(); const payload = { text: editing.text, expectedHash: editing.expectedHash };
    return mutate('write', payload, selected, () => { drafts.delete(key); editing = null; });
  }
  function renderBreadcrumbs() {
    const list = fieldHere('breadcrumbs');
    const crumbs = location === 'saved' ? [{ id: '/workspace', name: 'Mission files' }, { id: null, name: 'Existing files' }]
      : path.split('/').filter(Boolean).map((name, index, all) => ({ id: `/${all.slice(0, index + 1).join('/')}`, name: index ? name : 'Mission files' }));
    list.replaceChildren(...crumbs.map((crumb, index) => {
      const item = document.createElement('li');
      const control = button(crumb.name, () => guardNavigation(() => { if (location === 'saved') savePointId = null; location = 'working'; search = ''; fieldHere('search').value = ''; void load(crumb.id); }));
      if (!index) { control.dataset.files = 'working'; control.insertAdjacentHTML('afterbegin', icons.folder); }
      control.disabled = blocked() || index === crumbs.length - 1; control.title = crumb.id || 'Existing files';
      if (index === crumbs.length - 1) control.setAttribute('aria-current', 'location'); item.append(control); return item;
    }));
  }
  function openFolder(entry) { search = ''; fieldHere('search').value = ''; void load(entry.path); }

  async function mutate(action, payload = {}, entry = panel?.entry, onSuccess) {
    if (mutating || enabling || !connected() || !active || account !== readAccount() || location !== 'working' || savePointId || recovering) return false;
    if (!filesystemEnabled() || action !== 'copy' && (entry?.writable === false || protectedPath(entry?.path || path))) {
      const message = !filesystemEnabled() ? 'The filesystem is off, busy or unavailable. Check Mission filesystem before making changes.' : 'This file is managed by Constellation and is read-only.';
      if (editing) viewerError = message; else panelError = message; render(); return false;
    }
    const id = missionId; const targetLocation = location; const captured = generation; const token = ++mutationSequence;
    const previousPreview = selected ? { entry: { ...selected }, content } : null;
    const targetsPreview = !!entry && keyOf(previousPreview?.entry) === keyOf(entry);
    const openCreatedFile = action === 'write' && panel?.kind === 'createFile';
    mutating = true; panelError = ''; viewerError = ''; render();
    try {
      const input = { missionId: id, ...(entry ? { path: entry.path } : {}), action, ...payload };
      const result = await host.method('mutateEnvironmentFile', input);
      if (!current(captured, id) || token !== mutationSequence) return false;
      onSuccess?.(result); renaming = null; closePanel(); mutating = false;
      const refresh = load(); const refreshedGeneration = generation; await refresh;
      if (disposed || !active || missionId !== id || location !== targetLocation || token !== mutationSequence || generation !== refreshedGeneration || account !== readAccount()) return true;
      // A row action should not open a preview or select its result. Keep the
      // current file in view unless that exact file changed location or bytes.
      if (openCreatedFile || targetsPreview && ['write', 'rename'].includes(action)) {
        const nextPath = action === 'rename' ? payload.destination : payload.path || entry?.path;
        const nextEntry = result?.entry || { ...entry, path: nextPath, name: nextPath?.slice(nextPath.lastIndexOf('/') + 1), type: 'file' };
        if (!isFolder(nextEntry)) await openFile(nextEntry);
      } else if (previousPreview && !(targetsPreview && ['delete', 'move'].includes(action))) {
        selected = previousPreview.entry; content = previousPreview.content;
        if (content) showContent(content); else await openFile(selected);
        render();
      }
      return true;
    } catch (value) {
      if (current(captured, id) && token === mutationSequence) {
        const message = failure(value, 'Could not save this change. Try again.');
        if (editing) viewerError = message; else if (renaming) renaming.error = message; else panelError = message;
      }
      return false;
    } finally { if (missionId === id && token === mutationSequence && !disposed) { mutating = false; render(); } }
  }

  function showActions(entry, trigger = moreButton) {
    if (location !== 'working' || savePointId || blocked()) return;
    if (menu?.trigger === trigger) { closeMenus(true); return; }
    closeMenus(); rowMenu.replaceChildren(); rowMenu.setAttribute('aria-label', `Actions for ${entry.name}`);
    const addAction = (label, action, key) => { const control = button(label, action, false, key); control.setAttribute('role', 'menuitem'); rowMenu.append(control); return control; };
    if (entry.writable !== false && !protectedPath(entry.path)) {
      addAction('Rename', () => startRename(entry), 'rename-file');
      addAction('Move to…', () => showDestination('move', entry), 'move-file');
      addAction('Copy to…', () => showDestination('copy', entry), 'copy-file');
      rowMenu.append(document.createElement('hr'));
      addAction('Delete…', () => showDelete(entry), 'delete-file').classList.add('mission-files-delete');
    } else {
      const note = hint('Read-only · Make a working copy', rowMenu); note.setAttribute('role', 'presentation');
      addAction('Copy to…', () => showDestination('copy', entry), 'copy-file');
    }
    render(); openMenu(rowMenu, trigger);
  }
  function validName(name) { return !!name && name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name) && name.length <= 255; }
  function startRename(entry) {
    if (!writable() || entry.writable === false || protectedPath(entry.path)) return;
    closeMenus(); renaming = { entry, value: entry.name, error: '' }; renderEntries();
    fieldHere('rename-name')?.focus(); fieldHere('rename-name')?.select();
  }
  function cancelRename() {
    const key = keyOf(renaming?.entry); renaming = null; renderEntries();
    [...fieldHere('list').querySelectorAll('[data-file-key]')].find((item) => item.dataset.fileKey === key)?.focus();
  }
  function saveRename(event) {
    event.preventDefault(); if (!renaming || blocked() || !writable()) return;
    const name = renaming.value.trim(), entry = renaming.entry;
    if (!validName(name)) { renaming.error = 'Use a name without slashes, not “.” or “..”.'; render(); return; }
    if (entries.some((row) => keyOf(row) !== keyOf(entry) && row.name === name)) { renaming.error = 'This folder already contains that name.'; render(); return; }
    if (name === entry.name) { cancelRename(); return; }
    void mutate('rename', { destination: `${entry.path.slice(0, entry.path.lastIndexOf('/'))}/${name}` }, entry);
  }
  function showNameForm(action, file = null) {
    if (!writable()) return;
    const title = { createFolder: 'New folder', createFile: 'New file', upload: 'Upload file' }[action];
    const body = showPanel(title, { kind: action }); const form = document.createElement('form'); form.className = 'mission-files-action-form';
    const input = inputField(action === 'createFolder' ? 'Folder name' : 'Name', file?.name || (action === 'createFile' ? 'Untitled.txt' : ''), form);
    input.required = true; input.maxLength = 255;
    if (file) hint(`${sizeLabel(file.size)} · ${path}`, form);
    const actions = document.createElement('div'); actions.className = 'mission-files-action-buttons';
    const submit = button(title, () => {}, true, 'submit-action'); submit.type = 'submit'; actions.append(submit, button('Cancel', closePanel)); form.append(actions); body.append(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (blocked()) return;
      const name = input.value.trim(); if (!validName(name)) { panelError = 'Use a name without slashes, not “.” or “..”.'; render(); return; }
      let payload = { path: `${path}/${name}` };
      if (action === 'createFile') payload = { ...payload, text: '' };
      if (file) {
        if (file.size > 5_000_000) { panelError = 'Choose a file smaller than 5 MB.'; render(); return; }
        const token = panel?.token; const id = missionId; panel.loading = true; render();
        try { payload.content = toBase64(new Uint8Array(await file.arrayBuffer())); payload.contentType = file.type || 'application/octet-stream'; }
        catch { if (panel?.token === token) { panel.loading = false; panelError = 'Could not read this file. Choose it again.'; render(); } return; }
        if (panel?.token !== token || missionId !== id || !active) return;
        panel.loading = false;
      }
      void mutate(action === 'createFile' ? 'write' : action, payload, null);
    }); render(); input.focus(); input.select();
  }
  function showDelete(entry) {
    const body = showPanel(`Delete ${entry.name}?`, { entry, kind: 'delete' });
    const target = document.createElement('code'); target.className = 'mission-files-delete-target'; target.textContent = entry.path; body.append(target);
    hint(isFolder(entry) ? 'Permanently delete this folder and everything inside it. This cannot be undone.' : 'Permanently delete this file. This cannot be undone.', body);
    const actions = document.createElement('div'); actions.className = 'mission-files-action-buttons';
    const confirm = button('Delete permanently', () => void mutate('delete', { confirm: true }, entry), false, 'confirm-delete'); confirm.className = 'danger-button';
    const cancel = button('Cancel', closePanel); actions.append(confirm, cancel); body.append(actions); render(); cancel.focus();
  }
  function showDestination(action, entry) {
    if (blocked() || !filesystemEnabled()) return;
    const body = showPanel(`${action === 'move' ? 'Move' : 'Copy'} ${entry.name}`, { entry, kind: action });
    const managed = entry.writable === false || protectedPath(entry.path);
    const initialPath = managed ? '/workspace' : entry.path.slice(0, entry.path.lastIndexOf('/'));
    const copyName = isFolder(entry) ? `${entry.name} copy` : entry.name.replace(/(\.[^.]+)?$/, ' copy$1');
    const form = document.createElement('form'); form.className = 'mission-files-action-form';
    const input = inputField('Name', action === 'copy' && !managed ? copyName : entry.name, form, 'destination-name'); input.required = true; input.maxLength = 255;
    const picker = document.createElement('section'); picker.className = 'mission-files-destination'; picker.setAttribute('aria-label', 'Destination folder');
    picker.innerHTML = '<span class="mission-files-destination-label">Destination folder</span><nav data-files="destination-breadcrumbs" aria-label="Destination location"></nav><div data-files="destination-folders" class="mission-files-destination-folders"></div><p data-files="destination-status" role="status"></p>';
    form.append(picker); hint('Existing files will not be replaced.', form);
    const submit = button(action === 'move' ? 'Move' : 'Copy', () => {}, true, 'submit-action'); submit.type = 'submit';
    const actions = document.createElement('div'); actions.className = 'mission-files-action-buttons'; actions.append(submit, button('Cancel', closePanel)); form.append(actions); body.append(form);
    const token = panel.token; panel.destinationPath = initialPath; panel.destinationReady = false;
    async function browse(destination) {
      if (panel?.token !== token || !connected() || !filesystemEnabled()) return;
      const id = missionId, captured = generation;
      const request = (panel.destinationRequest || 0) + 1; panel.destinationRequest = request;
      panel.destinationReady = false; panel.destinationLoading = true; panelError = ''; render();
      fieldHere('destination-status').textContent = 'Loading folders…'; fieldHere('destination-folders').replaceChildren();
      try {
        const result = destination === path ? { entries } : await host.method('environmentFiles', { missionId: id, path: destination });
        if (!current(captured, id) || panel?.token !== token || panel.destinationRequest !== request) return;
        panel.destinationPath = destination; panel.destinationReady = true;
        const crumbs = destination.split('/').filter(Boolean);
        fieldHere('destination-breadcrumbs').replaceChildren(...crumbs.map((name, index) => {
          const control = button(index ? name : 'Mission files', () => void browse(`/${crumbs.slice(0, index + 1).join('/')}`));
          control.disabled = index === crumbs.length - 1; if (control.disabled) control.setAttribute('aria-current', 'location'); return control;
        }));
        const folders = (result?.entries || []).filter((item) => isFolder(item) && typeof item.path === 'string' && item.path.startsWith(`${destination}/`) && item.path.slice(destination.length + 1).indexOf('/') === -1
          && !protectedPath(item.path) && item.writable !== false && !(isFolder(entry) && (item.path === entry.path || item.path.startsWith(`${entry.path}/`)))).sort((a, b) => a.name.localeCompare(b.name));
        fieldHere('destination-folders').replaceChildren(...folders.map((folder) => {
          const control = button(folder.name, () => void browse(folder.path)); control.insertAdjacentHTML('afterbegin', icons.folder); control.dataset.destinationFolder = folder.path; return control;
        }));
        fieldHere('destination-status').textContent = folders.length ? '' : 'No subfolders. You can use this folder.';
      } catch (value) { if (panel?.token === token && panel.destinationRequest === request) { panelError = failure(value, 'Could not load this folder. Try another location.'); fieldHere('destination-status').textContent = ''; } }
      finally { if (panel?.token === token && panel.destinationRequest === request) { panel.destinationLoading = false; render(); } }
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (panel?.token !== token || !panel.destinationReady || panel.destinationLoading || blocked()) return;
      const name = input.value.trim();
      if (!validName(name)) { panelError = 'Use a name without slashes, not “.” or “..”.'; render(); return; }
      const destination = `${panel.destinationPath}/${name}`;
      if (destination === entry.path || isFolder(entry) && destination.startsWith(`${entry.path}/`)) { panelError = 'Choose a different folder or name.'; render(); return; }
      void mutate(action, { destination }, entry);
    });
    input.focus(); void browse(initialPath); render();
  }

  function render() {
    if (disposed) return;
    const visibleCount = entries.filter((entry) => !search || String(entry.name).toLowerCase().includes(search.toLowerCase())).length;
    renderBreadcrumbs();
    field(root, 'working').setAttribute('aria-pressed', String(location === 'working'));
    field(root, 'path').textContent = location === 'saved' ? '' : path;
    field(root, 'refresh').disabled = loading || recovering || mutating || enabling || !connected(); field(root, 'refresh').dataset.loading = String(loading);
    field(root, 'refresh').setAttribute('aria-label', loading ? 'Refreshing folder' : 'Refresh folder');
    field(root, 'history').hidden = !savePointId || location !== 'working';
    field(root, 'history-label').textContent = savePointId ? `Save point · ${environment?.savePoints?.find((point) => point.id === savePointId)?.label || savePointId}` : '';
    const notice = field(root, 'notice');
    const unknownChange = location === 'working' && !savePointId && liveEnvironment()?.lastFileMutation?.status === 'unknown';
    const needsFilesystem = location === 'working' && !savePointId && !loading && environment && (environment.status === 'not-created' || environment.status === 'ready' && environment.keepFiles === false) && !environment.erasedAt;
    fieldHere('enable-panel').hidden = !needsFilesystem; fieldHere('enable-panel').setAttribute('aria-busy', String(enabling));
    fieldHere('enable-hint').textContent = spriteConnected() ? 'Enable the mission filesystem before uploading or creating files. Sprites usage may incur charges.' : 'Connect Sprites to enable this mission’s filesystem and upload files. Sprites usage may incur charges.';
    fieldHere('enable').textContent = enabling ? 'Creating filesystem…' : spriteConnected() ? 'Enable mission filesystem' : 'Connect Sprites';
    fieldHere('enable').dataset.loading = String(enabling); fieldHere('enable').disabled = blocked();
    tools.hidden = needsFilesystem; root.querySelector('.mission-files-split').hidden = needsFilesystem;
    notice.textContent = !connected() ? 'Reconnecting… Files shown may be out of date.' : error || (loading ? 'Loading files…' : unknownChange ? 'An interrupted file change could not be confirmed. Inspect the files before trying it again.' : filesStale && location === 'working' && !savePointId ? 'The filesystem changed. Refresh for the latest files; unsaved edits are kept.' : !visibleCount && !needsFilesystem ? search ? 'No files match this search.' : location === 'saved' ? 'No files found.' : 'This folder is empty.' : '');
    notice.hidden = !notice.textContent; notice.setAttribute('role', error ? 'alert' : 'status');
    notice.dataset.loading = String(loading);
    field(root, 'more').hidden = location !== 'saved' || !cursor; field(root, 'more').disabled = blocked();
    field(root, 'list').setAttribute('aria-busy', String(loading));
    field(root, 'content').setAttribute('aria-busy', String(reading));
    root.querySelector('.mission-files-split').dataset.preview = String(!!selected);
    root.querySelector('.mission-file-viewer').hidden = !selected;
    fieldHere('close-preview').disabled = mutating || recovering;
    field(root, 'viewer-header').hidden = !selected;
    field(root, 'viewer-name').textContent = selected?.name || '';
    field(root, 'viewer-meta').textContent = selected ? [isFolder(selected) ? 'Folder' : sizeLabel(selected.size), location === 'saved' ? 'Existing file' : savePointId ? 'Read-only save point' : selected.path, selected.legacyPath].filter(Boolean).join(' · ') : '';
    field(root, 'origin').hidden = !selected?.runId; field(root, 'download').disabled = !content || reading;
    const downloadLabel = `Download ${selected?.name || 'file'}`;
    field(root, 'download').setAttribute('aria-label', downloadLabel); field(root, 'download').title = downloadLabel;
    field(root, 'recover').hidden = location !== 'working' || !savePointId || !selected;
    field(root, 'recover').disabled = reading || recovering || !connected() || !canBrowse(); field(root, 'recover').textContent = recovering ? 'Restoring copy…' : 'Restore a copy';
    const viewerNotice = field(root, 'viewer-notice'); viewerNotice.textContent = viewerError || (reading ? 'Opening file…' : '');
    viewerNotice.hidden = !viewerNotice.textContent; viewerNotice.setAttribute('role', viewerError ? 'alert' : 'status');
    viewerNotice.dataset.loading = String(reading); field(root, 'recover').dataset.loading = String(recovering);
    for (const button of field(root, 'list').querySelectorAll('button')) { button.disabled = loading || recovering || mutating || !connected(); if (button.dataset.fileKey) button.setAttribute('aria-pressed', String(button.dataset.fileKey === keyOf(selected))); }
    fieldHere('current').disabled = recovering || mutating || enabling;
    for (const name of ['new', 'new-folder', 'new-file', 'upload']) { fieldHere(name).hidden = location !== 'working' || !!savePointId; fieldHere(name).disabled = blocked() || !writable(); }
    fieldHere('search').disabled = mutating || recovering;
    fieldHere('edit').hidden = location !== 'working' || !selected || isFolder(selected) || !!savePointId || !!editing;
    fieldHere('edit').disabled = blocked() || !writable() || !editableText();
    fieldHere('edit').title = !editableText() ? 'Edit UTF-8 text files up to 1 MB.' : 'Edit file';
    fieldHere('file-actions').hidden = location !== 'working' || !selected || !!savePointId || !!editing;
    fieldHere('file-actions').disabled = blocked();
    fieldHere('file-actions').setAttribute('aria-label', `Actions for ${selected?.name || 'file'}`);
    fieldHere('editor-toolbar').hidden = !editing;
    fieldHere('editor-state').textContent = mutating ? 'Saving changes…' : editing && !filesystemEnabled() ? 'Filesystem unavailable · Edits kept' : editing?.text !== editing?.baseline ? 'Unsaved changes' : 'Editing';
    fieldHere('save-edit').disabled = !editing || blocked() || !writable() || editing.text === editing.baseline;
    fieldHere('save-edit').dataset.loading = String(mutating && !!editing);
    fieldHere('cancel-edit').disabled = mutating; fieldHere('download-draft').disabled = !editing;
    if (fieldHere('editor')) fieldHere('editor').disabled = mutating;
    const savedDrafts = [...drafts.values()].filter((draft) => draft.missionId === missionId);
    fieldHere('draft-banner').hidden = !!editing || !savedDrafts.length;
    fieldHere('draft-label').textContent = savedDrafts.length === 1 ? `Unsaved edits: ${savedDrafts[0]?.entry.name}` : `${savedDrafts.length} files have unsaved edits.`;
    fieldHere('action-error').textContent = panelError; fieldHere('action-error').hidden = !panelError;
    actionPanel.setAttribute('aria-busy', String(mutating || !!panel?.loading)); fieldHere('close-action').disabled = mutating;
    fieldHere('action-title').dataset.loading = String(mutating || !!panel?.loading);
    if (panel) for (const input of fieldHere('action-body').querySelectorAll('input,textarea,select,button')) input.disabled = mutating || !!panel.loading
      || input.hasAttribute('aria-current') || !!panel.destinationLoading && input.closest('.mission-files-destination') !== null
      || input.dataset.files === 'submit-action' && (!connected() || !filesystemEnabled() || !!panel.destinationLoading || ['move', 'copy'].includes(panel.kind) && !panel.destinationReady);
    for (const control of rowMenu.querySelectorAll('button')) control.disabled = blocked() || !filesystemEnabled();
    if (renaming) {
      const note = fieldHere('rename-error'); if (note) { note.textContent = renaming.error; note.hidden = !renaming.error; }
      for (const control of fieldHere('list').querySelectorAll('.mission-file-rename input,.mission-file-rename button')) control.disabled = blocked() || !writable();
    }
    fieldHere('count').textContent = `${visibleCount} ${visibleCount === 1 ? 'item' : 'items'}`;
  }

  function renderEntries() {
    const rows = [...entries].filter((entry) => !search || String(entry.name).toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || (a.name || '').localeCompare(b.name || ''));
    field(root, 'list').replaceChildren(...rows.map((entry) => {
      const row = document.createElement('li'); const button = document.createElement('button'); button.type = 'button';
      const key = keyOf(entry); button.dataset.fileKey = key;
      const icon = document.createElement('span'); icon.className = 'mission-file-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = isFolder(entry) ? icons.folder : icons.file;
      if (renaming && keyOf(renaming.entry) === key) {
        const form = document.createElement('form'); form.className = 'mission-file-rename'; form.dataset.files = 'rename-form';
        const input = document.createElement('input'); input.type = 'text'; input.value = renaming.value; input.maxLength = 255; input.required = true; input.dataset.files = 'rename-name'; input.setAttribute('aria-label', `Rename ${entry.name}`);
        input.addEventListener('input', () => { renaming.value = input.value; renaming.error = ''; render(); });
        const save = document.createElement('button'); save.type = 'submit'; save.dataset.files = 'rename-save'; save.className = 'toolbar-button icon-only'; save.innerHTML = icons.check; save.setAttribute('aria-label', 'Save name'); save.title = 'Save name';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.dataset.files = 'rename-cancel'; cancel.className = 'toolbar-button icon-only'; cancel.innerHTML = icons.close; cancel.setAttribute('aria-label', 'Cancel rename'); cancel.title = 'Cancel rename'; cancel.addEventListener('click', cancelRename);
        const error = document.createElement('p'); error.dataset.files = 'rename-error'; error.setAttribute('role', 'alert'); error.hidden = true;
        form.append(icon, input, save, cancel, error); form.addEventListener('submit', saveRename); row.append(form); return row;
      }
      const name = document.createElement('span'); name.textContent = entry.name; name.className = 'mission-file-name';
      const meta = document.createElement('small'); meta.textContent = isFolder(entry) ? 'Folder' : location === 'saved' ? `${entry.legacy ? 'Preserved copy' : 'Original'} · ${sizeLabel(entry.size)}` : sizeLabel(entry.size);
      button.append(icon, name, meta); button.addEventListener('click', () => guardNavigation(() => isFolder(entry) ? openFolder(entry) : void openFile(entry))); row.append(button);
      if (location === 'working' && !savePointId) {
        const control = document.createElement('button'); control.type = 'button'; control.className = 'mission-file-row-actions'; control.innerHTML = icons.more; control.setAttribute('aria-label', `Actions for ${entry.name}`); control.dataset.fileActions = key;
        control.setAttribute('aria-haspopup', 'menu'); control.setAttribute('aria-expanded', 'false');
        control.addEventListener('click', () => { if (menu?.trigger === control) closeMenus(true); else guardNavigation(() => showActions(entry, control)); }); row.append(control);
      }
      return row;
    })); render();
  }

  async function load(nextPath = path, append = false, filePath = null) {
    if (!active || !missionId || !connected() || recovering || mutating || enabling) { render(); return; }
    closeMenus(); renaming = null;
    const captured = ++generation; const id = missionId; const targetLocation = location;
    if (!append) { resetViewer(); entries = []; cursor = null; renderEntries(); }
    loading = true; loaded = false; error = ''; filesStale = false; render();
    try {
      const catalog = await host.method('missionFiles', { missionId: id, limit: 50, ...(targetLocation === 'saved' && append && cursor ? { cursor } : {}) }).catch(() => null);
      if (!current(captured, id)) return;
      if (catalog) {
        references = [...(targetLocation === 'saved' && append ? references : []), ...(Array.isArray(catalog.rows) ? catalog.rows.filter((item) => item && typeof item.name === 'string') : [])];
        cursor = catalog.nextCursor || null;
      }
      if (!append || !environment) {
        const metadata = await host.method('getEnvironment', { missionId: id });
        if (!current(captured, id)) return; environment = metadata;
      }
      if (requestedAttachmentId) {
        const target = references.find((entry) => (entry.attachmentId ?? entry.id ?? entry._id) === requestedAttachmentId) || { id: requestedAttachmentId, name: 'Selected file' };
        requestedAttachmentId = null; loaded = true; await openFile({ ...target, reference: true }); return;
      }
      if (targetLocation === 'saved') {
        entries = references.filter((entry) => entry.needsMigration || entry.storage !== 'sprite');
      } else {
        if (!canBrowse()) {
          error = environment?.erasedAt ? 'This mission was deleted.' : environment?.status === 'not-created' && !savePointId ? '' : environment?.status === 'busy' ? 'A code run is using these files. Refresh when it finishes.' : 'Check the status in Mission filesystem before browsing files.';
          loaded = environment?.status === 'not-created';
          return;
        }
        const result = await host.method('environmentFiles', { missionId: id, path: nextPath, ...(savePointId ? { savePointId } : {}) });
        if (!current(captured, id)) return;
        path = result?.path || nextPath; entries = Array.isArray(result?.entries) ? result.entries.filter((entry) => entry && ['file', 'directory'].includes(entry.type) && typeof entry.path === 'string' && typeof entry.name === 'string').map((entry) => ({ ...references.find((reference) => reference.storage === 'sprite' && reference.path === entry.path), ...entry })) : [];
      }
      loaded = true; renderEntries();
      if (filePath && targetLocation === 'working') {
        const target = entries.find((entry) => entry.path === filePath);
        if (target && isFolder(target)) { viewerError = 'This link points to a folder. Select it to browse its files.'; render(); }
        else await openFile(target || { path: filePath, name: filePath.slice(filePath.lastIndexOf('/') + 1), type: 'file' });
      }
    } catch (value) { if (current(captured, id)) error = failure(value, 'Could not load files. Try Refresh.'); }
    finally { if (current(captured, id)) { loading = false; render(); } }
  }

  function showContent(result) {
    const target = field(root, 'content'); target.replaceChildren(); revoke();
    const type = String(result.contentType || '').split(';')[0].trim().toLowerCase();
    const bytes = Uint8Array.from(atob(result.content || ''), (char) => char.charCodeAt(0));
    if (rasterTypes.has(type)) {
      objectUrl = URL.createObjectURL(new Blob([bytes], { type })); const image = document.createElement('img'); image.src = objectUrl; image.alt = result.name || selected.name; target.append(image);
    } else if (textTypes.test(type) || textNames.test(result.name || selected.name)) {
      const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = new TextDecoder().decode(bytes.subarray(0, 200_000)); pre.append(code); target.append(pre);
      if (bytes.length > 200_000) { const note = document.createElement('p'); note.className = 'mission-file-truncated'; note.textContent = 'Showing the first 200 KB. Download the complete file.'; target.prepend(note); }
    } else { const note = document.createElement('p'); note.className = 'mission-file-empty'; note.textContent = 'This file can’t be displayed here. Download it to open it on your computer.'; target.append(note); }
  }

  async function openFile(entry) {
    if (recovering || mutating || !active || !connected()) return;
    const captured = generation; const request = ++readGeneration; const id = missionId;
    const reference = entry.reference || entry.legacyEntryId || !entry.path || entry.storage === 'database';
    stashDraft(); editing = null; selected = entry; content = null; viewerError = ''; reading = true; revoke(); field(root, 'content').replaceChildren(); render();
    try {
      const result = await host.method(reference ? 'readMissionFile' : 'readEnvironmentFile', { missionId: id,
        ...(reference ? entry.legacyEntryId ? { legacyEntryId: entry.legacyEntryId } : { attachmentId: entry.attachmentId ?? entry.id ?? entry._id } : { path: entry.path, ...(savePointId ? { savePointId } : {}) }) });
      if (!current(captured, id) || readGeneration !== request) return;
      selected = { ...selected, ...result, content: undefined, text: undefined, name: result.name || selected.name, size: result.size ?? selected.size };
      showContent(result); content = result;
      if (reference && result.storage === 'sprite' && typeof result.path === 'string') {
        location = 'working'; savePointId = null; path = result.path.slice(0, result.path.lastIndexOf('/')) || '/workspace';
        const folder = await host.method('environmentFiles', { missionId: id, path });
        if (!current(captured, id) || readGeneration !== request) return;
        entries = (folder?.entries || []).filter((item) => item && ['file', 'directory'].includes(item.type) && typeof item.path === 'string').map((item) => ({ ...references.find((ref) => ref.storage === 'sprite' && ref.path === item.path), ...item }));
        renderEntries();
      } else if (reference) {
        location = 'saved'; entries = references.filter((item) => item.needsMigration || item.storage !== 'sprite');
        if (!entries.some((item) => keyOf(item) === keyOf(entry))) entries.push(entry);
        renderEntries();
      }
    } catch (value) { if (current(captured, id) && readGeneration === request) { viewerError = failure(value, 'Could not open this file. Its Sprite may be unavailable. Check Mission filesystem and try again.'); if (reference) error = viewerError; } }
    finally { if (current(captured, id) && readGeneration === request) { reading = false; render(); } }
  }

  function open(id, options = {}) {
    if (disposed || !id) return;
    if (options.filePath !== undefined) {
      const value = options.filePath;
      if (typeof value !== 'string' || !value.startsWith('/workspace/') || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)
        || value.split('/').slice(1).some((part) => !part || part === '.' || part === '..' || part.startsWith('.constellation'))) {
        error = 'Choose a file inside this mission’s /workspace folder.'; render(); return;
      }
      if (missionId === id) {
        active = true; changed.changed();
        if (mutating || recovering || enabling) { viewerError = 'Wait for the current file operation to finish, then open this file again.'; render(); return; }
        // Returning from Chat must not replace a dirty editor, even when the
        // linked file is in another folder. Cross-mission drafts remain stashed.
        guardNavigation(() => openLocation(id, options)); return;
      }
    }
    openLocation(id, options);
  }
  function openLocation(id, options) {
    const sameMission = missionId === id;
    const targetPath = options.filePath ? options.filePath.slice(0, options.filePath.lastIndexOf('/')) : options.path;
    const nextLocation = options.filePath || options.attachmentId ? 'working' : options.location === 'working' || options.savePointId ? 'working' : ['saved', 'existing'].includes(options.location) ? 'saved' : missionId === id ? location : 'working';
    const nextPoint = nextLocation === 'working' ? Object.prototype.hasOwnProperty.call(options, 'savePointId') ? options.savePointId : options.filePath ? null : sameMission ? savePointId : null : null;
    const same = sameMission && location === nextLocation && savePointId === nextPoint && (!targetPath || targetPath === path);
    if (!same) { stashDraft(); editing = null; closePanel(); closeMenus(); renaming = null; pickerScope = null; mutationSequence += 1; mutating = false; enabling = false; search = ''; fieldHere('search').value = ''; if (!sameMission) { references = []; } }
    active = true; missionId = id; location = nextLocation; savePointId = nextPoint; requestedAttachmentId = options.attachmentId ?? null; changed.changed();
    if (!same) { recovering = false; path = targetPath || '/workspace'; environment = null; void load(path, false, options.filePath); }
    else if (options.filePath) { search = ''; fieldHere('search').value = ''; void load(targetPath, false, options.filePath); }
    else if (requestedAttachmentId && !loading) { const target = references.find((entry) => (entry.attachmentId ?? entry.id ?? entry._id) === requestedAttachmentId) || { id: requestedAttachmentId, name: 'Selected file' }; requestedAttachmentId = null; guardNavigation(() => void openFile({ ...target, reference: true })); }
    else if (editing) render();
    else if (!loaded && !loading) void load(path);
    else if (selected && !content && !reading && !loading) void openFile(selected);
    else render();
  }
  function setActive(state) { if (state?.tab === 'files' && state.missionId) open(state.missionId, state.options); else if (active) { stashDraft(); closeMenus(); closePanel(); pickerScope = null; active = false; generation += 1; readGeneration += 1; loading = false; reading = false; recovering = false; changed.changed(); } }
  field(root, 'refresh').addEventListener('click', () => guardNavigation(() => void load())); field(root, 'more').addEventListener('click', () => void load(path, true));
  async function enableFilesystem() {
    if (blocked() || environment?.erasedAt) return;
    if (!spriteConnected()) { host.openConnection?.(); return; }
    const captured = generation; const id = missionId; const token = ++mutationSequence;
    enabling = true; error = ''; render();
    try {
      const result = await (host.enableFilesystem ? host.enableFilesystem(id) : host.method('enableFilesystem', { missionId: id }));
      if (!current(captured, id) || token !== mutationSequence) return;
      environment = result; loaded = false;
      if (result?.status !== 'ready') throw { reason: 'The filesystem needs a status check. Open Mission filesystem to continue.' };
      enabling = false; location = 'working'; await load('/workspace');
    } catch (value) { if (current(captured, id) && token === mutationSequence) error = failure(value, 'Could not enable the filesystem. Check your Sprites connection and try again.'); }
    finally { if (!disposed && missionId === id && token === mutationSequence) { enabling = false; if (!active) loaded = false; render(); } }
  }
  fieldHere('enable').addEventListener('click', enableFilesystem);
  field(root, 'current').addEventListener('click', () => { closePanel(); savePointId = null; path = '/workspace'; void load(); });
  fieldHere('close-action').addEventListener('click', closePanel);
  fieldHere('new').addEventListener('click', () => { if (!blocked() && writable()) openMenu(newMenu, fieldHere('new')); });
  fieldHere('new-folder').addEventListener('click', () => guardNavigation(() => showNameForm('createFolder')));
  fieldHere('new-file').addEventListener('click', () => guardNavigation(() => showNameForm('createFile')));
  fieldHere('upload').addEventListener('click', () => guardNavigation(() => { pickerScope = { missionId, generation, path }; fieldHere('upload-input').value = ''; fieldHere('upload-input').click(); }));
  fieldHere('upload-input').addEventListener('change', () => { const file = fieldHere('upload-input').files?.[0], scope = pickerScope; pickerScope = null; fieldHere('upload-input').value = ''; if (file && scope?.missionId === missionId && scope.generation === generation && scope.path === path && writable()) showNameForm('upload', file); });
  fieldHere('file-actions').addEventListener('click', () => { if (selected) showActions(selected, moreButton); });
  fieldHere('close-preview').addEventListener('click', () => { const key = keyOf(selected); guardNavigation(() => { resetViewer(); renderEntries(); [...fieldHere('list').querySelectorAll('[data-file-key]')].find((row) => row.dataset.fileKey === key)?.focus(); }); });
  fieldHere('edit').addEventListener('click', () => startEditing());
  fieldHere('cancel-edit').addEventListener('click', () => guardNavigation(() => { if (editing) discardEdits(); }));
  fieldHere('save-edit').addEventListener('click', () => void saveEditor());
  fieldHere('search').addEventListener('input', () => { closeMenus(); renaming = null; search = fieldHere('search').value.trim(); renderEntries(); });
  fieldHere('resume-draft').addEventListener('click', async () => {
    const draft = [...drafts.values()].find((item) => item.missionId === missionId); if (!draft || blocked()) return;
    const id = missionId; location = 'working'; path = draft.path; savePointId = null; changed.changed();
    await load(); if (!active || missionId !== id) return;
    await openFile(draft.entry); if (!active || missionId !== id || keyOf(selected) !== keyOf(draft.entry) || !content) return;
    startEditing(draft);
  });
  field(root, 'settings').addEventListener('click', () => host.openEnvironment(missionId, 'settings'));
  field(root, 'points').addEventListener('click', () => host.openEnvironment(missionId, 'points'));
  field(root, 'origin').addEventListener('click', () => { if (selected?.runId) host.openRun?.(selected.runId, missionId); });
  function download(value) {
    if (!value) return;
    if (host.downloadFile) { host.downloadFile(value); return; }
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(value.content), (char) => char.charCodeAt(0))], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = value.name || selected.name; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  field(root, 'download').addEventListener('click', () => download(content));
  fieldHere('download-draft').addEventListener('click', () => { if (editing) download({ name: selected.name, contentType: 'text/plain', content: toBase64(new TextEncoder().encode(editing.text)) }); });
  field(root, 'recover').addEventListener('click', async () => {
    if (!selected || !savePointId || recovering || !canBrowse()) return;
    const captured = generation; const request = readGeneration; const id = missionId; recovering = true; viewerError = ''; render();
    try { await host.method('recoverEnvironmentFile', { missionId: id, path: selected.path, savePointId }); if (current(captured, id) && request === readGeneration) viewerError = 'Copy restored to the mission’s Sprite. The original file is unchanged.'; }
    catch (value) { if (current(captured, id) && request === readGeneration) viewerError = failure(value, 'Could not save this copy. Try again.'); }
    finally { if (current(captured, id) && request === readGeneration) { recovering = false; render(); } }
  });
  const dismissMenus = (event) => { if (menu && !menu.element.contains(event.target) && !menu.trigger.contains(event.target)) closeMenus(); };
  document.addEventListener('pointerdown', dismissMenus);
  const keydown = (event) => {
    if (event.key === 'Escape') {
      if (mutating || recovering || enabling) return;
      if (panel) { event.preventDefault(); closePanel(); }
      else if (menu) { event.preventDefault(); closeMenus(true); }
      else if (renaming) { event.preventDefault(); cancelRename(); }
      return;
    }
    if (panel && event.key === 'Tab') {
      const controls = [...actionPanel.querySelectorAll('button,input,textarea,select')].filter((item) => !item.disabled && !item.hidden);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !actionPanel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !actionPanel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    } else if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const controls = [...menu.element.querySelectorAll('button:not(:disabled)')];
      const index = controls.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
      event.preventDefault(); controls[next]?.focus();
    } else if (menu && event.key === 'Tab') closeMenus();
  };
  root.addEventListener('keydown', keydown);
  const hideMenusOnResize = () => closeMenus(); window.addEventListener('resize', hideMenusOnResize);
  const computation = Tracker.autorun(() => {
    changed.depend(); host.connected?.();
    const nextAccount = readAccount();
    if (account !== nextAccount) {
      generation += 1; readGeneration += 1; mutationSequence += 1; resetViewer(); drafts.clear(); closeMenus(); closePanel();
      account = nextAccount; active = false; missionId = null; environment = null; entries = []; references = []; loaded = false;
      loading = false; reading = false; recovering = false; mutating = false; enabling = false; renaming = null; pickerScope = null;
      search = ''; path = '/workspace'; location = 'working'; savePointId = null; fieldHere('search').value = ''; renderEntries();
    }
    // Publications mark a cached file list stale; they never silently wake a Sprite.
    const published = missionId && host.environments?.findOne({ missionId });
    if (published && environment && !loading && (published.workspaceId !== environment.workspaceId
      || (published.fileRevision || 0) !== (environment.fileRevision || 0)
      || String(published.restoredAt || '') !== String(environment.restoredAt || '') || published.erasedAt
      || published.currentJobId || ['run', 'restore', 'preview'].includes(published.operationKind))) filesStale = true;
    render();
  }); render();
  return { open: (...args) => Tracker.nonreactive(() => open(...args)), setActive: (state) => Tracker.nonreactive(() => setActive(state)), refresh: () => guardNavigation(() => void load()), dispose() { disposed = true; active = false; generation += 1; readGeneration += 1; mutationSequence += 1; revoke(); computation.stop(); document.removeEventListener('pointerdown', dismissMenus); window.removeEventListener('resize', hideMenusOnResize); root.removeEventListener('keydown', keydown); root.replaceChildren(); } };
}
