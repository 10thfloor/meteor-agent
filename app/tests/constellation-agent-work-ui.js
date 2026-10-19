import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

// Exercise the real DOM controller with an intercepted read-only transport.
// No work is launched and no persisted mission or provider data is changed.
if (Meteor.isClient) describe('Constellation Agent work UI', function () {
  this.timeout(15_000);
  let initializeAgentWork; let controller; let originalCall; let response; let mission; let calls; let child; let opened;
  const crew = [{ agent: 'orchestrator', displayName: 'Atlas' }, { agent: 'researcher', displayName: 'Signal' }, { agent: 'operator', displayName: 'Relay' }];
  const waitUntil = async (condition, message = 'the agent work interface did not update') => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) assert.fail(message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  const $ = (part) => controller.dialog.querySelector(`[data-work-${part}]`);
  const row = (id = 'work_1', patch = {}) => ({ sessionId: id, agent: 'researcher', displayName: 'Signal', status: 'completed', statusLabel: 'Completed',
    label: 'Group the evidence', assignmentPreview: 'Group the numbered feedback into themes.', createdAt: new Date('2026-09-20T10:00:00Z'),
    requester: { agent: 'orchestrator', displayName: 'Atlas' }, source: 'delegation', resultReturned: true, result: { state: 'returned' }, ...patch });
  const page = (items, nextCursor = null) => ({ items, nextCursor, agents: crew, refreshedAt: new Date('2026-09-20T10:01:00Z') });
  const change = (part, value) => { $(part).value = value; $(part).dispatchEvent(new Event('change', { bubbles: true })); };

  before(async () => {
    ({ initializeAgentWork } = await import('../client/agent-work'));
  });
  beforeEach(() => {
    mission = 'agent_work_ui_mission'; calls = []; opened = [];
    response = async () => page([row()]);
    originalCall = Meteor.callAsync;
    Meteor.callAsync = function agentWorkUiTransport(method, ...args) {
      if (method === 'constellation.agentWork.list') {
        calls.push(args[0]);
        return Promise.resolve().then(() => response(args[0]));
      }
      return originalCall.call(this, method, ...args);
    };
    child = document.createElement('dialog');
    child.innerHTML = '<button type="button">Close work</button>'; document.body.append(child);
    child.querySelector('button').addEventListener('click', () => child.close());
    controller = initializeAgentWork({
      id: `agent-work-test-${Random.id()}`, missionId: () => mission, missionTitle: () => 'Notes app improvement', crew: () => crew,
      openChild(sessionId, agent) { opened.push({ sessionId, agent }); child.showModal(); return child; },
    });
  });
  afterEach(() => {
    if (child.open) child.close();
    const toastRegion = child.querySelector('#toast-region');
    if (toastRegion) document.body.append(toastRegion);
    controller.dispose(); child.remove(); Meteor.callAsync = originalCall;
  });

  it('loads readable assignments and delegates from mission-scoped history', async () => {
    controller.open();
    await waitUntil(() => $('list').children.length === 1);
    assert.strictEqual(calls[0].missionId, mission);
    assert.include(controller.dialog.textContent, 'Notes app improvement');
    assert.include($('list').textContent, 'Signal');
    assert.include($('list').textContent, 'Assigned by Atlas');
    assert.include($('list').textContent, 'Group the numbered feedback');
    assert.notInclude($('list').textContent, 'researcher');
    assert.notInclude($('list').textContent, 'child session');
    const copy = $('list').querySelector('.agent-work-copy');
    assert.strictEqual(copy.querySelector('.agent-work-assignment').parentElement, copy);
    assert.strictEqual(copy.querySelector('.agent-work-meta').parentElement, copy);
    assert.lengthOf($('list').querySelector('.agent-work-row').children, 3, 'avatar, copy, and open action are the only grid items');
    $('list').querySelector('button').click();
    assert.deepEqual(opened, [{ sessionId: 'work_1', agent: 'researcher' }]);
    assert.isTrue(controller.dialog.open, 'history must remain beneath the transcript');
    assert.isTrue(child.open);
  });

  it('sends agent and status filters and clears both from an empty result', async () => {
    response = async () => page([]);
    controller.open({ agent: 'researcher' });
    await waitUntil(() => calls.length === 1 && !$('refresh').disabled);
    assert.strictEqual(calls[0].agent, 'researcher');
    change('status', 'failed');
    await waitUntil(() => calls.length === 2 && !$('refresh').disabled);
    assert.strictEqual(calls[1].status, 'failed');
    assert.include($('empty').textContent, 'No matching work');
    $('empty').querySelector('button').click();
    await waitUntil(() => calls.length === 3 && !$('refresh').disabled);
    assert.notProperty(calls[2], 'agent'); assert.notProperty(calls[2], 'status');
    assert.include($('empty').textContent, 'Ask Atlas to delegate');
  });

  it('loads older work without duplicates and retains named historical agents', async () => {
    response = async (args) => args.cursor
      ? { ...page([row(), row('work_old', { agent: 'retired_reviewer', displayName: 'Vela', requester: { agent: 'former_coordinator', displayName: 'Older Atlas' } })]), agents: [...crew, { agent: 'retired_reviewer', displayName: 'Vela' }] }
      : page([row()], 'older_work');
    controller.open();
    await waitUntil(() => !$('more').hidden);
    $('more').click();
    await waitUntil(() => $('list').children.length === 2);
    assert.strictEqual(calls[1].cursor, 'older_work');
    assert.include($('list').textContent, 'Vela');
    assert.include($('list').textContent, 'Assigned by Older Atlas');
    assert.ok([...$('agent').options].some((option) => option.value === 'retired_reviewer' && option.textContent === 'Vela'));
    assert.isTrue($('more').hidden);
  });

  it('offers older work when a bounded filtered page has no matching rows', async () => {
    response = async (args) => args.cursor ? page([row('older_match', { status: 'failed', statusLabel: 'Failed' })]) : page([], 'older_work');
    controller.open(); change('status', 'failed');
    await waitUntil(() => !$('more').hidden && !$('more').disabled);
    assert.include($('empty').textContent, 'No matches in the most recent work');
    assert.include($('empty').textContent, 'Load more to search older assignments.');
    $('more').click();
    await waitUntil(() => $('list').children.length === 1);
    assert.strictEqual($('list').children[0].dataset.workSession, 'older_match');
  });

  it('keeps filters, scroll position, and keyboard focus after closing a transcript', async () => {
    response = async () => page(Array.from({ length: 20 }, (_, index) => row(`work_${index}`)));
    controller.open({ agent: 'researcher' });
    change('status', 'completed');
    await waitUntil(() => $('list').children.length === 20);
    const control = $('list').children[12].querySelector('button');
    control.focus(); $('scroll').scrollTop = 400;
    const scroll = $('scroll').scrollTop;
    control.click();
    child.close();
    await waitUntil(() => document.activeElement === control);
    assert.strictEqual($('agent').value, 'researcher');
    assert.strictEqual($('status').value, 'completed');
    assert.strictEqual($('scroll').scrollTop, scroll);
    assert.isTrue(controller.dialog.open);
  });

  it('updates statuses in place without replacing a focused row', async () => {
    let state = 'working';
    response = async () => page([row('live_work', { status: state, statusLabel: state === 'working' ? 'Working' : 'Completed' })]);
    controller.open();
    await waitUntil(() => $('list').children.length === 1);
    const control = $('list').querySelector('button'); control.focus();
    state = 'completed'; await controller.refresh();
    assert.strictEqual($('list').querySelector('button'), control);
    assert.strictEqual(document.activeElement, control);
    assert.include(control.textContent, 'Completed');
  });

  it('returns focus to the matching crew action after its original row is replaced', async () => {
    const container = document.createElement('div');
    container.id = `agent-work-launcher-${Random.id()}`;
    container.innerHTML = '<div class="crew-card" data-agent="researcher"><button type="button" data-crew-action="work">View Signal’s work</button></div>';
    document.body.append(container);
    try {
      const original = container.querySelector('button'); original.focus();
      controller.open({ agent: 'researcher', control: original });
      await waitUntil(() => $('list').children.length === 1);
      const replacementRow = container.firstElementChild.cloneNode(true);
      container.replaceChildren(replacementRow);
      controller.dialog.close();
      await waitUntil(() => document.activeElement === replacementRow.querySelector('button'), 'focus did not return to the replaced crew action');
    } finally { container.remove(); }
  });

  it('announces loading, preserves work on refresh errors, and offers retry', async () => {
    let resolve;
    response = () => new Promise((accept) => { resolve = accept; });
    controller.open();
    await waitUntil(() => resolve);
    assert.ok($('empty').querySelector('.op-loading[role="status"]'));
    resolve(page([row()]));
    await waitUntil(() => $('list').children.length === 1);
    response = async () => { throw { reason: 'Connection interrupted.' }; };
    await controller.refresh();
    assert.strictEqual($('list').children.length, 1);
    assert.strictEqual($('notice').getAttribute('role'), 'alert');
    assert.include($('notice').textContent, 'Connection interrupted.');
    response = async () => page([row(), row('work_2')]);
    $('notice').querySelector('button').click();
    await waitUntil(() => $('list').children.length === 2);
    assert.strictEqual($('notice').textContent, '');
  });

  it('ignores late responses after the mission changes or the dialog closes', async () => {
    const pending = [];
    response = (args) => new Promise((resolve) => pending.push({ args, resolve }));
    controller.open(); await waitUntil(() => pending.length === 1);
    mission = 'a_different_mission'; controller.contextChanged();
    await waitUntil(() => pending.length === 2);
    pending[1].resolve(page([row('new_mission_work')]));
    await waitUntil(() => $('list').children.length === 1);
    pending[0].resolve(page([row('old_mission_work')])); await tick();
    assert.strictEqual($('list').children[0].dataset.workSession, 'new_mission_work');
    const refresh = controller.refresh(); await waitUntil(() => pending.length === 3);
    controller.dialog.close();
    pending[2].resolve(page([row('closed_dialog_work')])); await refresh;
    assert.strictEqual($('list').children[0].dataset.workSession, 'new_mission_work');
  });

  it('renders untrusted assignment text without markup and requires a mission', async () => {
    mission = null; controller.open(); await tick();
    assert.lengthOf(calls, 0);
    assert.include($('empty').textContent, 'Open a mission');
    mission = 'agent_work_ui_mission';
    response = async () => page([row('escaped_work', { assignmentPreview: '<img src=x onerror=alert(1)> & evidence' })]);
    controller.contextChanged();
    await waitUntil(() => $('list').children.length === 1);
    assert.isNull($('list').querySelector('img'));
    assert.include($('list').textContent, '<img src=x onerror=alert(1)>');
  });

  it('preserves the shared toast host when a dialog is disposed', async () => {
    const toastRegion = document.getElementById('toast-region');
    assert.ok(toastRegion, 'the app toast host must remain available');
    controller.open();
    await waitUntil(() => $('list').children.length === 1);
    controller.dialog.append(toastRegion);
    controller.dispose();
    assert.strictEqual(document.getElementById('toast-region'), toastRegion);
    assert.strictEqual(toastRegion.parentElement, document.body);
  });
});
