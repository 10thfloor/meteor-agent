import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { defineAgentChat } from 'meteor/10thfloor:agent';

if (Meteor.isClient) describe('Constellation chat message reveal', function () {
  let mount; let chat; let rows; let calls; let scrolls; let matchMedia;
  const part = (name) => chat.shadowRoot.querySelector(`[part~="${name}"]`);
  const rowFor = (id) => [...part('messages').children].find((row) => row.dataset.messageId === id);
  const paint = () => { chat.mentionSources = {}; };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fakeClient = () => {
    chat.agentInstance.session = () => ({ agent: 'orchestrator', phase: 'idle', participants: [] });
    chat.agentInstance.messages = () => ({ fetch: () => rows.map((row, index) => ({
      _id: `reveal-${index}`, seq: index, createdAt: new Date(2026, 8, 20, 12, index), ...row,
    })) });
    for (const method of ['send', 'contribute', 'start', 'subscribe']) {
      chat.agentInstance[method] = (...args) => { calls.push({ method, args }); return Promise.resolve(); };
    }
    paint();
  };
  before(() => defineAgentChat());
  beforeEach(() => {
    rows = Array.from({ length: 36 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `Message ${index}: the evidence for this mission remains available in the conversation.`,
    }));
    calls = []; scrolls = [];
    mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:16px;top:16px;width:440px;height:420px;z-index:99999;background:#101211;overflow:auto;';
    chat = document.createElement('agent-chat');
    chat.style.cssText = 'height:100%;min-height:0;';
    chat.setAttribute('agent', 'orchestrator');
    chat.setAttribute('session-id', `reveal-chat-${Random.id()}`);
    mount.append(chat); document.body.append(mount);
    fakeClient();
    const messages = part('messages');
    // Keep movement deterministic while checking the requested motion policy.
    messages.scrollTo = (options) => { scrolls.push(options); messages.scrollTop = options.top; };
    matchMedia = window.matchMedia;
    window.matchMedia = (query) => query === '(prefers-reduced-motion: reduce)'
      ? { matches: false } : matchMedia.call(window, query);
  });
  afterEach(() => {
    window.matchMedia = matchMedia;
    mount.remove();
  });

  it('reveals the exact stable message with local scrolling, keyboard focus, and a themeable highlight', () => {
    const id = 'message-"quoted"]#target';
    rows[10]._id = id; paint();
    const messages = part('messages');
    const target = rowFor(id);
    const page = { x: window.scrollX, y: window.scrollY, mount: mount.scrollTop };
    const focus = target.focus.bind(target); const focusOptions = [];
    target.focus = (options) => { focusOptions.push(options); focus(options); };
    target.scrollIntoView = () => assert.fail('revealing a message must not scroll page ancestors');
    assert.isAbove(messages.scrollHeight, messages.clientHeight, 'the fixture must overflow');
    const before = messages.scrollTop;
    assert.isTrue(chat.revealMessage(id));
    assert.isBelow(messages.scrollTop, before);
    assert.lengthOf(scrolls, 1);
    assert.equal(scrolls[0].behavior, 'smooth');
    assert.deepEqual(focusOptions, [{ preventScroll: true }]);
    assert.strictEqual(chat.shadowRoot.activeElement, target);
    assert.equal(target.tabIndex, -1);
    assert.isTrue(target.classList.contains('message-target'));
    assert.isTrue(target.part.contains('message-target'));
    assert.equal(getComputedStyle(target).outlineStyle, 'solid');
    const bounds = target.getBoundingClientRect(); const viewport = messages.getBoundingClientRect();
    assert.isAtLeast(bounds.top, viewport.top);
    assert.isAtMost(bounds.bottom, viewport.bottom);
    assert.deepEqual({ x: window.scrollX, y: window.scrollY, mount: mount.scrollTop }, page);
    assert.isEmpty(calls);
  });

  it('uses immediate scrolling with reduced motion and keeps structured content sanitized', () => {
    rows[10] = { role: 'assistant', content: '{"private":"RAW STRUCTURED DATA"}' }; paint();
    window.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' });
    assert.isTrue(chat.revealMessage('reveal-10'));
    assert.equal(scrolls[0].behavior, 'instant');
    assert.include(rowFor('reveal-10').textContent, 'Structured response hidden');
    assert.notInclude(rowFor('reveal-10').textContent, 'RAW STRUCTURED DATA');
    assert.isNull(chat.getAttribute('verbosity'));
    assert.isEmpty(calls);
  });

  it('returns false for missing, omitted, hidden, and host-owned rows without disturbing the current target', () => {
    rows[2] = { role: 'system', from: { participant: 's:decision-review', name: 'decision-review' }, content: 'PRIVATE CONTINUATION' };
    rows[3] = { role: 'note', kind: 'compaction', content: 'PRIVATE BOOKKEEPING' };
    paint();
    const impersonator = document.createElement('div');
    impersonator.className = 'message'; impersonator.dataset.messageId = 'host-row'; impersonator.textContent = 'Timeline card';
    chat.timelineItems = [{ id: 'host-card', createdAt: new Date(), element: impersonator }];
    assert.isTrue(chat.revealMessage('reveal-10'));
    const before = part('messages').scrollTop;
    for (const id of ['', null, undefined, 'missing', 'reveal-2', 'reveal-3', 'host-row']) {
      assert.isFalse(chat.revealMessage(id), `no reveal for ${String(id)}`);
    }
    rowFor('reveal-4').style.visibility = 'hidden';
    assert.isFalse(chat.revealMessage('reveal-4'));
    chat.hidden = true;
    assert.isFalse(chat.revealMessage('reveal-10'));
    chat.hidden = false;
    assert.lengthOf(scrolls, 1);
    assert.equal(part('messages').scrollTop, before);
    assert.strictEqual(part('message-target'), rowFor('reveal-10'));
    assert.isNull(chat.getAttribute('verbosity'));
    assert.isEmpty(calls);
  });

  it('preserves draft selection and the highlight through reactive row replacement without another reveal', () => {
    chat.composerMode = 'note';
    chat.setDraft('Keep this crew note draft.', { selectionStart: 5, selectionEnd: 9, focus: true });
    const draftEvents = [];
    chat.addEventListener('agent-chat:draft-change', (event) => draftEvents.push(event.detail));
    const client = chat.agentInstance; const sessionId = chat.sessionId;
    assert.isTrue(chat.revealMessage('reveal-10'));
    const original = rowFor('reveal-10');
    part('messages').scrollTop = 40;
    rows.push({ role: 'assistant', content: 'A new response arrived.', streaming: true });
    paint();
    const replacement = rowFor('reveal-10');
    assert.notStrictEqual(replacement, original);
    assert.strictEqual(part('message-target'), replacement);
    assert.strictEqual(chat.shadowRoot.activeElement, replacement);
    assert.closeTo(part('messages').scrollTop, 40, 1);
    assert.lengthOf(scrolls, 1, 'reactive rendering must not navigate again');
    assert.equal(chat.draftText, 'Keep this crew note draft.');
    assert.equal(chat.composerMode, 'note');
    assert.equal(part('input').selectionStart, 5);
    assert.equal(part('input').selectionEnd, 9);
    assert.strictEqual(chat.agentInstance, client);
    assert.equal(chat.sessionId, sessionId);
    assert.isEmpty(draftEvents);
    assert.isEmpty(calls);
    chat.focusComposer(); paint();
    assert.strictEqual(chat.shadowRoot.activeElement, part('input'), 'updates never steal composer focus');
  });

  it('restarts the temporary highlight for repeated reveals and expires it after reactive updates', async function () {
    this.timeout(6_000);
    assert.isTrue(chat.revealMessage('reveal-10'));
    assert.isTrue(chat.revealMessage('reveal-11'));
    assert.isFalse(rowFor('reveal-10').part.contains('message-target'));
    await pause(1_200);
    assert.isTrue(chat.revealMessage('reveal-11'));
    paint();
    await pause(1_000);
    assert.strictEqual(part('message-target'), rowFor('reveal-11'), 'the first reveal must not end the renewed highlight');
    assert.lengthOf(chat.shadowRoot.querySelectorAll('[part~="message-target"]'), 1);
    await pause(1_150);
    assert.isNull(part('message-target'));
    paint();
    assert.isNull(part('message-target'), 'expired targets must not reappear on updates');
    assert.isEmpty(calls);
  });

  it('clears the pending timer and target when the session changes or the element disconnects', async () => {
    const setTimeout = window.setTimeout; const clearTimeout = window.clearTimeout;
    const scheduled = []; const cleared = [];
    window.setTimeout = (callback, delay, ...args) => {
      const timer = setTimeout.call(window, callback, delay, ...args);
      if (delay === 2_000) scheduled.push(timer);
      return timer;
    };
    window.clearTimeout = (timer) => { cleared.push(timer); clearTimeout.call(window, timer); };
    try {
      assert.isTrue(chat.revealMessage('reveal-10'));
      const previousTimer = scheduled.at(-1);
      chat.setAttribute('session-id', `reveal-next-${Random.id()}`);
      assert.isNull(part('message-target'));
      assert.isFalse(chat.revealMessage('reveal-10'));
      assert.include(cleared, previousTimer, 'session changes cancel the highlight timer');
      await Promise.resolve();
      fakeClient();
      assert.isNull(part('message-target'), 'reused message IDs cannot carry the previous session target');
      assert.isTrue(chat.revealMessage('reveal-10'));
      const nextTimer = scheduled.at(-1);
      mount.remove();
      assert.include(cleared, nextTimer, 'disconnect cancels the next highlight timer');
      assert.isNull(part('message-target'));
      assert.isFalse(chat.revealMessage('reveal-10'));
    } finally {
      window.setTimeout = setTimeout;
      window.clearTimeout = clearTimeout;
    }
  });
});
