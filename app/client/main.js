import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Accounts } from 'meteor/accounts-base';
import { Mongo } from 'meteor/mongo';
import {
  Agent,
  AgentMemories,
  AgentSessions,
  PRACTICE_EVIDENCE_MAX,
  NAMES,
  defineAgentChat,
} from 'meteor/10thfloor:agent';
import {
  CHANNEL_KINDS,
  CHANNEL_SCHEMAS,
  deriveRuntimeState,
  nextScheduledAt,
} from '../imports/constellation/config';

const SESSION_KEY = 'constellation.session';
const IDENTITY_KEY = 'constellation.local-identity';
const INITIAL_LINK_TOKEN = window.location.pathname
  .match(/^\/link\/([A-Za-z0-9_-]{8,128})$/)?.[1] ?? null;
const INITIAL_VERDICT_TOKEN = window.location.pathname
  .match(/^\/verdict\/([A-Za-z0-9_-]{8,128})$/)?.[1] ?? null;
if (INITIAL_LINK_TOKEN || INITIAL_VERDICT_TOKEN) {
  window.history.replaceState(window.history.state, '', '/');
}
const DEFAULT_MISSION_THRESHOLDS = Object.freeze({ turns: 80, toolCalls: 40, spend: 5 });
const MISSION_PARTICIPANT_LIMIT = 16;
const MissionConfigs = new Mongo.Collection('constellation_mission_configs');
const CrewConfigs = new Mongo.Collection('constellation_crew_configs');
const ModelCatalog = new Mongo.Collection('constellation_model_catalog');
const WorkspaceMembers = new Mongo.Collection('constellation_workspace_members');
const MissionParticipation = new Mongo.Collection('constellation_mission_participation');
const PulseConfigs = new Mongo.Collection('constellation_pulses');
const SkillConfigs = new Mongo.Collection('constellation_skills');
const ChannelConfigs = new Mongo.Collection('constellation_channel_configs');
const McpConfigs = new Mongo.Collection('constellation_mcp_configs');
const ToolCatalog = new Mongo.Collection('constellation_tool_catalog');
const AgentIdentities = new Mongo.Collection('agent_identities');
const AgentConstitutions = new Mongo.Collection('agent_constitutions');
const AgentExperiences = new Mongo.Collection('agent_experiences');
const AgentPractices = new Mongo.Collection('agent_practices');
const AgentMemoryFrames = new Mongo.Collection('agent_memory_frames');
const workspace = new Agent('orchestrator');
const sessionChanged = new Tracker.Dependency();
const memoryViewChanged = new Tracker.Dependency();
const learningViewChanged = new Tracker.Dependency();
const $ = (id) => document.getElementById(id);

let currentSessionId = null;
let currentView = 'missions';
let memoryFilter = 'all';
let bootstrap = null;
let editingMissionSessionId = null;
let editingMissionRevision = null;
let selectedCrewId = null;
let crewEditor = null;
let pendingCrewArchiveImpact = null;
let crewDirectoryTab = 'agents';
let agentDetailTab = 'profile';
let constitutionDraft = null;
const constitutionDrafts = new Map();
let experienceRetractDraftId = null;
let practiceTransitionDraft = null;
let practiceEvidenceDraft = new Set();
let practiceDraft = null;
const practiceDrafts = new Map();
let agentLearningErrorAction = null;
let learningSubscription = null;
let learningSubscriptionError = null;
let reviewFocusRequest = null;
let selectedWorkspaceMemberId = null;
let editingWorkspaceMemberId = null;
let editingWorkspaceMemberRevision = null;
let editingWorkspaceMemberOriginal = null;
let pendingPersonImpact = null;
let selectedMissionCrewMemberId = null;
let missionCrewDraft = null;
let missionCrewDirectoryReturn = false;
let missionParticipationHandle = null;
let missionParticipationSessionId = null;
let chatComposerMode = 'ask';
let selectedPulseId = null;
let editingPulseRevision = null;
let selectedSkillId = null;
let editingSkillRevision = null;
let skillFocusRestoreId = null;
let selectedChannelKind = null;
let editingChannelRevision = null;
let selectedMcpId = null;
let editingMcpId = null;
let editingMcpRevision = null;
let editingMcpPersistedEnabled = null;
let editingMcpDiscoveredTools = null;
let editingMcpSelectedTools = new Set();
let selectedToolId = null;
let pulseFilter = 'all';
let capabilityTab = 'tools';
let toolSourceFilter = 'all';
let toolAgentFilter = 'all';
let toolViewMode = 'tools';
let mcpDetailTab = 'overview';
let removedMcpEnvKeys = new Set();
const renaming = new Set();
const pendingControls = new WeakSet();
const pendingCrewArchives = new Set();
const pendingSkillStates = new Map();
const guardedEditors = new Map();
let childRunComputation = null;
let applicationWired = false;
let applicationWiringStarted = false;
let booted = false;
let bootPromise = null;
let bootSubscriptions = [];
let activeChannelLinkToken = null;
let activeChannelLinkPreview = null;
let channelLinkRequestGeneration = 0;
let activeVerdictToken = null;
let activeVerdictPreview = null;
let verdictRequestGeneration = 0;

function randomToken(bytes = 12) {
  const value = new Uint8Array(bytes);
  window.crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function login(username, password) {
  return new Promise((resolve, reject) => {
    Meteor.loginWithPassword(username, password, (error) => (error ? reject(error) : resolve()));
  });
}

function createAccount(username, password) {
  return new Promise((resolve, reject) => {
    Accounts.createUser({ username, password }, (error) => (error ? reject(error) : resolve()));
  });
}

async function ensureLocalIdentity() {
  if (Meteor.userId()) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null'); } catch { saved = null; }
  if (saved?.username && saved?.password) {
    try {
      await login(saved.username, saved.password);
      return;
    } catch {
      localStorage.removeItem(IDENTITY_KEY);
    }
  }

  const credentials = {
    username: `local-${randomToken(5)}`,
    password: `${randomToken(18)}A!`,
  };
  await createAccount(credentials.username, credentials.password);
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(credentials));
}

function messageOf(error) {
  return error?.reason || error?.message || String(error);
}

let toastDialogRecoveryBound = false;

function toastLayerOwner() {
  const focusedDialog = document.activeElement?.closest?.('dialog[open]');
  if (focusedDialog) return focusedDialog;
  const hitDialog = document.elementFromPoint?.(
    Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2),
  )?.closest?.('dialog[open]');
  if (hitDialog) return hitDialog;
  return [...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body;
}

function presentToastRegion(region) {
  const supportsPopover = typeof region.showPopover === 'function';
  try {
    if (supportsPopover && region.matches(':popover-open')) region.hidePopover();
  } catch { /* The fixed high-z fallback remains visible in older runtimes. */ }
  const owner = toastLayerOwner();
  if (region.parentElement !== owner) owner.append(region);
  try {
    if (supportsPopover) region.showPopover();
  } catch { /* Nesting in the active dialog keeps the fallback above its backdrop. */ }
}

function bindToastDialogRecovery() {
  if (toastDialogRecoveryBound) return;
  toastDialogRecoveryBound = true;
  document.addEventListener('close', () => {
    requestAnimationFrame(() => {
      const region = $('toast-region');
      if (!region) return;
      if (region.childElementCount) presentToastRegion(region);
      else if (region.parentElement !== document.body) document.body.append(region);
    });
  }, true);
}

function toast(message, tone = 'success') {
  const region = $('toast-region');
  bindToastDialogRecovery();
  const row = document.createElement('div');
  row.className = `toast ${tone}`;
  row.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  const light = document.createElement('i');
  const copy = document.createElement('span');
  copy.textContent = message;
  row.append(light, copy);
  region.append(row);
  presentToastRegion(region);
  window.setTimeout(() => row.classList.add('out'), 2800);
  window.setTimeout(() => {
    row.remove();
    if (!region.childElementCount) {
      try {
        if (typeof region.hidePopover === 'function' && region.matches(':popover-open')) {
          region.hidePopover();
        }
      } catch { /* Already closed or unsupported. */ }
      if (region.parentElement !== document.body) document.body.append(region);
    }
  }, 3100);
}

function clearFormError(formOrId) {
  const form = typeof formOrId === 'string' ? $(formOrId) : formOrId;
  form?.querySelector(':scope > .form-inline-error')?.remove();
}

function showFormError(formOrId, error, options = {}) {
  const form = typeof formOrId === 'string' ? $(formOrId) : formOrId;
  if (!form) return;
  clearFormError(form);
  const region = document.createElement('div');
  region.className = 'form-inline-error';
  region.setAttribute('role', 'alert');
  const copy = document.createElement('span');
  copy.textContent = messageOf(error);
  region.append(copy);
  if (typeof options.action === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = options.actionLabel || 'Try again';
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        await options.action();
        clearFormError(form);
      } finally {
        action.disabled = false;
      }
    });
    region.append(action);
  }
  const footer = form.querySelector(':scope > footer');
  form.insertBefore(region, footer);
  region.scrollIntoView({ block: 'nearest' });
}

function staleReloadOptions(error, reload) {
  return String(error?.error ?? '').startsWith('stale-')
    ? { actionLabel: 'Reload latest', action: reload }
    : {};
}

async function withControlBusy(control, label, operation) {
  if (!control || pendingControls.has(control)) return undefined;
  const wasDisabled = !!control.disabled;
  const form = control.form ?? control.closest?.('form') ?? null;
  const priorFormBusy = form?.getAttribute('aria-busy');
  const priorFormInert = form?.inert ?? false;
  pendingControls.add(control);
  control.dataset.loading = 'true';
  control.dataset.loadingLabel = label;
  control.setAttribute('aria-busy', 'true');
  control.disabled = true;
  if (form) {
    form.setAttribute('aria-busy', 'true');
    form.inert = true;
  }
  try {
    return await operation();
  } finally {
    pendingControls.delete(control);
    delete control.dataset.loading;
    delete control.dataset.loadingLabel;
    control.removeAttribute('aria-busy');
    control.disabled = wasDisabled;
    if (form) {
      form.inert = priorFormInert;
      if (priorFormBusy === null) form.removeAttribute('aria-busy');
      else form.setAttribute('aria-busy', priorFormBusy);
    }
  }
}

function editorSignature(value) {
  return JSON.stringify(value);
}

function updateGuardedEditor(formId) {
  const editor = guardedEditors.get(formId);
  if (!editor?.active) return false;
  const form = $(formId);
  const dirty = editorSignature(editor.read()) !== editor.baseline;
  editor.dirty = dirty;
  form.dataset.dirty = String(dirty);
  const status = $(editor.statusId);
  status.textContent = dirty ? 'Unsaved changes' : editor.cleanLabel;
  status.dataset.state = dirty ? 'dirty' : 'clean';
  status.classList.remove('error');
  status.setAttribute('role', 'status');
  const cancel = $(editor.cancelId);
  cancel.textContent = dirty ? 'Discard changes' : 'Cancel';
  const submit = form.querySelector('[type="submit"]');
  if (submit && !pendingControls.has(submit)) {
    submit.disabled = !dirty || (editor.requireValidity && !form.checkValidity());
  }
  return dirty;
}

function beginGuardedEditor(formId, { cleanLabel = 'Saved' } = {}) {
  const editor = guardedEditors.get(formId);
  if (!editor) return;
  editor.cleanLabel = cleanLabel;
  editor.baseline = editorSignature(editor.read());
  editor.active = true;
  editor.dirty = false;
  updateGuardedEditor(formId);
}

function endGuardedEditor(formId) {
  const editor = guardedEditors.get(formId);
  if (!editor) return;
  editor.active = false;
  editor.dirty = false;
  editor.baseline = null;
  const form = $(formId);
  delete form.dataset.dirty;
  $(editor.cancelId).textContent = 'Cancel';
}

function closeGuardedEditor(formId) {
  const editor = guardedEditors.get(formId);
  if (!editor) return false;
  const dirty = updateGuardedEditor(formId);
  if (dirty && !window.confirm(`Discard unsaved changes to ${editor.label}?`)) return false;
  $(editor.dialogId).close();
  return true;
}

function registerGuardedEditor({
  formId, dialogId, statusId, closeId, cancelId, label, read, requireValidity = false,
}) {
  const form = $(formId);
  const dialog = $(dialogId);
  const editor = {
    dialogId, statusId, cancelId, label, read, requireValidity,
    active: false, dirty: false, baseline: null, cleanLabel: 'Saved',
  };
  guardedEditors.set(formId, editor);
  const capture = () => updateGuardedEditor(formId);
  form.addEventListener('input', capture);
  form.addEventListener('change', capture);
  $(closeId).addEventListener('click', () => closeGuardedEditor(formId));
  $(cancelId).addEventListener('click', () => closeGuardedEditor(formId));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeGuardedEditor(formId);
  });
  dialog.addEventListener('close', () => endGuardedEditor(formId));
}

async function copyText(value, success) {
  try {
    await navigator.clipboard.writeText(value);
    toast(success);
  } catch {
    toast('Clipboard access was unavailable.', 'error');
  }
}

function timeAgo(value) {
  const at = value instanceof Date ? value.getTime() : new Date(value ?? Date.now()).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function titleFromPrompt(prompt) {
  const clean = prompt.replace(/^@[-\w.]+\s+/, '').replace(/\s+/g, ' ').trim();
  const first = clean.split(/[.!?]/)[0].replace(/^(build|create|research|review|remember)\s+/i, '');
  const words = first.split(' ').slice(0, 7).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'New mission';
}

function missionConfig(sessionId = currentSessionId) {
  return sessionId ? MissionConfigs.findOne(sessionId) : null;
}

function missionParticipation(sessionId = currentSessionId) {
  return sessionId ? MissionParticipation.findOne(sessionId) : null;
}

function missionLifecycleState(runtimeState, config) {
  if (!config || config.status === 'active') return runtimeState;
  if (config.status === 'paused') {
    return {
      ...runtimeState,
      key: 'paused',
      label: 'Paused',
      detail: runtimeState.key === 'ready' || runtimeState.key === 'stopped'
        ? 'Mission paused'
        : `Mission paused · ${runtimeState.detail}`,
    };
  }
  if (config.status === 'completed') {
    return {
      ...runtimeState,
      key: 'completed',
      label: 'Completed',
      detail: runtimeState.key === 'ready' || runtimeState.key === 'stopped'
        ? 'Mission completed'
        : `Mission completed · ${runtimeState.detail}`,
    };
  }
  return runtimeState;
}

function persistResumableMission(sessionId, config = missionConfig(sessionId)) {
  if (!sessionId) return;
  if (config?.continuity !== false && config?.status !== 'completed') {
    localStorage.setItem(SESSION_KEY, sessionId);
  } else if (localStorage.getItem(SESSION_KEY) === sessionId) {
    localStorage.removeItem(SESSION_KEY);
  }
}

function maybeAutoTitle(session, prompt) {
  if (!session || !prompt?.trim() || missionConfig(session._id)?.autoTitle === false
    || !/^(new|untitled) mission$/i.test(session.title ?? 'New mission')
    || renaming.has(session._id)) return;
  renaming.add(session._id);
  void Meteor.callAsync('constellation.renameSession', session._id, titleFromPrompt(prompt))
    .catch(() => {})
    .finally(() => renaming.delete(session._id));
}

function waitForSubscription(handle, label = 'workspace data', timeoutMs = 15_000) {
  if (handle.ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const computation = Tracker.autorun((tracker) => {
      if (!handle.ready()) return;
      settled = true;
      tracker.stop();
      if (timer !== null) window.clearTimeout(timer);
      resolve();
    });
    timer = window.setTimeout(() => {
      if (settled) return;
      computation.stop();
      reject(new Error(`Timed out loading ${label}.`));
    }, timeoutMs);
  });
}

function waitForReactiveValue(read, label = 'workspace data', timeoutMs = 15_000) {
  if (read()) return Promise.resolve(read());
  return new Promise((resolve, reject) => {
    let timer = null;
    const computation = Tracker.autorun((tracker) => {
      const value = read();
      if (!value) return;
      tracker.stop();
      if (timer !== null) window.clearTimeout(timer);
      resolve(value);
    });
    timer = window.setTimeout(() => {
      computation.stop();
      reject(new Error(`Timed out loading ${label}.`));
    }, timeoutMs);
  });
}

async function prepareSession(sessionId) {
  return Meteor.callAsync('constellation.prepareSession', sessionId);
}

function subscribeMissionParticipation(sessionId) {
  if (!sessionId) return null;
  if (missionParticipationSessionId === sessionId) return missionParticipationHandle;
  missionParticipationHandle?.stop?.();
  missionParticipationSessionId = sessionId;
  missionParticipationHandle = Meteor.subscribe('constellation.missionParticipation', sessionId);
  return missionParticipationHandle;
}

async function createMission(title = 'New mission') {
  const sessionId = await workspace.start({ title });
  await prepareSession(sessionId);
  return sessionId;
}

function openSession(sessionId) {
  if (!sessionId) return;
  currentSessionId = sessionId;
  setChatComposerMode('ask', { focus: false });
  subscribeMissionParticipation(sessionId);
  persistResumableMission(sessionId);
  const chat = $('mission-chat');
  chat.setAttribute('agent', 'orchestrator');
  chat.setAttribute('session-id', sessionId);
  sessionChanged.changed();
  queueMicrotask(() => sessionChanged.changed());
  void prepareSession(sessionId)
    .then(() => sessionChanged.changed())
    .catch((error) => toast(`Could not refresh this Mission crew: ${messageOf(error)}`, 'error'));
  activateView('missions');
}

async function newMission(control = $('new-mission')) {
  return withControlBusy(control, 'Creating', async () => {
    try {
      const sessionId = await createMission();
      openSession(sessionId);
      toast('Mission created.');
    } catch (error) {
      toast(messageOf(error), 'error');
    }
  });
}

async function sendPrompt(prompt) {
  if (!currentSessionId || !prompt?.trim()) return;
  const config = missionConfig();
  if (config?.status && config.status !== 'active') {
    toast(`Activate this mission before sending work.`, 'error');
    return;
  }
  activateView('missions');
  const session = AgentSessions.findOne(currentSessionId);
  maybeAutoTitle(session, prompt);
  try {
    await workspace.send(currentSessionId, prompt.trim());
  } catch (error) {
    toast(messageOf(error), 'error');
  }
}

function activateView(name) {
  if (!['missions', 'automations', 'memory', 'capabilities', 'channels'].includes(name)) return;
  currentView = name;
  $('workspace-shell').dataset.currentView = name;
  const sidebar = $('mission-sidebar');
  const missionScoped = name === 'missions';
  sidebar.setAttribute('aria-hidden', String(!missionScoped));
  if ('inert' in sidebar) sidebar.inert = !missionScoped;
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.viewPanel === name);
  });
  document.querySelectorAll('.rail-button[data-view]').forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function renderLocalAccountDetails() {
  const runtime = $('runtime-label').textContent.trim() || 'Local runtime';
  const activeChannels = Array.isArray(bootstrap?.channels) ? bootstrap.channels.length : 0;
  $('account-runtime-value').textContent = runtime;
  $('account-release-value').textContent = bootstrap?.release ?? 'RC1';
  $('account-credential-value').textContent = bootstrap?.secureCredentials
    ? 'Encrypted on this device'
    : 'Locked';
  $('account-channel-value').textContent = `${activeChannels} active`;
}

function openLocalAccountDetails() {
  renderLocalAccountDetails();
  const dialog = $('account-dialog');
  if (!dialog.open) dialog.showModal();
}

function closeLocalAccountDetails() {
  const dialog = $('account-dialog');
  if (dialog.open) dialog.close();
}

function currentMissionMessages() {
  const chat = $('mission-chat');
  return chat?.agentInstance && currentSessionId
    ? chat.agentInstance.messages(currentSessionId).fetch()
    : [];
}

function renderMissionList(currentMessages = currentMissionMessages()) {
  const list = $('mission-list');
  const focusedSessionId = document.activeElement?.closest?.('.mission-row')?.dataset.sessionId ?? null;
  let restoreFocus = null;
  const query = $('mission-search').value.trim().toLowerCase();
  const sessions = workspace.sessions().fetch().filter((session) => {
    const config = missionConfig(session._id);
    const text = `${session.title ?? ''} ${config?.objective ?? ''} ${config?.status ?? 'active'} ${session.channel?.origin ?? 'desktop'}`.toLowerCase();
    return !query || text.includes(query);
  });
  $('mission-count').textContent = String(sessions.length);
  list.textContent = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty';
    empty.textContent = query ? 'No matching missions.' : 'No missions.';
    list.append(empty);
    return;
  }

  for (const session of sessions) {
    const config = missionConfig(session._id);
    const state = missionLifecycleState(
      deriveRuntimeState(
        session,
        session._id === currentSessionId ? currentMessages : [],
      ),
      config,
    );
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mission-row${session._id === currentSessionId ? ' current' : ''}`;
    button.dataset.sessionId = session._id;
    button.dataset.agentState = state.key;
    button.dataset.runtimePhase = state.runtimePhase;
    const phase = document.createElement('i');
    phase.className = [
      state.key,
      ['loading', 'thinking', 'working'].includes(state.key) ? 'active' : '',
      state.key === 'waiting' ? 'awaiting' : '',
    ].filter(Boolean).join(' ');
    phase.dataset.agentState = state.key;
    phase.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'mission-row-copy';
    const title = document.createElement('strong');
    title.textContent = session.title || 'New mission';
    const meta = document.createElement('span');
    const surface = session.channel?.origin ?? 'desktop';
    meta.textContent = `${surface} · ${state.label.toLowerCase()}`;
    copy.append(title, meta);
    const at = document.createElement('time');
    at.textContent = timeAgo(session.updatedAt);
    button.setAttribute('aria-label', `${title.textContent} · ${state.label} · ${surface}`);
    button.title = state.detail;
    button.append(phase, copy, at);
    button.addEventListener('click', () => openSession(session._id));
    list.append(button);
    if (session._id === focusedSessionId) restoreFocus = button;
  }
  if (restoreFocus) requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
}

function primaryDefinition() {
  const config = CrewConfigs.findOne({ agent: 'orchestrator' });
  return {
    agent: 'orchestrator',
    label: config?.displayName ?? 'Atlas',
    role: config?.role ?? 'Orchestrator',
    avatar: config?.avatar ?? 'A',
    className: config?.color ?? 'amber',
    configId: config?._id,
    primary: true,
    enabled: true,
  };
}

function specialistDefinitions(includeDisabled = false) {
  return CrewConfigs.find(
    includeDisabled ? { agent: { $ne: 'orchestrator' } } : { agent: { $ne: 'orchestrator' }, enabled: true },
    { sort: { order: 1, createdAt: 1 } },
  ).fetch().filter((config) => !pendingCrewArchives.has(config._id)
    && !crewConfigArchived(config)).map((config) => ({
    agent: config.agent,
    label: config.displayName,
    role: config.role,
    avatar: config.avatar,
    className: config.color,
    configId: config._id,
    enabled: config.enabled,
  }));
}

function crewDefinitions() {
  return [primaryDefinition(), ...specialistDefinitions()];
}

function crewDefinition(agentName) {
  return crewDefinitions().find((crew) => crew.agent === agentName)
    ?? specialistDefinitions(true).find((crew) => crew.agent === agentName);
}

function activeCrewAgent(session, messages, state = deriveRuntimeState(session, messages)) {
  return state.agent && crewDefinition(state.agent) ? state.agent : null;
}

function updateMissionComposer(primary, config) {
  const chat = $('mission-chat');
  const status = config?.status ?? 'active';
  const writable = status === 'active';
  chat.dataset.missionStatus = status;
  chat.setAttribute('composer-mode', chatComposerMode);
  chat.setAttribute('placeholder', writable
    ? (chatComposerMode === 'note'
      ? `Share an update without running ${primary.label}…`
      : `Give ${primary.label} an outcome, or type @ to address a specialist…`)
    : `Mission ${status}`);
  chat.setAttribute('aria-disabled', String(!writable));
  const apply = () => {
    const input = chat.shadowRoot?.querySelector('.input');
    const send = chat.shadowRoot?.querySelector('.send');
    const approve = chat.shadowRoot?.querySelector('.approve');
    const deny = chat.shadowRoot?.querySelector('.deny');
    if (!input || !send) return;
    input.disabled = !writable;
    send.disabled = !writable;
    if (approve) approve.disabled = !writable;
    if (deny) deny.disabled = !writable;
    input.title = writable ? '' : `Mission ${status}`;
  };
  $('compact-mission').disabled = !writable;
  $('chat-mode-ask').textContent = `Ask ${primary.label}`;
  $('chat-mode-ask').title = `Send to ${primary.label}`;
  document.querySelectorAll('[data-prompt]').forEach((button) => { button.disabled = !writable; });
  apply();
  queueMicrotask(apply);
}

function setChatComposerMode(mode, { focus = true } = {}) {
  if (!['ask', 'note'].includes(mode)) return;
  chatComposerMode = mode;
  $('chat-mode-control').dataset.mode = mode;
  for (const candidate of ['ask', 'note']) {
    const button = $(`chat-mode-${candidate}`);
    const active = candidate === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  updateChatModeHint();
  updateMissionComposer(primaryDefinition(), missionConfig());
  if (focus) queueMicrotask(() => $('mission-chat').shadowRoot?.querySelector('.input')?.focus());
}

function updateChatModeHint() {
  const connected = (missionParticipation()?.surfaces ?? []).filter(
    (surface) => surface.status === 'bound',
  ).length;
  const audience = connected
    ? ` · shared to ${connected} channel${connected === 1 ? '' : 's'}`
    : '';
  $('chat-mode-hint').textContent = chatComposerMode === 'note'
    ? `Posts without running agents${audience}`
    : `Starts an agent turn${audience}`;
}

function initials(value, fallback = '?') {
  const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  return `${parts[0][0] ?? ''}${parts.length > 1 ? parts.at(-1)[0] ?? '' : ''}`
    .toUpperCase().slice(0, 2);
}

function surfaceLabel(kind) {
  const labels = {
    desktop: 'Desktop', slack: 'Slack', telegram: 'Telegram',
    email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', agent: 'Agent',
  };
  return labels[kind] ?? humanizeIdentifier(kind || 'surface');
}

function connectionLabel(connection) {
  if (connection === 'account') return 'Desktop account';
  if (connection === 'channel') return 'Channel identity';
  return 'Not connected';
}

function createSurfaceRow(surface, compact = false, participantNames = new Map()) {
  const row = document.createElement('div');
  row.className = `surface-list-item${compact ? ' compact' : ''}`;
  row.setAttribute('role', 'listitem');
  row.dataset.state = surface.status ?? 'bound';
  const icon = document.createElement('span');
  icon.className = `surface-kind-icon ${surface.kind}`;
  icon.dataset.kind = surface.kind;
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = surfaceLabel(surface.kind).slice(0, 1).toUpperCase();
  const copy = document.createElement('span');
  copy.className = 'surface-list-copy';
  const name = document.createElement('strong');
  name.textContent = surfaceLabel(surface.kind);
  const detail = document.createElement('small');
  const audience = surface.audience === 'group' ? 'Group' : 'Direct';
  const participantName = surface.participantKey
    ? participantNames.get(surface.participantKey)
    : '';
  detail.textContent = surface.detail || [participantName, audience,
    surface.lastActivityAt ? `active ${timeAgo(surface.lastActivityAt)}` : '']
    .filter(Boolean).join(' · ');
  copy.append(name, detail);
  const status = document.createElement('span');
  status.className = 'surface-status';
  status.dataset.state = surface.status ?? 'bound';
  status.textContent = surface.status === 'closing'
    ? 'Closing'
    : (surface.status === 'configured' ? 'Configured' : 'Connected');
  row.append(icon, copy, status);
  return row;
}

function renderSurfaceList(
  containerId, emptyId, surfaces, compact = false, participants = [],
) {
  const container = $(containerId);
  const empty = $(emptyId);
  if (!container) return;
  const participantNames = new Map(participants.map((participant) => [
    participant.key, participant.displayName,
  ]));
  container.replaceChildren(...surfaces.map(
    (surface) => createSurfaceRow(surface, compact, participantNames),
  ));
  if (empty) empty.hidden = surfaces.length > 0;
  container.hidden = surfaces.length === 0;
}

function renderMissionCollaboration(view = missionParticipation()) {
  const knownAgents = new Set(crewConfigs().filter((config) => config.enabled).map(
    (config) => config.agent,
  ));
  const participants = (view?.participants ?? []).filter(
    (participant) => participant.kind !== 'agent' || knownAgents.has(participant.agent),
  );
  const people = participants.filter((participant) => participant.kind === 'human');
  const agents = participants.filter((participant) => participant.kind === 'agent');
  const surfaces = view?.surfaces ?? [];
  updateChatModeHint();
  const stack = $('mission-participant-stack');
  stack.replaceChildren();
  stack.dataset.state = view ? 'ready' : 'loading';
  stack.setAttribute('aria-busy', String(!view));
  if (!view) {
    const loading = document.createElement('span');
    loading.className = 'participant-stack-loading';
    loading.setAttribute('aria-hidden', 'true');
    stack.append(loading);
  } else {
    const ordered = [
      ...people.filter((participant) => participant.role === 'owner'),
      ...people.filter((participant) => participant.role !== 'owner'),
      ...agents,
    ];
    for (const participant of ordered.slice(0, 5)) {
      const avatar = document.createElement('span');
      avatar.className = `participant-avatar ${participant.kind}`;
      avatar.dataset.kind = participant.kind;
      avatar.dataset.connection = participant.connection ?? '';
      avatar.textContent = initials(participant.displayName, participant.kind === 'agent' ? 'A' : 'P');
      avatar.title = `${participant.displayName} · ${participant.kind === 'agent' ? 'Agent' : participant.role}`;
      avatar.setAttribute('aria-label', avatar.title);
      stack.append(avatar);
    }
    if (ordered.length > 5) {
      const hidden = ordered.slice(5);
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'participant-avatar more';
      more.textContent = `+${ordered.length - 5}`;
      more.setAttribute('aria-label', `${ordered.length - 5} more crew members`);
      more.title = hidden.map((participant) => participant.displayName).join(', ');
      more.addEventListener('click', () => openMissionCrew(more));
      stack.append(more);
    }
    stack.setAttribute(
      'aria-label',
      ordered.length ? `Mission crew: ${ordered.map((row) => row.displayName).join(', ')}` : 'Mission crew is empty',
    );
  }

  $('mission-crew-count').textContent = String(participants.length);
  $('mission-crew-people-count').textContent = String(people.length);
  const peopleList = $('mission-crew-people');
  peopleList.replaceChildren();
  for (const person of people) {
    const row = document.createElement('div');
    row.className = 'mission-person-row';
    row.setAttribute('role', 'listitem');
    const avatar = document.createElement('span');
    avatar.className = 'participant-avatar human';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(person.displayName, 'P');
    const copy = document.createElement('span');
    copy.className = 'mission-person-copy';
    const name = document.createElement('strong');
    name.textContent = person.displayName;
    const detail = document.createElement('span');
    const channels = (person.surfaceKinds ?? []).map(surfaceLabel);
    detail.textContent = person.role === 'owner'
      ? 'Owner · Desktop'
      : (channels.length ? channels.join(' · ') : connectionLabel(person.connection));
    copy.append(name, detail);
    const role = document.createElement('span');
    role.className = 'mission-person-role';
    role.textContent = person.role === 'owner' ? 'Owner' : 'Participant';
    row.append(avatar, copy, role);
    peopleList.append(row);
  }
  $('mission-crew-people-empty').hidden = people.length > 0;
  peopleList.hidden = people.length === 0;
  renderSurfaceList(
    'mission-surface-list', 'mission-surface-empty', surfaces, true, participants,
  );
  if ($('mission-crew-dialog')?.open) renderMissionCrewDialog();
}

function renderCrew(
  session,
  messages,
  missionState = deriveRuntimeState(session, messages),
  config = missionConfig(),
) {
  const activeAgent = activeCrewAgent(session, messages, missionState);
  const roster = new Map((session?.participants ?? []).filter((row) => row.kind === 'model').map((row) => [row.agent, row]));
  const list = $('crew-list');
  const focusedConfigId = document.activeElement?.closest?.('.crew-card')?.dataset.configId ?? null;
  let restoreFocus = null;
  list.textContent = '';
  const definitions = crewDefinitions().filter(
    (definition) => definition.agent === 'orchestrator' || roster.has(definition.agent),
  );
  const primary = definitions[0];
  $('primary-name').textContent = primary.label;
  $('primary-role').textContent = primary.role;
  $('primary-avatar').className = `agent-avatar avatar-orbit ${primary.className}`;
  $('primary-avatar').firstChild.textContent = primary.avatar;
  $('primary-avatar').dataset.agentState = activeAgent === 'orchestrator'
    ? missionState.key
    : 'ready';
  updateMissionComposer(primary, config);
  for (const definition of definitions) {
    const row = document.createElement(definition.configId ? 'button' : 'div');
    const active = activeAgent === definition.agent;
    const delegatedWait = !!session?.activeChild
      && !!activeAgent
      && definition.agent === 'orchestrator'
      && activeAgent !== 'orchestrator';
    const agentState = active ? missionState.key : (delegatedWait ? 'waiting' : 'ready');
    const displayName = definition.agent === 'orchestrator'
      ? definition.label
      : (roster.get(definition.agent)?.displayName ?? definition.label);
    const detail = active
      ? missionState.detail
      : (delegatedWait ? `Waiting for ${crewDefinition(activeAgent)?.label ?? activeAgent}` : definition.role);
    const stateLabel = active
      ? missionState.label
      : (delegatedWait ? 'Waiting' : 'Ready');
    row.className = `crew-card${active ? ' active' : ''}`;
    row.dataset.agentState = agentState;
    row.dataset.accent = definition.className;
    if (definition.configId) {
      row.type = 'button';
      row.dataset.configId = definition.configId;
      row.dataset.configurable = 'true';
      row.title = `Configure ${displayName}`;
      row.setAttribute('aria-label', `Configure ${displayName}. ${detail}. ${stateLabel}.`);
      row.setAttribute('aria-haspopup', 'dialog');
      row.setAttribute('aria-controls', 'crew-dialog');
      row.setAttribute('aria-busy', String(['loading', 'thinking', 'working', 'retrying'].includes(agentState)));
      if (active) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => openCrewSettings(definition.configId));
      if (focusedConfigId === definition.configId) restoreFocus = row;
    }
    const avatar = document.createElement('span');
    avatar.className = `crew-avatar ${definition.className}`;
    avatar.setAttribute('aria-hidden', 'true');
    avatar.dataset.agentState = agentState;
    avatar.textContent = definition.avatar;
    avatar.append(document.createElement('i'));
    const copy = document.createElement('span');
    copy.className = 'crew-copy';
    const name = document.createElement('strong');
    name.textContent = displayName;
    const role = document.createElement('span');
    role.textContent = detail;
    copy.append(name, role);
    const state = crewStateGlyph(agentState, stateLabel);
    const disclosure = document.createElement('span');
    disclosure.className = 'crew-disclosure';
    disclosure.setAttribute('aria-hidden', 'true');
    disclosure.textContent = '›';
    row.append(avatar, copy, state, disclosure);
    list.append(row);
  }
  if (restoreFocus) requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  $('crew-count').textContent = String(definitions.length);
}

// Crew rows are too narrow for the state as words ("APPROVAL NEEDED" clipped
// to "APPROVAL N"); the mission header keeps the text pill. One glyph per
// runtime state, drawn on the rail icons' 24-grid so they read as one family.
const RING = ['circle', { cx: '12', cy: '12', r: '8.25' }];
const SPINNER = ['path', { d: 'M20.25 12A8.25 8.25 0 1 1 12 3.75' }];
const CREW_STATE_GLYPHS = {
  ready: [RING, ['path', { d: 'm8.7 12.3 2.1 2.1 4.5-4.7' }]],
  waiting: [RING, ['path', { d: 'M12 7.75v5' }], ['path', { d: 'M12 16.1h.01' }]],
  working: [SPINNER],
  loading: [SPINNER],
  thinking: [['path', { d: 'M6.5 12h.01M12 12h.01M17.5 12h.01' }]],
  retrying: [['path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }], ['path', { d: 'M19.5 4.5v4.2h-4.2' }]],
  error: [RING, ['path', { d: 'm9.4 9.4 5.2 5.2M14.6 9.4l-5.2 5.2' }]],
  stopped: [RING, ['rect', { x: '9.25', y: '9.25', width: '5.5', height: '5.5', rx: '1' }]],
  paused: [RING, ['path', { d: 'M10 9v6M14 9v6' }]],
  completed: [['path', { d: 'M5.5 12.5 9.8 16.8 18.5 7.8' }]],
};

function crewStateGlyph(agentState, label) {
  const state = document.createElement('span');
  state.className = 'crew-state';
  state.dataset.agentState = agentState;
  state.title = label;
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shapes = CREW_STATE_GLYPHS[agentState] ?? [['circle', { cx: '12', cy: '12', r: '2.4' }]];
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(svgNs, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  const text = document.createElement('span');
  text.className = 'sr-only';
  text.textContent = label;
  state.append(svg, text);
  return state;
}

function crewConfigArchived(config) {
  const identity = agentIdentityForConfig(config);
  return config?.status === 'archived' || identity?.lifecycle === 'archived';
}

function crewConfigs({ includeArchived = false } = {}) {
  for (const configId of pendingCrewArchives) {
    if (!CrewConfigs.findOne(configId)) pendingCrewArchives.delete(configId);
  }
  const configs = CrewConfigs.find({}, { sort: { order: 1, createdAt: 1 } }).fetch()
    .filter((config) => !pendingCrewArchives.has(config._id))
    .filter((config) => includeArchived || !crewConfigArchived(config));
  if (includeArchived) {
    configs.sort((left, right) => Number(crewConfigArchived(left))
      - Number(crewConfigArchived(right)));
  }
  if (crewEditor?.isNew) configs.push(crewEditor.config);
  return configs;
}

function learningIsReady() {
  learningViewChanged.depend();
  return !!learningSubscription?.ready?.();
}

function agentIdentityForConfig(config) {
  if (!config || config._draft) return null;
  return AgentIdentities.findOne(config.agentId ?? config._id)
    ?? AgentIdentities.findOne({ currentName: config.agent });
}

function agentIdForConfig(config) {
  return agentIdentityForConfig(config)?._id ?? config?.agentId ?? config?._id ?? null;
}

function agentConfigForId(agentId) {
  if (!agentId) return null;
  const identity = AgentIdentities.findOne(agentId);
  return CrewConfigs.findOne(agentId)
    ?? CrewConfigs.findOne({ agentId })
    ?? CrewConfigs.findOne({ agent: identity?.currentName });
}

function agentDisplayName(agentId) {
  const config = agentConfigForId(agentId);
  const identity = AgentIdentities.findOne(agentId);
  return config?.displayName ?? identity?.displayName ?? identity?.currentName ?? 'Agent';
}

function learningText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  for (const key of ['text', 'summary', 'lesson', 'guidance', 'content', 'message']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return '';
}

function learningAt(row) {
  return row?.updatedAt ?? row?.createdAt ?? row?.at ?? new Date(0);
}

function learningSourceLabel(row) {
  const source = row?.source ?? {};
  const sessionId = source.sessionId ?? row?.sessionId;
  const session = sessionId ? AgentSessions.findOne(sessionId) : null;
  const mission = sessionId ? MissionConfigs.findOne(sessionId) : null;
  const missionName = mission?.title ?? session?.title;
  const seq = source.triggerSeq ?? row?.triggerSeq;
  const sourceKind = typeof source.kind === 'string'
    ? source.kind.charAt(0).toUpperCase() + source.kind.slice(1) : null;
  return [sourceKind, missionName, Number.isInteger(seq) ? `turn ${seq}` : null,
    timeAgo(learningAt(row))]
    .filter(Boolean).join(' · ');
}

function appendLearningEmpty(container, text) {
  const empty = document.createElement('div');
  empty.className = 'learning-empty';
  empty.textContent = text;
  container.append(empty);
}

function learningStatus(value) {
  const status = document.createElement('span');
  const clean = String(value || 'active').toLowerCase();
  status.className = `learning-status ${clean}`;
  status.textContent = clean;
  return status;
}

function learningCard({ title, subtitle, body, status, muted = false }) {
  const card = document.createElement('article');
  card.className = `learning-card${muted ? ' is-muted' : ''}`;
  const header = document.createElement('header');
  const copy = document.createElement('div');
  copy.className = 'learning-card-title';
  const heading = document.createElement('strong');
  heading.textContent = title;
  copy.append(heading);
  if (subtitle) {
    const meta = document.createElement('span');
    meta.textContent = subtitle;
    copy.append(meta);
  }
  header.append(copy);
  if (status) header.append(learningStatus(status));
  card.append(header);
  if (body) {
    const content = document.createElement('p');
    content.textContent = body;
    card.append(content);
  }
  return card;
}

function learningAdmissionState(target, record) {
  const admission = target === 'experience'
    ? record?.admission : record?.validationAdmission;
  const reviewed = !!record?.review?.at;
  const active = target === 'experience'
    ? (record?.status ?? 'active') === 'active'
    : ['validated', 'hardened'].includes(record?.status);
  if (admission === 'automatic') {
    return {
      admission,
      label: reviewed ? 'Automatic · Reviewed' : 'Automatic · Review needed',
      pending: active && !reviewed,
      state: reviewed ? 'automatic-reviewed' : 'automatic-pending',
    };
  }
  if (admission === 'reviewed') {
    return {
      admission,
      label: target === 'experience' ? 'Approved before recording' : 'Reviewed before use',
      pending: false,
      state: 'approved',
    };
  }
  if (target === 'experience' && admission === 'trusted') {
    return { admission, label: 'Trusted source', pending: false, state: 'trusted' };
  }
  if (target === 'practice' && record?.status === 'candidate') {
    return { admission: null, label: 'Waiting for review', pending: false, state: 'candidate' };
  }
  return {
    admission: null,
    label: target === 'experience' ? 'Admission not recorded' : 'Validation admission not recorded',
    pending: false,
    state: 'legacy',
  };
}

function appendLearningAdmission(container, target, record) {
  const admission = learningAdmissionState(target, record);
  const label = document.createElement('span');
  label.className = `learning-admission is-${admission.state}`;
  label.textContent = admission.label;
  if (record?.review?.at) {
    label.title = `Reviewed ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(record.review.at))}`;
  }
  container.append(label);
  return admission;
}

function learningReviewButton(agentId, target, record, {
  inlineError = true,
  label = 'Acknowledge audit',
  ariaLabel = null,
} = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'learning-review-action';
  button.textContent = label;
  button.dataset.loadingLabel = 'Acknowledging';
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', async () => {
    const queue = button.closest('#reviews-list');
    const currentRow = button.closest('.review-row');
    const queueRows = queue ? [...queue.querySelectorAll('.review-row')] : [];
    const currentIndex = currentRow ? queueRows.indexOf(currentRow) : -1;
    const nextFocusKey = currentIndex >= 0
      ? (queueRows[currentIndex + 1]?.dataset.reviewKey
        ?? queueRows[currentIndex - 1]?.dataset.reviewKey
        ?? 'queue')
      : null;
    await withControlBusy(button, 'Acknowledging', async () => {
      try {
        await Meteor.callAsync(
          'constellation.learningReview', agentId, target, record._id,
        );
        if (nextFocusKey) reviewFocusRequest = nextFocusKey;
        learningViewChanged.changed();
        toast(`${target === 'experience' ? 'Experience' : 'Practice'} audit acknowledged.`);
      } catch (error) {
        if (inlineError) showAgentLearningError(error);
        else toast(messageOf(error), 'error');
      }
    });
  });
  return button;
}

function clearAgentLearningError() {
  const error = $('agent-learning-error');
  error.hidden = true;
  $('agent-learning-error-message').textContent = '';
  const action = $('agent-learning-error-action');
  action.hidden = true;
  action.textContent = 'Retry';
  agentLearningErrorAction = null;
}

function showAgentLearningError(error, { actionLabel, action } = {}) {
  const region = $('agent-learning-error');
  $('agent-learning-error-message').textContent = messageOf(error);
  const control = $('agent-learning-error-action');
  agentLearningErrorAction = typeof action === 'function' ? action : null;
  control.hidden = !agentLearningErrorAction;
  control.textContent = actionLabel || 'Retry';
  control.dataset.loadingLabel = actionLabel === 'Rebase draft' ? 'Rebasing' : 'Retrying';
  region.hidden = false;
  region.scrollIntoView({ block: 'nearest' });
}

function setLearningPanelState(region, state, text) {
  region.hidden = false;
  region.dataset.state = state;
  region.setAttribute('aria-busy', String(state === 'loading'));
  const copy = region.querySelector('span') ?? region;
  copy.textContent = text;
}

function setAgentDetailTab(tab, { focus = false } = {}) {
  if (!['profile', 'constitution', 'experience', 'practices', 'frames'].includes(tab)) return;
  if (crewEditor?.isNew && tab !== 'profile') return;
  agentDetailTab = tab;
  if (!learningSubscriptionError) clearAgentLearningError();
  document.querySelectorAll('[data-agent-detail-tab]').forEach((button) => {
    const active = button.dataset.agentDetailTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  document.querySelectorAll('[data-agent-detail-panel]').forEach((panel) => {
    const active = panel.dataset.agentDetailPanel === tab;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  $('crew-form-actions').hidden = tab !== 'profile' && !crewEditor?.dirty;
  $('restore-crew-agent-learning').hidden = tab === 'profile';
}

function renderAgentDetailTabs(config) {
  const draft = !!config?._draft;
  document.querySelectorAll('[data-agent-detail-tab]').forEach((button) => {
    button.disabled = draft && button.dataset.agentDetailTab !== 'profile';
  });
  if (draft && agentDetailTab !== 'profile') agentDetailTab = 'profile';
  setAgentDetailTab(agentDetailTab);
}

function constitutionDraftIsDirty(draft) {
  return !!draft && (
    draft.body.trim() !== draft.baseBody.trim() || draft.reason.trim().length > 0
  );
}

function updateConstitutionDraftState() {
  const dirty = constitutionDraftIsDirty(constitutionDraft);
  $('constitution-compose').classList.toggle('has-draft', dirty);
  $('constitution-draft-state').textContent = dirty
    ? 'Draft not published · open to continue'
    : 'Publish a new version while preserving history.';
}

function activateConstitutionDraft(identity, body) {
  let draft = constitutionDrafts.get(identity._id);
  const generation = Number(identity.generation ?? 1);
  if (!draft || (!constitutionDraftIsDirty(draft) && draft.baseGeneration !== generation)) {
    draft = {
      agentId: identity._id,
      baseBody: body,
      baseGeneration: generation,
      body,
      reason: '',
    };
    constitutionDrafts.set(identity._id, draft);
  }
  const changedAgent = constitutionDraft !== draft;
  constitutionDraft = draft;
  if (changedAgent) {
    $('constitution-body').value = draft.body;
    $('constitution-reason').value = draft.reason;
  }
  updateConstitutionDraftState();
  return draft;
}

function rebaseConstitutionDraft(agentId) {
  const draft = constitutionDrafts.get(agentId);
  const identity = AgentIdentities.findOne(agentId);
  if (!draft || !identity) {
    throw new Error('Latest Agent identity is not available yet.');
  }
  const current = identity.constitutionVersionId
    ? AgentConstitutions.findOne({
      _id: identity.constitutionVersionId, agentId: identity._id,
    }) : null;
  if (identity.constitutionVersionId && !current) {
    throw new Error('The active Constitution is unavailable. Reload learning data before rebasing.');
  }
  draft.baseBody = learningText(current?.content);
  draft.baseGeneration = Number(identity.generation ?? 1);
  constitutionDraft = draft;
  clearAgentLearningError();
  renderCrewSettings();
  toast('Constitution draft rebased. Review it before publishing.');
}

function renderConstitution(config, identity, ready, readOnly = false) {
  const loading = $('constitution-loading');
  const content = $('constitution-content');
  if (!ready) {
    setLearningPanelState(
      loading,
      learningSubscriptionError ? 'error' : 'loading',
      learningSubscriptionError ? 'Constitution unavailable.' : 'Loading constitution…',
    );
    content.hidden = true;
    return { versions: [], current: null };
  }
  if (!identity) {
    setLearningPanelState(
      loading, 'empty', config?._draft ? 'Save this agent first.' : 'Constitution unavailable.',
    );
    content.hidden = true;
    return { versions: [], current: null };
  }
  loading.hidden = true;
  content.hidden = false;
  const versions = AgentConstitutions.find(
    { agentId: identity._id }, { sort: { revision: -1, createdAt: -1 } },
  ).fetch();
  const activeVersionId = typeof identity.constitutionVersionId === 'string'
    && identity.constitutionVersionId ? identity.constitutionVersionId : null;
  const current = activeVersionId ? AgentConstitutions.findOne({
    _id: activeVersionId, agentId: identity._id,
  }) : null;
  const unresolved = !!activeVersionId && !current;
  content.querySelector('.constitution-compose').hidden = readOnly || unresolved;
  const body = learningText(current?.content);
  $('constitution-version').textContent = unresolved
    ? 'Active version unavailable'
    : current ? `Version ${current.revision ?? '—'}` : 'No active version';
  $('constitution-state').textContent = unresolved ? 'Unavailable' : current ? 'Active' : 'None';
  $('constitution-state').className = `learning-status${unresolved ? ' integrity' : current ? ' active' : ''}`;
  const currentPanel = content.querySelector('.constitution-current');
  currentPanel.classList.toggle('has-integrity-warning', unresolved);
  $('constitution-current-body').textContent = unresolved
    ? `Active Constitution ${activeVersionId} is not available in the published history. Revision is disabled.`
    : body || 'No active constitution.';
  if (!unresolved) activateConstitutionDraft(identity, body);
  else constitutionDraft = null;
  $('constitution-history-count').textContent = versions.length
    ? `Latest ${versions.length} published version${versions.length === 1 ? '' : 's'}`
    : 'No published versions';
  const history = $('constitution-history-list');
  history.replaceChildren();
  if (!versions.length) appendLearningEmpty(history, 'No constitution history.');
  for (const version of versions) {
    const active = version._id === current?._id;
    const row = learningCard({
      title: `Version ${version.revision ?? '—'}`,
      subtitle: [active ? 'Active' : null, learningSourceLabel(version)].filter(Boolean).join(' · '),
      body: concise(learningText(version.content), 220),
      status: active ? 'active' : null,
    });
    if (version.reason) {
      const metadata = document.createElement('div');
      metadata.className = 'learning-card-meta';
      const reason = document.createElement('span');
      reason.textContent = `Reason · ${concise(version.reason, 160)}`;
      metadata.append(reason);
      row.append(metadata);
    }
    history.append(row);
  }
  return { versions, current, unresolved };
}

function experienceSummary(experience) {
  return learningText(experience.lesson)
    || learningText(experience.difference)
    || learningText(experience.observed)
    || 'Recorded experience';
}

function experienceBody(experience) {
  const expected = learningText(experience.expected);
  const observed = learningText(experience.observed);
  const difference = learningText(experience.difference);
  return [
    expected ? `Expected · ${expected}` : null,
    observed ? `Observed · ${observed}` : null,
    difference ? `Difference · ${difference}` : null,
  ]
    .filter(Boolean).join('\n');
}

function experienceAudienceLabel(audience) {
  if (typeof audience?.key !== 'string' || !audience.key) return 'Unknown';
  return ({ identity: 'Agent identity', owner: 'Workspace', session: 'Chat' })[
    audience?.scope
  ] ?? 'Unknown';
}

function experienceAudienceText(audience) {
  const label = experienceAudienceLabel(audience);
  return label === 'Unknown' ? 'Unknown' : `${label} · ${audience.key}`;
}

function renderExperience(identity, ready, readOnly = false) {
  const loading = $('experience-loading');
  const content = $('experience-content');
  if (!ready) {
    setLearningPanelState(
      loading,
      learningSubscriptionError ? 'error' : 'loading',
      learningSubscriptionError ? 'Experience unavailable.' : 'Loading experience…',
    );
    content.hidden = true;
    return [];
  }
  if (!identity) {
    setLearningPanelState(loading, 'empty', 'Experience unavailable.');
    content.hidden = true;
    return [];
  }
  loading.hidden = true;
  content.hidden = false;
  const rows = AgentExperiences.find(
    { agentId: identity._id }, { sort: { createdAt: -1 } },
  ).fetch();
  const activeCount = rows.filter((row) => (row.status ?? 'active') === 'active').length;
  $('experience-summary').textContent = `Latest ${rows.length} records · ${activeCount} active · ${rows.length - activeCount} retracted`;
  const list = $('experience-list');
  list.replaceChildren();
  if (!rows.length) appendLearningEmpty(
    list,
    'No Experience yet. New records appear after this agent proposes and saves one.',
  );
  for (const experience of rows) {
    const status = experience.status ?? 'active';
    const row = learningCard({
      title: experienceSummary(experience),
      subtitle: learningSourceLabel(experience),
      body: experienceBody(experience),
      status,
      muted: status !== 'active',
    });
    const metadata = document.createElement('div');
    metadata.className = 'learning-card-meta';
    const admission = appendLearningAdmission(metadata, 'experience', experience);
    const basis = document.createElement('span');
    basis.textContent = `Expectation ${experience.expectationBasis ?? 'unspecified'}`;
    metadata.append(basis);
    if (learningText(experience.context)) {
      const context = document.createElement('span');
      context.textContent = `Context · ${learningText(experience.context)}`;
      metadata.append(context);
    }
    const audience = document.createElement('span');
    audience.textContent = `${experienceAudienceLabel(experience.audience)} scope`;
    audience.classList.toggle(
      'is-integrity-warning', experienceAudienceLabel(experience.audience) === 'Unknown',
    );
    metadata.append(audience);
    if (Number.isFinite(experience.confidence)) {
      const confidence = document.createElement('span');
      confidence.textContent = `Confidence ${Math.round(experience.confidence * 100)}%`;
      metadata.append(confidence);
    }
    if (experience.frameId) {
      const frame = AgentMemoryFrames.findOne(experience.frameId);
      const frameLabel = document.createElement('span');
      frameLabel.textContent = frame ? `Frame ${String(frame._id).slice(-6)}` : 'Frame unavailable';
      metadata.append(frameLabel);
    }
    if (experience.retractionReason) {
      const reason = document.createElement('span');
      reason.textContent = `Reason · ${concise(experience.retractionReason, 160)}`;
      metadata.append(reason);
    }
    if (metadata.childElementCount) row.append(metadata);
    if (status === 'active' && !readOnly) {
      const actions = document.createElement('div');
      actions.className = 'learning-card-actions';
      if (admission.pending) {
        actions.append(learningReviewButton(identity._id, 'experience', experience));
      }
      const retract = document.createElement('button');
      retract.type = 'button';
      retract.className = 'danger-inline';
      retract.textContent = 'Retract';
      retract.addEventListener('click', () => {
        experienceRetractDraftId = experience._id;
        learningViewChanged.changed();
      });
      actions.append(retract);
      row.append(actions);
      if (experienceRetractDraftId === experience._id) {
        const inline = document.createElement('div');
        inline.className = 'learning-inline-action';
        const label = document.createElement('label');
        label.textContent = 'Reason';
        const input = document.createElement('input');
        input.id = `experience-retract-reason-${experience._id}`;
        label.htmlFor = input.id;
        input.type = 'text';
        input.maxLength = 500;
        input.placeholder = 'Required';
        const controls = document.createElement('div');
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => {
          experienceRetractDraftId = null;
          learningViewChanged.changed();
        });
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'danger-inline';
        confirm.textContent = 'Retract experience';
        confirm.addEventListener('click', async () => {
          const reason = input.value.trim();
          if (!reason) { input.setCustomValidity('Enter a reason.'); input.reportValidity(); return; }
          input.setCustomValidity('');
          await withControlBusy(confirm, 'Retracting', async () => {
            try {
              await Meteor.callAsync(
                'constellation.experienceRetract', identity._id, experience._id, reason,
              );
              experienceRetractDraftId = null;
              learningViewChanged.changed();
              toast('Experience retracted.');
            } catch (error) {
              showAgentLearningError(error);
            }
          });
        });
        controls.append(cancel, confirm);
        inline.append(label, input, controls);
        row.append(inline);
        requestAnimationFrame(() => input.focus());
      }
    }
    list.append(row);
  }
  return rows;
}

function appendFrameAuditField(list, label, value, { code = false, integrity = false } = {}) {
  if (value === undefined || value === null || value === '') return;
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.classList.toggle('is-integrity-warning', integrity);
  const content = document.createElement(code ? 'code' : 'span');
  content.textContent = String(value);
  description.append(content);
  list.append(term, description);
}

function appendFrameEvidenceGroup(container, title, rows, describe) {
  const section = document.createElement('section');
  const heading = document.createElement('h5');
  heading.textContent = `${title} · ${rows.length}`;
  section.append(heading);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.textContent = 'None';
    section.append(empty);
  } else {
    const list = document.createElement('ul');
    for (const row of rows) {
      const item = document.createElement('li');
      const value = document.createElement('code');
      value.textContent = describe(row);
      item.append(value);
      list.append(item);
    }
    section.append(list);
  }
  container.append(section);
}

function memoryFrameAuditDetails(frame) {
  const details = document.createElement('details');
  details.className = 'frame-audit-details';
  const audienceLabel = experienceAudienceLabel(frame.audience);
  const promptVersion = frame.protectedPromptVersion;
  const promptVersionAbsent = promptVersion === undefined || promptVersion === null;
  const promptVersionSupported = promptVersion === 1 || promptVersion === 2;
  const integrityWarning = audienceLabel === 'Unknown'
    || (!promptVersionAbsent && !promptVersionSupported);
  details.classList.toggle('has-integrity-warning', integrityWarning);
  const summary = document.createElement('summary');
  summary.textContent = integrityWarning ? 'Inspect snapshot · integrity warning' : 'Inspect snapshot';
  const fields = document.createElement('dl');
  appendFrameAuditField(fields, 'Frame ID', frame._id, { code: true });
  appendFrameAuditField(fields, 'Trigger context', frame.context);
  appendFrameAuditField(
    fields,
    'Audience',
    `${audienceLabel} · ${frame.audience?.key ?? 'Unknown'}`,
    { code: true, integrity: audienceLabel === 'Unknown' },
  );
  const policy = frame.learningPolicy;
  const legacyPolicy = !policy;
  const experienceAdmission = policy?.experienceAdmission ?? 'reviewed';
  const practiceAcquisition = policy?.practiceAcquisition ?? 'disabled';
  const experienceAdmissionLabel = ({
    reviewed: 'Approval required', automatic: 'Automatic',
  })[experienceAdmission] ?? `Unknown · ${String(experienceAdmission)}`;
  const practiceAcquisitionLabel = ({
    disabled: 'Disabled', reviewed: 'Review candidates', automatic: 'Auto-validate candidates',
  })[practiceAcquisition] ?? `Unknown · ${String(practiceAcquisition)}`;
  appendFrameAuditField(
    fields,
    'Experience admission',
    `${experienceAdmissionLabel}${legacyPolicy ? ' · legacy default' : ''}`,
    { integrity: !['reviewed', 'automatic'].includes(experienceAdmission) },
  );
  appendFrameAuditField(
    fields,
    'Practice acquisition',
    `${practiceAcquisitionLabel}${legacyPolicy ? ' · legacy default' : ''}`,
    { integrity: !['disabled', 'reviewed', 'automatic'].includes(practiceAcquisition) },
  );
  appendFrameAuditField(
    fields,
    'Scoped evidence promotion',
    `${policy?.allowScopedEvidencePromotion === true ? 'Allowed' : 'Blocked'}${legacyPolicy ? ' · legacy default' : ''}`,
  );
  appendFrameAuditField(fields, 'Frame digest', frame.digest, { code: true });
  appendFrameAuditField(
    fields,
    'Prompt format',
    promptVersionAbsent
      ? 'Unversioned · legacy compatibility'
      : promptVersionSupported ? `v${promptVersion}` : `Unsupported · ${String(promptVersion)}`,
    { integrity: !promptVersionAbsent && !promptVersionSupported },
  );
  appendFrameAuditField(fields, 'Protected prompt digest', frame.protectedPromptDigest, { code: true });
  appendFrameAuditField(fields, 'Fact prompt digest', frame.factMemory?.promptDigest, { code: true });
  details.append(summary, fields);

  const evidence = document.createElement('div');
  evidence.className = 'frame-audit-evidence';
  appendFrameEvidenceGroup(
    evidence,
    'Constitution',
    frame.constitution ? [frame.constitution] : [],
    (row) => `${row.id ?? 'unknown'} · v${row.revision ?? '—'} · ${row.digest ?? 'digest unavailable'}`,
  );
  appendFrameEvidenceGroup(
    evidence,
    'Practices',
    Array.isArray(frame.practices) ? frame.practices : [],
    (row) => `${row.id ?? 'unknown'} · v${row.revision ?? '—'} · ${row.status ?? 'unknown'} · ${row.digest ?? 'digest unavailable'}`,
  );
  appendFrameEvidenceGroup(
    evidence,
    'Experience',
    Array.isArray(frame.experiences) ? frame.experiences : [],
    (row) => `${row.id ?? 'unknown'} · ${row.digest ?? 'digest unavailable'}`,
  );
  appendFrameEvidenceGroup(
    evidence,
    'Fact memory',
    Array.isArray(frame.factMemory?.evidence) ? frame.factMemory.evidence : [],
    (row) => `${row.id ?? 'unknown'} · ${row.scope ?? 'unknown'} · ${row.digest ?? 'digest unavailable'}`,
  );
  details.append(evidence);
  if (frame.digest) {
    const actions = document.createElement('div');
    actions.className = 'frame-audit-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy frame digest';
    copy.addEventListener('click', () => void copyText(frame.digest, 'Frame digest copied.'));
    actions.append(copy);
    details.append(actions);
  }
  return details;
}

function renderMemoryFrames(identity, ready) {
  const loading = $('frames-loading');
  const content = $('frames-content');
  const list = $('memory-frame-list');
  list.replaceChildren();
  if (!ready) {
    setLearningPanelState(
      loading,
      learningSubscriptionError ? 'error' : 'loading',
      learningSubscriptionError ? 'Memory frames unavailable.' : 'Loading memory frames…',
    );
    content.hidden = true;
    $('agent-frame-count').textContent = '…';
    return [];
  }
  if (!identity) {
    setLearningPanelState(loading, 'empty', 'Memory frames unavailable.');
    content.hidden = true;
    $('agent-frame-count').textContent = '0';
    return [];
  }
  loading.hidden = true;
  content.hidden = false;
  const published = AgentMemoryFrames.find(
    { agentId: identity._id }, { sort: { createdAt: -1 } },
  ).fetch();
  const frames = published.slice(0, 12);
  $('agent-frame-count').textContent = String(frames.length);
  $('memory-frame-count').textContent = frames.length
    ? `Latest ${frames.length} frames` : 'No frames';
  if (!frames.length) appendLearningEmpty(
    list,
    'No Memory Frames yet. A Frame is created after this agent’s next turn.',
  );
  for (const frame of frames) {
    const session = AgentSessions.findOne(frame.sessionId);
    const mission = MissionConfigs.findOne(frame.sessionId);
    const title = mission?.title ?? session?.title ?? `Session ${String(frame.sessionId).slice(-6)}`;
    const facts = frame.factMemory?.evidence?.length ?? 0;
    const practices = frame.practices?.length ?? 0;
    const experiences = frame.experiences?.length ?? 0;
    const constitution = frame.constitution?.revision
      ? `Constitution v${frame.constitution.revision}` : 'No constitution';
    const row = learningCard({
      title,
      subtitle: `Turn ${frame.triggerSeq} · ${timeAgo(frame.createdAt)}`,
      body: `${constitution} · ${practices} practices · ${experiences} experiences · ${facts} facts`,
    });
    const metadata = document.createElement('div');
    metadata.className = 'learning-card-meta';
    const audience = document.createElement('span');
    audience.textContent = `${experienceAudienceLabel(frame.audience)} scope`;
    audience.classList.toggle(
      'is-integrity-warning', experienceAudienceLabel(frame.audience) === 'Unknown',
    );
    const digest = document.createElement('span');
    digest.textContent = `Digest ${String(frame.digest).slice(0, 12)}`;
    metadata.append(audience, digest);
    row.append(metadata, memoryFrameAuditDetails(frame));
    list.append(row);
  }
  return frames;
}

function practiceGuidance(practice) {
  return learningText(practice.guidance) || 'No guidance.';
}

function activatePracticeDraft(identity) {
  let draft = practiceDrafts.get(identity._id);
  if (!draft) {
    draft = {
      agentId: identity._id,
      key: '',
      context: '',
      trigger: '',
      guidance: '',
      evidenceIds: new Set(),
    };
    practiceDrafts.set(identity._id, draft);
  }
  const changedAgent = practiceDraft !== draft;
  practiceDraft = draft;
  practiceEvidenceDraft = draft.evidenceIds;
  if (changedAgent) {
    $('practice-key').value = draft.key;
    $('practice-context').value = draft.context;
    $('practice-trigger').value = draft.trigger;
    $('practice-guidance').value = draft.guidance;
  }
  updatePracticeDraftState();
  return draft;
}

function practiceDraftIsDirty(draft) {
  return !!draft && !!(
    draft.key.trim() || draft.context.trim() || draft.trigger.trim() || draft.guidance.trim()
    || draft.evidenceIds.size
  );
}

function updatePracticeDraftState() {
  const dirty = !!practiceDraftIsDirty(practiceDraft);
  $('practice-compose').classList.toggle('has-draft', dirty);
  $('practice-draft-state').textContent = dirty
    ? 'Draft not proposed · open to continue'
    : 'Add reusable guidance from selected Experience.';
}

function practiceEvidenceRows(practice, experiences) {
  const byId = new Map(experiences.map((experience) => [experience._id, experience]));
  const evidenceIds = Array.isArray(practice.evidenceIds) ? practice.evidenceIds : [];
  return evidenceIds.map((id) => ({ id, experience: byId.get(id) ?? null }));
}

function laterPracticeEvidence(practice, experiences) {
  if (!Number.isInteger(practice.validationWatermark)) return [];
  return experiences.filter((experience) => (
    (experience.status ?? 'active') === 'active'
    && learningText(experience.context) === learningText(practice.context)
    && Number(experience.sequence) > practice.validationWatermark
  ));
}

function practiceTransitions(practice, experiences, identity) {
  const evidenceRows = practiceEvidenceRows(practice, experiences);
  const evidenceBlockers = [
    ...(!evidenceRows.length ? ['Needs at least one exact Experience.'] : []),
    ...(evidenceRows.some(({ experience }) => !experience)
      ? ['One or more evidence Experiences are unavailable.'] : []),
    ...(evidenceRows.some(({ experience }) => (
      experience && (experience.status ?? 'active') !== 'active'
    )) ? ['One or more evidence Experiences are not active.'] : []),
  ];
  if (practice.status === 'candidate') {
    return [
      {
        next: 'validated', label: 'Validate', disabled: evidenceBlockers.length > 0,
        title: evidenceBlockers.join(' '),
      },
      { next: 'rejected', label: 'Reject' },
    ];
  }
  if (practice.status === 'validated') {
    const hardeningEvidenceOptions = laterPracticeEvidence(practice, experiences);
    const capacityAvailable = Number(identity?.flexibility?.available ?? 0) > 0;
    const blockers = [
      ...evidenceBlockers,
      ...(!hardeningEvidenceOptions.length
        ? ['Needs a later active Experience in this context.'] : []),
      ...(!capacityAvailable ? ['No Practice capacity is available.'] : []),
    ];
    return [
      {
        next: 'hardened',
        label: 'Harden',
        disabled: blockers.length > 0,
        title: blockers.join(' '),
        hardeningEvidenceOptions,
      },
      { next: 'retired', label: 'Retire' },
      { next: 'rejected', label: 'Reject' },
    ];
  }
  if (practice.status === 'hardened') return [{ next: 'retired', label: 'Retire' }];
  return [];
}

function appendPracticeEvidenceRecords(card, practice, experiences) {
  const evidenceRows = practiceEvidenceRows(practice, experiences);
  const section = document.createElement('section');
  section.className = 'practice-evidence-records';
  const heading = document.createElement('h5');
  heading.textContent = `Exact evidence · ${evidenceRows.length}`;
  section.append(heading);
  if (!evidenceRows.length) {
    const missing = document.createElement('p');
    missing.className = 'is-integrity-warning';
    missing.textContent = 'No Experience evidence is attached.';
    section.append(missing);
  }
  for (const { id, experience } of evidenceRows) {
    const evidence = document.createElement('div');
    evidence.className = `practice-evidence-record${experience ? '' : ' is-unresolved'}`;
    const copy = document.createElement('span');
    copy.textContent = experience
      ? experienceSummary(experience) : 'Experience unavailable in the latest published records';
    const audience = document.createElement('small');
    audience.textContent = experience
      ? `Audience · ${experienceAudienceText(experience.audience)} · ${experience.status ?? 'active'}`
      : 'Unknown audience · unresolved';
    const exactId = document.createElement('code');
    exactId.textContent = id;
    evidence.append(copy, audience, exactId);
    section.append(evidence);
  }
  card.append(section);
  return evidenceRows.some(({ experience }) => !experience) || !evidenceRows.length;
}

function appendPracticePromotionWarning(card) {
  const warning = document.createElement('p');
  warning.className = 'practice-promotion-warning';
  warning.textContent = 'Promotion makes this guidance Agent-identity-wide across every chat and owner using this identity.';
  card.append(warning);
}

function updatePracticeEvidenceState(experiences) {
  $('practice-evidence-count').textContent = `${practiceEvidenceDraft.size} / ${PRACTICE_EVIDENCE_MAX} selected`;
  const selected = experiences.filter((row) => practiceEvidenceDraft.has(row._id));
  const promotedAudiences = [...new Set(selected
    .map((row) => experienceAudienceLabel(row.audience))
    .filter((audience) => audience !== 'Agent identity'))];
  const note = $('practice-scope-note');
  note.dataset.scopeState = promotedAudiences.length ? 'declassification' : 'identity';
  note.textContent = promotedAudiences.length
    ? `Declassification · selected Experience scope: ${promotedAudiences.join(' / ')} · promotion makes guidance Agent-identity-wide across every chat and owner using this identity`
    : 'Promotion makes guidance Agent-identity-wide across every chat and owner using this identity.';
}

function renderPracticeEvidence(experiences) {
  const list = $('practice-evidence-list');
  list.replaceChildren();
  const active = experiences.filter((row) => (row.status ?? 'active') === 'active');
  const contextField = $('practice-context');
  const requestedContext = contextField.value.trim();
  const eligible = active.filter((row) => (
    !requestedContext || learningText(row.context) === requestedContext
  ));
  const activeIds = new Set(eligible.map((row) => row._id));
  practiceEvidenceDraft = new Set(
    [...practiceEvidenceDraft].filter((experienceId) => activeIds.has(experienceId)),
  );
  if (practiceDraft) practiceDraft.evidenceIds = practiceEvidenceDraft;
  updatePracticeDraftState();
  updatePracticeEvidenceState(experiences);
  if (!active.length) {
    const empty = document.createElement('p');
    empty.className = 'compact-empty';
    empty.textContent = 'No active experience.';
    list.append(empty);
    return;
  }
  if (!eligible.length) {
    const empty = document.createElement('p');
    empty.className = 'compact-empty';
    empty.textContent = 'No active experience in this context.';
    list.append(empty);
    return;
  }
  for (const experience of eligible) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = experience._id;
    input.checked = practiceEvidenceDraft.has(experience._id);
    input.addEventListener('change', () => {
      if (input.checked) {
        if (practiceEvidenceDraft.size >= PRACTICE_EVIDENCE_MAX) {
          input.checked = false;
          showAgentLearningError(new Error(
            `Select no more than ${PRACTICE_EVIDENCE_MAX} Experience records.`,
          ));
          return;
        }
        practiceEvidenceDraft.add(experience._id);
        if (!contextField.value.trim() && experience.context) {
          contextField.value = experience.context;
          if (practiceDraft) practiceDraft.context = contextField.value;
          renderPracticeEvidence(experiences);
          return;
        }
      } else practiceEvidenceDraft.delete(experience._id);
      if (practiceDraft) practiceDraft.evidenceIds = practiceEvidenceDraft;
      updatePracticeDraftState();
      updatePracticeEvidenceState(experiences);
    });
    const copy = document.createElement('span');
    copy.textContent = [
      experienceSummary(experience),
      learningText(experience.context),
      `${experienceAudienceLabel(experience.audience)} scope`,
    ]
      .filter(Boolean).join(' · ');
    label.append(input, copy);
    list.append(label);
  }
}

function renderPractices(identity, experiences, ready, readOnly = false) {
  const loading = $('practices-loading');
  const content = $('practices-content');
  if (!ready) {
    setLearningPanelState(
      loading,
      learningSubscriptionError ? 'error' : 'loading',
      learningSubscriptionError ? 'Practices unavailable.' : 'Loading practices…',
    );
    content.hidden = true;
    return [];
  }
  if (!identity) {
    setLearningPanelState(loading, 'empty', 'Practices unavailable.');
    content.hidden = true;
    return [];
  }
  loading.hidden = true;
  content.hidden = false;
  content.querySelector('.practice-compose').hidden = readOnly;
  activatePracticeDraft(identity);
  const rows = AgentPractices.find(
    { agentId: identity._id }, { sort: { updatedAt: -1, createdAt: -1 } },
  ).fetch();
  const activeCount = rows.filter((row) => ['validated', 'hardened'].includes(row.status)).length;
  $('practices-summary').textContent = `Latest ${rows.length} records · ${activeCount} active · ${rows.filter((row) => row.status === 'candidate').length} candidate`;
  renderPracticeEvidence(experiences);
  const list = $('practice-list');
  list.replaceChildren();
  if (!rows.length) appendLearningEmpty(
    list,
    'No Practices yet. Add one here or let this agent propose one during a turn.',
  );
  for (const practice of rows) {
    const row = learningCard({
      title: practice.key || 'Practice',
      subtitle: [practice.context, `Version ${practice.revision ?? '—'}`, learningSourceLabel(practice)]
        .filter(Boolean).join(' · '),
      body: practiceGuidance(practice),
      status: practice.status,
      muted: ['retired', 'rejected'].includes(practice.status),
    });
    const metadata = document.createElement('div');
    metadata.className = 'learning-card-meta';
    const admission = appendLearningAdmission(metadata, 'practice', practice);
    const trigger = learningText(practice.trigger);
    if (trigger) {
      const triggerLabel = document.createElement('span');
      triggerLabel.textContent = `Trigger · ${trigger}`;
      metadata.append(triggerLabel);
    }
    const evidenceIds = Array.isArray(practice.evidenceIds) ? practice.evidenceIds : [];
    const evidence = document.createElement('span');
    evidence.textContent = `${evidenceIds.length} evidence`;
    metadata.append(evidence);
    if (practice.transitionReason) {
      const reason = document.createElement('span');
      reason.textContent = `Reason · ${concise(practice.transitionReason, 160)}`;
      metadata.append(reason);
    }
    if (practice.status === 'validated' && Number.isInteger(practice.validationWatermark)) {
      const eligible = laterPracticeEvidence(practice, experiences).length > 0;
      const validation = document.createElement('span');
      validation.textContent = eligible
        ? 'Later evidence available'
        : 'Needs later active evidence in this context';
      metadata.append(validation);
      if (Number(identity.flexibility?.available ?? 0) < 1) {
        const capacity = document.createElement('span');
        capacity.className = 'learning-capacity-blocker';
        capacity.textContent = 'No Practice capacity available';
        metadata.append(capacity);
      }
    }
    if (practice.hardenedEvidenceId) {
      const proof = AgentExperiences.findOne({
        _id: practice.hardenedEvidenceId, agentId: identity._id,
      });
      const hardening = document.createElement('span');
      hardening.textContent = proof
        ? `Hardened with · ${concise(experienceSummary(proof), 120)} · Audience ${experienceAudienceText(proof.audience)} · ${proof._id}`
        : `Hardening evidence unavailable · ${practice.hardenedEvidenceId}`;
      hardening.classList.toggle('is-integrity-warning', !proof);
      metadata.append(hardening);
    }
    row.append(metadata);
    if (['candidate', 'validated'].includes(practice.status)) {
      const evidenceIntegrityIssue = appendPracticeEvidenceRecords(row, practice, experiences);
      row.classList.toggle('has-integrity-warning', evidenceIntegrityIssue);
      appendPracticePromotionWarning(row);
    }
    const transitions = practiceTransitions(practice, experiences, identity);
    if ((transitions.length || admission.pending) && !readOnly) {
      const actions = document.createElement('div');
      actions.className = 'learning-card-actions';
      if (admission.pending) {
        actions.append(learningReviewButton(identity._id, 'practice', practice));
      }
      for (const transition of transitions) {
        const { next, label } = transition;
        const action = document.createElement('button');
        action.type = 'button';
        action.className = ['retired', 'rejected'].includes(next) ? 'danger-inline' : '';
        action.textContent = label;
        action.disabled = !!transition.disabled;
        if (transition.title) action.title = transition.title;
        action.addEventListener('click', () => {
          practiceTransitionDraft = {
            id: practice._id,
            next,
            ...(next === 'hardened' ? { hardeningEvidenceId: '' } : {}),
          };
          learningViewChanged.changed();
        });
        actions.append(action);
      }
      const disabledReasons = transitions
        .filter((transition) => transition.disabled && transition.title)
        .map((transition) => `${transition.label}: ${transition.title}`);
      if (disabledReasons.length) {
        const blocker = document.createElement('p');
        blocker.className = 'learning-action-blocker';
        blocker.textContent = disabledReasons.join(' ');
        actions.append(blocker);
      }
      row.append(actions);
    }
    const pendingTransition = transitions.find(
      ({ next }) => next === practiceTransitionDraft?.next,
    );
    if (!readOnly && practiceTransitionDraft?.id === practice._id
      && pendingTransition && !pendingTransition.disabled) {
      const inline = document.createElement('div');
      inline.className = 'learning-inline-action';
      let hardeningEvidenceSelect = null;
      if (practiceTransitionDraft.next === 'hardened') {
        const evidenceLabel = document.createElement('label');
        evidenceLabel.textContent = 'Later Experience used to harden';
        hardeningEvidenceSelect = document.createElement('select');
        hardeningEvidenceSelect.id = `practice-hardening-evidence-${practice._id}`;
        hardeningEvidenceSelect.required = true;
        evidenceLabel.htmlFor = hardeningEvidenceSelect.id;
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select exact later evidence';
        hardeningEvidenceSelect.append(placeholder);
        for (const experience of pendingTransition.hardeningEvidenceOptions ?? []) {
          const option = document.createElement('option');
          option.value = experience._id;
          option.textContent = [
            experienceSummary(experience),
            `Audience ${experienceAudienceText(experience.audience)}`,
            `sequence ${experience.sequence ?? '—'}`,
            experience._id,
          ].join(' · ');
          hardeningEvidenceSelect.append(option);
        }
        hardeningEvidenceSelect.value = practiceTransitionDraft.hardeningEvidenceId ?? '';
        hardeningEvidenceSelect.addEventListener('change', () => {
          if (practiceTransitionDraft?.id === practice._id) {
            practiceTransitionDraft.hardeningEvidenceId = hardeningEvidenceSelect.value;
          }
        });
        evidenceLabel.append(hardeningEvidenceSelect);
        inline.append(evidenceLabel);
      }
      const label = document.createElement('label');
      label.textContent = `Reason to ${practiceTransitionDraft.next}`;
      const input = document.createElement('input');
      input.id = `practice-transition-reason-${practice._id}`;
      label.htmlFor = input.id;
      input.type = 'text';
      input.maxLength = 500;
      input.placeholder = 'Required';
      const controls = document.createElement('div');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        practiceTransitionDraft = null;
        learningViewChanged.changed();
      });
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.textContent = practiceTransitionDraft.next === 'rejected' ? 'Reject' : 'Confirm';
      confirm.addEventListener('click', async () => {
        const reason = input.value.trim();
        if (!reason) { input.setCustomValidity('Enter a reason.'); input.reportValidity(); return; }
        input.setCustomValidity('');
        const next = practiceTransitionDraft?.next;
        if (!next) return;
        const hardeningEvidenceId = next === 'hardened'
          ? hardeningEvidenceSelect?.value.trim() : undefined;
        if (next === 'hardened' && !hardeningEvidenceId) {
          hardeningEvidenceSelect.setCustomValidity('Select the exact later Experience.');
          hardeningEvidenceSelect.reportValidity();
          return;
        }
        hardeningEvidenceSelect?.setCustomValidity('');
        await withControlBusy(confirm, 'Saving', async () => {
          try {
            const args = [
              'constellation.practiceTransition', identity._id, practice._id, next, reason,
            ];
            if (next === 'hardened') args.push(hardeningEvidenceId);
            await Meteor.callAsync(...args);
            practiceTransitionDraft = null;
            learningViewChanged.changed();
            toast(`Practice ${next}.`);
          } catch (error) {
            showAgentLearningError(error);
          }
        });
      });
      controls.append(cancel, confirm);
      inline.append(label, input, controls);
      row.append(inline);
      requestAnimationFrame(() => (hardeningEvidenceSelect ?? input).focus());
    }
    list.append(row);
  }
  return rows;
}

function renderAgentLearning(config) {
  renderAgentDetailTabs(config);
  const ready = learningIsReady();
  const identity = agentIdentityForConfig(config);
  updateCrewLearningControls(config);
  const readOnly = crewConfigArchived(config);
  $('agent-learning-read-only').hidden = !readOnly;
  const constitution = renderConstitution(config, identity, ready, readOnly);
  const experiences = renderExperience(identity, ready, readOnly);
  const frames = renderMemoryFrames(identity, ready);
  const practices = renderPractices(identity, experiences, ready, readOnly);
  const activeExperiences = experiences.filter((row) => (row.status ?? 'active') === 'active');
  const activePractices = practices.filter((row) => ['validated', 'hardened'].includes(row.status));
  if (!ready) {
    for (const id of [
      'agent-constitution-stat', 'agent-experience-stat', 'agent-practice-stat',
      'agent-frame-stat', 'agent-experience-count', 'agent-practice-count', 'agent-frame-count',
    ]) $(id).textContent = '…';
    $('agent-constitution-stat').classList.remove('is-integrity-warning');
  } else {
    $('agent-constitution-stat').textContent = constitution.unresolved
      ? 'Unavailable'
      : constitution.current ? `v${constitution.current.revision ?? '—'}` : '—';
    $('agent-constitution-stat').classList.toggle('is-integrity-warning', !!constitution.unresolved);
    $('agent-experience-stat').textContent = String(activeExperiences.length);
    $('agent-practice-stat').textContent = String(activePractices.length);
    $('agent-frame-stat').textContent = frames[0] ? timeAgo(frames[0].createdAt) : '—';
    $('agent-experience-count').textContent = String(experiences.length);
    $('agent-practice-count').textContent = String(practices.length);
  }
  if (learningSubscriptionError) {
    showAgentLearningError(learningSubscriptionError, {
      actionLabel: 'Retry', action: retryLearningSubscription,
    });
  }
}

function reviewAgentConfig(agentId) {
  return agentConfigForId(agentId);
}

function focusAgentLearning(agentId, tab) {
  const config = reviewAgentConfig(agentId);
  if (!config || !selectCrewConfig(config._id)) return;
  setCrewDirectoryTab('agents');
  setAgentDetailTab(tab);
  requestAnimationFrame(() => $(`agent-detail-tab-${tab}`)?.focus());
}

function openLearningReviews() {
  openCrewSettings();
  setCrewDirectoryTab('reviews');
  requestAnimationFrame(() => {
    const firstAction = $('reviews-list')?.querySelector('button:not(:disabled)');
    (firstAction ?? $('crew-directory-tab-reviews'))?.focus();
  });
}

function reviewKey(item) {
  return `${String(item.kind).toLowerCase()}:${item.row._id}`;
}

function appendReviewRow(list, item, { recent = false } = {}) {
  const row = document.createElement('article');
  row.className = `review-row${recent ? ' is-recent' : ''}`;
  row.setAttribute('role', 'listitem');
  row.dataset.reviewKey = reviewKey(item);
  const icon = document.createElement('span');
  icon.className = 'review-row-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = item.kind.slice(0, 1);
  const copy = document.createElement('div');
  copy.className = 'review-row-copy';
  const title = document.createElement('strong');
  const agentName = agentDisplayName(item.agentId);
  title.textContent = `${agentName} · ${item.title}`;
  const body = document.createElement('p');
  body.textContent = concise(item.body, 180) || item.kind;
  const meta = document.createElement('span');
  meta.textContent = [
    item.pendingKind === 'approval' ? 'Approval needed'
      : item.pendingKind === 'audit' ? 'Audit acknowledgment needed' : item.state ?? item.kind,
    item.lifecycle,
    learningSourceLabel(item.row),
  ]
    .filter(Boolean).join(' · ');
  copy.append(title, body, meta);
  const actions = document.createElement('div');
  actions.className = 'review-row-actions';
  if (item.pendingKind === 'audit') {
    const config = reviewAgentConfig(item.agentId);
    const review = learningReviewButton(item.agentId, item.target, item.row, {
      inlineError: false,
      ariaLabel: `Acknowledge ${item.kind.toLowerCase()} audit for ${agentName}: ${item.title}`,
    });
    review.disabled = !config || crewConfigArchived(config);
    if (review.disabled) review.title = config ? 'Restore this agent first.' : 'Agent unavailable.';
    actions.append(review);
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = item.pendingKind === 'approval'
    ? 'Review practice'
    : item.pendingKind === 'audit' ? `Open ${item.kind.toLowerCase()}` : 'Open';
  open.setAttribute(
    'aria-label',
    `${item.pendingKind === 'approval' ? 'Review' : 'Open'} ${item.kind.toLowerCase()} for ${agentName}: ${item.title}`,
  );
  open.disabled = !reviewAgentConfig(item.agentId);
  open.addEventListener('click', () => focusAgentLearning(item.agentId, item.tab));
  actions.append(open);
  row.append(icon, copy, actions);
  list.append(row);
}

function restoreReviewFocus() {
  if (!reviewFocusRequest) return;
  const requested = reviewFocusRequest;
  reviewFocusRequest = null;
  requestAnimationFrame(() => {
    const escaped = requested === 'queue' ? null : CSS.escape(requested);
    const row = escaped
      ? $('reviews-list')?.querySelector(`[data-review-key="${escaped}"]`)
      : null;
    const target = row?.querySelector('button:not(:disabled)')
      ?? $('reviews-list')?.querySelector('button:not(:disabled)')
      ?? $('crew-directory-tab-reviews');
    target?.focus({ preventScroll: true });
  });
}

function renderReviews() {
  learningViewChanged.depend();
  const ready = learningIsReady();
  const loading = $('reviews-loading');
  const content = $('reviews-content');
  const needsList = $('reviews-list');
  const recentList = $('reviews-recent-list');
  if (!ready) {
    setLearningPanelState(
      loading,
      learningSubscriptionError ? 'error' : 'loading',
      learningSubscriptionError ? 'Reviews unavailable.' : 'Loading reviews…',
    );
    $('reviews-retry-learning').hidden = !learningSubscriptionError;
    content.hidden = true;
    return;
  }
  const practices = AgentPractices.find(
    {}, { sort: { updatedAt: -1, createdAt: -1 } },
  ).fetch();
  const candidates = practices.filter((row) => row.status === 'candidate');
  const automaticPracticeReviews = practices.filter(
    (row) => learningAdmissionState('practice', row).pending,
  );
  const constitutions = AgentConstitutions.find(
    {}, { sort: { createdAt: -1 }, limit: 12 },
  ).fetch();
  const allExperiences = AgentExperiences.find(
    {}, { sort: { createdAt: -1 } },
  ).fetch();
  const automaticExperienceReviews = allExperiences.filter(
    (row) => learningAdmissionState('experience', row).pending,
  );
  const pendingCount = candidates.length
    + automaticPracticeReviews.length + automaticExperienceReviews.length;
  const attentionCopy = `${pendingCount} ${pendingCount === 1 ? 'item needs' : 'items need'} attention`;
  $('crew-reviews-count').textContent = String(pendingCount);
  $('mission-reviews-count').textContent = String(pendingCount);
  $('open-learning-reviews').setAttribute(
    'aria-label',
    `Open learning reviews, ${attentionCopy}`,
  );
  $('command-reviews-count').textContent = attentionCopy;
  $('reviews-directory-summary').textContent = attentionCopy;
  $('reviews-needs-count').textContent = String(pendingCount);
  loading.hidden = true;
  $('reviews-retry-learning').hidden = true;
  content.hidden = false;
  needsList.replaceChildren();
  recentList.replaceChildren();
  const actionable = [
    ...candidates.map((row) => ({
      kind: 'Practice', agentId: row.agentId, row, pendingKind: 'approval',
      title: row.key || 'Practice candidate', body: practiceGuidance(row), tab: 'practices',
      lifecycle: 'Candidate',
    })),
    ...automaticPracticeReviews.map((row) => ({
      kind: 'Practice', target: 'practice', agentId: row.agentId, row,
      pendingKind: 'audit', title: row.key || 'Practice', body: practiceGuidance(row),
      tab: 'practices',
      lifecycle: row.status,
    })),
    ...automaticExperienceReviews.map((row) => ({
      kind: 'Experience', target: 'experience', agentId: row.agentId, row,
      pendingKind: 'audit', title: experienceSummary(row), body: experienceBody(row),
      tab: 'experience', lifecycle: row.status === 'retracted' ? 'Retracted' : 'Active',
    })),
  ].sort((left, right) => new Date(learningAt(right.row)) - new Date(learningAt(left.row)));
  if (!actionable.length) appendLearningEmpty(needsList, 'Nothing needs attention.');
  for (const item of actionable) appendReviewRow(needsList, item);

  const pendingPracticeIds = new Set([
    ...candidates, ...automaticPracticeReviews,
  ].map((row) => row._id));
  const pendingExperienceIds = new Set(automaticExperienceReviews.map((row) => row._id));
  const recent = [
    ...constitutions.map((row) => ({
      kind: 'Constitution', agentId: row.agentId, row,
      title: `Constitution v${row.revision ?? '—'}`,
      body: learningText(row.content), tab: 'constitution',
      state: AgentIdentities.findOne(row.agentId)?.constitutionVersionId === row._id
        ? 'Active' : 'Superseded',
    })),
    ...practices.filter((row) => !pendingPracticeIds.has(row._id)).map((row) => ({
      kind: 'Practice', agentId: row.agentId, row,
      title: row.key || 'Practice', body: practiceGuidance(row), tab: 'practices',
      state: learningAdmissionState('practice', row).label,
      lifecycle: row.status,
    })),
    ...allExperiences.filter((row) => !pendingExperienceIds.has(row._id)).map((row) => {
      const admission = learningAdmissionState('experience', row);
      return {
        kind: 'Experience', target: 'experience', agentId: row.agentId, row,
        title: experienceSummary(row), body: experienceBody(row), tab: 'experience',
        state: admission.label,
        lifecycle: row.status === 'retracted' ? 'Retracted' : 'Active',
      };
    }),
  ]
    .sort((left, right) => new Date(learningAt(right.row)) - new Date(learningAt(left.row)))
    .slice(0, 24);
  $('reviews-recent-count').textContent = String(recent.length);
  if (!recent.length) appendLearningEmpty(recentList, 'No learning history yet.');
  for (const item of recent) appendReviewRow(recentList, item, { recent: true });
  restoreReviewFocus();
}

function crewExperienceConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const recent = Number.isSafeInteger(source.recent) ? source.recent : 4;
  return {
    record: source.record !== false,
    recall: source.recall !== false && recent > 0,
    recent,
    scope: ['owner', 'session', 'identity'].includes(source.scope) ? source.scope : 'owner',
    approval: source.approval === 'auto' ? 'auto' : 'ask',
  };
}

function crewPracticeConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    acquire: source.acquire === true,
    approval: source.approval === 'auto' ? 'auto' : 'ask',
    allowScopedEvidencePromotion: source.allowScopedEvidencePromotion === true,
  };
}

function crewConfigPatch(config) {
  const experience = crewExperienceConfig(config.experience);
  const practice = crewPracticeConfig(config.practice);
  return {
    ...(Number.isSafeInteger(config.revision) ? { expectedRevision: config.revision } : {}),
    displayName: config.displayName,
    role: config.role,
    avatar: config.avatar,
    color: config.color,
    instructions: config.instructions,
    model: config.model,
    enabled: config.enabled,
    flexibility: Number(config.flexibility ?? 3),
    experience,
    practice,
    budget: {
      turns: Number(config.budget?.turns ?? 24),
      toolCalls: Number(config.budget?.toolCalls ?? 8),
      spend: Number(config.budget?.spend ?? 1),
    },
    capabilities: {
      inspect: !!config.capabilities?.inspect,
      framing: !!config.capabilities?.framing,
      memory: !!config.capabilities?.memory,
      publish: !!config.capabilities?.publish,
    },
  };
}

function newCrewDraft() {
  const token = randomToken(4);
  return {
    _id: `draft:${token}`,
    agent: `draft-${token}`,
    displayName: 'New agent',
    role: 'Specialist',
    avatar: 'N',
    color: 'violet',
    enabled: true,
    order: 10_000,
    instructions: 'Analyze the assigned scope. State assumptions and return a concise recommendation with next actions.',
    model: 'default',
    flexibility: 3,
    experience: {
      record: true, recall: true, recent: 4, scope: 'owner', approval: 'ask',
    },
    practice: { acquire: false, approval: 'ask', allowScopedEvidencePromotion: false },
    budget: { turns: 24, toolCalls: 8, spend: 1 },
    capabilities: { inspect: true, framing: false, memory: false, publish: false },
    _draft: true,
  };
}

function modelNameFromId(modelId) {
  const name = String(modelId ?? '').split('/').at(-1) || 'Model';
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizedModelCatalog() {
  const catalog = ModelCatalog.findOne('available');
  const providers = Array.isArray(catalog?.providers)
    ? catalog.providers.flatMap((provider) => {
      if (!provider || typeof provider.id !== 'string' || typeof provider.label !== 'string') return [];
      const models = Array.isArray(provider.models)
        ? provider.models.flatMap((entry) => (
          entry && typeof entry.id === 'string' && typeof entry.label === 'string'
            ? [{
              id: entry.id,
              label: entry.label,
              warning: typeof entry.warning === 'string' ? entry.warning : null,
            }] : []
        )) : [];
      const local = provider.kind === 'local' || provider.source === 'local' || provider.local === true
        || ['constellation', 'ollama'].includes(provider.id);
      return models.length ? [{
        id: provider.id,
        label: provider.label,
        kind: local ? 'local' : 'api',
        warning: typeof provider.warning === 'string' ? provider.warning : null,
        models,
      }] : [];
    }) : [];
  const unavailableModels = Array.isArray(catalog?.unavailableModels)
    ? catalog.unavailableModels.flatMap((entry) => (
      entry && typeof entry.id === 'string'
          ? [{
            id: entry.id,
            label: typeof entry.label === 'string' ? entry.label : modelNameFromId(entry.id),
            providerLabel: typeof entry.providerLabel === 'string' ? entry.providerLabel : null,
            reason: typeof entry.reason === 'string' ? entry.reason : null,
          }]
        : []
    )) : [];
  return {
    ready: !!catalog,
    mode: catalog?.mode === 'live' ? 'live' : 'local',
    defaultModel: typeof catalog?.defaultModel === 'string'
      ? catalog.defaultModel : (bootstrap?.model ?? 'constellation/scripted'),
    providers,
    unavailableModels,
  };
}

function modelCatalogEntry(catalog, modelId) {
  for (const provider of catalog.providers) {
    const model = provider.models.find((entry) => entry.id === modelId);
    if (model) return {
      ...model,
      providerId: provider.id,
      providerLabel: provider.label,
      providerKind: provider.kind,
      providerWarning: provider.warning,
    };
  }
  return null;
}

function modelProviderName(modelId) {
  const provider = String(modelId ?? '').split('/')[0];
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Provider';
}

function appendModelOption(group, model, { disabled = false } = {}) {
  const option = document.createElement('option');
  option.value = model.id;
  option.textContent = `${model.label}${disabled ? ' — unavailable' : ''}`;
  option.disabled = disabled;
  group.append(option);
}

function renderCrewModelSelector(selectedModel = 'default') {
  const select = $('crew-model');
  const hint = $('crew-model-hint');
  const catalog = normalizedModelCatalog();
  const requestedModel = String(selectedModel || 'default');
  const defaultEntry = modelCatalogEntry(catalog, catalog.defaultModel);
  const availableEntry = modelCatalogEntry(catalog, requestedModel);
  const savedUnavailable = catalog.unavailableModels.find((entry) => entry.id === requestedModel);
  const unavailable = requestedModel !== 'default' && !availableEntry;

  select.replaceChildren();
  if (!catalog.ready) {
    const option = document.createElement('option');
    option.value = requestedModel;
    option.textContent = 'Loading available models…';
    option.disabled = true;
    option.selected = true;
    select.append(option);
    select.dataset.availabilityDisabled = 'true';
    select.disabled = true;
    hint.dataset.modelState = 'loading';
    hint.textContent = 'Loading available models…';
    return;
  }
  if (catalog.providers.length === 0) {
    const option = document.createElement('option');
    option.value = requestedModel;
    option.textContent = unavailable
      ? `${savedUnavailable?.label ?? modelNameFromId(requestedModel)} — unavailable`
      : 'No models available';
    option.disabled = true;
    option.selected = true;
    select.append(option);
    select.dataset.availabilityDisabled = 'true';
    select.disabled = true;
    hint.dataset.modelState = 'empty';
    hint.textContent = 'No model provider is available. Configure a provider or start a local runtime, then restart Constellation.';
    return;
  }
  select.dataset.availabilityDisabled = 'false';
  select.disabled = false;
  const workspaceGroup = document.createElement('optgroup');
  workspaceGroup.label = 'Workspace';
  appendModelOption(workspaceGroup, {
    id: 'default',
    label: `Use default · ${defaultEntry?.label ?? modelNameFromId(catalog.defaultModel)}`,
  });
  select.append(workspaceGroup);

  for (const provider of catalog.providers) {
    const group = document.createElement('optgroup');
    group.label = provider.label;
    for (const model of provider.models) appendModelOption(group, model);
    select.append(group);
  }

  if (unavailable) {
    const group = document.createElement('optgroup');
    group.label = 'Unavailable saved model';
    appendModelOption(group, {
      id: requestedModel,
      label: savedUnavailable?.label ?? modelNameFromId(requestedModel),
    }, { disabled: true });
    select.append(group);
  }
  select.value = requestedModel;

  if (unavailable) {
    hint.dataset.modelState = 'unavailable';
    hint.textContent = `${savedUnavailable?.providerLabel ?? modelProviderName(requestedModel)} is unavailable with the current provider configuration. This saved value is preserved; this agent can’t run until you choose an available model.`;
    return;
  }
  if (requestedModel === 'default') {
    hint.dataset.modelState = 'default';
    const localStatus = defaultEntry?.providerKind === 'local'
      ? (defaultEntry.providerId === 'ollama' ? ' Detected locally.' : ' Runs locally without an API key.')
      : '';
    const warning = defaultEntry?.warning ?? defaultEntry?.providerWarning;
    hint.textContent = `Workspace default: ${defaultEntry?.providerLabel ? `${defaultEntry.providerLabel} · ` : ''}${defaultEntry?.label ?? modelNameFromId(catalog.defaultModel)}.${localStatus}${warning ? ` ${warning}` : ''}`;
    return;
  }
  hint.dataset.modelState = 'available';
  const availability = availableEntry?.providerKind === 'local'
    ? `${availableEntry.providerLabel} · ${availableEntry.providerId === 'ollama' ? 'Detected locally' : 'Runs locally'} · No API key required.`
    : `${availableEntry?.providerLabel ?? modelProviderName(requestedModel)} · Available with the workspace provider configuration.`;
  const warning = availableEntry?.warning ?? availableEntry?.providerWarning;
  hint.textContent = `${availability}${warning ? ` ${warning}` : ''}`;
}

function resetCrewEditor(config, isNew = false) {
  const patch = crewConfigPatch(config);
  crewEditor = {
    id: config._id,
    config,
    isNew,
    dirty: isNew,
    original: patch,
    patch,
    sourceSignature: JSON.stringify(patch),
  };
}

function populateCrewForm(config) {
  const experience = crewExperienceConfig(config.experience);
  const practice = crewPracticeConfig(config.practice);
  $('crew-name').value = config.displayName;
  $('crew-role').value = config.role;
  $('crew-avatar').value = config.avatar;
  $('crew-color').value = config.color;
  $('crew-instructions').value = config.instructions;
  renderCrewModelSelector(config.model);
  $('crew-enabled').checked = config.enabled;
  $('crew-experience-record').checked = experience.record;
  $('crew-experience-recall').checked = experience.recall;
  $('crew-experience-automatic').checked = experience.approval === 'auto';
  $('crew-experience-scope').value = experience.scope;
  $('crew-experience-recent').value = String(experience.recent);
  $('crew-practice-acquire').checked = practice.acquire;
  $('crew-practice-automatic').checked = practice.approval === 'auto';
  $('crew-practice-scoped-promotion').checked = practice.allowScopedEvidencePromotion;
  $('crew-flexibility').value = String(config.flexibility ?? 3);
  $('crew-turns').value = String(config.budget?.turns ?? 24);
  $('crew-tool-calls').value = String(config.budget?.toolCalls ?? 8);
  $('crew-spend').value = String(config.budget?.spend ?? 1);
  $('crew-cap-inspect').checked = !!config.capabilities?.inspect;
  $('crew-cap-memory').checked = !!config.capabilities?.memory;
  $('crew-cap-publish').checked = !!config.capabilities?.publish;
}

function updateCrewLearningControls(config) {
  const archived = crewConfigArchived(config);
  const recordsExperience = $('crew-experience-record').checked;
  const recallsExperience = $('crew-experience-recall').checked;
  const experienceScope = $('crew-experience-scope').value;
  const experienceAutomatic = $('crew-experience-automatic');
  const acquiresPractice = $('crew-practice-acquire').checked;
  const practiceAutomatic = $('crew-practice-automatic');
  const scopedPromotion = $('crew-practice-scoped-promotion');
  const scopedPromotionRelevant = experienceScope !== 'identity';
  const automaticPracticeEligible = !scopedPromotionRelevant || scopedPromotion.checked;
  experienceAutomatic.disabled = archived || !recordsExperience;
  practiceAutomatic.disabled = archived || !acquiresPractice;
  scopedPromotion.disabled = archived || !acquiresPractice || !practiceAutomatic.checked
    || !scopedPromotionRelevant;
  $('crew-experience-recent').disabled = archived || !recallsExperience;
  $('crew-experience-automatic-control').classList.toggle(
    'is-dependent-disabled', !recordsExperience,
  );
  $('crew-practice-automatic-control').classList.toggle(
    'is-dependent-disabled', !acquiresPractice,
  );
  $('crew-practice-scoped-promotion-control').classList.toggle(
    'is-dependent-disabled', !acquiresPractice || !practiceAutomatic.checked
      || !scopedPromotionRelevant,
  );
  $('crew-experience-automatic-hint').textContent = !recordsExperience
    ? 'Turn on Capture new experience first'
    : experienceAutomatic.checked
      ? 'Save immediately · acknowledge later in Reviews'
      : 'Ask in chat before saving';
  $('crew-practice-acquire-hint').textContent = acquiresPractice
    ? 'Agent may create Practice candidates' : 'Off: people can still propose Practices';
  $('crew-practice-automatic-hint').textContent = !acquiresPractice
    ? 'Turn on Let agent propose practices first'
    : practiceAutomatic.checked
      ? automaticPracticeEligible
        ? 'Eligible agent proposals start as trials · acknowledge later in Reviews'
        : 'Scoped proposals stay in Reviews'
      : 'Agent proposals wait in Reviews';
  $('crew-practice-scoped-promotion-hint').textContent = !acquiresPractice
    ? 'Turn on Let agent propose practices first'
    : !practiceAutomatic.checked ? 'Turn on automatic trials first'
      : !scopedPromotionRelevant ? 'Not needed for Agent identity scope'
        : 'Allows scoped evidence to support an agent-wide Practice';
  $('crew-experience-scope-hint').textContent = ({
    owner: 'New turns · all workspace chats · existing Experience keeps its scope',
    session: 'New turns · current chat only · existing Experience keeps its scope',
    identity: 'New turns · every host reusing this identity · existing Experience keeps its scope',
  })[$('crew-experience-scope').value]
    ?? 'New turns · all workspace chats · existing Experience keeps its scope';
  const experiencePolicy = $('experience-policy-badge');
  experiencePolicy.textContent = !recordsExperience
    ? 'Capture off'
    : experienceAutomatic.checked ? 'Automatic · audit later' : 'Approval required';
  experiencePolicy.dataset.policy = !recordsExperience
    ? 'off' : experienceAutomatic.checked ? 'automatic' : 'reviewed';
  const practicePolicy = $('practice-policy-badge');
  practicePolicy.textContent = !acquiresPractice
    ? 'Agent proposals off'
    : practiceAutomatic.checked ? 'Automatic trials · audit later' : 'Review before trial';
  practicePolicy.dataset.policy = !acquiresPractice
    ? 'off' : practiceAutomatic.checked ? 'automatic' : 'reviewed';
  const identity = agentIdentityForConfig(config);
  const requestedCapacity = Number($('crew-flexibility').value || config.flexibility || 3);
  if (!identity?.flexibility) {
    $('crew-flexibility').min = '0';
    $('crew-flexibility-hint').textContent = 'Capacity is initialized when the Agent is saved.';
    return;
  }
  const committed = identity.flexibility.capacity - identity.flexibility.available;
  $('crew-flexibility').min = String(committed);
  $('crew-flexibility-hint').textContent = requestedCapacity === identity.flexibility.capacity
    ? `${identity.flexibility.available} available · ${committed} committed to hardened Practices`
    : `Saved capacity ${identity.flexibility.capacity} · ${committed} committed · pending ${requestedCapacity}`;
}

function renderCrewEditState(config) {
  const primary = config.agent === 'orchestrator';
  const archived = crewConfigArchived(config);
  const state = $('crew-edit-state');
  state.dataset.state = archived ? 'archived' : (crewEditor?.dirty ? 'dirty' : 'saved');
  state.textContent = archived
    ? 'Archived · history retained'
    : (crewEditor?.isNew
      ? 'New agent · not saved'
      : (crewEditor?.dirty ? 'Unsaved changes' : 'Saved'));
  $('crew-form-id').textContent = crewEditor?.isNew
    ? 'Not in the workspace yet'
    : (primary ? 'Primary agent · always available' : 'Workspace agent');
  for (const control of document.querySelectorAll(
    '#agent-detail-panel-profile input, #agent-detail-panel-profile select, '
    + '#agent-detail-panel-profile textarea',
  )) control.disabled = archived || control.dataset.availabilityDisabled === 'true';
  $('crew-enabled').disabled = primary || archived;
  const lifecycleAction = $('archive-crew-agent');
  lifecycleAction.hidden = primary || crewEditor?.isNew;
  lifecycleAction.disabled = primary || crewEditor?.isNew
    || pendingControls.has(lifecycleAction);
  lifecycleAction.textContent = archived ? 'Restore agent' : 'Archive';
  lifecycleAction.dataset.loadingLabel = archived ? 'Restoring' : 'Archiving';
  lifecycleAction.className = archived ? 'secondary-action' : 'danger-button';
  $('crew-primary-label').hidden = !primary;
  $('cancel-crew-edit').textContent = archived
    ? 'Close'
    : (crewEditor?.dirty ? 'Discard changes' : 'Close');
  const submit = $('crew-form').querySelector('[type="submit"]');
  submit.hidden = archived;
  submit.disabled = archived || (!crewEditor?.dirty && !crewEditor?.isNew)
    || pendingControls.has(submit);
  submit.textContent = crewEditor?.isNew ? 'Add to workspace' : 'Save changes';
  $('crew-form').classList.toggle('is-archived', archived);
  updateCrewLearningControls(config);
}

function captureCrewEdit() {
  if (!crewEditor) return;
  crewEditor.patch = crewFormPatch();
  crewEditor.dirty = crewEditor.isNew
    || JSON.stringify(crewEditor.patch) !== JSON.stringify(crewEditor.original);
  renderCrewEditState({ ...crewEditor.config, ...crewEditor.patch });
  $('crew-form-title').textContent = crewEditor.patch.displayName || 'Agent';
  $('crew-form-avatar').textContent = (crewEditor.patch.avatar || 'A').slice(0, 2).toUpperCase();
  $('crew-form-avatar').className = `crew-form-avatar ${crewEditor.patch.color}`;
}

function discardCrewChanges(message) {
  if (!crewEditor?.dirty) return true;
  return window.confirm(message ?? `Discard unsaved changes to ${crewEditor.patch.displayName || 'this agent'}?`);
}

function selectCrewConfig(configId) {
  if (configId === selectedCrewId) return true;
  if (!discardCrewChanges()) return false;
  crewEditor = null;
  constitutionDraft = null;
  experienceRetractDraftId = null;
  practiceTransitionDraft = null;
  practiceDraft = null;
  practiceEvidenceDraft = new Set();
  clearAgentLearningError();
  selectedCrewId = configId;
  renderCrewSettings();
  return true;
}

function renderCrewSettings() {
  const configs = crewConfigs({ includeArchived: true });
  const list = $('crew-settings-list');
  const focusedConfigId = document.activeElement?.closest?.('.crew-settings-row')?.dataset.configId ?? null;
  let restoreFocus = null;
  $('crew-settings-count').textContent = String(configs.length);
  $('crew-settings-tab-count').textContent = String(configs.length);
  if (!configs.some((config) => config._id === selectedCrewId)) {
    crewEditor = null;
    selectedCrewId = configs[0]?._id ?? null;
  }
  list.replaceChildren();

  for (const config of configs) {
    const button = document.createElement('button');
    const selected = config._id === selectedCrewId;
    const archived = crewConfigArchived(config);
    button.type = 'button';
    button.className = `crew-settings-row${selected ? ' active' : ''}${archived ? ' archived' : ''}`;
    button.dataset.configId = config._id;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(selected));
    button.setAttribute('aria-label', `${config.displayName}. ${config.role}. ${archived ? 'Archived' : (config.enabled ? 'Active' : 'Inactive')}.`);
    button.tabIndex = selected ? 0 : -1;
    const avatar = document.createElement('span');
    avatar.className = config.color;
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = config.avatar;
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = config.displayName;
    const role = document.createElement('small');
    role.textContent = `${config.role}${archived ? ' · Archived' : ''}`;
    copy.append(name, role);
    const status = document.createElement('i');
    status.className = archived ? 'archived' : (config.enabled ? 'enabled' : '');
    status.setAttribute('aria-hidden', 'true');
    button.append(avatar, copy, status);
    button.addEventListener('click', () => selectCrewConfig(config._id));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = configs.findIndex((item) => item._id === config._id);
      const nextIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? configs.length - 1
          : Math.max(0, Math.min(
            configs.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1),
          ));
      const nextId = configs[nextIndex]?._id ?? config._id;
      if (!selectCrewConfig(nextId)) return;
      requestAnimationFrame(() => list.querySelector(
        `[data-config-id="${CSS.escape(nextId)}"]`,
      )?.focus());
    });
    list.append(button);
    if (focusedConfigId === config._id) restoreFocus = button;
  }
  if (restoreFocus) requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));

  const config = configs.find((row) => row._id === selectedCrewId);
  const form = $('crew-form');
  form.hidden = !config;
  if (!config) return;
  const sourcePatch = crewConfigPatch(config);
  const sourceSignature = JSON.stringify(sourcePatch);
  const mustPopulate = !crewEditor || crewEditor.id !== config._id
    || (!crewEditor.dirty && crewEditor.sourceSignature !== sourceSignature);
  if (mustPopulate) {
    resetCrewEditor(config, !!config._draft);
    populateCrewForm(config);
  }
  const visible = crewEditor?.patch ?? sourcePatch;
  renderCrewModelSelector(visible.model);
  $('crew-form-title').textContent = visible.displayName;
  $('crew-form-avatar').className = `crew-form-avatar ${visible.color}`;
  $('crew-form-avatar').textContent = visible.avatar;
  renderCrewEditState({ ...config, ...visible });
  renderAgentLearning({ ...config, ...visible });
}

function setCrewDirectoryTab(tab, { focus = false } = {}) {
  if (!['people', 'agents', 'reviews'].includes(tab)) return;
  crewDirectoryTab = tab;
  document.querySelectorAll('[data-crew-directory-tab]').forEach((button) => {
    const active = button.dataset.crewDirectoryTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  document.querySelectorAll('[data-crew-directory-panel]').forEach((panel) => {
    const active = panel.dataset.crewDirectoryPanel === tab;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  $('crew-new-person').hidden = tab !== 'people';
  $('crew-new-agent').hidden = tab !== 'agents';
  if (tab === 'reviews') renderReviews();
}

function workspaceMembers() {
  return WorkspaceMembers.find({}, { sort: { displayName: 1, createdAt: 1 } }).fetch();
}

function renderWorkspacePeople() {
  const members = workspaceMembers();
  const list = $('crew-person-list');
  const focusedId = document.activeElement?.closest?.('.person-directory-row')?.dataset.memberId;
  $('crew-people-count').textContent = String(members.length);
  $('crew-people-list-count').textContent = String(members.length);
  // The detail pane carries the one actionable empty state; repeating it in
  // the narrow list makes an empty directory look like two separate errors.
  $('crew-person-list-empty').hidden = true;
  $('crew-person-detail-empty-title').textContent = members.length
    ? 'Select a person'
    : 'No people in this workspace';
  $('crew-person-detail-empty-hint').textContent = members.length
    ? 'Choose a row to view their connection.'
    : 'Add a person to include them in Missions.';
  list.hidden = members.length === 0;
  list.replaceChildren();
  if (!members.some((member) => member._id === selectedWorkspaceMemberId)) {
    selectedWorkspaceMemberId = members[0]?._id ?? null;
  }
  let restoreFocus = null;
  for (const member of members) {
    const selected = member._id === selectedWorkspaceMemberId;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `person-directory-row${selected ? ' active' : ''}`;
    row.dataset.memberId = member._id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected));
    row.tabIndex = selected ? 0 : -1;
    const avatar = document.createElement('span');
    avatar.className = 'person-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(member.displayName, 'P');
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = member.displayName;
    const title = document.createElement('small');
    title.textContent = member.title || 'Participant';
    copy.append(name, title);
    const connection = document.createElement('span');
    connection.className = `connection-chip ${member.connection}`;
    connection.dataset.connection = member.connection;
    connection.textContent = member.connection === 'channel'
      ? (member.surfaceKinds ?? []).map(surfaceLabel).filter((kind) => kind !== 'Desktop').join(' · ') || 'Channel'
      : connectionLabel(member.connection);
    row.append(avatar, copy, connection);
    row.addEventListener('click', () => {
      selectedWorkspaceMemberId = member._id;
      renderWorkspacePeople();
    });
    row.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = members.findIndex((item) => item._id === member._id);
      const nextIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? members.length - 1
          : Math.max(0, Math.min(
            members.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1),
          ));
      selectedWorkspaceMemberId = members[nextIndex]?._id ?? member._id;
      renderWorkspacePeople();
      requestAnimationFrame(() => list.querySelector(
        `[data-member-id="${CSS.escape(selectedWorkspaceMemberId)}"]`,
      )?.focus());
    });
    list.append(row);
    if (focusedId === member._id) restoreFocus = row;
  }
  if (restoreFocus) requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));

  const selected = members.find((member) => member._id === selectedWorkspaceMemberId);
  $('crew-person-detail-empty').hidden = !!selected;
  $('crew-person-detail').hidden = !selected;
  if (!selected) return;
  $('crew-person-detail-avatar').textContent = initials(selected.displayName, 'P');
  $('crew-person-detail-name').textContent = selected.displayName;
  $('crew-person-detail-role').textContent = selected.title || 'Participant';
  $('crew-person-detail-access').textContent = 'Participant';
  $('crew-person-detail-status').textContent = connectionLabel(selected.connection);
  const surfaces = (selected.surfaceKinds ?? []).map((kind) => ({
    kind, status: 'configured', detail: 'Identity configured',
  }));
  renderSurfaceList(
    'crew-person-detail-surfaces', 'crew-person-detail-surfaces-empty', surfaces,
  );
}

const PERSON_IDENTITY_COPY = Object.freeze({
  slack: { label: 'Slack member ID', placeholder: 'U012ABCDEF' },
  telegram: { label: 'Telegram user ID', placeholder: '123456789' },
  whatsapp: { label: 'WhatsApp phone number', placeholder: '+15551234567' },
  sms: { label: 'SMS phone number', placeholder: '+15551234567' },
  email: { label: 'Email address', placeholder: 'name@example.com' },
});

function personEditorPatch() {
  return {
    displayName: $('crew-person-name').value,
    title: $('crew-person-title').value,
    connection: $('crew-person-connection').value,
    surface: $('crew-person-surface').value,
    address: $('crew-person-address').value,
  };
}

function personEditorDirty() {
  return !!editingWorkspaceMemberOriginal
    && JSON.stringify(personEditorPatch()) !== JSON.stringify(editingWorkspaceMemberOriginal);
}

function updatePersonIdentityCopy() {
  const kind = $('crew-person-surface').value;
  const copy = PERSON_IDENTITY_COPY[kind] ?? {
    label: 'Channel member ID', placeholder: 'Exact provider ID',
  };
  const original = editingWorkspaceMemberOriginal;
  const keepsCurrent = !!editingWorkspaceMemberId
    && original?.connection === 'channel'
    && original.surface === kind;
  $('crew-person-address-label').textContent = copy.label;
  $('crew-person-address').placeholder = copy.placeholder;
  $('crew-person-address-hint').textContent = !kind
    ? 'Choose a Channel first.'
    : (keepsCurrent
      ? `Leave blank to keep the current ${copy.label.toLowerCase()}, or enter a replacement.`
      : `Use the exact ${copy.label.toLowerCase()}.`);
}

function updatePersonConnectionFields() {
  const isNew = !editingWorkspaceMemberId;
  const original = editingWorkspaceMemberOriginal;
  const type = $('crew-person-connection').value;
  const connected = type === 'channel';
  const channelKind = $('crew-person-surface').value;
  if (isNew && !connected) {
    $('crew-person-surface').value = '';
    $('crew-person-address').value = '';
  }
  $('crew-person-surface-field').hidden = !connected;
  $('crew-person-address-field').hidden = !connected;
  $('crew-person-surface').disabled = !connected;
  $('crew-person-address').disabled = !connected;
  $('crew-person-surface').required = connected;
  const keepsCurrent = !isNew
    && original?.connection === 'channel'
    && original.surface === $('crew-person-surface').value;
  $('crew-person-address').required = connected && !keepsCurrent;
  $('crew-person-address-required').hidden = keepsCurrent;
  $('crew-person-connection').disabled = original?.connection === 'account';
  updatePersonIdentityCopy();
  $('crew-person-identities-extra').textContent = original?.connection === 'account'
    ? 'Desktop account access is managed by authentication.'
    : (connected
      ? (!channelKind
        ? 'Choose a Channel to continue.'
        : (ChannelConfigs.findOne({ kind: channelKind })?.status === 'active'
          ? 'Recognizes this person in Channel conversations on their assigned Missions.'
          : `${surfaceLabel(channelKind)} is not active. This identity will be used after the Channel is configured.`))
      : 'Directory only · cannot send or receive Mission messages.');
}

function populatePersonSurfaceOptions(selected = '') {
  const select = $('crew-person-surface');
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Choose a Channel';
  select.append(none);
  for (const kind of CHANNEL_KINDS) {
    const config = ChannelConfigs.findOne({ kind });
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = `${surfaceLabel(kind)} · ${config?.status === 'active' ? 'Active' : 'Not active'}`;
    select.append(option);
  }
  select.value = selected;
}

function openPersonEditor(memberId = null) {
  const member = memberId ? WorkspaceMembers.findOne(memberId) : null;
  editingWorkspaceMemberId = member?._id ?? null;
  editingWorkspaceMemberRevision = member?.revision ?? null;
  clearFormError('crew-person-form');
  $('crew-person-dialog-title').textContent = member ? 'Edit person' : 'New person';
  $('crew-person-dialog-id').textContent = member ? 'Workspace participant' : 'Not saved';
  $('crew-person-edit-state').textContent = member ? 'Saved' : 'Not saved';
  $('crew-person-name').value = member?.displayName ?? '';
  $('crew-person-title').value = member?.title ?? '';
  const connectionSelect = $('crew-person-connection');
  connectionSelect.querySelector('option[value="account"]')?.remove();
  if (member?.connection === 'account') {
    const account = document.createElement('option');
    account.value = 'account';
    account.textContent = 'Desktop account';
    connectionSelect.append(account);
  }
  connectionSelect.value = member?.connection ?? 'unlinked';
  populatePersonSurfaceOptions(
    member?.surfaceKinds?.find((kind) => kind !== 'desktop') ?? '',
  );
  $('crew-person-address').value = '';
  $('remove-crew-person').hidden = !member;
  editingWorkspaceMemberOriginal = personEditorPatch();
  updatePersonConnectionFields();
  const dialog = $('crew-person-dialog');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $('crew-person-name').focus());
}

function closePersonEditor({ force = false } = {}) {
  if (!force && personEditorDirty()
    && !window.confirm('Discard unsaved changes to this person?')) return false;
  editingWorkspaceMemberId = null;
  editingWorkspaceMemberRevision = null;
  editingWorkspaceMemberOriginal = null;
  clearFormError('crew-person-form');
  $('crew-person-dialog').close();
  return true;
}

function openCrewSettings(configId) {
  if (configId && configId !== selectedCrewId) {
    if (!selectCrewConfig(configId)) return;
  }
  renderCrewSettings();
  renderWorkspacePeople();
  setCrewDirectoryTab(configId ? 'agents' : crewDirectoryTab);
  clearFormError('crew-form');
  if (!$('crew-dialog').open) $('crew-dialog').showModal();
}

function crewFormPatch() {
  return {
    ...(!crewEditor?.isNew && Number.isSafeInteger(crewEditor?.config?.revision)
      ? { expectedRevision: crewEditor.config.revision }
      : {}),
    displayName: $('crew-name').value,
    role: $('crew-role').value,
    avatar: $('crew-avatar').value,
    color: $('crew-color').value,
    instructions: $('crew-instructions').value,
    model: $('crew-model').value,
    enabled: $('crew-enabled').checked,
    flexibility: Number($('crew-flexibility').value),
    experience: {
      record: $('crew-experience-record').checked,
      recall: $('crew-experience-recall').checked,
      recent: Number($('crew-experience-recent').value),
      scope: $('crew-experience-scope').value,
      approval: $('crew-experience-automatic').checked ? 'auto' : 'ask',
    },
    practice: {
      acquire: $('crew-practice-acquire').checked,
      approval: $('crew-practice-automatic').checked ? 'auto' : 'ask',
      allowScopedEvidencePromotion: $('crew-practice-scoped-promotion').checked,
    },
    budget: {
      turns: Number($('crew-turns').value),
      toolCalls: Number($('crew-tool-calls').value),
      spend: Number($('crew-spend').value),
    },
    capabilities: {
      inspect: $('crew-cap-inspect').checked,
      framing: !!(crewEditor?.patch?.capabilities?.framing
        ?? crewEditor?.original?.capabilities?.framing
        ?? crewEditor?.config?.capabilities?.framing),
      memory: $('crew-cap-memory').checked,
      publish: $('crew-cap-publish').checked,
    },
  };
}

function closeCrewSettings({ discard = false } = {}) {
  if (crewEditor?.dirty && !discard
    && !discardCrewChanges('Discard unsaved crew changes and close?')) return false;
  crewEditor = null;
  $('crew-dialog').close();
  renderCrewSettings();
  if (missionCrewDirectoryReturn && missionCrewDraft) {
    missionCrewDirectoryReturn = false;
    rebaseMissionCrewDraft();
    renderMissionCrewDialog();
    $('mission-crew-dialog').showModal();
  }
  return true;
}

function appendCrewImpactSection(container, title, rows, describe) {
  const section = document.createElement('section');
  const heading = document.createElement('h3');
  heading.textContent = `${title} · ${rows.length}`;
  section.append(heading);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.textContent = 'None';
    section.append(empty);
  } else {
    const list = document.createElement('ul');
    for (const row of rows) {
      const item = document.createElement('li');
      item.textContent = describe(row);
      list.append(item);
    }
    section.append(list);
  }
  container.append(section);
}

function renderCrewArchiveImpact(impact) {
  $('crew-archive-title').textContent = `Archive ${impact.displayName}?`;
  const total = impact.missions.length + impact.skills.length
    + impact.mcpServers.length + impact.pulses.length;
  $('crew-archive-summary').textContent = total
    ? `${impact.displayName} will stop receiving work. The following references will change.`
    : `${impact.displayName} will stop receiving work.`;
  const container = $('crew-archive-impact');
  container.replaceChildren();
  appendCrewImpactSection(container, 'Missions', impact.missions, (row) =>
    `${row.name} · ${row.status}${row.awaitingApproval
      ? ` · awaiting ${row.pendingTool || 'approval'}`
      : (row.active ? ' · work in progress' : '')}`);
  appendCrewImpactSection(container, 'Skills', impact.skills, (row) =>
    `${row.name} · ${row.enabled ? 'enabled' : 'disabled'}`);
  appendCrewImpactSection(container, 'MCP access', impact.mcpServers, (row) =>
    `${row.name} · ${row.enabled ? 'enabled' : 'disabled'}`);
  appendCrewImpactSection(container, 'Pulses', impact.pulses, (row) =>
    `${row.name} · ${row.missionName} · ${row.enabled ? 'will be disabled' : 'disabled'}`);
}

function renderPersonRemovalImpact(impact) {
  $('person-remove-title').textContent = `Remove ${impact.displayName}?`;
  $('person-remove-summary').textContent = impact.missions.length
    ? `${impact.displayName} will be removed from the workspace and ${impact.missions.length} Mission${impact.missions.length === 1 ? '' : 's'}.`
    : `${impact.displayName} will be removed from the workspace.`;
  const container = $('person-remove-impact');
  container.replaceChildren();
  appendCrewImpactSection(container, 'Missions', impact.missions, (row) =>
    `${row.title} · ${row.status}`);
}

function closePersonRemoval() {
  pendingPersonImpact = null;
  if ($('person-remove-dialog').open) $('person-remove-dialog').close();
  requestAnimationFrame(() => $('remove-crew-person')?.focus());
}

function missionCrewSnapshot(view = missionParticipation()) {
  const configs = crewConfigs().filter((config) => config.enabled);
  const availableAgents = new Set(configs.map((config) => config.agent));
  const members = new Set(
    (view?.participants ?? [])
      .filter((row) => row.kind === 'human' && row.memberId)
      .map((row) => row.memberId),
  );
  const unmanagedPeople = (view?.participants ?? []).filter(
    (row) => row.kind === 'human' && row.role !== 'owner' && !row.memberId,
  );
  const agents = new Set(
    (view?.participants ?? [])
      .filter((row) => row.kind === 'agent' && row.agent
        && row.agent !== 'orchestrator' && availableAgents.has(row.agent))
      .map((row) => row.agent),
  );
  const config = missionConfig(view?.missionId ?? currentSessionId);
  const agentMode = view?.agentMode
    ?? (Array.isArray(config?.agents) ? 'custom' : 'inherit');
  if (agentMode === 'inherit') {
    agents.clear();
    configs.filter((row) => row.agent !== 'orchestrator').forEach(
      (row) => agents.add(row.agent),
    );
  }
  return { members, agents, agentMode, unmanagedPeople };
}

function missionCrewChanged(draft = missionCrewDraft) {
  if (!draft) return false;
  const sameSet = (left, right) => left.size === right.size
    && [...left].every((value) => right.has(value));
  return draft.agentMode !== draft.initialAgentMode
    || !sameSet(draft.members, draft.initialMembers)
    || !sameSet(draft.agents, draft.initialAgents);
}

function sanitizeMissionCrewDraft(draft = missionCrewDraft) {
  if (!draft) return;
  const memberIds = new Set(workspaceMembers().map((member) => member._id));
  const agentIds = new Set(crewConfigs()
    .filter((config) => config.enabled && config.agent !== 'orchestrator')
    .map((config) => config.agent));
  for (const set of [draft.members, draft.initialMembers]) {
    for (const id of set) if (!memberIds.has(id)) set.delete(id);
  }
  for (const set of [draft.agents, draft.initialAgents]) {
    for (const id of set) if (!agentIds.has(id)) set.delete(id);
  }
  if (draft.agentMode === 'inherit') draft.agents = new Set(agentIds);
  if (draft.initialAgentMode === 'inherit') draft.initialAgents = new Set(agentIds);
  draft.unmanagedPeople = missionCrewSnapshot(
    missionParticipation(draft.sessionId),
  ).unmanagedPeople;
}

function rebaseMissionCrewDraft() {
  const draft = missionCrewDraft;
  if (!draft) return;
  sanitizeMissionCrewDraft(draft);
  const current = missionCrewSnapshot();
  const applyDelta = (base, previous, desired) => {
    const next = new Set(base);
    for (const id of desired) if (!previous.has(id)) next.add(id);
    for (const id of previous) if (!desired.has(id)) next.delete(id);
    return next;
  };
  const desiredMode = draft.agentMode;
  const rebasedMembers = applyDelta(
    current.members, draft.initialMembers, draft.members,
  );
  const rebasedAgents = desiredMode === 'inherit'
    ? new Set(current.agents)
    : applyDelta(current.agents, draft.initialAgents, draft.agents);
  draft.revision = missionConfig(draft.sessionId)?.revision ?? draft.revision;
  draft.initialMembers = new Set(current.members);
  draft.initialAgents = new Set(current.agents);
  draft.initialAgentMode = current.agentMode;
  draft.members = rebasedMembers;
  draft.agents = rebasedAgents;
  draft.agentMode = desiredMode;
  draft.unmanagedPeople = current.unmanagedPeople;
  sanitizeMissionCrewDraft(draft);
}

function missionCrewSelectionTotal(snapshot = missionCrewDraft ?? missionCrewSnapshot()) {
  return snapshot
    ? 2 + snapshot.members.size + snapshot.agents.size + (snapshot.unmanagedPeople?.length ?? 0)
    : 2;
}

function missionCrewIsBusy(sessionId = currentSessionId) {
  const session = sessionId ? AgentSessions.findOne(sessionId) : null;
  return ['streaming', 'calling', 'retrying', 'compacting'].includes(session?.phase);
}

function updateMissionCrewCounts(snapshot = missionCrewDraft ?? missionCrewSnapshot()) {
  if (!snapshot) return;
  const peopleCount = snapshot.members.size + 1 + (snapshot.unmanagedPeople?.length ?? 0);
  const agentCount = snapshot.agents.size + 1;
  const total = missionCrewSelectionTotal(snapshot);
  $('mission-crew-dialog-people-count').textContent = `${peopleCount} selected`;
  $('mission-crew-dialog-agents-count').textContent = `${agentCount} selected`;
  $('mission-crew-capacity').textContent = `${total} / ${MISSION_PARTICIPANT_LIMIT} participants`;
  $('mission-crew-capacity').dataset.state = total > MISSION_PARTICIPANT_LIMIT
    ? 'over' : 'ready';
  const atLimit = total >= MISSION_PARTICIPANT_LIMIT;
  const workBusy = missionCrewIsBusy(missionCrewDraft?.sessionId);
  $('mission-crew-availability').hidden = !workBusy;
  document.querySelectorAll('#mission-crew-form input[data-roster-key]').forEach((input) => {
    input.disabled = workBusy || input.dataset.fixed === 'true' || (atLimit && !input.checked);
    const role = input.closest('.mission-roster-row')?.querySelector('.mission-roster-role');
    if (role && !input.checked) role.textContent = workBusy
      ? 'Wait for turn'
      : (atLimit ? 'Limit reached' : 'Not included');
  });
  $('mission-crew-agent-mode').disabled = workBusy;
  $('mission-crew-open-people').disabled = workBusy;
  $('mission-crew-open-agents').disabled = workBusy;
  $('save-mission-crew').disabled = workBusy || total > MISSION_PARTICIPANT_LIMIT;
}

function createMissionRosterOption({
  key, name, detail, checked, disabled = false, kind, status,
}) {
  const label = document.createElement('label');
  label.className = `mission-roster-row ${kind}${checked ? ' selected' : ''}`;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.dataset.fixed = String(disabled);
  input.dataset.rosterKey = key;
  input.dataset.rosterKind = kind;
  const avatar = document.createElement('span');
  avatar.className = `participant-avatar ${kind === 'agent' ? 'agent' : 'human'}`;
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = initials(name, kind === 'agent' ? 'A' : 'P');
  const copy = document.createElement('span');
  copy.className = 'mission-roster-copy';
  const title = document.createElement('strong');
  title.textContent = name;
  const meta = document.createElement('small');
  meta.textContent = detail;
  copy.append(title, meta);
  const role = document.createElement('span');
  role.className = 'mission-roster-role';
  role.textContent = status ?? (disabled ? 'Required' : (checked ? 'Included' : 'Not included'));
  label.append(input, avatar, copy, role);
  input.addEventListener('change', () => {
    const target = kind === 'agent' ? missionCrewDraft?.agents : missionCrewDraft?.members;
    if (!target) return;
    if (input.checked && missionCrewSelectionTotal() >= MISSION_PARTICIPANT_LIMIT) {
      input.checked = false;
      showFormError(
        'mission-crew-form',
        new Error(`A Mission can have at most ${MISSION_PARTICIPANT_LIMIT} participants.`),
      );
      updateMissionCrewCounts();
      return;
    }
    clearFormError('mission-crew-form');
    if (input.checked) target.add(key);
    else target.delete(key);
    label.classList.toggle('selected', input.checked);
    role.textContent = input.checked ? 'Included' : 'Not included';
    updateMissionCrewCounts();
  });
  return label;
}

function renderMissionCrewDialog() {
  const focusedRosterKey = document.activeElement?.dataset?.rosterKey ?? null;
  const modeHadFocus = document.activeElement === $('mission-crew-agent-mode');
  const view = missionParticipation();
  const members = workspaceMembers();
  const configs = crewConfigs().filter((config) => config.enabled);
  sanitizeMissionCrewDraft();
  const snapshot = missionCrewDraft ?? missionCrewSnapshot(view);
  const peopleList = $('mission-crew-people-list');
  const agentList = $('mission-crew-agents-list');
  peopleList.replaceChildren();
  agentList.replaceChildren();
  peopleList.append(createMissionRosterOption({
    key: 'owner', name: 'You', detail: 'Workspace owner', checked: true,
    disabled: true, kind: 'person', status: 'Required',
  }));
  for (const person of snapshot.unmanagedPeople ?? []) {
    const channels = (person.surfaceKinds ?? []).map(surfaceLabel);
    peopleList.append(createMissionRosterOption({
      key: person.key,
      name: person.displayName,
      detail: channels.length ? `${channels.join(' · ')} conversation` : 'Conversation participant',
      checked: true,
      disabled: true,
      kind: 'person',
      status: 'From conversation',
    }));
  }
  for (const member of members) {
    const surfaces = (member.surfaceKinds ?? []).map(surfaceLabel);
    const connection = surfaces.length
      ? `${surfaces.join(' · ')} identity`
      : connectionLabel(member.connection);
    peopleList.append(createMissionRosterOption({
      key: member._id,
      name: member.displayName,
      detail: member.title
        ? `${member.title} · ${connection}`
        : connection,
      checked: snapshot.members.has(member._id),
      kind: 'person',
    }));
  }
  for (const config of configs) {
    const primary = config.agent === 'orchestrator';
    const inherited = snapshot.agentMode === 'inherit' && !primary;
    agentList.append(createMissionRosterOption({
      key: config.agent,
      name: config.displayName,
      detail: config.role,
      checked: primary || snapshot.agents.has(config.agent),
      disabled: primary || inherited,
      kind: 'agent',
      status: primary ? 'Required' : (inherited ? 'From workspace' : undefined),
    }));
  }
  $('mission-crew-people-list-empty').hidden = true;
  peopleList.hidden = false;
  $('mission-crew-agents-list-empty').hidden = configs.length > 0;
  agentList.hidden = configs.length === 0;
  $('mission-crew-agent-mode').checked = snapshot.agentMode === 'inherit';
  updateMissionCrewCounts(snapshot);
  const surfaces = view?.surfaces ?? [];
  $('mission-crew-dialog-surfaces-count').textContent = `${surfaces.filter((row) => row.status === 'bound').length} connected`;
  renderSurfaceList(
    'mission-crew-surfaces-list', 'mission-crew-surfaces-list-empty', surfaces,
    false, view?.participants ?? [],
  );
  if (focusedRosterKey || modeHadFocus) requestAnimationFrame(() => {
    if (modeHadFocus) $('mission-crew-agent-mode').focus({ preventScroll: true });
    else document.querySelector(
      `#mission-crew-form input[data-roster-key="${CSS.escape(focusedRosterKey)}"]`,
    )?.focus({ preventScroll: true });
  });
}

async function openMissionCrew(control = null) {
  const sessionId = currentSessionId;
  if (!sessionId) return;
  if (missionCrewIsBusy(sessionId)) {
    toast('Crew editing is available when the current turn finishes.', 'error');
    return;
  }
  const button = control?.currentTarget ?? control;
  const show = async () => {
    subscribeMissionParticipation(sessionId);
    await prepareSession(sessionId);
    if (currentSessionId !== sessionId) return;
    const view = await waitForReactiveValue(
      () => {
        sessionChanged.depend();
        return currentSessionId !== sessionId
          ? { aborted: true }
          : missionParticipation(sessionId);
      },
      'Mission crew', 8_000,
    );
    if (currentSessionId !== sessionId || view.aborted) return;
    const snapshot = missionCrewSnapshot(view);
    missionCrewDraft = {
      sessionId,
      revision: missionConfig(sessionId)?.revision,
      initialMembers: new Set(snapshot.members),
      initialAgents: new Set(snapshot.agents),
      initialAgentMode: snapshot.agentMode,
      members: new Set(snapshot.members),
      agents: new Set(snapshot.agents),
      agentMode: snapshot.agentMode,
      unmanagedPeople: snapshot.unmanagedPeople,
    };
    $('mission-crew-dialog-id').textContent = missionConfig(sessionId)?.title || 'Current mission';
    clearFormError('mission-crew-form');
    renderMissionCrewDialog();
    if (!$('mission-crew-dialog').open) $('mission-crew-dialog').showModal();
  };
  try {
    if (button instanceof HTMLButtonElement) await withControlBusy(button, 'Loading', show);
    else await show();
  } catch (error) {
    toast(messageOf(error), 'error');
  }
}

function closeMissionCrew({ force = false, preserve = false } = {}) {
  if (!preserve && !force && missionCrewChanged()
    && !window.confirm('Discard unsaved Mission crew changes?')) return false;
  if (!preserve) missionCrewDraft = null;
  clearFormError('mission-crew-form');
  $('mission-crew-dialog').close();
  return true;
}

function wireCrewSettings() {
  $('configure-crew').addEventListener('click', () => {
    setCrewDirectoryTab('agents');
    openCrewSettings();
  });
  document.querySelectorAll('[data-crew-directory-tab]').forEach((button) => {
    button.addEventListener('click', () => setCrewDirectoryTab(button.dataset.crewDirectoryTab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = ['people', 'agents', 'reviews'];
      const current = tabs.indexOf(button.dataset.crewDirectoryTab);
      const next = event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs.at(-1)
          : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      setCrewDirectoryTab(next, { focus: true });
    });
  });
  document.querySelectorAll('[data-agent-detail-tab]').forEach((button) => {
    button.addEventListener('click', () => setAgentDetailTab(button.dataset.agentDetailTab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[data-agent-detail-tab]:not(:disabled)')];
      const current = tabs.indexOf(button);
      const next = event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs.at(-1)
          : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      if (next) setAgentDetailTab(next.dataset.agentDetailTab, { focus: true });
    });
  });
  document.querySelectorAll('[data-learning-configure]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.learningConfigure;
      const section = target === 'practice'
        ? $('practice-learning-settings') : $('experience-learning-settings');
      const control = target === 'practice'
        ? $('crew-practice-acquire') : $('crew-experience-record');
      setAgentDetailTab('profile');
      requestAnimationFrame(() => {
        section?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        control?.focus({ preventScroll: true });
      });
    });
  });
  $('open-learning-reviews').addEventListener('click', openLearningReviews);
  $('agent-learning-error-action').addEventListener('click', async (event) => {
    const action = agentLearningErrorAction;
    if (!action) return;
    await withControlBusy(
      event.currentTarget,
      event.currentTarget.dataset.loadingLabel || 'Working',
      async () => {
        try {
          await action();
        } catch (error) {
          showAgentLearningError(error, learningSubscriptionError
            ? { actionLabel: 'Retry', action: retryLearningSubscription }
            : {});
        }
      },
    );
  });
  $('reviews-retry-learning').addEventListener('click', async (event) => {
    await withControlBusy(event.currentTarget, 'Retrying', async () => {
      try {
        await retryLearningSubscription();
      } catch (error) {
        showAgentLearningError(error, {
          actionLabel: 'Retry', action: retryLearningSubscription,
        });
      }
    });
  });
  $('constitution-body').addEventListener('input', (event) => {
    if (constitutionDraft) constitutionDraft.body = event.currentTarget.value;
    updateConstitutionDraftState();
  });
  $('constitution-reason').addEventListener('input', (event) => {
    if (constitutionDraft) constitutionDraft.reason = event.currentTarget.value;
    updateConstitutionDraftState();
  });
  $('constitution-submit').addEventListener('click', async (event) => {
    const config = selectedCrewId ? CrewConfigs.findOne(selectedCrewId) : null;
    if (crewConfigArchived(config)) {
      toast('Restore this agent to revise its constitution.', 'error');
      renderCrewSettings();
      return;
    }
    const identity = agentIdentityForConfig(config);
    const body = $('constitution-body').value.trim();
    const reason = $('constitution-reason').value.trim();
    if (!identity) { showAgentLearningError(new Error('Agent identity unavailable.')); return; }
    if (!body) { $('constitution-body').setCustomValidity('Enter constitution text.'); $('constitution-body').reportValidity(); return; }
    $('constitution-body').setCustomValidity('');
    if (body === constitutionDraft?.baseBody?.trim()) {
      showAgentLearningError(new Error('Change the constitution text before submitting.'));
      return;
    }
    if (!reason) { $('constitution-reason').setCustomValidity('Enter a reason.'); $('constitution-reason').reportValidity(); return; }
    $('constitution-reason').setCustomValidity('');
    clearAgentLearningError();
    await withControlBusy(event.currentTarget, 'Publishing', async () => {
      try {
        await Meteor.callAsync(
          'constellation.constitutionRevise',
          identity._id,
          Number(constitutionDraft?.baseGeneration ?? identity.generation ?? 1),
          body,
          reason,
        );
        constitutionDrafts.delete(identity._id);
        constitutionDraft = null;
        $('constitution-compose').open = false;
        learningViewChanged.changed();
        toast('Constitution version published.');
      } catch (error) {
        if (String(error?.error ?? error?.message ?? error)
          .includes('identity-generation-conflict')) {
          showAgentLearningError(
            new Error('The Constitution changed after this draft started. Rebase keeps your text and updates its base version.'),
            { actionLabel: 'Rebase draft', action: () => rebaseConstitutionDraft(identity._id) },
          );
        } else showAgentLearningError(error);
      }
    });
  });
  for (const [id, key] of [
    ['practice-key', 'key'],
    ['practice-context', 'context'],
    ['practice-trigger', 'trigger'],
    ['practice-guidance', 'guidance'],
  ]) {
    $(id).addEventListener('input', (event) => {
      if (practiceDraft) practiceDraft[key] = event.currentTarget.value;
      updatePracticeDraftState();
    });
  }
  $('practice-submit').addEventListener('click', async (event) => {
    const config = selectedCrewId ? CrewConfigs.findOne(selectedCrewId) : null;
    if (crewConfigArchived(config)) {
      toast('Restore this agent to propose a practice.', 'error');
      renderCrewSettings();
      return;
    }
    const identity = agentIdentityForConfig(config);
    if (!identity) { showAgentLearningError(new Error('Agent identity unavailable.')); return; }
    const proposal = {
      commandId: randomToken(16),
      key: $('practice-key').value.trim(),
      context: $('practice-context').value.trim(),
      trigger: $('practice-trigger').value.trim(),
      guidance: $('practice-guidance').value.trim(),
      evidenceIds: [...practiceEvidenceDraft],
    };
    const required = [
      ['practice-key', proposal.key, 'Enter a key.'],
      ['practice-context', proposal.context, 'Enter a context.'],
      ['practice-trigger', proposal.trigger, 'Enter a trigger.'],
      ['practice-guidance', proposal.guidance, 'Enter guidance.'],
    ];
    for (const [id, value, message] of required) {
      const field = $(id);
      field.setCustomValidity(value ? '' : message);
      if (!value) { field.reportValidity(); return; }
    }
    if (!proposal.evidenceIds.length) {
      showAgentLearningError(new Error('Select at least one active Experience as evidence.'));
      return;
    }
    clearAgentLearningError();
    await withControlBusy(event.currentTarget, 'Submitting', async () => {
      try {
        await Meteor.callAsync('constellation.practicePropose', identity._id, proposal);
        for (const id of ['practice-key', 'practice-context', 'practice-trigger', 'practice-guidance']) {
          $(id).value = '';
        }
        practiceDrafts.delete(identity._id);
        practiceDraft = null;
        practiceEvidenceDraft = new Set();
        $('practice-compose').open = false;
        learningViewChanged.changed();
        toast('Practice proposed for review.');
      } catch (error) {
        showAgentLearningError(error);
      }
    });
  });
  $('practice-context').addEventListener('input', () => {
    const config = selectedCrewId ? CrewConfigs.findOne(selectedCrewId) : null;
    const identity = agentIdentityForConfig(config);
    if (!identity) return;
    renderPracticeEvidence(AgentExperiences.find(
      { agentId: identity._id }, { sort: { createdAt: -1 } },
    ).fetch());
  });
  $('crew-experience-recall').addEventListener('change', (event) => {
    const limit = $('crew-experience-recent');
    if (event.currentTarget.checked && Number(limit.value) < 1) limit.value = '1';
    updateCrewLearningControls(crewEditor?.patch ?? crewEditor?.config ?? {});
  });
  for (const id of [
    'crew-experience-record', 'crew-experience-automatic',
    'crew-experience-scope', 'crew-practice-acquire', 'crew-practice-automatic',
    'crew-practice-scoped-promotion',
  ]) {
    $(id).addEventListener('change', () => {
      updateCrewLearningControls(crewEditor?.patch ?? crewEditor?.config ?? {});
    });
  }
  $('crew-new-person').addEventListener('click', () => openPersonEditor());
  $('crew-edit-person').addEventListener('click', () => {
    if (selectedWorkspaceMemberId) openPersonEditor(selectedWorkspaceMemberId);
  });
  $('crew-person-connection').addEventListener('change', updatePersonConnectionFields);
  $('crew-person-surface').addEventListener('change', updatePersonConnectionFields);
  $('close-crew-person-dialog').addEventListener('click', () => closePersonEditor());
  $('cancel-crew-person-edit').addEventListener('click', () => closePersonEditor());
  $('crew-person-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closePersonEditor();
  });
  $('crew-person-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.submitter ?? event.currentTarget.querySelector('[type="submit"]');
    const memberId = editingWorkspaceMemberId;
    const revision = editingWorkspaceMemberRevision;
    clearFormError(event.currentTarget);
    await withControlBusy(submit, 'Saving', async () => {
      try {
        const patch = {
          displayName: $('crew-person-name').value,
          title: $('crew-person-title').value,
        };
        const connection = $('crew-person-connection').value;
        const kind = $('crew-person-surface').value;
        const externalUserId = $('crew-person-address').value.trim();
        const original = editingWorkspaceMemberOriginal;
        if (connection === 'channel' && (
          !memberId
          || original?.connection !== 'channel'
          || original.surface !== kind
          || externalUserId
        )) {
          patch.identity = {
            kind,
            externalUserId,
          };
        } else if (memberId && connection === 'unlinked'
          && original?.connection !== 'unlinked') {
          patch.clearIdentity = true;
        }
        const savedId = memberId
          ? memberId
          : await Meteor.callAsync('constellation.workspaceMemberCreate', patch);
        if (memberId) {
          await Meteor.callAsync(
            'constellation.workspaceMemberSave', memberId, revision, patch,
          );
        }
        selectedWorkspaceMemberId = savedId;
        closePersonEditor({ force: true });
        setCrewDirectoryTab('people');
        renderWorkspacePeople();
        toast(memberId ? 'Person saved.' : 'Person added to the workspace.');
      } catch (error) {
        showFormError(
          'crew-person-form', error,
          staleReloadOptions(error, async () => {
            const latest = memberId ? WorkspaceMembers.findOne(memberId) : null;
            if (!latest) {
              closePersonEditor({ force: true });
              toast('This person no longer exists.', 'error');
              return;
            }
            openPersonEditor(memberId);
          }),
        );
      }
    });
  });
  $('remove-crew-person').addEventListener('click', async (event) => {
    const memberId = editingWorkspaceMemberId;
    const revision = editingWorkspaceMemberRevision;
    const member = memberId ? WorkspaceMembers.findOne(memberId) : null;
    if (!member || revision === null) return;
    await withControlBusy(event.currentTarget, 'Checking', async () => {
      try {
        pendingPersonImpact = {
          ...(await Meteor.callAsync('constellation.workspaceMemberImpact', memberId)),
          revision,
        };
        renderPersonRemovalImpact(pendingPersonImpact);
        $('person-remove-dialog').showModal();
      } catch (error) {
        showFormError(
          'crew-person-form', error,
          staleReloadOptions(error, () => openPersonEditor(memberId)),
        );
      }
    });
  });
  $('close-person-remove').addEventListener('click', closePersonRemoval);
  $('cancel-person-remove').addEventListener('click', closePersonRemoval);
  $('person-remove-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closePersonRemoval();
  });
  $('confirm-person-remove').addEventListener('click', async (event) => {
    const impact = pendingPersonImpact;
    if (!impact) return;
    await withControlBusy(event.currentTarget, 'Removing', async () => {
      try {
        await Meteor.callAsync(
          'constellation.workspaceMemberRemove', impact.memberId, impact.revision,
        );
        selectedWorkspaceMemberId = null;
        pendingPersonImpact = null;
        $('person-remove-dialog').close();
        closePersonEditor({ force: true });
        renderWorkspacePeople();
        requestAnimationFrame(() => {
          const selected = selectedWorkspaceMemberId
            ? document.querySelector(
              `.person-directory-row[data-member-id="${CSS.escape(selectedWorkspaceMemberId)}"]`,
            )
            : null;
          (selected ?? $('crew-new-person')).focus({ preventScroll: true });
        });
        toast(`${impact.displayName} removed from the workspace.`);
      } catch (error) {
        showFormError(
          'crew-person-form', error,
          staleReloadOptions(error, () => openPersonEditor(impact.memberId)),
        );
        closePersonRemoval();
      }
    });
  });
  $('manage-mission-crew').addEventListener('click', (event) => {
    void openMissionCrew(event.currentTarget);
  });
  $('manage-mission-crew-inspector').addEventListener('click', (event) => {
    void openMissionCrew(event.currentTarget);
  });
  $('close-mission-crew-dialog').addEventListener('click', () => closeMissionCrew());
  $('cancel-mission-crew').addEventListener('click', () => closeMissionCrew());
  $('mission-crew-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeMissionCrew();
  });
  $('mission-crew-open-people').addEventListener('click', () => {
    closeMissionCrew({ preserve: true });
    missionCrewDirectoryReturn = true;
    setCrewDirectoryTab('people');
    openCrewSettings();
  });
  $('mission-crew-open-agents').addEventListener('click', () => {
    closeMissionCrew({ preserve: true });
    missionCrewDirectoryReturn = true;
    setCrewDirectoryTab('agents');
    openCrewSettings();
  });
  $('mission-crew-agent-mode').addEventListener('change', (event) => {
    if (!missionCrewDraft) return;
    missionCrewDraft.agentMode = event.currentTarget.checked ? 'inherit' : 'custom';
    if (missionCrewDraft.agentMode === 'inherit') {
      missionCrewDraft.agents = new Set(crewConfigs()
        .filter((config) => config.enabled && config.agent !== 'orchestrator')
        .map((config) => config.agent));
    }
    renderMissionCrewDialog();
    requestAnimationFrame(() => $('mission-crew-agent-mode').focus());
  });
  $('mission-crew-open-channels').addEventListener('click', () => {
    if (missionCrewChanged()) {
      showFormError(
        'mission-crew-form',
        new Error('Save or cancel crew changes before configuring Channels.'),
      );
      return;
    }
    closeMissionCrew({ force: true });
    activateView('channels');
  });
  $('mission-crew-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!missionCrewDraft) return;
    if (missionCrewIsBusy(missionCrewDraft.sessionId)) {
      showFormError(
        'mission-crew-form',
        new Error('Crew editing is available when the current turn finishes.'),
      );
      updateMissionCrewCounts();
      return;
    }
    const draft = missionCrewDraft;
    const submit = event.submitter ?? $('save-mission-crew');
    clearFormError(event.currentTarget);
    await withControlBusy(submit, 'Saving', async () => {
      try {
        await Meteor.callAsync(
          'constellation.missionCrewSave',
          draft.sessionId,
          draft.revision,
          {
            memberIds: [...draft.members],
            agentMode: draft.agentMode,
            agents: draft.agentMode === 'inherit' ? [] : [...draft.agents],
          },
        );
        closeMissionCrew({ force: true });
        sessionChanged.changed();
        toast('Mission crew updated.');
      } catch (error) {
        showFormError(
          'mission-crew-form', error,
          staleReloadOptions(error, async () => {
            missionCrewDraft = null;
            await openMissionCrew();
          }),
        );
      }
    });
  });
  $('chat-mode-ask').addEventListener('click', (event) => setChatComposerMode(
    'ask', { focus: event.detail > 0 },
  ));
  $('chat-mode-note').addEventListener('click', (event) => setChatComposerMode(
    'note', { focus: event.detail > 0 },
  ));
  $('close-crew-dialog').addEventListener('click', () => closeCrewSettings());
  $('cancel-crew-edit').addEventListener('click', () => closeCrewSettings({ discard: true }));
  $('crew-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCrewSettings();
  });
  const addCrewAgent = () => {
    if (!currentSessionId || !discardCrewChanges('Discard these changes and add a new agent?')) return;
    const draft = newCrewDraft();
    resetCrewEditor(draft, true);
    selectedCrewId = draft._id;
    populateCrewForm(draft);
    renderCrewSettings();
    requestAnimationFrame(() => $('crew-name').select());
  };
  $('crew-new-agent').addEventListener('click', addCrewAgent);
  $('crew-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentSessionId || !selectedCrewId || !crewEditor) return;
    const submit = event.submitter ?? event.currentTarget.querySelector('[type="submit"]');
    clearFormError(event.currentTarget);
    await withControlBusy(submit, 'Saving', async () => {
      try {
        const patch = crewFormPatch();
        const wasNew = crewEditor.isNew;
        const savedId = wasNew
          ? await Meteor.callAsync('constellation.crewCreate', currentSessionId, patch)
          : selectedCrewId;
        if (!wasNew) {
          await Meteor.callAsync('constellation.crewSave', currentSessionId, selectedCrewId, patch);
        }
        crewEditor = null;
        selectedCrewId = savedId;
        renderCrewSettings();
        sessionChanged.changed();
        toast(wasNew ? 'Agent added to the workspace.' : 'Agent saved.');
      } catch (error) {
        showFormError(
          'crew-form', error,
          staleReloadOptions(error, () => {
            crewEditor = null;
            renderCrewSettings();
          }),
        );
        toast(messageOf(error), 'error');
      }
    });
  });
  const restoreCrewAgent = async (config, control) => {
    await withControlBusy(control, 'Restoring', async () => {
      try {
        await Meteor.callAsync('constellation.crewRestore', config._id, config.revision);
        crewEditor = null;
        renderCrewSettings();
        sessionChanged.changed();
        toast(`${config.displayName} restored as inactive.`);
      } catch (error) {
        toast(messageOf(error), 'error');
      }
    });
  };
  $('restore-crew-agent-learning').addEventListener('click', async (event) => {
    const config = selectedCrewId ? CrewConfigs.findOne(selectedCrewId) : null;
    if (!config || !crewConfigArchived(config)) return;
    await restoreCrewAgent(config, event.currentTarget);
  });
  $('archive-crew-agent').addEventListener('click', async (event) => {
    if (!selectedCrewId) return;
    const configId = selectedCrewId;
    const config = CrewConfigs.findOne(configId);
    if (!config) return;
    if (crewConfigArchived(config)) {
      await restoreCrewAgent(config, event.currentTarget);
      return;
    }
    if (!currentSessionId) return;
    if (crewEditor?.dirty) {
      if (!discardCrewChanges('Discard unsaved changes and continue to archive this agent?')) return;
      crewEditor = null;
      renderCrewSettings();
    }
    await withControlBusy(event.currentTarget, 'Checking', async () => {
      try {
        pendingCrewArchiveImpact = await Meteor.callAsync('constellation.crewImpact', configId);
        renderCrewArchiveImpact(pendingCrewArchiveImpact);
        $('crew-archive-dialog').showModal();
      } catch (error) { toast(messageOf(error), 'error'); }
    });
    renderCrewSettings();
  });
  const closeCrewArchive = () => {
    pendingCrewArchiveImpact = null;
    $('crew-archive-dialog').close();
  };
  $('close-crew-archive').addEventListener('click', closeCrewArchive);
  $('cancel-crew-archive').addEventListener('click', closeCrewArchive);
  $('confirm-crew-archive').addEventListener('click', async (event) => {
    if (!currentSessionId || !pendingCrewArchiveImpact) return;
    const impact = pendingCrewArchiveImpact;
    const primary = crewConfigs().find((candidate) => candidate.agent === 'orchestrator');
    await withControlBusy(event.currentTarget, 'Archiving', async () => {
      pendingCrewArchives.add(impact.configId);
      crewEditor = null;
      selectedCrewId = primary?._id ?? null;
      renderCrewSettings();
      sessionChanged.changed();
      try {
        await Meteor.callAsync(
          'constellation.crewArchive', currentSessionId, impact.configId, impact.agent,
          impact.configRevision, impact.digest,
        );
        pendingCrewArchives.delete(impact.configId);
        pendingCrewArchiveImpact = null;
        $('crew-archive-dialog').close();
        renderCrewSettings();
        sessionChanged.changed();
        toast(`${impact.displayName} archived. History preserved.`);
      } catch (error) {
        pendingCrewArchives.delete(impact.configId);
        selectedCrewId = impact.configId;
        if (['stale-impact', 'stale-agent'].includes(error?.error)) {
          try {
            pendingCrewArchiveImpact = await Meteor.callAsync(
              'constellation.crewImpact', impact.configId,
            );
            renderCrewArchiveImpact(pendingCrewArchiveImpact);
          } catch {
            pendingCrewArchiveImpact = null;
            $('crew-archive-dialog').close();
          }
        }
        renderCrewSettings();
        sessionChanged.changed();
        toast(messageOf(error), 'error');
      }
    });
  });
  $('crew-model').addEventListener('change', (event) => {
    renderCrewModelSelector(event.currentTarget.value);
  });
  $('crew-form').addEventListener('keydown', (event) => {
    if (agentDetailTab !== 'profile' && event.key === 'Enter'
      && event.target instanceof HTMLInputElement) event.preventDefault();
  });
  $('crew-form').addEventListener('input', captureCrewEdit);
  $('crew-form').addEventListener('change', captureCrewEdit);
}

function concise(value, max = 120) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function isStructuredPayload(value) {
  let source = String(value ?? '').trim();
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) source = fenced[1].trim();
  if (!((source.startsWith('{') && source.endsWith('}'))
    || (source.startsWith('[') && source.endsWith(']')))) return false;
  try {
    const parsed = JSON.parse(source);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function operationalToolName(name) {
  return crewDefinition(name)?.label
    ?? String(name || 'Tool').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function setChildRuntimeState(dialog, chat, state) {
  const busy = ['loading', 'thinking', 'working'].includes(state.key)
    || state.runtimePhase === 'retrying';
  dialog.dataset.agentState = state.key;
  dialog.setAttribute('aria-busy', String(busy));
  chat.dataset.agentState = state.key;
  chat.dataset.runtimePhase = state.runtimePhase;
  chat.setAttribute('aria-busy', String(busy));
  const mount = $('child-chat-mount');
  if (mount) {
    mount.dataset.agentState = state.key;
    mount.setAttribute('aria-busy', String(busy));
  }
  const runtime = $('run-runtime-state');
  const label = $('run-runtime-label');
  if (runtime) {
    runtime.dataset.agentState = state.key;
    runtime.dataset.runtimePhase = state.runtimePhase;
    runtime.title = state.detail;
    runtime.setAttribute('aria-label', `${state.label}. ${state.detail}`);
  }
  if (label && label.textContent !== state.label) label.textContent = state.label;
}

function openChildRun(sessionId, agentName) {
  const dialog = $('run-dialog');
  const mount = $('child-chat-mount');
  childRunComputation?.stop();
  const chat = document.createElement('agent-chat');
  chat.setAttribute('agent', agentName);
  chat.setAttribute('session-id', sessionId);
  chat.setAttribute('verbosity', missionConfig()?.debugTraces ? 'debug' : 'clean');
  const header = document.createElement('span');
  header.slot = 'header';
  header.className = 'chat-header-label';
  header.textContent = 'CHILD SESSION';
  chat.append(header);
  mount.replaceChildren(chat);
  $('run-dialog-title').textContent = `${crewDefinition(agentName)?.label ?? agentName} run`;
  dialog.showModal();
  childRunComputation = Tracker.autorun(() => {
    const session = AgentSessions.findOne(sessionId);
    const messages = chat.agentInstance?.messages(sessionId).fetch() ?? [];
    setChildRuntimeState(dialog, chat, deriveRuntimeState(session, messages));
  });
}

function renderActivity(messages, runtimeState, debugTraces = false) {
  const list = $('activity-feed');
  list.textContent = '';
  const toolNames = new Map();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
  }
  const interesting = messages.filter((message) =>
    message.role === 'tool' || message.role === 'assistant' || message.role === 'note'
      || message.kind === 'crew-note',
  ).slice(-14);

  const live = ['loading', 'thinking', 'working', 'waiting', 'retrying'].includes(runtimeState.key);
  if (live) {
    const item = document.createElement('div');
    item.className = `activity-item live ${runtimeState.key}`;
    item.dataset.agentState = runtimeState.key;
    item.setAttribute('aria-label', `${runtimeState.label}. ${runtimeState.detail}`);
    const visual = document.createElement('span');
    visual.className = 'activity-state-visual';
    visual.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = runtimeState.label;
    const body = document.createElement('p');
    body.textContent = runtimeState.detail;
    const at = document.createElement('time');
    at.textContent = 'live';
    item.append(visual, title, body, at);
    list.append(item);
  }

  if (interesting.length === 0 && !live) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty';
    empty.textContent = 'No activity.';
    list.append(empty);
    return;
  }

  for (const message of interesting) {
    const item = document.createElement('div');
    const type = message.kind === 'crew-note'
      ? 'crew-note'
      : (message.role === 'tool' ? 'tool' : (message.kind === 'approval' ? 'approval' : 'assistant'));
    item.className = `activity-item ${type}`;
    const title = document.createElement('strong');
    if (message.kind === 'crew-note') {
      const via = message.source?.kind === 'channel'
        ? surfaceLabel(message.source.channel)
        : 'Desktop';
      title.textContent = `${message.from?.name ?? 'Crew member'} · ${via}`;
    }
    else if (message.role === 'tool') title.textContent = `${operationalToolName(toolNames.get(message.toolCallId))} completed`;
    else if (message.kind === 'approval') {
      const action = operationalToolName(toolNames.get(message.toolCallId));
      title.textContent = `${action} ${message.approved ? 'approved' : 'denied'}`;
    }
    else title.textContent = `${message.from?.name ?? primaryDefinition().label} response`;
    const body = document.createElement('p');
    const raw = message.content || message.reason || message.kind || '';
    if (message.kind === 'crew-note') {
      body.textContent = concise(raw || 'Crew note');
    } else if (debugTraces) {
      body.textContent = concise(raw || 'Transcript event');
    } else if (message.role === 'tool') {
      body.textContent = message.childSessionId ? 'Delegated run recorded.' : 'Result recorded.';
    } else if (message.kind === 'approval') {
      body.textContent = 'Decision recorded for one call.';
    } else if (message.toolCalls?.length) {
      body.textContent = `${message.toolCalls.length} tool request${message.toolCalls.length === 1 ? '' : 's'} recorded.`;
    } else {
      body.textContent = isStructuredPayload(raw) ? 'Structured response hidden.' : 'Message recorded.';
    }
    const at = document.createElement('time');
    at.textContent = message.streaming ? 'live' : timeAgo(message.createdAt);
    item.append(title, body, at);
    if (message.childSessionId) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Open child session →';
      const agentName = toolNames.get(message.toolCallId) ?? 'researcher';
      button.addEventListener('click', () => openChildRun(message.childSessionId, agentName));
      item.append(button);
    }
    list.append(item);
  }
}

function renderMissionState() {
  sessionChanged.depend();
  const chat = $('mission-chat');
  const session = currentSessionId ? AgentSessions.findOne(currentSessionId) : null;
  const config = missionConfig();
  const messages = chat?.agentInstance && currentSessionId
    ? chat.agentInstance.messages(currentSessionId).fetch()
    : [];

  const title = config?.title || session?.title || 'New mission';
  $('mission-title').textContent = title;
  $('mission-slug').textContent = title.toUpperCase().slice(0, 34);
  $('configure-mission').disabled = !config;
  $('continuity-state').textContent = config?.continuity === false
    ? 'Off'
    : 'On · comes back as your last mission';
  $('mission-empty').classList.toggle('hidden', messages.length > 0);
  $('turn-counter').textContent = `${session?.budgetSpent?.turns ?? 0} turn${(session?.budgetSpent?.turns ?? 0) === 1 ? '' : 's'}`;
  const verbosity = config?.debugTraces ? 'debug' : 'clean';
  if (chat.getAttribute('verbosity') !== verbosity) chat.setAttribute('verbosity', verbosity);

  const runtimeState = missionLifecycleState(deriveRuntimeState(session, messages), config);
  const phase = runtimeState.runtimePhase;
  const crewBusy = missionCrewIsBusy();
  for (const button of [$('manage-mission-crew'), $('manage-mission-crew-inspector')]) {
    button.disabled = !config || crewBusy;
    button.title = crewBusy ? 'Available when the current turn finishes' : 'Edit Mission crew';
  }
  const missionRoot = $('view-missions');
  const busy = ['loading', 'thinking', 'working'].includes(runtimeState.key)
    || phase === 'retrying';
  const contentLoading = !session || !config;
  if (missionRoot.dataset.agentState !== runtimeState.key) missionRoot.dataset.agentState = runtimeState.key;
  if (missionRoot.dataset.runtimePhase !== phase) missionRoot.dataset.runtimePhase = phase;
  if (missionRoot.getAttribute('aria-busy') !== String(contentLoading)) {
    missionRoot.setAttribute('aria-busy', String(contentLoading));
  }
  if (chat.dataset.agentState !== runtimeState.key) chat.dataset.agentState = runtimeState.key;
  if (chat.dataset.runtimePhase !== phase) chat.dataset.runtimePhase = phase;
  if (chat.getAttribute('aria-busy') !== String(contentLoading)) {
    chat.setAttribute('aria-busy', String(contentLoading));
  }

  const pill = $('phase-pill');
  const pillClass = `live-pill ${runtimeState.key} ${phase}`;
  if (pill.className !== pillClass) pill.className = pillClass;
  if (pill.dataset.agentState !== runtimeState.key) pill.dataset.agentState = runtimeState.key;
  if (pill.dataset.runtimePhase !== phase) pill.dataset.runtimePhase = phase;
  const runtimeAria = `${runtimeState.label}. ${runtimeState.detail}`;
  pill.title = runtimeState.detail;
  const pillLabel = runtimeState.label.toUpperCase();
  if (pill.querySelector('span').textContent !== pillLabel) pill.querySelector('span').textContent = pillLabel;

  const runtime = $('mission-runtime-state');
  const runtimeLabel = $('mission-runtime-label');
  if (runtime) {
    if (runtime.dataset.agentState !== runtimeState.key) runtime.dataset.agentState = runtimeState.key;
    if (runtime.dataset.runtimePhase !== phase) runtime.dataset.runtimePhase = phase;
    if (runtime.getAttribute('aria-label') !== runtimeAria) runtime.setAttribute('aria-label', runtimeAria);
    runtime.title = runtimeState.detail;
  }
  if (runtimeLabel && runtimeLabel.textContent !== runtimeState.label) {
    runtimeLabel.textContent = runtimeState.label;
  }

  const usage = session?.usage ?? { input: 0, output: 0, cost: 0 };
  const tokens = usage.input + usage.output;
  const spent = session?.budgetSpent ?? { turns: 0, toolCalls: 0 };
  const thresholds = config?.budget ?? DEFAULT_MISSION_THRESHOLDS;
  $('usage-tokens').textContent = tokens > 999 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  $('usage-tools').textContent = String(spent.toolCalls ?? 0);
  $('usage-cost').textContent = `$${Number(usage.cost ?? 0).toFixed(2)}`;
  const ratio = (value, limit) => (limit > 0 ? value / limit : (value > 0 ? 1 : 0));
  const budgetPct = Math.min(100, Math.max(
    ratio(spent.turns ?? 0, thresholds.turns),
    ratio(spent.toolCalls ?? 0, thresholds.toolCalls),
    ratio(Number(usage.cost ?? 0), thresholds.spend),
  ) * 100);
  $('budget-fill').style.width = `${budgetPct}%`;
  $('budget-copy').textContent = `${spent.turns ?? 0} / ${thresholds.turns} turns · ${spent.toolCalls ?? 0} / ${thresholds.toolCalls} tools · $${Number(usage.cost ?? 0).toFixed(2)} / $${Number(thresholds.spend).toFixed(2)}`;
  $('health-label').textContent = config?.status === 'completed' ? 'Completed'
    : (config?.status === 'paused' ? 'Paused'
      : (runtimeState.key === 'error' ? 'Needs attention'
        : (budgetPct >= 100 ? 'Threshold reached'
          : (budgetPct >= 80 ? 'Approaching threshold'
            : (phase === 'awaiting' ? 'Awaiting you'
              : (runtimeState.key === 'stopped' ? 'Stopped'
                : (busy ? 'Active' : 'Nominal')))))));

  renderCrew(session, messages, runtimeState, config);
  renderMissionCollaboration();
  renderActivity(messages, runtimeState, config?.debugTraces === true);
  renderMissionList(messages);
  if ($('mission-dialog').open) updateMissionConfigBadge(config?.status ?? 'active');

  if (session && config?.autoTitle !== false && /^(new|untitled) mission$/i.test(title)) {
    const firstUser = messages.find((message) => (
      message.role === 'user' && message.kind !== 'crew-note' && message.content?.trim()
    ));
    maybeAutoTitle(session, firstUser?.content);
  }
}

function memoryReviewAttentionCount() {
  if (!learningIsReady()) return null;
  const practices = AgentPractices.find({}).fetch();
  const experiences = AgentExperiences.find({}).fetch();
  return practices.filter((row) => row.status === 'candidate').length
    + practices.filter((row) => learningAdmissionState('practice', row).pending).length
    + experiences.filter((row) => learningAdmissionState('experience', row).pending).length;
}

function renderMemory() {
  memoryViewChanged.depend();
  const reviewCount = memoryReviewAttentionCount();
  const reviewCountElement = $('memory-reviews-count');
  reviewCountElement.textContent = reviewCount === null ? '—' : String(reviewCount);
  reviewCountElement.dataset.state = reviewCount > 0 ? 'attention' : 'clear';
  $('memory-open-reviews').setAttribute(
    'aria-label',
    reviewCount === null
      ? 'Open learning reviews, status unavailable'
      : `Open learning reviews, ${reviewCount} ${reviewCount === 1 ? 'item needs' : 'items need'} attention`,
  );
  const query = $('memory-search').value.trim().toLowerCase();
  const all = AgentMemories.find({}, { sort: { pinned: -1, at: -1 } }).fetch();
  $('personal-memory-count').textContent = String(all.filter((row) => row.scope !== 'app').length);
  $('work-memory-count').textContent = String(all.filter((row) => row.scope === 'app').length);
  const rows = all.filter((row) => {
    if (memoryFilter !== 'all' && row.scope !== memoryFilter) return false;
    return !query || `${row.text} ${row.by} ${row.scope}`.toLowerCase().includes(query);
  });
  const list = $('memory-list');
  list.textContent = '';
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty';
    empty.textContent = query ? 'No matching memories.' : 'No memories.';
    list.append(empty);
    return;
  }
  for (const memory of rows) {
    const row = document.createElement('article');
    row.className = `memory-row ${memory.scope}`;
    const icon = document.createElement('span');
    icon.className = 'memory-row-icon';
    icon.textContent = memory.scope === 'app' ? '∞' : '◇';
    const copy = document.createElement('div');
    copy.className = 'memory-row-copy';
    const text = document.createElement('p');
    text.textContent = memory.text;
    const meta = document.createElement('div');
    const scope = document.createElement('span');
    scope.textContent = memory.scope === 'app' ? 'Shared work' : 'Personal';
    const by = document.createElement('span');
    by.textContent = `by ${memory.by}`;
    const at = document.createElement('span');
    at.textContent = timeAgo(memory.at);
    meta.append(scope, by, at);
    if (memory.pinned) {
      const pin = document.createElement('i');
      pin.textContent = 'Always included';
      meta.append(pin);
    }
    copy.append(text, meta);
    let action;
    if (memory.scope === 'app') {
      action = document.createElement('span');
      action.className = 'memory-managed-state';
      action.textContent = 'Agent-managed';
      action.title = 'Ask an agent to forget this shared memory';
    } else {
      action = document.createElement('button');
      action.type = 'button';
      action.title = 'Delete this personal memory';
      action.setAttribute('aria-label', 'Delete personal memory');
      action.textContent = '×';
      action.addEventListener('click', async (event) => {
        await withControlBusy(event.currentTarget, 'Deleting', async () => {
          try {
            await Meteor.callAsync(NAMES.mMemoryForget, { id: memory._id });
            toast('Memory deleted.');
          } catch (error) { toast(messageOf(error), 'error'); }
        });
      });
    }
    row.append(icon, copy, action);
    list.append(row);
  }
}

function updateMissionConfigBadge(status = missionConfig()?.status ?? 'active') {
  const badge = $('mission-config-runtime-state');
  if (!badge) return;
  const session = currentSessionId ? AgentSessions.findOne(currentSessionId) : null;
  const runtime = deriveRuntimeState(session, currentMissionMessages());
  const state = status === 'active'
    ? runtime
    : {
      key: status,
      label: status === 'completed' ? 'Completed' : 'Paused',
      detail: status === 'completed' ? 'Mission completed' : 'Mission paused',
    };
  badge.dataset.state = state.key;
  badge.title = state.detail;
  badge.querySelector('span').textContent = state.label;
}

async function openMissionSettings(sessionId = currentSessionId) {
  if (!sessionId) return;
  let config = missionConfig(sessionId);
  if (!config) {
    try {
      await prepareSession(sessionId);
      config = missionConfig(sessionId);
    } catch (error) {
      toast(messageOf(error), 'error');
      return;
    }
  }
  clearFormError('mission-form');
  if (!config) {
    toast('Mission settings are still loading.', 'error');
    return;
  }
  editingMissionSessionId = sessionId;
  editingMissionRevision = config.revision;
  $('mission-dialog-id').textContent = 'This mission';
  $('mission-config-title').value = config.title ?? 'New mission';
  $('mission-config-objective').value = config.objective ?? '';
  const statusSelect = $('mission-config-status');
  statusSelect.querySelector('option[value="completed"]')?.remove();
  if (config.status === 'completed') {
    const completed = document.createElement('option');
    completed.value = 'completed';
    completed.textContent = 'Completed';
    statusSelect.append(completed);
  }
  $('mission-config-status').value = config.status ?? 'active';
  statusSelect.disabled = config.status === 'completed';
  $('mission-config-turns').value = String(config.budget?.turns ?? DEFAULT_MISSION_THRESHOLDS.turns);
  $('mission-config-tool-calls').value = String(config.budget?.toolCalls ?? DEFAULT_MISSION_THRESHOLDS.toolCalls);
  $('mission-config-spend').value = String(config.budget?.spend ?? DEFAULT_MISSION_THRESHOLDS.spend);
  $('mission-config-auto-title').checked = config.autoTitle ?? true;
  $('mission-config-continuity').checked = config.continuity ?? true;
  $('mission-config-approvals').checked = config.approvals ?? true;
  $('mission-config-approvals-hint').textContent = 'Other tool approval policies stay unchanged';
  $('mission-config-debug-traces').checked = config.debugTraces ?? false;
  $('mission-config-continuity').disabled = config.status === 'completed';
  $('archive-mission').textContent = config.status === 'completed' ? 'Reactivate mission' : 'Complete mission';
  $('mission-complete-effect').textContent = config.status === 'completed'
    ? 'Restarts linked Pulses and allows this mission to resume.'
    : 'Stops work, pauses linked Pulses, and disables resume.';
  updateMissionStatusHint(config.status);
  updateMissionConfigBadge(config.status);
  beginGuardedEditor('mission-form');
  if (!$('mission-dialog').open) $('mission-dialog').showModal();
  requestAnimationFrame(() => $('mission-config-title').focus());
}

function missionFormPatch() {
  return {
    title: $('mission-config-title').value,
    objective: $('mission-config-objective').value,
    status: $('mission-config-status').value,
    primaryAgent: 'orchestrator',
    budget: {
      turns: Number($('mission-config-turns').value),
      toolCalls: Number($('mission-config-tool-calls').value),
      spend: Number($('mission-config-spend').value),
    },
    autoTitle: $('mission-config-auto-title').checked,
    continuity: $('mission-config-continuity').checked,
    approvals: $('mission-config-approvals').checked,
    debugTraces: $('mission-config-debug-traces').checked,
  };
}

function updateMissionStatusHint(status) {
  const copy = status === 'paused'
    ? 'Stops active work and linked Pulses until reactivated.'
    : (status === 'completed'
      ? 'Stops work, pauses linked Pulses, and disables resume.'
      : 'Agents and linked Pulses can run.');
  $('mission-status-hint').textContent = copy;
}

function missionStateChangeNeedsConfirmation(current, nextStatus) {
  if (!current || current.status !== 'active' || nextStatus === 'active') return false;
  const session = AgentSessions.findOne(currentSessionId);
  const runtime = deriveRuntimeState(session, currentMissionMessages());
  return ['streaming', 'calling', 'retrying', 'compacting'].includes(session?.phase)
    || runtime.runtimePhase === 'awaiting'
    || runtime.key === 'waiting';
}

function confirmMissionStateChange(current, nextStatus) {
  if (!missionStateChangeNeedsConfirmation(current, nextStatus)) return true;
  const linkedPulses = PulseConfigs.find({ sessionId: currentSessionId, enabled: true }).count();
  const pulseCopy = `${linkedPulses} linked Pulse${linkedPulses === 1 ? '' : 's'}`;
  const verb = nextStatus === 'completed' ? 'Complete' : 'Pause';
  return window.confirm(
    `${verb} “${current.title}”? This stops the active work, pauses ${pulseCopy}, and holds any pending approval.`,
  );
}

function wireMissionSettings() {
  registerGuardedEditor({
    formId: 'mission-form', dialogId: 'mission-dialog', statusId: 'mission-form-status',
    closeId: 'close-mission-dialog', cancelId: 'cancel-mission-edit',
    label: 'this mission', read: missionFormPatch,
  });
  $('configure-mission').addEventListener('click', (event) => {
    void withControlBusy(event.currentTarget, 'Loading', openMissionSettings);
  });
  $('configure-continuity').addEventListener('click', (event) => {
    void withControlBusy(event.currentTarget, 'Loading', openMissionSettings);
  });
  $('mission-dialog').addEventListener('close', () => {
    editingMissionSessionId = null;
    editingMissionRevision = null;
  });
  $('mission-config-status').addEventListener('change', (event) => {
    updateMissionConfigBadge(event.currentTarget.value);
    updateMissionStatusHint(event.currentTarget.value);
  });
  $('mission-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormError(event.currentTarget);
    const sessionId = editingMissionSessionId;
    const expectedRevision = editingMissionRevision;
    const config = missionConfig(sessionId);
    if (!sessionId || !config) return;
    const patch = missionFormPatch();
    if (!confirmMissionStateChange(config, patch.status)) {
      const statusSelect = $('mission-config-status');
      statusSelect.value = config.status;
      if (config.status !== 'completed') statusSelect.querySelector('option[value="completed"]')?.remove();
      updateMissionConfigBadge(config.status);
      updateMissionStatusHint(config.status);
      updateGuardedEditor('mission-form');
      return;
    }
    const submit = event.submitter ?? $('mission-form').querySelector('[type="submit"]');
    await withControlBusy(submit, 'Saving', async () => {
      try {
        const saved = await Meteor.callAsync(
          'constellation.missionSave',
          sessionId,
          expectedRevision,
          patch,
        );
        persistResumableMission(sessionId, saved);
        $('mission-dialog').close();
        sessionChanged.changed();
        toast('Mission saved.');
      } catch (error) {
        showFormError('mission-form', error, staleReloadOptions(error, () => openMissionSettings(sessionId)));
        toast(messageOf(error), 'error');
      }
    });
  });
  $('archive-mission').addEventListener('click', () => {
    const completed = missionConfig()?.status === 'completed';
    const statusSelect = $('mission-config-status');
    if (!completed && !statusSelect.querySelector('option[value="completed"]')) {
      const option = document.createElement('option');
      option.value = 'completed';
      option.textContent = 'Completed';
      statusSelect.append(option);
    }
    $('mission-config-status').value = completed ? 'active' : 'completed';
    updateMissionConfigBadge(completed ? 'active' : 'completed');
    updateMissionStatusHint(completed ? 'active' : 'completed');
    updateGuardedEditor('mission-form');
    $('mission-form').requestSubmit();
  });
}

function wireNavigation() {
  document.querySelectorAll('.rail-button[data-view]').forEach((button) => {
    button.addEventListener('click', () => activateView(button.dataset.view));
  });
  document.querySelectorAll('[data-view-link]').forEach((button) => {
    button.addEventListener('click', () => activateView(button.dataset.viewLink));
  });
  $('new-mission').addEventListener('click', (event) => { void newMission(event.currentTarget); });
  $('mission-search').addEventListener('input', renderMissionList);
  $('mission-search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.currentTarget.value = ''; renderMissionList(); }
  });
  $('profile-button').addEventListener('click', openLocalAccountDetails);
  $('close-account-dialog').addEventListener('click', closeLocalAccountDetails);
  $('account-dialog-done').addEventListener('click', closeLocalAccountDetails);
  $('account-open-directory').addEventListener('click', () => {
    closeLocalAccountDetails();
    setCrewDirectoryTab('people');
    openCrewSettings();
    requestAnimationFrame(() => $('crew-directory-tab-people')?.focus());
  });
  $('account-open-channels').addEventListener('click', () => {
    closeLocalAccountDetails();
    activateView('channels');
    requestAnimationFrame(() => document.querySelector('.rail-button[data-view="channels"]')?.focus());
  });
}

function wireMissionActions() {
  const moreActions = $('mission-more-actions');
  const moreTrigger = $('mission-more-trigger');
  moreActions.addEventListener('toggle', () => {
    moreTrigger.setAttribute('aria-expanded', String(moreActions.open));
    if (moreActions.open) requestAnimationFrame(() => $('fork-mission').focus());
  });
  moreActions.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      moreActions.open = false;
      moreTrigger.focus();
    });
  });
  document.addEventListener('click', (event) => {
    if (moreActions.open && !moreActions.contains(event.target)) moreActions.open = false;
  });
  moreActions.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      moreActions.open = false;
      moreTrigger.focus();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
      || !moreActions.open) return;
    event.preventDefault();
    const items = [...moreActions.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? items[0]
      : event.key === 'End' ? items.at(-1)
        : items[(Math.max(0, current) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next.focus();
  });
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
      void withControlBusy(button, 'Sending', () => sendPrompt(button.dataset.prompt));
    });
  });
  $('fork-mission').addEventListener('click', async (event) => {
    if (!currentSessionId) return;
    await withControlBusy(event.currentTarget, 'Forking', async () => {
      try {
        const session = AgentSessions.findOne(currentSessionId);
        const source = missionConfig();
        const branchTitle = `${session?.title ?? 'Mission'} · branch`.slice(0, 96);
        const forked = await workspace.fork(currentSessionId, { title: branchTitle });
        await prepareSession(forked);
        if (source) {
          await Meteor.callAsync('constellation.missionSave', forked, 1, {
            title: branchTitle,
            objective: source.objective ?? '',
            status: 'active',
            primaryAgent: source.primaryAgent ?? 'orchestrator',
            budget: source.budget ?? DEFAULT_MISSION_THRESHOLDS,
            autoTitle: source.autoTitle ?? true,
            continuity: source.continuity ?? true,
            approvals: source.approvals ?? true,
            debugTraces: source.debugTraces ?? false,
          });
        }
        openSession(forked);
        toast('Mission forked.');
      } catch (error) { toast(messageOf(error), 'error'); }
    });
  });
  $('compact-mission').addEventListener('click', async (event) => {
    if (!currentSessionId) return;
    if (missionConfig()?.status !== 'active') {
      toast('Activate this mission before compacting.', 'error');
      return;
    }
    await withControlBusy(event.currentTarget, 'Reducing', async () => {
      try {
        const changed = await workspace.compact(currentSessionId);
        toast(changed ? 'Context compacted.' : 'No compaction needed.');
      } catch (error) { toast(messageOf(error), 'error'); }
    });
  });
  $('toggle-inspector').addEventListener('click', (event) => {
    const workspaceEl = document.querySelector('.mission-workspace');
    workspaceEl.classList.toggle('inspector-hidden');
    event.currentTarget.classList.toggle('active', !workspaceEl.classList.contains('inspector-hidden'));
  });
  document.querySelectorAll('[data-inspector-tab]').forEach((button) => {
    const activate = (target, focus = false) => {
      document.querySelectorAll('[data-inspector-tab]').forEach((tab) => {
        const active = tab === target;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      });
      document.querySelectorAll('[data-inspector-panel]').forEach((panel) => {
        const active = panel.dataset.inspectorPanel === target.dataset.inspectorTab;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
      if (focus) target.focus();
    };
    button.addEventListener('click', () => activate(button));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[data-inspector-tab]')];
      const current = tabs.indexOf(button);
      const next = event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs.at(-1)
          : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      activate(next, true);
    });
  });
  $('close-run-dialog').addEventListener('click', () => $('run-dialog').close());
  $('run-dialog').addEventListener('close', () => {
    childRunComputation?.stop();
    childRunComputation = null;
    $('child-chat-mount').replaceChildren();
  });
}

function wireMemory() {
  $('memory-open-agent-learning').addEventListener('click', () => {
    setCrewDirectoryTab('agents');
    setAgentDetailTab('experience');
    openCrewSettings();
    requestAnimationFrame(() => $('agent-detail-tab-experience')?.focus());
  });
  $('memory-open-reviews').addEventListener('click', openLearningReviews);
  $('memory-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormError(event.currentTarget);
    const input = $('memory-input');
    const submit = event.submitter ?? event.currentTarget.querySelector('[type="submit"]');
    await withControlBusy(submit, 'Saving', async () => {
      try {
        await Meteor.callAsync(NAMES.mMemorySave, {
          text: input.value.trim(),
          pinned: $('memory-pinned').checked,
        });
        input.value = '';
        $('memory-pinned').checked = false;
        toast('Personal memory saved.');
      } catch (error) {
        showFormError('memory-form', error);
        toast(messageOf(error), 'error');
      }
    });
  });
  document.querySelectorAll('[data-memory-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      memoryFilter = button.dataset.memoryFilter;
      document.querySelectorAll('[data-memory-filter]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
      $('memory-form').hidden = memoryFilter === 'app';
      $('memory-scope-note').hidden = memoryFilter !== 'app';
      memoryViewChanged.changed();
    });
  });
  $('memory-search').addEventListener('input', () => memoryViewChanged.changed());
}

function relativeTime(value, future = false) {
  if (!value) return 'Never';
  const at = new Date(value).getTime();
  const delta = future ? at - Date.now() : Date.now() - at;
  if (!Number.isFinite(delta)) return 'Unknown';
  if (future && delta <= 0) return 'Due';
  const minutes = Math.max(1, Math.round(Math.abs(delta) / 60_000));
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function localClock(hour, minute) {
  const value = new Date(2000, 0, 1, Number(hour), Number(minute));
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value);
}

function humanSchedule(schedule) {
  if (schedule?.kind !== 'cron') {
    const every = Number(schedule?.every ?? 0);
    const unit = String(schedule?.unit ?? 'minutes').replace(/s$/, '');
    return every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = String(schedule.expression ?? '').trim().split(/\s+/);
  if (![minute, hour].every((part) => /^\d+$/.test(part)) || dayOfMonth !== '*' || month !== '*') {
    return 'Custom schedule';
  }
  const time = localClock(hour, minute);
  if (dayOfWeek === '*') return `Daily at ${time}`;
  const days = dayOfWeek.split(',').map((part) => Number(part) % 7).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!days.length) return 'Custom schedule';
  if (days.join(',') === '1,2,3,4,5') return `Weekdays at ${time}`;
  return `${days.map((day) => `${WEEKDAYS[day]}s`).join(', ')} at ${time}`;
}

function pulseFailureLabel(code) {
  const normalized = String(code ?? '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  const labels = {
    'intent standing': 'Already queued for this mission',
    'mission paused': 'Target mission is paused',
    'mission completed': 'Target mission is completed',
    'pulse disabled': 'Pulse is paused',
    'missing session': 'Target mission is unavailable',
    'session missing': 'Target mission is unavailable',
    cooldown: 'Waiting before retrying',
  };
  return labels[normalized] ?? 'Could not run pulse';
}

function resourceEmpty(text) {
  const empty = document.createElement('div');
  empty.className = 'resource-empty';
  empty.textContent = text;
  return empty;
}

function pulsePatch(pulse, enabled = pulse.enabled) {
  return {
    name: pulse.name,
    prompt: pulse.prompt,
    agent: pulse.agent,
    sessionId: pulse.sessionId,
    schedule: pulse.schedule,
    enabled,
  };
}

async function setPulseEnabled(pulse, enabled, control) {
  return withControlBusy(control, enabled ? 'Enabling' : 'Pausing', async () => {
    try {
      await Meteor.callAsync('constellation.pulseSave', pulse._id, pulse.revision, pulsePatch(pulse, enabled));
      toast(`${pulse.name} ${enabled ? 'enabled' : 'paused'}.`);
    } catch (error) {
      if (control) control.checked = pulse.enabled;
      toast(messageOf(error), 'error');
    }
  });
}

async function runPulse(pulse, control) {
  return withControlBusy(control, 'Running', async () => {
    try {
      const outcome = await Meteor.callAsync('constellation.pulseRun', pulse._id);
      if (!outcome.ok) throw new Error(pulseFailureLabel(outcome.reason));
      toast(outcome.ran ? 'Pulse accepted.' : 'Pulse queued.');
    } catch (error) { toast(messageOf(error), 'error'); }
  });
}

function renderPulses() {
  const all = PulseConfigs.find({}, { sort: { createdAt: 1 } }).fetch();
  const active = all.filter((pulse) => pulse.enabled);
  $('pulse-total-count').textContent = String(all.length);
  $('pulse-active-count').textContent = String(active.length);
  const next = [...active].sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))[0];
  $('pulse-next-run').textContent = next ? relativeTime(next.nextRunAt, true) : '—';
  const rows = all.filter((pulse) => pulseFilter === 'all'
    || (pulseFilter === 'active' ? pulse.enabled : !pulse.enabled));
  const grid = $('pulse-grid');
  grid.replaceChildren();
  if (!rows.length) {
    grid.append(resourceEmpty(all.length ? 'No matching pulses.' : 'No pulses.'));
    return;
  }
  for (const pulse of rows) {
    const dispatching = pulse.lastStatus === 'dispatching';
    const card = document.createElement('article');
    card.className = 'pulse-card';
    card.dataset.agentState = dispatching ? 'working' : (pulse.enabled ? 'ready' : 'paused');
    card.setAttribute('aria-busy', String(dispatching));
    const top = document.createElement('div');
    top.className = 'pulse-card-top';
    const icon = document.createElement('span');
    icon.className = 'automation-icon amber';
    icon.textContent = '↻';
    const actions = document.createElement('div');
    actions.className = 'pulse-card-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'resource-card-action';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openPulseDialog(pulse._id));
    const toggle = document.createElement('label');
    toggle.className = 'switch';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = pulse.enabled;
    checkbox.setAttribute('aria-label', `${pulse.enabled ? 'Pause' : 'Enable'} ${pulse.name}`);
    checkbox.addEventListener('change', () => void setPulseEnabled(pulse, checkbox.checked, checkbox));
    toggle.append(checkbox, document.createElement('span'));
    actions.append(edit, toggle);
    top.append(icon, actions);
    const title = document.createElement('h3');
    title.textContent = pulse.name;
    const prompt = document.createElement('p');
    prompt.textContent = concise(pulse.prompt, 130);
    const meta = document.createElement('div');
    meta.className = 'pulse-meta';
    const schedule = document.createElement('span');
    try { schedule.textContent = humanSchedule(pulse.schedule); } catch { schedule.textContent = 'Custom schedule'; }
    const owner = document.createElement('span');
    owner.textContent = crewDefinition(pulse.agent)?.label ?? pulse.agent;
    const session = document.createElement('span');
    session.textContent = AgentSessions.findOne(pulse.sessionId)?.title ?? 'Missing mission';
    meta.append(schedule, owner, session);
    const status = document.createElement('div');
    status.className = 'pulse-status';
    status.dataset.agentState = dispatching ? 'working' : (pulse.enabled ? 'ready' : 'paused');
    const light = document.createElement('i');
    if (pulse.lastStatus === 'error') light.className = 'error';
    else if (dispatching) light.className = 'working';
    const copy = document.createElement('span');
    copy.textContent = dispatching
      ? 'Running now'
      : pulse.lastStatus === 'error'
      ? pulseFailureLabel(pulse.lastErrorCode)
      : (pulse.lastRunAt ? `Completed · ${relativeTime(pulse.lastRunAt)}` : `Next ${relativeTime(pulse.nextRunAt, true)}`);
    const run = document.createElement('button');
    run.type = 'button';
    run.textContent = 'Run';
    run.addEventListener('click', (event) => void runPulse(pulse, event.currentTarget));
    status.append(light, copy, run);
    card.append(top, title, prompt, meta, status);
    grid.append(card);
  }
}

function populatePulseTargets(pulse) {
  const agents = CrewConfigs.find({ enabled: true }, { sort: { order: 1 } }).fetch();
  const agentSelect = $('pulse-agent');
  agentSelect.replaceChildren();
  for (const agent of agents) {
    const option = document.createElement('option');
    option.value = agent.agent;
    option.textContent = `${agent.displayName} · ${agent.role}`;
    agentSelect.append(option);
  }
  const sessions = workspace.sessions().fetch();
  const sessionSelect = $('pulse-session');
  sessionSelect.replaceChildren();
  for (const session of sessions) {
    const option = document.createElement('option');
    option.value = session._id;
    option.textContent = session.title || 'New mission';
    sessionSelect.append(option);
  }
  agentSelect.value = pulse?.agent ?? 'orchestrator';
  sessionSelect.value = pulse?.sessionId ?? currentSessionId ?? sessions[0]?._id ?? '';
}

function setPulseScheduleFields(kind) {
  const cron = kind === 'cron';
  $('pulse-interval-fields').hidden = cron;
  $('pulse-cron-field').hidden = !cron;
  $('pulse-interval-value').required = !cron;
  $('pulse-cron').required = cron;
}

function updatePulseSchedulePreview() {
  const preview = $('pulse-schedule-preview');
  const cron = $('pulse-cron');
  const patch = pulseFormPatch();
  const mission = MissionConfigs.findOne(patch.sessionId);
  cron.setCustomValidity('');
  try {
    const next = nextScheduledAt(patch.schedule, new Date());
    const nextLabel = new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(next);
    const schedule = humanSchedule(patch.schedule);
    if (mission && mission.status !== 'active') {
      preview.dataset.tone = 'warning';
      preview.textContent = `${schedule} · ${mission.status === 'completed' ? 'Mission completed' : 'Mission paused'} · activate the Mission before enabling this Pulse.`;
      return;
    }
    preview.dataset.tone = patch.enabled ? 'ready' : 'paused';
    preview.textContent = patch.enabled
      ? `${schedule} · next ${nextLabel}`
      : `${schedule} · paused until enabled`;
  } catch (error) {
    const reason = messageOf(error);
    if (patch.schedule.kind === 'cron') cron.setCustomValidity(reason);
    preview.dataset.tone = 'error';
    preview.textContent = `Check the schedule · ${reason}`;
  }
}

function openPulseDialog(id = null) {
  clearFormError('pulse-form');
  const pulse = id ? PulseConfigs.findOne(id) : null;
  if (id && !pulse) {
    selectedPulseId = null;
    editingPulseRevision = null;
    if ($('pulse-dialog').open) $('pulse-dialog').close();
    toast('Pulse no longer exists.', 'error');
    return;
  }
  selectedPulseId = id;
  editingPulseRevision = pulse?.revision ?? null;
  $('pulse-dialog-title').textContent = pulse ? 'Edit pulse' : 'New pulse';
  $('pulse-dialog-id').textContent = pulse?._id ?? '';
  $('pulse-name').value = pulse?.name ?? '';
  $('pulse-prompt').value = pulse?.prompt ?? '';
  $('pulse-enabled').checked = pulse?.enabled ?? true;
  const kind = pulse?.schedule?.kind ?? 'interval';
  $('pulse-schedule-kind').value = kind;
  $('pulse-interval-value').value = String(pulse?.schedule?.every ?? 4);
  $('pulse-interval-unit').value = pulse?.schedule?.unit ?? 'hours';
  $('pulse-cron').value = pulse?.schedule?.expression ?? '0 9 * * 1';
  $('delete-pulse').hidden = !pulse;
  populatePulseTargets(pulse);
  setPulseScheduleFields(kind);
  updatePulseSchedulePreview();
  beginGuardedEditor('pulse-form', { cleanLabel: pulse ? 'Saved' : 'Not saved' });
  if (!$('pulse-dialog').open) $('pulse-dialog').showModal();
  requestAnimationFrame(() => $('pulse-name').focus());
}

function closePulseDialog() {
  $('pulse-dialog').close();
  selectedPulseId = null;
  editingPulseRevision = null;
}

function pulseFormPatch() {
  const kind = $('pulse-schedule-kind').value;
  return {
    name: $('pulse-name').value,
    prompt: $('pulse-prompt').value,
    agent: $('pulse-agent').value,
    sessionId: $('pulse-session').value,
    enabled: $('pulse-enabled').checked,
    schedule: kind === 'cron'
      ? { kind, expression: $('pulse-cron').value }
      : { kind, every: Number($('pulse-interval-value').value), unit: $('pulse-interval-unit').value },
  };
}

function wirePulses() {
  registerGuardedEditor({
    formId: 'pulse-form', dialogId: 'pulse-dialog', statusId: 'pulse-form-status',
    closeId: 'close-pulse-dialog', cancelId: 'cancel-pulse-edit',
    label: 'this pulse', read: pulseFormPatch,
  });
  $('add-pulse').addEventListener('click', () => openPulseDialog());
  $('pulse-dialog').addEventListener('close', () => {
    selectedPulseId = null;
    editingPulseRevision = null;
  });
  $('pulse-schedule-kind').addEventListener('change', (event) => {
    setPulseScheduleFields(event.currentTarget.value);
    updatePulseSchedulePreview();
  });
  for (const id of [
    'pulse-interval-value', 'pulse-interval-unit', 'pulse-cron', 'pulse-session', 'pulse-enabled',
  ]) {
    $(id).addEventListener('input', updatePulseSchedulePreview);
    $(id).addEventListener('change', updatePulseSchedulePreview);
  }
  document.querySelectorAll('[data-pulse-filter]').forEach((button) => button.addEventListener('click', () => {
    pulseFilter = button.dataset.pulseFilter;
    document.querySelectorAll('[data-pulse-filter]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
    renderPulses();
  }));
  $('pulse-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormError(event.currentTarget);
    const pulseId = selectedPulseId;
    const expectedRevision = editingPulseRevision;
    const submit = event.submitter ?? event.currentTarget.querySelector('[type="submit"]');
    await withControlBusy(submit, 'Saving', async () => {
      try {
        if (pulseId) {
          await Meteor.callAsync('constellation.pulseSave', pulseId, expectedRevision, pulseFormPatch());
        } else {
          await Meteor.callAsync('constellation.pulseCreate', pulseFormPatch());
        }
        closePulseDialog();
        toast('Pulse saved.');
      } catch (error) {
        showFormError('pulse-form', error, staleReloadOptions(error, () => openPulseDialog(pulseId)));
        toast(messageOf(error), 'error');
      }
    });
  });
  $('delete-pulse').addEventListener('click', async (event) => {
    const pulseId = selectedPulseId;
    const expectedRevision = editingPulseRevision;
    if (!pulseId || !window.confirm(`Delete ${$('pulse-name').value || 'this pulse'}?`)) return;
    await withControlBusy(event.currentTarget, 'Deleting', async () => {
      try {
        await Meteor.callAsync('constellation.pulseRemove', pulseId, expectedRevision);
        closePulseDialog();
        toast('Pulse deleted.');
      } catch (error) {
        showFormError('pulse-form', error, staleReloadOptions(error, () => openPulseDialog(pulseId)));
        toast(messageOf(error), 'error');
      }
    });
  });
}

const TOOL_SOURCE_LABELS = Object.freeze({
  framework: 'Framework',
  system: 'Framework',
  app: 'App',
  'app-mcp': 'App MCP',
  'workspace-mcp': 'Workspace MCP',
  unknown: 'Unknown',
});

const FRAMEWORK_CATEGORY_LABELS = Object.freeze({
  delegation: 'Delegation',
  skill: 'Skills',
  skills: 'Skills',
  memory: 'Memory',
  learning: 'Learning',
});

const TOOL_SOURCE_ORDER = Object.freeze({ framework: 0, app: 1, 'app-mcp': 2, 'workspace-mcp': 3 });

function normalizedToolSource(tool) {
  if (tool?.source === 'system') return 'framework';
  const source = typeof tool?.source === 'string' && tool.source ? tool.source : 'unknown';
  return Object.hasOwn(TOOL_SOURCE_LABELS, source) ? source : 'unknown';
}

function toolMatchesSource(tool) {
  const source = normalizedToolSource(tool);
  if (toolSourceFilter === 'all') return true;
  if (toolSourceFilter === 'builtin') return ['framework', 'app', 'app-mcp'].includes(source);
  if (toolSourceFilter === 'added-mcp') return source === 'workspace-mcp';
  return source === toolSourceFilter;
}

function toolSourceLabel(tool) {
  return TOOL_SOURCE_LABELS[tool?.source] ?? TOOL_SOURCE_LABELS[normalizedToolSource(tool)] ?? 'Unknown';
}

function toolCategoryLabel(tool) {
  return normalizedToolSource(tool) === 'framework'
    ? (FRAMEWORK_CATEGORY_LABELS[tool.category] ?? 'System')
    : '';
}

function searchable(...values) {
  return values.flat().filter(Boolean).join(' ').toLowerCase();
}

function capabilityQuery() {
  return $('capability-search')?.value.trim().toLowerCase() ?? '';
}

function renderToolAgentFilter() {
  const select = $('tool-agent-filter');
  const agents = CrewConfigs.find({ enabled: true }, { sort: { order: 1 } }).fetch();
  if (toolAgentFilter !== 'all' && !agents.some((config) => config.agent === toolAgentFilter)) {
    toolAgentFilter = 'all';
  }
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = 'All agents';
  const options = agents.map((config) => {
    const option = document.createElement('option');
    option.value = config.agent;
    option.textContent = config.displayName;
    return option;
  });
  select.replaceChildren(all, ...options);
  select.value = toolAgentFilter;
}

function agentNames(ids = []) {
  return ids.map((agentId) => {
    const config = CrewConfigs.findOne({ agent: agentId });
    return config?.displayName ?? agentId;
  });
}

function toolAccessLabel(tool, compact = false) {
  const names = agentNames(tool.agents);
  if (!names.length) return compact ? 'None' : 'No access';
  if (!compact || names.length <= 2) return names.join(', ');
  return `${names[0]} +${names.length - 1}`;
}

function toolApprovalLabel(tool, compact = false) {
  if (!compact && typeof tool.approvalSummary === 'string' && tool.approvalSummary.trim()) {
    return tool.approvalSummary.trim();
  }
  if (tool.approval === 'blocked') return 'Blocked';
  if (tool.approval === 'ask') return compact ? 'Ask' : 'Ask each call';
  if (tool.approval === 'conditional') return compact ? 'Conditional' : 'When required';
  if (tool.approval === 'auto') return compact ? 'Auto' : 'Automatic';
  return 'Inherited';
}

function summarizedList(values = [], limit = 2) {
  const items = values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')} +${items.length - limit}`;
}

function frameworkTargetName(tool) {
  if (tool.targetDisplayName) return tool.targetDisplayName;
  return CrewConfigs.findOne({ agent: tool.targetAgent })?.displayName ?? tool.targetAgent ?? '';
}

function toolProvenance(tool) {
  const source = normalizedToolSource(tool);
  const access = toolAccessLabel(tool);
  const availability = typeof tool.availabilityNote === 'string' ? tool.availabilityNote.trim() : '';
  if (source === 'framework') {
    const provider = 'meteor-agent runtime';
    if (tool.category === 'delegation') {
      const target = frameworkTargetName(tool);
      return {
        provider,
        assignment: 'Crew roster',
        why: availability || (target ? `${access} can delegate to ${target}` : `Crew delegation for ${access}`),
      };
    }
    if (['skill', 'skills'].includes(tool.category)) {
      const count = Number(tool.skillCount ?? tool.skillNames?.length ?? 0);
      const list = summarizedList(tool.skillNames);
      return {
        provider,
        assignment: 'Enabled skill assignments',
        why: availability || list || `${count} enabled skill${count === 1 ? '' : 's'} for ${access}`,
      };
    }
    if (tool.category === 'memory') {
      const inherited = CrewConfigs.findOne({ agent: tool.inheritedFrom })?.displayName
        ?? tool.inheritedFrom ?? 'Primary agent';
      const inheritsPrimary = tool.memoryAssignments?.some((assignment) => assignment.access === 'inherited');
      return {
        provider,
        assignment: tool.accessMode === 'root-mission'
          ? `${tool.assignmentSummary || (inheritsPrimary ? `${inherited} memory` : 'Agent memory')} · root missions`
          : 'Agent memory configuration',
        why: availability || `Memory enabled for ${access}`,
      };
    }
    if (tool.category === 'learning') {
      return {
        provider,
        assignment: `${tool.assignmentSummary || access} · Memory Frame`,
        why: availability || `Experience enabled for ${access}`,
      };
    }
    return { provider, assignment: 'Runtime configuration', why: availability || `Enabled for ${access}` };
  }
  if (source === 'app') {
    return {
      provider: 'Application code',
      assignment: 'Crew capability settings',
      why: availability || `Assigned to ${access}`,
    };
  }
  if (!source.endsWith('-mcp')) {
    return {
      provider: 'Unknown source',
      assignment: 'Not reported',
      why: availability || 'Catalog source metadata missing',
    };
  }
  const state = toolStatus(tool);
  const configured = agentNames(tool.assignedAgents);
  const inactiveReason = state.label === 'Blocked' ? 'Blocked by server policy'
    : state.label === 'Disabled' ? 'Server disabled'
      : state.label === 'Not selected' ? 'Not selected for runtime access'
        : state.key === 'unavailable' ? `Server ${state.label.toLowerCase()}` : '';
  return {
    provider: tool.serverName || 'MCP server',
    assignment: 'MCP server access',
    why: availability || inactiveReason || (tool.agents?.length
      ? `Assigned to ${access}`
      : configured.length ? `Configured for ${configured.join(', ')} · no runtime access` : 'No agent assignments'),
  };
}

function renderToolAgents(tool) {
  const mount = $('tool-detail-agent-list');
  mount.replaceChildren();
  const effectiveAgents = tool.agents ?? [];
  const configuredAgents = !effectiveAgents.length && normalizedToolSource(tool).endsWith('-mcp')
    ? (tool.assignedAgents ?? []) : effectiveAgents;
  const configuredOnly = !effectiveAgents.length && configuredAgents.length > 0;
  mount.setAttribute('aria-label', configuredOnly ? 'Configured agent assignments' : 'Agents with access');
  for (const agentId of configuredAgents) {
    const config = CrewConfigs.findOne({ agent: agentId });
    const chip = document.createElement('span');
    chip.className = 'tool-agent-chip';
    const name = document.createElement('strong');
    name.textContent = config?.displayName ?? agentId;
    const role = document.createElement('small');
    const assignedSkills = tool.category === 'skills'
      ? (tool.skillAssignments?.find((item) => item.agent === agentId)?.skills ?? []) : [];
    const assignment = tool.category === 'memory'
      ? tool.memoryAssignments?.find((item) => item.agent === agentId)?.access
      : summarizedList(assignedSkills, 1);
    const assignmentLabel = assignment === 'inherited' ? 'Inherited'
      : assignment === 'configured' ? 'Configured' : assignment;
    role.textContent = [config?.role ?? 'Agent', assignmentLabel, configuredOnly ? 'No runtime access' : '', config && !config.enabled ? 'Disabled' : '']
      .filter(Boolean).join(' · ');
    if (assignedSkills.length) role.title = assignedSkills.join(', ');
    chip.append(name, role);
    mount.append(chip);
  }
  if (!mount.children.length) {
    const empty = document.createElement('span');
    empty.className = 'tool-agent-empty';
    empty.textContent = 'No agent assignments';
    mount.append(empty);
  }
}

function toolStatus(tool) {
  const value = String(tool?.status ?? 'available').toLowerCase();
  if (tool?.approval === 'blocked' || value === 'blocked') return { key: 'disabled', label: 'Blocked' };
  if (value === 'disabled') return { key: 'disabled', label: 'Disabled' };
  if (value === 'conflict') return { key: 'unavailable', label: 'Name conflict' };
  if (value === 'removed') return { key: 'unavailable', label: 'Removed' };
  if (!['ready', 'available', 'registered'].includes(value)) return { key: 'unavailable', label: 'Unavailable' };
  if (normalizedToolSource(tool).endsWith('-mcp') && tool.selected === false) {
    return { key: 'disabled', label: 'Not selected' };
  }
  if (normalizedToolSource(tool).endsWith('-mcp') && !tool.agents?.length) {
    return { key: 'disabled', label: tool.assignedAgents?.length ? 'No access' : 'Unassigned' };
  }
  if (['ready', 'available', 'registered'].includes(value)) return { key: 'ready', label: 'Available' };
  return { key: 'unavailable', label: 'Unavailable' };
}

function renderToolDetail(tool) {
  $('tool-detail-empty').hidden = !!tool;
  $('tool-detail-content').hidden = !tool;
  if (!tool) return;
  const sourceKey = normalizedToolSource(tool);
  const source = toolSourceLabel(tool);
  const status = toolStatus(tool);
  const sourceBadge = $('tool-detail-source');
  sourceBadge.textContent = toolCategoryLabel(tool) ? `${source.toUpperCase()} · ${toolCategoryLabel(tool).toUpperCase()}` : source.toUpperCase();
  sourceBadge.dataset.source = sourceKey;
  $('tool-detail-name').textContent = tool.displayName ?? tool.name;
  $('tool-detail-id').textContent = tool.name;
  $('tool-detail-description').textContent = tool.description || 'No description.';
  $('tool-detail-agents').textContent = toolAccessLabel(tool);
  $('tool-detail-agents').title = agentNames(tool.agents).join(', ')
    || (tool.assignedAgents?.length ? `Configured: ${agentNames(tool.assignedAgents).join(', ')} · no runtime access` : 'No access');
  const approvalLabel = toolApprovalLabel(tool);
  $('tool-detail-approval').textContent = approvalLabel;
  $('tool-detail-approval').title = approvalLabel;
  $('tool-detail-schema').textContent = JSON.stringify(tool.inputSchema ?? tool.schema ?? {}, null, 2);
  $('tool-detail-status').dataset.state = status.key;
  $('tool-detail-status').className = `capability-state ${status.key}`;
  $('tool-detail-status').textContent = status.label;
  const icon = $('tool-detail-icon');
  icon.textContent = sourceKey === 'app' ? '⌘' : sourceKey === 'framework' ? 'F' : sourceKey.endsWith('-mcp') ? 'M' : '?';
  icon.className = `cap-icon ${sourceKey === 'workspace-mcp' ? 'violet' : sourceKey === 'app-mcp' ? 'blue' : sourceKey === 'framework' ? 'green' : 'steel'}`;
  const provenance = toolProvenance(tool);
  $('tool-detail-provider').textContent = provenance.provider;
  $('tool-detail-assignment').textContent = provenance.assignment;
  $('tool-detail-why').textContent = provenance.why;
  renderToolAgents(tool);
  const sourceAction = $('open-tool-source');
  sourceAction.hidden = false;
  sourceAction.disabled = false;
  sourceAction.dataset.serverId = tool.serverId ?? '';
  sourceAction.dataset.action = tool.serverId ? 'server' : sourceKey === 'framework' ? 'crew' : 'code';
  if (tool.serverId) {
    sourceAction.textContent = 'Configure server access';
    sourceAction.setAttribute('aria-label', tool.serverName ? `Configure access for ${tool.serverName}` : 'Configure MCP server access');
  } else if (sourceKey === 'framework') {
    sourceAction.textContent = 'Manage crew access';
    sourceAction.setAttribute('aria-label', 'Manage crew access');
  } else {
    sourceAction.textContent = 'Managed in code';
    sourceAction.disabled = true;
    sourceAction.setAttribute('aria-label', 'This app tool is managed in code');
  }
}

function renderToolCatalog(tools, requestedFocusId = null) {
  const focusedToolId = requestedFocusId
    ?? document.activeElement?.closest?.('.capability-table-row')?.dataset.toolId
    ?? null;
  const query = capabilityQuery();
  const visible = tools.filter((tool) => (
    toolMatchesSource(tool)
    && (toolAgentFilter === 'all' || tool.agents?.includes(toolAgentFilter))
    && (!query || searchable(
      tool.displayName, tool.name, tool.description, tool.serverName, toolSourceLabel(tool),
      toolCategoryLabel(tool), tool.targetDisplayName, tool.skillNames, agentNames(tool.agents),
    ).includes(query))
  ));
  let selected = visible.find((tool) => tool._id === selectedToolId) ?? null;
  if (!selected && visible.length) {
    selected = visible[0];
    if (!tools.some((tool) => tool._id === selectedToolId)) selectedToolId = selected._id;
  }
  const mount = $('tool-catalog-list');
  mount.replaceChildren();
  mount.closest('[role="grid"]')?.setAttribute('aria-rowcount', String(visible.length + 1));
  for (const [index, tool] of visible.entries()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'capability-table-row';
    row.setAttribute('role', 'row');
    row.setAttribute('aria-rowindex', String(index + 2));
    row.dataset.toolId = tool._id;
    const active = tool._id === selected?._id;
    row.dataset.selected = String(active);
    row.setAttribute('aria-selected', String(active));
    row.tabIndex = active ? 0 : -1;
    row.setAttribute('aria-label', `${tool.displayName ?? tool.name}, ${toolSourceLabel(tool)}, ${toolAccessLabel(tool)}, ${toolApprovalLabel(tool)}, ${toolStatus(tool).label}`);
    const identity = document.createElement('span');
    identity.className = 'tool-table-identity';
    identity.setAttribute('role', 'gridcell');
    const name = document.createElement('strong');
    name.textContent = tool.displayName ?? tool.name;
    const id = document.createElement('code');
    id.textContent = tool.name;
    identity.append(name, id);
    const source = document.createElement('span');
    source.className = 'tool-source-cell';
    source.setAttribute('role', 'gridcell');
    const sourceLabel = document.createElement('span');
    sourceLabel.className = 'source-badge';
    sourceLabel.dataset.source = normalizedToolSource(tool);
    sourceLabel.textContent = toolSourceLabel(tool);
    source.append(sourceLabel);
    const category = toolCategoryLabel(tool);
    if (category) {
      const categoryLabel = document.createElement('small');
      categoryLabel.textContent = category;
      source.append(categoryLabel);
    }
    const access = document.createElement('span');
    access.className = 'tool-access-cell';
    access.setAttribute('role', 'gridcell');
    access.textContent = toolAccessLabel(tool, true);
    access.title = agentNames(tool.agents).join(', ')
      || (tool.assignedAgents?.length ? `Configured: ${agentNames(tool.assignedAgents).join(', ')} · no runtime access` : 'No access');
    const approval = document.createElement('span');
    approval.className = 'tool-policy-cell';
    approval.dataset.policy = tool.approval ?? 'inherited';
    approval.setAttribute('role', 'gridcell');
    approval.textContent = toolApprovalLabel(tool, true);
    const status = document.createElement('span');
    status.setAttribute('role', 'gridcell');
    const resolved = toolStatus(tool);
    status.className = `table-state ${resolved.key}`;
    status.textContent = resolved.label;
    row.append(identity, source, access, approval, status);
    row.addEventListener('click', () => {
      selectedToolId = tool._id;
      renderToolCatalog(tools, tool._id);
    });
    row.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? visible.length - 1
          : event.key === 'ArrowUp' ? Math.max(0, index - 1)
            : Math.min(visible.length - 1, index + 1);
      const nextTool = visible[nextIndex];
      if (!nextTool) return;
      selectedToolId = nextTool._id;
      renderToolCatalog(tools, nextTool._id);
    });
    mount.append(row);
  }
  if (!visible.length) mount.append(resourceEmpty(tools.length ? 'No matching tools.' : 'No tools registered.'));
  if (focusedToolId && visible.some((tool) => tool._id === focusedToolId)) {
    requestAnimationFrame(() => [...mount.querySelectorAll('.capability-table-row')]
      .find((candidate) => candidate.dataset.toolId === focusedToolId)?.focus({ preventScroll: true }));
  }
  renderToolDetail(selected ?? null);
}

function renderToolsByAgent(tools) {
  const mount = $('tool-catalog-by-agent');
  const query = capabilityQuery();
  const agents = CrewConfigs.find({ enabled: true }, { sort: { order: 1, displayName: 1 } }).fetch()
    .filter((agent) => toolAgentFilter === 'all' || agent.agent === toolAgentFilter);
  mount.replaceChildren();
  for (const agent of agents) {
    const available = tools.filter((tool) => toolStatus(tool).key === 'ready'
      && tool.agents?.includes(agent.agent)
      && toolMatchesSource(tool)
      && (!query || searchable(
        tool.displayName, tool.name, tool.description, tool.serverName,
        toolSourceLabel(tool), toolCategoryLabel(tool), agent.displayName,
      ).includes(query)));
    if ((query || toolSourceFilter !== 'all') && !available.length) continue;
    const group = document.createElement('section');
    group.className = 'tool-agent-group';
    const header = document.createElement('header');
    const identity = document.createElement('div');
    const avatar = document.createElement('span');
    avatar.className = `crew-form-avatar ${agent.color}`;
    avatar.textContent = agent.avatar;
    avatar.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = agent.displayName;
    const role = document.createElement('small');
    role.textContent = `${agent.role} · ${available.length} available tool${available.length === 1 ? '' : 's'}`;
    copy.append(name, role);
    identity.append(avatar, copy);
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.textContent = 'Manage access';
    manage.addEventListener('click', () => openCrewSettings(agent._id));
    header.append(identity, manage);
    const list = document.createElement('div');
    list.className = 'tool-agent-tool-list';
    for (const tool of available) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tool-agent-tool-row';
      const rowCopy = document.createElement('span');
      const toolName = document.createElement('strong');
      toolName.textContent = tool.displayName ?? tool.name;
      const source = document.createElement('small');
      source.textContent = `${toolSourceLabel(tool)}${toolCategoryLabel(tool) ? ` · ${toolCategoryLabel(tool)}` : ''}`;
      rowCopy.append(toolName, source);
      const approval = document.createElement('span');
      approval.textContent = toolApprovalLabel(tool, true);
      row.append(rowCopy, approval);
      row.addEventListener('click', () => {
        selectedToolId = tool._id;
        toolViewMode = 'tools';
        toolAgentFilter = agent.agent;
        $('tool-agent-filter').value = agent.agent;
        renderCapabilities();
        requestAnimationFrame(() => $('tool-catalog-list').querySelector(`[data-tool-id="${CSS.escape(tool._id)}"]`)?.focus());
      });
      list.append(row);
    }
    if (!available.length) list.append(resourceEmpty('No available tools.'));
    group.append(header, list);
    mount.append(group);
  }
  if (!mount.children.length) mount.append(resourceEmpty('No matching agent access.'));
}

function applySkillCardState(skill, enabled, pending, nodes) {
  const key = pending ? 'updating' : (enabled ? 'enabled' : 'disabled');
  const pendingLabel = enabled ? 'Enabling' : 'Disabling';
  nodes.card.dataset.skillState = key;
  nodes.card.setAttribute('aria-busy', String(pending));
  nodes.state.dataset.state = key;
  nodes.state.textContent = pending ? pendingLabel : (enabled ? 'Enabled' : 'Disabled');
  nodes.checkbox.checked = enabled;
  nodes.checkbox.disabled = pending;
  if (pending) nodes.checkbox.dataset.loading = 'true';
  else delete nodes.checkbox.dataset.loading;
  nodes.checkbox.setAttribute('aria-busy', String(pending));
  const actionLabel = pending ? `${pendingLabel} ${skill.name}` : `${enabled ? 'Disable' : 'Enable'} ${skill.name}`;
  nodes.toggle.title = actionLabel;
  nodes.checkbox.setAttribute('aria-label', actionLabel);
}

async function setSkillEnabled(skill, enabled, nodes) {
  if (pendingSkillStates.has(skill._id)) {
    applySkillCardState(skill, pendingSkillStates.get(skill._id), true, nodes);
    return;
  }
  pendingSkillStates.set(skill._id, enabled);
  skillFocusRestoreId = skill._id;
  applySkillCardState(skill, enabled, true, nodes);
  try {
    await Meteor.callAsync('constellation.skillSave', skill._id, skill.revision, { enabled });
    toast(`${skill.name} ${enabled ? 'enabled' : 'disabled'}.`);
  } catch (error) {
    toast(messageOf(error), 'error');
  } finally {
    pendingSkillStates.delete(skill._id);
    renderCapabilities();
  }
}

function renderSkillCatalog(skills) {
  const query = capabilityQuery();
  const visible = skills.filter((skill) => !query
    || searchable(skill.name, skill.slug, skill.description, agentNames(skill.agents)).includes(query));
  const grid = $('capability-grid');
  const focusedCard = document.activeElement?.closest?.('[data-skill-id]');
  const focusedSkillId = focusedCard?.dataset.skillId ?? null;
  const focusedAction = document.activeElement?.dataset.skillAction ?? null;
  let restoreFocus = null;
  grid.replaceChildren();
  for (const skill of visible) {
    const pending = pendingSkillStates.has(skill._id);
    const enabled = pending ? pendingSkillStates.get(skill._id) : !!skill.enabled;
    const card = document.createElement('article');
    card.className = 'capability-card';
    card.dataset.skillId = skill._id;
    const icon = document.createElement('span');
    icon.className = 'cap-icon amber';
    icon.textContent = '✦';
    const copy = document.createElement('div');
    copy.className = 'capability-card-copy';
    const kicker = document.createElement('div');
    kicker.className = 'skill-card-kicker';
    const type = document.createElement('span');
    type.className = 'cap-type';
    type.textContent = 'SKILL';
    const state = document.createElement('span');
    state.className = 'skill-state';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-atomic', 'true');
    kicker.append(type, state);
    const title = document.createElement('h3');
    title.textContent = skill.name;
    const description = document.createElement('p');
    description.textContent = skill.description;
    copy.append(kicker, title, description);
    const footer = document.createElement('div');
    footer.className = 'capability-card-footer';
    const chips = document.createElement('div');
    chips.className = 'assignment-chips';
    for (const agentId of skill.agents ?? []) {
      const config = CrewConfigs.findOne({ agent: agentId });
      const chip = document.createElement('span');
      chip.className = 'assignment-chip';
      const hasSkillAccess = !!config?.enabled;
      chip.classList.toggle('blocked', !hasSkillAccess);
      chip.textContent = `${config?.displayName ?? agentId}${hasSkillAccess ? '' : ' · agent disabled'}`;
      if (!hasSkillAccess) chip.title = 'Enable this workspace agent to load the assigned skill.';
      chips.append(chip);
    }
    if (!chips.children.length) {
      const chip = document.createElement('span');
      chip.className = 'assignment-chip';
      chip.textContent = 'Unassigned';
      chips.append(chip);
    }
    const actions = document.createElement('div');
    actions.className = 'skill-card-actions';
    const toggle = document.createElement('label');
    toggle.className = 'switch skill-card-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.skillAction = 'toggle';
    const track = document.createElement('span');
    track.setAttribute('aria-hidden', 'true');
    toggle.append(checkbox, track);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'resource-card-action';
    edit.dataset.skillAction = 'edit';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openSkillDialog(skill._id));
    checkbox.addEventListener('change', () => void setSkillEnabled(skill, checkbox.checked, {
      card, state, toggle, checkbox,
    }));
    actions.append(toggle, edit);
    footer.append(chips, actions);
    card.append(icon, copy, footer);
    grid.append(card);
    applySkillCardState(skill, enabled, pending, { card, state, toggle, checkbox });

    const restoreId = skillFocusRestoreId ?? focusedSkillId;
    const restoreAction = skillFocusRestoreId ? 'toggle' : focusedAction;
    if (!pending && skill._id === restoreId) {
      restoreFocus = restoreAction === 'edit' ? edit : checkbox;
    }
  }
  if (!visible.length) grid.append(resourceEmpty(skills.length ? 'No matching skills.' : 'No skills.'));
  if (restoreFocus) {
    requestAnimationFrame(() => {
      if (!restoreFocus.isConnected) return;
      restoreFocus.focus({ preventScroll: true });
      const restoredSkillId = restoreFocus.closest('[data-skill-id]')?.dataset.skillId;
      if (restoreFocus.dataset.skillAction === 'toggle' && skillFocusRestoreId === restoredSkillId) {
        skillFocusRestoreId = null;
      }
    });
  }
}

function setCapabilityTab(tab) {
  const nextTab = ['tools', 'skills', 'mcp'].includes(tab) ? tab : 'tools';
  if (nextTab !== capabilityTab) $('capability-search').value = '';
  capabilityTab = nextTab;
  document.querySelectorAll('[data-capability-tab]').forEach((button) => {
    const active = button.dataset.capabilityTab === capabilityTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-capability-panel]').forEach((panel) => {
    const active = panel.dataset.capabilityPanel === capabilityTab;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  document.querySelectorAll('[data-capability-actions]').forEach((actions) => {
    actions.hidden = actions.dataset.capabilityActions !== capabilityTab;
  });
  document.querySelectorAll('[data-capability-summary]').forEach((summary) => {
    summary.hidden = summary.dataset.capabilitySummary !== capabilityTab;
  });
  $('capability-search').placeholder = capabilityTab === 'tools' ? 'Search tools'
    : capabilityTab === 'skills' ? 'Search skills' : 'Search servers';
  renderCapabilities();
}

function renderCapabilities() {
  const skills = SkillConfigs.find({}, { sort: { name: 1 } }).fetch();
  const tools = ToolCatalog.find({}).fetch().sort((left, right) => {
    const sourceOrder = (TOOL_SOURCE_ORDER[normalizedToolSource(left)] ?? 99)
      - (TOOL_SOURCE_ORDER[normalizedToolSource(right)] ?? 99);
    if (sourceOrder) return sourceOrder;
    return String(left.displayName ?? left.name).localeCompare(String(right.displayName ?? right.name));
  });
  const servers = McpConfigs.find({}, { sort: { managed: 1, name: 1 } }).fetch();
  renderToolAgentFilter();
  $('skill-enabled-count').textContent = String(skills.filter((skill) => skill.enabled).length);
  $('skill-assignment-count').textContent = String(skills.reduce((total, skill) => total + (skill.agents?.length ?? 0), 0));
  $('skill-agent-count').textContent = String(new Set(skills.flatMap((skill) => skill.agents ?? [])).size);
  const effectiveTools = tools.filter((tool) => toolStatus(tool).key === 'ready' && tool.agents?.length);
  $('tool-count').textContent = String(effectiveTools.length);
  $('tool-catalog-count').textContent = String(tools.length);
  $('mcp-server-count').textContent = String(servers.length);
  $('tool-tab-count').textContent = String(tools.length);
  $('skill-tab-count').textContent = String(skills.length);
  $('mcp-tab-count').textContent = String(servers.length);
  const frameworkTools = tools.filter((tool) => normalizedToolSource(tool) === 'framework').length;
  const appTools = tools.filter((tool) => normalizedToolSource(tool) === 'app').length;
  const mcpTools = tools.filter((tool) => normalizedToolSource(tool).endsWith('-mcp')).length;
  const unknownTools = tools.length - frameworkTools - appTools - mcpTools;
  const builtinTools = tools.filter((tool) => ['framework', 'app', 'app-mcp'].includes(normalizedToolSource(tool))).length;
  const addedMcpTools = tools.filter((tool) => normalizedToolSource(tool) === 'workspace-mcp').length;
  $('tool-builtin-count').textContent = String(builtinTools);
  $('tool-added-mcp-count').textContent = String(addedMcpTools);
  $('tool-source-summary').textContent = `${builtinTools} built-in · ${addedMcpTools} added MCP${unknownTools ? ` · ${unknownTools} unknown` : ''}`;
  const mcpStates = servers.map(resolveMcpState);
  $('mcp-ready-count').textContent = String(mcpStates.filter((state) => state.key === 'ready').length);
  $('mcp-attention-count').textContent = String(mcpStates.filter((state) => ['error', 'unavailable', 'incomplete'].includes(state.key)).length);
  const enabledSkills = skills.filter((skill) => skill.enabled).length;
  $('skill-panel-count').textContent = `${enabledSkills} enabled · ${skills.length - enabledSkills} disabled`;
  if (capabilityTab === 'tools') {
    $('tool-catalog-by-tool').hidden = toolViewMode !== 'tools';
    $('tool-catalog-by-agent').hidden = toolViewMode !== 'agents';
    document.querySelectorAll('[data-tool-view]').forEach((button) => {
      const active = button.dataset.toolView === toolViewMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (toolViewMode === 'tools') renderToolCatalog(tools);
    else renderToolsByAgent(tools);
  }
  if (capabilityTab === 'skills') renderSkillCatalog(skills);
  if (capabilityTab === 'mcp') renderMcpServers(servers, tools);
  const missionTitle = missionConfig()?.title || AgentSessions.findOne(currentSessionId)?.title || 'current mission';
  $('skill-demo').textContent = `Try skills in “${concise(missionTitle, 28)}”`;
}

function populateSkillAgents(skill) {
  const mount = $('skill-agent-options');
  mount.replaceChildren();
  const selected = new Set(skill?.agents ?? []);
  for (const agent of CrewConfigs.find({}, { sort: { order: 1 } }).fetch()) {
    const label = document.createElement('label');
    label.className = 'assignment-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = agent.agent;
    input.checked = selected.has(agent.agent);
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = agent.displayName;
    const role = document.createElement('small');
    role.textContent = `${agent.role}${agent.enabled ? '' : ' · Disabled'}`;
    copy.append(name, role);
    label.append(input, copy);
    mount.append(label);
  }
}

function openSkillDialog(id = null) {
  selectedSkillId = id;
  const skill = id ? SkillConfigs.findOne(id) : null;
  editingSkillRevision = skill?.revision ?? null;
  $('skill-dialog-title').textContent = skill ? 'Edit skill' : 'New skill';
  $('skill-dialog-id').textContent = skill?.slug ?? '';
  $('skill-name').value = skill?.name ?? '';
  $('skill-description').value = skill?.description ?? '';
  $('skill-instructions').value = skill?.content ?? '';
  $('skill-enabled').checked = skill?.enabled ?? true;
  $('skill-enabled').defaultChecked = $('skill-enabled').checked;
  updateSkillEditorState(false);
  setSkillFormStatus();
  $('delete-skill').hidden = !skill;
  populateSkillAgents(skill);
  beginGuardedEditor('skill-form', { cleanLabel: skill ? 'Saved' : 'Not saved' });
  $('skill-dialog').showModal();
  requestAnimationFrame(() => $('skill-name').focus());
}

function updateSkillEditorState(dirty = $('skill-enabled').checked !== $('skill-enabled').defaultChecked) {
  const enabled = $('skill-enabled').checked;
  $('skill-editor-toggle').dataset.skillState = enabled ? 'enabled' : 'disabled';
  $('skill-enabled-label').textContent = enabled ? 'Enabled' : 'Disabled';
  $('skill-enabled-hint').textContent = dirty
    ? `Will ${enabled ? 'enable' : 'disable'} when saved`
    : (enabled ? 'Available to assigned agents' : 'Unavailable · assignments kept');
}

function setSkillFormStatus(message = '', tone = '') {
  const status = $('skill-form-status');
  status.textContent = message;
  status.title = message;
  status.classList.toggle('error', tone === 'error');
  status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
}

function skillFormPatch() {
  return {
    name: $('skill-name').value,
    description: $('skill-description').value,
    content: $('skill-instructions').value,
    enabled: $('skill-enabled').checked,
    agents: [...$('skill-agent-options').querySelectorAll('input:checked')].map((input) => input.value),
  };
}

function wireSkills() {
  registerGuardedEditor({
    formId: 'skill-form', dialogId: 'skill-dialog', statusId: 'skill-form-status',
    closeId: 'close-skill-dialog', cancelId: 'cancel-skill-edit',
    label: 'this skill', read: skillFormPatch,
  });
  $('add-skill').addEventListener('click', () => openSkillDialog());
  $('skill-enabled').addEventListener('change', () => updateSkillEditorState());
  $('skill-demo').addEventListener('click', (event) => {
    void withControlBusy(event.currentTarget, 'Starting', () => sendPrompt('Choose and load the best available skill for framing this mission, then apply it.'));
  });
  document.querySelectorAll('[data-capability-tab]').forEach((button) => {
    button.addEventListener('click', () => setCapabilityTab(button.dataset.capabilityTab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[data-capability-tab]')];
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(tabs.indexOf(button) + offset + tabs.length) % tabs.length];
      setCapabilityTab(next.dataset.capabilityTab);
      next.focus();
    });
  });
  $('capability-search').addEventListener('input', renderCapabilities);
  $('capability-search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.currentTarget.value = '';
      renderCapabilities();
    }
  });
  $('tool-source-filter').addEventListener('change', (event) => {
    toolSourceFilter = event.currentTarget.value;
    renderCapabilities();
  });
  $('tool-agent-filter').addEventListener('change', (event) => {
    toolAgentFilter = event.currentTarget.value;
    renderCapabilities();
  });
  document.querySelectorAll('[data-tool-view]').forEach((button) => button.addEventListener('click', () => {
    toolViewMode = button.dataset.toolView;
    renderCapabilities();
  }));
  $('clear-tool-filters').addEventListener('click', () => {
    toolSourceFilter = 'all';
    toolAgentFilter = 'all';
    $('tool-source-filter').value = 'all';
    $('tool-agent-filter').value = 'all';
    $('capability-search').value = '';
    renderCapabilities();
    $('capability-search').focus();
  });
  $('copy-tool-schema').addEventListener('click', (event) => {
    void withControlBusy(event.currentTarget, 'Copying', () => copyText($('tool-detail-schema').textContent, 'Schema copied.'));
  });
  $('open-tool-source').addEventListener('click', (event) => {
    if (event.currentTarget.dataset.action === 'crew') {
      openCrewSettings();
      return;
    }
    const serverId = event.currentTarget.dataset.serverId;
    if (!serverId) return;
    selectedMcpId = serverId;
    mcpDetailTab = 'overview';
    $('capability-search').value = '';
    setCapabilityTab('mcp');
    requestAnimationFrame(() => [...$('mcp-server-list').querySelectorAll('.mcp-server-row')]
      .find((row) => row.dataset.serverId === serverId)?.focus());
  });
  $('skill-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.submitter ?? event.currentTarget.querySelector('[type="submit"]');
    const patch = skillFormPatch();
    setSkillFormStatus('Saving…');
    await withControlBusy(submit, 'Saving', async () => {
      try {
        if (selectedSkillId) {
          await Meteor.callAsync('constellation.skillSave', selectedSkillId, editingSkillRevision, patch);
        } else {
          await Meteor.callAsync('constellation.skillCreate', patch);
        }
        $('skill-dialog').close();
        toast('Skill saved.');
      } catch (error) {
        const message = messageOf(error);
        setSkillFormStatus(`Not saved · ${message}`, 'error');
        toast(message, 'error');
      }
    });
  });
  $('delete-skill').addEventListener('click', async (event) => {
    const skill = selectedSkillId && SkillConfigs.findOne(selectedSkillId);
    if (!skill || !window.confirm(`Delete ${skill.name}?`)) return;
    await withControlBusy(event.currentTarget, 'Deleting', async () => {
      try {
        await Meteor.callAsync('constellation.skillRemove', skill._id, editingSkillRevision ?? skill.revision);
        $('skill-dialog').close();
        toast('Skill deleted.');
      } catch (error) {
        const message = messageOf(error);
        setSkillFormStatus(`Not deleted · ${message}`, 'error');
        toast(message, 'error');
      }
    });
  });
}

function resolveMcpState(server) {
  const state = String(server?.status ?? (server?.enabled ? 'not-tested' : 'disabled')).toLowerCase();
  if (state === 'blocked') return { key: 'disabled', label: 'Blocked' };
  if (state === 'untrusted') return { key: 'incomplete', label: 'Trust required' };
  if (state === 'locked') return { key: 'unavailable', label: 'Locked' };
  const labels = {
    ready: 'Ready',
    connecting: 'Connecting',
    cooldown: 'Cooling down',
    disabled: 'Disabled',
    incomplete: 'Incomplete',
    unavailable: 'Unavailable',
    error: 'Error',
    configured: 'Not tested',
    'not-tested': 'Not tested',
  };
  return { key: labels[state] ? state : 'unavailable', label: labels[state] ?? 'Unavailable' };
}

function setMcpStatus(node, state, label) {
  if (!node) return;
  node.dataset.mcpState = state;
  const copy = node.querySelector('span:last-child');
  if (copy) copy.textContent = label;
  else node.textContent = label;
}

function toolsForServer(serverId, tools = ToolCatalog.find().fetch()) {
  return tools.filter((tool) => tool.serverId === serverId);
}

function renderMcpHealth(servers) {
  const states = servers.map((server) => resolveMcpState(server).key);
  const node = $('mcp-health-summary');
  if (!states.length) setMcpStatus(node, 'not-tested', 'No servers');
  else if (states.some((state) => ['error', 'unavailable', 'locked', 'incomplete'].includes(state))) {
    setMcpStatus(node, 'unavailable', 'Needs attention');
  } else if (states.some((state) => state === 'connecting')) setMcpStatus(node, 'connecting', 'Connecting');
  else if (states.some((state) => state === 'cooldown')) setMcpStatus(node, 'cooldown', 'Cooling down');
  else if (states.some((state) => state === 'ready')) {
    setMcpStatus(node, 'ready', `${states.filter((state) => state === 'ready').length} ready`);
  } else if (states.every((state) => state === 'disabled')) setMcpStatus(node, 'disabled', 'Disabled');
  else setMcpStatus(node, 'not-tested', 'Not tested');
}

function renderMcpDetail(server, tools) {
  $('mcp-detail-empty').hidden = !!server;
  $('mcp-detail-content').hidden = !server;
  if (!server) return;
  const state = resolveMcpState(server);
  const sourceBadge = $('mcp-detail-content').querySelector('.mcp-detail-header .source-badge');
  sourceBadge.textContent = server.managed === 'app' ? 'APP MCP' : 'WORKSPACE MCP';
  $('mcp-detail-name').textContent = server.name;
  $('mcp-detail-id').textContent = server.managed === 'app' ? 'Built-in server' : 'Added server';
  setMcpStatus($('mcp-detail-status'), state.key, state.label);
  $('mcp-detail-tool-count').textContent = String(tools.length);
  $('mcp-detail-agent-count').textContent = String(server.agents?.length ?? 0);
  $('mcp-detail-last-checked').textContent = server.lastTestedAt ? relativeTime(server.lastTestedAt) : 'Never';
  $('mcp-detail-command').textContent = server.locked ? 'Managed by app' : server.command || 'Not configured';
  $('mcp-detail-approval').textContent = server.approval === 'blocked' ? 'Blocked' : 'Ask each call';
  $('mcp-detail-diagnostics').textContent = server.lastErrorCode
    ? `${state.label}\n${server.lastErrorCode}` : `${state.label}\nNo errors recorded.`;
  $('edit-mcp-server').hidden = !!server.locked;
  $('test-mcp-server').disabled = !server._id;

  const agentMount = $('mcp-detail-agent-list');
  agentMount.replaceChildren();
  for (const name of agentNames(server.agents)) {
    const chip = document.createElement('span');
    chip.className = 'assignment-chip';
    chip.textContent = name;
    agentMount.append(chip);
  }
  if (!agentMount.children.length) {
    const chip = document.createElement('span');
    chip.className = 'assignment-chip';
    chip.textContent = 'Unassigned';
    agentMount.append(chip);
  }

  const toolMount = $('mcp-detail-tool-list');
  toolMount.replaceChildren();
  for (const tool of tools) {
    const row = document.createElement('div');
    row.className = 'derived-tool-row';
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = tool.displayName ?? tool.remoteName ?? tool.name;
    const alias = document.createElement('code');
    alias.textContent = tool.name;
    copy.append(name, alias);
    const status = document.createElement('span');
    const resolved = toolStatus(tool);
    status.className = `table-state ${resolved.key}`;
    status.textContent = resolved.label;
    row.append(copy, status);
    toolMount.append(row);
  }
  if (!tools.length) toolMount.append(resourceEmpty('No tools discovered.'));

  document.querySelectorAll('[data-mcp-detail-panel]').forEach((panel) => {
    const active = panel.dataset.mcpDetailPanel === mcpDetailTab;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  document.querySelectorAll('[data-mcp-detail-tab]').forEach((button) => {
    const active = button.dataset.mcpDetailTab === mcpDetailTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
}

function renderMcpServers(servers, allTools) {
  const focusedServerId = document.activeElement?.closest?.('.mcp-server-row')?.dataset.serverId ?? null;
  const query = capabilityQuery();
  const visible = servers.filter((server) => !query || searchable(
    server.name, server.command, server.status, server.managed,
    toolsForServer(server._id, allTools).map((tool) => [tool.name, tool.displayName, tool.description]),
  ).includes(query));
  renderMcpHealth(servers);
  const mount = $('mcp-server-list');
  mount.replaceChildren();
  for (const server of visible) {
    const serverTools = toolsForServer(server._id, allTools);
    const state = resolveMcpState(server);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mcp-server-row';
    row.dataset.serverId = server._id;
    row.setAttribute('aria-pressed', String(server._id === selectedMcpId));
    row.dataset.selected = String(server._id === selectedMcpId);
    const identity = document.createElement('span');
    identity.className = 'mcp-server-identity';
    const name = document.createElement('strong');
    name.textContent = server.name;
    const detail = document.createElement('small');
    detail.textContent = server.managed === 'app' ? 'App managed' : 'Workspace';
    identity.append(name, detail);
    const count = document.createElement('span');
    count.className = 'mcp-server-tool-count';
    count.textContent = String(serverTools.length || server.catalogCount || 0);
    const status = document.createElement('span');
    status.className = 'mcp-status compact';
    status.dataset.mcpState = state.key;
    const light = document.createElement('i');
    light.setAttribute('aria-hidden', 'true');
    const statusCopy = document.createElement('span');
    statusCopy.textContent = state.label;
    status.append(light, statusCopy);
    row.append(identity, count, status);
    row.addEventListener('click', () => {
      selectedMcpId = server._id;
      renderMcpServers(servers, allTools);
      requestAnimationFrame(() => mount.querySelector(`[data-server-id="${CSS.escape(server._id)}"]`)?.focus({ preventScroll: true }));
    });
    mount.append(row);
  }
  if (!visible.length) mount.append(resourceEmpty(servers.length ? 'No matching servers.' : 'No MCP servers.'));
  let selected = visible.find((server) => server._id === selectedMcpId);
  if (!selected && visible.length) {
    selected = visible[0];
    selectedMcpId = selected._id;
    mount.firstElementChild?.setAttribute('aria-pressed', 'true');
    if (mount.firstElementChild) mount.firstElementChild.dataset.selected = 'true';
  }
  renderMcpDetail(selected ?? null, selected ? toolsForServer(selected._id, allTools) : []);
  if (focusedServerId && visible.some((server) => server._id === focusedServerId)) {
    requestAnimationFrame(() => mount.querySelector(`[data-server-id="${CSS.escape(focusedServerId)}"]`)?.focus({ preventScroll: true }));
  }
}

function addMcpArgRow(value = '') {
  const row = $('mcp-arg-row-template').content.firstElementChild.cloneNode(true);
  row.querySelector('[name="mcpArg"]').value = value;
  row.querySelector('[data-remove-mcp-arg]').addEventListener('click', () => {
    row.remove();
    updateGuardedEditor('mcp-form');
  });
  $('mcp-args-rows').append(row);
  return row;
}

function addMcpEnvRow(key = '', stored = false) {
  const row = $('mcp-env-row-template').content.firstElementChild.cloneNode(true);
  const keyInput = row.querySelector('[name="mcpEnvKey"]');
  const valueInput = row.querySelector('[name="mcpEnvValue"]');
  keyInput.value = key;
  row.dataset.originalKey = stored ? key : '';
  if (stored) valueInput.placeholder = 'Stored · blank keeps value';
  row.querySelector('[data-remove-mcp-env]').addEventListener('click', () => {
    if (row.dataset.originalKey) removedMcpEnvKeys.add(row.dataset.originalKey);
    row.remove();
    updateGuardedEditor('mcp-form');
  });
  $('mcp-env-rows').append(row);
  return row;
}

function populateMcpAgents(server) {
  const selected = new Set(server?.agents ?? []);
  const mount = $('mcp-agent-options');
  mount.replaceChildren();
  for (const agent of CrewConfigs.find({}, { sort: { order: 1, displayName: 1 } }).fetch()) {
    const label = document.createElement('label');
    label.className = 'assignment-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = agent.agent;
    input.checked = selected.has(agent.agent);
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = agent.displayName;
    const role = document.createElement('small');
    role.textContent = `${agent.role}${agent.enabled ? '' : ' · Disabled'}`;
    copy.append(name, role);
    label.append(input, copy);
    mount.append(label);
  }
}

function renderMcpToolOptions(server, discovered = null, selectedTools = null) {
  const existing = discovered ?? (server?._id ? toolsForServer(server._id) : []);
  const selected = new Set(selectedTools ?? server?.selectedTools ?? []);
  const all = $('mcp-tool-access').value === 'all';
  const mount = $('mcp-tool-options');
  mount.replaceChildren();
  for (const tool of existing) {
    const row = $('mcp-tool-row-template').content.firstElementChild.cloneNode(true);
    const remoteName = tool.remoteName ?? tool.name;
    const input = row.querySelector('input');
    input.value = remoteName;
    input.checked = all || selected.has(remoteName);
    input.disabled = all;
    row.querySelector('[data-mcp-tool-name]').textContent = remoteName;
    row.querySelector('[data-mcp-tool-description]').textContent = tool.description || 'No description.';
    const statusNode = row.querySelector('[data-mcp-tool-status]');
    const status = toolStatus(tool);
    statusNode.dataset.state = status.key;
    statusNode.textContent = status.label;
    mount.append(row);
  }
  if (!existing.length) mount.append(resourceEmpty('Test this server to discover tools.'));
  $('mcp-discovery-count').textContent = String(existing.length);
}

function updateMcpPrimaryAction() {
  const submit = $('mcp-submit');
  if (!editingMcpId) {
    submit.textContent = 'Save & test';
    submit.dataset.loadingLabel = 'Saving & testing';
    return;
  }
  const enabling = $('mcp-enabled').checked && editingMcpPersistedEnabled === false;
  submit.textContent = enabling ? 'Enable server' : 'Save server';
  submit.dataset.loadingLabel = enabling ? 'Enabling' : 'Saving';
}

function updateMcpTrustRequirement() {
  // A new server must be trusted because its first save immediately runs discovery.
  $('mcp-trust-local').required = !editingMcpId || $('mcp-enabled').checked;
}

function clearMcpToolSelectionError() {
  const error = $('mcp-form').querySelector(
    ':scope > .form-inline-error[data-error-code="mcp-no-selected-tools"]',
  );
  error?.remove();
  $('mcp-tool-access').removeAttribute('aria-invalid');
  $('mcp-tool-options').removeAttribute('aria-describedby');
}

function showMcpToolSelectionError() {
  const firstTool = $('mcp-tool-options').querySelector('input:not(:disabled)');
  showFormError(
    'mcp-form',
    { reason: 'Choose at least one discovered tool before enabling this server.' },
    {
      actionLabel: firstTool ? 'Choose a tool' : 'Go to test',
      action: () => {
        const target = firstTool ?? $('mcp-test-discover');
        target.scrollIntoView({ block: 'nearest' });
        target.focus();
      },
    },
  );
  const error = $('mcp-form').querySelector(':scope > .form-inline-error');
  if (error) {
    error.id = 'mcp-tool-selection-error';
    error.dataset.errorCode = 'mcp-no-selected-tools';
    $('mcp-tool-access').setAttribute('aria-invalid', 'true');
    $('mcp-tool-options').setAttribute('aria-describedby', error.id);
  }
}

function mcpPatchNeedsToolSelection(patch) {
  return patch.enabled && patch.toolMode === 'selected' && patch.selectedTools.length === 0;
}

function updateMcpEditorState(server) {
  const state = resolveMcpState(server);
  setMcpStatus($('mcp-dialog-runtime-status'), state.key, state.label);
  setMcpStatus($('mcp-discovery-status'), state.key, state.label);
  $('mcp-last-checked').textContent = server?.lastTestedAt ? relativeTime(server.lastTestedAt) : 'Never';
  $('mcp-last-error').textContent = server?.lastErrorCode || 'None';
  $('mcp-diagnostic-log').textContent = server?.lastErrorCode
    ? `${state.label}\n${server.lastErrorCode}` : `${state.label}\nNo errors recorded.`;
}

function openMcpDialog(id = null) {
  clearMcpToolSelectionError();
  clearFormError('mcp-form');
  const server = id ? McpConfigs.findOne(id) : null;
  if (id && !server) {
    editingMcpId = null;
    editingMcpRevision = null;
    editingMcpPersistedEnabled = null;
    editingMcpDiscoveredTools = null;
    editingMcpSelectedTools = new Set();
    if ($('mcp-dialog').open) $('mcp-dialog').close();
    toast('MCP server no longer exists.', 'error');
    return;
  }
  if (server?.locked) {
    if ($('mcp-dialog').open) $('mcp-dialog').close();
    toast('This MCP server is managed by the app.', 'error');
    return;
  }
  editingMcpId = id;
  editingMcpRevision = server?.revision ?? null;
  editingMcpPersistedEnabled = server?.enabled ?? null;
  editingMcpDiscoveredTools = null;
  editingMcpSelectedTools = new Set(server?.selectedTools ?? []);
  removedMcpEnvKeys = new Set();
  $('mcp-dialog-title').textContent = server ? 'Configure MCP server' : 'Add MCP server';
  $('mcp-dialog-id').textContent = server ? 'Workspace server' : 'New workspace server';
  $('mcp-name').value = server?.name ?? '';
  $('mcp-server-id').value = server?._id ?? '';
  $('mcp-command').value = server?.command ?? '';
  $('mcp-timeout-ms').value = String(server?.timeoutMs ?? 15_000);
  $('mcp-cooldown-ms').value = String(server?.cooldownMs ?? 30_000);
  $('mcp-form').querySelector('.mcp-advanced').open = !!(server?.args?.length || server?.envKeys?.length
    || (server?.timeoutMs && server.timeoutMs !== 15_000) || (server?.cooldownMs && server.cooldownMs !== 30_000));
  $('mcp-enabled').checked = server?.enabled ?? false;
  $('mcp-trust-local').checked = server?.trusted ?? false;
  updateMcpTrustRequirement();
  $('mcp-tool-access').value = server?.toolMode ?? 'selected';
  $('mcp-approval').value = server?.approval ?? 'ask';
  $('mcp-args-rows').replaceChildren();
  for (const argument of server?.args ?? []) addMcpArgRow(argument);
  $('mcp-env-rows').replaceChildren();
  for (const key of server?.envKeys ?? []) addMcpEnvRow(key, true);
  populateMcpAgents(server);
  renderMcpToolOptions(server, null, editingMcpSelectedTools);
  updateMcpEditorState(server);
  $('delete-mcp-server').hidden = !server;
  $('mcp-test-discover').disabled = !server;
  updateMcpPrimaryAction();
  beginGuardedEditor('mcp-form', { cleanLabel: server ? 'Saved' : 'Not saved' });
  if (!$('mcp-dialog').open) $('mcp-dialog').showModal();
  requestAnimationFrame(() => $('mcp-name').focus());
}

function mcpFormPatch() {
  const env = {};
  for (const row of $('mcp-env-rows').querySelectorAll('[data-mcp-env-row]')) {
    const key = row.querySelector('[name="mcpEnvKey"]').value.trim();
    const value = row.querySelector('[name="mcpEnvValue"]').value;
    if (key && value) env[key] = value;
  }
  const removeEnv = [...removedMcpEnvKeys].filter((key) => !(key in env));
  const toolMode = $('mcp-tool-access').value;
  if (toolMode === 'selected') {
    editingMcpSelectedTools = new Set(
      [...$('mcp-tool-options').querySelectorAll('input:checked')].map((input) => input.value),
    );
  }
  return {
    name: $('mcp-name').value,
    enabled: $('mcp-enabled').checked,
    trusted: $('mcp-trust-local').checked,
    command: $('mcp-command').value,
    args: [...$('mcp-args-rows').querySelectorAll('[name="mcpArg"]')]
      .map((input) => input.value).filter((value) => value.length),
    env,
    removeEnv,
    agents: [...$('mcp-agent-options').querySelectorAll('input:checked')].map((input) => input.value),
    toolMode,
    selectedTools: [...editingMcpSelectedTools],
    approval: $('mcp-approval').value,
    timeoutMs: Number($('mcp-timeout-ms').value || 15_000),
    cooldownMs: Number($('mcp-cooldown-ms').value || 30_000),
  };
}

function adoptCreatedMcpServer(saved, requestedEnabled) {
  editingMcpId = saved._id;
  editingMcpRevision = saved.revision;
  editingMcpPersistedEnabled = !!saved.enabled;
  editingMcpDiscoveredTools = [];
  editingMcpSelectedTools = new Set(saved.selectedTools ?? []);
  selectedMcpId = saved._id;
  $('mcp-dialog-title').textContent = 'Configure MCP server';
  $('mcp-dialog-id').textContent = 'Workspace server';
  $('mcp-server-id').value = saved._id;
  $('delete-mcp-server').hidden = false;
  $('mcp-test-discover').disabled = false;
  $('mcp-enabled').checked = !!saved.enabled;
  renderMcpToolOptions(saved, editingMcpDiscoveredTools, editingMcpSelectedTools);
  updateMcpEditorState(saved);
  updateMcpTrustRequirement();
  updateMcpPrimaryAction();
  beginGuardedEditor('mcp-form', { cleanLabel: 'Saved' });

  // Keep the user's enable intent as the next explicit step after discovery.
  $('mcp-enabled').checked = requestedEnabled;
  updateMcpTrustRequirement();
  updateMcpPrimaryAction();
  updateGuardedEditor('mcp-form');
}

async function performMcpTest(id, { inlineFailure = false } = {}) {
  try {
    const result = await Meteor.callAsync('constellation.mcpTest', id);
    if ($('mcp-dialog').open && editingMcpId === id) {
      editingMcpDiscoveredTools = result.tools ?? [];
      const server = McpConfigs.findOne(id) ?? { _id: id, selectedTools: [] };
      renderMcpToolOptions(server, editingMcpDiscoveredTools, editingMcpSelectedTools);
      const state = result.ok ? 'ready' : 'error';
      const label = result.ok ? 'Ready' : 'Unavailable';
      setMcpStatus($('mcp-dialog-runtime-status'), state, label);
      setMcpStatus($('mcp-discovery-status'), state, label);
      $('mcp-last-checked').textContent = 'Just now';
      $('mcp-last-error').textContent = result.ok ? 'None' : (result.reason ?? 'Connection failed');
      $('mcp-diagnostic-log').textContent = result.ok
        ? `${result.tools?.length ?? 0} tools discovered.`
        : (result.reason ?? 'Connection failed.');
      updateGuardedEditor('mcp-form');
      if (inlineFailure && !result.ok) showFormError('mcp-form', { reason: result.reason ?? 'Server unavailable.' });
    }
    toast(
      result.ok ? `${result.tools?.length ?? 0} tools discovered.` : (result.reason ?? 'Server unavailable.'),
      result.ok ? 'success' : 'error',
    );
    return result;
  } catch (error) {
    if ($('mcp-dialog').open && editingMcpId === id) {
      setMcpStatus($('mcp-dialog-runtime-status'), 'error', 'Unavailable');
      setMcpStatus($('mcp-discovery-status'), 'error', 'Unavailable');
      $('mcp-last-checked').textContent = 'Just now';
      $('mcp-last-error').textContent = messageOf(error);
      $('mcp-diagnostic-log').textContent = messageOf(error);
      if (inlineFailure) showFormError('mcp-form', error);
    }
    toast(messageOf(error), 'error');
    return { ok: false, status: 'error', tools: [], reason: messageOf(error) };
  }
}

async function testMcpServer(id, control) {
  if (!id) {
    toast('Save the server before testing.', 'error');
    return null;
  }
  clearMcpToolSelectionError();
  clearFormError('mcp-form');
  return withControlBusy(control, 'Testing', () => performMcpTest(id, { inlineFailure: true }));
}

function wireMcpServers() {
  registerGuardedEditor({
    formId: 'mcp-form', dialogId: 'mcp-dialog', statusId: 'mcp-form-status',
    closeId: 'close-mcp-dialog', cancelId: 'cancel-mcp-edit',
    label: 'this MCP server', read: mcpFormPatch,
  });
  const close = () => {
    $('mcp-dialog').close();
    editingMcpId = null;
    editingMcpRevision = null;
    editingMcpPersistedEnabled = null;
    editingMcpDiscoveredTools = null;
    editingMcpSelectedTools = new Set();
    removedMcpEnvKeys = new Set();
  };
  $('add-mcp-server').addEventListener('click', () => openMcpDialog());
  $('mcp-dialog').addEventListener('close', () => {
    editingMcpId = null;
    editingMcpRevision = null;
    editingMcpPersistedEnabled = null;
    editingMcpDiscoveredTools = null;
    editingMcpSelectedTools = new Set();
    removedMcpEnvKeys = new Set();
  });
  $('add-mcp-arg').addEventListener('click', () => {
    addMcpArgRow().querySelector('input').focus();
    updateGuardedEditor('mcp-form');
  });
  $('add-mcp-env').addEventListener('click', () => {
    addMcpEnvRow().querySelector('input').focus();
    updateGuardedEditor('mcp-form');
  });
  $('mcp-enabled').addEventListener('change', () => {
    updateMcpTrustRequirement();
    updateMcpPrimaryAction();
    if (!$('mcp-enabled').checked) clearMcpToolSelectionError();
  });
  $('mcp-tool-access').addEventListener('change', () => {
    renderMcpToolOptions(
      editingMcpId ? McpConfigs.findOne(editingMcpId) : null,
      editingMcpDiscoveredTools,
      editingMcpSelectedTools,
    );
    if ($('mcp-tool-access').value === 'all') clearMcpToolSelectionError();
  });
  $('mcp-tool-options').addEventListener('change', (event) => {
    if (!event.target.matches('input[type="checkbox"]')
      || $('mcp-tool-access').value !== 'selected') return;
    editingMcpSelectedTools = new Set(
      [...$('mcp-tool-options').querySelectorAll('input:checked')].map((input) => input.value),
    );
    if (editingMcpSelectedTools.size) clearMcpToolSelectionError();
  });
  const activateMcpDetailTab = (button, focus = false) => {
    mcpDetailTab = button.dataset.mcpDetailTab;
    renderCapabilities();
    if (focus) button.focus();
  };
  document.querySelectorAll('[data-mcp-detail-tab]').forEach((button) => {
    button.addEventListener('click', () => activateMcpDetailTab(button));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[data-mcp-detail-tab]')];
      const current = tabs.indexOf(button);
      const next = event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs.at(-1)
          : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      activateMcpDetailTab(next, true);
    });
  });
  $('edit-mcp-server').addEventListener('click', () => {
    if (selectedMcpId) openMcpDialog(selectedMcpId);
  });
  $('test-mcp-server').addEventListener('click', (event) => void testMcpServer(selectedMcpId, event.currentTarget));
  $('mcp-test-discover').addEventListener('click', (event) => void testMcpServer(editingMcpId, event.currentTarget));
  $('refresh-mcp-servers').addEventListener('click', (event) => {
    void withControlBusy(event.currentTarget, 'Checking', async () => {
      const servers = McpConfigs.find({ enabled: true }).fetch();
      if (!servers.length) {
        toast('No enabled MCP servers.');
        return;
      }
      let ready = 0;
      for (const server of servers) {
        try {
          const result = await Meteor.callAsync('constellation.mcpTest', server._id);
          if (result.ok) ready += 1;
        } catch { /* Each server stores its sanitized failure state. */ }
      }
      toast(`${ready}/${servers.length} servers ready.`, ready === servers.length ? 'success' : 'error');
    });
  });
  $('mcp-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMcpToolSelectionError();
    clearFormError(event.currentTarget);
    const serverId = editingMcpId;
    const expectedRevision = editingMcpRevision;
    const patch = mcpFormPatch();
    if (serverId && mcpPatchNeedsToolSelection(patch)) {
      showMcpToolSelectionError();
      return;
    }
    const creating = !serverId;
    const submit = event.submitter ?? $('mcp-submit');
    await withControlBusy(submit, creating ? 'Saving & testing' : submit.dataset.loadingLabel, async () => {
      try {
        if (creating) {
          const requestedEnabled = patch.enabled;
          const saved = await Meteor.callAsync(
            'constellation.mcpCreate', { ...patch, enabled: false },
          );
          adoptCreatedMcpServer(saved, requestedEnabled);
          setCapabilityTab('mcp');
          const result = await performMcpTest(saved._id, { inlineFailure: true });
          if (result.ok && mcpPatchNeedsToolSelection(mcpFormPatch())) {
            showMcpToolSelectionError();
          }
          return;
        }
        const saved = await Meteor.callAsync(
          'constellation.mcpSave', serverId, expectedRevision, patch,
        );
        selectedMcpId = saved._id;
        close();
        setCapabilityTab('mcp');
        toast(saved.enabled ? 'MCP server enabled.' : 'MCP server saved.');
      } catch (error) {
        showFormError('mcp-form', error, staleReloadOptions(error, () => openMcpDialog(serverId)));
        toast(messageOf(error), 'error');
      }
    });
    if ($('mcp-dialog').open) {
      updateMcpPrimaryAction();
      updateGuardedEditor('mcp-form');
    }
  });
  $('delete-mcp-server').addEventListener('click', async (event) => {
    const serverId = editingMcpId;
    const expectedRevision = editingMcpRevision;
    const server = serverId && McpConfigs.findOne(serverId);
    if (!serverId || server?.locked || !window.confirm(`Delete ${$('mcp-name').value || 'this MCP server'}?`)) return;
    await withControlBusy(event.currentTarget, 'Deleting', async () => {
      try {
        await Meteor.callAsync('constellation.mcpRemove', serverId, expectedRevision);
        if (selectedMcpId === serverId) selectedMcpId = null;
        close();
        toast('MCP server deleted.');
      } catch (error) {
        showFormError('mcp-form', error, staleReloadOptions(error, () => openMcpDialog(serverId)));
        toast(messageOf(error), 'error');
      }
    });
  });
}

const CHANNEL_ICONS = {
  slack: ['S', 'slack'], telegram: ['T', 'telegram'], whatsapp: ['W', 'whatsapp'],
  sms: ['••', 'sms'], email: ['@', 'mail'],
};

function webhookUrl(kind) {
  return `${window.location.origin}/agent/channels/${kind}`;
}

function renderChannels() {
  const configs = ChannelConfigs.find({}, { sort: { kind: 1 } }).fetch();
  $('channel-active-count').textContent = String(1 + configs.filter((row) => row.status === 'active').length);
  $('channel-incomplete-count').textContent = String(configs.filter((row) => ['incomplete', 'locked', 'error'].includes(row.status)).length);
  $('channel-disabled-count').textContent = String(configs.filter((row) => row.status === 'disabled').length);
  const mount = $('channel-list');
  mount.replaceChildren();
  const desktop = document.createElement('div');
  desktop.className = 'channel-control-row';
  desktop.innerHTML = '<div class="channel-identity"><i class="surface-icon web">W</i><span><strong>Desktop</strong><small>Local account</small></span></div><span class="channel-source">Built-in</span><span class="channel-state active">Active</span><div class="channel-actions"></div>';
  mount.append(desktop);
  for (const kind of CHANNEL_KINDS) {
    const config = configs.find((row) => row.kind === kind);
    if (!config) continue;
    const row = document.createElement('div');
    row.className = 'channel-control-row';
    const identity = document.createElement('div');
    identity.className = 'channel-identity';
    const icon = document.createElement('i');
    const [glyph, className] = CHANNEL_ICONS[kind];
    icon.className = `surface-icon ${className}`;
    icon.textContent = glyph;
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = CHANNEL_SCHEMAS[kind].label;
    const detail = document.createElement('small');
    const configuredCount = config.configuredFields?.length ?? 0;
    const requiredCount = CHANNEL_SCHEMAS[kind].fields.length;
    detail.textContent = configuredCount === 0 ? 'Not configured'
      : configuredCount < requiredCount ? `${configuredCount} of ${requiredCount} required`
        : 'Credentials stored';
    copy.append(name, detail);
    identity.append(icon, copy);
    const source = document.createElement('span');
    source.className = 'channel-source';
    source.textContent = 'Built-in';
    const state = document.createElement('span');
    state.className = `channel-state ${config.status}`;
    state.textContent = config.status === 'active' ? 'Active'
      : config.status === 'locked' ? 'Locked'
        : config.status === 'error' ? 'Error'
          : config.status === 'incomplete' ? 'Incomplete' : 'Disabled';
    const actions = document.createElement('div');
    actions.className = 'channel-actions';
    if (config.status === 'active') {
      const copyWebhook = document.createElement('button');
      copyWebhook.type = 'button';
      copyWebhook.textContent = 'Copy webhook';
      copyWebhook.addEventListener('click', () => void copyText(webhookUrl(kind), 'Webhook URL copied.'));
      actions.append(copyWebhook);
    }
    const configure = document.createElement('button');
    configure.type = 'button';
    configure.textContent = 'Configure';
    configure.addEventListener('click', () => openChannelDialog(kind));
    actions.append(configure);
    row.append(identity, source, state, actions);
    mount.append(row);
  }
}

function resetChannelEditor() {
  $('channel-field-mount').replaceChildren();
  selectedChannelKind = null;
  editingChannelRevision = null;
}

function openChannelDialog(kind) {
  clearFormError('channel-form');
  const config = ChannelConfigs.findOne({ kind });
  if (!config) return;
  selectedChannelKind = kind;
  editingChannelRevision = config.revision;
  const schema = CHANNEL_SCHEMAS[kind];
  $('channel-dialog-title').textContent = schema.label;
  $('channel-dialog-kind').textContent = 'Connection';
  $('channel-dialog-status').textContent = config.status.charAt(0).toUpperCase() + config.status.slice(1);
  const configuredCount = config.configuredFields?.length ?? 0;
  $('channel-dialog-detail').textContent = configuredCount === 0 ? 'Not configured'
    : configuredCount < schema.fields.length ? `${configuredCount} of ${schema.fields.length} required`
      : 'Credentials stored';
  $('channel-enabled').checked = config.enabled;
  const mount = $('channel-field-mount');
  mount.replaceChildren();
  for (const field of schema.fields) {
    const label = document.createElement('label');
    label.className = `form-field${schema.fields.length % 2 && field === schema.fields.at(-1) ? ' full' : ''}`;
    const title = document.createElement('span');
    title.textContent = field.label;
    const input = document.createElement('input');
    input.dataset.channelField = field.key;
    input.type = field.secret ? 'password' : (field.type ?? 'text');
    input.maxLength = 2048;
    input.spellcheck = false;
    input.required = config.enabled && !config.configuredFields?.includes(field.key);
    if (field.secret) {
      input.autocomplete = 'new-password';
      input.placeholder = config.configuredFields?.includes(field.key) ? 'Stored · blank keeps value' : (field.placeholder ?? 'Required');
    } else {
      input.value = config.settings?.[field.key] ?? '';
      input.autocomplete = 'off';
    }
    label.append(title, input);
    mount.append(label);
  }
  $('channel-webhook-url').value = webhookUrl(kind);
  $('channel-webhook-field').hidden = false;
  $('channel-clear').hidden = configuredCount === 0;
  $('channel-test').hidden = configuredCount < schema.fields.length;
  $('channel-test-status').hidden = true;
  $('channel-test-status').textContent = '';
  delete $('channel-test-status').dataset.tone;
  $('channel-save').disabled = !$('channel-form').checkValidity();
  beginGuardedEditor('channel-form');
  if (!$('channel-dialog').open) $('channel-dialog').showModal();
  requestAnimationFrame(() => mount.querySelector('input')?.focus());
}

function channelFormPatch() {
  const fields = {};
  for (const input of $('channel-field-mount').querySelectorAll('[data-channel-field]')) {
    const schemaField = CHANNEL_SCHEMAS[selectedChannelKind].fields.find((field) => field.key === input.dataset.channelField);
    if (!schemaField.secret || input.value.trim()) fields[input.dataset.channelField] = input.value;
  }
  return { enabled: $('channel-enabled').checked, fields };
}

function wireChannels() {
  registerGuardedEditor({
    formId: 'channel-form', dialogId: 'channel-dialog', statusId: 'channel-form-status',
    closeId: 'close-channel-dialog', cancelId: 'cancel-channel-edit',
    label: 'this channel', read: channelFormPatch, requireValidity: true,
  });
  const close = () => { $('channel-dialog').close(); resetChannelEditor(); };
  $('channel-dialog').addEventListener('close', resetChannelEditor);
  $('copy-channel-webhook').addEventListener('click', () => void copyText($('channel-webhook-url').value, 'Webhook URL copied.'));
  $('copy-link-command').addEventListener('click', () => void copyText('/link', '/link command copied.'));
  const updateChannelValidity = () => {
    const config = selectedChannelKind && ChannelConfigs.findOne({ kind: selectedChannelKind });
    if (!config) return;
    for (const input of $('channel-field-mount').querySelectorAll('[data-channel-field]')) {
      input.required = $('channel-enabled').checked && !config.configuredFields?.includes(input.dataset.channelField);
    }
    updateGuardedEditor('channel-form');
  };
  $('channel-enabled').addEventListener('change', updateChannelValidity);
  $('channel-field-mount').addEventListener('input', updateChannelValidity);
  $('channel-test').addEventListener('click', async (event) => {
    if (!selectedChannelKind) return;
    const status = $('channel-test-status');
    status.hidden = false;
    status.textContent = 'Checking the provider…';
    delete status.dataset.tone;
    await withControlBusy(event.currentTarget, 'Testing', async () => {
      try {
        const result = await Meteor.callAsync('constellation.channelTest', selectedChannelKind);
        status.textContent = result.reason;
        status.dataset.tone = result.ok ? 'success' : 'error';
      } catch (error) {
        status.textContent = messageOf(error);
        status.dataset.tone = 'error';
      }
    });
  });
  $('channel-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormError(event.currentTarget);
    const kind = selectedChannelKind;
    const expectedRevision = editingChannelRevision;
    if (!kind) return;
    const submit = event.submitter ?? event.currentTarget.querySelector('[type="submit"]');
    await withControlBusy(submit, 'Saving', async () => {
      try {
        const status = await Meteor.callAsync('constellation.channelSave', kind, expectedRevision, channelFormPatch());
        close();
        toast(status === 'active' ? 'Channel active.' : `Channel ${status}.`);
      } catch (error) {
        showFormError('channel-form', error, staleReloadOptions(error, () => openChannelDialog(kind)));
        toast(messageOf(error), 'error');
      }
    });
  });
  $('channel-clear').addEventListener('click', async (event) => {
    const kind = selectedChannelKind;
    const expectedRevision = editingChannelRevision;
    if (!kind || !window.confirm(`Clear stored credentials for ${CHANNEL_SCHEMAS[kind].label}?`)) return;
    await withControlBusy(event.currentTarget, 'Clearing', async () => {
      try {
        await Meteor.callAsync('constellation.channelClear', kind, expectedRevision);
        close();
        toast('Credentials cleared.');
      } catch (error) {
        showFormError('channel-form', error, staleReloadOptions(error, () => openChannelDialog(kind)));
        toast(messageOf(error), 'error');
      }
    });
  });
}

function executeCommand(command) {
  $('command-palette').close();
  if (command.startsWith('view:')) activateView(command.slice(5));
  if (command === 'new') void newMission();
  if (command === 'reviews') openLearningReviews();
}

function wireCommandPalette() {
  const dialog = $('command-palette');
  const input = $('command-input');
  const open = () => {
    input.value = '';
    dialog.querySelectorAll('[data-command]').forEach((button) => { button.hidden = false; });
    dialog.showModal();
    requestAnimationFrame(() => input.focus());
  };
  $('command-trigger').addEventListener('click', open);
  dialog.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => executeCommand(button.dataset.command)));
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    dialog.querySelectorAll('[data-command]').forEach((button) => {
      button.hidden = !!query && !button.textContent.toLowerCase().includes(query);
    });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const first = [...dialog.querySelectorAll('[data-command]')].find((button) => !button.hidden);
      if (first) executeCommand(first.dataset.command);
    }
  });
  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'k') { event.preventDefault(); open(); }
    if (meta && event.key.toLowerCase() === 'n') { event.preventDefault(); void newMission(); }
    if (meta && event.key.toLowerCase() === 'f' && currentView === 'memory') {
      event.preventDefault();
      $('memory-search').focus();
      $('memory-search').select();
    }
    const isEditing = event.composedPath().some((node) => node instanceof HTMLElement
      && (['INPUT', 'TEXTAREA', 'SELECT', 'AGENT-CHAT'].includes(node.tagName) || node.isContentEditable));
    if (event.key === '/' && !isEditing) {
      const search = currentView === 'missions' ? $('mission-search')
        : currentView === 'memory' ? $('memory-search')
          : currentView === 'capabilities' ? $('capability-search') : null;
      if (search) {
        event.preventDefault();
        search.focus();
      }
    }
  });
}

function applyBootstrap(data) {
  bootstrap = data;
  const desktopRuntime = window.constellationDesktop?.runtime;
  $('runtime-label').textContent = desktopRuntime || `${data.live ? 'Live model' : 'Local scripted'} · rc1`;
}

function channelLinkStatus(message, tone = 'neutral') {
  const status = $('channel-link-status');
  status.textContent = message;
  status.dataset.tone = tone;
}

function renderChannelLinkPreview(preview) {
  activeChannelLinkPreview = preview;
  const ready = preview?.state === 'ready';
  const dialog = $('channel-link-dialog');
  const confirm = $('channel-link-confirm');
  $('channel-link-details').hidden = !ready;
  confirm.hidden = !ready;
  if (!ready) {
    $('channel-link-dialog-kicker').textContent = 'LINK UNAVAILABLE';
    $('channel-link-dialog-title').textContent = 'This Channel link can’t be completed';
    channelLinkStatus(
      preview?.state === 'expired'
        ? 'This link has expired. Request a new link from the Channel.'
        : 'This link was already used or is no longer available.',
      'error',
    );
    requestAnimationFrame(() => dialog.focus());
    return;
  }

  const channel = humanizeIdentifier(preview.channel) || 'Channel';
  const expiresAt = preview.expiresAt ? new Date(preview.expiresAt) : null;
  $('channel-link-dialog-kicker').textContent = 'ONE-TIME LINK';
  $('channel-link-dialog-title').textContent = `Link ${channel} to this workspace?`;
  $('channel-link-kind').textContent = channel;
  $('channel-link-expiry').textContent = expiresAt && !Number.isNaN(expiresAt.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(expiresAt)
    : 'Not available';
  confirm.textContent = `Link ${channel}`;
  channelLinkStatus('Connect this Channel to the local workspace on this computer.');
  requestAnimationFrame(() => confirm.focus());
}

async function openChannelLink(token) {
  const generation = ++channelLinkRequestGeneration;
  activeChannelLinkToken = token;
  activeChannelLinkPreview = null;
  const dialog = $('channel-link-dialog');
  $('channel-link-details').hidden = true;
  $('channel-link-confirm').hidden = true;
  $('channel-link-dialog-kicker').textContent = 'CHECKING LINK';
  $('channel-link-dialog-title').textContent = 'Loading Channel details';
  channelLinkStatus('Verifying this one-time link.');
  if (!dialog.open) dialog.showModal();
  dialog.setAttribute('aria-busy', 'true');
  dialog.focus();
  try {
    const preview = await Meteor.callAsync('constellation.previewChannelLink', token);
    if (generation !== channelLinkRequestGeneration || activeChannelLinkToken !== token) return;
    renderChannelLinkPreview(preview);
  } catch (error) {
    if (generation !== channelLinkRequestGeneration || activeChannelLinkToken !== token) return;
    activeChannelLinkPreview = { state: 'unavailable' };
    $('channel-link-dialog-kicker').textContent = 'LINK UNAVAILABLE';
    $('channel-link-dialog-title').textContent = 'This Channel link can’t be checked';
    channelLinkStatus(messageOf(error), 'error');
    dialog.focus();
  } finally {
    if (generation === channelLinkRequestGeneration && activeChannelLinkToken === token) {
      dialog.setAttribute('aria-busy', 'false');
    }
  }
}

function wireChannelLinkDialog() {
  const dialog = $('channel-link-dialog');
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  $('channel-link-confirm').addEventListener('click', async (event) => {
    if (!activeChannelLinkToken || activeChannelLinkPreview?.state !== 'ready') return;
    const generation = channelLinkRequestGeneration;
    const token = activeChannelLinkToken;
    const preview = activeChannelLinkPreview;
    const channel = humanizeIdentifier(preview.channel) || 'Channel';
    dialog.setAttribute('aria-busy', 'true');
    await withControlBusy(event.currentTarget, 'Linking', async () => {
      channelLinkStatus(`Linking ${channel}…`);
      try {
        const identity = await Meteor.callAsync('constellation.linkChannel', token);
        if (generation !== channelLinkRequestGeneration
          || activeChannelLinkToken !== token || activeChannelLinkPreview !== preview) return;
        activeChannelLinkToken = null;
        activeChannelLinkPreview = null;
        $('channel-link-details').hidden = true;
        $('channel-link-confirm').hidden = true;
        $('channel-link-dialog-kicker').textContent = 'CHANNEL LINKED';
        $('channel-link-dialog-title').textContent = `${humanizeIdentifier(identity?.kind) || channel} linked`;
        channelLinkStatus('This Channel now uses your local workspace. You can close this tab.', 'success');
        dialog.focus();
      } catch (error) {
        if (generation !== channelLinkRequestGeneration
          || activeChannelLinkToken !== token || activeChannelLinkPreview !== preview) return;
        activeChannelLinkToken = null;
        activeChannelLinkPreview = null;
        $('channel-link-details').hidden = true;
        $('channel-link-confirm').hidden = true;
        $('channel-link-dialog-kicker').textContent = 'LINK FAILED';
        $('channel-link-dialog-title').textContent = `${channel} wasn’t linked`;
        channelLinkStatus(messageOf(error), 'error');
        dialog.focus();
      } finally {
        if (generation === channelLinkRequestGeneration) {
          dialog.setAttribute('aria-busy', 'false');
        }
      }
    });
  });
}

async function handleChannelLinkDeepLink(token = INITIAL_LINK_TOKEN) {
  if (!token) return;
  await openChannelLink(token);
}

async function handleVerdictDeepLink(token = INITIAL_VERDICT_TOKEN) {
  if (!token) return;
  // Capability URLs must not linger in browser history or desktop crash logs.
  // Capture the bearer in memory, then render its non-consuming preview.
  window.history.replaceState({}, '', '/');
  await openVerdictLink(token);
}

function humanizeIdentifier(value) {
  return String(value ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function verdictLinkStatus(message, tone = 'neutral') {
  const status = $('verdict-status');
  status.textContent = message;
  status.dataset.tone = tone;
}

function renderVerdictPreview(preview) {
  activeVerdictPreview = preview;
  const ready = preview?.state === 'ready';
  $('verdict-details').hidden = !ready;
  $('verdict-confirm').hidden = !ready;
  if (!ready) {
    $('verdict-dialog-kicker').textContent = 'LINK UNAVAILABLE';
    $('verdict-dialog-title').textContent = 'This decision can’t be completed';
    verdictLinkStatus(
      preview?.state === 'expired'
        ? 'This approval link has expired. Return to the conversation for a current request.'
        : 'This request was already decided, replaced, or is no longer waiting.',
      'error',
    );
    return;
  }

  const approving = preview.verdict === 'approved';
  const tool = humanizeIdentifier(preview.toolName) || 'Tool call';
  $('verdict-dialog-kicker').textContent = 'ONE-TIME DECISION';
  $('verdict-dialog-title').textContent = approving ? `Approve ${tool}?` : `Don’t allow ${tool}?`;
  $('verdict-mission').textContent = preview.missionTitle || 'Untitled mission';
  $('verdict-tool').textContent = tool;
  $('verdict-requester').textContent = humanizeIdentifier(preview.requestingAgent) || 'Agent';
  $('verdict-identity').textContent = preview.runContext === 'anonymous'
    ? 'Anonymous service context'
    : (preview.runContext === 'elevated' ? 'Escalated account' : 'Mission owner');
  $('verdict-source').textContent = preview.source || 'App tool';
  $('verdict-scope').textContent = 'This call only';
  $('verdict-expiry').textContent = preview.expiresAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(preview.expiresAt))
    : 'Not available';
  $('verdict-confirm').textContent = approving ? 'Approve once' : 'Don’t allow';
  $('verdict-confirm').classList.toggle('danger-button', !approving);
  $('verdict-confirm').classList.toggle('primary-action', approving);
  verdictLinkStatus(
    approving
      ? 'The agent will run this exact call once.'
      : 'The agent will receive a denied result and continue.',
  );
}

async function openVerdictLink(token) {
  const generation = ++verdictRequestGeneration;
  activeVerdictToken = token;
  activeVerdictPreview = null;
  const dialog = $('verdict-dialog');
  $('close-verdict-dialog').hidden = false;
  $('verdict-details').hidden = true;
  $('verdict-confirm').hidden = true;
  $('verdict-dialog-kicker').textContent = 'CHECKING LINK';
  $('verdict-dialog-title').textContent = 'Loading decision details';
  verdictLinkStatus('Verifying the current request.');
  if (!dialog.open) dialog.showModal();
  dialog.setAttribute('aria-busy', 'true');
  try {
    const preview = await Meteor.callAsync('constellation.previewVerdict', token);
    if (generation !== verdictRequestGeneration || activeVerdictToken !== token) return;
    renderVerdictPreview(preview);
  } catch (error) {
    if (generation !== verdictRequestGeneration || activeVerdictToken !== token) return;
    renderVerdictPreview({ state: 'unavailable' });
    verdictLinkStatus(messageOf(error), 'error');
  } finally {
    if (generation === verdictRequestGeneration && activeVerdictToken === token) {
      dialog.setAttribute('aria-busy', 'false');
    }
  }
}

function wireVerdictDialog() {
  const dialog = $('verdict-dialog');
  $('close-verdict-dialog').addEventListener('click', () => {
    if (INITIAL_VERDICT_TOKEN) {
      window.close();
      // Browsers only allow script-close for script-opened tabs. Keep a useful
      // terminal surface when the platform refuses instead of presenting a
      // close control that appears broken.
      verdictRequestGeneration += 1;
      activeVerdictToken = null;
      activeVerdictPreview = null;
      $('verdict-details').hidden = true;
      $('verdict-confirm').hidden = true;
      $('verdict-dialog-kicker').textContent = 'DECISION NOT RECORDED';
      $('verdict-dialog-title').textContent = 'You can close this tab';
      $('close-verdict-dialog').hidden = true;
      verdictLinkStatus('Return to the original link if you still need to decide this request.');
      return;
    }
    dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (INITIAL_VERDICT_TOKEN) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    verdictRequestGeneration += 1;
    activeVerdictToken = null;
    activeVerdictPreview = null;
  });
  $('verdict-confirm').addEventListener('click', async (event) => {
    if (!activeVerdictToken || activeVerdictPreview?.state !== 'ready') return;
    const token = activeVerdictToken;
    const preview = activeVerdictPreview;
    const approving = preview.verdict === 'approved';
    await withControlBusy(event.currentTarget, approving ? 'Approving' : 'Denying', async () => {
      verdictLinkStatus(approving ? 'Recording approval…' : 'Recording denial…');
      try {
        const decided = await Meteor.callAsync('constellation.redeemVerdict', token);
        if (activeVerdictToken !== token || activeVerdictPreview !== preview) return;
        if (!decided) {
          renderVerdictPreview({ state: 'unavailable' });
          return;
        }
        if (INITIAL_VERDICT_TOKEN) {
          activeVerdictToken = null;
          activeVerdictPreview = null;
          $('verdict-details').hidden = true;
          $('verdict-confirm').hidden = true;
          $('verdict-dialog-kicker').textContent = 'DECISION RECORDED';
          $('verdict-dialog-title').textContent = approving ? 'Approved once' : 'Tool call denied';
          $('close-verdict-dialog').hidden = true;
          verdictLinkStatus('You can close this window.');
          return;
        }
        dialog.close();
        activeVerdictToken = null;
        activeVerdictPreview = null;
        toast(approving ? 'Approved once.' : 'Tool call denied.');
      } catch (error) {
        if (activeVerdictToken === token && activeVerdictPreview === preview) {
          verdictLinkStatus(messageOf(error), 'error');
        }
      }
    });
  });
}

function showStartupFailure(error) {
  $('startup-error-detail').textContent = messageOf(error);
  $('startup-failure').hidden = false;
  $('app-frame').dataset.startupState = 'error';
  $('app-frame').setAttribute('aria-busy', 'false');
  $('app-frame').inert = true;
  const retry = $('retry-startup');
  retry.disabled = false;
  retry.dataset.loading = 'false';
  delete retry.dataset.loadingLabel;
  requestAnimationFrame(() => retry.focus());
}

function beginStartupAttempt() {
  const recovering = !$('startup-failure').hidden;
  $('app-frame').dataset.startupState = 'loading';
  $('app-frame').setAttribute('aria-busy', 'true');
  $('app-frame').inert = true;
  if (!recovering) return;
  $('startup-error-detail').textContent = 'Reconnecting to the local workspace…';
  const retry = $('retry-startup');
  retry.disabled = true;
  retry.dataset.loading = 'true';
  retry.dataset.loadingLabel = 'Retrying';
}

function finishStartup() {
  $('startup-failure').hidden = true;
  $('startup-error-detail').textContent = '';
  $('app-frame').dataset.startupState = 'ready';
  $('app-frame').setAttribute('aria-busy', 'false');
  $('app-frame').inert = false;
}

function stopBootSubscriptions() {
  bootSubscriptions.forEach((handle) => handle?.stop?.());
  bootSubscriptions = [];
  learningSubscription = null;
  learningSubscriptionError = null;
  learningViewChanged.changed();
  missionParticipationHandle?.stop?.();
  missionParticipationHandle = null;
  missionParticipationSessionId = null;
}

function subscribeToLearning() {
  let handle = null;
  handle = Meteor.subscribe('constellation.learning', {
    onReady() {
      if (learningSubscription !== handle) return;
      learningSubscriptionError = null;
      clearAgentLearningError();
      learningViewChanged.changed();
    },
    onStop(error) {
      if (!error || learningSubscription !== handle) return;
      learningSubscriptionError = messageOf(error);
      learningViewChanged.changed();
    },
  });
  return handle;
}

async function retryLearningSubscription() {
  const previous = learningSubscription;
  const index = bootSubscriptions.indexOf(previous);
  previous?.stop?.();
  learningSubscriptionError = null;
  clearAgentLearningError();
  learningSubscription = subscribeToLearning();
  if (index >= 0) bootSubscriptions[index] = learningSubscription;
  else bootSubscriptions.push(learningSubscription);
  learningViewChanged.changed();
  try {
    await waitForSubscription(learningSubscription, 'agent learning');
  } catch (error) {
    learningSubscriptionError = messageOf(error);
    learningViewChanged.changed();
    throw error;
  }
}

async function initializeWorkspace() {
  await ensureLocalIdentity();
  bootstrap = await Meteor.callAsync('constellation.bootstrap');

  $('profile-button').title = 'Local workspace account';
  applyBootstrap(bootstrap);
  learningSubscriptionError = null;
  learningSubscription = subscribeToLearning();
  const subscriptions = [
    { label: 'missions', handle: workspace.subscribeSessions() },
    { label: 'mission settings', handle: Meteor.subscribe('constellation.missions') },
    { label: 'memory', handle: Meteor.subscribe(NAMES.pubMemories) },
    { label: 'crew', handle: Meteor.subscribe('constellation.crew') },
    { label: 'agent learning', handle: learningSubscription },
    { label: 'models', handle: Meteor.subscribe('constellation.modelCatalog') },
    { label: 'workspace members', handle: Meteor.subscribe('constellation.workspaceMembers') },
    { label: 'Pulses', handle: Meteor.subscribe('constellation.pulses') },
    { label: 'Skills', handle: Meteor.subscribe('constellation.skills') },
    { label: 'MCP servers', handle: Meteor.subscribe('constellation.mcp') },
    { label: 'tool catalog', handle: Meteor.subscribe('constellation.toolCatalog') },
    { label: 'Channels', handle: Meteor.subscribe('constellation.channels') },
  ];
  bootSubscriptions = subscriptions.map(({ handle }) => handle);
  await Promise.all(subscriptions.map(({ handle, label }) => waitForSubscription(handle, label)));

  const saved = localStorage.getItem(SESSION_KEY);
  let initialSession = saved;
  let restoreFailure = null;
  if (initialSession) {
    const savedTitle = AgentSessions.findOne(initialSession)?.title || 'your previous mission';
    try {
      await prepareSession(initialSession);
      const config = missionConfig(initialSession);
      if (!config || config.continuity === false || config.status === 'completed') {
        throw new Error('Mission is not resumable.');
      }
    } catch (error) {
      restoreFailure = { title: savedTitle, reason: messageOf(error) };
      initialSession = null;
      localStorage.removeItem(SESSION_KEY);
    }
  }
  if (!initialSession) {
    const preferred = workspace.sessions().fetch().find((session) => {
      const config = missionConfig(session._id);
      return config?.continuity !== false && config?.status !== 'completed';
    });
    initialSession = preferred?._id ?? await createMission();
    if (preferred) await prepareSession(initialSession);
  }
  currentSessionId = initialSession;

  const chat = $('mission-chat');
  chat.setAttribute('session-id', initialSession);
  if (!applicationWired) {
    applicationWiringStarted = true;
    chat.addEventListener('agent-chat:session', (event) => {
      currentSessionId = event.detail.sessionId;
      setChatComposerMode('ask', { focus: false });
      subscribeMissionParticipation(currentSessionId);
      void prepareSession(currentSessionId);
      persistResumableMission(currentSessionId);
      sessionChanged.changed();
    });
    chat.addEventListener('agent-chat:error', (event) => {
      toast(messageOf(event.detail?.error), 'error');
    });
    chat.addEventListener('agent-chat:submitted', (event) => {
      if (event.detail?.mode === 'note') setChatComposerMode('ask', { focus: false });
    });

    defineAgentChat();
    chat.mentionSources = {
      '#': {
        kind: 'mission-object',
        list: [
          { handle: 'launch', label: 'Launch brief', detail: 'Current deliverable' },
          { handle: 'positioning', label: 'Positioning decision', detail: 'Decision record' },
          { handle: 'design-partners', label: 'Design partners', detail: 'Target cohort' },
        ],
        handle: 'handle', label: 'label', detail: 'detail',
      },
    };

    wireNavigation();
    wireMissionActions();
    wireMissionSettings();
    wireCrewSettings();
    wireMemory();
    wirePulses();
    wireSkills();
    wireMcpServers();
    wireChannels();
    wireCommandPalette();
    Tracker.autorun(renderMissionState);
    Tracker.autorun(renderMemory);
    Tracker.autorun(renderCrewSettings);
    Tracker.autorun(renderWorkspacePeople);
    Tracker.autorun(renderReviews);
    Tracker.autorun(renderPulses);
    Tracker.autorun(renderCapabilities);
    Tracker.autorun(renderChannels);
    applicationWired = true;
    applicationWiringStarted = false;
  }
  openSession(initialSession);
  if (restoreFailure) {
    const opened = AgentSessions.findOne(initialSession)?.title || 'another mission';
    toast(`Couldn’t resume “${restoreFailure.title}”; opened “${opened}”.`, 'error');
  }
}

async function boot() {
  if (booted || bootPromise) return bootPromise;
  beginStartupAttempt();
  bootPromise = initializeWorkspace()
    .then(() => {
      booted = true;
      finishStartup();
    })
    .catch((error) => {
      stopBootSubscriptions();
      showStartupFailure(error);
    })
    .finally(() => {
      if (!booted) bootPromise = null;
    });
  return bootPromise;
}

Meteor.startup(() => {
  wireChannelLinkDialog();
  wireVerdictDialog();
  if (INITIAL_LINK_TOKEN) {
    $('app-frame').inert = true;
    void handleChannelLinkDeepLink();
    return;
  }
  if (INITIAL_VERDICT_TOKEN) {
    $('app-frame').inert = true;
    void handleVerdictDeepLink();
    return;
  }
  $('retry-startup').addEventListener('click', () => {
    if (applicationWiringStarted && !applicationWired) {
      window.location.reload();
      return;
    }
    void boot();
  });
  void boot();
});
