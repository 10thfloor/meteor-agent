import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { defineAgentChat } from 'meteor/10thfloor:agent';

// Public composer APIs, using per-element read/write stand-ins. No server
// methods are called and no plan, transcript, or agent memory is created.
if (Meteor.isClient) describe('Constellation plan composer', function () {
  const tag = 'constellation-plan-composer-test';
  const part = (chat, token) => chat.shadowRoot.querySelector(`[part~="${token}"]`);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  const sources = () => ({
    '#': { kind: 'plan', actionable: true, emptyText: 'No matching plans.',
      list: [
        { handle: 'launch-review', name: 'Launch review', detail: 'Launch · Version 3' },
        { handle: 'release-review', name: 'Release review', detail: 'Release · Version 1' },
      ], handle: 'handle', label: 'name', detail: 'detail' },
    '@': { kind: 'agent', actionable: true,
      list: [{ handle: 'atlas', name: 'Atlas' }], handle: 'handle', label: 'name' },
  });
  let chat;
  let calls;
  let registerComposerContext;
  before(async () => {
    ({ registerComposerContext } = await import('../client/composer-context.js'));
    defineAgentChat(tag);
  });
  beforeEach(() => {
    calls = [];
    chat = document.createElement(tag);
    chat.setAttribute('agent', 'orchestrator');
    chat.setAttribute('session-id', `composer-fixture-${Random.id()}`);
    document.body.append(chat);
    const client = chat.agentInstance;
    client.messages = () => ({ fetch: () => [] });
    client.send = async (sessionId, text) => { calls.push({ mode: 'ask', sessionId, text }); };
    client.contribute = async (sessionId, text) => { calls.push({ mode: 'note', sessionId, text }); };
    chat.mentionSources = sources();
  });
  afterEach(() => chat.remove());

  const type = (text, caret = text.length) => {
    const input = part(chat, 'input');
    input.focus();
    input.value = text;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input'));
  };
  const submit = () => part(chat, 'composer').dispatchEvent(new Event('submit', {
    bubbles: true, cancelable: true,
  }));

  it('shares empty submissions across independent plan and file context lifecycles', () => {
    const plans = registerComposerContext(chat);
    const files = registerComposerContext(chat);
    assert.isFalse(chat.allowEmptySubmit);
    files.set(true);
    plans.set(false);
    assert.isTrue(chat.allowEmptySubmit, 'plan repaint cannot disable an uploaded-file message');
    plans.set(true);
    files.set(false);
    assert.isTrue(chat.allowEmptySubmit, 'removing files preserves selected plan context');
    files.dispose();
    assert.isTrue(chat.allowEmptySubmit);
    plans.dispose();
    assert.isFalse(chat.allowEmptySubmit, 'last disposal restores the original baseline');
    files.set(true);
    files.dispose();
    assert.isFalse(chat.allowEmptySubmit, 'late updates and repeated disposal are inert');
  });

  it('preserves an initial empty-submit baseline without leaking it between chat elements', () => {
    chat.allowEmptySubmit = true;
    const context = registerComposerContext(chat);
    context.set(false);
    assert.isTrue(chat.allowEmptySubmit);
    context.dispose();
    assert.isTrue(chat.allowEmptySubmit);
    chat.allowEmptySubmit = false;
    const later = registerComposerContext(chat);
    later.set(false);
    assert.isFalse(chat.allowEmptySubmit, 'a later lifecycle captures its own baseline');
    later.dispose();
    const otherChat = { allowEmptySubmit: false };
    const independent = registerComposerContext(otherChat);
    independent.set(true);
    assert.isFalse(chat.allowEmptySubmit);
    independent.dispose();
    assert.isFalse(otherChat.allowEmptySubmit);
  });

  it('routes explicitly selected recipients and captures the recipient before asynchronous completion', async () => {
    const receipts = [];
    let finish;
    chat.agentInstance.send = (sessionId, text, options) => {
      calls.push({ sessionId, text, options });
      return new Promise((resolve) => { finish = resolve; });
    };
    chat.addEventListener('agent-chat:submitted', (event) => receipts.push(event.detail));
    chat.recipient = 'm:operator';
    type('Please ask @atlas about this');
    submit();
    assert.deepEqual(calls, [{
      sessionId: chat.sessionId, text: 'Please ask @atlas about this', options: { to: 'm:operator' },
    }]);
    chat.recipient = 'm:researcher';
    finish();
    await settled();
    assert.equal(receipts[0].recipient, 'm:operator', 'receipt belongs to the issued send');
    assert.equal(chat.recipient, 'm:researcher', 'completion cannot undo a later selection');
    chat.composerMode = 'note';
    type('@operator Shared context only');
    submit();
    await settled();
    assert.equal(calls[1].mode, 'note');
    assert.notProperty(receipts[1], 'recipient', 'crew notes never wake a selected recipient');
  });

  it('names the selected recipient for screen readers without reconnecting or discarding the draft', () => {
    chat.agentInstance.session = () => ({ participants: [
      { id: 'm:operator', kind: 'model', agent: 'operator', displayName: 'Relay' },
    ] });
    const client = chat.agentInstance;
    type('Draft stays here');
    chat.recipient = 'm:operator';
    assert.equal(part(chat, 'input').getAttribute('aria-label'), 'Message Relay');
    assert.equal(part(chat, 'input').placeholder, 'Message Relay…');
    assert.equal(chat.draftText, 'Draft stays here');
    assert.strictEqual(chat.agentInstance, client);
    chat.recipient = 'm:removed';
    assert.equal(part(chat, 'input').getAttribute('aria-label'), 'Message unavailable agent');
    chat.composerMode = 'note';
    assert.equal(part(chat, 'input').getAttribute('aria-label'), 'Add a crew note');
    chat.composerMode = 'ask';
    chat.recipient = undefined;
    assert.equal(part(chat, 'input').getAttribute('aria-label'), 'Message the agent');
  });

  it('blocks unavailable-recipient sends without blocking Stop or approval controls', async () => {
    const client = chat.agentInstance;
    let phase = 'streaming';
    client.status = () => phase;
    client.session = () => ({ phase, participants: [], pending: phase === 'awaiting' ? {
      toolCallId: 'existing-approval', name: 'publish', args: {}, agent: 'orchestrator',
    } : undefined });
    chat.setAttribute('composer-disabled', 'true');
    chat.mentionSources = chat.mentionSources;
    assert.isTrue(part(chat, 'input').disabled);
    assert.isTrue(part(chat, 'send').disabled);
    assert.isFalse(part(chat, 'stop').hidden);
    assert.isFalse(part(chat, 'stop').disabled);
    chat.setDraft('Do not redirect this');
    await chat.submitDraft();
    assert.isEmpty(calls, 'programmatic submission cannot bypass the recipient guard');
    assert.equal(chat.draftText, 'Do not redirect this');
    phase = 'awaiting';
    chat.mentionSources = chat.mentionSources;
    assert.isFalse(part(chat, 'approval').hidden);
    assert.isFalse(part(chat, 'approve').disabled);
    assert.isFalse(part(chat, 'deny').disabled);
    chat.setAttribute('aria-disabled', 'true');
    assert.isTrue(part(chat, 'approve').disabled, 'mission writability still gates all actions');
    chat.removeAttribute('aria-disabled');
    chat.setAttribute('composer-disabled', 'false');
    assert.isFalse(part(chat, 'input').disabled);
    assert.isFalse(part(chat, 'send').disabled);
  });

  it('blocks incomplete-context sends while keeping the draft editable', async () => {
    chat.setAttribute('send-disabled', 'true');
    assert.isFalse(part(chat, 'input').disabled);
    assert.isTrue(part(chat, 'send').disabled);
    type('Continue writing while files upload.');
    submit();
    await chat.submitDraft();
    assert.isEmpty(calls, 'form and public submit APIs share the send guard');
    assert.equal(chat.draftText, 'Continue writing while files upload.');
    chat.removeAttribute('send-disabled');
    assert.isFalse(part(chat, 'send').disabled);
    await chat.submitDraft();
    assert.equal(calls[0].text, 'Continue writing while files upload.');
  });

  it('keeps recipient context in custom handlers and restores a failed draft for an explicit retry', async () => {
    const requests = [];
    const receipts = [];
    let reject;
    chat.submissionHandler = (request) => {
      requests.push(request);
      return new Promise((_resolve, fail) => { reject = fail; });
    };
    chat.addEventListener('agent-chat:submitted', (event) => receipts.push(event.detail));
    chat.recipient = 'm:operator';
    // Finish the mention token: submitting with an open typeahead deliberately
    // accepts its suggestion rather than invoking the submission handler.
    type('Review #launch-review ');
    submit();
    chat.recipient = 'm:researcher';
    reject(new Error('Relay is unavailable. Choose another recipient.'));
    await settled();
    assert.equal(requests[0].recipient, 'm:operator');
    assert.equal(chat.draftText, 'Review #launch-review');
    assert.equal(chat.recipient, 'm:researcher');
    assert.isEmpty(receipts);
    chat.submissionHandler = async (request) => { requests.push(request); };
    submit();
    await settled();
    assert.equal(requests[1].recipient, 'm:researcher');
    assert.equal(receipts[0].recipient, 'm:researcher');
    chat.composerMode = 'note';
    type('Keep #launch-review as context');
    submit();
    await settled();
    assert.notProperty(requests[2], 'recipient', 'custom crew notes also omit the recipient');
  });

  it('shows delivered handoffs with the sender, recipient, and readable message', () => {
    chat.agentInstance.messages = () => ({ fetch: () => [{
      _id: 'handoff-receipt', sessionId: chat.sessionId, seq: 1,
      role: 'tool', kind: 'handoff', from: { participant: 'm:orchestrator', name: 'orchestrator' },
      to: 'm:operator', content: '{"ok":true,"agent":"operator"}',
      displayContent: 'Sent to Relay', transcriptContent: 'Please **review** this. Payload: {"internal":true}',
    }] });
    chat.agentInstance.session = () => ({ participants: [
      { kind: 'model', agent: 'orchestrator', displayName: 'Atlas' },
      { kind: 'model', agent: 'operator', displayName: 'Relay' },
    ] });
    chat.mentionSources = chat.mentionSources;
    assert.equal(part(chat, 'handoff-route').textContent, 'Atlas → Relay');
    assert.equal(part(chat, 'handoff-status').textContent, 'Sent');
    assert.include(part(chat, 'handoff-message').textContent, 'Please review this.');
    assert.isNotNull(part(chat, 'handoff-message').querySelector('strong'));
    assert.notInclude(part(chat, 'handoff').textContent, '"ok"');
    assert.notInclude(part(chat, 'handoff').textContent, '"internal"');
    chat.setAttribute('verbosity', 'debug');
    assert.include(part(chat, 'tool-content').textContent, '"ok"');
  });

  it('intercepts one submission, preserves busy state, and reports completion', async () => {
    let finish;
    const intercepted = [];
    const receipts = [];
    chat.submissionHandler = (request) => {
      intercepted.push(request);
      return new Promise((resolve) => { finish = resolve; });
    };
    chat.addEventListener('agent-chat:submitted', (event) => receipts.push(event.detail));
    type('Run #launch-review ');
    submit();
    assert.deepEqual(intercepted, [{ sessionId: chat.sessionId, text: 'Run #launch-review', mode: 'ask' }]);
    assert.isEmpty(calls, 'intercepted submission does not fall through to agent.send');
    assert.isTrue(part(chat, 'input').disabled);
    assert.isTrue(part(chat, 'send').disabled);
    assert.strictEqual(part(chat, 'send').dataset.loading, 'true');
    assert.strictEqual(part(chat, 'composer').getAttribute('aria-busy'), 'true');
    submit();
    assert.lengthOf(intercepted, 1, 'programmatic duplicate is also guarded');
    finish();
    await settled();
    assert.isFalse(part(chat, 'input').disabled);
    assert.strictEqual(part(chat, 'input').value, '');
    assert.deepEqual(receipts, [{ sessionId: chat.sessionId, mode: 'ask' }]);
  });

  it('restores a rejected draft and never turns a crew note into an ask', async () => {
    const intercepted = [];
    chat.composerMode = 'note';
    chat.submissionHandler = async (request) => {
      intercepted.push(request);
      throw new Error('Plan changed. Review its saved version first.');
    };
    type('Discuss #launch-review ');
    submit();
    await settled();
    assert.strictEqual(intercepted[0].mode, 'note');
    assert.isEmpty(calls);
    assert.strictEqual(part(chat, 'input').value, 'Discuss #launch-review');
    assert.include(part(chat, 'messages').textContent, 'Plan changed.');
    assert.isFalse(part(chat, 'send').disabled);
    chat.submissionHandler = null;
    submit();
    await settled();
    assert.deepEqual(calls, [{ sessionId: chat.sessionId, text: 'Discuss #launch-review', mode: 'note' }]);
  });

  it('inserts at the saved caret after an external picker takes focus without sending', () => {
    const selected = [];
    chat.addEventListener('agent-chat:mention-selected', (event) => selected.push(event.detail));
    type('Review before Friday', 7);
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    try {
      assert.isTrue(chat.insertMention('#', 'launch-review'));
      assert.strictEqual(part(chat, 'input').value, 'Review #launch-review before Friday');
      assert.strictEqual(chat.shadowRoot.activeElement, part(chat, 'input'));
      assert.deepEqual(selected, [{ prefix: '#', handle: 'launch-review', kind: 'plan' }]);
      assert.isEmpty(calls);
      assert.isFalse(chat.insertMention('#', 'unavailable-plan'));
      assert.lengthOf(selected, 1);
    } finally { other.remove(); }
  });

  it('preserves the insertion point through a native modal closing and restoring focus', () => {
    type('Compare  before launch', 8);
    const dialog = document.createElement('dialog');
    const search = document.createElement('input');
    dialog.append(search);
    document.body.append(dialog);
    try {
      dialog.showModal();
      search.focus();
      dialog.close();
      // Native focus restoration is allowed to change the live selection;
      // insertion must use the deliberate selection captured before the picker.
      part(chat, 'input').setSelectionRange(0, 0);
      assert.isTrue(chat.insertMention('#', 'launch-review'));
      assert.strictEqual(part(chat, 'input').value, 'Compare #launch-review  before launch');
      assert.isEmpty(calls);
    } finally { dialog.remove(); }
  });

  it('opens # from an app action, supports arrow selection, and only sends on the next Enter', async () => {
    const selected = [];
    chat.addEventListener('agent-chat:mention-selected', (event) => selected.push(event.detail));
    type('Run ');
    assert.isTrue(chat.openMentions('#'));
    assert.strictEqual(part(chat, 'input').value, 'Run #');
    assert.isFalse(part(chat, 'typeahead').hidden);
    assert.lengthOf(chat.shadowRoot.querySelectorAll('[part~="suggestion"]'), 2);
    assert.include(part(chat, 'typeahead').textContent, 'Launch · Version 3');
    part(chat, 'input').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    assert.strictEqual(part(chat, 'input').getAttribute('aria-activedescendant'), 'agent-chat-suggestion-1');
    // Native Enter submits this single-line form; the first submit completes.
    submit();
    assert.strictEqual(part(chat, 'input').value, 'Run #release-review ');
    assert.isTrue(part(chat, 'typeahead').hidden);
    assert.isEmpty(calls);
    assert.deepEqual(selected, [{ prefix: '#', handle: 'release-review', kind: 'plan' }]);
    submit();
    await settled();
    assert.strictEqual(calls[0].text, 'Run #release-review');
  });

  it('supports semantic suggestion clicks without double insertion after pointer selection', () => {
    type('Run #');
    part(chat, 'suggestion').click();
    assert.strictEqual(part(chat, 'input').value, 'Run #launch-review ');
    assert.isEmpty(calls);
    type('Run #');
    const row = part(chat, 'suggestion');
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    row.click();
    assert.strictEqual(part(chat, 'input').value, 'Run #launch-review ', 'mousedown and click insert only once');
    assert.isEmpty(calls);
  });

  it('renders clickable plan references but leaves leading @ routing unchanged', () => {
    chat.agentInstance.messages = () => ({ fetch: () => [{
      _id: 'mention-fixture', role: 'user', content: '@atlas review #launch-review', seq: 1,
    }] });
    chat.mentionSources = chat.mentionSources;
    const mentioned = [];
    chat.addEventListener('agent-chat:mention', (event) => {
      assert.isTrue(event.composed);
      assert.isTrue(event.bubbles);
      mentioned.push(event.detail);
    });
    const plan = chat.shadowRoot.querySelector('button[part~="plan"]');
    assert.ok(plan);
    assert.strictEqual(plan.type, 'button');
    assert.strictEqual(plan.getAttribute('aria-label'), 'View plan: Launch review');
    plan.focus();
    assert.strictEqual(chat.shadowRoot.activeElement, plan);
    plan.click();
    assert.deepEqual(mentioned, [{ prefix: '#', handle: 'launch-review', kind: 'plan' }]);
    const agent = chat.shadowRoot.querySelector('[part~="agent"]');
    assert.strictEqual(agent.tagName, 'SPAN');
    assert.include(agent.getAttribute('part').split(' '), 'addressed');
    assert.isEmpty(calls, 'opening a plan cannot wake an agent');
  });

  it('shows empty feedback and removes stale choices when the source changes', () => {
    type('Run #');
    assert.isFalse(part(chat, 'typeahead').hidden);
    chat.mentionSources = { '#': { ...sources()['#'], list: [], emptyText: 'Loading plans…' } };
    assert.isNull(part(chat, 'suggestion'));
    assert.strictEqual(part(chat, 'suggestion-empty').textContent, 'Loading plans…');
    assert.isFalse(part(chat, 'typeahead').hidden);
    assert.isNull(part(chat, 'input').getAttribute('aria-activedescendant'));
    part(chat, 'input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    assert.isTrue(part(chat, 'typeahead').hidden);
    assert.isEmpty(calls);
  });

  it('rechecks a suggestion at selection time and inherits raw source reference metadata', () => {
    let plans = [{ handle: 'launch-review', label: 'Launch review' }];
    chat.mentionSources = { '#': { kind: 'plan', actionable: true,
      search: () => plans, lookup: (handle) => plans.find((plan) => plan.handle === handle) } };
    const selected = [];
    chat.addEventListener('agent-chat:mention-selected', (event) => selected.push(event.detail));
    type('Run #');
    plans = [];
    submit();
    assert.strictEqual(part(chat, 'input').value, 'Run #', 'revoked choice is not inserted');
    assert.isEmpty(selected);
    assert.isEmpty(calls, 'a stale choice is not interpreted as a Send');
    plans = [{ handle: 'launch-review', label: 'Launch review' }];
    assert.isTrue(chat.insertMention('#', 'launch-review'));
    assert.deepEqual(selected, [{ prefix: '#', handle: 'launch-review', kind: 'plan' }]);
    chat.agentInstance.messages = () => ({ fetch: () => [{
      _id: 'raw-mention-fixture', role: 'user', content: '#launch-review', seq: 1,
    }] });
    chat.mentionSources = chat.mentionSources;
    assert.ok(chat.shadowRoot.querySelector('button[part~="plan"]'));
  });

  it('does not restore an old failed submission or picker into a different session', async () => {
    let fail;
    const receipts = [];
    chat.addEventListener('agent-chat:submitted', (event) => receipts.push(event.detail));
    chat.submissionHandler = () => new Promise((_resolve, reject) => { fail = reject; });
    type('Run #launch-review ');
    submit();
    chat.setAttribute('session-id', `other-composer-fixture-${Random.id()}`);
    await settled();
    type('New mission draft');
    fail(new Error('Old request failed'));
    await settled();
    assert.strictEqual(part(chat, 'input').value, 'New mission draft');
    assert.notInclude(part(chat, 'messages').textContent, 'Old request failed');
    assert.isTrue(part(chat, 'typeahead').hidden);
    assert.isFalse(part(chat, 'input').disabled);
    assert.isEmpty(receipts);
  });

  it('honors host-disabled state immediately and after a pending write settles', async () => {
    let finish;
    let approvals = 0;
    chat.agentInstance.session = () => ({ phase: 'awaiting', pending: {
      toolCallId: 'approval-fixture', name: 'publish_brief', args: {}, agent: 'orchestrator',
    } });
    chat.agentInstance.approve = async () => { approvals += 1; };
    chat.mentionSources = chat.mentionSources;
    assert.isFalse(part(chat, 'approve').disabled);
    chat.submissionHandler = () => new Promise((resolve) => { finish = resolve; });
    type('Run #launch-review ');
    submit();
    chat.setAttribute('aria-disabled', 'true');
    assert.isTrue(part(chat, 'input').disabled);
    assert.isTrue(part(chat, 'approve').disabled);
    assert.isTrue(part(chat, 'deny').disabled);
    assert.isTrue(part(chat, 'deny-guidance').disabled);
    // Direct dispatch bypasses the native disabled-button click guard.
    part(chat, 'approve').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.strictEqual(approvals, 0);
    assert.isFalse(chat.insertMention('#', 'launch-review'));
    finish();
    await settled();
    assert.isTrue(part(chat, 'input').disabled, 'settling the write cannot unlock a paused mission');
    assert.isTrue(part(chat, 'send').disabled);
    chat.setAttribute('aria-disabled', 'false');
    assert.isFalse(part(chat, 'input').disabled);
    assert.isFalse(part(chat, 'send').disabled);
    assert.isFalse(part(chat, 'approve').disabled);
    assert.strictEqual(chat.sessionId, chat.getAttribute('session-id'), 'changing host state does not reattach');
  });

  it('exposes app activity and composer controls without placing them inside the transcript', () => {
    for (const name of ['activity', 'composer-header', 'composer-toolbar', 'composer-actions']) {
      const node = document.createElement('div');
      node.slot = name;
      chat.append(node);
      const slot = chat.shadowRoot.querySelector(`slot[name="${name}"]`);
      assert.deepEqual(slot.assignedElements(), [node]);
      assert.isFalse(part(chat, 'messages').contains(slot));
    }
  });

  it('exposes draft editing, focused selection, and clear/restore notifications', async () => {
    const changes = [];
    chat.addEventListener('agent-chat:draft-change', (event) => changes.push(event.detail));
    chat.setAttribute('multiline', '');
    chat.setDraft('First line\nSecond line', { selectionStart: 6, selectionEnd: 10, focus: true });
    assert.strictEqual(chat.draftText, 'First line\nSecond line');
    assert.strictEqual(part(chat, 'input').selectionStart, 6);
    assert.strictEqual(part(chat, 'input').selectionEnd, 10);
    assert.strictEqual(chat.shadowRoot.activeElement, part(chat, 'input'));
    assert.deepEqual(changes.at(-1), { text: chat.draftText, sessionId: chat.sessionId });
    chat.submissionHandler = async () => { throw new Error('Draft remains available'); };
    await chat.submitDraft();
    assert.deepEqual(changes.slice(-2).map((change) => change.text), ['', 'First line\nSecond line']);
    assert.strictEqual(chat.draftText, 'First line\nSecond line');
    chat.draftText = 'Updated draft';
    assert.strictEqual(part(chat, 'input').value, 'Updated draft');
    assert.strictEqual(changes.at(-1).text, 'Updated draft');
  });

  it('supports multiline Shift+Enter, sends on Enter, and leaves IME composition alone', async () => {
    chat.setAttribute('multiline', '');
    chat.setAttribute('composer-layout', 'panel');
    chat.setDraft('First\nSecond');
    const input = part(chat, 'input');
    assert.strictEqual(input.tagName, 'TEXTAREA');
    assert.strictEqual(input.rows, 2);
    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
    input.dispatchEvent(shiftEnter);
    assert.isFalse(shiftEnter.defaultPrevented, 'browser may insert a newline');
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true });
    input.dispatchEvent(composingEnter);
    assert.isFalse(composingEnter.defaultPrevented);
    assert.isEmpty(calls);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    input.dispatchEvent(enter);
    await settled();
    assert.isTrue(enter.defaultPrevented);
    assert.strictEqual(calls[0].text, 'First\nSecond');
    chat.setDraft(Array(12).fill('More lines').join('\n'));
    const style = getComputedStyle(input);
    const line = parseFloat(style.lineHeight);
    const insets = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    assert.isAtMost(parseFloat(input.style.height), line * 6 + insets + 1);
    assert.strictEqual(input.style.overflowY, 'auto');
  });

  it('allows a one-row minimum without losing multiline growth or the default two-row composer', () => {
    chat.setAttribute('multiline', '');
    chat.setAttribute('composer-layout', 'panel');
    chat.style.width = '480px';
    chat.setDraft('');
    const input = part(chat, 'input');
    const twoRowHeight = input.getBoundingClientRect().height;
    assert.equal(input.rows, 2, 'framework consumers retain the existing default');

    chat.style.setProperty('--agent-chat-input-min-rows', '1');
    chat.setDraft('');
    const oneRowHeight = input.getBoundingClientRect().height;
    assert.equal(input.rows, 1);
    assert.isBelow(oneRowHeight, twoRowHeight, 'an empty single-row composer is genuinely shorter');
    chat.setDraft('First line\nSecond line\nThird line');
    assert.isAbove(input.getBoundingClientRect().height, oneRowHeight, 'the draft expands with its contents');
    chat.setDraft(Array(12).fill('Another line').join('\n'));
    const style = getComputedStyle(input);
    const line = parseFloat(style.lineHeight);
    const insets = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    assert.isAtMost(input.getBoundingClientRect().height, line * 6 + insets + 1);
    assert.equal(input.style.overflowY, 'auto', 'long drafts scroll inside the bounded input');
    chat.setDraft('');
    assert.closeTo(input.getBoundingClientRect().height, oneRowHeight, 1, 'clearing a long draft restores compact height');
    chat.style.removeProperty('--agent-chat-input-min-rows');
    chat.setDraft('');
    assert.equal(input.rows, 2, 'removing the opt-in restores the framework default');
  });

  it('does not open a host picker or send while a mention is being composed with an IME', async () => {
    const queries = [];
    chat.addEventListener('agent-chat:mention-query', (event) => { queries.push(event.detail); event.preventDefault(); });
    const input = part(chat, 'input'); input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '#la'; input.setSelectionRange(3, 3);
    input.dispatchEvent(new InputEvent('input', { isComposing: true, data: '#la' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    assert.isEmpty(queries);
    assert.isEmpty(calls);
    assert.strictEqual(chat.shadowRoot.activeElement, input);
    input.dispatchEvent(new CompositionEvent('compositionend'));
    await settled();
    assert.strictEqual(queries.at(-1).query, 'la');
    assert.isEmpty(calls);
  });

  it('allows a host to replace # suggestions and attach a selected plan without a slug in the draft', () => {
    const queries = [];
    chat.addEventListener('agent-chat:mention-query', (event) => {
      if (event.detail.prefix !== '#') return;
      queries.push(event.detail); event.preventDefault();
    });
    type('Discuss #la');
    assert.deepEqual(queries[0].range, { start: 8, end: 11 });
    assert.strictEqual(queries[0].query, 'la');
    assert.isNumber(queries[0].rect.left);
    assert.isTrue(part(chat, 'typeahead').hidden);
    assert.strictEqual(chat.draftText, 'Discuss #la');
    const selected = [];
    chat.addEventListener('agent-chat:mention-selected', (event) => selected.push(event.detail));
    chat.addEventListener('agent-chat:mention-select', (event) => {
      assert.isTrue(event.cancelable);
      event.preventDefault();
      const { start, end } = event.detail.range;
      chat.setDraft(chat.draftText.slice(0, start) + chat.draftText.slice(end), { selectionStart: start, focus: true });
    });
    assert.isTrue(chat.insertMention('#', 'launch-review'));
    assert.strictEqual(chat.draftText, 'Discuss ');
    assert.isEmpty(selected, 'default post-insertion event is not emitted for host-owned attachment selection');
    assert.isEmpty(calls);
  });

  it('requires a host handler for attachment-only submission and supports explicit submit labels', async () => {
    chat.allowEmptySubmit = true;
    await chat.submitDraft();
    assert.isEmpty(calls, 'empty Agent sends remain blocked');
    const submitted = [];
    chat.submissionHandler = async (request) => { submitted.push(request); };
    chat.setAttribute('submit-label', 'Run plan');
    assert.strictEqual(part(chat, 'send').textContent, 'Run plan');
    await chat.submitDraft();
    assert.deepEqual(submitted, [{ sessionId: chat.sessionId, mode: 'ask', text: '' }]);
    assert.strictEqual(part(chat, 'send').textContent, 'Run plan');
  });

  it('places composer context above the text and its toolbar/actions below inside the form', () => {
    chat.setAttribute('composer-layout', 'panel');
    const context = document.createElement('div'); context.slot = 'composer-context'; chat.append(context);
    const root = chat.shadowRoot;
    const composer = part(chat, 'composer');
    const input = part(chat, 'input');
    const contextSlot = root.querySelector('slot[name="composer-context"]');
    const headerSlot = root.querySelector('slot[name="composer-header"]');
    const toolbar = root.querySelector('slot[name="composer-toolbar"]');
    assert.deepEqual(contextSlot.assignedElements(), [context]);
    assert.isTrue(composer.contains(contextSlot));
    assert.isTrue(composer.contains(headerSlot));
    assert.isTrue(!!(headerSlot.compareDocumentPosition(contextSlot) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.isTrue(composer.contains(toolbar));
    assert.isTrue(!!(contextSlot.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.isTrue(!!(input.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.strictEqual(getComputedStyle(composer).flexDirection, 'column');
    assert.strictEqual(getComputedStyle(part(chat, 'composer-footer')).display, 'flex');
  });

  it('interleaves light-DOM run cards by time or message anchor and preserves focused card state', () => {
    const rows = [
      { _id: 'first', role: 'user', content: 'First message', createdAt: new Date(1000), seq: 1 },
      { _id: 'second', role: 'assistant', content: 'Second message', createdAt: new Date(3000), seq: 2 },
    ];
    chat.agentInstance.messages = () => ({ fetch: () => rows });
    const card = document.createElement('article');
    const toggle = document.createElement('button'); toggle.textContent = 'Expanded run';
    card.append(toggle); card.dataset.expanded = 'true';
    const anchored = document.createElement('article'); anchored.textContent = 'Anchored run';
    chat.timelineItems = [
      { id: 'later-anchor', createdAt: new Date(9000), afterMessageId: 'first', element: anchored },
      { id: 'middle', createdAt: new Date(2000), element: card },
    ];
    const order = () => [...part(chat, 'messages').children].map((node) =>
      node.tagName === 'SLOT' ? node.assignedElements()[0].textContent : node.textContent);
    assert.deepEqual(order(), ['First message', 'Expanded run', 'Anchored run', 'Second message']);
    assert.strictEqual(card.parentElement, chat, 'host CSS still applies to its light-DOM card');
    assert.isNull(card.closest('[part~="message"]'), 'a card is not attributed as an assistant message');
    toggle.focus();
    const assigned = card.assignedSlot;
    rows[1].content = 'Second message updated';
    chat.mentionSources = chat.mentionSources;
    assert.strictEqual(card.assignedSlot, assigned);
    assert.strictEqual(document.activeElement, toggle, 'stream paints retain focused card controls');
    assert.strictEqual(card.dataset.expanded, 'true');
    assert.strictEqual(order().at(-1), 'Second message updated');
    chat.timelineItems = [];
    assert.isFalse(card.isConnected);
    assert.isFalse(anchored.isConnected);
    assert.lengthOf(part(chat, 'messages').querySelectorAll('slot'), 0);
  });

  it('keeps reader scroll position when a new timeline card arrives and clears cards on scope change', async () => {
    chat.style.cssText = 'position:fixed;top:0;left:0;width:480px;height:300px;';
    const items = Array.from({ length: 12 }, (_, index) => {
      const element = document.createElement('article');
      element.textContent = `Run ${index}`; element.style.minHeight = '100px';
      return { id: `run-${index}`, createdAt: index * 1000, element };
    });
    chat.timelineItems = items;
    const messages = part(chat, 'messages');
    messages.scrollTop = 30;
    const element = document.createElement('article'); element.textContent = 'New run';
    chat.timelineItems = [...items, { id: 'new-run', createdAt: 15_000, element }];
    assert.closeTo(messages.scrollTop, 30, 1);
    assert.isFalse(part(chat, 'new-messages').hidden);
    chat.setAttribute('session-id', `other-timeline-${Random.id()}`);
    await settled();
    assert.isEmpty(chat.timelineItems);
    assert.isFalse(element.isConnected);
  });
});
