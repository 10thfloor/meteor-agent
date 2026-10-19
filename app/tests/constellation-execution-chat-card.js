import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

// Local presentation fixtures only: no subscriptions, credentials or provider
// operations. The controller owns those boundaries, not a transcript card.
if (Meteor.isClient) describe('Constellation code run chat cards', function () {
  let create; let format; let card; let data; let calls;
  const find = (name) => card.element.querySelector(`[data-code-chat="${name}"]`);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  before(async () => {
    ({ createExecutionChatCard: create, codeRunElapsed: format } = await import('../client/execution-chat-card'));
  });
  beforeEach(() => {
    calls = [];
    card = create({ onView: (id) => calls.push(['view', id]), onStop: (id) => calls.push(['stop', id]) });
    document.body.append(card.element);
    data = { _id: 'code-run-one', title: 'Check the quarterly totals', agentDisplayName: 'Signal', language: 'python',
      status: 'running', elapsedMs: 2300, connectionState: 'connected' };
    card.update(data);
  });
  afterEach(() => { card.dispose(); });

  it('shows a legible run summary, live stage and exact-run actions without technical output', async () => {
    card.update({ ...data, stdout: '{"internal":"stdout"}', stderr: '{"internal":"stderr"}',
      code: 'print("internal source")', error: { reason: '{"internal":"provider error"}' } });
    assert.equal(find('title').textContent, 'Check the quarterly totals');
    assert.equal(find('meta').textContent, 'Signal · Python · Code');
    assert.equal(find('state').textContent, 'Running in Sprites');
    assert.equal(find('time').textContent, '0:02');
    assert.equal(find('body').getAttribute('aria-busy'), 'true');
    assert.equal(card.element.dataset.animating, 'true');
    assert.equal(find('announcement').getAttribute('aria-live'), 'polite');
    assert.notInclude(card.element.textContent, 'internal');
    find('view').click(); find('stop').click(); await settle();
    assert.deepEqual(calls, [['view', 'code-run-one'], ['stop', 'code-run-one']]);
  });

  it('keeps focus and control nodes stable and never announces clock ticks', async () => {
    const button = find('view'); const title = find('title'); const state = find('state');
    const announcement = find('announcement');
    const mutations = [];
    const observer = new MutationObserver((changes) => mutations.push(...changes));
    observer.observe(announcement, { childList: true, characterData: true, subtree: true });
    button.focus();
    card.update({ ...data, elapsedMs: 12300 });
    await settle();
    assert.strictEqual(find('view'), button);
    assert.strictEqual(find('title'), title);
    assert.strictEqual(find('state'), state);
    assert.strictEqual(document.activeElement, button);
    assert.equal(find('time').textContent, '0:12');
    assert.isEmpty(mutations, 'elapsed time must not mutate a live announcement');
    card.update({ ...data, status: 'completed', elapsedMs: 15000 });
    await settle();
    assert.isNotEmpty(mutations, 'a terminal stage should announce');
    observer.disconnect();
  });

  it('distinguishes queuing, preparation and stopping without a fictional progress percentage', () => {
    card.update({ ...data, status: 'queued' });
    assert.equal(find('state').textContent, 'Waiting for environment');
    assert.equal(find('detail').textContent, 'Your code has not started yet.');
    assert.equal(card.element.dataset.animating, 'false');
    card.update({ ...data, status: 'preparing' });
    assert.equal(find('state').textContent, 'Preparing environment');
    assert.equal(card.element.dataset.animating, 'true');
    card.update({ ...data, status: 'stopping' });
    assert.equal(find('state').textContent, 'Stopping code');
    assert.include(find('detail').textContent, 'confirm the stop');
    assert.isTrue(find('stop').disabled);
    assert.isNull(card.element.querySelector('progress,[role="progressbar"],[aria-valuenow]'));
  });

  it('shows an unconfirmed state rather than pretending disconnected work is still running', () => {
    for (const connectionState of ['loading', 'reconnecting', 'unavailable']) {
      card.update({ ...data, connectionState, elapsedMs: null });
      assert.equal(card.element.dataset.state, 'unconfirmed');
      assert.equal(card.element.dataset.animating, 'false');
      assert.isTrue(find('time').hidden);
      assert.isTrue(find('stop').disabled);
      assert.notEqual(find('state').textContent, 'Running in Sprites');
      assert.isFalse(find('view').disabled);
    }
    assert.equal(find('state').textContent, 'Run status unavailable');
    card.update(data);
    assert.equal(find('state').textContent, 'Running in Sprites');
    assert.equal(card.element.dataset.animating, 'true');
    assert.isFalse(find('stop').disabled);
  });

  it('keeps terminal receipts compact with saved-file counts, not stdout or raw error payloads', () => {
    card.update({ ...data, status: 'completed', artifacts: [{ id: 'one', name: 'file.csv' }, { id: 'two' }, null], stdout: '{"amount":5050}' });
    assert.equal(find('state').textContent, 'Code finished');
    assert.equal(find('result').textContent, '2 files saved');
    assert.isTrue(find('stop').hidden);
    assert.equal(find('body').getAttribute('aria-busy'), 'false');
    assert.equal(card.element.dataset.animating, 'false');
    assert.notInclude(card.element.textContent, '5050');
    card.update({ ...data, status: 'failed', error: { reason: '{"secret":"provider trace"}' } });
    assert.equal(find('state').textContent, 'Code run failed');
    assert.include(find('detail').textContent, 'review the error');
    assert.notInclude(card.element.textContent, 'provider trace');
    card.update({ ...data, status: 'unknown' });
    assert.equal(find('state').textContent, 'Status unconfirmed');
    assert.include(find('detail').textContent, 'before starting again');
  });

  it('guards repeated stop clicks, reports failure safely and keeps the action usable afterwards', async () => {
    card.dispose();
    let rejectStop;
    card = create({ onView() {}, onStop: (id) => {
      calls.push(['stop', id]); return new Promise((resolve, reject) => { rejectStop = reject; });
    } });
    document.body.append(card.element); card.update(data);
    find('stop').click(); find('stop').click();
    assert.deepEqual(calls, [['stop', 'code-run-one']]);
    assert.equal(find('state').textContent, 'Stopping code');
    assert.isTrue(find('stop').disabled);
    rejectStop(new Error('private provider trace')); await settle();
    assert.isFalse(find('stop').disabled);
    assert.equal(find('error').getAttribute('role'), 'alert');
    assert.include(find('error').textContent, 'Could not request a stop');
    assert.notInclude(card.element.textContent, 'private provider trace');
  });

  it('reduces successful receipts to two lines while keeping failures and active work prominent', () => {
    card.element.style.width = '700px';
    const activeHeight = card.element.getBoundingClientRect().height;
    card.update({ ...data, status: 'completed', artifacts: [{ id: 'one' }] });
    assert.equal(card.element.dataset.compact, 'true');
    assert.isBelow(card.element.getBoundingClientRect().height, activeHeight - 20);
    assert.isAtLeast(find('view').getBoundingClientRect().height, 34);
    assert.equal(find('result').textContent, '1 file saved');
    card.update({ ...data, status: 'cancelled' });
    assert.equal(card.element.dataset.compact, 'true');
    card.update({ ...data, status: 'failed' });
    assert.equal(card.element.dataset.compact, 'false');
    assert.isFalse(find('detail').hidden);
    card.update(data);
    assert.equal(card.element.dataset.compact, 'false');
  });

  it('shows a controller-provided stop failure and clears it when the run finishes', () => {
    const actionError = 'Could not request a stop. Check the run before trying again.';
    card.update({ ...data, actionError });
    assert.isFalse(find('error').hidden);
    assert.equal(find('error').textContent, actionError);
    assert.equal(find('error').getAttribute('role'), 'alert');
    assert.isFalse(find('stop').disabled);
    card.update({ ...data, actionError, status: 'completed' });
    assert.isTrue(find('error').hidden);
    assert.equal(find('error').textContent, '');
    card.update({ ...data, actionError: '' });
    assert.isTrue(find('error').hidden);
  });

  it('retains document-level styling when rendered through the real agent-chat timeline slot', async () => {
    const { defineAgentChat } = await import('meteor/10thfloor:agent');
    const tag = 'constellation-code-card-style-test';
    defineAgentChat(tag);
    const host = document.createElement(tag);
    // No agent/session is bound: this fixture exercises only the DOM slot
    // contract and cannot create a session or issue a provider request.
    document.body.append(host);
    try {
      host.timelineItems = [{ id: 'code-card-style', createdAt: new Date(), element: card.element }];
      assert.strictEqual(card.element.parentElement, host, 'app-owned card remains in light DOM');
      assert.strictEqual(card.element.getRootNode(), document);
      assert.strictEqual(card.element.assignedSlot?.getRootNode(), host.shadowRoot);
      assert.equal(getComputedStyle(card.element).borderRadius, '13px');
      assert.equal(getComputedStyle(find('body')).display, 'flex');
      assert.equal(getComputedStyle(find('title')).fontSize, '15px');
      assert.equal(getComputedStyle(find('view')).minHeight, '34px');
    } finally { host.remove(); }
  });

  it('does not collapse or clip its actions in a bounded, overflowing chat transcript', async () => {
    const { defineAgentChat } = await import('meteor/10thfloor:agent');
    const tag = 'constellation-code-card-overflow-test';
    defineAgentChat(tag);
    const host = document.createElement(tag);
    host.style.cssText = 'position:fixed;left:24px;top:24px;width:620px;height:380px;z-index:2147483646;background:var(--ink);';
    const earlier = document.createElement('div');
    earlier.style.cssText = 'height:900px;min-height:900px;flex-shrink:0;';
    earlier.textContent = 'Earlier transcript content';
    document.body.append(host);
    try {
      card.update({ ...data, status: 'completed' });
      host.timelineItems = [
        { id: 'earlier-content', createdAt: new Date(0), element: earlier },
        { id: 'bounded-code-card', createdAt: new Date(1), element: card.element },
      ];
      const transcript = host.shadowRoot.querySelector('[part="messages"]');
      transcript.scrollTop = transcript.scrollHeight;
      await settle();
      const bounds = card.element.getBoundingClientRect();
      const body = find('body').getBoundingClientRect();
      const button = find('view'); const action = button.getBoundingClientRect();
      const viewport = transcript.getBoundingClientRect();
      assert.isAbove(transcript.scrollHeight, transcript.clientHeight);
      assert.equal(getComputedStyle(card.element).flexShrink, '0');
      assert.isAtLeast(bounds.height, body.height, 'card must enclose its body, not shrink to its borders');
      assert.isAbove(bounds.height, 60);
      assert.isAtLeast(action.top, bounds.top);
      assert.isAtMost(action.bottom, bounds.bottom);
      const x = action.left + action.width / 2; const y = action.top + action.height / 2;
      assert.isAbove(action.width, 0); assert.isAbove(action.height, 0);
      assert.isAtLeast(y, viewport.top); assert.isAtMost(y, viewport.bottom);
      let hit = document.elementFromPoint(x, y);
      if (hit === host) hit = host.shadowRoot.elementFromPoint(x, y);
      assert.isTrue(hit === button || button.contains(hit), 'View run must be hit-testable, not hidden by clipped card overflow');
      button.click(); await settle();
      assert.deepEqual(calls, [['view', 'code-run-one']]);
    } finally { host.remove(); }
  });

  it('moves focus to View run when a focused stop control disappears after completion', () => {
    find('stop').focus();
    card.update({ ...data, status: 'completed' });
    assert.strictEqual(document.activeElement, find('view'));
    assert.isTrue(find('stop').hidden);
  });

  it('honors readonly cards and disposes click handlers', async () => {
    card.update({ ...data, canStop: false });
    assert.isTrue(find('stop').hidden);
    const button = find('view');
    card.dispose(); button.click(); await settle();
    assert.isEmpty(calls);
  });

  it('escapes titles and agent names and formats elapsed time without invalid or negative values', () => {
    card.update({ ...data, title: '<img src=x onerror=alert(1)>', agentDisplayName: '<svg onload=alert(1)>' });
    assert.equal(find('title').textContent, '<img src=x onerror=alert(1)>');
    assert.isNull(find('title').querySelector('img'));
    assert.isNull(find('meta').querySelector('svg'));
    assert.equal(format(-50), '0:00');
    assert.equal(format(undefined), '0:00');
    assert.equal(format(Infinity), '0:00');
    assert.equal(format(61999), '1:01');
    assert.equal(format(3600000), '60:00');
  });
});
