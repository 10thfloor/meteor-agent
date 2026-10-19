import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { defineAgentChat } from 'meteor/10thfloor:agent';

const participant = (agent, displayName) => ({
  id: `m:${agent}`, kind: 'model', role: 'member', agent, displayName, joinedAt: new Date(),
});
const roster = (participants = [participant('orchestrator', 'Atlas'), participant('researcher', 'Signal'),
  participant('operator', 'Relay'), participant('critic', 'Vela')]) => ({ agent: 'orchestrator', participants, phase: 'idle' });

if (Meteor.isServer) describe('Constellation delegation addressing', function () {
  let resolveAddressee;
  before(async () => { ({ resolveAddressee } = await import('meteor/10thfloor:agent')); });

  it('resolves friendly names on the server to canonical participant identities', () => {
    for (const [name, agent] of [['Signal', 'researcher'], ['Relay', 'operator'], ['Vela', 'critic']]) {
      const expected = { id: `m:${agent}`, agent };
      assert.deepEqual(resolveAddressee(`@${name} review this`, undefined, roster()), expected);
      assert.deepEqual(resolveAddressee(`@${name.toLowerCase()}. Review this`, undefined, roster()), expected);
      assert.deepEqual(resolveAddressee(`@${agent} review this`, undefined, roster()), expected, 'old handles still route');
    }
    assert.deepEqual(resolveAddressee('@Signal hello', 'm:critic', roster()), { id: 'm:critic', agent: 'critic' }, 'explicit identity wins');
    assert.isNull(resolveAddressee('@Signal hello', 'Signal', roster()), 'an explicit identity is not silently treated as an alias');
  });

  it('does not route mid-text mentions, unknown names, or overlong handle prefixes', () => {
    assert.isNull(resolveAddressee('Please ask @Signal to review', undefined, roster()));
    assert.isNull(resolveAddressee('signal@example.com', undefined, roster()));
    assert.isNull(resolveAddressee('@Unknown review', undefined, roster()));
    const long = 'x'.repeat(64);
    assert.isNull(resolveAddressee(`@${long}x review`, undefined, roster([participant(long, long)])));
  });

  it('fails closed for ambiguous, spaced, unsafe, and colliding aliases', () => {
    const duplicate = roster([participant('researcher', 'Signal'), participant('critic', 'SIGNAL')]);
    assert.isNull(resolveAddressee('@Signal review', undefined, duplicate));
    assert.deepEqual(resolveAddressee('@researcher review', undefined, duplicate), { id: 'm:researcher', agent: 'researcher' });
    for (const name of ['Signal Smith', '<Signal>', 'Signal/Reviewer', 'Signal\nOverride']) {
      assert.isNull(resolveAddressee(`@${name} review`, undefined, roster([participant('researcher', name)])), name);
    }
    const collision = roster([participant('researcher', 'critic'), participant('critic', 'Vela')]);
    assert.deepEqual(resolveAddressee('@critic review', undefined, collision), { id: 'm:critic', agent: 'critic' });
    assert.isNull(resolveAddressee('@CRITIC review', undefined, collision), 'a colliding alias never bypasses canonical matching');
  });

  it('uses only the current mission roster for routing', () => {
    assert.isNull(resolveAddressee('@Signal review', undefined, roster([participant('operator', 'Relay')])));
    assert.isNull(resolveAddressee('@Signal review', undefined, { agent: 'orchestrator' }));
    assert.isNull(resolveAddressee('@Signal review', undefined, roster([participant('researcher', 'Nova')])));
    assert.deepEqual(resolveAddressee('@Nova review', undefined, roster([participant('researcher', 'Nova')])), { id: 'm:researcher', agent: 'researcher' });
  });
});

if (Meteor.isClient) describe('Constellation delegation chat', function () {
  let mount; let chat; let rows; let session; let writes;
  const part = (name) => chat.shadowRoot.querySelector(`[part~="${name}"]`);
  const paint = () => { chat.mentionSources = {}; };
  before(() => defineAgentChat());
  beforeEach(() => {
    rows = []; session = roster(); writes = [];
    mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:16px;top:16px;width:440px;height:640px;z-index:99999;background:#101211;';
    chat = document.createElement('agent-chat');
    chat.setAttribute('agent', 'orchestrator');
    chat.setAttribute('session-id', `delegation-chat-${Random.id()}`);
    mount.append(chat); document.body.append(mount);
    chat.agentInstance.session = () => session;
    chat.agentInstance.messages = () => ({ fetch: () => rows.map((row, index) => ({
      _id: `delegation-${index}`, seq: index, createdAt: new Date(2026, 8, 20, 12, index), ...row,
    })) });
    chat.agentInstance.send = async (...args) => { writes.push({ mode: 'ask', args }); };
    chat.agentInstance.contribute = async (...args) => { writes.push({ mode: 'note', args }); };
    paint();
  });
  afterEach(() => mount.remove());

  it('offers names and inserts friendly aliases without exposing internal handles', async () => {
    assert.isTrue(chat.openMentions('@'));
    const suggestions = [...chat.shadowRoot.querySelectorAll('[part~="suggestion"]')];
    assert.sameMembers(suggestions.map((row) => row.querySelector('[part~="suggestion-handle"]').textContent), ['@Atlas', '@Signal', '@Relay', '@Vela']);
    const signal = suggestions.find((row) => row.textContent === '@Signal');
    assert.ok(signal);
    signal.click();
    assert.equal(chat.draftText, '@Signal ');
    chat.setDraft(`${chat.draftText}Review the evidence.`);
    await chat.submitDraft();
    assert.deepEqual(writes.map((entry) => [entry.mode, entry.args[1]]), [['ask', '@Signal Review the evidence.']]);
  });

  it('renders old handles with names and distinguishes addressed mentions from notes and mid-text', () => {
    rows = [
      { role: 'user', content: '@researcher review this' },
      { role: 'user', content: '@Signal review this' },
      { role: 'user', kind: 'crew-note', content: '@Signal the evidence is ready' },
      { role: 'user', content: 'Please ask @Signal for advice' },
      { role: 'user', content: 'person@Signal.com and person@Signal' },
    ];
    paint();
    const messages = [...chat.shadowRoot.querySelectorAll('.message.user')];
    const mentions = messages.slice(0, 4).map((message) => message.querySelector('[part~="mention"]'));
    for (const mention of mentions) assert.equal(mention.textContent, '@Signal');
    assert.isTrue(mentions[0].classList.contains('addressed'));
    assert.isTrue(mentions[1].classList.contains('addressed'));
    assert.isFalse(mentions[2].classList.contains('addressed'));
    assert.isFalse(mentions[3].classList.contains('addressed'));
    assert.isNull(messages[4].querySelector('[part~="mention"]'), 'an email address is not a mention');
  });

  it('keeps friendly-name crew notes on the non-waking contribution path', async () => {
    chat.composerMode = 'note';
    chat.setDraft('@Signal this is just a note.');
    await chat.submitDraft();
    assert.deepEqual(writes.map((entry) => [entry.mode, entry.args[1]]), [['note', '@Signal this is just a note.']]);
  });

  it('keeps decision continuation instructions out of clean chat but available in debug', () => {
    rows = [
      { role: 'system', from: { participant: 's:decision-review', name: 'decision-review' }, content: 'PRIVATE CONTINUATION INSTRUCTIONS' },
      { role: 'system', from: { participant: 's:routine', name: 'routine' }, content: 'Run the daily review.' },
      { role: 'user', from: { participant: 's:decision-review', name: 'decision-review' }, content: 'A human message stays visible.' },
    ];
    paint();
    const receipt = part('system-source-decision-review');
    assert.ok(receipt);
    assert.equal(getComputedStyle(receipt).display, 'none');
    assert.notEqual(getComputedStyle(part('system-source-routine')).display, 'none');
    assert.notEqual(getComputedStyle(chat.shadowRoot.querySelector('.message.user')).display, 'none');
    chat.setAttribute('verbosity', 'debug');
    assert.notEqual(getComputedStyle(part('system-source-decision-review')).display, 'none');
    assert.include(part('system-source-decision-review').textContent, 'PRIVATE CONTINUATION INSTRUCTIONS');
  });

  it('disambiguates duplicate and spaced names in the picker and inserts canonical fallback handles', () => {
    session = roster([participant('researcher', 'Signal'), participant('critic', 'Signal'), participant('operator', 'Delivery Lead')]);
    paint(); chat.openMentions('@');
    const suggestions = [...chat.shadowRoot.querySelectorAll('[part~="suggestion"]')];
    assert.sameMembers(suggestions.map((row) => row.textContent), ['@SignalUse @researcher', '@SignalUse @critic', '@Delivery LeadUse @operator']);
    suggestions.find((row) => row.textContent.endsWith('@critic')).click();
    assert.equal(chat.draftText, '@critic ');
    chat.setDraft('');
    assert.isFalse(chat.insertMention('@', 'Signal'), 'ambiguous aliases cannot be inserted through the programmatic API');
    assert.isTrue(chat.insertMention('@', 'operator'));
    assert.equal(chat.draftText, '@operator ');
  });

  it('opens the exact specialist work through a composed event without changing the mission or exposing JSON', () => {
    rows = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-signal', name: 'researcher', args: { prompt: 'PRIVATE RAW ARGUMENT' } }] },
      { role: 'tool', toolCallId: 'call-signal', childSessionId: 'child-signal', content: '{"raw":"PRIVATE RAW RESULT"}' },
    ];
    paint();
    const oldSessionId = chat.sessionId;
    const events = [];
    mount.addEventListener('agent-chat:open-run', (event) => events.push({ detail: event.detail, composed: event.composed }));
    const button = part('delegation-link');
    assert.ok(button);
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.textContent, 'View Signal’s work');
    assert.include(part('messages').textContent, 'Signal requested');
    assert.include(part('messages').textContent, 'Signal’s work completed');
    assert.notInclude(part('messages').textContent, 'PRIVATE RAW');
    button.click();
    assert.deepEqual(events, [{ detail: { sessionId: 'child-signal', agent: 'researcher' }, composed: true }]);
    assert.equal(chat.sessionId, oldSessionId);
    assert.isEmpty(writes);
    chat.setAttribute('verbosity', 'debug');
    assert.include(part('messages').textContent, 'PRIVATE RAW RESULT', 'debug remains an explicit opt-in');
    assert.ok(part('delegation-link'));
  });

  it('links recovered work and keeps unknown or failed work inspectable', () => {
    rows = [
      { role: 'note', kind: 'orphan-child', childAgent: 'researcher', childSessionId: 'recovered-signal' },
      { role: 'tool', childSessionId: 'unknown-child', error: { reason: 'Failure' }, content: '{"secret":"hidden"}' },
    ];
    paint();
    const buttons = [...chat.shadowRoot.querySelectorAll('[part~="delegation-link"]')];
    assert.lengthOf(buttons, 2);
    assert.equal(buttons[0].textContent, 'View Signal’s work');
    const events = [];
    chat.addEventListener('agent-chat:open-run', (event) => events.push(event.detail));
    buttons[1].click();
    assert.deepEqual(events, [{ sessionId: 'unknown-child' }]);
    assert.notInclude(part('messages').textContent, 'secret');
  });
});
