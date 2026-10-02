import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';
import { DurableConversation } from 'meteor/10thfloor:durable';
import {
  DURABLE_DEFINITION,
  DURABLE_PLAN_KIND,
  messageText,
  threadSpend,
  threadTokens,
  transcriptRows,
} from '../imports/constellation/durable';
import { renderMarkdown } from './durable-markdown';
import './durable-threads.css';

// Threads: Constellation's surface on `10thfloor:durable`.
//
// It is a layer over the workspace, opened from its own button in the rail,
// and it owns everything it shows: the app's views, and which of them is
// current, are untouched underneath. Opening it covers them; choosing any
// view closes it.
//
// What is on screen is read from `DurableConversation`, which is the stored
// rows of the conversation, kept current. Nothing is asked of the server
// instance that happens to run the thread, so the layer shows the same thing
// whichever instance the browser is connected to, and goes on showing it
// while a thread changes hands.

const DurableThreads = new Mongo.Collection('constellation_durable_threads');
const THREAD_KEY = 'constellation.thread';
const NEAR_BOTTOM = 96;

// The layer's skeleton and its icons are the only markup set as HTML, and they
// are constants of this file. Everything a thread contains is written as text
// nodes, or by the Markdown renderer, which makes text nodes too.
const ICONS = {
  rail: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="9.5" r="2"/><path d="M6.5 7.5v9M17.5 11.5c0 3.2-3.4 3.4-6.2 4.1-1.9.5-3.2 1-4.3 2"/></svg>',
  plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>',
};

const LAYER = `
  <aside class="threads-sidebar" aria-label="Thread list">
    <div class="sidebar-heading">
      <div><p class="eyebrow">Experimental</p><h1>Threads</h1></div>
      <button class="icon-button primary" id="threads-new" type="button" aria-label="New thread" title="New thread">${ICONS.plus}</button>
    </div>
    <div class="sidebar-section-label"><span>Threads</span><span id="threads-count">0</span></div>
    <div class="mission-list" id="threads-list" aria-label="Threads"></div>
    <div class="threads-note">
      <strong>Committed before it is shown</strong>
      <span>A thread survives a restart in the middle of an answer and picks up where it was.</span>
    </div>
  </aside>
  <div class="threads-stage">
    <div class="threads-empty" id="threads-empty">
      <p class="eyebrow">Threads</p>
      <h2>A conversation that survives its server</h2>
      <p>Every model turn, tool call and plan change is stored before you see it. Stop the app in the middle of an answer and the thread goes on from there. Fork from any answer to try another direction.</p>
      <button class="primary-action" id="threads-start" type="button">Start a thread</button>
    </div>
    <div class="threads-open" id="threads-open" hidden>
      <header class="threads-topbar">
        <div class="threads-title-block">
          <button class="threads-title" id="threads-title" type="button" title="Rename"></button>
          <input class="threads-title-input" id="threads-title-input" type="text" maxlength="120" aria-label="Thread title" hidden>
          <div class="threads-meta" id="threads-usage" aria-live="off"></div>
        </div>
        <div class="threads-controls">
          <label class="threads-select"><span>Branch</span><select id="threads-branch" aria-label="Conversation"></select></label>
          <label class="threads-select"><span>Model</span><select id="threads-model" aria-label="Model"></select></label>
          <button class="secondary-action" id="threads-reset" type="button" title="Start a new context. Earlier messages stay in the thread; the model no longer sees them.">New context</button>
          <button class="secondary-action" id="threads-compact" type="button" title="Summarize earlier messages to make room">Summarize</button>
          <button class="secondary-action threads-danger" id="threads-delete" type="button">Delete</button>
        </div>
      </header>
      <div class="threads-body">
        <div class="threads-transcript" id="threads-transcript" tabindex="0" aria-label="Conversation"></div>
        <aside class="threads-side" aria-label="Plan and queue">
          <section>
            <h3>Plan</h3>
            <ol class="threads-plan" id="threads-plan"></ol>
          </section>
          <section id="threads-queue-section" hidden>
            <h3>Queued</h3>
            <ul class="threads-queue" id="threads-queue"></ul>
          </section>
        </aside>
      </div>
      <form class="threads-composer" id="threads-composer">
        <p class="threads-offline" id="threads-offline" role="status" hidden>The server is not answering. This is the thread as it was last stored; it goes on from here when the server is back.</p>
        <textarea id="threads-input" rows="2" maxlength="20000" placeholder="Say something. Enter sends, Shift+Enter adds a line." aria-label="Message"></textarea>
        <div class="threads-composer-row">
          <span class="threads-status" id="threads-status" role="status"></span>
          <button class="secondary-action" id="threads-stop" type="button" hidden>Stop</button>
          <button class="secondary-action" id="threads-steer" type="button" hidden title="Add this to the work in progress">Steer</button>
          <button class="primary-action" id="threads-send" type="submit">Send</button>
        </div>
      </form>
    </div>
  </div>
`;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const messageOf = (error) => error?.reason || error?.message || 'Something went wrong.';
const compact = (count) => (count >= 10_000 ? `${Math.round(count / 1000)}k` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
const ago = (date) => {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
};

let shell;
let layer;
let railButton;
let open = false;
/** What the layer covered when it opened, to put back if it is closed without a view having been chosen. */
let covered = null;
let threadId = null;
let conversationId = 1;
let chat = null;
let renaming = false;
let deleteArmed = null;
const selection = new Tracker.Dependency();
const opened = new Tracker.Dependency();
/** Computations that run only while the layer is open. */
let computations = [];

// ── Opening and closing ──────────────────────────────────────────────────────

function setOpen(next, { byViewChange = false } = {}) {
  if (open === next) return;
  open = next;
  layer.hidden = !open;
  railButton.classList.toggle('active', open);
  railButton.setAttribute('aria-pressed', String(open));
  const sidebar = $('mission-sidebar');
  const stage = shell.querySelector('.content-stage');
  if (open) {
    shell.dataset.threadsOpen = 'true';
    const current = shell.querySelector('.rail-button[data-view][aria-current]');
    covered = { sidebarInert: sidebar?.inert === true, current };
    current?.removeAttribute('aria-current');
    railButton.setAttribute('aria-current', 'page');
    // What is underneath can neither be seen nor take focus.
    if (sidebar) sidebar.inert = true;
    if (stage) stage.inert = true;
    start();
    $('threads-input').focus({ preventScroll: true });
  } else {
    delete shell.dataset.threadsOpen;
    railButton.removeAttribute('aria-current');
    if (stage) stage.inert = false;
    // A view that was just chosen has set its own state; otherwise put back what was covered.
    if (!byViewChange && covered) {
      if (sidebar) sidebar.inert = covered.sidebarInert;
      covered.current?.setAttribute('aria-current', 'page');
    }
    covered = null;
    stop();
  }
  opened.changed();
}

/** Whether the Threads layer is showing. Reactive. */
export function threadsOpen() {
  opened.depend();
  return open;
}

/** Show or hide the Threads layer. */
export function showThreads(next = true) {
  if (layer) setOpen(next);
}

// ── Reading: one conversation at a time ──────────────────────────────────────

function select(nextThread, nextConversation = 1) {
  threadId = nextThread;
  conversationId = nextConversation;
  renaming = false;
  disarmDelete();
  // Remembered across a reload, like the mission the app reopens.
  if (threadId) localStorage.setItem(THREAD_KEY, JSON.stringify({ threadId, conversationId }));
  else localStorage.removeItem(THREAD_KEY);
  selection.changed();
  // Whatever was chosen, the next thing a person does is type. After the flush, when the composer is on screen.
  if (open) Tracker.afterFlush(() => $('threads-input').focus({ preventScroll: true }));
}

const threadRow = () => (threadId ? DurableThreads.findOne(threadId) : undefined);
const catalog = () => Mongo.getCollection('constellation_model_catalog')?.findOne('available');

function start() {
  const subscription = Meteor.subscribe('constellation.durableThreads');
  const autorun = (work) => computations.push(Tracker.autorun(work));
  computations.push({ stop: () => subscription.stop() });

  // The conversation on screen follows the selection.
  autorun(() => {
    selection.depend();
    const row = threadId ? DurableThreads.findOne(threadId, { fields: { conversations: 1 } }) : undefined;
    Tracker.nonreactive(() => {
      chat?.stop();
      chat = null;
      if (!row) return;
      if (!row.conversations.some((conversation) => conversation.id === conversationId)) conversationId = 1;
      chat = new DurableConversation({ host: DURABLE_DEFINITION, key: threadId, conversationId });
    });
    bound.changed();
  });
  // With no thread chosen, or one that was deleted here or elsewhere, the newest is the one on screen.
  autorun(() => {
    selection.depend();
    if (!subscription.ready()) return;
    if (threadId && DurableThreads.findOne(threadId, { fields: { _id: 1 } })) return;
    const next = DurableThreads.findOne({}, { sort: { updatedAt: -1 }, fields: { _id: 1 } })?._id ?? null;
    if (next !== threadId) Tracker.nonreactive(() => select(next));
  });
  autorun(renderList);
  autorun(renderTopbar);
  autorun(renderTranscript);
  autorun(renderLive);
  autorun(renderSide);
  autorun(renderConnection);
}

function stop() {
  for (const computation of computations.splice(0)) computation.stop();
  chat?.stop();
  chat = null;
}

/** Invalidated when `chat` is replaced; the renderers depend on it, since `chat` itself is not reactive. */
const bound = new Tracker.Dependency();
const conversation = () => {
  bound.depend();
  return chat;
};

// ── Rendering ────────────────────────────────────────────────────────────────

function renderList() {
  selection.depend();
  const threads = DurableThreads.find({}, { sort: { updatedAt: -1 } }).fetch();
  $('threads-count').textContent = String(threads.length);
  const list = $('threads-list');
  list.replaceChildren(...threads.map((thread) => {
    const row = el('button', `mission-row${thread._id === threadId ? ' current' : ''}`);
    row.type = 'button';
    row.dataset.threadId = thread._id;
    row.appendChild(el('i'));
    const copy = el('div', 'mission-row-copy');
    copy.appendChild(el('strong', '', thread.title));
    const forks = thread.conversations.length - 1;
    copy.appendChild(el('span', '', forks > 0 ? `${forks} ${forks === 1 ? 'fork' : 'forks'}` : 'No forks'));
    row.appendChild(copy);
    row.appendChild(el('time', '', ago(thread.updatedAt)));
    row.addEventListener('click', () => select(thread._id));
    return row;
  }));
  const any = threads.length > 0;
  $('threads-empty').hidden = any && !!threadId;
  $('threads-open').hidden = !(any && !!threadId);
}

function renderTopbar() {
  selection.depend();
  const row = threadRow();
  if (!row) return;
  if (!renaming) $('threads-title').textContent = row.title;

  const branch = $('threads-branch');
  branch.replaceChildren(...row.conversations.map((entry, index) => {
    const option = el('option', '', index === 0 ? 'Main' : `Fork ${index}`);
    option.value = String(entry.id);
    if (entry.parent !== undefined) {
      const parent = row.conversations.findIndex((candidate) => candidate.id === entry.parent);
      option.title = `From ${parent <= 0 ? 'Main' : `Fork ${parent}`}`;
    }
    return option;
  }));
  branch.value = String(conversationId);
  branch.closest('label').hidden = row.conversations.length < 2;

  const models = catalog();
  const select = $('threads-model');
  const groups = (models?.providers ?? []).map((provider) => {
    const group = el('optgroup');
    group.label = provider.label;
    for (const model of provider.models) {
      const option = el('option', '', model.label);
      option.value = model.id;
      group.appendChild(option);
    }
    return group;
  });
  const fallback = el('option', '', 'Workspace default');
  fallback.value = 'default';
  select.replaceChildren(fallback, ...groups);
  // A model the catalog no longer offers stays the thread's model, and says so.
  if (row.model !== 'default' && ![...select.options].some((option) => option.value === row.model)) {
    const missing = el('option', '', `${row.model} (unavailable)`);
    missing.value = row.model;
    select.appendChild(missing);
  }
  select.value = row.model;
}

/** Keep the transcript at its end when it was at its end. */
function following(container, change) {
  const pinned = container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM;
  change();
  if (pinned) container.scrollTop = container.scrollHeight;
}

function toolCard(row, result, slot) {
  const card = el('div', 'threads-tool');
  card.dataset.status = result ? (result.failed ? 'failed' : 'done') : (slot?.status ?? 'pending');
  const head = el('div', 'threads-tool-head');
  head.appendChild(el('strong', '', row.call.name));
  head.appendChild(el('span', '', result ? (result.failed ? 'Failed' : 'Done') : slot?.status === 'running' ? 'Running' : 'Waiting'));
  card.appendChild(head);
  const body = result?.text ?? slot?.output ?? '';
  if (body) card.appendChild(el('pre', '', body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body));
  return card;
}

function renderTranscript() {
  const current = conversation();
  const container = $('threads-transcript');
  if (!current) {
    container.replaceChildren();
    return;
  }
  const rows = transcriptRows(current.entries());
  const results = new Map(rows.filter((row) => row.kind === 'result').map((row) => [row.callId, row]));
  // The slots of the round in progress are read without depending on them: `renderLive` keeps the running ones current.
  const slots = new Map((Tracker.nonreactive(() => current.tools()) ?? []).map((slot) => [slot.callId, slot]));
  const nodes = [];
  for (const row of rows) {
    if (row.kind === 'result') continue;
    let node;
    if (row.kind === 'marker') {
      node = el('div', 'threads-marker');
      node.appendChild(el('span', '', row.text));
      if (row.detail) node.appendChild(el('p', '', row.detail));
    } else if (row.kind === 'call') {
      node = toolCard(row, results.get(row.call.id), slots.get(row.call.id));
      node.dataset.callId = row.call.id;
    } else {
      node = el('article', `threads-message threads-${row.kind}`);
      const body = el('div', 'threads-message-body');
      if (row.kind === 'assistant') renderMarkdown(body, row.text);
      else body.textContent = row.text;
      node.appendChild(body);
      if (row.note) node.appendChild(el('p', 'threads-message-note', row.note));
      if (row.kind === 'assistant' && row.text !== '') {
        const fork = el('button', 'threads-fork', 'Fork from here');
        fork.type = 'button';
        fork.addEventListener('click', () => forkAt(row.id, fork));
        node.appendChild(fork);
      }
    }
    if (row.past) node.classList.add('threads-past');
    nodes.push(node);
  }
  if (rows.length === 0 && current.ready()) {
    const hint = el('div', 'threads-hint');
    hint.appendChild(el('strong', '', 'Nothing said yet'));
    hint.appendChild(el('span', '', 'Ask for something with several steps and the agent keeps a plan beside the conversation.'));
    nodes.push(hint);
  }
  const live = el('div', 'threads-live');
  live.id = 'threads-live';
  following(container, () => container.replaceChildren(...nodes, live));
  Tracker.nonreactive(renderLive);
}

/** What is happening now: the answer as far as it has been committed, running tools, and the composer's state. */
function renderLive() {
  const current = conversation();
  const live = $('threads-live');
  const busy = current?.busy() === true;
  $('threads-stop').hidden = !busy;
  $('threads-steer').hidden = !busy;
  $('threads-send').textContent = busy ? 'Queue' : 'Send';
  $('threads-send').title = busy ? 'Send this after the current answer' : '';
  if (!current || !live) return;
  const container = $('threads-transcript');
  following(container, () => {
    const nodes = [];
    const partial = current.streaming();
    const text = messageText(partial);
    if (text !== '') {
      const node = el('article', 'threads-message threads-assistant threads-streaming');
      const body = el('div', 'threads-message-body');
      renderMarkdown(body, text);
      node.appendChild(body);
      nodes.push(node);
    } else if (busy && (current.tools() ?? []).every((slot) => slot.status === 'done')) {
      nodes.push(el('div', 'threads-thinking', 'Working'));
    }
    const retry = current.live()?.generation?.retry;
    if (retry) nodes.push(el('p', 'threads-message-note', `Retrying after an error: ${retry.error}`));
    live.replaceChildren(...nodes);
    // A tool that is running shows its output as it comes.
    for (const slot of current.tools() ?? []) {
      const card = container.querySelector(`.threads-tool[data-call-id="${CSS.escape(slot.callId)}"]`);
      if (!card || card.dataset.status === 'done' || card.dataset.status === 'failed') continue;
      card.dataset.status = slot.status;
      card.querySelector('.threads-tool-head span').textContent = slot.status === 'running' ? 'Running' : slot.status === 'done' ? 'Done' : 'Waiting';
      if (slot.output) {
        const pre = card.querySelector('pre') ?? card.appendChild(el('pre'));
        pre.textContent = slot.output.length > 4000 ? `${slot.output.slice(0, 4000)}\n…` : slot.output;
      }
    }
  });
}

function renderSide() {
  const current = conversation();
  const plan = current?.document(DURABLE_PLAN_KIND)?.items ?? [];
  const list = $('threads-plan');
  if (plan.length === 0) {
    const empty = el('li', 'threads-plan-empty', 'No plan yet. The agent writes one when the work has several steps.');
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...plan.map((item) => {
      const node = el('li', '', item.text);
      node.dataset.status = item.status;
      return node;
    }));
  }

  const queued = (current?.inbox()?.items ?? []).filter((item) => item.mode !== 'write');
  $('threads-queue-section').hidden = queued.length === 0;
  $('threads-queue').replaceChildren(...queued.map((item) => {
    const node = el('li');
    node.appendChild(el('span', '', typeof item.content === 'string' ? item.content : messageText({ role: 'user', content: item.content })));
    node.appendChild(el('em', '', item.mode === 'steer' ? 'Steers the work in progress' : 'After this answer'));
    const withdraw = el('button', 'threads-withdraw', 'Withdraw');
    withdraw.type = 'button';
    withdraw.addEventListener('click', () => act(withdraw, () => current.withdraw(item.id)));
    node.appendChild(withdraw);
    return node;
  }));

  const usage = current?.usage();
  const { input, output } = threadTokens(usage);
  const spent = threadSpend(usage);
  $('threads-usage').textContent = input + output === 0
    ? 'Nothing spent in this conversation'
    : `$${spent.toFixed(spent > 0 && spent < 0.01 ? 4 : 2)} · ${compact(input)} in · ${compact(output)} out`;
}

/**
 * Whether the server can be reached. What is on screen is the last thing that
 * was committed; when the server is back, the thread goes on from there.
 */
function renderConnection() {
  const { connected } = Meteor.status();
  const notice = $('threads-offline');
  notice.hidden = connected;
  $('threads-send').disabled = !connected;
  $('threads-steer').disabled = !connected;
  $('threads-stop').disabled = !connected;
}

// ── Speaking ─────────────────────────────────────────────────────────────────

function status(text, kind = 'info') {
  const node = $('threads-status');
  node.textContent = text;
  node.dataset.kind = kind;
}

/** Run something a button asked for, with the button busy meanwhile and a failure said where the person is looking. */
async function act(button, work) {
  if (button.dataset.loading === 'true') return undefined;
  button.dataset.loading = 'true';
  button.disabled = true;
  status('');
  try {
    return await work();
  } catch (error) {
    status(messageOf(error), 'error');
    return undefined;
  } finally {
    button.dataset.loading = 'false';
    button.disabled = false;
    // Unless the server is away, which keeps the composer's buttons off.
    if (open) Tracker.nonreactive(renderConnection);
  }
}

async function createThread(button) {
  const created = await act(button, () => Meteor.callAsync('constellation.durableThreadCreate'));
  if (created) {
    select(created.threadId, created.conversationId);
    $('threads-input').focus({ preventScroll: true });
  }
}

async function say(button, whenBusy) {
  const input = $('threads-input');
  const text = input.value;
  if (text.trim() === '' || !threadId) return;
  // The same ID on every attempt at this input: a retry after a lost connection is admitted once.
  const requestId = input.dataset.requestId || (input.dataset.requestId = Random.id());
  const sent = await act(button, () => Meteor.callAsync('constellation.durableThreadSay', {
    threadId,
    conversationId,
    text,
    requestId,
    ...(whenBusy ? { whenBusy } : {}),
  }));
  if (sent) {
    input.value = '';
    delete input.dataset.requestId;
    const container = $('threads-transcript');
    container.scrollTop = container.scrollHeight;
  }
  input.focus({ preventScroll: true });
}

async function forkAt(entryId, button) {
  const forked = await act(button, () => Meteor.callAsync('constellation.durableThreadFork', threadId, conversationId, entryId));
  if (forked) select(threadId, forked.conversationId);
}

function disarmDelete() {
  if (deleteArmed) clearTimeout(deleteArmed);
  deleteArmed = null;
  const button = document.getElementById('threads-delete');
  if (button) button.textContent = 'Delete';
}

function beginRename() {
  const row = threadRow();
  if (!row) return;
  renaming = true;
  const input = $('threads-title-input');
  input.value = row.title;
  input.hidden = false;
  $('threads-title').hidden = true;
  input.focus();
  input.select();
}

async function endRename(save) {
  if (!renaming) return;
  renaming = false;
  const input = $('threads-title-input');
  const title = input.value.trim();
  input.hidden = true;
  $('threads-title').hidden = false;
  const row = threadRow();
  if (save && row && title !== '' && title !== row.title) {
    $('threads-title').textContent = title;
    try {
      await Meteor.callAsync('constellation.durableThreadRename', row._id, title);
    } catch (error) {
      $('threads-title').textContent = row.title;
      status(messageOf(error), 'error');
    }
  }
}

// ── Putting it on the page ───────────────────────────────────────────────────

function wire() {
  $('threads-new').addEventListener('click', (event) => createThread(event.currentTarget));
  $('threads-start').addEventListener('click', (event) => createThread(event.currentTarget));
  $('threads-composer').addEventListener('submit', (event) => {
    event.preventDefault();
    void say($('threads-send'));
  });
  $('threads-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void say($('threads-send'));
  });
  // Text that changed is another input, with its own ID.
  $('threads-input').addEventListener('input', (event) => { delete event.currentTarget.dataset.requestId; });
  $('threads-steer').addEventListener('click', (event) => { void say(event.currentTarget, 'steer'); });
  $('threads-stop').addEventListener('click', (event) => act(event.currentTarget, async () => {
    const { idle } = await chat.abort();
    if (!idle) status('Asked to stop. A tool is still finishing.');
  }));
  $('threads-reset').addEventListener('click', async (event) => {
    await act(event.currentTarget, () => chat.reset());
    $('threads-input').focus({ preventScroll: true });
  });
  $('threads-compact').addEventListener('click', async (event) => {
    await act(event.currentTarget, async () => {
      await chat.compact();
      // Whether there was enough to summarize is known only once the task has looked.
      status('Asked for a summary. A marker appears in the thread if there was enough to summarize.');
    });
    $('threads-input').focus({ preventScroll: true });
  });
  $('threads-branch').addEventListener('change', (event) => select(threadId, Number(event.currentTarget.value)));
  $('threads-model').addEventListener('change', async (event) => {
    const target = event.currentTarget;
    const row = threadRow();
    const changed = await act(target, () => Meteor.callAsync('constellation.durableThreadModel', threadId, target.value));
    if (!changed && row) target.value = row.model;
  });
  $('threads-delete').addEventListener('click', (event) => {
    const button = event.currentTarget;
    // Twice, on purpose: the first press says what the second will do.
    if (!deleteArmed) {
      button.textContent = 'Delete for good?';
      deleteArmed = setTimeout(disarmDelete, 4000);
      return;
    }
    disarmDelete();
    const doomed = threadId;
    void act(button, () => Meteor.callAsync('constellation.durableThreadRemove', doomed));
  });
  $('threads-title').addEventListener('click', beginRename);
  $('threads-title-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void endRename(true); }
    if (event.key === 'Escape') { event.preventDefault(); void endRename(false); }
  });
  $('threads-title-input').addEventListener('blur', () => { void endRename(true); });
}

function mount() {
  shell = $('workspace-shell');
  const rail = shell?.querySelector('.rail-top');
  if (!shell || !rail || $('threads-layer')) return;

  railButton = el('button', 'rail-button');
  railButton.type = 'button';
  railButton.id = 'threads-rail';
  railButton.setAttribute('aria-label', 'Threads');
  railButton.setAttribute('aria-pressed', 'false');
  railButton.innerHTML = `${ICONS.rail}<span>Threads</span>`;
  railButton.hidden = true;
  railButton.addEventListener('click', () => setOpen(!open));
  rail.appendChild(railButton);

  layer = el('section', 'threads-layer');
  layer.id = 'threads-layer';
  layer.setAttribute('aria-label', 'Threads');
  layer.hidden = true;
  layer.innerHTML = LAYER;
  shell.appendChild(layer);
  wire();

  try {
    const remembered = JSON.parse(localStorage.getItem(THREAD_KEY) ?? 'null');
    if (typeof remembered?.threadId === 'string') {
      threadId = remembered.threadId;
      if (Number.isInteger(remembered.conversationId) && remembered.conversationId > 0) conversationId = remembered.conversationId;
    }
  } catch {
    localStorage.removeItem(THREAD_KEY);
  }

  // Any view being chosen, by the rail, the command palette or the app itself, closes the layer.
  new MutationObserver(() => { if (open) setOpen(false, { byViewChange: true }); })
    .observe(shell, { attributes: true, attributeFilter: ['data-current-view'] });

  // Threads belong to the workspace's owner, and the workspace says when it has started: until then, and
  // whenever it starts over, there is no button.
  const frame = $('app-frame');
  const startup = new Tracker.Dependency();
  if (frame) {
    new MutationObserver(() => startup.changed())
      .observe(frame, { attributes: true, attributeFilter: ['data-startup-state'] });
  }
  Tracker.autorun(() => {
    startup.depend();
    const available = !!Meteor.userId() && (!frame || frame.dataset.startupState === 'ready');
    railButton.hidden = !available;
    if (!available && open) Tracker.nonreactive(() => setOpen(false));
  });
}

Meteor.startup(mount);
