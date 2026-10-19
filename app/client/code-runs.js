import { Tracker } from 'meteor/tracker';
import { Agent } from 'meteor/10thfloor:agent';
import './code-runs.css';

const activeStatuses = new Set(['queued', 'preparing', 'running', 'stopping']);
const labels = { queued: 'Queued', preparing: 'Preparing', running: 'Running', stopping: 'Stopping', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped', unknown: 'Needs attention' };
const stamp = (value) => new Date(value ?? 0).getTime() || 0;
const byNewest = (a, b) => stamp(b.createdAt) - stamp(a.createdAt) || String(b._id).localeCompare(String(a._id));
const errorText = (error, fallback) => typeof error?.reason === 'string' && error.reason.trim() ? error.reason : fallback;
const text = (node, value) => { const next = String(value ?? ''); if (node.textContent !== next) node.textContent = next; };
const duration = (job, now) => {
  const from = stamp(job.startedAt ?? job.createdAt); const until = stamp(job.completedAt) || (activeStatuses.has(job.status) ? now : 0);
  if (!from || !until) return '—';
  const seconds = Math.max(0, Math.floor((until - from) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const date = (value) => stamp(value) ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const initial = () => ({ search: '', status: '', agent: '', missionFilter: '', cursors: [null], page: 0, rows: [], nextCursor: null,
  selected: null, selectedMission: null, detail: null, detailTab: 'output', scroll: 0, loaded: false });

/** One scalable run browser, mounted either in a mission or the global dialog.
 * History pages contain metadata only. Source/output load for one exact run. */
export function initializeCodeRuns(host) {
  const { root, jobs, method } = host; const global = host.global === true;
  const states = new Map(); const rows = new Map(); const changed = new Tracker.Dependency();
  const find = (name) => root.querySelector(`[data-runs="${name}"]`);
  let state = initial(); let scope = null; let shown = false; let disposed = false; let generation = 0;
  let listRequest = 0; let detailRequest = 0; let loading = false; let detailLoading = false; let error = ''; let detailError = '';
  let subscription = null; let subscriptionKey = null; let subscriptionFailed = false; let pendingAction = null;
  let timer = null; let searchTimer = null; let detailSignature = '';
  const connection = () => host.connectionStatus?.()?.connected !== false;
  const effectiveMission = () => global ? state.missionFilter || null : scope;
  const name = (id) => host.agentName?.(id) ?? id ?? 'Agent';
  const missionName = (job) => job.missionTitle || host.missionName?.(job.missionId) || 'Untitled mission';
  const current = (captured) => !disposed && shown && captured === generation;
  root.classList.add('code-runs');
  root.hidden = true;
  root.innerHTML = `<div class="code-runs-toolbar"><label class="code-runs-search"><span class="code-runs-sr">Search code runs</span><input type="search" data-runs="search" placeholder="Search runs" maxlength="120"></label><label><span class="code-runs-sr">Status</span><select data-runs="status" aria-label="Filter runs by status"><option value="">All statuses</option>${Object.entries(labels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label><span class="code-runs-sr">Agent</span><select data-runs="agent" aria-label="Filter runs by agent"><option value="">All agents</option></select></label><label data-runs="mission-field" ${global ? '' : 'hidden'}><span class="code-runs-sr">Mission</span><select data-runs="mission" aria-label="Filter runs by mission"><option value="">All missions</option></select></label><button type="button" class="secondary-action" data-runs="refresh">Refresh</button></div>
    <p class="code-runs-notice" data-runs="notice" role="status" hidden></p>
    <div class="code-runs-layout"><div class="code-runs-list"><div class="code-runs-table-scroll" data-runs="table-scroll" tabindex="0" aria-label="Code runs"><table><thead><tr><th scope="col">Status</th><th scope="col">Run</th>${global ? '<th scope="col">Mission</th>' : ''}<th scope="col">Agent</th><th scope="col">Duration</th><th scope="col">Files</th><th scope="col">Started</th></tr></thead><tbody data-runs="rows"></tbody></table><p class="code-runs-empty" data-runs="empty" role="status"></p></div><footer class="code-runs-pagination"><span data-runs="page-label"></span><div><button type="button" class="secondary-action" data-runs="previous">Previous</button><button type="button" class="secondary-action" data-runs="next">Next</button></div></footer></div>
    <section class="code-run-detail" data-runs="detail" aria-label="Selected run" hidden><header><div><span class="execution-status" data-runs="detail-status"></span><h3 data-runs="title"></h3><p data-runs="detail-meta"></p></div><button type="button" class="code-run-close" data-runs="close-detail" aria-label="Close run details">×</button></header><p class="code-runs-notice" data-runs="detail-notice" role="status" hidden></p><div class="code-run-actions"><button type="button" class="secondary-action" data-runs="stop">Stop run</button><button type="button" class="secondary-action" data-runs="cleanup">Remove remote workspace</button><button type="button" class="secondary-action" data-runs="environment">Check environment</button><button type="button" class="secondary-action" data-runs="retry-detail" hidden>Retry</button></div><div class="code-run-tabs" role="tablist" aria-label="Run result"><button type="button" data-runs-tab="output" role="tab">Output</button><button type="button" data-runs-tab="code" role="tab">Code</button><button type="button" data-runs-tab="files" role="tab">Files</button></div><div class="code-run-content" data-runs="detail-scroll" tabindex="0"><section data-runs-panel="output" role="tabpanel"><pre data-runs="stdout"></pre><details data-runs="stderr-section" hidden><summary>Error output</summary><pre data-runs="stderr"></pre></details><p class="code-run-hint" data-runs="truncated" hidden>Output was shortened. Saved files contain the complete exported results.</p></section><section data-runs-panel="code" role="tabpanel" hidden><pre data-runs="code"></pre></section><section data-runs-panel="files" role="tabpanel" hidden><ul class="code-run-files" data-runs="files"></ul><p class="code-run-hint" data-runs="no-files">No files were saved by this run.</p></section></div></section></div>`;
  const pageSize = 25;
  const tabsId = `code-run-tabs-${window.crypto.randomUUID()}`;
  for (const button of root.querySelectorAll('[data-runs-tab]')) {
    const value = button.dataset.runsTab; const panel = root.querySelector(`[data-runs-panel="${value}"]`);
    button.id = `${tabsId}-${value}-tab`; panel.id = `${tabsId}-${value}-panel`;
    button.setAttribute('aria-controls', panel.id); panel.setAttribute('aria-labelledby', button.id);
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...root.querySelectorAll('[data-runs-tab]')].filter((tab) => !tab.disabled);
      if (!tabs.length) return;
      event.preventDefault(); const index = tabs.indexOf(button);
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.click(); next.focus();
    });
  }

  function syncSelect(control, options, selected) {
    const signature = JSON.stringify(options);
    if (control.dataset.options !== signature) {
      control.dataset.options = signature;
      control.replaceChildren(...options.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
    }
    control.value = selected;
  }
  function ensureSubscription() {
    const key = shown ? effectiveMission() || '@workspace' : null;
    if (key === subscriptionKey) return;
    subscription?.stop(); subscription = null; subscriptionKey = key; subscriptionFailed = false;
    if (!key) return;
    const captured = generation;
    subscription = Tracker.nonreactive(() => host.subscribe(...(key === '@workspace'
      ? ['constellation.execution.workspaceJobs'] : ['constellation.execution.missionJobs', key]), {
      onError() { if (current(captured) && subscriptionKey === key) { subscriptionFailed = true; changed.changed(); } },
    }));
  }
  function matches(job) {
    return !job.erasedAt && (!effectiveMission() || job.missionId === effectiveMission())
      && (!state.status || job.status === state.status) && (!state.agent || job.agent === state.agent)
      && (!state.search || String(job.title || '').toLowerCase().includes(state.search.toLowerCase()));
  }
  function visibleRows() {
    const live = jobs.find({ ...(effectiveMission() ? { missionId: effectiveMission() } : {}) }).fetch();
    const byId = new Map(live.map((job) => [job._id, job]));
    const merged = new Map(state.rows.map((job) => [job._id, { ...job, ...byId.get(job._id) }]));
    // Keep the server page boundary intact. Prepending newly published rows
    // would push records off this page while its cursor still skips them.
    return [...merged.values()].filter(matches).sort(byNewest).slice(0, pageSize);
  }
  async function refresh({ reset = false } = {}) {
    if (!shown || disposed) return;
    if (reset) { state.cursors = [null]; state.page = 0; state.scroll = 0; find('table-scroll').scrollTop = 0; }
    const captured = generation; const request = ++listRequest; const missionId = effectiveMission();
    loading = true; error = ''; render();
    try {
      const result = await method('historyPage', { ...(missionId ? { missionId } : {}), ...(state.search ? { search: state.search } : {}),
        ...(state.status ? { status: state.status } : {}), ...(state.agent ? { agent: state.agent } : {}),
        ...(state.cursors[state.page] ? { cursor: state.cursors[state.page] } : {}), limit: pageSize });
      if (!current(captured) || request !== listRequest) return;
      state.rows = (Array.isArray(result?.rows) ? result.rows : []).filter((job) => typeof job?._id === 'string' && (!missionId || job.missionId === missionId) && !job.erasedAt);
      state.nextCursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null; state.loaded = true;
    } catch (value) { if (current(captured) && request === listRequest) error = errorText(value, 'Could not load runs. Try Refresh.'); }
    finally { if (current(captured) && request === listRequest) { loading = false; changed.changed(); } }
  }
  async function loadDetail() {
    if (!shown || !state.selected || !state.selectedMission) return;
    const captured = generation; const request = ++detailRequest; const id = state.selected; const missionId = state.selectedMission;
    detailLoading = true; detailError = ''; render();
    try {
      const result = await method('getRun', { missionId, jobId: id });
      if (!current(captured) || request !== detailRequest || state.selected !== id || state.selectedMission !== missionId) return;
      if (!result || result._id !== id || result.missionId !== missionId || result.erasedAt) throw { reason: 'This run is unavailable in this mission.' };
      state.detail = result;
    } catch (value) {
      if (current(captured) && request === detailRequest) { state.detail = null; detailError = errorText(value, 'Could not load this run. Try again.'); }
    } finally { if (current(captured) && request === detailRequest) { detailLoading = false; changed.changed(); } }
  }
  function selectRun(jobId, missionId) {
    if (!shown || !jobId || !missionId || (!global && missionId !== scope)) return;
    const same = state.selected === jobId && state.selectedMission === missionId;
    state.selected = jobId; state.selectedMission = missionId;
    if (!same) { state.detail = null; state.detailTab = 'output'; detailSignature = ''; pendingAction = null; find('detail-scroll').scrollTop = 0; }
    void loadDetail(); render();
  }
  function closeDetail() { detailRequest += 1; state.selected = null; state.selectedMission = null; state.detail = null; detailError = ''; detailLoading = false; pendingAction = null; render(); }
  function drawDetail() {
    const detail = find('detail'); detail.hidden = !state.selected;
    root.classList.toggle('has-detail', !!state.selected); if (!state.selected) return;
    const live = jobs.findOne({ _id: state.selected, missionId: state.selectedMission });
    const job = state.detail ? { ...state.detail, ...live } : null;
    const unavailable = !!live?.erasedAt;
    const notice = find('detail-notice');
    const message = unavailable ? 'This run is unavailable in this mission.' : detailError || (detailLoading ? 'Loading run…' : job?.error?.reason || '');
    text(notice, message); notice.hidden = !message; notice.setAttribute('role', detailError || unavailable ? 'alert' : 'status');
    notice.dataset.busy = String(detailLoading); detail.setAttribute('aria-busy', String(detailLoading));
    text(find('title'), job?.title || (detailLoading ? 'Loading run…' : 'Run unavailable'));
    const status = find('detail-status'); text(status, job ? labels[job.status] || 'Needs attention' : ''); status.dataset.state = job?.status ?? 'unknown';
    text(find('detail-meta'), job ? [global ? missionName(job) : null, name(job.agent), job.language, date(job.createdAt), duration(job, Date.now()), Number.isInteger(job.exitCode) ? `Exit ${job.exitCode}` : null].filter(Boolean).join(' · ') : '');
    const enabled = !!job && !unavailable;
    find('stop').hidden = !enabled || !activeStatuses.has(job.status); find('stop').disabled = !!pendingAction || !connection() || job?.status === 'stopping';
    text(find('stop'), pendingAction === 'stop' || job?.status === 'stopping' ? 'Stopping…' : 'Stop run');
    find('cleanup').hidden = !enabled || !job.cleanupPending || activeStatuses.has(job.status); find('cleanup').disabled = !!pendingAction || !connection();
    text(find('cleanup'), pendingAction === 'cleanup' ? 'Removing…' : 'Remove remote workspace');
    find('environment').hidden = !enabled || !job.persistent || job.status !== 'unknown';
    find('retry-detail').hidden = !detailError || detailLoading;
    for (const button of root.querySelectorAll('[data-runs-tab]')) { const selected = button.dataset.runsTab === state.detailTab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; button.disabled = !enabled; }
    for (const panel of root.querySelectorAll('[data-runs-panel]')) panel.hidden = panel.dataset.runsPanel !== state.detailTab;
    text(find('stdout'), enabled ? job.stdout || (activeStatuses.has(job.status) ? 'No output yet.' : 'No output captured.') : '');
    text(find('stderr'), enabled ? job.stderr || '' : ''); find('stderr-section').hidden = !enabled || !job.stderr;
    text(find('code'), enabled ? job.code || 'No source captured.' : ''); find('truncated').hidden = !enabled || !job.truncated;
    const files = enabled && Array.isArray(job.artifacts) ? job.artifacts.filter((file) => file?.id) : [];
    const signature = JSON.stringify([state.selected, files]);
    if (signature !== detailSignature) {
      detailSignature = signature; find('files').replaceChildren(...files.map((file) => {
        const row = document.createElement('li'); const view = document.createElement('button'); view.type = 'button'; view.className = 'code-run-file-link'; view.textContent = file.name || 'File';
        view.setAttribute('aria-label', `Open ${file.name || 'file'} in mission files`);
        const capturedId = job._id; const capturedMission = job.missionId;
        view.addEventListener('click', () => host.navigateToMissionWork?.('files', capturedMission, { attachmentId: file.id }));
        const download = document.createElement('button'); download.type = 'button'; download.className = 'op-link'; download.textContent = 'Download'; download.setAttribute('aria-label', `Download ${file.name || 'file'}`);
        download.addEventListener('click', async () => {
          const captured = generation; const selectedRequest = detailRequest;
          if (download.disabled) return; download.disabled = true; text(download, 'Preparing…');
          try {
            const url = await (host.attachmentUrl ? host.attachmentUrl(job, file) : new Agent(job.agent || 'orchestrator').attachmentUrl(job.sessionId, file.id));
            if (!current(captured) || selectedRequest !== detailRequest || state.selected !== capturedId || state.selectedMission !== capturedMission) return;
            if (host.download) host.download(url); else window.location.assign(url);
          } catch (value) { if (current(captured) && selectedRequest === detailRequest && state.selected === capturedId) { detailError = errorText(value, 'Could not download this file. Try again.'); changed.changed(); } }
          finally { if (download.isConnected) { download.disabled = false; text(download, 'Download'); } }
        });
        row.append(view, download); return row;
      }));
    }
    find('no-files').hidden = !!files.length;
  }
  function render() {
    if (!shown || disposed) return;
    ensureSubscription();
    syncSelect(find('agent'), [['', 'All agents'], ...(host.crew?.() ?? []).map((agent) => [agent.agent ?? agent._id, agent.displayName || agent.agent || agent._id])], state.agent);
    if (global) syncSelect(find('mission'), [['', 'All missions'], ...(host.missions?.() ?? []).map((mission) => [mission._id ?? mission.id, mission.title || 'Untitled mission'])], state.missionFilter);
    const visible = visibleRows(); const ids = new Set(visible.map((job) => job._id));
    for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
    for (const [index, job] of visible.entries()) {
      let row = rows.get(job._id);
      if (!row) {
        row = document.createElement('tr'); row.dataset.jobId = job._id;
        row.innerHTML = `<td><span class="execution-status" data-cell="status"></span></td><td class="code-run-name"><button type="button" data-cell="title"></button><span data-cell="language"></span></td>${global ? '<td data-cell="mission"></td>' : ''}<td data-cell="agent"></td><td data-cell="duration"></td><td data-cell="files"></td><td data-cell="started"></td>`;
        row.querySelector('button').addEventListener('click', () => selectRun(job._id, job.missionId)); rows.set(job._id, row);
      }
      const cell = (key) => row.querySelector(`[data-cell="${key}"]`);
      text(cell('status'), labels[job.status] || 'Needs attention'); cell('status').dataset.state = job.status;
      text(cell('title'), job.title || 'Code run'); text(cell('language'), job.language || '');
      text(cell('agent'), name(job.agent)); text(cell('duration'), duration(job, Date.now()));
      text(cell('files'), Array.isArray(job.artifacts) ? job.artifacts.length : 0); text(cell('started'), date(job.createdAt));
      if (global) text(cell('mission'), missionName(job));
      row.classList.toggle('is-selected', job._id === state.selected); cell('title').setAttribute('aria-current', String(job._id === state.selected));
      if (find('rows').children[index] !== row) find('rows').insertBefore(row, find('rows').children[index] ?? null);
    }
    const first = state.rows[0];
    const newCount = state.loaded && state.page === 0 ? jobs.find({ ...(effectiveMission() ? { missionId: effectiveMission() } : {}) }).fetch()
      .filter((job) => matches(job) && !state.rows.some((row) => row._id === job._id) && (!first || byNewest(job, first) < 0)).length : 0;
    const warning = error || (!connection() ? 'Connection lost. Showing the last available run states.' : subscriptionFailed ? 'Live updates are unavailable. Refresh to check the latest results.' : loading ? 'Loading runs…'
      : newCount ? `${newCount} new ${newCount === 1 ? 'run' : 'runs'} available. Refresh to show them.` : '');
    text(find('notice'), warning); find('notice').hidden = !warning; find('notice').setAttribute('role', error || subscriptionFailed ? 'alert' : 'status');
    find('notice').dataset.busy = String(loading); find('table-scroll').setAttribute('aria-busy', String(loading));
    find('empty').hidden = !!visible.length;
    text(find('empty'), loading ? 'Loading runs…' : error ? 'Runs could not be loaded.' : state.search || state.status || state.agent ? 'No runs match these filters.' : 'No code runs yet. Ask an agent to work on a file or calculation.');
    text(find('page-label'), `Page ${state.page + 1} · ${visible.length} ${visible.length === 1 ? 'run' : 'runs'}`);
    find('previous').disabled = loading || state.page === 0; find('next').disabled = loading || !state.nextCursor;
    find('refresh').disabled = loading; find('refresh').setAttribute('aria-busy', String(loading));
    drawDetail();
    const detailStatus = state.detail && (jobs.findOne({ _id: state.selected, missionId: state.selectedMission })?.status ?? state.detail.status);
    const needsClock = connection() && (visible.some((job) => activeStatuses.has(job.status)) || activeStatuses.has(detailStatus));
    if (needsClock && timer === null) timer = window.setInterval(() => { if (shown && !disposed) render(); }, 1000);
    if (!needsClock && timer !== null) { window.clearInterval(timer); timer = null; }
  }
  async function runAction(action) {
    if (!state.detail || pendingAction || !connection()) return;
    const captured = generation; const id = state.selected; pendingAction = action; detailError = ''; render();
    try { await method(action, { jobId: id }); if (current(captured) && state.selected === id) { void refresh(); void loadDetail(); } }
    catch (value) { if (current(captured) && state.selected === id) detailError = errorText(value, 'Could not update this run. Try again.'); }
    finally { if (current(captured) && state.selected === id) { pendingAction = null; changed.changed(); } }
  }
  function changeFilters() { generation += 1; listRequest += 1; detailRequest += 1; pendingAction = null; subscriptionKey = null; closeDetail(); void refresh({ reset: true }); }
  find('search').addEventListener('input', () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { state.search = find('search').value.trim(); changeFilters(); }, 180); });
  for (const key of ['status', 'agent', 'mission']) find(key).addEventListener('change', (event) => { state[key === 'mission' ? 'missionFilter' : key] = event.currentTarget.value; changeFilters(); });
  find('refresh').addEventListener('click', () => { void refresh({ reset: true }); if (state.selected) void loadDetail(); });
  find('previous').addEventListener('click', () => { if (loading || !state.page) return; state.page -= 1; state.rows = []; find('table-scroll').scrollTop = 0; void refresh(); });
  find('next').addEventListener('click', () => { if (loading || !state.nextCursor) return; state.cursors[state.page + 1] = state.nextCursor; state.page += 1; state.rows = []; find('table-scroll').scrollTop = 0; void refresh(); });
  find('close-detail').addEventListener('click', closeDetail); find('retry-detail').addEventListener('click', () => void loadDetail());
  find('stop').addEventListener('click', () => void runAction('stop')); find('cleanup').addEventListener('click', () => void runAction('cleanup'));
  find('environment').addEventListener('click', () => host.openEnvironment?.(state.selectedMission));
  for (const button of root.querySelectorAll('[data-runs-tab]')) button.addEventListener('click', () => { state.detailTab = button.dataset.runsTab; find('detail-scroll').scrollTop = 0; drawDetail(); });
  function setActive({ missionId = null, active = false, jobId } = {}) {
    const key = global ? '@workspace' : missionId;
    const activating = active && (!shown || scope !== key);
    if (scope !== key) {
      if (scope) { state.scroll = find('table-scroll').scrollTop; states.set(scope, state); }
      generation += 1; listRequest += 1; detailRequest += 1; state = states.get(key) ?? initial(); scope = key;
      error = ''; detailError = ''; loading = false; detailLoading = false; pendingAction = null; detailSignature = '';
      rows.clear(); find('rows').replaceChildren(); find('search').value = state.search; find('status').value = state.status;
      find('table-scroll').scrollTop = state.scroll;
    }
    if (shown !== active) { generation += 1; listRequest += 1; detailRequest += 1; shown = active; loading = false; detailLoading = false; pendingAction = null; }
    root.hidden = !shown; ensureSubscription();
    if (!shown) { if (timer !== null) window.clearInterval(timer); timer = null; window.clearTimeout(searchTimer); return; }
    render(); if (activating && !state.loaded && !loading) void refresh();
    if (jobId && (activating || state.selected !== jobId || state.selectedMission !== missionId)) selectRun(jobId, missionId);
    else if (activating && state.selected) void loadDetail();
    changed.changed();
  }
  const computation = Tracker.autorun(() => { changed.depend(); if (shown) render(); });
  // The app calls setActive from its own reactive view computation. Keep our
  // dependencies inside this controller, not that caller's computation.
  return { setActive: (options) => Tracker.nonreactive(() => setActive(options)),
    selectRun: (jobId, missionId) => Tracker.nonreactive(() => selectRun(jobId, missionId)), refresh,
    dispose() { disposed = true; generation += 1; computation.stop(); subscription?.stop(); window.clearInterval(timer); window.clearTimeout(searchTimer); root.replaceChildren(); } };
}
