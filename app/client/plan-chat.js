import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { planReferenceHandles, parsePlanRunCommand } from '../imports/constellation/plan-references';
import { escapeHtml } from './operations';
import { createPlanRunTimeline } from './plan-chat-runs';
import { registerComposerContext } from './composer-context';

const icon = (name) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
  plan: '<rect x="4" y="2.5" width="12" height="15" rx="2"/><path d="M7 7h6M7 10h6M7 13h3"/>',
  close: '<path d="m6 6 8 8M14 6l-8 8"/>', back: '<path d="m11 5-5 5 5 5M6 10h10"/>',
  search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>', run: '<path d="m7 4 9 6-9 6Z"/>',
}[name]}</svg>`;

/** Plans are composer attachments; execution requires an explicit action. */
export function initializePlanChat(host) {
  const { chat } = host;
  let plans = [], loading = true, failure = '', generation = 0, previewGeneration = 0;
  let disposed = false, originMission, catalogSignature = '', pendingRequest = null;
  let launchRequest = null, launching = false, currentRunSubscription = null, catalogTimer = null;
  let queryDraft = null, preview = null, restoreFocus = false, pickerFocus = null, externalAnchor = null;
  const selected = new Map(), subscriptions = [];
  const previousHandler = chat.submissionHandler;
  const composerContext = registerComposerContext(chat);
  const previousPlanSource = chat.mentionSources?.['#'];
  const add = document.createElement('button');
  add.id = 'chat-add-plan'; add.type = 'button'; add.className = 'chat-add-plan';
  add.slot = 'composer-toolbar'; add.innerHTML = `${icon('plan')}<span>Plans</span>`;
  add.title = 'Attach a saved plan or choose one to run · #';
  add.setAttribute('aria-haspopup', 'dialog'); add.setAttribute('aria-controls', 'chat-plan-picker'); add.setAttribute('aria-expanded', 'false');
  if (!host.externalTrigger) chat.append(add);
  const context = document.createElement('div');
  context.id = 'chat-plan-context'; context.className = 'chat-plan-context'; context.slot = 'composer-context'; context.hidden = true;
  context.setAttribute('aria-label', 'Attached plans'); chat.append(context);
  const picker = document.createElement('div');
  picker.id = 'chat-plan-picker'; picker.className = 'chat-plan-picker';
  picker.setAttribute('popover', 'auto'); picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', 'Choose a plan');
  picker.innerHTML = `<div class="chat-plan-browse"><header class="chat-plan-picker-heading"><h2>Plans</h2><button type="button" class="plan-icon-button" data-plan-close aria-label="Close plans">${icon('close')}</button></header>
    <div class="chat-plan-search">${icon('search')}<input id="chat-plan-search" type="search" aria-label="Search plans" placeholder="Search plans…" autocomplete="off"><kbd>#</kbd></div>
    <div id="chat-plan-list" class="chat-plan-list" aria-live="polite"></div><footer class="chat-plan-picker-foot"><span>Select to attach as context</span><button type="button" class="plan-text-button" data-plan-manage>Manage plans ↗</button></footer>
    </div><div class="chat-plan-preview" hidden></div>`;
  document.body.append(picker);
  const search = picker.querySelector('#chat-plan-search'), list = picker.querySelector('#chat-plan-list');
  const browse = picker.querySelector('.chat-plan-browse'), previewBody = picker.querySelector('.chat-plan-preview');
  const message = (error) => error?.reason || error?.message || 'Could not load plans. Try again.';
  const current = () => host.currentMission();
  const reference = (plan) => ({ handle: plan.handle, missionId: plan.missionId, revision: plan.revision });
  const missionLabel = (plan) => plan.missionId === current() ? 'This mission' : plan.missionTitle;
  const matching = (query = '') => plans.filter((plan) => `${plan.name} ${plan.handle} ${plan.missionTitle}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const isOpen = () => picker.matches(':popover-open');
  const disabled = () => chat.getAttribute('aria-disabled') === 'true' || chat.shadowRoot?.querySelector('.composer')?.getAttribute('aria-busy') === 'true' || launching;

  async function openContext(missionId, tab, runId, control) {
    const origin = current();
    const dialog = await host.openPlan(missionId, tab, runId, control);
    dialog?.addEventListener?.('close', () => {
      if (current() !== origin) return;
      const fresh = runId ? chat.querySelector(`[data-chat-run="${CSS.escape(runId)}"] [data-chat-run-open]`) : null;
      (control?.isConnected && !picker.contains(control) ? control : fresh ?? externalAnchor ?? add).focus?.({ preventScroll: true });
    }, { once: true });
  }
  const timeline = createPlanRunTimeline({ ...host, openContext });
  const { activity } = timeline;
  function positionPicker() {
    if (!isOpen()) return;
    const anchor = chat.shadowRoot?.querySelector('.composer')?.getBoundingClientRect() ?? add.getBoundingClientRect();
    const width = Math.min(480, window.innerWidth - 32, Math.max(320, anchor.width));
    picker.style.width = `${width}px`;
    picker.style.maxHeight = `${Math.min(580, window.innerHeight - 32, Math.max(140, anchor.top - 26))}px`;
    picker.style.left = `${Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16))}px`;
    picker.style.top = `${Math.max(16, anchor.top - picker.getBoundingClientRect().height - 10)}px`;
  }
  function closePicker(focus = false) { restoreFocus = focus; if (isOpen()) picker.hidePopover(); queryDraft = null; }
  function showPicker() { if (!isOpen()) picker.showPopover(); add.setAttribute('aria-expanded', 'true'); positionPicker(); }
  function updateMentions() {
    chat.mentionSources = { ...chat.mentionSources, '#': {
      kind: 'plan', actionable: true,
      search: (query) => matching(query).map((plan) => ({ handle: plan.handle, label: plan.name, kind: 'plan', actionable: true })),
      lookup: (handle) => {
        const plan = plans.find((row) => row.handle === String(handle).toLowerCase());
        return plan ? { handle: plan.handle, label: plan.name, kind: 'plan', actionable: true } : null;
      },
    } };
  }
  function renderAttachments() {
    context.hidden = !selected.size; composerContext.set(selected.size > 0);
    context.innerHTML = [...selected.values()].map((plan) => `<div class="chat-plan-attachment" data-plan-attachment="${escapeHtml(plan.handle)}"><button type="button" data-plan-preview="${escapeHtml(plan.handle)}" aria-label="Preview ${escapeHtml(plan.name)}">${icon('plan')}<span>${escapeHtml(plan.name)}</span><small>v${plan.revision}</small></button><button type="button" data-plan-remove="${escapeHtml(plan.handle)}" aria-label="Remove ${escapeHtml(plan.name)}">${icon('close')}</button></div>`).join('');
    context.querySelectorAll('[data-plan-preview]').forEach((button) => button.addEventListener('click', () => { queryDraft = null; void showPreview(selected.get(button.dataset.planPreview)); }));
    context.querySelectorAll('[data-plan-remove]').forEach((button) => button.addEventListener('click', () => { selected.delete(button.dataset.planRemove); pendingRequest = null; renderAttachments(); chat.focusComposer(); }));
    updateAddState();
  }
  function attach(plan) {
    if (!plan || disabled() || originMission !== current()) return;
    if (selected.get(plan.handle)?.revision !== plan.revision) pendingRequest = null;
    selected.set(plan.handle, { ...plan });
    // Consume only the # query that opened the chooser, not surrounding text.
    if (queryDraft && chat.draftText === queryDraft.text) {
      const { start, end } = queryDraft.range;
      chat.setDraft(queryDraft.text.slice(0, start) + queryDraft.text.slice(end), { selectionStart: start, selectionEnd: start });
    }
    renderAttachments(); closePicker(); chat.focusComposer();
  }
  function renderPicker() {
    if (!isOpen() || preview) return;
    const focused = document.activeElement;
    if (list.contains(focused)) {
      const action = focused.hasAttribute('data-preview-plan') ? 'data-preview-plan' : 'data-select-plan';
      pickerFocus = { action, handle: focused.getAttribute(action), query: search.value };
    }
    list.setAttribute('aria-busy', String(loading));
    if (loading) list.innerHTML = '<div class="plan-picker-status" role="status"><span class="plan-spinner"></span>Loading plans…</div>';
    else if (failure) list.innerHTML = `<div class="plan-picker-status plan-error" role="alert">${escapeHtml(failure)}<button type="button" class="plan-text-button" data-plan-retry>Try again</button></div>`;
    else {
      const rows = matching(search.value);
      const groups = [['This mission', rows.filter((plan) => plan.missionId === current())], ['Other missions', rows.filter((plan) => plan.missionId !== current())]];
      list.innerHTML = rows.length ? groups.filter(([, items]) => items.length).map(([name, items]) => `<section class="chat-plan-group" aria-label="${name}"><h3>${name}</h3>${items.map((plan) => `<div class="chat-plan-option${selected.has(plan.handle) ? ' is-attached' : ''}"><button type="button" data-select-plan="${escapeHtml(plan.handle)}"><span class="chat-plan-option-symbol">${icon('plan')}</span><span class="chat-plan-option-copy"><strong>${escapeHtml(plan.name)}</strong><small>${escapeHtml(plan.missionId === current() ? `${plan.stepCount} ${plan.stepCount === 1 ? 'step' : 'steps'}` : plan.missionTitle)}${plan.status !== 'active' ? ` · ${escapeHtml(plan.status)}` : ''}</small></span><span class="chat-plan-option-add" aria-hidden="true">${selected.has(plan.handle) ? '✓' : '+'}</span></button><button type="button" class="plan-option-preview" data-preview-plan="${escapeHtml(plan.handle)}" aria-label="Preview ${escapeHtml(plan.name)}">Preview</button></div>`).join('')}</section>`).join('')
        : `<div class="plan-picker-status"><strong>${plans.length ? 'No matching plans' : 'No saved plans yet'}</strong><span>${plans.length ? 'Try a different name or mission.' : 'Create a plan in Plan & runs, then use it here.'}</span>${plans.length ? '' : '<button type="button" class="plan-text-button" data-plan-create>Create a plan ↗</button>'}</div>`;
    }
    list.querySelector('[data-plan-retry]')?.addEventListener('click', () => void refresh());
    list.querySelector('[data-plan-create]')?.addEventListener('click', managePlans);
    list.querySelectorAll('[data-select-plan]').forEach((button) => button.addEventListener('click', () => attach(plans.find((row) => row.handle === button.dataset.selectPlan))));
    list.querySelectorAll('[data-preview-plan]').forEach((button) => button.addEventListener('click', () => void showPreview(plans.find((row) => row.handle === button.dataset.previewPlan))));
    if (pickerFocus) {
      const target = !loading && pickerFocus.query === search.value ? list.querySelector(`[${pickerFocus.action}="${CSS.escape(pickerFocus.handle ?? '')}"]`) : null;
      (target ?? search).focus({ preventScroll: true });
      if (!loading) pickerFocus = null;
    }
    positionPicker();
  }
  async function refresh() {
    if (catalogTimer) { clearTimeout(catalogTimer); catalogTimer = null; }
    const request = ++generation, missionId = current();
    loading = true; failure = ''; updateMentions(); renderPicker();
    try {
      const result = await Meteor.callAsync('constellation.workflowPlans', { missionId });
      if (disposed || request !== generation || missionId !== current()) return;
      plans = result.plans ?? [];
    } catch (error) {
      if (disposed || request !== generation || missionId !== current()) return;
      plans = []; failure = message(error);
    } finally { if (!disposed && request === generation) { loading = false; updateMentions(); renderPicker(); } }
  }
  function showBrowse(query = '', draft = null, anchor = null) {
    if (disabled()) return;
    externalAnchor = anchor;
    originMission = current(); queryDraft = draft; preview = null; pickerFocus = null; previewGeneration += 1;
    browse.hidden = false; previewBody.hidden = true; picker.setAttribute('aria-label', 'Choose a plan'); search.value = query;
    showPicker(); renderPicker(); search.focus({ preventScroll: true });
    if (loading || failure) void refresh();
  }
  function renderPreview() {
    if (!preview || disposed) return;
    const focused = previewBody.contains(document.activeElement) ? [...document.activeElement.attributes].find((attribute) => attribute.name.startsWith('data-plan-'))?.name : null;
    const { plan, definition, loading: busy, error, stale } = preview;
    const runnable = !busy && !error && !stale && plan.status === 'active' && definition?.steps?.length && !disabled();
    const steps = definition?.steps ?? [];
    const agentName = (name) => host.crew?.().find((member) => member.agent === name)?.displayName ?? name;
    previewBody.innerHTML = `<header class="chat-plan-picker-heading"><button type="button" class="plan-text-button" data-plan-back>${icon('back')}Plans</button><button type="button" class="plan-icon-button" data-plan-close aria-label="Close plan preview">${icon('close')}</button></header>
      <div class="plan-preview-content"><div class="plan-preview-title">${icon('plan')}<div><h2>${escapeHtml(plan.name)}</h2><p>${escapeHtml(missionLabel(plan))} · Version ${plan.revision}</p></div></div>
      ${busy ? '<div class="plan-preview-status" role="status"><span class="plan-spinner"></span>Loading steps…</div>' : error ? `<div class="plan-preview-status plan-error" role="alert">${escapeHtml(error)}<button type="button" class="plan-text-button" data-plan-preview-retry>Try again</button></div>` : stale ? `<div class="plan-preview-status plan-warning" role="status">This plan has changed since you attached it.<button type="button" class="plan-text-button" data-plan-use-latest>Use version ${definition?.revision ?? 'latest'}</button></div>` : ''}
      ${!busy && !error && !stale ? `<ol class="plan-preview-steps">${steps.map((step, index) => `<li><span class="plan-preview-step-number">${index + 1}</span><div><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.primitive === 'approval' ? 'Your review' : agentName(step.agent) ?? 'Agent')}${step.requireApproval ? ' · Approval required' : ''}</small></div></li>`).join('')}</ol>` : ''}
      ${!busy && !error && !stale ? '<p class="plan-preview-scope" id="chat-plan-run-routing">Run plan uses the agents listed above, not the chat recipient.</p>' : ''}
      ${!busy && !error && !stale && plan.missionId !== current() ? `<p class="plan-preview-scope">Runs in ${escapeHtml(plan.missionTitle)}. Updates appear in this chat.</p>` : ''}
      ${plan.status !== 'active' ? `<p class="plan-preview-status">Mission ${escapeHtml(plan.status)}. You can still attach this plan as context.</p>` : ''}
      ${preview.launchError ? `<p class="plan-preview-status plan-error" role="alert">${escapeHtml(preview.launchError)}</p>` : ''}</div>
      <footer class="plan-preview-footer"><button type="button" class="plan-text-button" data-plan-open>Open plan ↗</button><div><button type="button" class="plan-secondary-button" data-plan-attach ${disabled() ? 'disabled' : ''}>${selected.has(plan.handle) ? 'Attached ✓' : 'Attach'}</button><button type="button" class="plan-primary-button" data-plan-run aria-describedby="chat-plan-run-routing" ${runnable ? '' : 'disabled'}>${launching ? '<span class="plan-spinner"></span>Starting…' : `${icon('run')}Run plan`}</button></div></footer>`;
    previewBody.querySelector('[data-plan-back]').addEventListener('click', () => showBrowse(search.value, queryDraft, externalAnchor));
    previewBody.querySelector('[data-plan-close]').addEventListener('click', () => closePicker(true));
    previewBody.querySelector('[data-plan-preview-retry]')?.addEventListener('click', () => void showPreview(plan));
    previewBody.querySelector('[data-plan-use-latest]')?.addEventListener('click', () => {
      const latest = { ...plan, revision: definition.revision, name: definition.name, stepCount: definition.steps.length };
      if (selected.has(plan.handle)) { selected.set(plan.handle, latest); pendingRequest = null; renderAttachments(); }
      launchRequest = null; void showPreview(latest);
    });
    previewBody.querySelector('[data-plan-attach]').addEventListener('click', () => attach(plan));
    previewBody.querySelector('[data-plan-run]').addEventListener('click', () => void runPreview());
    previewBody.querySelector('[data-plan-open]').addEventListener('click', () => { closePicker(); void openContext(plan.missionId, 'plan', null, add); });
    if (focused && isOpen()) (previewBody.querySelector(`[${focused}]:not(:disabled)`) ?? previewBody.querySelector('[data-plan-back]')).focus({ preventScroll: true });
    positionPicker();
  }
  async function showPreview(plan) {
    if (!plan || disabled()) return;
    originMission = current();
    const request = ++previewGeneration, mission = current();
    preview = { plan: { ...plan }, loading: true }; browse.hidden = true; previewBody.hidden = false;
    picker.setAttribute('aria-label', `Preview ${plan.name}`); showPicker(); renderPreview();
    previewBody.querySelector('[data-plan-back]').focus({ preventScroll: true });
    try {
      const data = await Meteor.callAsync('constellation.workflowGet', { missionId: plan.missionId });
      if (disposed || request !== previewGeneration || mission !== current()) return;
      if (!data.definition) throw new Error('This plan is no longer available.');
      preview.definition = data.definition; preview.stale = data.definition.revision !== plan.revision;
    } catch (error) { if (!disposed && request === previewGeneration && mission === current()) preview.error = message(error); }
    finally { if (!disposed && request === previewGeneration && mission === current()) { preview.loading = false; renderPreview(); } }
  }
  async function runPreview() {
    if (!preview || disabled() || preview.loading || preview.error || preview.stale || !preview.definition?.steps?.length || preview.plan.status !== 'active') return;
    const state = preview, plan = state.plan, sessionId = current();
    if (!launchRequest || launchRequest.missionId !== sessionId || launchRequest.references[0].handle !== plan.handle || launchRequest.references[0].revision !== plan.revision) {
      launchRequest = { missionId: sessionId, text: `Run #${plan.handle}`, mode: 'agent', requestKey: window.crypto.randomUUID(), references: [reference(plan)] };
    }
    const pending = launchRequest;
    launching = true; state.launchError = ''; updateAddState(); renderPreview();
    try {
      await Meteor.callAsync('constellation.workflowChatSend', pending);
      if (disposed || current() !== sessionId || launchRequest !== pending) return;
      launchRequest = null;
      if (selected.get(plan.handle)?.revision === plan.revision) selected.delete(plan.handle);
      renderAttachments(); closePicker(true); host.toast('Plan started with its assigned agents.');
    } catch (error) {
      if (disposed || current() !== sessionId || launchRequest !== pending) return;
      state.launchError = message(error);
      if (['workflow-conflict', 'workflow-reference-stale'].includes(error?.error)) {
        launchRequest = null; state.error = 'This saved version is no longer current. Refresh the preview to choose the latest version.'; void refresh();
      }
    } finally {
      if (!disposed && current() === sessionId && (launchRequest === pending || preview === state)) {
        launching = false; updateAddState(); if (preview === state) renderPreview();
      }
    }
  }
  function managePlans() { closePicker(); void openContext(current(), 'plan', null, add); }
  function updateAddState() {
    add.disabled = disabled();
    context.querySelectorAll('button').forEach((button) => { button.disabled = disabled(); });
    const run = previewBody.querySelector('[data-plan-run]');
    const attachment = previewBody.querySelector('[data-plan-attach]');
    if (attachment) attachment.disabled = disabled();
    if (run && preview) run.disabled = disabled() || preview.loading || !!preview.error || preview.stale
      || preview.plan.status !== 'active' || !preview.definition?.steps?.length;
  }
  add.addEventListener('click', () => isOpen() ? closePicker(true) : showBrowse());
  picker.querySelector('[data-plan-close]').addEventListener('click', () => closePicker(true));
  picker.querySelector('[data-plan-manage]').addEventListener('click', managePlans);
  picker.addEventListener('toggle', (event) => {
    add.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState === 'closed' && restoreFocus && !disposed) {
      if (externalAnchor?.isConnected) externalAnchor.focus({ preventScroll: true });
      else chat.focusComposer();
    }
    restoreFocus = false;
  });
  picker.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); closePicker(true); } });
  search.addEventListener('input', () => { pickerFocus = null; renderPicker(); });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('[data-select-plan]')?.focus(); }
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); list.querySelector('[data-select-plan]')?.click(); }
  });
  list.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll('[data-select-plan]')]; if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement?.closest('.chat-plan-option')?.querySelector('[data-select-plan]'));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  const onQuery = (event) => {
    if (event.detail?.prefix !== '#') return;
    event.preventDefault(); showBrowse(event.detail.query, { text: chat.draftText, range: event.detail.range });
  };
  const onSelected = (event) => {
    if (event.detail?.prefix !== '#') return;
    event.preventDefault();
    const range = event.detail.range;
    if (range && chat.draftText.slice(range.start, range.end).startsWith('#')) queryDraft = { text: chat.draftText, range };
    const plan = plans.find((row) => row.handle === String(event.detail.handle).toLowerCase()); if (plan) attach(plan);
  };
  const onMention = (event) => {
    if (event.detail?.prefix !== '#') return;
    const plan = plans.find((row) => row.handle === String(event.detail.handle).toLowerCase());
    if (plan) void openContext(plan.missionId, 'plan', null, event.composedPath()[0]); else host.toast('This plan is no longer available.', 'error');
  };
  chat.addEventListener('agent-chat:mention-query', onQuery); chat.addEventListener('agent-chat:mention-select', onSelected); chat.addEventListener('agent-chat:mention', onMention);
  const composerObserver = new MutationObserver(updateAddState);
  composerObserver.observe(chat, { attributes: true, attributeFilter: ['aria-disabled'] });
  if (chat.shadowRoot) composerObserver.observe(chat.shadowRoot, { attributes: true, subtree: true, attributeFilter: ['aria-busy'] });
  const resizeObserver = new ResizeObserver(() => {
    positionPicker();
    const composer = chat.shadowRoot?.querySelector('.composer');
    if (composer) chat.parentElement?.style.setProperty('--chat-composer-space', `${Math.ceil(chat.getBoundingClientRect().bottom - composer.getBoundingClientRect().top + 12)}px`);
  });
  resizeObserver.observe(chat);
  if (chat.shadowRoot?.querySelector('.composer')) resizeObserver.observe(chat.shadowRoot.querySelector('.composer'));
  window.addEventListener('resize', positionPicker); window.addEventListener('scroll', positionPicker, true); updateAddState();
  chat.submissionHandler = async ({ sessionId, text, mode, recipient }) => {
    const attachmentSnapshot = [...selected.values()], typed = planReferenceHandles(text);
    const attached = attachmentSnapshot.filter((plan) => !typed.includes(plan.handle));
    // A labeled suffix stops a note such as “Run” becoming a command when an
    // attachment is serialized. Selecting context must never start execution.
    const submitted = attached.length ? `${text.trim()}${text.trim() ? '\n\n' : ''}Plan context: ${attached.map((plan) => `#${plan.handle}`).join(' ')}` : text;
    const handles = planReferenceHandles(submitted);
    const command = mode !== 'note' ? parsePlanRunCommand(submitted) : null;
    // Context follows the selected chat recipient. A plan launch instead uses
    // its saved step agents; notes and launch receipts never wake a model.
    const target = mode === 'note' || command ? undefined : recipient;
    if (!handles.length && !command) {
      if (previousHandler) return previousHandler({ sessionId, text, mode, ...(target !== undefined ? { recipient: target } : {}) });
      return mode === 'note' ? chat.agentInstance.contribute(sessionId, text)
        : chat.agentInstance.send(sessionId, text, target === undefined ? undefined : { to: target });
    }
    if (!pendingRequest || pendingRequest.sessionId !== sessionId || pendingRequest.text !== submitted || pendingRequest.mode !== mode || pendingRequest.recipient !== target) {
      pendingRequest = { sessionId, text: submitted, mode, ...(target !== undefined ? { recipient: target } : {}), requestKey: window.crypto.randomUUID(), references: handles.map((handle) => selected.get(handle) ?? plans.find((row) => row.handle === handle)).filter(Boolean).map(reference) };
    }
    const pending = pendingRequest;
    try {
      const result = await Meteor.callAsync('constellation.workflowChatSend', { missionId: sessionId, text: submitted, mode: mode === 'note' ? 'note' : 'agent', ...(pending.recipient !== undefined ? { recipient: pending.recipient } : {}), requestKey: pending.requestKey, references: pending.references });
      if (pendingRequest === pending && current() === sessionId && !disposed) {
        pendingRequest = null;
        attachmentSnapshot.forEach((plan) => { if (selected.get(plan.handle)?.revision === plan.revision) selected.delete(plan.handle); }); renderAttachments();
        if (result?.kind === 'run') host.toast('Plan started with its assigned agents.');
      }
      return result;
    } catch (error) {
      if (pendingRequest === pending && current() === sessionId && ['workflow-conflict', 'workflow-reference-stale'].includes(error?.error)) { pendingRequest = null; void refresh(); }
      throw error;
    }
  };
  const catalog = Tracker.autorun(() => {
    const id = current(), rows = host.definitions.find({}, { fields: { revision: 1, name: 1, handle: 1 } }).fetch();
    const next = JSON.stringify([id, rows]), missionChanged = originMission !== id;
    if (missionChanged) {
      originMission = id; selected.clear(); pendingRequest = null; launchRequest = null; launching = false; preview = null; previewGeneration += 1;
      closePicker(); renderAttachments(); currentRunSubscription?.stop();
      if (host.subscribe !== false && id) currentRunSubscription = Meteor.subscribe('constellation.workflows', id);
    }
    if (next !== catalogSignature) {
      const first = !catalogSignature; catalogSignature = next;
      if (first || missionChanged) void refresh();
      else { if (catalogTimer) clearTimeout(catalogTimer); catalogTimer = setTimeout(() => { catalogTimer = null; if (!disposed) void refresh(); }, 80); }
    }
  });
  if (host.subscribe !== false) subscriptions.push(Meteor.subscribe('constellation.workflows', { onError(error) { failure = message(error); loading = false; updateMentions(); renderPicker(); } }));
  return { refresh, button: add, picker, activity, context, openBrowse: (anchor) => showBrowse('', null, anchor),
    dispose() {
      disposed = true; generation += 1; previewGeneration += 1; catalog.stop(); timeline.dispose(); composerObserver.disconnect(); resizeObserver.disconnect();
      currentRunSubscription?.stop(); subscriptions.forEach((subscription) => subscription.stop()); if (catalogTimer) clearTimeout(catalogTimer);
      chat.submissionHandler = previousHandler; composerContext.dispose();
      const sources = { ...chat.mentionSources }; if (previousPlanSource) sources['#'] = previousPlanSource; else delete sources['#']; chat.mentionSources = sources;
      chat.removeEventListener('agent-chat:mention-query', onQuery); chat.removeEventListener('agent-chat:mention-select', onSelected); chat.removeEventListener('agent-chat:mention', onMention);
      window.removeEventListener('resize', positionPicker); window.removeEventListener('scroll', positionPicker, true); picker.remove(); add.remove(); context.remove();
    },
  };
}
