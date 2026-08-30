import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Accounts } from 'meteor/accounts-base';
import { Mongo } from 'meteor/mongo';
import {
  Agent,
  AgentMemories,
  AgentSessions,
  NAMES,
  defineAgentChat,
} from 'meteor/10thfloor:agent';
import {
  CHANNEL_KINDS,
  CHANNEL_SCHEMAS,
  deriveRuntimeState,
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
const workspace = new Agent('orchestrator');
const sessionChanged = new Tracker.Dependency();
const memoryViewChanged = new Tracker.Dependency();
const $ = (id) => document.getElementById(id);

let currentSessionId = null;
let currentView = 'missions';
let memoryFilter = 'all';
let bootstrap = null;
let editingMissionSessionId = null;
let editingMissionRevision = null;
let selectedCrewId = null;
let crewEditor = null;
let pendingCrewImpact = null;
let crewDirectoryTab = 'agents';
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
const pendingCrewRemovals = new Set();
const pendingSkillStates = new Map();
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

function toast(message, tone = 'success') {
  const row = document.createElement('div');
  row.className = `toast ${tone}`;
  row.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  const light = document.createElement('i');
  const copy = document.createElement('span');
  copy.textContent = message;
  row.append(light, copy);
  $('toast-region').append(row);
  window.setTimeout(() => row.classList.add('out'), 2800);
  window.setTimeout(() => row.remove(), 3100);
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
  ).fetch().filter((config) => !pendingCrewRemovals.has(config._id)).map((config) => ({
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
    const state = document.createElement('span');
    state.className = 'crew-state';
    state.dataset.agentState = agentState;
    state.textContent = stateLabel;
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

function crewConfigs() {
  for (const configId of pendingCrewRemovals) {
    if (!CrewConfigs.findOne(configId)) pendingCrewRemovals.delete(configId);
  }
  const configs = CrewConfigs.find({}, { sort: { order: 1, createdAt: 1 } }).fetch()
    .filter((config) => !pendingCrewRemovals.has(config._id));
  if (crewEditor?.isNew) configs.push(crewEditor.config);
  return configs;
}

function crewConfigPatch(config) {
  return {
    displayName: config.displayName,
    role: config.role,
    avatar: config.avatar,
    color: config.color,
    instructions: config.instructions,
    model: config.model,
    enabled: config.enabled,
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
    instructions: 'You are a specialist. Work only within the assigned scope, state assumptions, and return a concise recommendation with next actions.',
    model: 'default',
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
    select.disabled = true;
    hint.dataset.modelState = 'empty';
    hint.textContent = 'No model provider is available. Configure a provider or start a local runtime, then restart Constellation.';
    return;
  }
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
  $('crew-name').value = config.displayName;
  $('crew-role').value = config.role;
  $('crew-avatar').value = config.avatar;
  $('crew-color').value = config.color;
  $('crew-instructions').value = config.instructions;
  renderCrewModelSelector(config.model);
  $('crew-enabled').checked = config.enabled;
  $('crew-turns').value = String(config.budget?.turns ?? 24);
  $('crew-tool-calls').value = String(config.budget?.toolCalls ?? 8);
  $('crew-spend').value = String(config.budget?.spend ?? 1);
  $('crew-cap-inspect').checked = !!config.capabilities?.inspect;
  $('crew-cap-memory').checked = !!config.capabilities?.memory;
  $('crew-cap-publish').checked = !!config.capabilities?.publish;
}

function renderCrewEditState(config) {
  const primary = config.agent === 'orchestrator';
  const state = $('crew-edit-state');
  state.dataset.state = crewEditor?.dirty ? 'dirty' : 'saved';
  state.textContent = crewEditor?.isNew
    ? 'New agent · not saved'
    : (crewEditor?.dirty ? 'Unsaved changes' : 'Saved');
  $('crew-form-id').textContent = crewEditor?.isNew
    ? 'Not in the workspace yet'
    : (primary ? 'Primary agent' : 'Workspace agent');
  $('crew-enabled').disabled = primary;
  $('remove-crew-agent').hidden = primary || crewEditor?.isNew;
  $('remove-crew-agent').disabled = primary || crewEditor?.isNew
    || pendingControls.has($('remove-crew-agent'));
  $('crew-primary-label').hidden = !primary;
  $('cancel-crew-edit').textContent = crewEditor?.dirty ? 'Discard changes' : 'Close';
  $('crew-form').querySelector('[type="submit"]').textContent = crewEditor?.isNew
    ? 'Add to workspace'
    : 'Save changes';
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
  selectedCrewId = configId;
  renderCrewSettings();
  return true;
}

function renderCrewSettings() {
  const configs = crewConfigs();
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
    button.type = 'button';
    button.className = `crew-settings-row${selected ? ' active' : ''}`;
    button.dataset.configId = config._id;
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${config.displayName}. ${config.role}. ${config.enabled ? 'Active' : 'Inactive'}.`);
    const avatar = document.createElement('span');
    avatar.className = config.color;
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = config.avatar;
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = config.displayName;
    const role = document.createElement('small');
    role.textContent = config.role;
    copy.append(name, role);
    const status = document.createElement('i');
    status.className = config.enabled ? 'enabled' : '';
    status.setAttribute('aria-hidden', 'true');
    button.append(avatar, copy, status);
    button.addEventListener('click', () => selectCrewConfig(config._id));
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
}

function setCrewDirectoryTab(tab, { focus = false } = {}) {
  if (!['people', 'agents'].includes(tab)) return;
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
    displayName: $('crew-name').value,
    role: $('crew-role').value,
    avatar: $('crew-avatar').value,
    color: $('crew-color').value,
    instructions: $('crew-instructions').value,
    model: $('crew-model').value,
    enabled: $('crew-enabled').checked,
    budget: {
      turns: Number($('crew-turns').value),
      toolCalls: Number($('crew-tool-calls').value),
      spend: Number($('crew-spend').value),
    },
    capabilities: {
      inspect: $('crew-cap-inspect').checked,
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

function renderCrewRemovalImpact(impact) {
  $('crew-remove-title').textContent = `Remove ${impact.displayName}?`;
  const total = impact.missions.length + impact.skills.length
    + impact.mcpServers.length + impact.pulses.length;
  $('crew-remove-summary').textContent = total
    ? `${impact.displayName} will be removed from the workspace and the following references will change.`
    : `${impact.displayName} will be removed from the workspace.`;
  const container = $('crew-remove-impact');
  container.replaceChildren();
  appendCrewImpactSection(container, 'Missions', impact.missions, (row) =>
    `${row.name} · ${row.status}${row.active ? ' · work in progress' : ''}`);
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
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      setCrewDirectoryTab(
        button.dataset.crewDirectoryTab === 'people' ? 'agents' : 'people',
        { focus: true },
      );
    });
  });
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
  $('add-crew-agent').addEventListener('click', () => {
    if (!currentSessionId || !discardCrewChanges('Discard these changes and add a new agent?')) return;
    const draft = newCrewDraft();
    resetCrewEditor(draft, true);
    selectedCrewId = draft._id;
    populateCrewForm(draft);
    renderCrewSettings();
    requestAnimationFrame(() => $('crew-name').select());
  });
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
        showFormError('crew-form', error);
        toast(messageOf(error), 'error');
      }
    });
  });
  $('remove-crew-agent').addEventListener('click', async (event) => {
    if (!currentSessionId || !selectedCrewId) return;
    const configId = selectedCrewId;
    const config = CrewConfigs.findOne(configId);
    if (!config) return;
    await withControlBusy(event.currentTarget, 'Checking', async () => {
      try {
        pendingCrewImpact = await Meteor.callAsync('constellation.crewImpact', configId);
        renderCrewRemovalImpact(pendingCrewImpact);
        $('crew-remove-dialog').showModal();
      } catch (error) { toast(messageOf(error), 'error'); }
    });
    renderCrewSettings();
  });
  const closeRemoval = () => {
    pendingCrewImpact = null;
    $('crew-remove-dialog').close();
  };
  $('close-crew-remove').addEventListener('click', closeRemoval);
  $('cancel-crew-remove').addEventListener('click', closeRemoval);
  $('confirm-crew-remove').addEventListener('click', async (event) => {
    if (!currentSessionId || !pendingCrewImpact) return;
    const impact = pendingCrewImpact;
    const primary = crewConfigs().find((candidate) => candidate.agent === 'orchestrator');
    await withControlBusy(event.currentTarget, 'Removing', async () => {
      pendingCrewRemovals.add(impact.configId);
      crewEditor = null;
      selectedCrewId = primary?._id ?? null;
      renderCrewSettings();
      sessionChanged.changed();
      try {
        await Meteor.callAsync(
          'constellation.crewRemove', currentSessionId, impact.configId, impact.agent,
        );
        pendingCrewImpact = null;
        $('crew-remove-dialog').close();
        renderCrewSettings();
        sessionChanged.changed();
        toast(`${impact.displayName} removed from the workspace.`);
      } catch (error) {
        pendingCrewRemovals.delete(impact.configId);
        selectedCrewId = impact.configId;
        renderCrewSettings();
        sessionChanged.changed();
        toast(messageOf(error), 'error');
      }
    });
  });
  $('crew-model').addEventListener('change', (event) => {
    renderCrewModelSelector(event.currentTarget.value);
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
  $('continuity-state').textContent = config?.continuity === false ? 'Disabled' : 'Enabled';
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

function renderMemory() {
  memoryViewChanged.depend();
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
  $('mission-config-approvals-hint').textContent = `${primaryDefinition().label} asks before each Publish brief call`;
  $('mission-config-debug-traces').checked = config.debugTraces ?? false;
  $('mission-config-continuity').disabled = config.status === 'completed';
  $('archive-mission').textContent = config.status === 'completed' ? 'Reactivate mission' : 'Complete mission';
  $('mission-complete-effect').textContent = config.status === 'completed'
    ? 'Restarts linked Pulses and allows this mission to resume.'
    : 'Stops work, pauses linked Pulses, and disables resume.';
  updateMissionStatusHint(config.status);
  updateMissionConfigBadge(config.status);
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
  $('configure-mission').addEventListener('click', (event) => {
    void withControlBusy(event.currentTarget, 'Loading', openMissionSettings);
  });
  $('configure-continuity').addEventListener('click', (event) => {
    void withControlBusy(event.currentTarget, 'Loading', openMissionSettings);
  });
  $('close-mission-dialog').addEventListener('click', () => $('mission-dialog').close());
  $('cancel-mission-edit').addEventListener('click', () => $('mission-dialog').close());
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
  $('profile-button').addEventListener('click', () => toast('Local-only account.'));
}

function wireMissionActions() {
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
    await withControlBusy(event.currentTarget, 'Compacting', async () => {
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
  $('add-pulse').addEventListener('click', () => openPulseDialog());
  $('close-pulse-dialog').addEventListener('click', closePulseDialog);
  $('cancel-pulse-edit').addEventListener('click', closePulseDialog);
  $('pulse-dialog').addEventListener('close', () => {
    selectedPulseId = null;
    editingPulseRevision = null;
  });
  $('pulse-schedule-kind').addEventListener('change', (event) => setPulseScheduleFields(event.currentTarget.value));
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
  $('add-skill').addEventListener('click', () => openSkillDialog());
  $('close-skill-dialog').addEventListener('click', () => $('skill-dialog').close());
  $('cancel-skill-edit').addEventListener('click', () => $('skill-dialog').close());
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
  row.querySelector('[data-remove-mcp-arg]').addEventListener('click', () => row.remove());
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

function renderMcpToolOptions(server, discovered = null) {
  const existing = discovered ?? (server?._id ? toolsForServer(server._id) : []);
  const selected = new Set(server?.selectedTools ?? []);
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
  clearFormError('mcp-form');
  const server = id ? McpConfigs.findOne(id) : null;
  if (id && !server) {
    editingMcpId = null;
    editingMcpRevision = null;
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
  $('mcp-trust-local').required = $('mcp-enabled').checked;
  $('mcp-tool-access').value = server?.toolMode ?? 'selected';
  $('mcp-approval').value = server?.approval ?? 'ask';
  $('mcp-args-rows').replaceChildren();
  for (const argument of server?.args ?? []) addMcpArgRow(argument);
  $('mcp-env-rows').replaceChildren();
  for (const key of server?.envKeys ?? []) addMcpEnvRow(key, true);
  populateMcpAgents(server);
  renderMcpToolOptions(server);
  updateMcpEditorState(server);
  $('delete-mcp-server').hidden = !server;
  $('mcp-test-discover').disabled = !server;
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
    toolMode: $('mcp-tool-access').value,
    selectedTools: [...$('mcp-tool-options').querySelectorAll('input:checked')].map((input) => input.value),
    approval: $('mcp-approval').value,
    timeoutMs: Number($('mcp-timeout-ms').value || 15_000),
    cooldownMs: Number($('mcp-cooldown-ms').value || 30_000),
  };
}

async function testMcpServer(id, control) {
  if (!id) {
    toast('Save the server before testing.', 'error');
    return;
  }
  await withControlBusy(control, 'Testing', async () => {
    try {
      const result = await Meteor.callAsync('constellation.mcpTest', id);
      const server = McpConfigs.findOne(id);
      if ($('mcp-dialog').open && editingMcpId === id) {
        renderMcpToolOptions(server, result.tools ?? []);
        setMcpStatus($('mcp-dialog-runtime-status'), result.status ?? (result.ok ? 'ready' : 'error'), result.ok ? 'Ready' : 'Unavailable');
        setMcpStatus($('mcp-discovery-status'), result.status ?? (result.ok ? 'ready' : 'error'), result.ok ? 'Ready' : 'Unavailable');
        $('mcp-diagnostic-log').textContent = result.ok ? `${result.tools?.length ?? 0} tools discovered.` : (result.reason ?? 'Connection failed.');
      }
      toast(result.ok ? `${result.tools?.length ?? 0} tools discovered.` : (result.reason ?? 'Server unavailable.'), result.ok ? 'success' : 'error');
    } catch (error) { toast(messageOf(error), 'error'); }
  });
}

function wireMcpServers() {
  const close = () => {
    $('mcp-dialog').close();
    editingMcpId = null;
    editingMcpRevision = null;
    removedMcpEnvKeys = new Set();
  };
  $('add-mcp-server').addEventListener('click', () => openMcpDialog());
  $('close-mcp-dialog').addEventListener('click', close);
  $('cancel-mcp-edit').addEventListener('click', close);
  $('mcp-dialog').addEventListener('close', () => {
    editingMcpId = null;
    editingMcpRevision = null;
    removedMcpEnvKeys = new Set();
  });
  $('add-mcp-arg').addEventListener('click', () => addMcpArgRow().querySelector('input').focus());
  $('add-mcp-env').addEventListener('click', () => addMcpEnvRow().querySelector('input').focus());
  $('mcp-enabled').addEventListener('change', () => {
    $('mcp-trust-local').required = $('mcp-enabled').checked;
  });
  $('mcp-tool-access').addEventListener('change', () => {
    renderMcpToolOptions(editingMcpId ? McpConfigs.findOne(editingMcpId) : null);
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
    clearFormError(event.currentTarget);
    const serverId = editingMcpId;
    const expectedRevision = editingMcpRevision;
    const submit = event.submitter ?? event.currentTarget.querySelector('[type="submit"]');
    await withControlBusy(submit, 'Saving', async () => {
      try {
        const saved = serverId
          ? await Meteor.callAsync('constellation.mcpSave', serverId, expectedRevision, mcpFormPatch())
          : await Meteor.callAsync('constellation.mcpCreate', mcpFormPatch());
        selectedMcpId = saved._id;
        close();
        setCapabilityTab('mcp');
        toast(saved.enabled ? 'MCP server enabled.' : 'MCP server saved.');
      } catch (error) {
        showFormError('mcp-form', error, staleReloadOptions(error, () => openMcpDialog(serverId)));
        toast(messageOf(error), 'error');
      }
    });
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
  const close = () => { $('channel-dialog').close(); resetChannelEditor(); };
  $('close-channel-dialog').addEventListener('click', close);
  $('cancel-channel-edit').addEventListener('click', close);
  $('channel-dialog').addEventListener('close', resetChannelEditor);
  $('copy-channel-webhook').addEventListener('click', () => void copyText($('channel-webhook-url').value, 'Webhook URL copied.'));
  $('copy-link-command').addEventListener('click', () => void copyText('/link', '/link command copied.'));
  const updateChannelValidity = () => {
    const config = selectedChannelKind && ChannelConfigs.findOne({ kind: selectedChannelKind });
    if (!config) return;
    for (const input of $('channel-field-mount').querySelectorAll('[data-channel-field]')) {
      input.required = $('channel-enabled').checked && !config.configuredFields?.includes(input.dataset.channelField);
    }
    $('channel-save').disabled = !$('channel-form').checkValidity();
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
  missionParticipationHandle?.stop?.();
  missionParticipationHandle = null;
  missionParticipationSessionId = null;
}

async function initializeWorkspace() {
  await ensureLocalIdentity();
  bootstrap = await Meteor.callAsync('constellation.bootstrap');

  $('profile-button').title = 'Local workspace account';
  applyBootstrap(bootstrap);
  const subscriptions = [
    { label: 'missions', handle: workspace.subscribeSessions() },
    { label: 'mission settings', handle: Meteor.subscribe('constellation.missions') },
    { label: 'memory', handle: Meteor.subscribe(NAMES.pubMemories) },
    { label: 'crew', handle: Meteor.subscribe('constellation.crew') },
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
