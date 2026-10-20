import { Tracker } from 'meteor/tracker';
import { registerComposerContext } from './composer-context';
import { parsePlanRunCommand } from '../imports/constellation/plan-references';
import './chat-file-upload.css';

const svg = (body) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const clip = svg('<path d="m7 10 5-5a2.1 2.1 0 0 1 3 3l-7 7a3.5 3.5 0 0 1-5-5l8-8a4.9 4.9 0 0 1 7 7l-8 8"/>');
const fileIcon = svg('<path d="M11 2H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-5-5Z"/><path d="M11 2v5h5M7 11h6M7 14h4"/>');
const close = svg('<path d="m6 6 8 8M14 6l-8 8"/>');
const enabled = (state) => !!(state.missionId && state.environment?.keepFiles && state.environment?.workspaceId && !state.environment?.erasedAt);
const bytesLabel = (bytes) => bytes < 1_000_000 ? `${Math.ceil(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
const errorWithReason = (reason) => Object.assign(new Error(reason), { reason });
const base64 = (bytes) => {
  let value = '';
  for (let index = 0; index < bytes.length; index += 32768) value += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(value);
};
// Variable-length delimiters keep arbitrary filenames literal in Markdown and
// out of the #plan parser. Padding also handles names containing backticks.
const codePath = (path) => {
  const delimiter = '`'.repeat(Math.max(0, ...(path.match(/`+/g) || []).map((run) => run.length)) + 1);
  const padding = path.includes('`') ? ' ' : '';
  return `${delimiter}${padding}${path}${padding}${delimiter}`;
};

/** Files are saved immediately; their paths are shared only when Send is pressed. */
export function initializeChatFileUpload(host) {
  const { chat } = host;
  const previousHandler = chat.submissionHandler;
  const previousSendDisabled = chat.getAttribute('send-disabled');
  const composerContext = registerComposerContext(chat);
  const changed = new Tracker.Dependency();
  const buckets = new Map(), queues = new Map();
  let disposed = false, sending = false, account = host.snapshot().userId, pickerScope = null;
  const add = document.createElement('button');
  add.type = 'button'; add.slot = 'composer-toolbar'; add.className = 'chat-upload-button';
  add.dataset.chatUpload = ''; add.innerHTML = clip;
  add.setAttribute('aria-label', 'Upload files to mission');
  const picker = document.createElement('input');
  picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.tabIndex = -1;
  picker.setAttribute('aria-label', 'Choose mission files');
  const context = document.createElement('div');
  context.slot = 'composer-context'; context.className = 'chat-file-context'; context.dataset.chatFiles = ''; context.hidden = true;
  context.setAttribute('aria-label', 'Files for this message');
  const list = document.createElement('div'); list.className = 'chat-file-list';
  const status = document.createElement('p'); status.className = 'chat-file-status'; status.setAttribute('role', 'status');
  context.append(list, status); if (!host.externalTrigger) chat.append(add); chat.append(picker, context);
  const entries = (id) => buckets.get(id) || [];
  const fresh = (entry) => !disposed && entry.account === account && entries(entry.missionId).includes(entry);
  const sameFilesystem = (entry, state) => enabled(state) && entry.workspaceId === state.environment.workspaceId;
  const notify = () => { if (!disposed) changed.changed(); };
  const syncAccount = (state) => {
    if (state.userId !== account) { buckets.clear(); queues.clear(); account = state.userId; pickerScope = null; }
  };

  function uploadBlock(state) {
    if (!enabled(state)) return 'Enable the mission filesystem before uploading files.';
    if (state.active === false || chat.getAttribute('aria-disabled') === 'true') return 'Open an active mission to upload files.';
    if (state.connected === false) return 'Reconnect to upload files.';
    if (!state.settings?.providerConfigured || state.settings?.connectionStatus !== 'connected') return 'Connect Sprites to upload files.';
    if (state.environment.status !== 'ready') return 'Wait for the mission filesystem to be ready.';
    if (sending) return 'Wait for this message to send.';
    return '';
  }
  function sendBlock(state, selected) {
    if (!selected.length) return '';
    if (selected.some((entry) => !sameFilesystem(entry, state))) return 'The filesystem changed. Remove these file references before sending.';
    if (selected.some((entry) => ['queued', 'uploading'].includes(entry.state))) return 'Uploading files… You can keep writing.';
    if (selected.some((entry) => entry.state !== 'ready')) return 'Retry or remove the unfinished uploads before sending.';
    return '';
  }
  function action(label, attribute, handler, icon) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset[attribute] = '';
    button.setAttribute('aria-label', label); button.title = label;
    if (icon) button.innerHTML = icon; else button.textContent = label;
    button.addEventListener('click', handler); return button;
  }
  function render() {
    changed.depend(); const state = host.snapshot();
    syncAccount(state);
    const selected = entries(state.missionId), block = sendBlock(state, selected);
    add.hidden = !enabled(state); add.disabled = !!uploadBlock(state);
    add.title = uploadBlock(state) || `Upload files to mission · up to ${bytesLabel(Math.min(5_000_000, state.settings?.limits?.maxArtifactBytes || 5_000_000))} each`;
    context.hidden = !selected.length;
    composerContext.set(selected.some((entry) => entry.state === 'ready'));
    chat.setAttribute('send-disabled', String(previousSendDisabled === 'true' || !!block));
    status.textContent = block || (selected.length ? 'Saved to mission · Send to share with the crew' : '');
    status.dataset.error = String(selected.some((entry) => ['error', 'unknown'].includes(entry.state)));
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.closest('[data-chat-file-id]')?.dataset.chatFileId;
    const focusKind = focused?.dataset.fileRename !== undefined ? 'fileRename' : focused?.dataset.fileRemove !== undefined ? 'fileRemove' : focused?.dataset.fileRetry !== undefined ? 'fileRetry' : focused?.dataset.fileOpen !== undefined ? 'fileOpen' : null;
    const selection = focusKind === 'fileRename' ? [focused.selectionStart, focused.selectionEnd] : null;
    list.replaceChildren(...selected.map((entry) => {
      const item = document.createElement('div'); item.className = 'chat-file-chip'; item.dataset.chatFileId = entry.id; item.dataset.state = entry.state;
      const pending = ['queued', 'uploading'].includes(entry.state);
      const info = action(`Open ${entry.name} in Files`, 'fileOpen', () => host.openFiles(entry.missionId, entry.path), fileIcon);
      info.className = 'chat-file-info'; info.disabled = entry.state !== 'ready' || !sameFilesystem(entry, state) || sending;
      const name = document.createElement('span'); name.textContent = entry.name; name.className = 'chat-file-name';
      const detail = document.createElement('small'); detail.textContent = entry.state === 'ready' ? Number.isFinite(entry.size) ? bytesLabel(entry.size) : 'Mission file' : entry.state === 'uploading' ? 'Uploading…' : entry.state === 'queued' ? 'Queued' : entry.state === 'unknown' ? 'Unconfirmed' : 'Not uploaded';
      info.append(name, detail); item.append(info); item.setAttribute('aria-busy', String(pending));
      if (entry.error) {
        const error = document.createElement('span'); error.className = 'chat-file-error'; error.textContent = entry.error; item.append(error);
        if (entry.collision) {
          const rename = document.createElement('input'); rename.type = 'text'; rename.dataset.fileRename = ''; rename.value = entry.rename || entry.name;
          rename.setAttribute('aria-label', `New name for ${entry.name}`); rename.maxLength = 255;
          rename.addEventListener('input', () => { entry.rename = rename.value; }); rename.disabled = sending; item.append(rename);
        }
        if (entry.file) {
          const retry = action(entry.collision ? 'Upload with new name' : 'Retry upload', 'fileRetry', () => {
            if (entry.collision) {
              const name = (entry.rename || '').trim();
              if (!name || name === entry.name) { entry.error = 'Choose a different name. The existing file will not be replaced.'; notify(); return; }
              entry.name = name; entry.requestId = crypto.randomUUID();
            }
            void enqueue(entry);
          });
          retry.disabled = sending || !!uploadBlock(state) || !sameFilesystem(entry, state); item.append(retry);
        }
      }
      const remove = action(`Remove ${entry.name} from message`, 'fileRemove', () => {
        buckets.set(entry.missionId, entries(entry.missionId).filter((row) => row !== entry)); notify(); chat.focusComposer?.();
      }, close);
      remove.className = 'chat-file-remove'; remove.title = pending ? 'Remove from message · an upload already started may still finish' : 'Remove from message · saved files are kept';
      remove.disabled = sending; item.append(remove); return item;
    }));
    if (focusId && focusKind) {
      const replacement = [...list.querySelectorAll('[data-chat-file-id]')].find((item) => item.dataset.chatFileId === focusId);
      const control = [...(replacement?.querySelectorAll('button,input') || [])].find((item) => item.dataset[focusKind] !== undefined);
      control?.focus({ preventScroll: true }); if (selection) control?.setSelectionRange?.(...selection);
    }
  }
  async function upload(entry) {
    if (!fresh(entry)) return;
    const state = host.snapshot();
    // Queued files never drift to whichever mission happens to be open later.
    if (state.missionId !== entry.missionId || state.userId !== entry.account || !sameFilesystem(entry, state)) {
      entry.state = 'error'; entry.error = 'Return to this mission to retry the upload.'; notify(); return;
    }
    const block = uploadBlock(state);
    if (block) { entry.state = 'error'; entry.error = block; notify(); return; }
    entry.state = 'uploading'; entry.error = ''; entry.collision = false; notify();
    try {
      const content = base64(new Uint8Array(await entry.file.arrayBuffer()));
      const latest = host.snapshot();
      if (!fresh(entry)) return;
      if (latest.missionId !== entry.missionId || latest.userId !== entry.account || !sameFilesystem(entry, latest) || uploadBlock(latest)) {
        throw errorWithReason('The mission or filesystem changed. Return to this mission to retry.');
      }
      const result = await host.upload({ missionId: entry.missionId, name: entry.name, content, contentType: entry.file.type || 'application/octet-stream', requestId: entry.requestId });
      if (!fresh(entry)) return;
      if (result?.status !== 'completed' || result.previousEnvironment) {
        entry.state = 'unknown'; entry.error = result?.previousEnvironment ? 'This upload belongs to an older filesystem. Remove it and choose the file again.' : 'Upload not confirmed. Retry to check its status, or check Files.';
        if (result?.previousEnvironment) entry.file = null;
      } else {
        entry.state = 'ready'; entry.path = result.path; entry.size = result.size ?? entry.file.size; entry.file = null;
      }
    } catch (error) {
      if (!fresh(entry)) return;
      entry.state = 'error'; entry.error = error?.reason || 'Could not upload this file. Retry or remove it from the message.';
      entry.collision = error?.error === 'execution-file-exists';
      // Only an explicitly refused receipt is safe to retry as a new write.
      // Pending/unknown outcomes always retain their original idempotency key.
      if (error?.error === 'execution-file-request-rejected') entry.requestId = crypto.randomUUID();
    } finally { notify(); }
  }
  function enqueue(entry) {
    entry.state = 'queued'; entry.error = ''; notify();
    const previous = queues.get(entry.missionId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => upload(entry));
    queues.set(entry.missionId, next);
    void next.finally(() => { if (queues.get(entry.missionId) === next) queues.delete(entry.missionId); });
    return next;
  }
  async function selectFiles(files, scope = host.snapshot()) {
    const current = host.snapshot(); syncAccount(current);
    if (disposed || current.userId !== scope.userId || current.missionId !== scope.missionId || current.environment?.workspaceId !== scope.environment?.workspaceId) return;
    const block = uploadBlock(current);
    if (block) { host.toast?.(block, 'error'); return; }
    const maxBytes = Math.min(5_000_000, current.settings?.limits?.maxArtifactBytes || 5_000_000);
    const rows = entries(current.missionId), jobs = [];
    buckets.set(current.missionId, rows);
    for (const file of files) {
      if (rows.length >= 10) { host.toast?.('Share up to 10 files in one message.', 'error'); break; }
      const entry = { id: crypto.randomUUID(), requestId: crypto.randomUUID(), missionId: current.missionId, account, workspaceId: current.environment.workspaceId, file, name: file.name, size: file.size, state: 'queued' };
      rows.push(entry);
      if (file.size > maxBytes) { entry.state = 'error'; entry.error = `Choose a file up to ${bytesLabel(maxBytes)}.`; entry.file = null; }
      else jobs.push(enqueue(entry));
    }
    notify(); await Promise.all(jobs);
  }
  function getReadiness() {
    changed.depend(); const state = host.snapshot();
    const count = state.userId === account ? entries(state.missionId).length : 0;
    const reason = disposed ? 'This composer is closed.' : uploadBlock(state) || (count >= 10 ? 'Remove a file to add another. Share up to 10 files per message.' : '');
    return { enabled: enabled(state), reason, canUpload: !reason, count };
  }
  function attachExisting(files, scope = host.snapshot()) {
    const state = host.snapshot(); syncAccount(state);
    if (disposed || state.userId !== scope.userId || state.missionId !== scope.missionId || state.environment?.workspaceId !== scope.environment?.workspaceId) return false;
    const block = uploadBlock(state);
    if (block) { host.toast?.(block, 'error'); return false; }
    const rows = entries(state.missionId); const additions = [];
    for (const file of files) {
      const path = file?.path;
      if (typeof path !== 'string' || !path.startsWith('/workspace/') || path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(path)
        || path.split('/').slice(1).some((part) => !part || part === '.' || part === '..' || part.startsWith('.constellation'))
        || file.type !== 'file') { host.toast?.('Choose a file from this mission’s filesystem.', 'error'); return false; }
      if (!rows.some((entry) => entry.path === path && entry.state === 'ready') && !additions.some((entry) => entry.path === path)) additions.push(file);
    }
    if (rows.length + additions.length > 10) { host.toast?.('Share up to 10 files in one message.', 'error'); return false; }
    buckets.set(state.missionId, [...rows, ...additions.map((file) => ({
      id: crypto.randomUUID(), missionId: state.missionId, account, workspaceId: state.environment.workspaceId,
      path: file.path, name: file.path.slice(file.path.lastIndexOf('/') + 1), size: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined, state: 'ready', file: null,
    }))]);
    notify(); return true;
  }
  const openPicker = () => {
    if (!getReadiness().canUpload) return false;
    pickerScope = host.snapshot(); picker.click(); return true;
  };
  const picked = () => { const files = [...picker.files]; picker.value = ''; if (pickerScope) void selectFiles(files, pickerScope); pickerScope = null; };
  add.addEventListener('click', openPicker); picker.addEventListener('change', picked);
  const submit = async (submission) => {
    const state = host.snapshot(); syncAccount(state);
    // Files belong to the Mission; the message goes to the open chat (#general or a topic).
    const selected = [...entries(state.missionId)];
    if (selected.length && ((state.chatId ?? state.missionId) !== submission.sessionId || sending)) throw errorWithReason('Return to this mission before sending its files.');
    const block = sendBlock(state, selected);
    if (block) throw errorWithReason(block);
    if (selected.length && submission.mode !== 'note' && parsePlanRunCommand(submission.text)) throw errorWithReason('Remove the files from this message to run a plan. Send them in a separate message to share them as context.');
    const text = selected.length ? `${submission.text.trim() || (submission.mode === 'note' ? 'Shared files:' : 'Please review these files:')}\n\nMission files:\n${selected.map((entry) => `- ${codePath(entry.path)}`).join('\n')}` : submission.text;
    sending = true; notify();
    try {
      const forwarded = { ...submission, text };
      const result = previousHandler ? await previousHandler(forwarded)
        : submission.mode === 'note' ? await chat.agentInstance.contribute(submission.sessionId, text)
          : await chat.agentInstance.send(submission.sessionId, text, submission.recipient ? { to: submission.recipient } : undefined);
      if (!disposed && state.userId === account) buckets.set(state.missionId, entries(state.missionId).filter((entry) => !selected.includes(entry)));
      return result;
    } finally { sending = false; notify(); }
  };
  chat.submissionHandler = submit;
  const observer = new MutationObserver(notify);
  observer.observe(chat, { attributes: true, attributeFilter: ['aria-disabled'] });
  const computation = Tracker.autorun(render);
  return {
    selectFiles, openPicker, getReadiness, attachExisting,
    dispose() {
      disposed = true; computation.stop(); observer.disconnect(); composerContext.dispose();
      if (chat.submissionHandler === submit) chat.submissionHandler = previousHandler;
      if (previousSendDisabled === null) chat.removeAttribute('send-disabled'); else chat.setAttribute('send-disabled', previousSendDisabled);
      buckets.clear(); queues.clear(); add.remove(); picker.remove(); context.remove();
    },
  };
}
