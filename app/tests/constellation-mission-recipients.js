import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { defineAgentChat } from 'meteor/10thfloor:agent';

if (Meteor.isClient) describe('Mission chat recipients', function () {
  let chat, controls, initialize, state, sent, stored, modes;
  const tag = 'constellation-recipient-test';
  const roster = () => [
    { id: 'm:orchestrator', agent: 'orchestrator', displayName: 'Atlas', kind: 'model' },
    { id: 'm:operator', agent: 'operator', displayName: 'Relay', kind: 'model' },
    { id: 'm:researcher', agent: 'researcher', displayName: 'Signal', kind: 'model' },
  ];
  const update = (patch = {}) => { state = { ...state, ...patch }; controls.update(state); };
  const option = (id) => [...controls.menu.querySelectorAll('[data-recipient-choice]')].find((item) => item.dataset.recipientChoice === id);
  const key = (target, value) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const initializeControls = () => initialize({ chat,
    storage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    onModeChange: (mode) => { modes.push(mode); update({ mode }); },
  });
  before(async () => { defineAgentChat(tag); ({ initializeMissionRecipients: initialize } = await import('../client/mission-recipients')); });
  beforeEach(() => {
    chat = document.createElement(tag); chat.setAttribute('agent', 'orchestrator');
    chat.setAttribute('session-id', `recipient-test-${Random.id()}`); chat.setAttribute('multiline', '');
    document.body.append(chat);
    sent = []; stored = new Map(); modes = [];
    state = { session: { _id: chat.sessionId, agent: 'orchestrator', participants: roster() },
      primary: { label: 'Atlas', role: 'Orchestrator' }, crew: [{ agent: 'operator', role: 'Operations' }, { agent: 'researcher', role: 'Research' }],
      userId: 'owner', mode: 'ask', writable: true, status: 'active' };
    chat.agentInstance.session = () => state.session;
    chat.agentInstance.messages = () => ({ fetch: () => [] });
    chat.agentInstance.send = async (...args) => { sent.push({ kind: 'send', args }); };
    chat.agentInstance.contribute = async (...args) => { sent.push({ kind: 'note', args }); };
    controls = initializeControls();
    update();
  });
  afterEach(() => { controls.dispose(); chat.remove(); });
  it('combines recipients and crew notes in one above-input menu with functional sharing guidance', () => {
    assert.equal(controls.control.slot, 'composer-header');
    assert.include(controls.button.textContent, 'Ask Atlas');
    assert.equal(controls.button.getAttribute('aria-haspopup'), 'menu');
    assert.isNull(controls.control.querySelector('select'));
    controls.button.click();
    assert.isTrue(controls.menu.matches(':popover-open'));
    assert.equal(controls.button.getAttribute('aria-expanded'), 'true');
    assert.equal(option('m:orchestrator').getAttribute('aria-checked'), 'true');
    assert.include(option('m:operator').textContent, 'Operations');
    assert.include(option('note').textContent, 'No agent reply');
    assert.include(controls.menu.textContent, 'Replies stay in this mission’s shared chat');
    update({ sharedChannels: 2 });
    assert.include(controls.menu.textContent, 'connected channels');
  });
  it('sends to Relay without invoking Atlas and retains Relay for follow-ups', async () => {
    controls.button.click(); option('m:operator').click();
    assert.equal(chat.recipient, 'm:operator'); assert.equal(chat.getAttribute('placeholder'), 'Write a message…');
    assert.include(controls.button.textContent, 'Ask Relay'); assert.isFalse(controls.menu.matches(':popover-open'));
    assert.equal(chat.getAttribute('submit-label'), 'Send');
    chat.setDraft('Hello'); await chat.submitDraft(); chat.setDraft('And one more thing'); await chat.submitDraft();
    assert.lengthOf(sent, 2); sent.forEach(({ args }) => assert.deepEqual(args[2], { to: 'm:operator' }));
    update(); assert.equal(option('m:operator').getAttribute('aria-checked'), 'true');
  });
  it('turns an autocomplete selection anywhere into an explicit recipient without losing prose', () => {
    chat.setDraft('Can you check @Rel');
    const event = new CustomEvent('agent-chat:mention-select', { cancelable: true, detail: { prefix: '@', handle: 'Relay', kind: 'agent', range: { start: 14, end: 18 } } });
    chat.dispatchEvent(event);
    assert.isTrue(event.defaultPrevented); assert.equal(chat.recipient, 'm:operator');
    assert.equal(chat.draftText, 'Can you check ');
  });
  it('supports typed leading friendly names but does not route inline or quoted mentions', () => {
    chat.setDraft('@relay please review'); assert.equal(chat.recipient, 'm:operator');
    chat.setDraft('Ask @Signal later'); assert.equal(chat.recipient, 'm:operator');
    chat.setDraft('"@Signal" is a name'); assert.equal(chat.recipient, 'm:operator');
    chat.setDraft('@Signal please review'); assert.equal(chat.recipient, 'm:researcher');
    controls.choose('operator'); chat.setDraft('@Signal please review this too'); assert.equal(chat.recipient, 'm:operator', 'explicit picker wins over unchanged leading text');
  });
  it('remembers recipients per account and mission and restores them after remount', () => {
    const first = state.session;
    controls.choose('operator');
    update({ session: { ...first, _id: 'another-mission' } }); assert.equal(chat.recipient, 'm:orchestrator');
    controls.choose('researcher'); update({ session: first }); assert.equal(chat.recipient, 'm:operator');
    controls.dispose(); controls = initializeControls();
    update(); assert.equal(chat.recipient, 'm:operator');
    update({ userId: 'other-owner' }); assert.equal(chat.recipient, 'm:orchestrator');
  });
  it('keeps crew notes non-waking even when they mention agents', async () => {
    controls.choose('operator'); controls.button.click(); option('note').click();
    assert.deepEqual(modes, ['note']); assert.equal(chat.composerMode, 'note');
    assert.isFalse(controls.control.hidden); assert.include(controls.button.textContent, 'Crew note'); assert.isUndefined(chat.recipient);
    assert.equal(chat.getAttribute('placeholder'), 'Write a crew note…'); assert.equal(chat.getAttribute('submit-label'), 'Post note');
    assert.isFalse(controls.control.querySelector('.mission-recipient-note-hint').hidden);
    chat.setDraft('@Signal hello');
    const event = new CustomEvent('agent-chat:mention-select', { cancelable: true, detail: { prefix: '@', handle: 'Signal', kind: 'agent' } });
    chat.dispatchEvent(event); assert.isFalse(event.defaultPrevented);
    await chat.submitDraft(); assert.equal(sent[0].kind, 'note');
    controls.choose('operator'); assert.equal(chat.recipient, 'm:operator'); assert.deepEqual(modes, ['note', 'ask']);
  });
  it('blocks an unavailable recipient instead of silently choosing Atlas', async () => {
    controls.choose('operator');
    update({ session: { ...state.session, participants: roster().filter((row) => row.agent !== 'operator') } });
    assert.equal(chat.recipient, 'm:operator'); assert.equal(chat.getAttribute('composer-disabled'), 'true');
    assert.equal(chat.getAttribute('aria-disabled'), 'false', 'only new submissions are blocked, not Stop or approval controls');
    assert.include(controls.notice.textContent, 'Relay is no longer'); assert.isFalse(controls.notice.hidden);
    chat.setDraft('Do not reroute'); await chat.submitDraft(); assert.isEmpty(sent);
    controls.choose('researcher'); assert.equal(chat.getAttribute('composer-disabled'), 'false'); assert.isTrue(controls.notice.hidden);
  });
  it('keeps blocked missions blocked and does not enable a send while selecting an agent', () => {
    update({ writable: false, status: 'paused' }); assert.isTrue(controls.button.disabled);
    assert.isFalse(controls.choose('operator')); assert.equal(chat.getAttribute('aria-disabled'), 'true');
    assert.isFalse(controls.chooseNote());
  });
  it('supports menu keyboard navigation and Escape without changing the draft', () => {
    chat.setDraft('Keep this unfinished thought.');
    controls.button.focus(); key(controls.button, 'ArrowDown');
    assert.strictEqual(document.activeElement, option('m:orchestrator'));
    // Agents, then Crew note, then where the answer goes.
    key(document.activeElement, 'End'); assert.strictEqual(document.activeElement, option('reply:thread'));
    key(document.activeElement, 'ArrowUp'); assert.strictEqual(document.activeElement, option('reply:chat'));
    key(document.activeElement, 'ArrowUp'); assert.strictEqual(document.activeElement, option('note'));
    key(document.activeElement, 'ArrowUp'); assert.strictEqual(document.activeElement, option('m:researcher'));
    key(document.activeElement, 'Home'); assert.strictEqual(document.activeElement, option('m:orchestrator'));
    key(document.activeElement, 'r'); assert.strictEqual(document.activeElement, option('m:operator'));
    key(document.activeElement, 'Escape');
    assert.isFalse(controls.menu.matches(':popover-open')); assert.equal(controls.button.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(document.activeElement, controls.button); assert.equal(chat.draftText, 'Keep this unfinished thought.');
    assert.equal(chat.recipient, 'm:orchestrator'); assert.isEmpty(sent);
  });
  it('closes the menu and blocks both route and mode changes while a submission is pending', async () => {
    let finish;
    chat.agentInstance.send = () => new Promise((resolve) => { finish = resolve; });
    controls.open(); chat.setDraft('Wait for this send');
    const pending = chat.submitDraft();
    await Promise.resolve();
    assert.isFalse(controls.menu.matches(':popover-open'));
    assert.isTrue(controls.button.disabled);
    assert.isFalse(controls.choose('operator')); assert.isFalse(controls.chooseNote());
    finish(); await pending; await Promise.resolve();
    assert.isFalse(controls.button.disabled);
  });
  it('keeps keyboard focus usable when the focused agent leaves an open menu', () => {
    controls.choose('operator'); controls.open();
    assert.strictEqual(document.activeElement, option('m:operator'));
    update({ session: { ...state.session, participants: roster().filter((row) => row.agent !== 'operator') } });
    assert.isTrue(controls.menu.matches(':popover-open'));
    assert.isTrue(option('m:operator').disabled);
    assert.strictEqual(document.activeElement, option('m:orchestrator'));
    assert.equal(chat.recipient, 'm:operator', 'moving keyboard focus does not silently change the recipient');
    key(document.activeElement, 'Escape'); assert.strictEqual(document.activeElement, controls.button);
  });
  it('closes a menu on mission changes and removes its portaled surface on disposal', () => {
    controls.open(); assert.isTrue(controls.menu.matches(':popover-open'));
    update({ session: { ...state.session, _id: 'another-mission' } });
    assert.isFalse(controls.menu.matches(':popover-open'));
    const menu = controls.menu; controls.open(); controls.dispose();
    assert.isFalse(menu.isConnected); assert.isFalse(controls.control.isConnected);
  });
  it('keeps a manual recipient choice when a failed draft is restored and edited', async () => {
    chat.setDraft('@Signal review'); controls.choose('operator');
    chat.agentInstance.send = async () => { throw new Error('Offline'); };
    await chat.submitDraft();
    assert.equal(chat.draftText, '@Signal review');
    chat.setDraft('@Signal review again'); assert.equal(chat.recipient, 'm:operator');
  });
});
