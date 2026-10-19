import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

if (Meteor.isClient) describe('Mission preflight', () => {
  let initialize; let root; let ui; let state; let calls; let enable; let dependency;
  const button = (name) => root.querySelector(`[data-action="${name}"]`);
  const refresh = () => { dependency.changed(); Tracker.flush(); };
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); Tracker.flush(); };
  before(async () => { ({ initializeMissionPreflight: initialize } = await import('../client/mission-preflight')); });
  beforeEach(() => {
    root = document.createElement('section'); document.body.append(root); calls = []; dependency = new Tracker.Dependency();
    state = { missionId: 'one', config: { objective: '', approvals: true, budget: { spend: 5 } }, crew: [{ agent: 'atlas' }],
      settings: { enabled: true, providerConfigured: true, connectionStatus: 'connected' }, environment: null, connected: true };
    enable = async (id) => { calls.push(['enable', id]); return { missionId: id, keepFiles: true, workspaceId: 'sprite', status: 'ready' }; };
    ui = initialize({ root, snapshot: () => { dependency.depend(); return state; }, enable: (id) => enable(id),
      ...Object.fromEntries(['openSettings', 'openCrew', 'openFiles', 'openConnection', 'openEnvironment'].map((name) => [name, (...args) => calls.push([name, ...args])])) });
  });
  afterEach(() => { ui.dispose(); root.remove(); });
  it('shows optional setup without provisioning or gating chat', () => {
    assert.include(root.textContent, 'Optional setup'); assert.include(root.textContent, '$5.00 model limit');
    assert.include(root.textContent, '1 agent'); assert.include(root.textContent, 'Off · Sprites usage charges apply');
    assert.equal(button('files').textContent, 'Enable mission filesystem'); assert.isEmpty(calls);
    button('brief').click(); button('crew').click(); button('limits').click();
    assert.deepEqual(calls, [['openSettings', 'one', 'brief'], ['openCrew', 'one'], ['openSettings', 'one', 'limits']]);
  });
  it('requires connection setup first, never enabling a disconnected provider', () => {
    state.settings.providerConfigured = false; refresh(); button('files').click();
    assert.equal(button('files').textContent, 'Connect Sprites'); assert.deepEqual(calls, [['openConnection']]);
    state.connected = false; refresh(); assert.isTrue(button('files').disabled);
  });
  it('does not require enabling arbitrary code execution for a filesystem', async () => {
    state.settings.enabled = false; refresh(); button('files').click(); await settle();
    assert.deepEqual(calls, [['enable', 'one']]); assert.equal(button('files').textContent, 'Open files');
  });
  it('animates one in-flight enable and opens files only in the captured mission', async () => {
    let finish; enable = (id) => { calls.push(['enable', id]); return new Promise((resolve) => { finish = resolve; }); };
    button('files').click(); Tracker.flush(); button('files').click();
    assert.equal(button('files').getAttribute('aria-busy'), 'true'); assert.isTrue(button('files').disabled);
    assert.equal(root.querySelector('[data-check="files"]').dataset.state, 'busy');
    assert.lengthOf(calls, 1);
    state = { ...state, missionId: 'two' }; refresh(); assert.equal(button('files').textContent, 'Enable mission filesystem');
    finish({ keepFiles: true, workspaceId: 'sprite', status: 'ready' }); await settle();
    assert.equal(button('files').textContent, 'Enable mission filesystem'); assert.lengthOf(calls, 1);
    state.missionId = 'one'; refresh(); assert.equal(button('files').textContent, 'Open files'); button('files').click();
    assert.deepEqual(calls[1], ['openFiles', 'one']);
  });
  it('shows errors inline and permits a deliberate retry', async () => {
    enable = async () => { throw { reason: 'Connection could not be verified' }; };
    button('files').click(); await settle();
    assert.isFalse(root.querySelector('[role="alert"]').hidden); assert.include(root.textContent, 'Connection could not be verified');
    assert.isFalse(button('files').disabled); assert.equal(button('files').textContent, 'Enable mission filesystem');
  });
  it('shows recovery and follows published disabling rather than a stale success', async () => {
    button('files').click(); await settle();
    state.environment = { workspaceId: 'sprite', keepFiles: false, status: 'needs-attention' }; refresh();
    assert.equal(button('files').textContent, 'Review filesystem'); button('files').click();
    assert.deepEqual(calls.at(-1), ['openEnvironment', 'one']);
    state.environment = { workspaceId: 'sprite', keepFiles: false, status: 'ready' }; refresh();
    assert.equal(button('files').textContent, 'Enable mission filesystem');
  });
  it('disables controls safely while the mission configuration is loading', () => {
    state.config = null; state.missionId = null; refresh();
    assert.isTrue(button('files').disabled); assert.isTrue(button('crew').disabled);
  });
});
