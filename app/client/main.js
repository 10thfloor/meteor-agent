import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Agent } from 'meteor/10thfloor:agent';

// Plain DOM + Tracker, no framework: `messages()` is a real minimongo cursor,
// so one autorun re-rendering from `.fetch()` is the entire data layer. The
// same cursor drops into React via useTracker or Blaze via a helper unchanged.
const Demo = new Agent('demo');

const el = (id) => document.getElementById(id);

function renderMessage(m) {
  const row = document.createElement('div');
  row.className = `msg ${m.role}${m.streaming ? ' streaming' : ''}`;
  if (m.role === 'note') {
    row.textContent =
      m.kind === 'approval'
        ? `${m.timedOut ? 'Timed out' : m.approved ? 'Approved' : 'Denied'}`
          + `${m.reason ? ` — ${m.reason}` : ''}`
        : m.kind === 'compaction'
          ? '· earlier conversation compacted ·'
          : m.error?.reason ?? m.kind;
    return row;
  }
  if (m.role === 'tool') {
    row.textContent = `⚙ ${m.content}`;
    return row;
  }
  row.textContent = (m.truncatedHead ? '…' : '') + (m.content ?? '');
  if (m.toolCalls?.length) {
    const call = document.createElement('span');
    call.className = 'calls';
    call.textContent = m.toolCalls.map((c) => ` → ${c.name}(${JSON.stringify(c.args)})`).join('');
    row.appendChild(call);
  }
  return row;
}

Meteor.startup(async () => {
  const sessionId = await Demo.start({ title: 'demo chat' });
  Demo.subscribe(sessionId);

  Tracker.autorun(() => {
    const messages = Demo.messages(sessionId).fetch();
    const box = el('messages');
    box.replaceChildren(...messages.map(renderMessage));
    box.scrollTop = box.scrollHeight;

    const phase = Demo.status(sessionId);
    el('phase').textContent = phase;
    el('phase').dataset.phase = phase;

    const ask = Demo.pending(sessionId);
    el('approval').hidden = !ask || !!ask.verdict;
    if (ask && !ask.verdict) {
      el('approval-text').textContent =
        `The agent wants to run ${ask.name}(${JSON.stringify(ask.args)})`;
    }
  });

  el('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = el('input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await Demo.send(sessionId, text);
  });
  el('stop').addEventListener('click', () => Demo.interrupt(sessionId));
  el('approve').addEventListener('click', () => Demo.approve(sessionId));
  el('deny').addEventListener('click', () => Demo.deny(sessionId, 'denied from the demo UI'));
});
