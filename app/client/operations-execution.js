import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { createDialog, showDialog, busyAction } from './operations';
import { initializeExecutionEnvironments } from './execution-environments';
import { initializeCodeRuns } from './code-runs';
import './execution.css';

const policyLabels = { disabled: 'Off', ask: 'Ask every time', auto: 'Allowed' };
const agentId = (agent) => agent.agent ?? agent._id;
const errorText = (error, fallback) => typeof error?.reason === 'string' && error.reason.trim() ? error.reason : fallback;
const collection = (name) => Mongo.getCollection?.(name) ?? new Mongo.Collection(name);
const query = (root, name) => root.querySelector(`[data-execution="${name}"]`);
const defaults = { timeoutSeconds: 60, maxRunsPerMission: 20, maxOutputBytes: 64000, maxArtifactBytes: 5000000 };
const connectionRechecks = new Map();
const transientFailure = (error) => [408, 429, 500, 502, 503, 504, 'network-error', 'connection-error', 'connection-lost', 'timeout', 'server-unavailable'].includes(error?.error ?? error?.code);
const connectionFields = ['connectionStatus', 'connectionError', 'connectionErrorCode', 'connectionRetryable', 'connectionRecheckAt', 'connectionRecheckAfter', 'testedAt', 'connectorReview'];

/** Application UI only. Runs are created by the permission-checked agent tool. */
export function initializeExecution(host) {
  const root = host.root;
  const settings = host.settings ?? collection('constellation_execution_settings');
  const jobs = host.jobs ?? collection('constellation_execution_jobs');
  const environments = host.environments ?? collection('constellation_execution_environments');
  const method = host.method ?? ((name, args = {}) => Meteor.callAsync(`constellation.execution.${name}`, args));
  const localConnectionStatus = host.connectionStatus ?? (() => Meteor.status());
  const accountId = host.userId ?? (() => Meteor.userId());
  const recoveryEnabled = host.reconnectRecovery ?? host.subscribe !== false;
  const clock = host.recoveryClock ?? { now: () => Date.now(), setTimeout: (fn, delay) => window.setTimeout(fn, delay), clearTimeout: (timer) => window.clearTimeout(timer) };
  const subscribe = host.subscribe === false ? () => ({ ready: () => true, stop() {} })
    : host.subscribe ?? ((...args) => Meteor.subscribe(...args));
  const prefix = host.id ?? `execution-${window.crypto.randomUUID()}`;
  const changed = new Tracker.Dependency();
  const crewNodes = new Map();
  const policyStates = new Map();
  const cleanupNodes = new Map();
  const busyRegions = new Set();
  let disposed = false; let settingsFailed = false;
  let settingsSubscription = null, subscriptionGeneration = 0, subscriptionAttempts = 0, subscriptionTimer = null, subscriptionRetryable = false;
  let recoveryAccount = accountId(), wasOnline = localConnectionStatus()?.connected === true, recoveryGeneration = 0;
  let recheckWanted = false, recheckAttempts = 0, recheckTimer = null, automaticCheck = null, recoverySnapshot = null, recoveryRequestError = null;
  let recoveryBootPending = true;
  let savedTokenAvailable = false;
  let pendingConnectionAction = null; let retainConnectionDraft = false; let connectionMessageManual = false;
  let connectorSnapshot = null; let connectorPublication = null;
  let cleanupTimer = null; let cleanupWakeAt = null;
  let accessFocusFrame = null; let accessFocusTimer = null;
  let returnToEnvironment = null;
  // Injected collections without a userId getter are supported by isolated UI hosts.
  const config = () => settings.findOne(accountId() || '__signed-out__')
    ?? (host.settings && !host.userId ? settings.findOne() : null) ?? {};
  const crew = () => host.crew?.() ?? [];
  const agentName = (id) => crew().find((agent) => agentId(agent) === id)?.displayName ?? id ?? 'Agent';
  const missions = () => host.missions?.() ?? [];
  const missionName = (id) => host.missionTitle?.(id)
    || missions().find((mission) => (mission._id ?? mission.id) === id)?.title || 'Untitled mission';
  const notify = (text) => host.toast?.(text);
  root.classList.add('execution-panel');
  root.innerHTML = `<div class="execution-panel-scroll">
    <div class="execution-access-return" data-execution="access-return" hidden><p data-execution="access-return-description"></p><button type="button" class="secondary-action" data-execution="return-environment">Back to settings</button></div>
    <header class="execution-intro"><div><h2>Run code</h2><p>Let agents calculate, transform files, and create results in Sprites.</p></div><button type="button" class="secondary-action" data-execution="open-settings">Connection settings</button></header>
    <section class="execution-connection" aria-label="Sprites connection"><span class="execution-status" data-execution="connection-state" role="status"></span><p data-execution="connection-hint"></p><button type="button" class="primary-action" data-execution="connect">Connect Sprites</button></section>
    <section class="execution-access"><header><h3>Code permissions <span class="execution-scope-label">All missions</span></h3><p>Choose who can run code. Ask every time requires your approval before each run.</p></header><div class="execution-crew" data-execution="crew"></div><p class="execution-empty" data-execution="crew-empty" hidden>Add an agent to set its code permissions.</p><p class="execution-data-note execution-permission-note">Code can change all files, packages, services and save points in its mission environment. It cannot access your computer.</p></section>
    <section class="execution-retained" data-execution="retained-environments" hidden><h3>Saved environments</h3><p>Manage working files, save points, and access for each mission.</p><p data-execution="environment-list-error" role="alert" hidden>Saved environments could not be loaded. Reopen the app to try again.</p><div data-execution="environment-list"></div></section>
    <section class="execution-cleanup" data-execution="workspace-cleanup" hidden><h3>Remote workspaces</h3><p>These conversations were deleted before their remote workspaces could be removed.</p><div data-execution="cleanup-list"></div><div data-execution="cleanup-errors"></div></section>
    <section class="execution-about"><h3>Working files, your choice</h3><p>Code and selected files go to Fly.io’s Sprites. Workspaces are disposable by default. Each mission can keep its working files between runs and share them with selected agents.</p><p>Generated results are saved to the mission. Sprites bills for runs and retained storage.</p><button type="button" class="secondary-action" data-execution="open-work">View code runs</button></section>
  </div>`;
  const connection = createDialog(`${prefix}-connection`, 'Sprites connection', `<form data-execution="connection-form"><div class="op-scroll execution-form">
    <p class="execution-message" data-execution="connection-message" role="status"></p>
    <p class="execution-data-note execution-status" data-execution="connection-recovery" role="status" aria-live="polite" hidden></p>
    <p class="execution-data-note" data-execution="local-server-notice" role="status" aria-live="polite" hidden></p>
    <fieldset class="execution-fields"><label class="op-check"><input data-execution="enabled" type="checkbox">Allow agents to run code</label>
    <label>Sprites token<input data-execution="token" type="password" autocomplete="new-password" spellcheck="false" maxlength="4096"></label><p class="op-hint" data-execution="token-source"></p>
    <p class="execution-data-note">Enabling this sends code and selected files to Fly.io’s Sprites. Runs are billed to your Sprites account.</p>
    <label>Allowed websites<textarea data-execution="domains" rows="4" placeholder="example.com" spellcheck="false" aria-describedby="${prefix}-domains-hint"></textarea></label><p class="op-hint" id="${prefix}-domains-hint">One domain per line. Blank blocks ordinary websites. Separately granted connected APIs have their own access rules.</p>
    <section class="execution-connectors" aria-label="Connected APIs"><h3>Connected APIs</h3><p class="op-hint">These permissions are managed by your Sprites organization, separately from allowed websites and your model-spend limit. Code may use them without revealing credentials here.</p><p data-execution="connector-status" role="status"></p><ul data-execution="connector-list"></ul><div class="execution-inline-actions"><button type="button" class="secondary-action" data-execution="review-connections">Review access</button><button type="button" class="secondary-action" data-execution="approve-connections" hidden>Allow these connections for code</button></div></section>
    <div class="op-form-row"><label>Timeout (seconds)<input data-execution="timeout" type="number" min="1" max="300" step="1" required></label><label>Runs per mission<input data-execution="runs" type="number" min="1" max="100" step="1" required></label></div></fieldset>
    <div data-execution="connection-errors"></div></div><footer class="op-footer execution-footer"><button type="button" class="op-link" data-execution="clear-token" hidden>Remove saved token</button><button type="button" class="secondary-action" data-execution="test">Test connection</button><button type="submit" class="primary-action" data-execution="save">Save connection</button></footer></form>`, 'execution-dialog');
  const work = createDialog(`${prefix}-work`, 'All code runs', '<div data-execution="global-runs"></div>', 'execution-dialog code-runs-global-dialog');
  work.querySelector('.op-dialog-scope').textContent = 'All missions';
  const dialogs = { connection, work };
  const runsHost = { jobs, method, subscribe, connectionStatus: localConnectionStatus, crew, missions, agentName, missionName,
    attachmentUrl: host.attachmentUrl, download: host.download,
    openEnvironment: (id) => environmentControls.openEnvironment(id),
    navigateToMissionWork: (tab, id, options) => { if (work.open) work.close(); host.navigateToMissionWork?.(tab, id, options); } };
  const missionRuns = host.runsRoot ? initializeCodeRuns({ ...runsHost, root: host.runsRoot }) : null;
  const globalRuns = initializeCodeRuns({ ...runsHost, root: query(work, 'global-runs'), global: true });

  function setMissionWork({ missionId, tab, options = {} }) {
    if (disposed) return;
    missionRuns?.setActive({ missionId, active: tab === 'runs', jobId: options.jobId });
    environmentControls.setActive?.({ missionId, tab, options });
  }
  function openRun(jobId, missionId) {
    if (!jobId || !missionId || disposed) return null;
    host.navigateToMissionWork?.('runs', missionId, { jobId });
    setMissionWork({ missionId, tab: 'runs', options: { jobId } });
    return host.runsRoot ?? null;
  }
  function openWorkspace() {
    if (disposed) return null;
    showDialog(work); globalRuns.setActive({ active: true }); return work;
  }

  async function action(control, region, label, operation) {
    if (disposed || busyRegions.has(region)) return;
    busyRegions.add(region);
    const form = region.closest('form');
    const fields = form?.querySelector('fieldset');
    form?.setAttribute('aria-busy', 'true');
    if (fields) fields.disabled = true;
    try {
      return await busyAction(control, region, label, async () => {
        try { return await operation(); }
        catch (error) { throw { reason: errorText(error, 'Could not complete this action. Try again.') }; }
      });
    } finally {
      busyRegions.delete(region);
      form?.setAttribute('aria-busy', 'false');
      if (fields) fields.disabled = false;
      if (!disposed) changed.changed();
    }
  }

  function connectionState(value, includeLocalServer = true) {
    value = connectionValue(value);
    if (includeLocalServer && !localServerConnected()) return ['Local server disconnected', 'Waiting for the local app server. This is separate from your Sprites connection.'];
    if (settingsFailed) return ['Settings unavailable', subscriptionTimer !== null ? 'Connection settings could not be loaded. Retrying shortly…' : 'Connection settings could not be loaded. Reconnect the local app or reopen it to retry.'];
    if (!settingsSubscription?.ready()) return ['Loading…', 'Loading connection settings.'];
    if (automaticCheck) return ['Checking connection…', 'Checking the saved Sprites connection. Your permissions are unchanged.'];
    if (recoveryRequestError) return ['Connection check interrupted', recoveryRequestError.retryable
      ? recheckTimer !== null ? 'The local server could not complete the check. Retrying shortly…' : 'The local server could not complete the check. Try Test connection again.'
      : 'The connection could not be checked. Check your local sign-in and use Test connection.'];
    if (!value.providerConfigured) return ['Not connected', 'Add a Sprites token to enable code runs.'];
    if (value.connectionStatus === 'error') {
      const failures = {
        'key-rejected': ['Token not accepted', 'Replace the saved token in connection settings, then test it.'],
        'token-locked': ['Token unavailable', 'Unlock this computer’s credential store, then test the connection.'],
        'token-required': ['Token required', 'Add a Sprites token in connection settings, then test it.'],
        'network-error': ['Sprites unreachable', 'Check your internet connection, then test the saved connection.'],
        'provider-busy': ['Sprites temporarily unavailable', 'Sprites is busy. Try Test connection again shortly.'],
        'provider-error': ['Sprites unavailable', 'Sprites returned an error. Try Test connection again shortly.'],
      };
      const [state, hint] = failures[value.connectionErrorCode] ?? ['Connection needs attention', 'Open connection settings and test your saved token.'];
      return [state, recheckTimer !== null ? 'Checking again shortly. Your token and permissions are unchanged.' : hint];
    }
    if (!value.enabled) return ['Paused', 'Existing work remains available. Enable code runs in connection settings.'];
    if (value.connectionStatus !== 'connected') return ['Token saved', 'Test the connection before asking an agent to run code.'];
    if (value.connectorReview && (value.connectorReview.status !== 'checked' || value.connectorReview.connections?.length && value.approvedConnectorFingerprint !== value.connectorReview.fingerprint)) return ['Review connected APIs', 'Open connection settings to review connected API permissions before starting code or services.'];
    return ['Connected', 'Ready for agents with code access.'];
  }

  function openSettings() {
    if (disposed) return null;
    if (pendingConnectionAction || retainConnectionDraft) {
      renderConnectionTransport(); showDialog(connection); return connection;
    }
    connectionMessageManual = false;
    const value = config(); const limits = { ...defaults, ...value.limits };
    savedTokenAvailable = value.providerConfigured === true;
    query(connection, 'enabled').checked = value.enabled === true;
    query(connection, 'token').value = '';
    query(connection, 'token').disabled = value.canStoreSecret === false;
    query(connection, 'token').placeholder = value.providerConfigured ? 'Leave blank to keep the saved token' : 'Paste your Sprites token';
    query(connection, 'domains').value = (value.domains ?? []).join('\n');
    query(connection, 'timeout').value = String(limits.timeoutSeconds);
    query(connection, 'runs').value = String(limits.maxRunsPerMission);
    query(connection, 'connection-errors').replaceChildren();
    renderConnectionInfo();
    showDialog(connection);
    return connection;
  }

  function renderConnectionInfo() {
    const value = { ...config(), providerConfigured: config().providerConfigured || savedTokenAvailable };
    query(connection, 'connection-message').textContent = connectionState(value, false)[0];
    query(connection, 'token-source').textContent = value.keySource === 'shell'
      ? 'Using SPRITES_TOKEN from this computer’s environment.'
      : value.canStoreSecret === false
        ? 'Open the desktop app to save a token securely, or set SPRITES_TOKEN before starting the server.'
        : value.providerConfigured ? 'A token is saved on this computer. It is never shown to agents.' : 'The token is stored securely on this computer and is never shown to agents.';
    query(connection, 'clear-token').hidden = !value.providerConfigured || value.keySource === 'shell';
    syncSaveLabel();
  }

  function syncSaveLabel() {
    renderConnectionTransport();
  }

  function localServerConnected() {
    return localConnectionStatus()?.connected === true;
  }

  function connectionValue(value = config()) {
    const snapshot = recoverySnapshot;
    if (!snapshot || snapshot.account !== accountId() || value._id !== snapshot.account || !value.providerConfigured
      || value.connectionStatus === 'untested' || !value.testedAt
      || new Date(value.testedAt).getTime() > new Date(snapshot.value.testedAt).getTime()) return value;
    // A caller may already hold an overlaid value. Only the real publication
    // can acknowledge the snapshot; otherwise a rejected token becomes stale
    // "connected" data again on the next render or reconnect.
    const published = config();
    if (published._id === snapshot.account
      && connectionFields.every((key) => JSON.stringify(published[key]) === JSON.stringify(snapshot.value[key]))) {
      recoverySnapshot = null; return value;
    }
    return { ...value, ...Object.fromEntries(connectionFields.map((key) => [key, snapshot.value[key]])) };
  }

  function clearRecoveryTimers() {
    if (recheckTimer !== null) clock.clearTimeout(recheckTimer);
    if (subscriptionTimer !== null) clock.clearTimeout(subscriptionTimer);
    recheckTimer = null; subscriptionTimer = null;
  }

  function retrySettingsSubscription() {
    if (!recoveryEnabled || disposed || !localServerConnected() || !accountId() || !settingsFailed || !subscriptionRetryable
      || subscriptionTimer !== null || subscriptionAttempts >= 3) return;
    const owner = accountId(), generation = subscriptionGeneration;
    subscriptionTimer = clock.setTimeout(() => {
      subscriptionTimer = null;
      if (disposed || owner !== accountId() || generation !== subscriptionGeneration || !localServerConnected()) return;
      subscriptionAttempts += 1; startSettingsSubscription();
    }, [1000, 5000, 15000][subscriptionAttempts]);
  }

  function startSettingsSubscription() {
    const generation = ++subscriptionGeneration, owner = accountId();
    settingsSubscription?.stop();
    const current = () => !disposed && generation === subscriptionGeneration && owner === accountId();
    const failed = (error) => {
      if (!current() || settingsFailed) return;
      settingsFailed = true; subscriptionRetryable = transientFailure(error);
      retrySettingsSubscription(); changed.changed();
    };
    settingsFailed = false;
    settingsSubscription = subscribe('constellation.execution', {
      onReady() {
        if (!current()) return;
        settingsFailed = false; subscriptionRetryable = false; subscriptionAttempts = 0;
        if (subscriptionTimer !== null) clock.clearTimeout(subscriptionTimer);
        subscriptionTimer = null; changed.changed();
      },
      onError: failed,
      onStop(error) { if (error) failed(error); },
    });
    changed.changed();
  }

  function scheduleRecheck(value) {
    if (recheckAttempts >= 3 || value.connectionRetryable !== true || !localServerConnected()) return;
    const owner = accountId(), generation = recoveryGeneration;
    const throttle = new Date(value.connectionRecheckAfter ?? 0).getTime() - clock.now();
    recheckTimer = clock.setTimeout(() => {
      recheckTimer = null;
      if (disposed || generation !== recoveryGeneration || owner !== accountId()) return;
      recheckWanted = true; changed.changed();
    }, Math.max(recheckAttempts === 1 ? 30000 : 60000, Number.isFinite(throttle) ? throttle : 0));
  }

  async function recheckConnection() {
    const owner = accountId(), generation = recoveryGeneration;
    const pending = { owner, generation }; automaticCheck = pending; recheckWanted = false; recheckAttempts += 1; changed.changed();
    const current = () => !disposed && owner === accountId() && generation === recoveryGeneration && automaticCheck === pending;
    try {
      let request = connectionRechecks.get(owner);
      if (!request) {
        request = Promise.resolve().then(() => method('recheckConnection', {}));
        connectionRechecks.set(owner, request);
        void request.finally(() => { if (connectionRechecks.get(owner) === request) connectionRechecks.delete(owner); }).catch(() => {});
      }
      const result = await request;
      if (!current()) return;
      recheckWanted = false;
      if (result?._id !== owner) return;
      recoveryRequestError = null;
      recoverySnapshot = { account: owner, value: result };
      scheduleRecheck(result);
    } catch (error) {
      if (!current()) return;
      recheckWanted = false;
      // Authentication and validation failures require a person, never a retry loop.
      recoveryRequestError = { retryable: transientFailure(error) };
      if (transientFailure(error)) scheduleRecheck({ connectionRetryable: true });
    } finally {
      if (current()) { automaticCheck = null; changed.changed(); }
    }
  }

  function renderConnectedAPIs() {
    const value = connectionValue(); const published = JSON.stringify([value.connectorReview, value.approvedConnectorFingerprint]);
    if (published !== connectorPublication) { connectorPublication = published; connectorSnapshot = null; }
    const snapshot = connectorSnapshot ?? value; const review = snapshot.connectorReview;
    const connections = review?.status === 'checked' && Array.isArray(review.connections) ? review.connections : [];
    const approved = !!review?.fingerprint && snapshot.approvedConnectorFingerprint === review.fingerprint;
    query(connection, 'connector-status').textContent = review?.status === 'checked'
      ? !connections.length ? 'No connected APIs are currently available to code.' : approved ? 'These connected API permissions are approved for code.' : 'Review these permissions before allowing code to use them. New runs and services wait for your approval.'
      : review?.error || 'Review the connected APIs available to this Sprites account before running code.';
    const list = query(connection, 'connector-list'); const signature = JSON.stringify(connections);
    if (list.dataset.contents !== signature) {
      list.dataset.contents = signature;
      list.replaceChildren(...connections.map((item) => {
        const row = document.createElement('li'); const heading = document.createElement('strong');
        heading.textContent = [item.provider, item.name || item.id].filter(Boolean).join(' · '); row.append(heading);
        const scopes = document.createElement('p'); scopes.textContent = `Scopes: ${Array.isArray(item.scopes) && item.scopes.length ? item.scopes.join(', ') : 'Not specified by provider'}`; row.append(scopes);
        const policy = item.policy ?? {};
        const details = [policy.allowAll === true ? 'All endpoints allowed' : null,
          policy.namePrefix ? `Name prefix: ${policy.namePrefix}` : null,
          Array.isArray(policy.labels) && policy.labels.length ? `Labels: ${policy.labels.join(', ')}` : null,
          Array.isArray(policy.allowedEndpoints) && policy.allowedEndpoints.length ? `Allowed endpoints: ${policy.allowedEndpoints.join(', ')}` : null,
          Array.isArray(policy.blockedEndpoints) && policy.blockedEndpoints.length ? `Blocked endpoints: ${policy.blockedEndpoints.join(', ')}` : null].filter(Boolean);
        if (details.length) { const summary = document.createElement('p'); summary.textContent = details.join(' · '); row.append(summary); }
        return row;
      }));
    }
    const approve = query(connection, 'approve-connections');
    approve.hidden = !connections.length || approved || !review?.fingerprint;
    approve.dataset.fingerprint = review?.fingerprint ?? '';
  }

  function renderConnectionTransport() {
    renderConnectedAPIs();
    const status = localConnectionStatus(); const online = status?.connected === true;
    const pending = pendingConnectionAction;
    if (!connectionMessageManual && !pending) query(connection, 'connection-message').textContent = connectionState(config(), false)[0];
    const recoveryNotice = query(connection, 'connection-recovery');
    recoveryNotice.dataset.state = automaticCheck ? 'preparing' : 'unknown';
    recoveryNotice.setAttribute('aria-busy', String(!!automaticCheck));
    const recoveryError = recoverySnapshot?.account === accountId() && connectionValue().connectionStatus === 'error';
    recoveryNotice.hidden = !online || (!automaticCheck && recheckTimer === null && !recoveryError && !recoveryRequestError);
    recoveryNotice.textContent = !online ? '' : automaticCheck ? 'Checking the saved Sprites connection…'
      : recoveryError || recoveryRequestError ? connectionState(config(), false).join('. ') : recheckTimer !== null ? 'Checking the saved connection shortly…' : '';
    if (pending && !online) pending.disconnected = true;
    const notice = query(connection, 'local-server-notice');
    const reconnecting = ['connecting', 'waiting'].includes(status?.status);
    notice.hidden = online && !pending?.disconnected;
    notice.textContent = !online
      ? `The local app server is disconnected.${reconnecting ? ' Reconnecting…' : ' Waiting for it to reconnect.'} ${pending
        ? 'Your request is still pending; do not submit it again. You can close this dialog and reopen it.'
        : 'Your draft is kept here. Saving and testing will be available after reconnection.'} This is not a Sprites error.`
      : pending?.disconnected ? 'The local app server reconnected. Waiting for confirmation of your existing request; do not submit it again.' : '';
    const labels = { save: query(connection, 'enabled').checked ? 'Save & test' : 'Save connection',
      test: 'Test connection', 'clear-token': 'Remove saved token', 'review-connections': 'Review access',
      'approve-connections': 'Allow these connections for code' };
    for (const [name, label] of Object.entries(labels)) {
      const control = query(connection, name);
      control.disabled = !online || !!pending || !!automaticCheck || settingsFailed || !settingsSubscription?.ready()
        || (['test', 'review-connections', 'approve-connections'].includes(name) && !config().providerConfigured && !savedTokenAvailable);
      const active = pending?.control === control;
      const nextLabel = active ? !online ? 'Waiting for local server…' : pending.disconnected ? 'Awaiting confirmation…' : pending.label : label;
      if (control.textContent !== nextLabel) control.textContent = nextLabel;
      if (active) {
        control.dataset.loadingLabel = control.textContent;
        control.setAttribute('aria-label', control.textContent);
      }
    }
  }

  async function connectionAction(control, label, operation) {
    renderConnectionTransport();
    if (disposed || !localServerConnected() || pendingConnectionAction || automaticCheck || settingsFailed || !settingsSubscription?.ready()) return;
    if (recheckTimer !== null) clock.clearTimeout(recheckTimer);
    recheckTimer = null; recheckWanted = false; recoverySnapshot = null; recoveryRequestError = null;
    connectionMessageManual = true;
    const pending = { control, label, disconnected: false }; pendingConnectionAction = pending;
    let completed = false;
    const task = action(control, query(connection, 'connection-errors'), label, async () => {
      await operation(); completed = true;
    });
    renderConnectionTransport();
    try { await task; }
    finally {
      if (pendingConnectionAction === pending) {
        pendingConnectionAction = null;
        if (completed) recheckWanted = false;
        if (completed && !connection.open) retainConnectionDraft = false;
      }
      if (!disposed) { renderConnectionTransport(); changed.changed(); }
    }
  }

  async function testSavedConnection() {
    const result = await method('testConnection', {});
    if (result?.connected === false || result?.ok === false) throw { reason: 'Sprites could not be reached. Check the token and try again.' };
  }

  function focusAgentAccess(agent) {
    if (disposed) return null;
    const row = crewNodes.get(agent) ?? (!agent ? crewNodes.values().next().value : null);
    if (!row) { if (agent) notify('Select an available agent first.'); return null; }
    window.cancelAnimationFrame(accessFocusFrame); window.clearTimeout(accessFocusTimer);
    for (const node of crewNodes.values()) node.classList.remove('is-targeted');
    row.classList.add('is-targeted');
    accessFocusFrame = window.requestAnimationFrame(() => {
      if (disposed || !row.isConnected) return;
      row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      query(row, 'policy').focus({ preventScroll: true });
      accessFocusTimer = window.setTimeout(() => row.classList.remove('is-targeted'), 2400);
    });
    return row;
  }

  // Compatibility entry point: callers navigate to the one workspace editor.
  // This must never open a second permission form inside another context.
  function openAgentAccess(agent, context) {
    if (disposed) return null;
    if (agent && !crew().some((candidate) => agentId(candidate) === agent)) { notify('Select an available agent first.'); return null; }
    // Each entry point owns its return path. A previous visit may have been
    // abandoned by navigating away, so never compose with that stale draft.
    setNavigationReturn(context ?? null);
    const restoreParent = host.navigateToCode?.(agent);
    if (typeof restoreParent === 'function') {
      const restoreChild = returnToEnvironment;
      if (restoreChild) returnToEnvironment = () => { if (restoreParent() !== false) restoreChild(); };
      else setNavigationReturn({ label: restoreParent.label || 'Back to settings', onReturn: restoreParent });
    }
    return focusAgentAccess(agent);
  }

  function setNavigationReturn(context) {
    returnToEnvironment = typeof context?.onReturn === 'function' ? context.onReturn : null;
    query(root, 'access-return').hidden = !returnToEnvironment;
    query(root, 'access-return-description').textContent = context?.description || 'Your settings draft is kept.';
    query(root, 'return-environment').textContent = context?.label || 'Back to settings';
  }

  async function saveAgentPolicy(agent, run) {
    if (disposed || policyStates.get(agent)?.pending || !localServerConnected() || !Object.hasOwn(policyLabels, run)) return;
    const prior = config().agentPolicies?.[agent]?.run ?? 'disabled';
    const state = { pending: true, run, observed: prior, error: '' };
    policyStates.set(agent, state); changed.changed();
    try {
      const saved = await method('setAgentPolicy', { agent, policy: { run } });
      if (disposed || policyStates.get(agent) !== state) return;
      state.run = Object.hasOwn(policyLabels, saved?.run) ? saved.run : run;
      state.confirmed = true;
    } catch (error) {
      if (disposed || policyStates.get(agent) !== state) return;
      state.error = errorText(error, 'Could not save this permission. Try again.');
    } finally {
      if (!disposed && policyStates.get(agent) === state) { state.pending = false; changed.changed(); }
    }
  }

  function renderWorkspaceCleanup() {
    const receipts = jobs.find({ erasedAt: { $exists: true }, cleanupPending: true }, { sort: { erasedAt: -1 } }).fetch();
    query(root, 'workspace-cleanup').hidden = !receipts.length;
    const ids = new Set(receipts.map((receipt) => receipt._id));
    for (const [id, node] of cleanupNodes) if (!ids.has(id)) { node.remove(); cleanupNodes.delete(id); }
    let nextWake = null;
    for (const receipt of receipts) {
      let row = cleanupNodes.get(receipt._id);
      if (!row) {
        row = document.createElement('div'); row.className = 'execution-cleanup-row'; row.dataset.jobId = receipt._id;
        row.innerHTML = '<div><strong>Deleted conversation</strong><span></span></div><button type="button" class="secondary-action">Retry cleanup</button>';
        row.querySelector('button').addEventListener('click', (event) => void action(event.currentTarget,
          query(root, 'cleanup-errors'), 'Removing…', async () => {
            await method('cleanup', { jobId: receipt._id });
            if (!disposed) notify('Remote workspace cleanup requested.');
          }));
        cleanupNodes.set(receipt._id, row); query(root, 'cleanup-list').append(row);
      }
      const retryAt = new Date(receipt.cleanupRetryAfter ?? 0).getTime();
      const waiting = retryAt > Date.now();
      if (waiting) nextWake = nextWake === null ? retryAt : Math.min(nextWake, retryAt);
      row.querySelector('span').textContent = `${agentName(receipt.agent)} · ${waiting ? 'Cleanup will be available shortly' : 'Cleanup needed'}`;
      const button = row.querySelector('button');
      if (button.dataset.loading !== 'true') {
        button.disabled = waiting || busyRegions.has(query(root, 'cleanup-errors'));
        button.textContent = waiting ? 'Available shortly' : 'Retry cleanup';
      }
    }
    if (nextWake !== cleanupWakeAt) {
      window.clearTimeout(cleanupTimer); cleanupWakeAt = nextWake;
      cleanupTimer = nextWake === null ? null : window.setTimeout(() => {
        cleanupWakeAt = null; cleanupTimer = null;
        if (!disposed) changed.changed();
      }, Math.max(1, nextWake - Date.now()));
    }
  }

  query(root, 'open-settings').addEventListener('click', openSettings);
  query(root, 'connect').addEventListener('click', openSettings);
  query(root, 'open-work').addEventListener('click', openWorkspace);
  query(connection, 'enabled').addEventListener('change', syncSaveLabel);
  query(connection, 'connection-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const token = query(connection, 'token').value.trim();
    const input = { enabled: query(connection, 'enabled').checked,
      domains: query(connection, 'domains').value.split(/\r?\n/).map((domain) => domain.trim()).filter(Boolean),
      limits: { ...defaults, ...config().limits, timeoutSeconds: Number(query(connection, 'timeout').value), maxRunsPerMission: Number(query(connection, 'runs').value) },
      ...(token ? { token } : {}) };
    void connectionAction(query(connection, 'save'), input.enabled ? 'Saving & testing…' : 'Saving…', async () => {
      if (input.enabled && !token && !config().providerConfigured && !savedTokenAvailable) {
        throw { reason: 'Add a Sprites token before enabling code runs.' };
      }
      const saved = await method('saveSettings', input);
      if (disposed) return;
      savedTokenAvailable = !!(token || saved?.providerConfigured || config().providerConfigured || savedTokenAvailable);
      query(connection, 'token').value = '';
      renderConnectionInfo();
      if (input.enabled && savedTokenAvailable) {
        if (!localServerConnected()) {
          query(connection, 'connection-message').textContent = 'Settings saved. Test the connection after the local app server reconnects.';
          return;
        }
        pendingConnectionAction.label = 'Testing…'; pendingConnectionAction.disconnected = false; renderConnectionTransport();
        query(connection, 'connection-message').textContent = 'Settings saved. Testing connection…';
        try { await testSavedConnection(); }
        catch (error) {
          if (!disposed) query(connection, 'connection-message').textContent = localServerConnected()
            ? 'Settings saved. Connection needs attention.' : 'Settings saved. The local app server disconnected before testing was confirmed.';
          throw error;
        }
      }
      if (disposed || !connection.open) return;
      connection.close(); notify(input.enabled ? 'Sprites connected.' : 'Sprites connection saved.');
    });
  });
  query(connection, 'test').addEventListener('click', (event) => void connectionAction(event.currentTarget, 'Testing…', async () => {
    if (query(connection, 'token').value.trim()) throw { reason: 'Save your new token before testing the connection.' };
    await testSavedConnection();
    if (disposed || !connection.open) return;
    query(connection, 'connection-message').textContent = 'Connection confirmed.';
    notify('Sprites connection confirmed.');
  }));
  query(connection, 'clear-token').addEventListener('click', (event) => void connectionAction(event.currentTarget, 'Removing…', async () => {
    await method('saveSettings', { enabled: false, clearToken: true });
    if (!disposed) { query(connection, 'token').value = ''; connection.close(); notify('Saved Sprites token removed.'); }
  }));
  for (const [name, methodName, label] of [['review-connections', 'reviewConnections', 'Reviewing…'], ['approve-connections', 'approveConnections', 'Allowing…']]) {
    query(connection, name).addEventListener('click', (event) => {
      const fingerprint = query(connection, 'approve-connections').dataset.fingerprint;
      if (name === 'approve-connections' && (!fingerprint || query(connection, name).hidden)) return;
      void connectionAction(event.currentTarget, label, async () => {
        if (query(connection, 'token').value.trim()) throw { reason: 'Save your new token before reviewing connected APIs.' };
        const result = await method(methodName, name === 'approve-connections' ? { fingerprint } : {});
        if (disposed || !connection.open) return;
        connectorPublication = JSON.stringify([config().connectorReview, config().approvedConnectorFingerprint]);
        connectorSnapshot = result; renderConnectionTransport();
      });
    });
  }
  connection.addEventListener('close', () => {
    if (connection.open) return;
    retainConnectionDraft = !!pendingConnectionAction;
    if (!retainConnectionDraft) query(connection, 'token').value = '';
  });
  query(root, 'return-environment').addEventListener('click', () => {
    const restore = returnToEnvironment; setNavigationReturn(null); restore?.();
  });
  work.addEventListener('close', () => { if (!work.open) globalRuns.setActive({ active: false }); });
  startSettingsSubscription();
  const environmentControls = initializeExecutionEnvironments({ root, environments, method, subscribe, prefix,
    crew, missionCrew: host.missionCrew, missionName, config, openSettings, openAgentAccess,
    filesRoot: host.filesRoot, servicesRoot: host.servicesRoot, openRun, navigateToMissionWork: host.navigateToMissionWork,
    connected: localServerConnected, toast: notify, downloadFile: host.downloadEnvironmentFile, openPreview: host.openPreview });
  Object.assign(dialogs, environmentControls.dialogs);
  const recoveryComputation = Tracker.autorun(() => {
    changed.depend();
    const owner = accountId(), online = localServerConnected();
    if (owner !== recoveryAccount) {
      recoveryAccount = owner; recoveryGeneration += 1; clearRecoveryTimers();
      recheckAttempts = 0; recheckWanted = false; automaticCheck = null; recoverySnapshot = null; recoveryRequestError = null; recoveryBootPending = true;
      connectorSnapshot = null; connectorPublication = null; savedTokenAvailable = false;
      subscriptionAttempts = 0; subscriptionRetryable = false; wasOnline = online;
      Tracker.nonreactive(startSettingsSubscription);
    }
    if (!online) {
      clearRecoveryTimers();
    } else if (!wasOnline) {
      recheckAttempts = automaticCheck ? 1 : 0; recheckWanted = !automaticCheck; subscriptionAttempts = 0;
      retrySettingsSubscription();
    }
    wasOnline = online;
    const value = connectionValue();
    if (recoveryBootPending && online && owner && !settingsFailed && settingsSubscription?.ready() && value._id === owner) {
      recoveryBootPending = false;
      if (value.providerConfigured && value.testedAt && value.connectionStatus === 'error' && value.connectionRetryable === true) recheckWanted = true;
    }
    if (!recoveryEnabled || !recheckWanted || !online || !owner || settingsFailed || !settingsSubscription?.ready()
      || pendingConnectionAction || automaticCheck) return;
    if (value._id !== owner || !value.providerConfigured || !value.testedAt
      || !(value.connectionStatus === 'connected' || value.connectionStatus === 'error' && value.connectionRetryable === true)) {
      recheckWanted = false; return;
    }
    const throttle = new Date(value.connectionRecheckAfter ?? 0).getTime() - clock.now();
    if (throttle > 0) {
      if (recheckTimer === null) recheckTimer = clock.setTimeout(() => { recheckTimer = null; changed.changed(); }, throttle);
      return;
    }
    void Tracker.nonreactive(recheckConnection);
  });
  const renderComputation = Tracker.autorun(() => {
    changed.depend(); const value = connectionValue();
    const [state, hint] = connectionState(value);
    query(root, 'connection-state').textContent = state;
    query(root, 'connection-state').dataset.state = !localServerConnected() || settingsFailed || recoveryRequestError ? 'unknown' : automaticCheck ? 'preparing' : value.connectionStatus ?? 'untested';
    query(root, 'connection-state').setAttribute('aria-busy', String(!!automaticCheck));
    query(root, 'connection-hint').textContent = hint;
    query(root, 'connect').hidden = value.providerConfigured === true;
    renderConnectionTransport();
    const members = crew(); const ids = new Set(members.map(agentId));
    for (const [id, row] of crewNodes) if (!ids.has(id)) { row.remove(); crewNodes.delete(id); policyStates.delete(id); }
    query(root, 'crew-empty').hidden = !!members.length;
    for (const member of members) {
      const id = agentId(member); let row = crewNodes.get(id);
      if (!row) {
        row = document.createElement('div'); row.className = 'execution-crew-row'; row.dataset.agent = id;
        row.innerHTML = '<div class="execution-crew-identity"><strong></strong><span data-execution="crew-policy"></span></div><div class="execution-policy-control"><select data-execution="policy"><option value="disabled">Off</option><option value="ask">Ask every time</option><option value="auto">Allowed</option></select><span data-execution="policy-status" role="status" aria-live="polite"></span></div><div class="execution-policy-error" data-execution="policy-error" hidden><p role="alert"></p><button type="button" class="op-link" data-execution="retry-policy">Retry</button></div>';
        query(row, 'policy').addEventListener('change', (event) => void saveAgentPolicy(id, event.currentTarget.value));
        query(row, 'retry-policy').addEventListener('click', () => void saveAgentPolicy(id, policyStates.get(id)?.run));
        crewNodes.set(id, row); query(root, 'crew').append(row);
      }
      row.querySelector('strong').textContent = member.displayName ?? id;
      const published = value.agentPolicies?.[id]?.run ?? 'disabled';
      let state = policyStates.get(id);
      if (state?.confirmed && !state.pending && published !== state.observed) {
        policyStates.delete(id); state = null;
      }
      const policy = state?.pending || state?.confirmed ? state.run : published;
      query(row, 'crew-policy').textContent = policy === 'ask' ? 'Your approval before each run' : policy === 'auto' ? 'Runs without asking' : 'Cannot run code';
      const select = query(row, 'policy'); select.value = Object.hasOwn(policyLabels, policy) ? policy : 'disabled';
      select.disabled = !!state?.pending || !localServerConnected() || settingsFailed || !settingsSubscription.ready();
      select.setAttribute('aria-label', `${member.displayName ?? id} code permission for all missions`);
      row.setAttribute('aria-busy', String(!!state?.pending));
      const status = query(row, 'policy-status');
      status.textContent = state?.pending ? !localServerConnected() ? 'Awaiting confirmation…' : 'Saving…' : state?.confirmed ? 'Saved' : !localServerConnected() ? 'Local server disconnected' : '';
      status.dataset.pending = String(!!state?.pending);
      query(row, 'policy-error').hidden = !state?.error;
      query(row, 'policy-error').querySelector('p').textContent = state?.error ?? '';
      query(row, 'retry-policy').disabled = !localServerConnected() || !!state?.pending;
    }
    renderWorkspaceCleanup();
  });

  return { openSettings, openAgentAccess, focusAgentAccess, setNavigationReturn, openRun, openWorkspace, setMissionWork, openEnvironment: environmentControls.openEnvironment,
    openFiles: environmentControls.openFiles, openServices: environmentControls.openServices, settings, jobs, environments, dialogs,
    dispose() {
      if (disposed) return;
      disposed = true;
      recoveryGeneration += 1; subscriptionGeneration += 1; clearRecoveryTimers();
      window.clearTimeout(cleanupTimer);
      window.cancelAnimationFrame(accessFocusFrame); window.clearTimeout(accessFocusTimer);
      recoveryComputation.stop(); renderComputation.stop(); settingsSubscription?.stop();
      missionRuns?.dispose(); globalRuns.dispose();
      environmentControls.dispose();
      for (const dialog of Object.values(dialogs)) {
        const toast = dialog.querySelector('#toast-region'); if (toast) document.body.append(toast);
        if (dialog.open) dialog.close(); dialog.remove();
      }
      root.replaceChildren();
    },
  };
}
