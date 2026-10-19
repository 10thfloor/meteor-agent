import { Meteor } from 'meteor/meteor';
import { createDialog, showDialog, dateLabel } from './operations';

const PAGE_SIZE = 20;
const REFRESH_MS = 12_000;
const statusLabels = { working: 'Working', waiting: 'Needs approval', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };
const labelFor = (row) => row.displayName ?? row.label ?? row.name ?? row.agent;
const agentId = (row) => row.agent ?? row._id;

/** Mission-scoped work history. The transcript stacks above it, never replaces it. */
export function initializeAgentWork(host) {
  const id = host.id ?? 'agent-work-dialog';
  const dialog = createDialog(id, 'Agent work', `
    <div class="agent-work-filters">
      <label>Agent<select data-work-agent aria-label="Filter agent work by agent"><option value="">All agents</option></select></label>
      <label>Status<select data-work-status aria-label="Filter agent work by status"><option value="">All statuses</option>${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <button class="secondary-action agent-work-refresh" data-work-refresh type="button">Refresh</button>
    </div>
    <div class="agent-work-notice" data-work-notice role="status" aria-live="polite"></div>
    <div class="agent-work-scroll" data-work-scroll>
      <div class="agent-work-empty" data-work-empty></div>
      <ul class="agent-work-list" data-work-list aria-label="Agent assignments"></ul>
      <div class="agent-work-pagination"><button class="secondary-action" data-work-more type="button" hidden>Load more</button></div>
    </div>
    <footer class="agent-work-footer"><span data-work-count aria-live="polite"></span><span data-work-updated></span></footer>
  `, 'agent-work-dialog');
  const $ = (name) => dialog.querySelector(`[data-work-${name}]`);
  const agentSelect = $('agent');
  const statusSelect = $('status');
  const list = $('list');
  const scroller = $('scroll');
  let missionId = null;
  let items = [];
  let roster = [];
  let cursor = null;
  let generation = 0;
  let timer = null;
  let busy = false;
  let disposed = false;
  let childDialog = null;
  let childClose = null;
  let refreshError = false;
  let returnLauncher = null;

  const valid = (request) => !disposed && dialog.open && request === generation && missionId === host.missionId();
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && dialog.open) timer = setTimeout(() => {
      if (document.visibilityState === 'hidden' || childDialog?.open || busy) schedule();
      else void load('refresh', true);
    }, REFRESH_MS);
  };
  const currentLabel = (agent) => [...(host.crew?.() ?? []), ...roster].find((row) => agentId(row) === agent);
  const nameFor = (agent, fallback) => labelFor(currentLabel(agent) ?? { agent, displayName: fallback });

  function renderAgents() {
    const selected = agentSelect.value;
    const available = new Map();
    for (const row of [...roster, ...(host.crew?.() ?? [])]) {
      if (agentId(row)) available.set(agentId(row), labelFor(row));
    }
    if (selected && !available.has(selected)) available.set(selected, selected);
    const options = [{ value: '', label: 'All agents' }, ...[...available].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([value, label]) => ({ value, label }))];
    // Preserve the select itself (and its focus) during background updates.
    const signature = JSON.stringify(options);
    if (agentSelect.dataset.options !== signature) {
      agentSelect.replaceChildren(...options.map(({ value, label }) => new Option(label, value)));
      agentSelect.value = selected;
      agentSelect.dataset.options = signature;
    }
  }

  function setNotice(message = '', error = false, retryAction) {
    const notice = $('notice');
    notice.replaceChildren();
    notice.classList.toggle('is-error', error);
    notice.setAttribute('role', error ? 'alert' : 'status');
    if (message) {
      const text = document.createElement('span'); text.textContent = message; notice.append(text);
      if (error) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'op-link'; retry.textContent = 'Retry';
        retry.addEventListener('click', () => { if (retryAction) retryAction(); else void load(items.length ? 'refresh' : 'initial'); }); notice.append(retry);
      }
    }
  }

  function renderEmpty({ loading = false, error = false } = {}) {
    const empty = $('empty');
    empty.hidden = items.length > 0;
    if (empty.hidden) return;
    empty.replaceChildren();
    if (loading) {
      const indicator = document.createElement('div'); indicator.className = 'op-loading'; indicator.setAttribute('role', 'status');
      indicator.innerHTML = '<span aria-hidden="true"></span>Loading agent work…'; empty.append(indicator); return;
    }
    const title = document.createElement('strong');
    title.textContent = error ? 'Could not load agent work' : !missionId ? 'Open a mission to view agent work' : cursor ? 'No matches in the most recent work' : agentSelect.value || statusSelect.value ? 'No matching work' : 'No agent work yet';
    empty.append(title);
    if (!error && missionId) {
      const hint = document.createElement('p');
      hint.textContent = cursor ? 'Load more to search older assignments.' : agentSelect.value || statusSelect.value ? 'Try another agent or status.' : 'Ask Atlas to delegate a task, or run a plan with agent steps.';
      empty.append(hint);
    }
    if (!error && (agentSelect.value || statusSelect.value)) {
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'secondary-action'; clear.textContent = 'Clear filters';
      clear.addEventListener('click', () => { agentSelect.value = ''; statusSelect.value = ''; resetAndLoad(); }); empty.append(clear);
    }
  }

  function rowElement() {
    const item = document.createElement('li');
    item.innerHTML = '<button type="button" class="agent-work-row"><span class="agent-work-avatar" aria-hidden="true"></span><span class="agent-work-copy"><span class="agent-work-heading"><strong data-row-agent></strong><span class="agent-work-status"><i aria-hidden="true"></i><span data-row-status></span></span></span><span class="agent-work-assignment" data-row-assignment></span><span class="agent-work-meta"><span data-row-requester></span><time></time></span></span><span class="agent-work-open" aria-hidden="true">View work <span>↗</span></span></button>';
    item.querySelector('button').addEventListener('click', (event) => openTranscript(item._work, event.currentTarget));
    return item;
  }

  function renderRows() {
    const focused = document.activeElement;
    const focusId = focused?.closest('[data-work-session]')?.dataset.workSession;
    const scroll = scroller.scrollTop;
    const rows = new Map([...list.children].map((row) => [row.dataset.workSession, row]));
    items.forEach((work, index) => {
      const row = rows.get(work.sessionId) ?? rowElement();
      rows.delete(work.sessionId);
      row.dataset.workSession = work.sessionId;
      row._work = work;
      const agentName = nameFor(work.agent, work.displayName);
      row.querySelector('[data-row-agent]').textContent = agentName;
      row.querySelector('.agent-work-avatar').textContent = String(agentName).slice(0, 1).toUpperCase();
      row.querySelector('[data-row-status]').textContent = work.statusLabel ?? statusLabels[work.status] ?? 'Saved';
      row.querySelector('.agent-work-status').dataset.state = work.status;
      row.querySelector('[data-row-assignment]').textContent = work.assignmentPreview || work.label || 'Agent assignment';
      const requesterName = work.requester?.agent ? nameFor(work.requester.agent, work.requester.displayName) : work.requester?.displayName;
      row.querySelector('[data-row-requester]').textContent = work.source === 'plan' ? `Plan: ${work.planName || requesterName || 'Saved plan'}` : `Assigned by ${requesterName || 'Atlas'}`;
      const time = row.querySelector('time');
      const date = new Date(work.createdAt);
      time.textContent = Number.isNaN(date.getTime()) ? '' : dateLabel(date);
      if (!Number.isNaN(date.getTime())) { time.dateTime = date.toISOString(); time.title = date.toLocaleString(); }
      row.querySelector('button').setAttribute('aria-label', `View ${agentName}’s work: ${work.assignmentPreview || work.label || 'Agent assignment'}`);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    });
    rows.forEach((row) => row.remove());
    // Reordering a DOM node can unset focus in Chromium. Keep keyboard users on
    // the same assignment; if a status filter removes it, return to that filter.
    if (focusId && dialog.contains(focused) && focused.isConnected) focused.focus({ preventScroll: true });
    else if (focusId && !focused.isConnected) statusSelect.focus({ preventScroll: true });
    scroller.scrollTop = scroll;
    $('count').textContent = items.length ? `${items.length} assignment${items.length === 1 ? '' : 's'}${cursor ? ' shown' : ''}` : '';
    $('more').hidden = !cursor;
    $('more').disabled = busy;
    renderEmpty();
  }

  async function load(mode = 'initial', quiet = false) {
    if (disposed || !dialog.open || !missionId || (busy && mode === 'more')) return;
    clearTimeout(timer);
    const request = ++generation;
    const args = { missionId, ...(agentSelect.value ? { agent: agentSelect.value } : {}), ...(statusSelect.value ? { status: statusSelect.value } : {}), limit: PAGE_SIZE };
    const targetCount = mode === 'refresh' ? Math.max(PAGE_SIZE, items.length) : PAGE_SIZE;
    let pageCursor = mode === 'more' ? cursor : undefined;
    let nextItems = mode === 'more' ? [...items] : [];
    let fetched = 0;
    let nextRoster = roster;
    let refreshedAt;
    busy = true; refreshError = false;
    $('refresh').disabled = true;
    $('more').disabled = true;
    if (!quiet) {
      setNotice();
      if (!items.length) renderEmpty({ loading: true });
      else if (mode === 'more') { $('more').dataset.loading = 'true'; $('more').textContent = 'Loading…'; }
      else { $('refresh').dataset.loading = 'true'; $('refresh').textContent = 'Refreshing…'; }
    }
    try {
      do {
        const page = await Meteor.callAsync('constellation.agentWork.list', { ...args, ...(pageCursor ? { cursor: pageCursor } : {}) });
        if (!valid(request)) return;
        const seen = new Set(nextItems.map((row) => row.sessionId));
        nextItems.push(...(page.items ?? []).filter((row) => !seen.has(row.sessionId)));
        fetched += page.items?.length ?? 0;
        pageCursor = page.nextCursor ?? null;
        nextRoster = [...new Map([...nextRoster, ...(page.agents ?? [])].map((row) => [agentId(row), row])).values()];
        refreshedAt = page.refreshedAt;
      } while (mode === 'refresh' && pageCursor && fetched < targetCount);
      if (!valid(request)) return;
      items = nextItems; cursor = pageCursor; roster = nextRoster;
      setNotice(); renderAgents(); renderRows();
      $('updated').textContent = refreshedAt ? `Updated ${new Date(refreshedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    } catch (error) {
      if (!valid(request)) return;
      refreshError = true;
      setNotice(error?.reason || 'Could not load agent work. Try again.', true, () => void load(mode));
      renderEmpty({ error: true });
    } finally {
      if (valid(request)) {
        busy = false;
        $('refresh').disabled = false; $('refresh').dataset.loading = 'false'; $('refresh').textContent = 'Refresh';
        $('more').disabled = false; $('more').dataset.loading = 'false'; $('more').textContent = 'Load more';
        schedule();
      }
    }
  }

  function resetAndLoad() {
    generation += 1; busy = false; items = []; cursor = null; refreshError = false;
    $('refresh').disabled = !missionId; $('refresh').dataset.loading = 'false'; $('refresh').textContent = 'Refresh';
    $('more').dataset.loading = 'false'; $('more').textContent = 'Load more';
    scroller.scrollTop = 0; renderRows(); setNotice();
    $('updated').textContent = '';
    if (missionId) void load();
  }

  function openTranscript(work, control) {
    if (!work || childDialog?.open) return;
    const scroll = scroller.scrollTop;
    clearTimeout(timer);
    try {
      childDialog = host.openChild(work.sessionId, work.agent);
      if (!childDialog?.addEventListener) { childDialog = null; schedule(); return; }
      childClose = () => {
        childDialog = null; childClose = null;
        if (!dialog.open || disposed) return;
        scroller.scrollTop = scroll;
        if (control.isConnected) control.focus({ preventScroll: true });
        schedule();
      };
      childDialog.addEventListener('close', childClose, { once: true });
    } catch (error) {
      childDialog = null;
      setNotice(error?.reason || 'Could not open this agent’s work. Try again.', true, () => openTranscript(work, control)); schedule();
    }
  }

  function syncScope() {
    dialog.querySelector(`#${id}-scope`).textContent = host.missionTitle?.() || 'Current mission';
    renderAgents();
  }

  agentSelect.addEventListener('change', resetAndLoad);
  statusSelect.addEventListener('change', resetAndLoad);
  $('refresh').addEventListener('click', () => void load(items.length ? 'refresh' : 'initial'));
  $('more').addEventListener('click', () => void load('more'));
  dialog.addEventListener('close', () => {
    generation += 1; busy = false; clearTimeout(timer);
    // Crew rows are reactive and may be replaced while this dialog is open.
    // Restore to the equivalent control instead of dropping keyboard focus.
    if (!dialog._returnFocus?.isConnected && returnLauncher) {
      const container = document.getElementById(returnLauncher.containerId);
      const selector = `[data-agent="${CSS.escape(returnLauncher.agent)}"] [data-crew-action="${CSS.escape(returnLauncher.action)}"]`;
      const target = container?.querySelector(selector) ?? document.getElementById('inspector-tab-crew');
      target?.focus({ preventScroll: true });
    }
  });
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden' && dialog.open && !childDialog?.open && !busy) void load(items.length ? 'refresh' : 'initial', !refreshError);
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    dialog,
    open(options = {}) {
      if (disposed) return null;
      if (missionId !== host.missionId()) roster = [];
      missionId = host.missionId();
      syncScope();
      if (options.agent && ![...agentSelect.options].some((option) => option.value === options.agent)) agentSelect.add(new Option(nameFor(options.agent), options.agent));
      agentSelect.value = options.agent ?? ''; statusSelect.value = '';
      const control = options.control ?? document.activeElement;
      const crewRow = control?.closest?.('.crew-card[data-agent]');
      returnLauncher = crewRow?.parentElement?.id && control.dataset?.crewAction
        ? { containerId: crewRow.parentElement.id, agent: crewRow.dataset.agent, action: control.dataset.crewAction }
        : null;
      showDialog(dialog, control);
      resetAndLoad();
      return dialog;
    },
    contextChanged() {
      if (!dialog.open || disposed) return;
      syncScope();
      if (missionId !== host.missionId()) { missionId = host.missionId(); roster = []; statusSelect.value = ''; syncScope(); resetAndLoad(); }
    },
    refresh() { return load(items.length ? 'refresh' : 'initial'); },
    dispose() {
      disposed = true; generation += 1; clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (childDialog && childClose) childDialog.removeEventListener('close', childClose);
      if (dialog.open) dialog.close();
      // The app temporarily reparents its shared toast host into the top dialog.
      // Disposal must not delete it before the asynchronous close recovery runs.
      const toastRegion = dialog.querySelector('#toast-region');
      if (toastRegion) document.body.append(toastRegion);
      dialog.remove();
    },
  };
}
