import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isClient) describe('Constellation work handoff context', function () {
  this.timeout(10_000);
  let dialog; let container; let controller; let response; let requests; let mission;
  const waitUntil = async (test) => {
    const deadline = Date.now() + 4000;
    while (!test()) { if (Date.now() > deadline) assert.fail('Handoff context did not settle'); await new Promise((resolve) => setTimeout(resolve, 20)); }
  };
  const detail = (sessionId = 'work-a', result = { state: 'returned', text: 'The evidence favors preventing data loss.' }) => ({
    sessionId, agent: 'researcher', displayName: 'Signal', source: 'delegation',
    requester: { agent: 'orchestrator', displayName: 'Atlas' }, assignment: 'Group the feedback by theme.', result,
  });
  beforeEach(async () => {
    const { createWorkTranscriptContext } = await import('../client/agent-work-transcript');
    mission = 'mission-a'; requests = [];
    dialog = document.createElement('dialog'); container = document.createElement('section');
    dialog.append(container); document.body.append(dialog); dialog.showModal();
    response = async ({ sessionId }) => detail(sessionId);
    controller = createWorkTranscriptContext({ dialog, container, missionId: () => mission,
      read: (input) => { requests.push(input); return response(input); } });
  });
  afterEach(() => {
    controller.stop(); dialog.close();
    // The app's top-layer toast host can be temporarily reparented into this
    // fixture by native-dialog recovery. It does not belong to the fixture.
    const toastRegion = dialog.querySelector('#toast-region');
    if (toastRegion) document.body.append(toastRegion);
    dialog.remove();
  });

  it('separates the assignment from the result actually returned and preserves open details', async () => {
    controller.show('work-a');
    await waitUntil(() => container.querySelector('[data-handoff="assignment"]'));
    assert.include(container.textContent, 'Assignment from Atlas');
    assert.include(container.textContent, 'Result returned to Atlas');
    assert.deepEqual(requests[0], { missionId: 'mission-a', sessionId: 'work-a' });
    const assignment = container.querySelector('[data-handoff="assignment"]'); assignment.open = true;
    assignment.querySelector('summary').focus(); controller.refresh();
    await waitUntil(() => requests.length === 2);
    assert.isTrue(container.querySelector('[data-handoff="assignment"]').open);
    assert.strictEqual(document.activeElement.closest('[data-handoff]').dataset.handoff, 'assignment');
  });

  it('keeps waiting and failed receipts distinct from a completed result', async () => {
    response = async () => detail('work-a', { state: 'awaiting', text: 'Atlas received an approval request, not a completed result.' });
    controller.show('work-a');
    await waitUntil(() => container.textContent.includes('Waiting notice sent'));
    assert.notInclude(container.textContent, 'Result returned');
    response = async () => ({ ...detail('work-a', { state: 'failed', text: 'The plan step failed.' }), source: 'plan', requester: { displayName: 'Feedback review' } });
    controller.refresh();
    await waitUntil(() => container.textContent.includes('Failure reported to plan'));
    assert.include(container.textContent, 'Assignment from Feedback review');
  });

  it('ignores a late response after switching to another specialist or closing', async () => {
    let resolveFirst;
    response = ({ sessionId }) => sessionId === 'work-a' ? new Promise((resolve) => { resolveFirst = resolve; }) : Promise.resolve(detail(sessionId));
    controller.show('work-a'); await waitUntil(() => resolveFirst);
    controller.show('work-b'); await waitUntil(() => container.textContent.includes('Result returned'));
    resolveFirst({ ...detail('work-a'), assignment: 'Stale assignment must not replace the current one.' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.notInclude(container.textContent, 'Stale assignment');
    controller.stop(); dialog.close();
    assert.strictEqual(container.textContent, '');
  });

  it('keeps untrusted text inert and offers recovery without exposing raw errors', async () => {
    response = async () => { throw new Error('secret-provider-body'); };
    controller.show('work-a'); await waitUntil(() => container.querySelector('button'));
    assert.notInclude(container.textContent, 'secret-provider-body');
    response = async () => ({ ...detail(), assignment: '<img src=x onerror=alert(1)> Please review.' });
    container.querySelector('button').click();
    await waitUntil(() => container.querySelector('details'));
    assert.isNull(container.querySelector('img'));
    assert.include(container.textContent, '<img src=x');
  });
});

if (Meteor.isClient) describe('Constellation delegation entry points', function () {
  this.timeout(20_000);
  before(async () => {
    const deadline = Date.now() + 15000;
    while (!document.querySelector('#crew-list [data-crew-action="work"]')) {
      if (Date.now() > deadline) assert.fail('Mission crew did not initialize');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  it('provides separate work and settings actions without nesting buttons', () => {
    const rows = [...document.querySelectorAll('#crew-list .crew-card[data-config-id]')];
    assert.isAtLeast(rows.length, 1);
    for (const row of rows) {
      assert.strictEqual(row.tagName, 'DIV');
      assert.strictEqual(row.querySelector('[data-crew-action="work"]').textContent, 'View work');
      assert.match(row.querySelector('[data-crew-action="settings"]').getAttribute('aria-label'), /settings$/);
      assert.isNull(row.querySelector('button button'));
    }
  });
  it('centers View work with the status and settings controls for short, long, and left crew rows', async () => {
    const source = document.querySelector('#crew-list .crew-card[data-config-id]');
    assert.ok(source, 'clone a real rendered crew row with both actions');
    const mount = document.createElement('div');
    mount.className = 'crew-list';
    mount.style.cssText = 'position:fixed;left:16px;top:16px;width:288px;z-index:99999;background:#151817;';
    document.body.append(mount);
    try {
      for (const fixture of [
        { name: 'Signal', role: 'Research and analysis', state: 'ready', width: 288 },
        { name: 'An exceptionally long specialist display name',
          role: 'Reviewing the evidence and preparing the detailed mission report', state: 'working', width: 261 },
        { name: 'A specialist who previously worked on this mission',
          role: 'Left · not on this mission', state: 'left', width: 261 },
      ]) {
        const row = source.cloneNode(true);
        row.classList.remove('active'); row.dataset.agentState = fixture.state;
        row.querySelector('.crew-copy strong').textContent = fixture.name;
        const role = row.querySelector('.crew-secondary > span') ?? row.querySelector('.crew-copy > span');
        role.textContent = fixture.role;
        row.querySelector('.crew-state').dataset.agentState = fixture.state;
        row.querySelector('.crew-avatar').dataset.agentState = fixture.state;
        mount.style.width = `${fixture.width}px`;
        mount.replaceChildren(row);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const work = row.querySelector('[data-crew-action="work"]');
        const state = row.querySelector('.crew-state');
        const settings = row.querySelector('[data-crew-action="settings"]');
        const bounds = row.getBoundingClientRect();
        assert.isAbove(bounds.height, 0, 'the independent fixture must have a visible layout');
        assert.strictEqual(work.parentElement, row, 'work aligns in the crew row, outside its secondary copy');
        const center = (element) => {
          const rect = element.getBoundingClientRect();
          assert.isAbove(rect.width, 0);
          assert.isAtLeast(rect.left, bounds.left);
          assert.isAtMost(rect.right, bounds.right + 1);
          return rect.top + rect.height / 2;
        };
        assert.closeTo(center(work), center(state), 1, `${fixture.state}: work and status share a horizontal centerline`);
        assert.closeTo(center(work), center(settings), 1, `${fixture.state}: work and settings share a horizontal centerline`);
        assert.closeTo(center(work), bounds.top + bounds.height / 2, 1, `${fixture.state}: actions center vertically in the row`);
        assert.isAtMost(work.getBoundingClientRect().right, state.getBoundingClientRect().left);
        assert.isAtMost(state.getBoundingClientRect().right, settings.getBoundingClientRect().left);
      }
    } finally {
      mount.remove();
    }
  });
  it('keeps complete history reachable outside the short activity feed', () => {
    const history = document.getElementById('view-all-agent-work');
    assert.include(history.textContent, 'View all agent work');
    assert.strictEqual(history.getAttribute('aria-controls'), 'agent-work-dialog');
    assert.isFalse(document.getElementById('activity-feed').contains(history));
  });
});
