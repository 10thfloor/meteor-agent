import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isClient) describe('Constellation decision work navigation', function () {
  let createNavigator;
  before(async () => { ({ createDecisionWorkNavigator: createNavigator } = await import('../client/decision-work-navigation')); });

  function fixture({ root = true, loaded = true } = {}) {
    const calls = [];
    let current = 'mission'; let visible = true;
    const rows = [
      { _id: 'sys:mission:approved', sessionId: 'mission', seq: 2, role: 'system' },
      { _id: 'result', sessionId: 'mission', seq: 3, role: 'assistant', content: 'Billing', from: { participant: 'm:orchestrator' } },
    ];
    const chat = { isConnected: true, sessionId: loaded ? 'mission' : null,
      agentInstance: { messages: () => ({ fetch: () => rows }) },
      revealMessage: (id) => { calls.push(['reveal', id]); return true; } };
    const dialog = { open: true, querySelector: () => chat };
    const host = {
      isMission: () => root, currentMission: () => current, rootChat: () => chat,
      showMission: () => { visible = true; calls.push(['show']); },
      openMission: (id) => { current = id; visible = true; calls.push(['open', id]); },
      missionVisible: () => visible,
      openChild: (...args) => { calls.push(['child', ...args]); return dialog; },
      toast: (...args) => calls.push(['toast', ...args]),
    };
    return { calls, rows, chat, dialog, host,
      moveTo: (id) => { current = id; }, hide: () => { visible = false; },
      open: createNavigator(host, { timeoutMs: 60, pollMs: 5 }),
    };
  }
  const continuation = { key: 'approved', status: 'completed' };

  it('reveals current mission work without reopening the mission or resetting its composer', async () => {
    const f = fixture();
    assert.isTrue(await f.open('mission', 'orchestrator', continuation));
    assert.deepEqual(f.calls, [['show'], ['reveal', 'result']]);
  });

  it('opens another root mission before revealing its exact continuation', async () => {
    const f = fixture(); f.moveTo('other');
    assert.isTrue(await f.open('mission', 'orchestrator', continuation));
    assert.deepEqual(f.calls, [['open', 'mission'], ['reveal', 'result']]);
  });

  it('keeps specialist work in a transcript dialog', async () => {
    const f = fixture({ root: false });
    f.rows[1].from.participant = 'm:researcher';
    assert.isTrue(await f.open('mission', 'researcher', continuation));
    assert.deepEqual(f.calls, [['child', 'mission', 'researcher'], ['reveal', 'result']]);
  });

  it('waits for transcript hydration and does not jump before the session matches', async () => {
    const f = fixture({ loaded: false });
    const pending = f.open('mission', 'orchestrator', continuation);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.isFalse(f.calls.some(([name]) => name === 'reveal'));
    f.chat.sessionId = 'mission';
    assert.isTrue(await pending);
  });

  it('cancels delayed navigation when the user leaves or opens another work item', async () => {
    const f = fixture({ loaded: false });
    const pending = f.open('mission', 'orchestrator', continuation);
    f.hide(); f.chat.sessionId = 'mission';
    assert.isFalse(await pending);
    assert.isFalse(f.calls.some(([name]) => name === 'reveal' || name === 'toast'));
    f.chat.sessionId = null;
    const first = f.open('mission', 'orchestrator', continuation);
    const second = f.open('mission', 'orchestrator', continuation);
    f.chat.sessionId = 'mission';
    assert.isFalse(await first);
    assert.isTrue(await second);
    assert.lengthOf(f.calls.filter(([name]) => name === 'reveal'), 1);
  });

  it('explains unavailable work instead of jumping to an unrelated reply', async () => {
    const f = fixture(); f.rows.shift();
    assert.isFalse(await f.open('mission', 'orchestrator', continuation));
    assert.isFalse(f.calls.some(([name]) => name === 'reveal'));
    assert.include(f.calls.at(-1)[1], 'not available');
    assert.isFalse(await f.open('mission', 'orchestrator', { status: 'queued' }));
    assert.include(f.calls.at(-1)[1], 'cannot be located');
  });
});
