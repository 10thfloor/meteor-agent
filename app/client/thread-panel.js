// Threads in a topic: a summary under each message that has one ("3 replies · Relay, Vela · 2m"), "Reply in thread"
// on every message, and the thread itself in the right-hand pane with its own composer. A thread is its own session,
// forked from the topic at that message (see the agent package): its agent sees the topic up to the message and the
// thread, and it runs beside the topic. The pane shows the message and the replies; the history above stays context.
import { Tracker } from 'meteor/tracker';
import { setChatTimelineSource } from './chat-timeline';
import { initializeMissionRecipients } from './mission-recipients';
import { topicLabel } from '../imports/constellation/topics';
import './thread-panel.css';

const BUSY = new Set(['streaming', 'calling', 'retrying', 'compacting']);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * host: { workspace, chat, pane, currentChat(), currentMission(), topicName(sessionId), recipientState(session),
 *   timeAgo(date), openInspector(), toast(message, kind), defineChat() }
 */
export function initializeThreads(host) {
  const { workspace, chat, pane } = host;
  const summaries = new Map();
  let openThreadId = null;
  let anchorSeq = null;
  let threadSubscriptions = new Map();

  // The pane: a header naming the thread's topic, the thread's own chat, and the "also send" choice.
  const panel = el('section', 'thread-panel');
  panel.id = 'thread-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Thread');
  const header = el('header', 'thread-panel-header');
  const heading = el('div', 'thread-panel-heading');
  const title = el('h3', '', 'Thread');
  title.id = 'thread-panel-title';
  const where = el('span', 'thread-panel-topic');
  heading.append(title, where);
  const close = el('button', 'thread-panel-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close thread');
  close.title = 'Close thread (Esc)';
  close.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>';
  header.append(heading, close);
  panel.append(header);
  pane.append(panel);

  // The thread's own chat exists only while a thread is open, and is made with its session already named: an
  // <agent-chat> attached without a session starts a new one.
  let threadChat = null;
  let recipients = null;
  let alsoBox = null;
  let alsoText = null;
  // The thread's composer chooses its own agent, or a crew note, apart from the topic's.
  let threadMode = 'ask';
  function mountChat(threadId) {
    if (threadChat) {
      threadChat.setAttribute('session-id', threadId);
      return;
    }
    threadChat = document.createElement(host.chatTag ?? 'agent-chat');
    threadChat.id = 'thread-chat';
    threadChat.className = 'thread-chat';
    threadChat.setAttribute('agent', 'orchestrator');
    threadChat.setAttribute('session-id', threadId);
    threadChat.setAttribute('multiline', '');
    threadChat.setAttribute('aria-labelledby', title.id);
    const also = el('label', 'thread-also');
    also.slot = 'composer-context';
    alsoBox = el('input');
    alsoBox.type = 'checkbox';
    alsoBox.id = 'thread-also-send';
    alsoText = el('span', '', 'Also send to #general');
    also.append(alsoBox, alsoText);
    threadChat.append(also);
    panel.append(threadChat);
    threadMode = 'ask';
    recipients = initializeMissionRecipients({
      chat: threadChat, onChange: () => {}, onModeChange: (mode) => { threadMode = mode; paint(); },
    });
    const sending = threadChat;
    threadChat.submissionHandler = async ({ sessionId, text, mode, recipient }) => {
      if (mode === 'note') return sending.agentInstance.contribute(sessionId, text);
      const options = {
        ...(recipient !== undefined ? { to: recipient } : {}),
        ...(alsoBox?.checked ? { alsoToParent: true } : {}),
      };
      const sent = await sending.agentInstance.send(sessionId, text, Object.keys(options).length ? options : undefined);
      if (alsoBox) alsoBox.checked = false;
      return sent;
    };
  }
  function unmountChat() {
    recipients?.dispose();
    threadChat?.remove();
    threadChat = null; recipients = null; alsoBox = null; alsoText = null;
  }

  const threadDoc = (id = openThreadId) => (id ? host.AgentSessions.findOne(id) : null);
  // Where the thread starts: the message it was opened on (recorded on the thread; else found in the topic).
  const parentSeqOf = (row) => {
    if (Number.isInteger(row.thread.anchorSeq)) return row.thread.anchorSeq;
    const parent = chat.agentInstance?.messages(row.thread.sessionId).fetch()
      .find((message) => message._id === row.thread.messageId);
    return parent?.seq ?? row.thread.seq;
  };

  function show(threadId, { focus = true } = {}) {
    const row = threadDoc(threadId);
    if (!row?.thread) return;
    openThreadId = threadId;
    anchorSeq = parentSeqOf(row);
    host.openInspector();
    pane.classList.add('thread-open');
    panel.hidden = false;
    mountChat(threadId);
    threadChat.setAttribute('from-seq', String(anchorSeq));
    paint();
    for (const summary of summaries.values()) summary.button.setAttribute('aria-expanded', String(summary.id === threadId));
    if (focus) requestAnimationFrame(() => threadChat?.focusComposer?.());
  }

  function hide({ focus = true } = {}) {
    if (!openThreadId) return;
    const was = openThreadId;
    openThreadId = null;
    anchorSeq = null;
    pane.classList.remove('thread-open');
    panel.hidden = true;
    unmountChat();
    for (const summary of summaries.values()) summary.button.setAttribute('aria-expanded', 'false');
    if (focus) (summaries.get(was)?.button ?? chat).focus?.({ preventScroll: true });
  }

  function paint() {
    const row = threadDoc();
    if (!row || !threadChat) return;
    const topic = host.topicName(row.thread.sessionId);
    where.textContent = topicLabel(topic);
    alsoText.textContent = `Also send to ${topicLabel(topic)}`;
    recipients.update({ ...host.recipientState(row), mode: threadMode, replyModes: false });
  }

  // One summary per threaded message, kept between paints so focus and hover survive.
  function summaryFor(row) {
    let summary = summaries.get(row._id);
    if (!summary) {
      const button = el('button', 'thread-summary');
      button.type = 'button';
      button.setAttribute('aria-controls', 'thread-panel');
      button.setAttribute('aria-expanded', 'false');
      const faces = el('span', 'thread-summary-faces');
      faces.setAttribute('aria-hidden', 'true');
      const count = el('strong', 'thread-summary-count');
      const meta = el('span', 'thread-summary-meta');
      button.append(faces, count, meta);
      button.addEventListener('click', () => (openThreadId === row._id ? hide() : show(row._id)));
      summary = { id: row._id, button, faces, count, meta };
      summaries.set(row._id, summary);
    }
    const stats = row.thread;
    const names = (stats.repliers ?? []).map((id) => row.participants?.find((participant) => participant.id === id)?.displayName
      ?? id.replace(/^m:/, '')).filter(Boolean);
    summary.faces.replaceChildren(...names.slice(0, 3).map((name) => el('span', 'thread-summary-face', Array.from(name)[0] ?? '?')));
    const replies = Number(stats.replies ?? 0);
    const working = BUSY.has(row.phase);
    summary.count.textContent = replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'Thread';
    summary.meta.textContent = [
      names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : ''),
      working ? 'Working…' : row.phase === 'awaiting' ? 'Waiting for approval' : (stats.lastReplyAt ? host.timeAgo(stats.lastReplyAt) : ''),
    ].filter(Boolean).join(' · ');
    summary.button.dataset.state = working ? 'working' : row.phase === 'awaiting' ? 'waiting' : 'idle';
    summary.button.setAttribute('aria-label', `${summary.count.textContent} in thread${names.length ? `, ${names.join(', ')}` : ''}${working ? ', working' : ''}. Open thread`);
    return summary.button;
  }

  // Summaries for the open chat, and the Mission's threads kept subscribed so Mission health can count them.
  const computation = Tracker.autorun(() => {
    const chatId = host.currentChat();
    const missionId = host.currentMission();
    const owners = chatId ? host.conversationIds(missionId) : [];
    const wanted = new Set(owners);
    Tracker.nonreactive(() => {
      for (const [id, handle] of threadSubscriptions) if (!wanted.has(id)) { handle.stop(); threadSubscriptions.delete(id); }
      for (const id of wanted) if (!threadSubscriptions.has(id)) threadSubscriptions.set(id, workspace.subscribeThreads(id));
    });
    const rows = chatId ? workspace.threads(chatId).fetch() : [];
    const live = new Set(rows.map((row) => row._id));
    for (const id of summaries.keys()) if (!live.has(id)) summaries.delete(id);
    setChatTimelineSource(chat, 'threads', rows.filter((row) => row.thread?.messageId).map((row) => ({
      id: `thread-${row._id}`,
      createdAt: row.createdAt ?? new Date(0),
      afterMessageId: row.thread.messageId,
      element: summaryFor(row),
    })));
    Tracker.nonreactive(() => {
      if (openThreadId && !live.has(openThreadId)) hide({ focus: false });
      else if (openThreadId) paint();
    });
  });

  chat.threadable = true;
  chat.addEventListener('agent-chat:open-thread', async (event) => {
    const { sessionId, messageId } = event.detail ?? {};
    if (!sessionId || !messageId) return;
    try {
      const threadId = await workspace.thread(sessionId, messageId);
      // The new thread may not have reached this page yet.
      const deadline = Date.now() + 5000;
      while (!threadDoc(threadId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      show(threadId);
    } catch (error) {
      host.toast(error?.reason ?? error?.message ?? 'Could not open the thread.', 'error');
    }
  });
  close.addEventListener('click', () => hide());
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // Escape in the composer with text in it is the composer's; anywhere else it closes the thread.
    if (event.composedPath().some((node) => node instanceof HTMLTextAreaElement && node.value)) return;
    event.preventDefault();
    hide();
  });

  return {
    open: async (threadId) => {
      const deadline = Date.now() + 5000;
      while (!threadDoc(threadId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      show(threadId);
    },
    close: hide,
    isOpen: () => Boolean(openThreadId),
    current: () => openThreadId,
    /** The open chat changed: a thread belongs to its topic, so it closes. */
    chatChanged(chatId) {
      if (openThreadId && threadDoc()?.thread?.sessionId !== chatId) hide({ focus: false });
    },
    dispose() { computation.stop(); for (const handle of threadSubscriptions.values()) handle.stop(); unmountChat(); panel.remove(); },
  };
}
