import { modelParticipantByHandle, resolveAddressee } from 'meteor/10thfloor:agent';
import './mission-recipients.css';

let pickerSequence = 0;
const svg = (body) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const chevron = svg('<path d="m6 8 4 4 4-4"/>');
const people = svg('<circle cx="7" cy="6" r="2.5"/><path d="M2.5 16v-2a4.5 4.5 0 0 1 9 0v2M13 4a2.5 2.5 0 0 1 0 5M14 11a4 4 0 0 1 3.5 4v1"/>');
const check = svg('<path d="m5 10 3 3 7-7"/>');

/** One explicit destination/action in the shared mission chat. */
export function initializeMissionRecipients({ chat, storage = window.localStorage, onChange = () => {}, onModeChange = () => {} }) {
  const id = `mission-recipient-menu-${++pickerSequence}`;
  const control = document.createElement('div');
  control.className = 'mission-recipient'; control.slot = 'composer-header';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'mission-recipient-button';
  button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-controls', id); button.setAttribute('aria-expanded', 'false');
  const avatar = document.createElement('span'); avatar.className = 'mission-recipient-avatar'; avatar.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.className = 'mission-recipient-label';
  const arrow = document.createElement('span'); arrow.className = 'mission-recipient-chevron'; arrow.innerHTML = chevron;
  const noteHint = document.createElement('span'); noteHint.className = 'mission-recipient-note-hint'; noteHint.textContent = 'No agent reply'; noteHint.hidden = true;
  button.append(avatar, label, arrow); control.append(button, noteHint);
  const menu = document.createElement('div'); menu.id = id; menu.className = 'mission-recipient-menu';
  menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Who should respond?');
  menu.setAttribute('aria-describedby', `${id}-hint`);
  const menuHint = document.createElement('p'); menuHint.id = `${id}-hint`; menuHint.className = 'mission-recipient-menu-hint';
  const choices = document.createElement('div'); choices.className = 'mission-recipient-choices'; choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Agents');
  const divider = document.createElement('div'); divider.className = 'mission-recipient-divider'; divider.setAttribute('role', 'separator');
  const note = menuOption('note', 'Crew note', 'No agent reply');
  menu.append(menuHint, choices, divider, note); document.body.append(menu);
  const notice = document.createElement('p');
  notice.className = 'mission-recipient-notice'; notice.slot = 'composer-context';
  notice.setAttribute('role', 'status'); notice.hidden = true;
  chat.append(control, notice);
  let state = null, key = null, choice = null, leading = '', disposed = false;
  let typeahead = '', typeaheadAt = 0;
  const remembered = new Map();
  const busy = () => chat.shadowRoot?.querySelector('.composer')?.getAttribute('aria-busy') === 'true';
  const models = () => (state?.session?.participants ?? []).filter((row) => row.kind === 'model' && row.agent)
    .sort((a, b) => Number(b.agent === state.session.agent) - Number(a.agent === state.session.agent));
  const selected = () => models().find((row) => row.id === choice?.id);
  const isOpen = () => menu.matches(':popover-open');
  const items = () => [...menu.querySelectorAll('[data-recipient-choice]:not(:disabled)')];
  const unavailable = () => !state?.writable || busy() || !state.session?._id;
  const remember = (row) => {
    choice = { id: row.id, label: row.displayName || row.agent };
    if (!key) return;
    remembered.set(key, choice);
    try { storage.setItem(key, JSON.stringify(choice)); } catch { /* In-memory preference still works. */ }
  };
  function menuOption(value, name, role) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'mission-recipient-option'; item.tabIndex = -1;
    item.dataset.recipientChoice = value; item.dataset.recipientName = name;
    item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', 'false');
    const icon = document.createElement('span'); icon.className = 'mission-recipient-avatar'; icon.setAttribute('aria-hidden', 'true');
    if (value === 'note') icon.innerHTML = people; else icon.textContent = Array.from(name)[0] || '?';
    const copy = document.createElement('span'); copy.className = 'mission-recipient-option-copy';
    const title = document.createElement('span'); title.textContent = name; copy.append(title);
    if (role) { const detail = document.createElement('small'); detail.textContent = role; copy.append(detail); }
    const mark = document.createElement('span'); mark.className = 'mission-recipient-check'; mark.innerHTML = check;
    item.append(icon, copy, mark); return item;
  }
  function close(focus = false) {
    if (isOpen()) menu.hidePopover();
    button.setAttribute('aria-expanded', 'false'); typeahead = '';
    if (focus && !disposed) button.focus({ preventScroll: true });
  }
  function position() {
    if (!isOpen()) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(340, Math.max(240, window.innerWidth - 32));
    menu.style.width = `${width}px`;
    const above = rect.top - 12, below = window.innerHeight - rect.bottom - 12;
    const openBelow = below >= Math.min(340, menu.scrollHeight) || below >= above;
    menu.style.maxHeight = `${Math.max(100, Math.min(440, openBelow ? below : above))}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    menu.style.top = `${Math.max(12, openBelow ? rect.bottom + 6 : rect.top - menu.getBoundingClientRect().height - 6)}px`;
  }
  function syncAvailability() {
    if (disposed) return;
    const disabled = unavailable(); button.disabled = disabled;
    menu.querySelectorAll('[data-recipient-choice]').forEach((item) => {
      item.disabled = disabled || item.dataset.unavailable === 'true';
    });
    if (disabled) close();
  }
  function paint() {
    if (!state || disposed) return;
    const isNote = state.mode === 'note', row = selected(), missing = !!choice && !row;
    const name = row?.displayName || choice?.label || state.primary?.label || 'agent';
    label.textContent = isNote ? 'Crew note' : `Ask ${name}`;
    if (isNote) avatar.innerHTML = people; else avatar.textContent = Array.from(name)[0] || '?';
    noteHint.hidden = !isNote;
    button.setAttribute('aria-label', `${label.textContent} — choose an agent or post a crew note`);
    menuHint.textContent = state.sharedChannels > 0
      ? 'Replies stay in this mission’s shared chat and connected channels'
      : 'Replies stay in this mission’s shared chat';
    const options = models().map((participant) => {
      const definition = state.crew?.find((entry) => entry.agent === participant.agent);
      return { id: participant.id, label: participant.displayName || participant.agent,
        role: definition?.role || (participant.agent === state.session.agent ? state.primary?.role : '') || '' };
    });
    if (missing) options.unshift({ id: choice.id, label: choice.label, role: 'No longer on this mission', disabled: true });
    const signature = JSON.stringify(options);
    let restoreFocus = null;
    if (choices.dataset.options !== signature) {
      restoreFocus = choices.contains(document.activeElement) ? document.activeElement.dataset.recipientChoice : null;
      choices.replaceChildren(...options.map((option) => {
        const item = menuOption(option.id, option.label, option.role);
        item.dataset.unavailable = String(!!option.disabled); item.disabled = !!option.disabled; return item;
      }));
      if (!options.length) { const empty = document.createElement('p'); empty.className = 'mission-recipient-empty'; empty.textContent = 'Loading crew…'; choices.append(empty); }
      choices.dataset.options = signature;
    }
    menu.querySelectorAll('[data-recipient-choice]').forEach((item) => item.setAttribute('aria-checked', String(
      item.dataset.recipientChoice === 'note' ? isNote : !isNote && item.dataset.recipientChoice === choice?.id,
    )));
    chat.recipient = isNote ? undefined : choice?.id;
    chat.composerMode = isNote ? 'note' : 'ask';
    // Missing destinations block only new submissions, never Stop or approvals.
    chat.setAttribute('aria-disabled', String(!state.writable));
    chat.setAttribute('composer-disabled', String(!isNote && (!row || !state.session?._id)));
    chat.setAttribute('placeholder', !state.writable ? `Mission ${state.status}` : isNote ? 'Write a crew note…' : 'Write a message…');
    chat.setAttribute('submit-label', isNote ? 'Post note' : 'Send');
    notice.hidden = isNote || !missing;
    notice.textContent = missing ? `${name} is no longer on this mission. Choose another recipient.` : '';
    syncAvailability(); position();
    if (restoreFocus && isOpen()) {
      const available = items();
      (available.find((item) => item.dataset.recipientChoice === restoreFocus) || available[0])?.focus({ preventScroll: true });
    }
  }
  function choose(id, { focus = true } = {}) {
    if (unavailable()) return false;
    const row = models().find((participant) => participant.id === id || participant.agent === id);
    if (!row) return false;
    remember(row); const changedMode = state.mode !== 'ask'; state = { ...state, mode: 'ask' };
    paint(); close();
    if (changedMode) onModeChange('ask');
    onChange(row);
    if (focus) chat.focusComposer?.();
    return true;
  }
  function chooseNote({ focus = true } = {}) {
    if (unavailable()) return false;
    const changedMode = state.mode !== 'note'; state = { ...state, mode: 'note' };
    paint(); close();
    if (changedMode) onModeChange('note');
    if (focus) chat.focusComposer?.();
    return true;
  }
  function update(next) {
    state = next;
    const nextKey = next.session?._id ? `constellation.recipient:${next.userId || 'local'}:${next.session._id}` : null;
    if (nextKey !== key) {
      close(); key = nextKey; choice = key ? remembered.get(key) ?? null : null; leading = '';
      if (!choice && key) {
        try {
          const saved = JSON.parse(storage.getItem(key) || 'null');
          if (typeof saved?.id === 'string' && typeof saved?.label === 'string') choice = saved;
        } catch { /* A corrupt preference never prevents opening a mission. */ }
      }
    }
    if (!choice) {
      const primary = models().find((row) => row.agent === next.session?.agent);
      if (primary) choice = { id: primary.id, label: primary.displayName || primary.agent };
    }
    paint();
  }
  function open(focus = 'selected') {
    if (unavailable()) return;
    paint(); menu.showPopover(); button.setAttribute('aria-expanded', 'true'); position();
    const available = items();
    const target = focus === 'first' ? available[0] : focus === 'last' ? available.at(-1)
      : available.find((item) => item.getAttribute('aria-checked') === 'true') || available[0];
    target?.focus({ preventScroll: true });
  }
  function mention(event) {
    if (event.detail?.prefix !== '@' || event.detail.kind !== 'agent' || state?.mode === 'note') return;
    const row = modelParticipantByHandle(state?.session ?? {}, event.detail.handle);
    if (!row) return;
    event.preventDefault();
    if (!choose(row.id, { focus: false })) return;
    const { start, end } = event.detail.range ?? {}, text = chat.draftText || '';
    if (Number.isInteger(start) && Number.isInteger(end) && text.slice(start, end).startsWith('@')) {
      chat.setDraft(text.slice(0, start) + text.slice(end), { selectionStart: start, selectionEnd: start });
    }
    chat.focusComposer?.();
  }
  function draft(event) {
    if (!state) return;
    const text = event.detail?.text || '', next = /^\s*@([\w.-]+)/.exec(text)?.[1] || '';
    if (state.mode === 'note' || busy()) { leading = next; return; }
    const hit = resolveAddressee(text, undefined, state.session ?? {});
    if (next !== leading && hit) choose(hit.id, { focus: false });
    leading = next;
  }
  const toggle = () => isOpen() ? close(true) : open();
  const triggerKey = (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); open(event.key === 'ArrowUp' ? 'last' : 'first');
  };
  const pick = (event) => {
    const item = event.target.closest('[data-recipient-choice]');
    if (!item || item.disabled) return;
    if (item.dataset.recipientChoice === 'note') chooseNote(); else choose(item.dataset.recipientChoice);
  };
  const menuKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const available = items(), index = available.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
      available[next]?.focus();
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      const now = Date.now(); typeahead = now - typeaheadAt > 700 ? event.key : typeahead + event.key; typeaheadAt = now;
      const match = available.find((item) => item.dataset.recipientName.toLocaleLowerCase().startsWith(typeahead.toLocaleLowerCase()));
      if (match) { event.preventDefault(); match.focus(); }
    }
  };
  const toggled = () => { button.setAttribute('aria-expanded', String(isOpen())); };
  button.addEventListener('click', toggle); button.addEventListener('keydown', triggerKey);
  menu.addEventListener('click', pick); menu.addEventListener('keydown', menuKey); menu.addEventListener('toggle', toggled);
  chat.addEventListener('agent-chat:mention-select', mention); chat.addEventListener('agent-chat:draft-change', draft);
  window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
  const observer = new MutationObserver(syncAvailability);
  if (chat.shadowRoot) observer.observe(chat.shadowRoot, { subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
  return { update, choose, chooseNote, open, close, control, button, menu, notice,
    canSend: () => !!state?.writable && !!selected() && !busy(),
    dispose() {
      disposed = true; observer.disconnect(); close(); menu.remove(); control.remove(); notice.remove();
      chat.recipient = undefined; chat.removeAttribute('composer-disabled');
      button.removeEventListener('click', toggle); button.removeEventListener('keydown', triggerKey);
      menu.removeEventListener('click', pick); menu.removeEventListener('keydown', menuKey); menu.removeEventListener('toggle', toggled);
      chat.removeEventListener('agent-chat:mention-select', mention); chat.removeEventListener('agent-chat:draft-change', draft);
      window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
    },
  };
}
