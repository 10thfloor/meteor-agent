// The Mission list as a tree: each Mission is a section with its #topics under it, like channels in a workspace.
//
// A Mission row opens the topic you last had open there (#general at first) and expands it; its arrow only folds it.
// Topic rows open their topic. Unread topics are bold, a working topic has a moving dot, and a topic waiting for an
// approval shows a count. "Add topic" turns into a name field in place.
//
// Keyboard: the tree has one tab stop. Up and Down move, Right opens a Mission or moves into it, Left folds it or
// moves to it, Home and End jump, Enter opens. Option-Up and Option-Down move between topics from anywhere;
// add Shift to move between unread topics.
import { normalizeTopicName, topicLabel, topicNameProblem } from '../imports/constellation/topics';

const storage = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered on this device */ }
  },
};

/** Per device and account: how far each topic has been read, which Missions are folded, and each Mission's last topic. */
export function createTopicMemory(userId) {
  const prefix = `constellation.topics:${userId ?? 'local'}`;
  const read = storage.read(`${prefix}:read`, {});
  const folded = new Set(storage.read(`${prefix}:folded`, []));
  const last = storage.read(`${prefix}:last`, {});
  return {
    /** A topic seen for the first time counts as read up to where it is: only what arrives later is new. */
    unread(sessionId, seq) {
      if (!(sessionId in read)) { read[sessionId] = seq; storage.write(`${prefix}:read`, read); return false; }
      return seq > read[sessionId];
    },
    markRead(sessionId, seq) {
      if ((read[sessionId] ?? -1) >= seq) return;
      read[sessionId] = seq;
      storage.write(`${prefix}:read`, read);
    },
    folded: (missionId) => folded.has(missionId),
    setFolded(missionId, value) {
      if (value) folded.add(missionId); else folded.delete(missionId);
      storage.write(`${prefix}:folded`, [...folded]);
    },
    lastTopic: (missionId) => last[missionId] ?? null,
    setLastTopic(missionId, sessionId) {
      if (last[missionId] === sessionId) return;
      last[missionId] = sessionId;
      storage.write(`${prefix}:last`, last);
    },
  };
}

// The open "Add topic" field per Mission, kept here rather than read back from the page: the list re-renders whenever
// any session changes, including while a new topic is being saved.
const drafts = new Map();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function stateDot(state) {
  const dot = el('i');
  dot.className = [
    state.key,
    ['loading', 'thinking', 'working'].includes(state.key) ? 'active' : '',
    state.key === 'waiting' ? 'awaiting' : '',
  ].filter(Boolean).join(' ');
  dot.dataset.agentState = state.key;
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function waitingBadge(count, label) {
  const badge = el('b', 'tree-badge', String(count));
  badge.title = label;
  return badge;
}

/**
 * Render the tree into `root`.
 * model: { query, currentSessionId, missions: [{ id, title, time, state, waiting, unread, folded, current,
 *   topics: [{ id, name, state, waiting, unread, current }] }] }
 * handlers: { open(sessionId), openMission(missionId), toggle(missionId, folded), createTopic(missionId, name),
 *   takenNames(missionId) }
 */
export function renderMissionTree(root, model, handlers) {
  const focusedKey = root.contains(document.activeElement)
    ? document.activeElement.closest('[data-tree-key]')?.dataset.treeKey : null;
  const typing = root.contains(document.activeElement) && document.activeElement.closest('.topic-add-form');
  root.textContent = '';
  root.setAttribute('role', 'tree');
  root.setAttribute('aria-label', 'Missions');
  let restore = null;
  let tabStop = null;

  for (const mission of model.missions) {
    const group = el('div', 'mission-group');
    group.setAttribute('role', 'none');
    const expanded = !mission.folded || Boolean(model.query);
    const header = el('div', `mission-group-row${mission.current ? ' current-mission' : ''}${mission.unread && !expanded ? ' unread' : ''}`);
    header.setAttribute('role', 'treeitem');
    header.setAttribute('aria-level', '1');
    header.setAttribute('aria-expanded', String(expanded));
    header.dataset.treeKey = `mission:${mission.id}`;
    header.dataset.missionId = mission.id;
    header.dataset.agentState = mission.state.key;
    header.tabIndex = -1;
    const fold = el('button', 'tree-fold');
    fold.type = 'button';
    fold.tabIndex = -1;
    fold.setAttribute('aria-hidden', 'true');
    fold.title = expanded ? 'Fold' : 'Unfold';
    const title = el('span', 'mission-group-title', mission.title);
    const end = el('span', 'tree-end');
    if (mission.waiting) end.append(waitingBadge(mission.waiting, `${mission.waiting} waiting for approval`));
    else if (mission.unread && !expanded) end.append(el('span', 'tree-unread-dot'));
    end.append(el('time', '', mission.time));
    header.append(fold, stateDot(mission.state), title, end);
    header.setAttribute('aria-label', [
      mission.title, mission.state.label,
      mission.waiting ? `${mission.waiting} waiting for approval` : '',
      mission.unread ? 'unread' : '',
    ].filter(Boolean).join(' · '));
    header.title = mission.state.detail;
    fold.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.toggle(mission.id, expanded);
    });
    header.addEventListener('click', () => handlers.openMission(mission.id));
    group.append(header);
    if (mission.current) tabStop ??= header;
    if (header.dataset.treeKey === focusedKey) restore = header;

    // A folded Mission still shows the topic you are in.
    const visible = expanded ? mission.topics : mission.topics.filter((topic) => topic.current);
    if (visible.length || expanded) {
      const children = el('div', 'mission-topics');
      children.setAttribute('role', 'group');
      for (const topic of visible) {
        const row = el('div', `mission-row topic-row${topic.current ? ' current' : ''}${topic.unread ? ' unread' : ''}`);
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', '2');
        row.dataset.treeKey = `topic:${topic.id}`;
        row.dataset.sessionId = topic.id;
        row.dataset.missionId = mission.id;
        row.dataset.agentState = topic.state.key;
        row.tabIndex = -1;
        if (topic.current) row.setAttribute('aria-current', 'page');
        const name = el('span', 'topic-name');
        name.append(el('span', 'topic-hash', '#'), document.createTextNode(topic.name));
        const tail = el('span', 'tree-end');
        if (topic.waiting) tail.append(waitingBadge(topic.waiting, 'Waiting for approval'));
        row.append(stateDot(topic.state), name, tail);
        row.setAttribute('aria-label', [
          topicLabel(topic.name), topic.state.label, topic.waiting ? 'waiting for approval' : '', topic.unread ? 'unread' : '',
        ].filter(Boolean).join(' · '));
        row.title = topic.state.detail;
        row.addEventListener('click', () => handlers.open(topic.id));
        children.append(row);
        if (topic.current) tabStop = row;
        if (row.dataset.treeKey === focusedKey) restore = row;
      }
      if (expanded && !model.query) {
        if (drafts.has(mission.id)) children.append(topicForm(root, mission, handlers));
        else {
          const add = el('div', 'topic-add-row');
          add.setAttribute('role', 'treeitem');
          add.setAttribute('aria-level', '2');
          add.dataset.treeKey = `add:${mission.id}`;
          add.dataset.missionId = mission.id;
          add.tabIndex = -1;
          add.append(el('span', 'topic-add-plus', '+'), document.createTextNode('Add topic'));
          add.setAttribute('aria-label', `Add a topic to ${mission.title}`);
          add.addEventListener('click', () => startTopicForm(root, mission, handlers));
          children.append(add);
          if (add.dataset.treeKey === focusedKey) restore = add;
        }
      }
      group.append(children);
    }
    root.append(group);
  }

  tabStop ??= root.querySelector('[role="treeitem"]');
  if (tabStop) tabStop.tabIndex = 0;
  if (restore) {
    for (const item of root.querySelectorAll('[role="treeitem"]')) item.tabIndex = -1;
    restore.tabIndex = 0;
    requestAnimationFrame(() => restore.isConnected && restore.focus({ preventScroll: true }));
  }
  const field = root.querySelector('.topic-add-form input');
  if (typing && field) {
    const at = field.value.length;
    requestAnimationFrame(() => { if (field.isConnected) { field.focus({ preventScroll: true }); field.setSelectionRange(at, at); } });
  }
}

function startTopicForm(root, mission, handlers) {
  for (const id of drafts.keys()) if (id !== mission.id && !drafts.get(id).busy) drafts.delete(id);
  root.querySelectorAll('.topic-add-form').forEach((form) => { if (!drafts.has(form.dataset.missionId)) form.remove(); });
  drafts.set(mission.id, { value: '', busy: false, message: '' });
  const add = root.querySelector(`.topic-add-row[data-mission-id="${CSS.escape(mission.id)}"]`);
  const form = topicForm(root, mission, handlers);
  add?.replaceWith(form);
  form.querySelector('input').focus();
}

function topicForm(root, mission, handlers) {
  const draft = drafts.get(mission.id) ?? { value: '', busy: false, message: '' };
  const value = draft.value;
  const form = el('form', 'topic-add-form');
  form.dataset.missionId = mission.id;
  form.setAttribute('role', 'none');
  form.noValidate = true;
  const field = el('label', 'topic-add-field');
  field.append(el('span', 'topic-hash', '#'));
  const input = el('input');
  input.type = 'text';
  input.value = value;
  input.maxLength = 60;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'topic-name';
  input.setAttribute('aria-label', `New topic in ${mission.title}`);
  field.append(input);
  const hint = el('small', 'topic-add-hint', 'Enter to add · Esc to cancel');
  hint.id = `topic-add-hint-${mission.id}`;
  input.setAttribute('aria-describedby', hint.id);
  form.append(field, hint);
  const problem = () => {
    const name = normalizeTopicName(input.value);
    return input.value.trim() ? topicNameProblem(name, handlers.takenNames(mission.id)) : null;
  };
  const showHint = () => {
    const name = normalizeTopicName(input.value);
    const issue = problem();
    hint.textContent = issue ?? (name && name !== input.value.trim() ? `Will be #${name}` : 'Enter to add · Esc to cancel');
    form.classList.toggle('invalid', Boolean(issue));
  };
  input.addEventListener('input', () => { draft.value = input.value; draft.message = ''; showHint(); });
  const close = () => {
    drafts.delete(mission.id);
    form.dispatchEvent(new CustomEvent('topic-form-close', { bubbles: true }));
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  // Leaving an empty field puts it away. A re-render replacing the field is not leaving it.
  input.addEventListener('blur', () => queueMicrotask(() => {
    if (form.isConnected && !input.value.trim() && !draft.busy) close();
  }));
  const showBusy = () => {
    input.readOnly = draft.busy;
    if (draft.busy) hint.textContent = 'Adding…';
    else if (draft.message) { hint.textContent = draft.message; form.classList.add('invalid'); }
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (draft.busy) return;
    const issue = problem();
    if (!input.value.trim() || issue) { showHint(); input.focus(); return; }
    draft.busy = true;
    showBusy();
    try {
      await handlers.createTopic(mission.id, normalizeTopicName(input.value));
      close();
    } catch (error) {
      draft.busy = false;
      draft.message = error?.reason ?? error?.message ?? 'Could not add the topic.';
      // The list may have re-rendered while this was saving; speak through whichever field is on the page now.
      const live = root.querySelector(`.topic-add-form[data-mission-id="${CSS.escape(mission.id)}"]`);
      live?.dispatchEvent(new CustomEvent('topic-form-refresh'));
      live?.querySelector('input')?.focus();
    }
  });
  form.addEventListener('topic-form-refresh', showBusy);
  if (value) queueMicrotask(showHint);
  showBusy();
  return form;
}

/** Keyboard handling for the tree and the Option-arrow shortcuts. Call once. */
export function wireMissionTree(root, handlers) {
  const items = () => [...root.querySelectorAll('[role="treeitem"]')];
  const focusItem = (item) => {
    if (!item) return;
    for (const other of items()) other.tabIndex = -1;
    item.tabIndex = 0;
    item.focus();
    item.scrollIntoView({ block: 'nearest' });
  };
  root.addEventListener('topic-form-close', (event) => {
    const form = event.target.closest('.topic-add-form');
    const missionId = form?.dataset.missionId;
    form?.remove();
    handlers.formClosed?.(missionId);
  });
  root.addEventListener('keydown', (event) => {
    const item = event.target.closest('[role="treeitem"]');
    if (!item || event.target.closest('form')) return;
    const all = items();
    const index = all.indexOf(item);
    const isMission = item.classList.contains('mission-group-row');
    const expanded = item.getAttribute('aria-expanded') === 'true';
    const missionHeader = () => root.querySelector(`.mission-group-row[data-mission-id="${CSS.escape(item.dataset.missionId)}"]`);
    let handled = true;
    switch (event.key) {
      case 'ArrowDown': focusItem(all[index + 1]); break;
      case 'ArrowUp': focusItem(all[index - 1]); break;
      case 'Home': focusItem(all[0]); break;
      case 'End': focusItem(all.at(-1)); break;
      case 'ArrowRight':
        if (isMission && !expanded) handlers.toggle(item.dataset.missionId, false);
        else if (isMission) focusItem(all[index + 1]);
        else handled = false;
        break;
      case 'ArrowLeft':
        if (isMission && expanded) handlers.toggle(item.dataset.missionId, true);
        else if (!isMission) focusItem(missionHeader());
        else handled = false;
        break;
      case 'Enter':
      case ' ':
        item.click();
        break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  });
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.metaKey || event.ctrlKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    if (!handlers.active()) return;
    const editing = event.composedPath().some((node) => node instanceof HTMLElement
      && (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) || node.isContentEditable));
    // In a text field Option-arrows move the caret; they are left alone there.
    if (editing) return;
    const topics = [...root.querySelectorAll('.topic-row')].filter((row) => !event.shiftKey || row.classList.contains('unread') || row.classList.contains('current'));
    if (!topics.length) return;
    const current = topics.findIndex((row) => row.classList.contains('current'));
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = topics[(current + step + topics.length) % topics.length];
    if (!next || next.classList.contains('current')) return;
    event.preventDefault();
    handlers.open(next.dataset.sessionId);
  });
}
