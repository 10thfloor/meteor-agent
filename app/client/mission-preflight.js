import { Tracker } from 'meteor/tracker';

/** Optional, mission-local setup. Chat never waits on this checklist. */
export function initializeMissionPreflight(host) {
  const { root } = host;
  root.innerHTML = `<header><strong>Mission preflight</strong><span>Optional setup</span></header>
    <div class="preflight-row"><span class="preflight-indicator" data-check="brief" aria-hidden="true"></span><div><strong>Brief</strong><small data-value="brief"></small></div><button type="button" data-action="brief">Add brief</button></div>
    <div class="preflight-row"><span class="preflight-indicator" data-check="crew" aria-hidden="true"></span><div><strong>Crew</strong><small data-value="crew"></small></div><button type="button" data-action="crew">Review crew</button></div>
    <div class="preflight-row"><span class="preflight-indicator" data-check="limits" aria-hidden="true"></span><div><strong>Approvals &amp; budget</strong><small data-value="limits"></small></div><button type="button" data-action="limits">Review limits</button></div>
    <div class="preflight-row preflight-files"><span class="preflight-indicator" data-check="files" aria-hidden="true"></span><div><strong>Mission filesystem</strong><small data-value="files"></small></div><button type="button" data-action="files">Enable mission filesystem</button></div>
    <p class="preflight-error" role="alert" hidden></p>`;
  const pending = new Set(); const errors = new Map(); const confirmed = new Map();
  const changed = new Tracker.Dependency(); let disposed = false;
  const find = (selector) => root.querySelector(selector);
  const buttons = Object.fromEntries(['brief', 'crew', 'limits', 'files'].map((name) => [name, find(`[data-action="${name}"]`)]));
  const value = (name, text, state) => { find(`[data-value="${name}"]`).textContent = text; find(`[data-check="${name}"]`).dataset.state = state; };
  const filesystem = (current) => {
    if (current.environment?.workspaceId) confirmed.delete(current.missionId);
    return confirmed.get(current.missionId) ?? current.environment;
  };
  function render() {
    changed.depend(); const current = host.snapshot(); const { missionId, crew = [], connected = true } = current;
    const config = current.config ?? {}; const settings = current.settings ?? {};
    const environment = filesystem(current); const busy = pending.has(missionId);
    const attention = ['needs-attention', 'deleting'].includes(environment?.status);
    const enabled = environment?.keepFiles && environment?.workspaceId;
    value('brief', config.objective?.trim() ? 'Added' : 'Start with your goal in chat', config.objective?.trim() ? 'ready' : 'off');
    buttons.brief.textContent = config.objective?.trim() ? 'Edit brief' : 'Add brief';
    value('crew', `${crew.length} agent${crew.length === 1 ? '' : 's'}`, crew.length ? 'ready' : 'attention');
    value('limits', `${config.approvals !== false ? 'Ask by default' : 'Auto-approve by default'} · $${Number(config.budget?.spend ?? 5).toFixed(2)} model limit`, 'ready');
    buttons.limits.title = 'Deletion always asks. Individual tool approval policies still apply.';
    value('files', busy ? 'Preparing workspace…' : attention ? 'Needs attention' : enabled ? 'Ready · /workspace' : environment?.workspaceId ? 'Off · files retained' : 'Off · Sprites usage charges apply', busy ? 'busy' : attention ? 'attention' : enabled ? 'ready' : 'off');
    const needsConnection = !settings.providerConfigured || settings.connectionStatus !== 'connected';
    buttons.files.textContent = busy ? 'Enabling…' : attention ? 'Review filesystem' : enabled ? 'Open files' : needsConnection ? 'Connect Sprites' : 'Enable mission filesystem';
    buttons.files.dataset.loading = String(busy);
    buttons.files.setAttribute('aria-busy', String(busy));
    buttons.files.title = !connected ? 'Reconnect to the local server first' : enabled ? 'Open this mission’s Files tab' : 'Creates a remote Sprite workspace. Sprites usage charges apply.';
    for (const button of Object.values(buttons)) button.disabled = !missionId || !current.config;
    buttons.files.disabled ||= busy || !connected;
    const error = errors.get(missionId); find('.preflight-error').hidden = !error; find('.preflight-error').textContent = error ?? '';
  }
  async function action(event) {
    const name = event.target.closest('[data-action]')?.dataset.action; if (!name) return;
    const current = host.snapshot(); const id = current.missionId;
    if (!id) return;
    if (name === 'brief' || name === 'limits') { host.openSettings(id, name); return; }
    if (name === 'crew') { host.openCrew(id); return; }
    if (pending.has(id)) return;
    const environment = filesystem(current);
    if (['needs-attention', 'deleting'].includes(environment?.status)) { host.openEnvironment(id); return; }
    if (environment?.workspaceId && environment.keepFiles) { host.openFiles(id); return; }
    const settings = current.settings ?? {};
    if (!settings.providerConfigured || settings.connectionStatus !== 'connected') { host.openConnection(); return; }
    pending.add(id); errors.delete(id); changed.changed();
    try { const result = await host.enable(id); if (!disposed) confirmed.set(id, result); }
    catch (error) { if (!disposed) errors.set(id, error.reason || error.message || 'Could not enable the filesystem. Try again.'); }
    finally { pending.delete(id); if (!disposed) changed.changed(); }
  }
  root.addEventListener('click', action);
  const computation = Tracker.autorun(render);
  return { dispose() { disposed = true; computation.stop(); root.removeEventListener('click', action); root.replaceChildren(); } };
}
