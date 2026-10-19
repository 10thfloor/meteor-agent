import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { sanitizeCleanAssistantContent } from 'meteor/10thfloor:agent';
import { setChatTimelineSource } from './chat-timeline';

const activeRun = (run) => ['queued', 'running', 'awaiting'].includes(run.status);
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const clean = (value) => sanitizeCleanAssistantContent(typeof value === 'string' ? value : '')
  // The chat sanitizer's placeholder describes hidden debug material; it is
  // not an agent result. Prefer the run's useful completion count instead.
  .replace(/```[^\n`]*\n\s*Structured data hidden\s*\n```/g, '')
  .replace(/\bStructured data hidden\b/g, '').trim();
const concise = (value, max = 150) => {
  const text = clean(value).replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const errorText = (failure) => clean(failure?.reason || failure?.message || failure)
  || 'This action could not finish. Try again.';
const checkpointFor = (run) => (run.steps ?? []).find((step) => step.status === 'awaiting'
  && step.waitReason === 'approval' && step.fingerprint && !step.childSessionId);
const toolReviewFor = (run) => (run.steps ?? []).find((step) => step.status === 'awaiting'
  && step.waitReason === 'approval' && step.childSessionId);
const stateFor = (run) => {
  if (activeRun(run) && (checkpointFor(run) || toolReviewFor(run))) return { key: 'review', label: 'Needs review', priority: 0 };
  if (run.status === 'queued') return { key: 'working', label: 'Queued', priority: 2 };
  if (activeRun(run)) return { key: 'working', label: 'Working', priority: 1 };
  if (run.status === 'completed') return { key: 'completed', label: 'Complete', priority: 3 };
  if (run.status === 'cancelled') return { key: 'cancelled', label: 'Stopped', priority: 3 };
  return { key: 'failed', label: 'Failed', priority: 3 };
};
const lastAgentResult = (run) => [...(run.steps ?? [])].reverse()
  .find((step) => step.primitive === 'agent' && step.status === 'completed' && clean(step.summary));
const stepCount = (run) => ({ total: run.steps?.length ?? 0,
  done: (run.steps ?? []).filter((step) => ['completed', 'skipped'].includes(step.status)).length,
  skipped: (run.steps ?? []).filter((step) => step.status === 'skipped').length });
const currentStep = (run) => checkpointFor(run) || toolReviewFor(run)
  || (run.steps ?? []).find((step) => ['running', 'awaiting'].includes(step.status))
  || (run.steps ?? []).find((step) => step.status === 'pending');
const stepProgress = (run) => {
  const { done, total, skipped } = stepCount(run);
  return `${done} of ${total} steps ${skipped ? `resolved · ${skipped} skipped` : 'complete'}`;
};

// Review only the results feeding this checkpoint. In legacy projections that
// omit dependency IDs, earlier completed agent steps are the safe fallback.
function reviewResults(run, checkpoint) {
  const steps = run.steps ?? [];
  if (!checkpoint) return steps.filter((step) => step.primitive === 'agent' && step.status === 'completed' && clean(step.summary));
  const dependencies = new Set(checkpoint.dependsOn ?? []);
  const declaredDependencies = Array.isArray(checkpoint.dependsOn);
  for (let pass = 0; pass < steps.length; pass += 1) {
    for (const step of steps) if (dependencies.has(step.id)) for (const id of step.dependsOn ?? []) dependencies.add(id);
  }
  return steps.filter((step, index) => step.primitive === 'agent' && step.status === 'completed'
    && (declaredDependencies ? dependencies.has(step.id) : index < steps.indexOf(checkpoint)));
}

/** Run history lives in the conversation; only current work occupies the rail.
 * Nodes and controls survive reactive updates so reading, focus and disclosure
 * state do not reset when a step completes or another run is published. */
export function createPlanRunTimeline(host) {
  const { chat } = host;
  const cards = new Map();
  let disposed = false;
  let missionId;
  let activeRows = [];
  let railSignature = '';
  const uniqueId = `plan-run-list-${window.crypto.randomUUID()}`;
  const activity = document.createElement('div');
  activity.id = 'chat-plan-activity';
  activity.className = 'chat-plan-activity';
  activity.slot = 'activity';
  activity.hidden = true;
  activity.setAttribute('aria-label', 'Active plan runs');
  activity.innerHTML = `<button type="button" class="plan-run-rail-main" data-plan-rail-main>
    <span class="plan-run-rail-symbol" aria-hidden="true"></span>
    <span class="plan-run-rail-title"></span><span class="plan-run-rail-status" role="status"></span>
    <span class="plan-run-rail-action"></span></button>
    <button type="button" class="plan-run-rail-count" data-plan-rail-count aria-expanded="false" aria-haspopup="dialog"></button>
    <div class="plan-run-rail-popover" popover="auto" role="dialog" aria-label="Active plan runs">
      <div class="plan-run-rail-list" role="list"></div></div>`;
  chat.append(activity);
  const railMain = activity.querySelector('[data-plan-rail-main]');
  const railCount = activity.querySelector('[data-plan-rail-count]');
  const railPopover = activity.querySelector('[popover]');
  const railList = activity.querySelector('.plan-run-rail-list');
  railPopover.id = uniqueId;
  railCount.setAttribute('aria-controls', uniqueId);
  const hidePopover = () => { if (railPopover.matches(':popover-open')) railPopover.hidePopover(); };
  const positionPopover = () => {
    if (!railPopover.matches(':popover-open')) return;
    const bounds = railCount.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 32);
    railPopover.style.width = `${width}px`;
    railPopover.style.maxHeight = `${Math.min(320, Math.max(100, bounds.top - 24))}px`;
    railPopover.style.left = `${Math.max(16, Math.min(bounds.right - width, window.innerWidth - width - 16))}px`;
    railPopover.style.top = `${Math.max(16, bounds.top - railPopover.getBoundingClientRect().height - 8)}px`;
  };
  railPopover.addEventListener('toggle', () => railCount.setAttribute('aria-expanded', String(railPopover.matches(':popover-open'))));
  railCount.addEventListener('click', () => {
    if (railPopover.matches(':popover-open')) return hidePopover();
    railPopover.showPopover();
    positionPopover();
    railList.querySelector('button')?.focus({ preventScroll: true });
  });
  railPopover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); hidePopover(); railCount.focus({ preventScroll: true }); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...railList.querySelectorAll('button')]; if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  window.addEventListener('resize', positionPopover);
  const reveal = (runId) => {
    const entry = cards.get(runId);
    if (!entry) return;
    hidePopover();
    if (stateFor(entry.run).key === 'review') {
      entry.open = true;
      entry.reviewing = !!checkpointFor(entry.run);
      entry.reviewFingerprint = checkpointFor(entry.run)?.fingerprint;
      entry.reviewChanged = false;
      updateCard(entry);
    }
    entry.card.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    (entry.reviewing ? entry.reviewHeading : entry.toggle).focus({ preventScroll: true });
  };
  railMain.addEventListener('click', () => { if (activeRows[0]) reveal(activeRows[0]._id); });

  function createCard(run) {
    const card = document.createElement('article');
    card.className = 'plan-run-card';
    card.dataset.chatRun = run._id;
    card.innerHTML = `<header class="plan-run-summary">
      <span class="plan-run-symbol" aria-hidden="true"></span>
      <button type="button" class="plan-run-toggle" data-chat-run-toggle aria-expanded="false">
        <span class="plan-run-heading"><strong class="plan-run-title"></strong><span class="plan-run-state"></span></span>
        <span class="plan-run-current"></span></button>
      <button type="button" class="plan-run-primary" data-chat-plan-review>Review result</button>
      <button type="button" class="plan-run-primary" data-chat-tool-review>Review tool request</button>
      <span class="plan-run-chevron" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </header>
    <progress class="plan-run-progress"></progress>
    <div class="plan-run-body" hidden>
      <p class="plan-run-meta"></p>
      <section class="plan-run-review" hidden>
        <h4 class="plan-run-review-heading" tabindex="-1">Review result</h4>
        <p class="plan-run-review-question"></p>
        <div class="plan-run-evidence"></div>
        <p class="plan-run-no-evidence" hidden>No earlier results. Review this task before allowing it to start.</p>
        <div class="plan-run-review-actions">
          <button type="button" class="primary-action" data-chat-plan-approve="true">Approve &amp; continue</button>
          <button type="button" class="secondary-action" data-chat-plan-approve="false">Decline</button>
          <button type="button" class="op-link" data-chat-run-evidence>View evidence</button>
        </div>
      </section>
      <section class="plan-run-result" hidden><h4>Result</h4><p></p></section>
      <p class="plan-run-error" role="alert" hidden></p>
      <div class="plan-run-actions">
        <button type="button" class="op-link" data-chat-run-open>View run</button>
        <button type="button" class="op-link" data-chat-run-stop>Stop run</button>
      </div>
    </div>`;
    const find = (selector) => card.querySelector(selector);
    const entry = { card, run, open: false, reviewing: false, busy: false, error: '', evidence: new Map(),
      toggle: find('[data-chat-run-toggle]'), body: find('.plan-run-body'), title: find('.plan-run-title'),
      state: find('.plan-run-state'), current: find('.plan-run-current'), progress: find('progress'),
      meta: find('.plan-run-meta'), review: find('.plan-run-review'), reviewHeading: find('.plan-run-review-heading'),
      question: find('.plan-run-review-question'), reviewButton: find('[data-chat-plan-review]'),
      toolButton: find('[data-chat-tool-review]'), evidenceBox: find('.plan-run-evidence'),
      noEvidence: find('.plan-run-no-evidence'), result: find('.plan-run-result'), errorBox: find('.plan-run-error'),
      stop: find('[data-chat-run-stop]'), openButton: find('[data-chat-run-open]'),
    };
    const bodyId = `plan-run-body-${window.crypto.randomUUID()}`;
    entry.body.id = bodyId;
    entry.toggle.setAttribute('aria-controls', bodyId);
    entry.toggle.addEventListener('click', () => {
      entry.open = !entry.open;
      if (entry.open && checkpointFor(entry.run)) {
        entry.reviewing = true; entry.reviewFingerprint = checkpointFor(entry.run).fingerprint; entry.reviewChanged = false;
      }
      updateCard(entry);
    });
    // The visible disclosure chevron and symbol share the title's hit target.
    find('.plan-run-summary').addEventListener('click', (event) => {
      if (!event.target.closest('button') && !entry.busy) entry.toggle.click();
    });
    entry.reviewButton.addEventListener('click', () => {
      entry.open = true; entry.reviewing = true; entry.reviewFingerprint = checkpointFor(entry.run)?.fingerprint;
      entry.reviewChanged = false; updateCard(entry);
      entry.reviewHeading.focus({ preventScroll: true });
    });
    entry.openButton.addEventListener('click', () => void host.openContext(entry.run.missionId, 'runs', entry.run._id, entry.openButton));
    find('[data-chat-run-evidence]').addEventListener('click', (event) => void host.openContext(entry.run.missionId, 'evidence', entry.run._id, event.currentTarget));
    entry.toolButton.addEventListener('click', () => {
      const step = toolReviewFor(entry.run);
      if (step && !entry.busy) host.openChild(step.childSessionId, step.agent);
    });
    entry.stop.addEventListener('click', () => void act(entry, entry.stop, 'Stopping…', 'constellation.workflowCancel', { runId: entry.run._id }));
    card.querySelectorAll('[data-chat-plan-approve]').forEach((button) => button.addEventListener('click', () => {
      const checkpoint = checkpointFor(entry.run);
      if (!entry.reviewing || !entry.open || !checkpoint) return;
      void act(entry, button, 'Saving…', 'constellation.workflowApprove', {
        runId: entry.run._id, stepId: checkpoint.id, fingerprint: checkpoint.fingerprint,
        approved: button.dataset.chatPlanApprove === 'true',
      });
    }));
    return entry;
  }

  async function act(entry, control, label, method, args) {
    if (entry.busy || disposed) return;
    const origin = missionId;
    entry.busy = true; entry.error = ''; entry.open = true;
    control.dataset.loading = 'true';
    const originalLabel = control.textContent;
    control.textContent = label;
    updateCard(entry);
    try { await Meteor.callAsync(method, args); }
    catch (failure) { entry.error = errorText(failure); }
    finally {
      entry.busy = false; delete control.dataset.loading; control.textContent = originalLabel;
      if (!disposed && missionId === origin && cards.get(entry.run._id) === entry) {
        updateCard(entry);
        if (entry.error) entry.errorBox.focus?.({ preventScroll: true });
      }
    }
  }

  function updateEvidence(entry, checkpoint) {
    const rows = reviewResults(entry.run, checkpoint);
    const keep = new Set(rows.map((step) => step.id));
    for (const [id, item] of entry.evidence) if (!keep.has(id)) { item.element.remove(); entry.evidence.delete(id); }
    for (const step of rows) {
      let item = entry.evidence.get(step.id);
      if (!item) {
        const element = document.createElement('div');
        element.className = 'plan-run-evidence-item';
        const heading = document.createElement('strong');
        const result = document.createElement('p');
        const source = document.createElement('button');
        source.type = 'button'; source.className = 'op-link'; source.textContent = 'View conversation';
        source.addEventListener('click', () => {
          const current = entry.run.steps.find((row) => row.id === step.id);
          if (current?.childSessionId) host.openChild(current.childSessionId, current.agent);
        });
        element.append(heading, result, source);
        item = { element, heading, result, source };
        entry.evidence.set(step.id, item);
        entry.evidenceBox.append(element);
      }
      setText(item.heading, step.label);
      setText(item.result, clean(step.summary) || 'Open the conversation to review this result.');
      item.source.hidden = !step.childSessionId;
    }
    entry.noEvidence.hidden = rows.length > 0;
  }

  function updateCard(entry) {
    const { run } = entry;
    const state = stateFor(run);
    const checkpoint = checkpointFor(run);
    const toolReview = toolReviewFor(run);
    const count = stepCount(run);
    const current = currentStep(run);
    const result = lastAgentResult(run);
    const focused = document.activeElement;
    if (entry.reviewing && checkpoint && entry.reviewFingerprint !== checkpoint.fingerprint) {
      entry.reviewing = false; entry.reviewChanged = true;
    }
    if (!checkpoint) { entry.reviewing = false; entry.reviewChanged = false; }
    entry.card.dataset.state = state.key;
    entry.card.dataset.expanded = String(entry.open);
    entry.card.setAttribute('aria-label', `${run.name}: ${state.label}`);
    entry.card.setAttribute('aria-busy', String(entry.busy));
    setText(entry.title, run.name);
    setText(entry.state, state.label);
    setText(entry.current, run.status === 'completed' && result ? concise(result.summary)
      : run.status === 'failed' ? concise(errorText(run.error))
        : activeRun(run) && current ? `${current.label} · ${stepProgress(run)}` : stepProgress(run));
    entry.toggle.setAttribute('aria-expanded', String(entry.open));
    entry.body.hidden = !entry.open;
    entry.progress.hidden = !activeRun(run) || !count.total;
    entry.progress.max = count.total || 1;
    entry.progress.value = count.done;
    entry.progress.setAttribute('aria-label', stepProgress(run));
    const target = run.missionId !== missionId ? host.missionConfig(run.missionId)?.title || 'Another mission' : 'This mission';
    const stamp = new Date(run.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    setText(entry.meta, `${target} · Version ${run.definitionRevision} · ${stamp} · ${stepProgress(run)}`);
    entry.reviewButton.hidden = !checkpoint || entry.open && entry.reviewing;
    entry.toolButton.hidden = !toolReview;
    entry.review.hidden = !checkpoint || !entry.reviewing;
    if (checkpoint) {
      setText(entry.question, clean(checkpoint.prompt) || checkpoint.label);
      updateEvidence(entry, checkpoint);
    } else setText(entry.question, '');
    entry.result.hidden = !result || !!checkpoint;
    setText(entry.result.querySelector('p'), result ? clean(result.summary) : '');
    setText(entry.errorBox, entry.error || (entry.reviewChanged ? 'This review changed. Review the latest result before deciding.' : '')
      || (run.status === 'failed' ? errorText(run.error) : ''));
    entry.errorBox.hidden = !entry.errorBox.textContent;
    entry.stop.hidden = !activeRun(run);
    for (const button of entry.card.querySelectorAll('button')) button.disabled = entry.busy;
    if (focused && entry.card.contains(focused) && focused.closest('[hidden]')) entry.toggle.focus({ preventScroll: true });
  }

  function updateRail(rows) {
    activeRows = rows.filter(activeRun).sort((a, b) => stateFor(a).priority - stateFor(b).priority
      || new Date(b.createdAt) - new Date(a.createdAt));
    activity.hidden = !activeRows.length;
    if (!activeRows.length) { hidePopover(); return; }
    const first = activeRows[0];
    const state = stateFor(first);
    activity.dataset.state = state.key;
    setText(activity.querySelector('.plan-run-rail-title'), first.name);
    setText(activity.querySelector('.plan-run-rail-status'), state.key === 'review' ? 'Needs review'
      : `${currentStep(first)?.label || state.label} · ${stepProgress(first)}`);
    setText(activity.querySelector('.plan-run-rail-action'), state.key === 'review' ? 'Review' : 'View');
    railMain.setAttribute('aria-label', `${first.name}: ${state.label}. ${state.key === 'review' ? 'Review result' : 'View progress'}`);
    railCount.hidden = activeRows.length < 2;
    if (railCount.hidden) hidePopover();
    setText(railCount, `${activeRows.length} active`);
    railCount.setAttribute('aria-label', `Show all ${activeRows.length} active plan runs`);
    const next = JSON.stringify(activeRows.map((run) => [run._id, run.name, stateFor(run).key, currentStep(run)?.label, stepProgress(run)]));
    if (next === railSignature) return;
    railSignature = next;
    const focusedId = document.activeElement?.dataset?.planRailRun;
    railList.replaceChildren();
    for (const run of activeRows) {
      const item = document.createElement('div'); item.setAttribute('role', 'listitem');
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'plan-run-rail-option'; button.dataset.planRailRun = run._id;
      button.dataset.state = stateFor(run).key;
      const title = document.createElement('strong'); title.textContent = run.name;
      const status = document.createElement('span'); status.textContent = `${stateFor(run).label} · ${stepProgress(run)}`;
      button.append(title, status); button.addEventListener('click', () => reveal(run._id));
      item.append(button); railList.append(item);
      if (focusedId === run._id) button.focus({ preventScroll: true });
    }
  }

  function render() {
    if (disposed) return;
    const current = host.currentMission();
    if (missionId !== current) {
      missionId = current; hidePopover(); cards.clear(); railSignature = '';
    }
    const rows = current ? host.runs.find({ $or: [{ missionId: current }, { originChatId: current }] },
      { sort: { createdAt: -1 }, limit: 40 }).fetch() : [];
    const keep = new Set(rows.map((run) => run._id));
    for (const [id] of cards) if (!keep.has(id)) cards.delete(id);
    for (const run of rows) {
      let entry = cards.get(run._id);
      if (!entry) { entry = createCard(run); cards.set(run._id, entry); }
      entry.run = run; updateCard(entry);
    }
    setChatTimelineSource(chat, 'plans', [...rows].reverse().map((run) => ({ id: `plan-run-${run._id}`,
      createdAt: run.originChatId === current && run.chatPostedAt ? run.chatPostedAt : run.createdAt,
      ...(run.chatMessageId && run.originChatId === current ? { afterMessageId: run.chatMessageId } : {}),
      element: cards.get(run._id).card })));
    updateRail(rows);
    positionPopover();
  }
  const computation = Tracker.autorun(render);
  return { activity, render,
    dispose() {
      disposed = true; computation.stop(); hidePopover(); window.removeEventListener('resize', positionPopover); activity.remove(); cards.clear(); setChatTimelineSource(chat, 'plans', []);
    },
  };
}
