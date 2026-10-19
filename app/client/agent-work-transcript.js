import { Meteor } from 'meteor/meteor';
import { sanitizeCleanAssistantContent } from 'meteor/10thfloor:agent';

// Assignment and return receipts are distinct from the specialist's conversation.
// Never infer that a later reply was handed back to the coordinator.
export function createWorkTranscriptContext({ container, dialog, missionId, onDetail = () => {},
  read = (input) => Meteor.callAsync('constellation.agentWork.detail', input) }) {
  let selection = null;
  let generation = 0;
  let pending = false;
  let refreshQueued = false;
  let timer = null;
  let pollTimer = null;

  function status(text, { error = false, retry = false } = {}) {
    container.replaceChildren();
    const message = document.createElement('p');
    message.className = error ? 'run-context-error' : 'run-context-loading';
    message.setAttribute('role', error ? 'alert' : 'status');
    message.textContent = text;
    container.append(message);
    if (retry) {
      const button = document.createElement('button');
      button.className = 'run-context-retry'; button.type = 'button'; button.textContent = 'Try again';
      button.addEventListener('click', () => void load()); container.append(button);
    }
  }

  function section(key, title, text, open) {
    const details = document.createElement('details');
    details.className = 'run-handoff-block'; details.dataset.handoff = key; details.open = open;
    const summary = document.createElement('summary'); summary.textContent = title;
    const body = document.createElement('p');
    body.textContent = sanitizeCleanAssistantContent(text || 'No text was recorded.');
    details.append(summary, body);
    return details;
  }

  function render(detail) {
    const open = new Set([...container.querySelectorAll('details[open]')].map((row) => row.dataset.handoff));
    const focused = document.activeElement?.closest?.('[data-handoff]')?.dataset.handoff;
    const scroll = container.scrollTop;
    const requester = detail.requester?.displayName || 'Coordinator';
    const recipient = detail.source === 'plan' ? 'plan' : requester;
    const titles = {
      returned: `Result returned to ${recipient}`,
      pending: `Not yet returned to ${recipient}`,
      awaiting: `Waiting notice sent to ${recipient}`,
      failed: `Failure reported to ${recipient}`,
      unavailable: 'Return receipt unavailable',
    };
    const result = detail.result ?? { state: 'unavailable' };
    const empty = result.state === 'pending' ? 'This work has not returned a result yet.'
      : result.state === 'unavailable' ? 'No return receipt is available. The recorded conversation is below.'
        : 'No response text was recorded.';
    container.replaceChildren(
      section('assignment', `Assignment from ${requester}`, detail.assignment, open.has('assignment')),
      section('result', titles[result.state] ?? titles.unavailable, result.text || empty, open.has('result')),
    );
    container.scrollTop = scroll;
    if (focused) container.querySelector(`[data-handoff="${focused}"] > summary`)?.focus({ preventScroll: true });
    onDetail(detail);
  }

  async function load() {
    if (!selection || !dialog.open || selection.missionId !== missionId()) return;
    if (pending) { refreshQueued = true; return; }
    const request = selection;
    const token = generation;
    pending = true;
    try {
      const detail = await read(request);
      if (token !== generation || !dialog.open || request.missionId !== missionId()) return;
      render(detail);
      // A child can finish before its parent persists the return receipt.
      // Keep that handoff visible without requiring the person to reopen it.
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      if (['pending', 'awaiting'].includes(detail.result?.state)) {
        pollTimer = setTimeout(() => { pollTimer = null; void load(); }, 4000);
      }
    } catch {
      if (token !== generation || !dialog.open) return;
      status('Couldn’t load the handoff details. The recorded conversation is still available below.', { error: true, retry: true });
    } finally {
      if (token === generation) {
        pending = false;
        if (refreshQueued) { refreshQueued = false; refresh(); }
      }
    }
  }

  function refresh() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void load(); }, 120);
  }

  return {
    show(sessionId) {
      generation += 1; pending = false; refreshQueued = false;
      if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null;
      selection = { missionId: missionId(), sessionId };
      status('Loading assignment and result…');
      refresh();
    },
    refresh,
    stop() {
      generation += 1; selection = null; pending = false; refreshQueued = false;
      if (timer !== null) clearTimeout(timer); timer = null;
      if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null;
      container.replaceChildren();
    },
  };
}
