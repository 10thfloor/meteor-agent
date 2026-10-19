import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isClient) describe('Mission work navigation', function () {
  let create; let root; let navigation; let changes;
  const button = (tab) => root.querySelector(`[data-mission-work-tab="${tab}"]`);
  before(async () => { ({ initializeMissionWorkNavigation: create } = await import('../client/mission-work-navigation')); });
  beforeEach(() => {
    root = document.createElement('section');
    root.innerHTML = `<nav role="tablist">${['chat', 'files', 'runs', 'services'].map((tab) => `<button type="button" role="tab" data-mission-work-tab="${tab}">${tab}</button>`).join('')}</nav>${['chat', 'files', 'runs', 'services'].map((tab) => `<section data-mission-work-panel="${tab}"><input value="draft"></section>`).join('')}`;
    document.body.append(root); changes = [];
    navigation = create({ root, onChange: (context) => changes.push(context) });
  });
  afterEach(() => { navigation.dispose(); root.remove(); });
  it('disables work without a mission, keeps the chat mounted and remembers each mission’s tab', () => {
    assert.isTrue(button('files').disabled);
    navigation.setMission('one');
    const input = root.querySelector('input'); input.value = 'Unsent note';
    button('files').click();
    assert.isTrue(root.querySelector('[data-mission-work-panel="chat"]').hidden);
    assert.equal(button('files').getAttribute('aria-selected'), 'true');
    navigation.setMission('two'); assert.equal(navigation.activeTab, 'chat');
    navigation.show('runs');
    navigation.setMission('one'); assert.equal(navigation.activeTab, 'files');
    assert.strictEqual(root.querySelector('input'), input); assert.equal(input.value, 'Unsent note');
    navigation.show('chat'); assert.isFalse(root.querySelector('[data-mission-work-panel="chat"]').hidden);
  });
  it('suspends work offscreen and restores the selected view without duplicate navigation', () => {
    navigation.setMission('one'); navigation.show('services');
    changes.length = 0;
    navigation.setVisible(false); navigation.setVisible(false);
    assert.lengthOf(changes, 1); assert.equal(changes[0].tab, 'chat');
    assert.equal(navigation.activeTab, 'services');
    navigation.setVisible(true); assert.equal(changes[1].tab, 'services');
    navigation.show('services'); assert.lengthOf(changes, 2);
    navigation.show('files', { attachmentId: 'file-one' });
    assert.deepEqual(changes[2], { missionId: 'one', tab: 'files', options: { attachmentId: 'file-one' } });
  });
  it('supports arrow and end-key navigation with a single tabbable tab', () => {
    navigation.setMission('one'); button('chat').focus();
    button('chat').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.strictEqual(document.activeElement, button('files'));
    assert.equal(button('files').tabIndex, 0); assert.equal(button('chat').tabIndex, -1);
    button('files').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(navigation.activeTab, 'services');
    button('services').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(navigation.activeTab, 'chat');
  });
  it('reveals decision work in Chat when another mission remembers its Files tab', async () => {
    const { createDecisionWorkNavigator } = await import('../client/decision-work-navigation');
    let currentMission = 'one'; let revealed; const notices = [];
    navigation.setMission('one'); navigation.show('files');
    currentMission = 'two'; navigation.setMission('two'); navigation.show('services');
    const draft = root.querySelector('input'); draft.value = 'Unsent mission note';
    const chat = { isConnected: true, get sessionId() { return currentMission; },
      agentInstance: { messages: () => ({ fetch: () => [
        { _id: 'sys:one:decision-key', sessionId: 'one', role: 'system', seq: 1 },
        { _id: 'exact-reply', sessionId: 'one', role: 'assistant', seq: 2, content: 'Finished the decision.' },
      ] }) },
      revealMessage: (id) => { revealed = id; return navigation.activeTab === 'chat'; } };
    const navigateToChat = (id = currentMission) => {
      currentMission = id; navigation.setMission(id);
      navigation.show('chat', undefined, { focus: true });
    };
    const openWork = createDecisionWorkNavigator({
      isMission: () => true, currentMission: () => currentMission,
      openMission: navigateToChat, showMission: navigateToChat,
      missionVisible: () => navigation.activeTab === 'chat', rootChat: () => chat,
      toast: (message) => notices.push(message),
    }, { timeoutMs: 100, pollMs: 1 });
    assert.isTrue(await openWork('one', 'orchestrator', { key: 'decision-key', status: 'completed' }));
    assert.equal(currentMission, 'one'); assert.equal(navigation.activeTab, 'chat'); assert.equal(revealed, 'exact-reply');
    assert.isFalse(root.querySelector('[data-mission-work-panel="chat"]').hidden);
    assert.strictEqual(document.activeElement, button('chat'));
    assert.equal(draft.value, 'Unsent mission note'); assert.isEmpty(notices);
  });
});
