import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';

// Every transport and collection is local to these fixtures: no Sprites calls,
// credentials, executions, or mission records are created by this suite.
if (Meteor.isClient) describe('Constellation code execution UI', function () {
  this.timeout(8_000);
  let initialize; let fixture;
  const $ = (name, root = fixture.root) => root.querySelector(`[data-execution="${name}"]`);
  const flush = () => Tracker.flush();
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 4_000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail('Execution UI did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
  };
  const job = (id = 'run-one', patch = {}) => ({ _id: id, missionId: 'mission-a', sessionId: 'session-a',
    agent: 'researcher', title: 'Summarize the spreadsheet', language: 'python',
    code: 'print("Rows: 12")', status: 'completed', stdout: 'Rows: 12', stderr: '', exitCode: 0,
    createdAt: new Date('2026-09-21T16:00:00Z'), artifacts: [], ...patch });
  const environment = (patch = {}) => ({ _id: 'environment-a', missionId: 'mission-a', workspaceId: 'saved-workspace',
    keepFiles: true, allowedAgents: ['researcher'], retention: 'keep', status: 'ready', savePoints: [], ...patch });
  const connected = (patch = {}) => {
    fixture.settings.update('settings', { $set: { providerConfigured: true, enabled: true,
      connectionStatus: 'connected', ...patch } }); flush();
  };
  const localConnection = (connected, status = connected ? 'connected' : 'waiting') => {
    fixture.connectionStatus = { connected, status }; fixture.connectionChanged.changed(); flush();
  };
  const advanceRecovery = async (delay) => {
    fixture.now += delay;
    for (const [id, timer] of [...fixture.recoveryTimers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > fixture.now) continue;
      fixture.recoveryTimers.delete(id); timer.fn(); flush();
    }
    await Promise.resolve(); await Promise.resolve(); flush();
  };
  const settingsSubscription = () => fixture.subscriptions.filter((entry) => entry.name === 'constellation.execution').at(-1);
  const settingsCallbacks = (subscription = settingsSubscription()) => subscription.args.at(-1);
  const connectionResult = (patch = {}) => ({ ...fixture.settings.findOne(fixture.accountId), testedAt: new Date(fixture.now), ...patch });
  const submit = (form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

  before(async () => { ({ initializeExecution: initialize } = await import('../client/operations-execution')); });
  beforeEach(() => {
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;inset:30px;z-index:99999;background:#151817;display:flex;';
    const root = document.createElement('section'); const missionRoot = document.createElement('section');
    const runsRoot = document.createElement('section'); const filesRoot = document.createElement('section'); const servicesRoot = document.createElement('section');
    mount.append(root, missionRoot, runsRoot, filesRoot, servicesRoot); document.body.append(mount);
    const settings = new Mongo.Collection(null); const jobs = new Mongo.Collection(null); const environments = new Mongo.Collection(null);
    settings.insert({ _id: 'settings', enabled: false, providerConfigured: false,
      canStoreSecret: true, connectionStatus: 'untested', domains: [], agentPolicies: {},
      limits: { timeoutSeconds: 60, maxRunsPerMission: 20, maxOutputBytes: 64000, maxArtifactBytes: 5000000 } });
    fixture = { mount, root, missionRoot, runsRoot, filesRoot, servicesRoot, settings, jobs, environments, calls: [], subscriptions: [], toasts: [], downloads: [], environmentDownloads: [], previewOpens: [], navigations: [], workNavigations: [],
      accountId: 'settings', accountChanged: new Tracker.Dependency(), now: Date.now(), recoveryTimers: new Map(), nextRecoveryTimer: 0,
      missionId: 'mission-a', missionChanged: new Tracker.Dependency(),
      connectionStatus: { connected: true, status: 'connected' }, connectionChanged: new Tracker.Dependency(),
      missions: [{ _id: 'mission-a', title: 'Analysis mission' }, { id: 'mission-b', title: 'Other mission' }],
      members: [{ agent: 'orchestrator', displayName: 'Atlas' }, { agent: 'researcher', displayName: 'Signal' }],
      response: async (name) => name === 'history' ? [] : name === 'getEnvironment' ? {
        keepFiles: false, allowedAgents: [], retention: 'keep', status: 'not-created', savePoints: [],
      } : {},
      attachment: async () => '/local-test-download',
    };
    fixture.host = { root, runsRoot, filesRoot, servicesRoot, settings, jobs, environments, id: `execution-test-${Random.id()}`,
      userId: () => { fixture.accountChanged.depend(); return fixture.accountId; },
      recoveryClock: { now: () => fixture.now,
        setTimeout: (fn, delay) => { const id = ++fixture.nextRecoveryTimer; fixture.recoveryTimers.set(id, { fn, at: fixture.now + delay }); return id; },
        clearTimeout: (id) => fixture.recoveryTimers.delete(id) },
      mission: () => { fixture.missionChanged.depend(); return fixture.missionId; },
      missions: () => fixture.missions,
      connectionStatus: () => { fixture.connectionChanged.depend(); return fixture.connectionStatus; },
      missionTitle: (id) => id === 'mission-a' ? 'Analysis mission' : 'Other mission', crew: () => fixture.members,
      toast: (message) => fixture.toasts.push(message),
      navigateToCode: (agent) => { fixture.navigations.push(agent); return fixture.navigationRestore; },
      navigateToMissionWork: (tab, missionId, options) => fixture.workNavigations.push({ tab, missionId, options }),
      subscribe: (name, ...args) => {
        const request = { name, args, stopped: false, isReady: true, ready() { return this.isReady; }, stop() { this.stopped = true; } };
        fixture.subscriptions.push(request); return request;
      },
      method: (name, input) => { fixture.calls.push({ name, input }); return fixture.response(name, input); },
      attachmentUrl: (run, file) => fixture.attachment(run, file), download: (url) => fixture.downloads.push(url),
      downloadEnvironmentFile: (file) => fixture.environmentDownloads.push(file),
      openPreview: (url) => fixture.previewOpens.push(url),
    };
    fixture.controller = initialize(fixture.host);
  });
  afterEach(() => { fixture.controller.dispose(); fixture.mount.remove(); });

  it('offers a clear connection action and keeps mission code work hidden without credentials', () => {
    assert.include(fixture.root.textContent, 'Run code');
    assert.equal($('connection-state').textContent, 'Not connected');
    assert.isFalse($('connect').hidden);
    assert.isEmpty(fixture.missionRoot.children, 'Code settings do not create duplicate mission navigation');
    assert.sameMembers(fixture.subscriptions.map((entry) => entry.name), ['constellation.execution', 'constellation.execution.environments']);
    assert.isEmpty(fixture.calls);
    assert.include(fixture.root.textContent, 'Fly.io');
    assert.notMatch(fixture.root.textContent, /\$0\.00|persistent workspace|checkpoint/i);
  });

  it('saves a write-only token, allowlist, and limits before testing the enabled connection', async () => {
    const dialog = fixture.controller.openSettings();
    assert.equal($('token', dialog).type, 'password');
    assert.equal($('token', dialog).value, '');
    $('token', dialog).value = 'test-secret-token'; $('enabled', dialog).checked = true;
    $('enabled', dialog).dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal($('save', dialog).textContent, 'Save & test');
    $('domains', dialog).value = 'example.com\n data.example.com \n';
    $('timeout', dialog).value = '90'; $('runs', dialog).value = '12';
    submit($('connection-form', dialog));
    await waitUntil(() => !dialog.open);
    assert.deepEqual(fixture.calls, [{ name: 'saveSettings', input: { enabled: true, token: 'test-secret-token',
      domains: ['example.com', 'data.example.com'], limits: { timeoutSeconds: 90, maxRunsPerMission: 12,
        maxOutputBytes: 64000, maxArtifactBytes: 5000000 } } }, { name: 'testConnection', input: {} }]);
    assert.equal($('token', dialog).value, '');
    assert.notInclude(fixture.root.textContent + dialog.textContent, 'test-secret-token');
    // Native dialog close events are queued, including their token cleanup.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.controller.openSettings(); $('token', dialog).value = 'discard-on-close';
    const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    dialog.close(); await closed;
    assert.equal($('token', dialog).value, '');
  });

  it('keeps saved settings open when the combined connection test fails and supports an immediate retry', async () => {
    let tests = 0;
    fixture.response = async (name) => {
      if (name === 'testConnection' && ++tests === 1) throw { reason: 'Token was not accepted. Check your Sprites token.' };
      return {};
    };
    const dialog = fixture.controller.openSettings();
    $('enabled', dialog).checked = true; $('enabled', dialog).dispatchEvent(new Event('change'));
    $('token', dialog).value = 'saved-secret'; $('domains', dialog).value = 'example.com';
    submit($('connection-form', dialog));
    await waitUntil(() => $('connection-errors', dialog).querySelector('[role="alert"]'));
    assert.isTrue(dialog.open);
    assert.equal($('token', dialog).value, '', 'a saved token must not remain in the password field');
    assert.equal($('domains', dialog).value, 'example.com');
    assert.include($('connection-message', dialog).textContent, 'Settings saved');
    assert.isFalse($('test', dialog).disabled, 'retry must work before settings publication catches up');
    $('test', dialog).click();
    await waitUntil(() => tests === 2 && !$('test', dialog).disabled);
    assert.isTrue(dialog.open);
    assert.include($('connection-message', dialog).textContent, 'confirmed');
    assert.deepEqual(fixture.calls.map(({ name }) => name), ['saveSettings', 'testConnection', 'testConnection']);
  });

  it('saves with execution switched off without making a connection test', async () => {
    connected(); const dialog = fixture.controller.openSettings();
    assert.equal($('save', dialog).textContent, 'Save & test');
    $('enabled', dialog).checked = false; $('enabled', dialog).dispatchEvent(new Event('change'));
    assert.equal($('save', dialog).textContent, 'Save connection');
    submit($('connection-form', dialog));
    await waitUntil(() => !dialog.open);
    assert.deepEqual(fixture.calls.map(({ name }) => name), ['saveSettings']);
    assert.isFalse(fixture.calls[0].input.enabled);
  });

  it('explains shell credentials and tests only a saved connection on an explicit click', async () => {
    connected({ keySource: 'shell', canStoreSecret: false });
    const dialog = fixture.controller.openSettings();
    assert.isTrue($('token', dialog).disabled);
    assert.isTrue($('clear-token', dialog).hidden);
    assert.include($('token-source', dialog).textContent, 'SPRITES_TOKEN');
    assert.isEmpty(fixture.calls, 'opening settings must not contact the provider');
    $('test', dialog).click();
    await waitUntil(() => fixture.calls.length === 1 && !$('test', dialog).disabled);
    assert.deepEqual(fixture.calls[0], { name: 'testConnection', input: {} });
    assert.include($('connection-message', dialog).textContent, 'confirmed');
  });

  it('preserves connection drafts on errors and prevents duplicate saves', async () => {
    const pending = deferred(); fixture.response = () => pending.promise;
    const dialog = fixture.controller.openSettings();
    $('token', dialog).value = 'unsaved-secret'; $('domains', dialog).value = 'example.com';
    submit($('connection-form', dialog)); submit($('connection-form', dialog));
    assert.lengthOf(fixture.calls, 1);
    pending.reject({ reason: 'Finish the active run before replacing the token.' });
    await waitUntil(() => $('connection-errors', dialog).querySelector('[role="alert"]'));
    assert.isTrue(dialog.open); assert.equal($('token', dialog).value, 'unsaved-secret');
    assert.equal($('domains', dialog).value, 'example.com');
    assert.include($('connection-errors', dialog).textContent, 'Finish the active run');
  });

  it('keeps a pending token save through a local-server disconnect without replaying it', async () => {
    const pending = deferred(); fixture.response = () => pending.promise;
    const dialog = fixture.controller.openSettings();
    $('token', dialog).value = 'pending-local-secret'; $('domains', dialog).value = 'example.com';
    submit($('connection-form', dialog));
    assert.lengthOf(fixture.calls, 1);
    localConnection(false);
    assert.isFalse($('local-server-notice', dialog).hidden);
    assert.include($('local-server-notice', dialog).textContent, 'local app server');
    assert.include($('local-server-notice', dialog).textContent, 'still pending');
    assert.equal($('save', dialog).textContent, 'Waiting for local server…');
    assert.isTrue($('save', dialog).disabled); assert.isTrue($('test', dialog).disabled);
    assert.equal($('token', dialog).value, 'pending-local-secret');
    assert.equal($('domains', dialog).value, 'example.com');
    assert.isEmpty($('connection-errors', dialog).textContent);
    submit($('connection-form', dialog)); assert.lengthOf(fixture.calls, 1);
    localConnection(true);
    assert.equal($('save', dialog).textContent, 'Awaiting confirmation…');
    assert.isTrue($('save', dialog).disabled);
    assert.equal($('token', dialog).value, 'pending-local-secret');
    assert.lengthOf(fixture.calls, 1, 'reconnection must not replay a write');
    pending.resolve({ providerConfigured: true }); await waitUntil(() => !dialog.open);
    assert.lengthOf(fixture.calls, 1, 'a disabled connection is saved without testing or granting access');
    assert.equal($('token', dialog).value, '');
  });

  it('blocks new connection actions while offline and restores controls without changing the draft', () => {
    connected({ connectionStatus: 'error' }); localConnection(false, 'offline');
    const dialog = fixture.controller.openSettings();
    $('token', dialog).value = 'not-submitted'; $('domains', dialog).value = 'draft.example.com';
    $('timeout', dialog).value = '120'; $('enabled', dialog).checked = false;
    assert.equal($('connection-state').textContent, 'Local server disconnected');
    assert.include($('local-server-notice', dialog).textContent, 'not a Sprites error');
    for (const name of ['save', 'test', 'clear-token']) assert.isTrue($(name, dialog).disabled);
    assert.isFalse($('connection-form', dialog).querySelector('fieldset').disabled, 'offline drafts can still be edited');
    submit($('connection-form', dialog)); $('test', dialog).click(); $('clear-token', dialog).click();
    assert.isEmpty(fixture.calls);
    localConnection(true);
    for (const name of ['save', 'test', 'clear-token']) assert.isFalse($(name, dialog).disabled);
    assert.isTrue($('local-server-notice', dialog).hidden);
    assert.equal($('save', dialog).textContent, 'Save connection');
    assert.equal($('token', dialog).value, 'not-submitted');
    assert.equal($('domains', dialog).value, 'draft.example.com');
    assert.equal($('timeout', dialog).value, '120');
    assert.isFalse($('enabled', dialog).checked);
    assert.equal(fixture.settings.findOne('settings').connectionStatus, 'error', 'transport recovery does not certify the provider');
    assert.isEmpty(fixture.calls);
  });

  it('allows closing and reopening a pending offline save without discarding its credential', async () => {
    const pending = deferred(); fixture.response = () => pending.promise;
    const dialog = fixture.controller.openSettings();
    $('token', dialog).value = 'keep-until-confirmed'; $('domains', dialog).value = 'example.com';
    submit($('connection-form', dialog)); localConnection(false);
    const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    dialog.querySelector('[data-dialog-close]').click(); await closed;
    assert.isFalse(dialog.open); assert.equal($('token', dialog).value, 'keep-until-confirmed');
    assert.strictEqual(fixture.controller.openSettings(), dialog);
    assert.equal($('token', dialog).value, 'keep-until-confirmed');
    assert.equal($('domains', dialog).value, 'example.com');
    assert.isTrue($('save', dialog).disabled);
    assert.lengthOf(fixture.calls, 1);
    localConnection(true); pending.reject({ reason: 'The token could not be stored. Try again.' });
    await waitUntil(() => !$('save', dialog).disabled && $('connection-errors', dialog).textContent.includes('could not be stored'));
    assert.equal($('token', dialog).value, 'keep-until-confirmed');
    assert.isTrue($('local-server-notice', dialog).hidden);
    assert.isTrue(dialog.open); assert.lengthOf(fixture.calls, 1);
  });

  it('does not start a new provider test if a save is acknowledged while the local server is offline', async () => {
    const saved = deferred(); fixture.response = async (name) => name === 'saveSettings' ? saved.promise : {};
    const dialog = fixture.controller.openSettings();
    $('enabled', dialog).checked = true; $('token', dialog).value = 'save-once';
    submit($('connection-form', dialog)); localConnection(false);
    saved.resolve({ providerConfigured: true });
    await waitUntil(() => $('connection-form', dialog).getAttribute('aria-busy') === 'false');
    assert.isTrue(dialog.open); assert.equal($('token', dialog).value, '', 'an acknowledged saved token no longer needs a draft copy');
    assert.include($('connection-message', dialog).textContent, 'after the local app server reconnects');
    assert.isTrue($('test', dialog).disabled);
    localConnection(true);
    assert.deepEqual(fixture.calls.map(({ name }) => name), ['saveSettings']);
    assert.isFalse($('test', dialog).disabled);
    $('test', dialog).click(); await waitUntil(() => $('connection-message', dialog).textContent.includes('confirmed'));
    assert.deepEqual(fixture.calls.map(({ name }) => name), ['saveSettings', 'testConnection']);
  });

  it('separates a pending provider test from server reconnection and surfaces its eventual error', async () => {
    connected(); const pending = deferred(); fixture.response = () => pending.promise;
    const dialog = fixture.controller.openSettings(); $('test', dialog).click(); localConnection(false);
    assert.equal($('test', dialog).textContent, 'Waiting for local server…');
    localConnection(true); assert.equal($('test', dialog).textContent, 'Awaiting confirmation…');
    $('test', dialog).click(); assert.lengthOf(fixture.calls, 1);
    pending.reject({ reason: 'Sprites did not accept the saved token.' });
    await waitUntil(() => !$('test', dialog).disabled && $('connection-errors', dialog).textContent.includes('Sprites did not accept'));
    assert.isTrue($('local-server-notice', dialog).hidden);
    assert.equal($('test', dialog).textContent, 'Test connection');
    assert.equal($('save', dialog).textContent, 'Save & test');
    assert.lengthOf(fixture.calls, 1);
  });

  it('rechecks a tested connection once after local reconnection without touching drafts or permissions', async () => {
    connected({ testedAt: new Date(fixture.now - 1000), agentPolicies: { researcher: { run: 'ask' } } });
    const pending = deferred(); fixture.response = () => pending.promise;
    const dialog = fixture.controller.openSettings();
    $('token', dialog).value = 'unsaved-replacement'; $('domains', dialog).value = 'draft.example.com';
    $('enabled', dialog).checked = false; $('timeout', dialog).value = '120';
    localConnection(false); assert.equal($('connection-state').textContent, 'Local server disconnected');
    localConnection(true); await waitUntil(() => fixture.calls.length === 1);
    assert.deepEqual(fixture.calls, [{ name: 'recheckConnection', input: {} }]);
    assert.equal($('connection-state').textContent, 'Checking connection…');
    assert.equal($('connection-state').dataset.state, 'preparing');
    assert.isFalse($('connection-recovery', dialog).hidden);
    assert.isTrue($('save', dialog).disabled);
    assert.isFalse($('connection-form', dialog).querySelector('fieldset').disabled, 'a background check does not lock draft editing');
    localConnection(false); localConnection(true); await Promise.resolve();
    assert.lengthOf(fixture.calls, 1, 'another reconnect cannot duplicate an in-flight check');
    pending.resolve(connectionResult({ connectionStatus: 'connected', connectionRetryable: false }));
    await waitUntil(() => $('connection-state').textContent === 'Connected');
    assert.equal($('token', dialog).value, 'unsaved-replacement');
    assert.equal($('domains', dialog).value, 'draft.example.com');
    assert.equal($('timeout', dialog).value, '120'); assert.isFalse($('enabled', dialog).checked);
    assert.deepEqual(fixture.settings.findOne('settings').agentPolicies, { researcher: { run: 'ask' } });
    assert.isTrue(fixture.settings.findOne('settings').enabled);
    assert.isEmpty(fixture.toasts); assert.lengthOf(fixture.calls, 1);
  });

  it('bounds transient connection recovery and respects the server throttle and backoff', async () => {
    connected({ testedAt: new Date(fixture.now - 1000) });
    fixture.response = async () => connectionResult({ connectionStatus: 'error', connectionErrorCode: 'network-error',
      connectionRetryable: true, connectionRecheckAfter: new Date(fixture.now + 45000) });
    localConnection(false); localConnection(true);
    await waitUntil(() => fixture.calls.length === 1 && $('connection-state').textContent === 'Sprites unreachable');
    assert.include($('connection-hint').textContent, 'Checking again shortly');
    await advanceRecovery(44999); assert.lengthOf(fixture.calls, 1);
    await advanceRecovery(1); await waitUntil(() => fixture.calls.length === 2 && $('connection-state').textContent === 'Sprites unreachable');
    await advanceRecovery(59999); assert.lengthOf(fixture.calls, 2);
    await advanceRecovery(1); await waitUntil(() => fixture.calls.length === 3 && $('connection-state').textContent === 'Sprites unreachable');
    assert.equal(fixture.recoveryTimers.size, 0);
    assert.include($('connection-hint').textContent, 'internet connection');
    await advanceRecovery(86400000); assert.lengthOf(fixture.calls, 3);
    assert.isTrue(fixture.calls.every(({ name }) => name === 'recheckConnection'));
  });

  it('recovers a previously tested transient error after restarting but never tests a new token automatically', async () => {
    connected({ testedAt: new Date(fixture.now - 1000), connectionStatus: 'error', connectionErrorCode: 'provider-busy',
      connectionRetryable: true, connectionRecheckAfter: new Date(fixture.now + 30000) });
    fixture.controller.dispose();
    fixture.response = async () => connectionResult({ connectionStatus: 'connected', connectionRetryable: false });
    fixture.controller = initialize(fixture.host);
    assert.isEmpty(fixture.calls);
    await advanceRecovery(30000);
    await waitUntil(() => fixture.calls.length === 1 && $('connection-state').textContent === 'Connected');
    fixture.settings.update('settings', { $set: { connectionStatus: 'untested', connectionRetryable: false }, $unset: { testedAt: 1 } }); flush();
    localConnection(false); localConnection(true); await advanceRecovery(86400000);
    assert.lengthOf(fixture.calls, 1, 'saving an untested token does not authorize an automatic first test');
    assert.equal($('connection-state').textContent, 'Token saved');
  });

  it('stops automatic checks on rejected credentials instead of retrying authentication', async () => {
    connected({ testedAt: new Date(fixture.now - 1000) });
    fixture.response = async () => connectionResult({ connectionStatus: 'error', connectionErrorCode: 'key-rejected', connectionRetryable: false });
    localConnection(false); localConnection(true);
    await waitUntil(() => $('connection-state').textContent === 'Token not accepted');
    assert.include($('connection-hint').textContent, 'Replace the saved token');
    assert.equal(fixture.recoveryTimers.size, 0);
    fixture.settings.update('settings', { $set: { unrelated: 'still awaiting the connection publication' } }); flush();
    assert.equal($('connection-state').textContent, 'Token not accepted', 'an overlaid render is not a publication acknowledgment');
    localConnection(false); localConnection(true); await advanceRecovery(86400000);
    assert.lengthOf(fixture.calls, 1);
    assert.equal($('connection-state').textContent, 'Token not accepted');
  });

  it('retries a transient settings subscription and clears its failure only for the current subscription', async () => {
    const original = settingsSubscription();
    settingsCallbacks(original).onError({ error: 503 }); flush();
    assert.equal($('connection-state').textContent, 'Settings unavailable');
    assert.include($('connection-hint').textContent, 'Retrying shortly');
    await advanceRecovery(1000);
    const renewed = settingsSubscription(); assert.notStrictEqual(renewed, original); assert.isTrue(original.stopped);
    settingsCallbacks(renewed).onReady(); flush();
    assert.equal($('connection-state').textContent, 'Not connected');
    settingsCallbacks(original).onError({ error: 503 }); flush();
    assert.equal($('connection-state').textContent, 'Not connected');
    assert.equal(fixture.recoveryTimers.size, 0); assert.isEmpty(fixture.calls);
  });

  it('bounds settings subscription retries and never retries permission failures', async () => {
    for (const delay of [1000, 5000, 15000]) {
      settingsCallbacks().onError({ error: 503 }); flush(); await advanceRecovery(delay);
    }
    settingsCallbacks().onError({ error: 503 }); flush();
    assert.lengthOf(fixture.subscriptions.filter(({ name }) => name === 'constellation.execution'), 4);
    assert.equal(fixture.recoveryTimers.size, 0);
    // A local reconnect permits a new bounded recovery cycle, never a permission retry.
    settingsCallbacks().onReady(); flush(); settingsCallbacks().onError({ error: 403 }); flush();
    localConnection(false); localConnection(true); await advanceRecovery(86400000);
    assert.lengthOf(fixture.subscriptions.filter(({ name }) => name === 'constellation.execution'), 4);
    assert.equal($('connection-state').textContent, 'Settings unavailable');
  });

  it('ignores old-account recovery results and publications after switching accounts', async () => {
    connected({ testedAt: new Date(fixture.now - 1000) });
    const pending = deferred(); fixture.response = () => pending.promise;
    localConnection(false); localConnection(true); await waitUntil(() => fixture.calls.length === 1);
    fixture.settings.insert({ _id: 'other-owner', providerConfigured: false, enabled: false, connectionStatus: 'untested' });
    fixture.accountId = 'other-owner'; fixture.accountChanged.changed(); flush();
    assert.equal($('connection-state').textContent, 'Not connected');
    pending.resolve({ _id: 'settings', providerConfigured: true, connectionStatus: 'error', testedAt: new Date(fixture.now),
      connectionErrorCode: 'network-error', connectionRetryable: true });
    await Promise.resolve(); await Promise.resolve(); flush();
    fixture.settings.update('settings', { $set: { connectionStatus: 'connected', testedAt: new Date(fixture.now + 1000) } }); flush();
    assert.equal($('connection-state').textContent, 'Not connected');
    assert.equal(fixture.recoveryTimers.size, 0); assert.lengthOf(fixture.calls, 1);
  });

  it('disposes pending recovery without stale DOM writes or retries', async () => {
    connected({ testedAt: new Date(fixture.now - 1000) });
    const pending = deferred(); fixture.response = () => pending.promise;
    localConnection(false); localConnection(true); await waitUntil(() => fixture.calls.length === 1);
    fixture.controller.dispose();
    pending.resolve(connectionResult({ connectionStatus: 'error', connectionErrorCode: 'network-error', connectionRetryable: true }));
    await Promise.resolve(); await Promise.resolve(); await advanceRecovery(86400000);
    assert.isEmpty(fixture.root.children); assert.equal(fixture.recoveryTimers.size, 0);
    assert.lengthOf(fixture.calls, 1); assert.isEmpty(fixture.toasts);
  });

  it('navigates to one inline permission editor with explicit workspace scope', async () => {
    connected();
    const row = fixture.controller.openAgentAccess('researcher');
    assert.deepEqual(fixture.navigations, ['researcher']);
    assert.isUndefined(fixture.controller.dialogs.access);
    assert.include(row.textContent, 'Signal');
    assert.include(fixture.root.textContent, 'All missions');
    assert.isAtLeast(parseFloat(getComputedStyle(fixture.root.querySelector('.execution-permission-note')).marginTop), 16,
      'permission guidance stays visually separate from the last agent row');
    const policy = $('policy', row);
    assert.equal(policy.value, 'disabled');
    assert.include(policy.getAttribute('aria-label'), 'Signal code permission for all missions');
    assert.deepEqual([...policy.options].map((option) => option.textContent), ['Off', 'Ask every time', 'Allowed']);
    await waitUntil(() => document.activeElement === policy);
    policy.value = 'ask'; policy.dispatchEvent(new Event('change'));
    await waitUntil(() => !policy.disabled && $('policy-status', row).textContent === 'Saved');
    assert.deepEqual(fixture.calls, [{ name: 'setAgentPolicy', input: { agent: 'researcher', policy: { run: 'ask' } } }]);
    assert.equal(policy.value, 'ask', 'confirmed selection remains stable until publication arrives');
    fixture.settings.update('settings', { $set: { enabled: false } }); flush();
    assert.equal(policy.value, 'ask', 'unrelated publication does not reset a saved selection');
    fixture.settings.update('settings', { $set: { 'agentPolicies.researcher.run': 'ask' } }); flush();
    assert.equal(policy.value, 'ask');
  });

  it('keeps permission saves single-flight and restores the saved value after failure', async () => {
    connected(); const pending = deferred(); fixture.response = () => pending.promise;
    const row = fixture.controller.openAgentAccess('researcher'); const policy = $('policy', row);
    policy.value = 'auto'; policy.dispatchEvent(new Event('change')); flush();
    assert.isTrue(policy.disabled); assert.equal(row.getAttribute('aria-busy'), 'true');
    assert.equal($('policy-status', row).textContent, 'Saving…');
    policy.dispatchEvent(new Event('change')); assert.lengthOf(fixture.calls, 1);
    localConnection(false);
    assert.equal($('policy-status', row).textContent, 'Awaiting confirmation…');
    pending.reject({ reason: 'This permission could not be saved.' });
    await waitUntil(() => !$('policy-error', row).hidden);
    assert.equal(policy.value, 'disabled'); assert.include($('policy-error', row).textContent, 'could not be saved');
    assert.isTrue($('retry-policy', row).disabled);
    localConnection(true); fixture.response = async () => ({ run: 'auto' });
    $('retry-policy', row).click();
    await waitUntil(() => policy.value === 'auto' && !policy.disabled);
    assert.isTrue($('policy-error', row).hidden);
    assert.lengthOf(fixture.calls, 2);
  });

  it('returns to a suspended settings context after visiting code permissions', () => {
    let restored = false;
    fixture.navigationRestore = () => { restored = true; };
    fixture.navigationRestore.label = 'Back to Atlas settings';
    fixture.controller.openAgentAccess('orchestrator');
    assert.isFalse($('access-return').hidden);
    assert.equal($('return-environment').textContent, 'Back to Atlas settings');
    $('return-environment').click();
    assert.isTrue(restored); assert.isTrue($('access-return').hidden);
  });

  it('replaces abandoned return paths when code permissions are opened from another context', () => {
    const restored = [];
    fixture.navigationRestore = () => restored.push('old-parent');
    fixture.controller.openAgentAccess('researcher', { label: 'Back to previous mission',
      onReturn: () => restored.push('old-environment') });
    assert.equal($('return-environment').textContent, 'Back to previous mission');
    fixture.navigationRestore = () => restored.push('new-agent');
    fixture.navigationRestore.label = 'Back to Atlas settings';
    fixture.controller.openAgentAccess('orchestrator');
    assert.equal($('return-environment').textContent, 'Back to Atlas settings');
    $('return-environment').click();
    assert.deepEqual(restored, ['new-agent'], 'a new visit cannot revive an earlier mission or settings draft');
    fixture.controller.openAgentAccess('orchestrator');
    assert.isFalse($('access-return').hidden);
    fixture.navigationRestore = null;
    fixture.controller.openAgentAccess('researcher');
    assert.isTrue($('access-return').hidden, 'direct visits clear any abandoned settings return link');
  });

  it('does not reopen a child draft when its parent settings context cannot be restored', () => {
    let parentAttempts = 0; let childRestored = false;
    fixture.navigationRestore = () => { parentAttempts += 1; return false; };
    fixture.controller.openAgentAccess('researcher', { label: 'Back to mission settings',
      onReturn: () => { childRestored = true; } });
    $('return-environment').click();
    assert.equal(parentAttempts, 1);
    assert.isFalse(childRestored);
    assert.isTrue($('access-return').hidden);
    assert.isFalse(fixture.controller.dialogs.environment.open);
  });

  it('opens persistent mission Runs with exact context and without a mission modal', async () => {
    connected();
    fixture.response = async (name, input) => name === 'historyPage' ? { rows: [job()], nextCursor: null }
      : name === 'getRun' ? job(input.jobId) : {};
    const root = fixture.controller.openRun('run-one', 'mission-a');
    assert.strictEqual(root, fixture.runsRoot);
    await waitUntil(() => fixture.runsRoot.querySelector('[data-runs="title"]')?.textContent === 'Summarize the spreadsheet');
    assert.deepEqual(fixture.workNavigations, [{ tab: 'runs', missionId: 'mission-a', options: { jobId: 'run-one' } }]);
    assert.isFalse(fixture.controller.dialogs.work.open);
    assert.isFalse(fixture.runsRoot.hidden);
    assert.equal(fixture.runsRoot.querySelectorAll('tbody tr').length, 1);
    const before = fixture.calls.length;
    fixture.controller.setMissionWork({ missionId: 'mission-a', tab: 'runs', options: { jobId: 'run-one' } });
    await Promise.resolve(); flush();
    assert.equal(fixture.calls.length, before, 'reactive navigation updates do not reload the same run');
    fixture.controller.setMissionWork({ missionId: 'mission-a', tab: 'chat' });
    assert.isTrue(fixture.runsRoot.hidden);
  });

  it('uses the same metadata browser for All missions without selecting the current mission', async () => {
    fixture.response = async (name) => name === 'historyPage' ? { rows: [job()], nextCursor: null } : {};
    const dialog = fixture.controller.openWorkspace();
    await waitUntil(() => dialog.querySelector('tbody tr'));
    assert.equal(dialog.querySelector('h2').textContent, 'All code runs');
    assert.equal(dialog.querySelector('.op-dialog-scope').textContent, 'All missions');
    assert.isFalse(dialog.querySelector('[data-runs="mission-field"]').hidden);
    assert.include(dialog.querySelector('thead').textContent, 'Mission');
    assert.deepEqual(fixture.calls, [{ name: 'historyPage', input: { limit: 25 } }]);
    const subscription = fixture.subscriptions.find((row) => row.name === 'constellation.execution.workspaceJobs');
    const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    dialog.close(); await closed;
    assert.isTrue(subscription.stopped);
  });

  it('stops every subscription on disposal and preserves the shared toast host', () => {
    fixture.controller.openWorkspace(); fixture.controller.setMissionWork({ missionId: 'mission-a', tab: 'runs' });
    const dialog = fixture.controller.openSettings();
    const toast = document.createElement('div'); toast.id = 'toast-region'; dialog.append(toast);
    fixture.controller.dispose();
    assert.isTrue(fixture.subscriptions.every((entry) => entry.stopped));
    assert.strictEqual(toast.parentElement, document.body);
    toast.remove();
  });

  it('keeps cleanup discoverable after a conversation is deleted without requiring its mission', async () => {
    fixture.missionId = null; fixture.missionChanged.changed();
    fixture.jobs.insert({ _id: 'erased-run', erasedAt: new Date(), status: 'unknown', agent: 'researcher',
      title: 'Deleted conversation · cleanup pending', cleanupPending: true }); flush();
    assert.isFalse($('workspace-cleanup').hidden);
    assert.isTrue(fixture.runsRoot.hidden, 'workspace cleanup does not require an active mission Runs surface');
    assert.isEmpty(fixture.missionRoot.children, 'workspace cleanup has no dependency on the removed sidebar tile');
    assert.include($('cleanup-list').textContent, 'Deleted conversation');
    assert.include($('cleanup-list').textContent, 'Signal');
    fixture.response = async (name, input) => {
      if (name === 'cleanup') fixture.jobs.update(input.jobId, { $set: { cleanupPending: false } });
      return {};
    };
    $('cleanup-list').querySelector('button').click();
    await waitUntil(() => $('workspace-cleanup').hidden);
    assert.deepEqual(fixture.calls, [{ name: 'cleanup', input: { jobId: 'erased-run' } }]);
  });

  it('waits for uncertain workspace creation to settle before offering cleanup', () => {
    fixture.jobs.insert({ _id: 'settling-run', erasedAt: new Date(), status: 'unknown', agent: 'researcher',
      cleanupPending: true, cleanupRetryAfter: new Date(Date.now() + 120_000) }); flush();
    const button = $('cleanup-list').querySelector('button');
    assert.isTrue(button.disabled); assert.equal(button.textContent, 'Available shortly');
    assert.isEmpty(fixture.calls);
    fixture.jobs.update('settling-run', { $set: { cleanupRetryAfter: new Date(Date.now() - 1000) } }); flush();
    assert.isFalse(button.disabled); assert.equal(button.textContent, 'Retry cleanup');
  });

  it('enables a mission filesystem with explicit agent grants only when settings are submitted', async () => {
    const dialog = fixture.controller.openEnvironment('mission-a');
    await waitUntil(() => !$('env-settings-fields', dialog).disabled);
    assert.equal(dialog.querySelector('.op-dialog-scope').textContent, 'Analysis mission');
    assert.isFalse($('env-keep-files', dialog).checked);
    assert.equal($('env-retention', dialog).value, 'keep');
    assert.isTrue([...$('env-agents', dialog).querySelectorAll('input')].every((input) => !input.checked));
    assert.include(dialog.textContent, 'Share files with');
    assert.include(dialog.textContent, 'file or code permissions');
    assert.deepEqual(fixture.calls.map(({ name }) => name), ['getEnvironment'], 'opening settings does not provision');
    $('env-keep-files', dialog).checked = true;
    $('env-agents', dialog).querySelector('[value="researcher"]').checked = true;
    $('env-retention', dialog).value = 'delete-on-completion';
    fixture.missionId = 'mission-b'; fixture.missionChanged.changed(); flush();
    $('env-keep-files', dialog).dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal($('env-save-settings', dialog).textContent, 'Enable filesystem');
    fixture.response = async (name, input) => name === 'enableFilesystem' ? environment({ ...input }) : { ...input, status: 'not-created', savePoints: [] };
    submit($('env-settings-form', dialog));
    await waitUntil(() => $('env-message', dialog).textContent.includes('Settings saved'));
    assert.deepEqual(fixture.calls, [
      { name: 'getEnvironment', input: { missionId: 'mission-a' } },
      { name: 'saveEnvironment', input: { missionId: 'mission-a', keepFiles: true, allowedAgents: ['researcher'], retention: 'delete-on-completion' } },
      { name: 'enableFilesystem', input: { missionId: 'mission-a' } },
    ]);
    assert.isTrue(dialog.open);
    assert.equal(dialog.querySelector('.op-dialog-scope').textContent, 'Analysis mission');
    assert.include($('env-status-hint', dialog).textContent, 'Sprites');
  });

  it('links mission file sharing to central permissions and restores its captured draft', async () => {
    const dialog = fixture.controller.openEnvironment('mission-a');
    await waitUntil(() => !$('env-settings-fields', dialog).disabled);
    assert.isFalse($('env-connection', dialog).hidden);
    assert.equal($('env-open-connection', dialog).textContent, 'Connect Sprites');
    $('env-keep-files', dialog).checked = true;
    $('env-keep-files', dialog).dispatchEvent(new Event('change', { bubbles: true }));
    assert.isFalse($('env-no-grants', dialog).hidden);
    $('env-retention', dialog).value = 'delete-on-completion';
    const connectionOpener = $('env-open-connection', dialog); connectionOpener.focus(); connectionOpener.click();
    const connection = fixture.controller.dialogs.connection;
    assert.isTrue(connection.open); assert.isTrue(dialog.open);
    const closed = new Promise((resolve) => connection.addEventListener('close', resolve, { once: true }));
    connection.close(); await closed;
    assert.strictEqual(document.activeElement, connectionOpener);
    assert.isTrue($('env-keep-files', dialog).checked);
    assert.equal($('env-retention', dialog).value, 'delete-on-completion');
    assert.isNull($('env-agents', dialog).querySelector('button'), 'file-sharing rows do not contain another permission editor');
    assert.include($('env-agents', dialog).textContent, 'Files enabled · Code off');
    const selectedAgent = $('env-agents', dialog).querySelector('[value="researcher"]'); selectedAgent.checked = true;
    let parentRestored = false; fixture.navigationRestore = () => { parentRestored = true; };
    $('env-manage-permissions', dialog).click();
    assert.isFalse(dialog.open); assert.deepEqual(fixture.navigations, ['researcher']);
    assert.isFalse($('access-return').hidden);
    assert.include($('return-environment').textContent, 'Analysis mission');
    fixture.response = async (name, input) => {
      if (name === 'setAgentPolicy') fixture.settings.update('settings', { $set: { agentPolicies: { [input.agent]: input.policy } } });
      if (name === 'getEnvironment') return { keepFiles: false, allowedAgents: [], retention: 'keep', status: 'not-created', savePoints: [] };
      return {};
    };
    const row = fixture.root.querySelector('[data-agent="researcher"]');
    $('policy', row).value = 'ask'; $('policy', row).dispatchEvent(new Event('change'));
    await waitUntil(() => !$('policy', row).disabled); flush();
    fixture.missionId = 'mission-b'; fixture.missionChanged.changed(); flush();
    $('return-environment').click();
    await waitUntil(() => dialog.open && !$('env-settings-fields', dialog).disabled);
    assert.isTrue(parentRestored, 'return restores suspended parents before reopening the environment');
    assert.equal(dialog.querySelector('.op-dialog-scope').textContent, 'Analysis mission');
    assert.isTrue($('env-keep-files', dialog).checked);
    assert.equal($('env-retention', dialog).value, 'delete-on-completion');
    assert.include($('env-agents', dialog).textContent, 'Files enabled · Code asks first');
    assert.isTrue($('env-agents', dialog).querySelector('[value="researcher"]').checked, 'selected sharing draft is restored');
    assert.isFalse($('env-agents', dialog).querySelector('[value="orchestrator"]').checked, 'permissions never silently grant file sharing');
    assert.deepEqual(fixture.calls.map(({ name }) => name), ['getEnvironment', 'setAgentPolicy', 'getEnvironment']);
  });

  it('ignores stale environment settings metadata after changing context', async () => {
    const first = deferred(); const second = deferred();
    fixture.response = (name, input) => input.missionId === 'mission-a' ? first.promise : second.promise;
    const dialog = fixture.controller.openEnvironment('mission-a');
    fixture.controller.openEnvironment('mission-b');
    second.resolve(environment({ _id: 'environment-b', missionId: 'mission-b', allowedAgents: ['orchestrator'] }));
    await waitUntil(() => !$('env-settings-fields', dialog).disabled);
    first.resolve(environment()); await Promise.resolve(); flush();
    assert.equal(dialog.querySelector('.op-dialog-scope').textContent, 'Other mission');
    assert.isTrue($('env-agents', dialog).querySelector('[value="orchestrator"]').checked);
    assert.isFalse($('env-agents', dialog).querySelector('[value="researcher"]').checked);
  });

  it('saves named save points and confirms filesystem-only restoration without leaving the mission', async () => {
    const saved = deferred(); let value = environment();
    fixture.response = async (name) => {
      if (name === 'getEnvironment') return value;
      if (name === 'savePoint') return saved.promise;
      if (name === 'restoreSavePoint') return { ...value, savePoints: [...value.savePoints, { id: 'safety', label: 'Before restore', createdAt: new Date() }] };
      return {};
    };
    const dialog = fixture.controller.openEnvironment('mission-a', 'points');
    await waitUntil(() => !$('env-save-point', dialog).disabled);
    $('env-point-label', dialog).value = 'Before the change';
    submit($('env-point-form', dialog)); submit($('env-point-form', dialog));
    assert.isTrue($('env-point-label', dialog).disabled);
    assert.lengthOf(fixture.calls.filter(({ name }) => name === 'savePoint'), 1);
    value = environment({ savePoints: [{ id: 'point-1', label: 'Before the change', createdAt: new Date() }] });
    saved.resolve(value);
    await waitUntil(() => $('env-points', dialog).children.length === 1);
    const restore = $('env-points', dialog).querySelector('button'); restore.focus(); restore.click();
    const confirmation = fixture.controller.dialogs.environmentConfirm;
    assert.isTrue(confirmation.open); assert.isTrue(dialog.open);
    assert.include(confirmation.textContent, 'whole filesystem, including uploads, generated files');
    assert.include(confirmation.textContent, 'safety save point');
    assert.include(confirmation.textContent, 'linked files revert with the filesystem');
    assert.notInclude(fixture.calls.map(({ name }) => name), 'restoreSavePoint');
    const cancelled = new Promise((resolve) => confirmation.addEventListener('close', resolve, { once: true }));
    $('env-confirm-cancel', confirmation).click(); await cancelled;
    assert.strictEqual(document.activeElement, restore);
    restore.click(); $('env-confirm-action', confirmation).click();
    await waitUntil(() => !confirmation.open);
    assert.deepEqual(fixture.calls.at(-1), { name: 'restoreSavePoint', input: { missionId: 'mission-a', savePointId: 'point-1', confirm: true } });
    assert.include($('env-message', dialog).textContent, 'Chat history was not changed');
    assert.isTrue(dialog.open);
    assert.lengthOf($('env-points', dialog).children, 2);
  });

  it('reserves room for a safety save point and offers deletion when the list is full', async () => {
    let value = environment({ savePoints: Array.from({ length: 50 }, (_, index) => ({ id: `point-${index}`, label: `Version ${index}` })) });
    fixture.response = async (name, input) => name === 'deleteSavePoint'
      ? (value = { ...value, savePoints: value.savePoints.filter((point) => point.id !== input.savePointId) }) : value;
    const dialog = fixture.controller.openEnvironment('mission-a', 'points');
    await waitUntil(() => $('env-points', dialog).children.length === 50);
    assert.isTrue($('env-save-point', dialog).disabled);
    assert.isTrue($('env-points', dialog).querySelector('[data-point-action="restore"]').disabled);
    assert.include($('env-points-limit', dialog).textContent, 'safety save point');
    $('env-points', dialog).querySelector('[data-point-action="remove"]').click();
    const confirmation = fixture.controller.dialogs.environmentConfirm;
    assert.include(confirmation.textContent, 'Delete save point');
    assert.include(confirmation.textContent, 'cannot be undone');
    $('env-confirm-action', confirmation).click(); await waitUntil(() => !confirmation.open);
    assert.deepEqual(fixture.calls.at(-1), { name: 'deleteSavePoint', input: { missionId: 'mission-a', savePointId: 'point-0', confirm: true } });
    assert.isFalse($('env-save-point', dialog).disabled);
    assert.isFalse($('env-points', dialog).querySelector('[data-point-action="restore"]').disabled);
  });

  it('disables only unsupported save-point deletion and clears that limitation for a new environment', async () => {
    const point = { id: 'point-one', label: 'Original', available: true, healthy: true };
    const value = environment({ checkpointDeletionSupported: false, savePoints: [point] });
    fixture.environments.insert(value);
    fixture.response = async (name, input) => input.missionId === 'mission-a' ? value : environment({ missionId: input.missionId, workspaceId: 'new-environment', savePoints: [point] });
    const dialog = fixture.controller.openEnvironment('mission-a', 'points');
    assert.isTrue($('env-save-point', dialog).disabled, 'published rows do not unlock actions before the scoped load finishes');
    await waitUntil(() => $('env-points', dialog).children.length === 1 && !$('env-save-point', dialog).disabled);
    assert.isFalse($('env-point-deletion-unavailable', dialog).hidden);
    assert.include($('env-point-deletion-unavailable', dialog).textContent, 'Existing save points can still be restored');
    assert.isTrue($('env-points', dialog).querySelector('[data-point-action="remove"]').disabled);
    assert.isFalse($('env-points', dialog).querySelector('[data-point-action="restore"]').disabled);
    assert.isFalse($('env-points', dialog).querySelector('[data-point-action="browse"]').disabled);
    assert.isFalse($('env-save-point', dialog).disabled);
    fixture.environments.update(value._id, { $set: { savePoints: Array.from({ length: 50 }, (_, index) => ({ ...point, id: `point-${index}` })) } }); flush();
    assert.isFalse($('env-points-limit', dialog).hidden);
    assert.include($('env-points-limit', dialog).textContent, 'nothing is deleted automatically');
    assert.notInclude($('env-points-limit', dialog).textContent, 'Delete one');
    assert.isTrue($('env-save-point', dialog).disabled);
    fixture.controller.openEnvironment('mission-b', 'points');
    await waitUntil(() => $('env-points', dialog).querySelector('[data-point-action="remove"]')?.disabled === false);
    assert.isTrue($('env-point-deletion-unavailable', dialog).hidden);
    assert.isFalse($('env-points', dialog).querySelector('[data-point-action="remove"]').disabled);
    assert.notInclude(fixture.calls.map(({ name }) => name), 'deleteSavePoint');
  });

  it('routes save-point browsing to the mission Files surface without duplicating modal tabs', async () => {
    const value = environment({ savePoints: [{ id: 'point-1', label: 'Before cleanup', available: true }] });
    fixture.response = async (name) => name === 'getEnvironment' ? value : { path: '/workspace', entries: [] };
    const dialog = fixture.controller.openEnvironment('mission-a', 'points');
    await waitUntil(() => $('env-points', dialog).children.length === 1);
    assert.sameMembers([...dialog.querySelectorAll('[data-env-tab]')].map((button) => button.dataset.envTab), ['points', 'settings']);
    $('env-points', dialog).querySelector('[data-point-action="browse"]').click();
    await waitUntil(() => fixture.calls.some(({ name }) => name === 'environmentFiles'));
    assert.isFalse(dialog.open);
    assert.deepEqual(fixture.calls.at(-1), { name: 'environmentFiles', input: { missionId: 'mission-a', path: '/workspace', savePointId: 'point-1' } });
    assert.include(fixture.filesRoot.textContent, 'Before cleanup');
    assert.notInclude(fixture.calls.map(({ name }) => name), 'restoreSavePoint');
  });

  it('reviews connected API permissions and requires explicit approval of the exact snapshot', async () => {
    connected();
    const review = { status: 'checked', fingerprint: 'grants-one', connections: [{ id: 'repository', provider: 'GitHub', name: 'Research repository', scopes: ['contents:read'], policy: { allowedEndpoints: ['GET /repos/*'], blockedEndpoints: ['DELETE *'] } }] };
    fixture.response = async (name, input) => {
      if (name === 'reviewConnections') return { connectorReview: review };
      if (name === 'approveConnections') return { connectorReview: review, approvedConnectorFingerprint: input.fingerprint };
      return {};
    };
    const dialog = fixture.controller.openSettings();
    $('review-connections', dialog).click();
    await waitUntil(() => $('connector-list', dialog).textContent.includes('Research repository'));
    assert.include($('connector-list', dialog).textContent, 'contents:read');
    assert.include($('connector-list', dialog).textContent, 'GET /repos/*');
    assert.include($('connector-list', dialog).textContent, 'DELETE *');
    assert.isFalse($('approve-connections', dialog).hidden);
    assert.notInclude(fixture.calls.map(({ name }) => name), 'approveConnections');
    $('approve-connections', dialog).click();
    await waitUntil(() => $('approve-connections', dialog).hidden);
    assert.deepEqual(fixture.calls.at(-1), { name: 'approveConnections', input: { fingerprint: 'grants-one' } });
    assert.include($('connector-status', dialog).textContent, 'approved');
    fixture.settings.update('settings', { $set: { connectorReview: { ...review, fingerprint: 'grants-two' }, approvedConnectorFingerprint: 'grants-one' } }); flush();
    assert.isFalse($('approve-connections', dialog).hidden, 'new grants must not inherit old approval');
    localConnection(false);
    assert.isTrue($('review-connections', dialog).disabled); assert.isTrue($('approve-connections', dialog).disabled);
  });

  it('keeps one readable pending label and its spinner through reactive connection updates', async () => {
    const review = { status: 'checked', fingerprint: 'current-grants', connections: [{ id: 'files', provider: 'Files', name: 'Research', scopes: [] }] };
    connected({ connectorReview: review });
    const dialog = fixture.controller.openSettings();
    for (const [name, label] of [['review-connections', 'Reviewing…'], ['approve-connections', 'Allowing…'], ['test', 'Testing…']]) {
      const pending = deferred(); fixture.response = () => pending.promise;
      const button = $(name, dialog); button.click();
      assert.equal(button.dataset.loading, 'true'); assert.equal(button.textContent, label);
      fixture.settings.update('settings', { $set: { unrelated: name } }); flush();
      assert.equal(button.textContent, label); assert.equal(button.getAttribute('aria-label'), label);
      assert.equal(getComputedStyle(button, '::after').content, 'none', 'CSS must not paint or announce a second copy of the label');
      assert.equal(getComputedStyle(button, '::before').display, 'inline-block');
      assert.equal(getComputedStyle(button, '::before').position, 'static');
      assert.notEqual(getComputedStyle(button).color, 'rgba(0, 0, 0, 0)');
      localConnection(false);
      assert.equal(button.textContent, 'Waiting for local server…');
      assert.equal(button.getAttribute('aria-label'), 'Waiting for local server…');
      assert.equal(getComputedStyle(button, '::before').display, 'inline-block');
      localConnection(true);
      pending.resolve(name === 'test' ? { connected: true } : { connectorReview: review });
      await waitUntil(() => button.dataset.loading === 'false' && !button.disabled);
      assert.isNull(button.getAttribute('aria-label'));
    }
  });

  it('explains full mission-environment authority at both agent and saved-file grants', async () => {
    fixture.controller.openAgentAccess('researcher');
    assert.include(fixture.root.textContent, 'Code can change all files, packages, services and save points in its mission environment. It cannot access your computer.');
    const dialog = fixture.controller.openEnvironment('mission-a');
    await waitUntil(() => !$('env-settings-fields', dialog).disabled);
    assert.include($('env-settings-form', dialog).textContent, 'Code can change files, packages, services and save points in this mission filesystem. It cannot access your computer.');
  });


  it('keeps erased environments discoverable and never reports an unconfirmed deletion as success', async () => {
    const receipt = environment({ erasedAt: new Date(), status: 'needs-attention', error: 'Deletion needs another attempt.' });
    fixture.environments.insert(receipt); fixture.missionId = null; fixture.missionChanged.changed(); flush();
    assert.isFalse($('retained-environments').hidden);
    assert.include($('environment-list').textContent, 'Deleted mission');
    let attempts = 0;
    fixture.response = async (name) => name === 'getEnvironment' ? receipt
      : name === 'deleteEnvironment' && ++attempts === 1 ? receipt
        : { ...receipt, keepFiles: false, status: 'not-created', workspaceId: null, savePoints: [] };
    $('environment-list').querySelector('button').click();
    const dialog = fixture.controller.dialogs.environment;
    await waitUntil(() => !$('env-delete', dialog).disabled);
    assert.isTrue($('env-settings-fields', dialog).disabled);
    assert.include($('env-status-hint', dialog).textContent, 'deleted');
    $('env-delete', dialog).click();
    const confirmation = fixture.controller.dialogs.environmentConfirm;
    assert.include(confirmation.textContent, 'cannot be undone');
    assert.include(confirmation.textContent, 'turned off');
    assert.notInclude(fixture.calls.map(({ name }) => name), 'deleteEnvironment');
    $('env-confirm-action', confirmation).click();
    await waitUntil(() => !$('env-confirm-errors', confirmation).hidden);
    assert.isTrue(confirmation.open); assert.include(confirmation.textContent, 'Deletion needs another attempt');
    assert.notInclude($('env-message', dialog).textContent, 'deleted');
    $('env-confirm-action', confirmation).click(); await waitUntil(() => !confirmation.open);
    assert.deepEqual(fixture.calls.at(-1), { name: 'deleteEnvironment', input: { missionId: 'mission-a', confirm: true } });
    assert.include($('env-message', dialog).textContent, 'Remote environment deleted');
    assert.notInclude(fixture.calls.map(({ name }) => name), 'environmentFiles');
  });

  it('locks unknown settings on load errors and preserves drafts on save errors', async () => {
    fixture.response = async () => { throw new Error('PRIVATE TRANSPORT PAYLOAD'); };
    const dialog = fixture.controller.openEnvironment('mission-a');
    await waitUntil(() => !$('env-errors', dialog).hidden);
    assert.isTrue($('env-settings-fields', dialog).disabled);
    assert.isFalse($('env-reload', dialog).hidden);
    assert.notInclude(dialog.textContent, 'PRIVATE TRANSPORT PAYLOAD');
    fixture.response = async (name) => {
      if (name === 'saveEnvironment') throw { reason: 'Wait for the active run to finish.' };
      if (name === 'environmentFiles') return { path: '/workspace', entries: [{ name: 'recover.csv', path: '/workspace/recover.csv', type: 'file' }] };
      return environment({ status: 'needs-attention', recoveryKind: 'restore', error: 'Restore could not be confirmed.' });
    };
    $('env-reload', dialog).click(); await waitUntil(() => !$('env-settings-fields', dialog).disabled);
    assert.include($('env-status-hint', dialog).textContent, 'Restore could not be confirmed');
    $('env-retention', dialog).value = 'delete-on-completion';
    $('env-agents', dialog).querySelector('[value="orchestrator"]').checked = true;
    submit($('env-settings-form', dialog)); await waitUntil(() => $('env-errors', dialog).textContent.includes('Wait for'));
    assert.equal($('env-retention', dialog).value, 'delete-on-completion');
    assert.isTrue($('env-agents', dialog).querySelector('[value="orchestrator"]').checked);
    dialog.querySelector('[data-env-tab="points"]').click();
    assert.isTrue($('env-save-point', dialog).disabled);
  });


  it('does not browse a quarantined environment whose previous code run may still be active', async () => {
    fixture.response = async () => environment({ status: 'needs-attention', recoveryKind: 'run', error: 'Run status is unknown.' });
    const root = fixture.controller.openFiles('mission-a', { location: 'working' });
    await waitUntil(() => root.querySelector('[data-files="notice"]').textContent.includes('Check the status in Mission filesystem'));
    assert.isEmpty(root.querySelector('[data-files="list"]').children);
    assert.deepEqual(fixture.calls.map(({ name }) => name), ['missionFiles', 'getEnvironment']);
  });

  it('preserves environment drafts through live state changes and fences a save after reopening', async () => {
    const value = environment({ updatedAt: new Date(1000) }); fixture.environments.insert(value);
    const pending = deferred();
    fixture.response = async (name, input) => name === 'saveEnvironment' ? pending.promise : environment({ missionId: input.missionId, updatedAt: new Date(1000) });
    const dialog = fixture.controller.openEnvironment('mission-a');
    await waitUntil(() => !$('env-settings-fields', dialog).disabled);
    const checkbox = $('env-agents', dialog).querySelector('[value="orchestrator"]');
    checkbox.checked = true; checkbox.focus(); $('env-retention', dialog).value = 'delete-on-completion';
    fixture.environments.update(value._id, { $set: { status: 'busy', updatedAt: new Date(2000) } }); flush();
    assert.isTrue($('env-settings-fields', dialog).disabled);
    assert.isTrue(checkbox.checked); assert.equal($('env-retention', dialog).value, 'delete-on-completion');
    fixture.environments.update(value._id, { $set: { status: 'ready', updatedAt: new Date(3000) } }); flush();
    assert.strictEqual($('env-agents', dialog).querySelector('[value="orchestrator"]'), checkbox);
    assert.isTrue(checkbox.checked);
    submit($('env-settings-form', dialog));
    fixture.controller.openEnvironment('mission-b');
    await waitUntil(() => !$('env-settings-fields', dialog).disabled);
    pending.resolve(environment({ missionId: 'mission-a', retention: 'delete-on-completion', updatedAt: new Date(4000) }));
    await Promise.resolve(); await Promise.resolve(); flush();
    assert.equal(dialog.querySelector('.op-dialog-scope').textContent, 'Other mission');
    assert.equal($('env-retention', dialog).value, 'keep');
    assert.isTrue($('env-message', dialog).hidden);
  });

  it('keeps long working-file lists independently scrollable beside the viewer', async () => {
    fixture.response = async (name) => name === 'getEnvironment' ? environment() : { path: '/workspace', entries:
      Array.from({ length: 40 }, (_, index) => ({ name: `File ${index} ${'long name '.repeat(8)}.csv`, path: `/workspace/${index}.csv`, type: 'file', size: 100 })) };
    const root = fixture.controller.openFiles('mission-a', { location: 'working' });
    root.style.cssText = 'position:fixed;inset:30px auto auto 30px;width:900px;height:450px;';
    await waitUntil(() => root.querySelector('[data-files="list"]').children.length === 40);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const scroller = root.querySelector('.mission-files-list-pane');
    assert.equal(getComputedStyle(scroller).overflowY, 'auto');
    assert.isAbove(scroller.clientHeight, 40); assert.isAbove(scroller.scrollHeight, scroller.clientHeight);
    assert.isAtMost(scroller.scrollWidth, scroller.clientWidth + 1);
    const headerTop = root.querySelector('header').getBoundingClientRect().top;
    scroller.scrollTop = 200;
    assert.isAbove(scroller.scrollTop, 0); assert.equal(root.querySelector('header').getBoundingClientRect().top, headerTop);
  });
});
