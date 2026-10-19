import './execution-chat.css';

const activeStates = new Set(['queued', 'preparing', 'running', 'stopping']);
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const plain = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const languages = { python: 'Python', javascript: 'JavaScript', shell: 'Shell', bash: 'Shell' };

export function codeRunElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(milliseconds) ? milliseconds / 1000 : 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function presentation(data, stopPending) {
  const active = activeStates.has(data.status);
  const connected = !data.connectionState || data.connectionState === 'connected';
  if (active && !connected) {
    const [label, detail] = data.connectionState === 'loading'
      ? ['Checking run status', 'Waiting for a live update.']
      : data.connectionState === 'unavailable'
        ? ['Run status unavailable', 'Open the run to check its status before starting again.']
        : ['Waiting for connection', 'Run status is unconfirmed. Reconnecting does not restart the run.'];
    return { state: 'unconfirmed', label, detail, active, connected, animate: false };
  }
  if (active && (stopPending || data.stopping || data.status === 'stopping')) return {
    state: 'stopping', label: 'Stopping code', detail: 'Waiting for Sprites to confirm the stop.', active, connected, animate: true,
  };
  const states = {
    queued: ['Waiting for environment', 'Your code has not started yet.'],
    preparing: ['Preparing environment', 'Connecting to Sprites.'],
    running: ['Running in Sprites', ''],
    completed: ['Code finished', ''],
    cancelled: ['Code stopped', ''],
    failed: ['Code run failed', 'Open the run to review the error.'],
    unknown: ['Status unconfirmed', 'Check the run before starting again.'],
  };
  const state = states[data.status] ? data.status : 'unknown';
  const [label, detail] = states[state];
  return { state, label, detail, active, connected, animate: connected && ['preparing', 'running'].includes(state) };
}

/** A stable, app-owned transcript receipt. Updating the clock changes only the
 * time text; the card, actions and polite announcement remain mounted. The
 * caller owns job subscription, elapsed-time clock and permission checks. */
export function createExecutionChatCard({ onView, onStop } = {}) {
  const element = document.createElement('article');
  element.className = 'execution-chat-card';
  const titleId = `execution-chat-title-${window.crypto.randomUUID()}`;
  element.setAttribute('aria-labelledby', titleId);
  element.innerHTML = `<div class="execution-chat-body" data-code-chat="body">
    <span class="execution-chat-symbol" aria-hidden="true">
      <svg class="execution-chat-terminal" viewBox="0 0 24 24"><path d="m6.5 7.5 4 4-4 4"/><path class="execution-chat-cursor" d="M13 15.5h4.5"/></svg>
      <svg class="execution-chat-check" viewBox="0 0 24 24"><path d="m6 12 4 4 8-8"/></svg>
      <svg class="execution-chat-warning" viewBox="0 0 24 24"><path d="M12 6v7"/><path d="M12 17h.01"/></svg>
      <svg class="execution-chat-stopped" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>
    </span>
    <div class="execution-chat-content">
      <p class="execution-chat-eyebrow" data-code-chat="meta"></p>
      <h3 class="execution-chat-title" id="${titleId}" data-code-chat="title"></h3>
      <div class="execution-chat-status-line"><span class="execution-chat-state" data-code-chat="state"></span><time class="execution-chat-time" data-code-chat="time" aria-label="Elapsed time" aria-live="off"></time><span class="execution-chat-result" data-code-chat="result" hidden></span></div>
      <p class="execution-chat-detail" data-code-chat="detail" hidden></p>
    </div>
    <div class="execution-chat-actions"><button type="button" class="execution-chat-action execution-chat-view" data-code-chat="view">View run<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4"/></svg></button><button type="button" class="execution-chat-action execution-chat-stop" data-code-chat="stop" title="Stops this run, not other services in the environment.">Stop run</button></div>
  </div>
  <p class="execution-chat-action-error" data-code-chat="error" role="alert" hidden></p>
  <span class="execution-chat-announcement" data-code-chat="announcement" role="status" aria-live="polite" aria-atomic="true"></span>`;
  const find = (name) => element.querySelector(`[data-code-chat="${name}"]`);
  const ui = Object.fromEntries(['body', 'meta', 'title', 'state', 'time', 'result', 'detail', 'view', 'stop', 'error', 'announcement'].map((name) => [name, find(name)]));
  let data = {}; let disposed = false; let stopPending = false; let actionError = ''; let actionErrorKind;

  function paint() {
    if (disposed) return;
    const stopWasFocused = document.activeElement === ui.stop;
    const current = presentation(data, stopPending);
    const id = data._id ?? data.id ?? '';
    const agent = plain(data.agentDisplayName, plain(data.agent, 'Agent'));
    const title = plain(data.title, 'Code run');
    element.dataset.codeRun = id;
    element.dataset.state = current.state;
    element.dataset.active = String(current.active);
    element.dataset.animating = String(current.animate);
    element.dataset.compact = String(['completed', 'cancelled'].includes(current.state));
    ui.body.setAttribute('aria-busy', String(current.active));
    text(ui.meta, [agent, languages[data.language] ?? plain(data.language), 'Code'].filter(Boolean).join(' · '));
    text(ui.title, title);
    text(ui.state, current.label);
    text(ui.time, codeRunElapsed(data.elapsedMs));
    ui.time.dateTime = `PT${Math.max(0, Math.floor((Number.isFinite(data.elapsedMs) ? data.elapsedMs : 0) / 1000))}S`;
    ui.time.hidden = !Number.isFinite(data.elapsedMs);
    const files = Array.isArray(data.artifacts) ? data.artifacts.filter((file) => file?.id).length : 0;
    const result = !current.active && files ? `${files} ${files === 1 ? 'file' : 'files'} saved` : '';
    text(ui.result, result); ui.result.hidden = !result;
    text(ui.detail, current.detail); ui.detail.hidden = !current.detail;
    ui.stop.hidden = !current.active || typeof onStop !== 'function' || data.canStop === false;
    ui.stop.disabled = !current.connected || stopPending || data.stopping || data.status === 'stopping';
    text(ui.stop, stopPending || data.stopping || data.status === 'stopping' ? 'Stopping…' : 'Stop run');
    ui.view.disabled = typeof onView !== 'function';
    const visibleError = (current.active || actionErrorKind !== 'stop' ? actionError : '')
      || (current.active ? plain(data.actionError) : '');
    text(ui.error, visibleError); ui.error.hidden = !visibleError;
    // Deliberately excludes the clock, file counts and transient output. Only
    // meaningful stage changes announce; a one-second tick never speaks.
    text(ui.announcement, `${agent}: ${title}. ${current.label}.`);
    if (ui.stop.hidden && stopWasFocused && !ui.view.disabled) ui.view.focus({ preventScroll: true });
  }

  async function view() {
    if (disposed || typeof onView !== 'function') return;
    actionError = ''; actionErrorKind = 'view'; paint();
    try { await onView(data._id ?? data.id); }
    catch { if (!disposed) { actionError = 'Could not open this run. Try again.'; paint(); } }
  }
  async function stop() {
    if (disposed || ui.stop.hidden || ui.stop.disabled || typeof onStop !== 'function') return;
    stopPending = true; actionError = ''; actionErrorKind = 'stop'; paint();
    try { await onStop(data._id ?? data.id); }
    catch { if (!disposed) actionError = 'Could not request a stop. Check the run before trying again.'; }
    finally { stopPending = false; paint(); }
  }
  ui.view.addEventListener('click', view);
  ui.stop.addEventListener('click', stop);
  return {
    element,
    update(next) {
      if (disposed) return;
      data = next ?? {};
      if (!activeStates.has(data.status) && actionErrorKind === 'stop') actionError = '';
      paint();
    },
    dispose() { disposed = true; ui.view.removeEventListener('click', view); ui.stop.removeEventListener('click', stop); element.remove(); },
  };
}
