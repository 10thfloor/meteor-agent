import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import {
  createCipheriv, createDecipheriv, createHash, randomBytes,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Agent,
  AgentSessions,
  abandonPendingAgentTurns,
  assertLearningReviewTarget,
  assertPracticeTransitionEvidence,
  ChannelBindings,
  ChannelIdentities,
  createLearningPublisher,
  createPiAiProvider,
  discoverMcpTools,
  disconnectMcpServer,
  egress,
  getMcpServerStatus,
  governedConstitutionRevise,
  governedExperienceRetract,
  governedLearningReview,
  governedPracticePropose,
  governedPracticeTransition,
  hostLearningSource,
  loadPiAi,
  LEARNING_TOOL_NAMES,
  EXPERIENCE_RECALL_MAX,
  MAX_PARTICIPANTS,
  MEMORY_TEXT_MAX,
  MEMORY_TOOL_NAMES,
  mockProvider,
  humanParticipantId,
  modelParticipantId,
  piAiProvider,
  previewLinkToken,
  previewVerdictToken,
  redeemLinkToken,
  redeemVerdictToken,
  startEgress,
  SKILL_TOOL_NAME,
  SUBAGENT_ARGS,
  unregisterMcpServer,
} from 'meteor/10thfloor:agent';
import { slack } from 'meteor/10thfloor:agent-channel-slack';
import { telegram } from 'meteor/10thfloor:agent-channel-telegram';
import { whatsapp } from 'meteor/10thfloor:agent-channel-whatsapp';
import { sms } from 'meteor/10thfloor:agent-channel-sms';
import { email } from 'meteor/10thfloor:agent-channel-email';
import {
  CHANNEL_KINDS,
  CHANNEL_SCHEMAS,
  nextScheduledAt,
  normalizeSchedule,
  slugifySkill,
} from '../imports/constellation/config';
import {
  assertCrewModelAvailable,
  buildModelCatalog,
  effectiveCrewModel,
  LOCAL_MODEL,
  MODEL_ID_MAX,
  modelIdsFromCatalog,
} from '../imports/constellation/models';
import { refreshRadiusModels } from './model-providers';
import { detectOllamaModels, OLLAMA_OPENAI_URL } from './ollama';

const offline = process.env.CONSTELLATION_OFFLINE === '1';
let live = false;
let model = LOCAL_MODEL;
export const WorkspaceState = new Mongo.Collection('constellation_workspace_state');
export const MissionConfigs = new Mongo.Collection('constellation_mission_configs');
export const CrewConfigs = new Mongo.Collection('constellation_crew_configs');
const CrewStates = new Mongo.Collection('constellation_crew_states');
export const WorkspaceMembers = new Mongo.Collection('constellation_workspace_members');
const PulseConfigs = new Mongo.Collection('constellation_pulses');
const PulseRuns = new Mongo.Collection('constellation_pulse_runs');
const PulseStates = new Mongo.Collection('constellation_pulse_states');
export const SkillConfigs = new Mongo.Collection('constellation_skills');
const SkillStates = new Mongo.Collection('constellation_skill_states');
const ChannelConfigs = new Mongo.Collection('constellation_channel_configs');
const ChannelSecrets = new Mongo.Collection('constellation_channel_secrets');
export const McpConfigs = new Mongo.Collection('constellation_mcp_configs');
const McpSecrets = new Mongo.Collection('constellation_mcp_secrets');
export const ToolCatalog = new Mongo.Collection('constellation_tool_catalog');
const CREW_COLORS = new Set(['amber', 'blue', 'green', 'red', 'violet', 'steel']);
const CREW_STATUSES = new Set(['available', 'unavailable', 'archived']);
const WORKSPACE_MEMBER_CONNECTIONS = new Set(['unlinked', 'account', 'channel']);
const WORKSPACE_MEMBER_MAX = 64;
const MISSION_STATUSES = new Set(['active', 'paused', 'completed']);
const MCP_APPROVALS = new Set(['ask', 'blocked']);
const MCP_TOOL_MODES = new Set(['all', 'selected']);
const MCP_ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MCP_ACTIVE_PHASES = ['streaming', 'calling', 'retrying', 'compacting', 'awaiting'];
const MCP_DANGEROUS_ENV = new Set(['PATH', 'HOME', 'SHELL', 'NODE_OPTIONS']);
const EXPERIENCE_SCOPES = new Set(['identity', 'owner', 'session']);
const LEARNING_APPROVALS = new Set(['ask', 'auto']);
const DEFAULT_CREW_EXPERIENCE = Object.freeze({
  record: true, recall: true, recent: 4, scope: 'owner', approval: 'ask',
});
const DEFAULT_CREW_PRACTICE = Object.freeze({
  acquire: false, approval: 'ask', allowScopedEvidencePromotion: false,
});
const DEFAULT_CREW_FLEXIBILITY = 3;
const activeChannelDefs = new Map();
const runtimeMcpToolsByAgent = new Map();
const toolCatalogSyncByUser = new Map();
const missionCrewMutationLocks = new Map();
const crewConfigMutationLocks = new Map();
const workspaceConfigMutationLocks = new Map();
const [MEMORY_SAVE_TOOL_NAME, MEMORY_SEARCH_TOOL_NAME, MEMORY_FORGET_TOOL_NAME]
  = MEMORY_TOOL_NAMES;
const [EXPERIENCE_PROPOSE_TOOL_NAME, EXPERIENCE_SEARCH_TOOL_NAME, PRACTICE_PROPOSE_TOOL_NAME]
  = LEARNING_TOOL_NAMES;

function resolveAppMcpScript() {
  const roots = [...new Set([
    process.env.CONSTELLATION_APP_ROOT,
    process.env.INIT_CWD,
    process.env.PWD,
    process.cwd(),
  ].filter(Boolean))];
  for (const root of roots) {
    for (const relative of ['mcp/workspace-server.mjs', 'app/mcp/workspace-server.mjs']) {
      const candidate = resolve(root, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return resolve(process.cwd(), 'mcp/workspace-server.mjs');
}

export const APP_MCP_SERVERS = Object.freeze([Object.freeze({
  appKey: 'workspace-runtime',
  name: 'Workspace Runtime',
  command: process.execPath,
  args: [resolveAppMcpScript()],
  displayCommand: 'node',
  displayArgs: ['mcp/workspace-server.mjs'],
  agents: ['orchestrator'],
  approval: 'ask',
})]);

function inactiveChannelError(kind) {
  return new Error(`${kind} channel is disabled`);
}

function channelFacade(kind) {
  const facade = {
    agent: 'orchestrator',
    transport: {
      post: (...args) => {
        const def = activeChannelDefs.get(kind);
        if (!def) throw inactiveChannelError(kind);
        return def.transport.post(...args);
      },
      reconcile: (...args) => activeChannelDefs.get(kind)?.transport?.reconcile?.(...args) ?? false,
    },
    lens: {
      out: (...args) => {
        const def = activeChannelDefs.get(kind);
        if (!def) throw inactiveChannelError(kind);
        return def.lens.out(...args);
      },
      in: (...args) => {
        const def = activeChannelDefs.get(kind);
        if (!def) throw inactiveChannelError(kind);
        return def.lens.in(...args);
      },
    },
    preverify: (...args) => {
      const def = activeChannelDefs.get(kind);
      if (!def) return false;
      return def.preverify ? def.preverify(...args) : true;
    },
    verify: (...args) => activeChannelDefs.get(kind)?.verify?.(...args) ?? false,
    parse: (...args) => {
      const def = activeChannelDefs.get(kind);
      if (!def) throw inactiveChannelError(kind);
      return def.parse(...args);
    },
    maxInboundBytes: kind === 'email' ? 50 * 1024 * 1024 : 1024 * 1024,
  };
  for (const key of [
    'profile', 'statuses', 'onUncertainDelivery', 'sessionUrl', 'approvalUrl', 'linkUrl',
    'throttle', 'attachments', 'admits', 'adoptDestination', 'media',
  ]) {
    Object.defineProperty(facade, key, {
      enumerable: true,
      get: () => activeChannelDefs.get(kind)?.[key]
        ?? (key === 'profile' ? { interact: 'link', limit: 1 } : undefined),
    });
  }
  return facade;
}

// The channel package mounts routes only once. Stable facades keep every route
// present while credentials, verification, and transport can change live.
for (const kind of CHANNEL_KINDS) Agent.channel(kind, channelFacade(kind));
const DEFAULT_PRIMARY = {
  _id: 'constellation-agent-orchestrator',
  agent: 'orchestrator', displayName: 'Atlas', role: 'Orchestrator', avatar: 'A', color: 'amber', enabled: true, primary: true, order: 0,
  revision: 1,
  status: 'available',
  constitution: 'Be steady, candid, and accountable. Preserve human agency. Prefer reversible progress to confident theater. State uncertainty and never conceal consequential tradeoffs.',
  instructions: 'Treat the durable mission as the unit of work. Delegate when a specialist improves the result. State assumptions, keep progress legible, and stop at approval boundaries.',
  model: 'default', budget: { turns: 80, toolCalls: 40, spend: 5 },
  capabilities: { inspect: true, framing: true, memory: true, publish: true },
};
const DEFAULT_CREW = [
  {
    _id: 'constellation-agent-researcher',
    agent: 'researcher', displayName: 'Signal', role: 'Research', avatar: 'S', color: 'blue', enabled: true, order: 10,
    revision: 1,
    status: 'available',
    constitution: 'Be intellectually honest and curious. Follow evidence over consensus. Separate observation from inference and say when evidence is insufficient.',
    instructions: 'Research the assigned scope. Return compact evidence, meaningful uncertainty, and a recommendation. Distinguish verified sources from inference.',
    model: 'default', budget: { turns: 24, toolCalls: 8, spend: 1 },
    capabilities: { inspect: true, framing: false, memory: false, publish: false },
  },
  {
    _id: 'constellation-agent-operator',
    agent: 'operator', displayName: 'Relay', role: 'Operations', avatar: 'R', color: 'green', enabled: true, order: 20,
    revision: 1,
    status: 'available',
    constitution: 'Be dependable and calm under ambiguity. Protect reversibility, ownership, and follow-through. Never mistake activity for completion.',
    instructions: 'Convert decisions into bounded execution plans with owners, receipts, escalation conditions, and reversible steps.',
    model: 'default', budget: { turns: 24, toolCalls: 8, spend: 1 },
    capabilities: { inspect: true, framing: true, memory: false, publish: false },
  },
  {
    _id: 'constellation-agent-critic',
    agent: 'critic', displayName: 'Vela', role: 'Critic', avatar: 'V', color: 'red', enabled: true, order: 30,
    revision: 1,
    status: 'available',
    constitution: 'Be constructively skeptical, not cynical. Challenge ideas without diminishing people. Surface risk early and change your mind when evidence changes.',
    instructions: 'Review assumptions, ownership, irreversible risk, and decisions hidden inside prose. Return prioritized findings and concrete mitigations.',
    model: 'default', budget: { turns: 24, toolCalls: 8, spend: 1 },
    capabilities: { inspect: true, framing: false, memory: false, publish: false },
  },
];
const DEFAULT_AGENT_CONSTITUTION = 'Be candid, reliable, and respectful of human agency. State uncertainty, preserve reversibility, and never claim work you did not verify.';
const DEFAULT_CREW_CONFIGS = [DEFAULT_PRIMARY, ...DEFAULT_CREW];
const DEFAULT_CONSTITUTION_BY_AGENT = new Map(
  DEFAULT_CREW_CONFIGS.map((config) => [config.agent, config.constitution]),
);
const DEFAULT_SKILLS = [
  {
    name: 'Mission framing',
    slug: 'mission-framing',
    description: 'Structure outcomes, constraints, evidence, approvals, and done criteria.',
    content: 'Frame the mission in five lines: outcome, non-goals, evidence bar, irreversible actions requiring approval, and a testable definition of done. Then choose the smallest specialist crew that can move it forward.',
    enabled: true,
    agents: ['orchestrator', 'operator'],
  },
  {
    name: 'Decision brief',
    slug: 'decision-brief',
    description: 'Turn evidence and critique into a decision-ready brief.',
    content: 'Lead with the decision. Separate evidence from inference. Name the strongest counterargument, the reversible first move, the owner, and the next review point.',
    enabled: true,
    agents: ['orchestrator'],
  },
];
const DEFAULT_PULSES = [
  {
    name: 'Mission heartbeat',
    prompt: 'Inspect this mission for blockers and recommend the single highest-leverage next move. Do not repeat finished work.',
    agent: 'orchestrator',
    schedule: { kind: 'interval', every: 4, unit: 'hours' },
    enabled: true,
  },
  {
    name: 'Decision drift',
    prompt: 'Review the mission for stale assumptions, unresolved decisions, and work that no longer supports the stated outcome.',
    agent: 'critic',
    schedule: { kind: 'cron', expression: '0 9 * * 1' },
    enabled: true,
  },
  {
    name: 'Delivery watch',
    prompt: 'Check current execution receipts and surface missing owners, failed handoffs, or approval-bound work that needs attention.',
    agent: 'operator',
    schedule: { kind: 'interval', every: 30, unit: 'minutes' },
    enabled: true,
  },
];
let runtimeSkills = DEFAULT_SKILLS;

const lastUserText = (request) => String(
  [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '',
).toLowerCase();
const requestedTool = (request, name) => request.messages.some(
  (message) => message.toolCalls?.some((call) => call.name === name),
);
const lastTool = (request) => [...request.messages].reverse().find(
  (message) => message.role === 'tool',
);
let scriptedCall = 0;
const callId = (prefix) => `${prefix}-${++scriptedCall}`;

function orchestratorScript(request, profile) {
  const prompt = lastUserText(request);
  const used = (name) => requestedTool(request, name);
  const tool = lastTool(request);
  const isLaunch = /launch|go.to.market|positioning|campaign/.test(prompt);
  const isResearch = /research|compare|explore|evidence|open.source/.test(prompt);
  const isReview = /review|red.team|risk|skeptical|assumption/.test(prompt);
  const isHeartbeat = /heartbeat|blocker|highest.leverage|scheduled mission/.test(prompt);
  const isMemory = /remember|prefer|preference/.test(prompt);
  const isSkill = /choose a skill|mission framing|use a skill/.test(prompt);

  if (isMemory) {
    if (!used('memory_save')) {
      return {
        toolCalls: [{
          id: callId('memory'),
          name: 'memory_save',
          args: {
            text: 'The operator prefers direct, decision-oriented updates with assumptions stated explicitly.',
            scope: 'user',
            key: 'communication-style',
            pinned: true,
          },
        }],
      };
    }
    return { text: 'Remembered. Every agent in this workspace can now adapt to that preference because person memory follows you—not a particular model.' };
  }

  if (isSkill) {
    const selected = runtimeSkills.find(
      (skill) => skill.enabled && skill.agents?.includes('orchestrator'),
    );
    if (!selected) return { text: 'No enabled skill is assigned to Atlas.' };
    if (!used('skill')) {
      return { toolCalls: [{ id: callId('skill'), name: 'skill', args: { name: selected.slug } }] };
    }
    return {
      text: `Loaded ${selected.slug} on demand. I will apply its instructions to this mission before delegating.`,
    };
  }

  if (isHeartbeat) {
    if (!used('inspect_workspace')) {
      return { toolCalls: [{ id: callId('inspect'), name: 'inspect_workspace', args: { focus: 'blockers' } }] };
    }
    return {
      text: 'Heartbeat complete. The mission is healthy. Highest-leverage next move: decide the target segment before expanding deliverables; everything downstream is still sensitive to that choice.',
    };
  }

  if (isLaunch) {
    if (!used('researcher')) {
      return {
        text: 'I’ll turn this into a decision-ready launch mission. First I’m opening a dedicated research run.',
        toolCalls: [{
          id: callId('research'), name: 'researcher',
          args: { prompt: 'Research the market for a privacy-first team knowledge product. Identify the strongest category wedge, buyer tension, credible differentiation, and evidence that should shape positioning.' },
        }],
      };
    }
    if (!used('critic')) {
      return {
        text: 'The market wedge is promising. I’m asking the critic to attack the assumptions before anything leaves the workspace.',
        toolCalls: [{
          id: callId('critic'), name: 'critic',
          args: { prompt: 'Red-team this launch thesis: privacy-first team knowledge, positioned around useful recall without surveillance. Surface weak claims, adoption risks, and the decisions that need explicit owners.' },
        }],
      };
    }
    if (!used('publish_brief')) {
      return {
        text: 'The crew has converged. I prepared a concise launch brief and am applying this mission’s delivery policy before it leaves the workspace.',
        toolCalls: [{
          id: callId('publish'), name: 'publish_brief',
          args: {
            title: 'The Quiet Knowledge Layer — launch brief',
            audience: 'Product and go-to-market leads',
            summary: 'Lead with useful recall without surveillance; validate the security-conscious design-partner segment before widening the category claim.',
          },
        }],
      };
    }
    const denied = tool?.isError || /denied|refused/.test(String(tool?.content ?? '').toLowerCase());
    return denied ? {
      text: 'The brief remains a draft. Nothing was published. I can revise the positioning or narrow the audience before asking again.',
    } : {
      text: 'Launch brief published and attached. The recommendation is intentionally narrow: win security-conscious design partners with “useful recall without surveillance,” then expand once activation and trust are proven.',
    };
  }

  if (isResearch) {
    if (!used('researcher')) {
      return { toolCalls: [{ id: callId('research'), name: 'researcher', args: { prompt } }] };
    }
    return { text: `Research is back. The strongest pattern is to make durable state—not the LLM request—the center of the product. ${String(tool?.content ?? '').slice(0, 360)}` };
  }

  if (isReview) {
    if (!used('critic')) {
      return { toolCalls: [{ id: callId('critic'), name: 'critic', args: { prompt } }] };
    }
    return { text: `The critic found the pressure points. ${String(tool?.content ?? '').slice(0, 420)}` };
  }

  return {
    text: `I’m ${profile?.displayName ?? 'Atlas'}, the mission orchestrator. Give me an outcome and I can delegate research, route a red-team review, use typed tools, remember durable facts, and stop for your approval before consequential actions. Try the launch playbook to see the whole loop.`,
  };
}

function specialistScript(name, profile) {
  return (request) => {
    const prompt = lastUserText(request);
    if (name === 'researcher') {
      return {
        text: 'Research synthesis\n\n1. The category wedge is not “another knowledge base”; it is trusted recall for teams that reject surveillance-heavy AI.\n2. The first credible buyer is a security-conscious product or design org with fragmented decisions across chat, docs, and email.\n3. The strongest proof is operational: provenance, intentional forgetting, and explicit approval before knowledge becomes shared.\n\nRecommendation: lead with “useful recall without surveillance,” recruit 6–8 design partners, and measure time-to-recover-a-decision rather than documents indexed.',
      };
    }
    if (name === 'critic') {
      return {
        text: 'Red-team review\n\n• “Privacy-first” is table stakes unless the product makes control visible in the workflow.\n• Shared memory can become shared contamination; promotion needs an explicit human gate and provenance.\n• A broad knowledge-platform launch will diffuse urgency. Own one painful recovery moment first.\n\nThree decisions: target segment, proof metric, and who can promote a fact into shared work memory.',
      };
    }
    if (name === 'operator') {
      return {
        text: `Operator plan\n\nI translated the request into a bounded runbook: define the owner and success signal, execute the smallest reversible step, record receipts, and escalate only if the mission crosses an approval boundary.\n\nCurrent brief: ${prompt.slice(0, 180)}`,
      };
    }
    return {
      text: `${profile?.displayName ?? 'Specialist'} · ${profile?.role ?? 'Specialist'}\n\nScope: ${prompt.slice(0, 220)}\n\nRecommendation: state the decision, verify the highest-risk assumption, assign an owner, and take the smallest reversible next action.`,
    };
  };
}

/** Private request marker shared only by this app's hook and Provider wrapper.
 *  The wrapper removes it before delegating to the real Provider. */
export const MISSION_EXECUTION_SESSION = Symbol('constellation.missionSession');

export function withMissionExecutionContext(request, context) {
  return { ...request, [MISSION_EXECUTION_SESSION]: context.sessionId };
}

/** Paid work is fenced at the Provider boundary, after the framework has
 *  assembled the request and immediately before the underlying adapter runs.
 *  Generic framework hooks intentionally fail open; this app policy does not. */
export function missionScopedProvider(provider, agent) {
  return {
    ...(provider.capabilities ? { capabilities: provider.capabilities } : {}),
    async *stream(request) {
      const sessionId = request[MISSION_EXECUTION_SESSION];
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new Meteor.Error(
          'mission-context-missing',
          'Mission execution context is unavailable; provider work was not started.',
        );
      }
      await requireActiveMissionExecution(sessionId, agent);
      const providerRequest = { ...request };
      delete providerRequest[MISSION_EXECUTION_SESSION];
      yield* provider.stream(providerRequest);
    },
  };
}

let availableRuntimeModelIds = new Set([LOCAL_MODEL, model]);
let runtimeModelContextWindows = new Map();

function applyRuntimeModelCatalog(catalog) {
  availableRuntimeModelIds = modelIdsFromCatalog(catalog);
  live = (catalog.providers ?? []).some((provider) => provider.kind === 'cloud');
  runtimeModelContextWindows = new Map((catalog.providers ?? []).flatMap(
    (provider) => (provider.models ?? [])
      .filter((entry) => Number.isFinite(entry.contextWindow))
      .map((entry) => [entry.id, entry.contextWindow]),
  ));
}

export function boundedAgentContextWindow(discovered) {
  return Number.isFinite(discovered)
    ? Math.max(1024, Math.min(120000, Math.floor(discovered * 0.8)))
    : 120000;
}

function contextForModel(configuredModel) {
  const modelId = configuredModel === 'default' ? model : configuredModel;
  const discovered = runtimeModelContextWindows.get(modelId);
  return { window: boundedAgentContextWindow(discovered), compactAt: 0.72, keep: 8 };
}

const liveProvider = offline ? null : piAiProvider();
const providerFor = (name, profile) => {
  const requestedModel = profile?.model === 'default' ? model : profile?.model;
  if (requestedModel !== LOCAL_MODEL && !availableRuntimeModelIds.has(requestedModel)) {
    return missionScopedProvider({
      capabilities: { imageInput: async () => false },
      async *stream() {
        const error = new Meteor.Error(
          'model-unavailable',
          `The configured model "${requestedModel}" is unavailable. Configure its provider credentials or choose another model.`,
        );
        error.retryable = false;
        throw error;
      },
    }, name);
  }
  const localOllama = requestedModel?.startsWith('ollama/') ? ollamaProvider : null;
  if (localOllama) return missionScopedProvider(localOllama, name);
  const scripted = requestedModel === LOCAL_MODEL || !liveProvider;
  return missionScopedProvider(scripted ? mockProvider(
    name === 'orchestrator' ? (request) => orchestratorScript(request, profile) : specialistScript(name, profile),
  ) : liveProvider, name);
};

const commonBudget = {
  turns: 80,
  systemTurns: 24,
  toolCalls: 40,
  approval: 10 * 60 * 1000,
  relay: 8,
  spend: '$5.00',
};
const DEFAULT_MISSION_BUDGET = Object.freeze({ turns: 80, toolCalls: 40, spend: 5 });

function workspaceInspectionTool() {
  return {
    name: 'inspect_workspace',
    description: 'Read a bounded operational snapshot of the current local mission.',
    args: {
      type: 'object',
      properties: { focus: { type: 'string' } },
      required: ['focus'],
    },
    run: async ({ focus }, context) => {
      const session = await AgentSessions.findOneAsync({ _id: context.sessionId });
      if (!session) return 'Mission no longer exists.';
      const root = await rootMissionSession(context.sessionId);
      const mission = root
        ? await MissionConfigs.findOneAsync({ _id: root._id, userId: root.userId })
        : null;
      return JSON.stringify({
        focus,
        objective: mission?.objective || null,
        missionStatus: mission?.status ?? 'active',
        primaryAgent: mission?.primaryAgent ?? 'orchestrator',
        continuity: mission?.continuity ?? true,
        approvals: mission?.approvals ?? true,
        budget: mission?.budget ?? DEFAULT_MISSION_BUDGET,
        phase: session.phase,
        turns: session.budgetSpent.turns,
        systemTurns: session.budgetSpent.systemTurns ?? 0,
        toolCalls: session.budgetSpent.toolCalls,
        hasPendingApproval: !!session.pending,
        activeChild: session.activeChild?.sessionId ?? null,
      });
    },
  };
}

function publishBriefTool() {
  return {
    name: 'publish_brief',
    description: 'Publish a reviewed mission brief as a downloadable Markdown attachment under the Mission approval policy.',
    args: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        audience: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['title', 'audience', 'summary'],
    },
    gate: async ({ sessionId, userId }) => {
      const root = await rootMissionSession(sessionId);
      const mission = root
        ? await MissionConfigs.findOneAsync({ _id: root._id, userId: root.userId })
        : null;
      if (!root || root.userId !== userId || !mission) return false;
      return mission.approvals === false ? true : 'ask';
    },
    describe: ({ title, audience }) => `Publish “${title}” for ${audience} as a downloadable mission brief`,
    run: async ({ title, audience, summary }, context) => {
      const markdown = [
        `# ${title}`,
        '',
        `**Audience:** ${audience}`,
        '',
        '## Recommendation',
        '',
        summary,
        '',
        '## Decision record',
        '',
        '- Lead with useful recall without surveillance.',
        '- Validate with a narrow design-partner segment.',
        '- Keep shared-memory promotion human-approved and provenance-visible.',
        '',
        '_Prepared by the Constellation crew using meteor-agent rc1._',
      ].join('\n');
      const ref = await Agent.attachments.create({
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        name: 'constellation-launch-brief.md',
        contentType: 'text/markdown',
        content: markdown,
        attach: true,
      });
      return `Published ${ref.name} (${ref.size} bytes).`;
    },
  };
}

function skillsForAgent(skills, config) {
  return skills
    .filter((skill) => skill.enabled && skill.agents?.includes(config.agent))
    .map((skill) => ({
      name: skill.slug,
      description: skill.description,
      content: skill.content,
    }));
}

function mcpToolsForAgent(agent) {
  return runtimeMcpToolsByAgent.get(agent) ?? [];
}

function defineCrewAgent(config, skills = runtimeSkills) {
  const tools = [];
  if (config.capabilities?.inspect) tools.push(workspaceInspectionTool());
  if (config.capabilities?.publish) tools.push(publishBriefTool());
  tools.push(...mcpToolsForAgent(config.agent));
  const provider = providerFor(config.agent, config);
  const assignedSkills = skillsForAgent(skills, config);
  new Agent(config.agent, {
    model: config.model && config.model !== 'default' ? config.model : model,
    instructions: config.instructions,
    identity: {
      id: config._id,
      displayName: config.displayName,
      constitution: config.constitution,
      flexibility: config.flexibility ?? DEFAULT_CREW_FLEXIBILITY,
    },
    experience: frameworkExperienceConfig(config.experience),
    practice: frameworkPracticeConfig(config.practice),
    startable: false,
    budget: {
      turns: config.budget?.turns ?? 24,
      toolCalls: config.budget?.toolCalls ?? 8,
      spend: `$${Number(config.budget?.spend ?? 1).toFixed(2)}`,
    },
    // Re-check host lifecycle at dispatch time. Archiving an Agent may race an
    // already-streaming response; no consequential Tool side effect may start
    // after the durable archive fence lands.
    canUse: (tool, context) => configuredToolEntitlement(tool, context, config.agent),
    // Mission participants can converse with every Crew member, but only the
    // local workspace owner may grant a consequential Tool or learning write.
    approve: workspaceOwnerCanApprove,
    tools,
    ...(assignedSkills.length ? { skills: assignedSkills } : {}),
    ...(config.capabilities?.memory ? { memory: { scopes: ['user', 'app'] } } : {}),
    context: contextForModel(config.model),
    ...(provider ? { provider } : {}),
  });
}

for (const config of DEFAULT_CREW) defineCrewAgent(config, DEFAULT_SKILLS);

const orchestrator = new Agent('orchestrator');
function defineOrchestrator(crew, primary = DEFAULT_PRIMARY, skills = runtimeSkills) {
  const provider = providerFor('orchestrator', primary);
  const coreTools = [];
  if (primary.capabilities?.inspect) coreTools.push(workspaceInspectionTool());
  if (primary.capabilities?.publish) coreTools.push(publishBriefTool());
  const assignedSkills = skillsForAgent(skills, primary);
  orchestrator.define({
    model: primary.model && primary.model !== 'default' ? primary.model : model,
    instructions: primary.instructions,
    identity: {
      id: primary._id,
      displayName: primary.displayName,
      constitution: primary.constitution,
      flexibility: primary.flexibility ?? DEFAULT_CREW_FLEXIBILITY,
    },
    experience: frameworkExperienceConfig(primary.experience),
    practice: frameworkPracticeConfig(primary.practice),
    tools: [
      ...crew.filter(
        (config) => config.enabled && config.status !== 'archived',
      ).map((config) => ({
        subagent: config.agent,
        description: `Delegate a focused ${config.role.toLowerCase()} run to ${config.displayName}.`,
        // Agent definitions are process-wide, while Mission Crew membership is
        // per root session. The gate is the runtime fence that keeps an archived
        // specialist from remaining callable through its still-listed tool.
        gate: (context) => missionAllowsAgent(context, config.agent),
      })),
      ...coreTools,
      ...mcpToolsForAgent('orchestrator'),
    ],
    ...(assignedSkills.length ? { skills: assignedSkills } : {}),
    ...(primary.capabilities?.memory ? { memory: { scopes: ['user', 'app'], hints: { minScore: 0.55 }, index: { pinned: 6, recent: 8 } } } : {}),
    budget: {
      ...commonBudget,
      turns: primary.budget?.turns ?? commonBudget.turns,
      toolCalls: primary.budget?.toolCalls ?? commonBudget.toolCalls,
      spend: `$${Number(primary.budget?.spend ?? 5).toFixed(2)}`,
    },
    context: contextForModel(primary.model),
    // Definitions are process-wide and a Turn can outlive a control-panel
    // edit. Resolve the exact current entitlement again at every dispatch
    // boundary; approval can authorize a call, but can never restore access.
    canUse: (tool, context) => configuredToolEntitlement(tool, context, primary.agent),
    // Mission participants may contribute to the conversation, but only the
    // local workspace owner can grant authority for a consequential call.
    approve: workspaceOwnerCanApprove,
    ...(provider ? { provider } : {}),
  });
}
defineOrchestrator(DEFAULT_CREW, DEFAULT_PRIMARY, DEFAULT_SKILLS);

export async function workspaceOwnerCanApprove({ userId }) {
  if (!userId) return false;
  return !!await WorkspaceState.findOneAsync(
    { _id: 'local', ownerUserId: userId },
    { fields: { _id: 1 } },
  );
}

async function claimWorkspace(userId) {
  if (!userId) throw new Meteor.Error('not-authorized', 'A local workspace identity is required.');
  let state = await WorkspaceState.findOneAsync('local');
  if (!state) {
    try {
      await WorkspaceState.insertAsync({ _id: 'local', ownerUserId: userId, createdAt: new Date() });
    } catch {
      // A second local window may have claimed the singleton concurrently.
    }
    state = await WorkspaceState.findOneAsync('local');
  }
  if (!state || state.ownerUserId !== userId) {
    throw new Meteor.Error('workspace-owned', 'This desktop workspace belongs to another local account.');
  }
  return state;
}

let baseModelCatalogPromise;
let ollamaProvider = null;

async function configureOllamaProvider(ollamaModels) {
  if (ollamaModels.length === 0) return null;
  const [{ createModels, createProvider }, { openAICompletionsApi }] = await Promise.all([
    loadPiAi(),
    loadPiAi('api/openai-completions.lazy'),
  ]);
  const models = createModels();
  models.setProvider(createProvider({
    id: 'ollama',
    name: 'Ollama',
    baseUrl: OLLAMA_OPENAI_URL,
    auth: {
      apiKey: {
        name: 'Local Ollama',
        // The OpenAI SDK requires a non-empty key even though Ollama ignores
        // authentication. This fixed sentinel is scoped to the loopback-only
        // provider and is never published or sourced from user credentials.
        resolve: async () => ({ auth: { apiKey: 'ollama' }, source: 'Local Ollama' }),
      },
    },
    models: ollamaModels,
    api: openAICompletionsApi(),
  }));
  return createPiAiProvider(async () => models);
}

async function loadBaseModelCatalog() {
  if (baseModelCatalogPromise) return baseModelCatalogPromise;
  baseModelCatalogPromise = (async () => {
    if (offline) {
      ollamaProvider = null;
      const catalog = buildModelCatalog({ offline: true });
      applyRuntimeModelCatalog(catalog);
      model = catalog.defaultModel;
      return catalog;
    }
    try {
      const [ollamaModels, { builtinModels }] = await Promise.all([
        detectOllamaModels({
          enabled: !(Meteor.isTest || Meteor.isAppTest
            || process.env.NODE_ENV === 'test' || process.env.TEST_BROWSER_DRIVER),
        }),
        loadPiAi('providers/all'),
      ]);
      ollamaProvider = await configureOllamaProvider(ollamaModels);
      const models = builtinModels();
      const networkDiscoveryEnabled = !(Meteor.isTest || Meteor.isAppTest
        || process.env.NODE_ENV === 'test' || process.env.TEST_BROWSER_DRIVER);
      await refreshRadiusModels({ models, enabled: networkDiscoveryEnabled });
      const providerLabels = Object.fromEntries(
        models.getProviders().map((provider) => [provider.id, provider.name]),
      );
      const knownModels = models.getModels();
      // PROVIDER_API_KEY is an explicit adapter override. pi-ai cannot infer
      // its provider from the value, so preserve the app's historical
      // Anthropic convention without ever inspecting or publishing that key.
      const hasGenericProviderKey = typeof process.env.PROVIDER_API_KEY === 'string'
        && process.env.PROVIDER_API_KEY.trim().length > 0;
      const authenticatedModels = (await Promise.all(models.getProviders().map(
        (provider) => models.getAvailable(provider.id).catch(() => []),
      ))).flat();
      // The generic key augments authoritative provider discovery; it must not
      // hide another provider whose own credentials are also configured.
      let cloudModels = [...new Map([
        ...authenticatedModels,
        ...(hasGenericProviderKey ? models.getModels('anthropic') : []),
      ].map((entry) => [`${entry.provider}/${entry.id}`, entry])).values()];
      // pi-ai can resolve an Azure key without the endpoint information its
      // request adapter also requires. Do not offer those models prematurely.
      const azureEndpointReady = !!(
        process.env.AZURE_OPENAI_BASE_URL?.trim()
        || process.env.AZURE_OPENAI_RESOURCE_NAME?.trim()
      );
      if (!azureEndpointReady) {
        cloudModels = cloudModels.filter((entry) => entry.provider !== 'azure-openai-responses');
      }
      providerLabels.ollama = 'Ollama';
      const catalog = buildModelCatalog({
        availableModels: [...cloudModels, ...ollamaModels],
        knownModels: [...knownModels, ...ollamaModels],
        providerLabels,
        providerKinds: { ollama: 'local' },
        offline,
      });
      applyRuntimeModelCatalog(catalog);
      model = catalog.defaultModel;
      return catalog;
    } catch (error) {
      console.warn('[constellation] Model catalog unavailable; using local model:', error?.message ?? error);
      const catalog = buildModelCatalog({ offline: true });
      applyRuntimeModelCatalog(catalog);
      model = catalog.defaultModel;
      ollamaProvider = null;
      return catalog;
    }
  })();
  // A transient module/auth failure should not poison every future bootstrap.
  baseModelCatalogPromise.catch(() => { baseModelCatalogPromise = null; });
  return baseModelCatalogPromise;
}

export async function modelCatalogView(userId) {
  const base = await loadBaseModelCatalog();
  if (!userId) return base;
  const savedModels = (await CrewConfigs.find(
    { userId }, { fields: { model: 1 }, limit: 12 },
  ).fetchAsync()).map((config) => config.model);
  // Rebuild only when an unavailable saved choice needs annotating. Available
  // choices and the default are process-scoped because environment keys can
  // change only after an app restart.
  const unavailable = [...new Set(savedModels)].filter(
    (saved) => saved && saved !== 'default' && !modelIdsFromCatalog(base).has(saved),
  );
  if (unavailable.length === 0) return base;
  return {
    ...base,
    unavailableModels: unavailable.map((id) => {
      const slash = id.indexOf('/');
      const providerId = slash > 0 ? id.slice(0, slash) : 'unknown';
      return {
        id,
        label: slash > 0 ? id.slice(slash + 1) : id,
        providerId,
        providerLabel: providerId,
        reason: 'Provider credentials are not configured.',
      };
    }),
  };
}

async function runtimeCrewConfigs(configs, userId) {
  const catalog = await modelCatalogView(userId);
  return configs.map((config) => ({
    ...config,
    model: effectiveCrewModel(config.model, catalog),
  }));
}

async function ensureSkillConfigs(userId) {
  const state = await SkillStates.findOneAsync({ userId });
  if (!state) {
    for (const defaults of DEFAULT_SKILLS) {
      const existing = await SkillConfigs.findOneAsync({ userId, slug: defaults.slug });
      if (!existing) {
        await SkillConfigs.insertAsync({
          ...defaults,
          userId,
          revision: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
    await SkillStates.insertAsync({ userId, initializedAt: new Date() });
  }
  runtimeSkills = await SkillConfigs.find(
    { userId }, { sort: { name: 1, createdAt: 1 } },
  ).fetchAsync();
  return runtimeSkills;
}

function inferredCrewStatus(config) {
  if (config.archivedAt || config.status === 'archived') return 'archived';
  return config.enabled === false ? 'unavailable' : 'available';
}

function crewExperienceConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const recent = Number.isSafeInteger(source.recent)
    && source.recent >= 0 && source.recent <= EXPERIENCE_RECALL_MAX
    ? source.recent : DEFAULT_CREW_EXPERIENCE.recent;
  return {
    record: source.record !== false,
    recall: source.recall !== false && recent > 0,
    recent,
    scope: EXPERIENCE_SCOPES.has(source.scope)
      ? source.scope : DEFAULT_CREW_EXPERIENCE.scope,
    approval: LEARNING_APPROVALS.has(source.approval)
      ? source.approval : DEFAULT_CREW_EXPERIENCE.approval,
  };
}

function crewPracticeConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    acquire: source.acquire === true,
    approval: LEARNING_APPROVALS.has(source.approval)
      ? source.approval : DEFAULT_CREW_PRACTICE.approval,
    allowScopedEvidencePromotion: source.allowScopedEvidencePromotion === true,
  };
}

function frameworkExperienceConfig(value) {
  const config = crewExperienceConfig(value);
  return {
    record: config.record,
    recall: config.recall && config.recent > 0 ? { recent: config.recent } : false,
    scope: config.scope,
    approval: config.approval,
  };
}

function frameworkPracticeConfig(value) {
  const config = crewPracticeConfig(value);
  return {
    acquire: config.acquire,
    approval: config.approval,
    allowScopedEvidencePromotion: config.allowScopedEvidencePromotion,
  };
}

function initialCrewConstitution(config) {
  return DEFAULT_CONSTITUTION_BY_AGENT.get(config.agent) ?? DEFAULT_AGENT_CONSTITUTION;
}

async function backfillCrewConfigs(userId) {
  const configs = await CrewConfigs.find({ userId }).fetchAsync();
  const updates = [];
  const observed = (field, value) => (
    value === undefined ? { [field]: { $exists: false } } : { [field]: value }
  );
  for (const config of configs) {
    // `_id` is the durable Agent identity. Legacy rows are enriched in place;
    // migration must never exchange that identity for a deterministic default.
    if (!Number.isSafeInteger(config.revision) || config.revision < 1) {
      updates.push(CrewConfigs.updateAsync(
        { _id: config._id, userId, ...observed('revision', config.revision) },
        { $set: { revision: 1 } },
      ));
    }
    if (!CREW_STATUSES.has(config.status)) {
      updates.push(CrewConfigs.updateAsync(
        { _id: config._id, userId, ...observed('status', config.status) },
        { $set: { status: inferredCrewStatus(config) } },
      ));
    }
    if (typeof config.constitution !== 'string' || !config.constitution.trim()) {
      updates.push(CrewConfigs.updateAsync(
        { _id: config._id, userId, ...observed('constitution', config.constitution) },
        { $set: { constitution: initialCrewConstitution(config) } },
      ));
    }
    const experience = crewExperienceConfig(config.experience);
    if (JSON.stringify(config.experience) !== JSON.stringify(experience)) {
      updates.push(CrewConfigs.updateAsync(
        { _id: config._id, userId, ...observed('experience', config.experience) },
        { $set: { experience } },
      ));
    }
    const practice = crewPracticeConfig(config.practice);
    if (JSON.stringify(config.practice) !== JSON.stringify(practice)) {
      updates.push(CrewConfigs.updateAsync(
        { _id: config._id, userId, ...observed('practice', config.practice) },
        { $set: { practice } },
      ));
    }
    if (!Number.isSafeInteger(config.flexibility)
      || config.flexibility < 0 || config.flexibility > 1000) {
      updates.push(CrewConfigs.updateAsync(
        { _id: config._id, userId, ...observed('flexibility', config.flexibility) },
        { $set: { flexibility: DEFAULT_CREW_FLEXIBILITY } },
      ));
    }
  }
  await Promise.all(updates);
}

// Stable idempotency-key namespace for every learning mutation this app
// issues. Changing it would orphan replay adoption of in-flight commands.
const LEARNING_SOURCE_NS = 'constellation';

async function syncCrewLearningIdentity(config) {
  await Agent.learning.ensureIdentity({
    id: config._id,
    name: config.agent,
    displayName: config.displayName,
    constitution: config.constitution,
    flexibility: config.flexibility ?? DEFAULT_CREW_FLEXIBILITY,
  });
  const identity = await Agent.learning.read.identities([config._id]).fetchAsync().then((rows) => rows[0]);
  if (!identity) throw new Error(`[constellation] Agent Identity ${config._id} was not created`);
  const lifecycle = config.status === 'archived' ? 'archived' : 'active';
  if (identity.lifecycle !== lifecycle) {
    await Agent.learning.setLifecycle(
      config._id,
      identity.generation,
      lifecycle,
      hostLearningSource(LEARNING_SOURCE_NS, 'lifecycle', config._id, {
        lifecycle, revision: config.revision,
      }),
    );
  }
}

async function ownedLearningIdentity(userId, agentId, { active = false } = {}) {
  if (!userId) throw new Meteor.Error('not-authorized', 'Sign in to manage Agent learning.');
  const config = await CrewConfigs.findOneAsync({
    _id: agentId,
    userId,
    ...(active ? { status: { $ne: 'archived' } } : {}),
  });
  if (!config) throw new Meteor.Error('not-authorized', 'Agent Identity is not in this workspace.');
  return config;
}

async function ensureCrewConfigs(userId, { reconcileArchives = true } = {}) {
  const state = await CrewStates.findOneAsync({ userId });
  if (!state) {
    for (const defaults of DEFAULT_CREW_CONFIGS) {
      const existing = await CrewConfigs.findOneAsync({ userId, agent: defaults.agent });
      if (!existing) {
        await CrewConfigs.insertAsync({ ...defaults, userId, createdAt: new Date(), updatedAt: new Date() });
      }
    }
    await CrewStates.insertAsync({ userId, initializedAt: new Date() });
  }
  if (!await CrewConfigs.findOneAsync({ userId, agent: 'orchestrator' })) {
    await CrewConfigs.insertAsync({ ...DEFAULT_PRIMARY, userId, createdAt: new Date(), updatedAt: new Date() });
  }
  await backfillCrewConfigs(userId);
  if (reconcileArchives) await reconcilePendingCrewArchives(userId);
  const configs = await CrewConfigs.find({ userId }, { sort: { order: 1, createdAt: 1 } }).fetchAsync();
  for (const config of configs) await syncCrewLearningIdentity(config);
  const effectiveConfigs = await runtimeCrewConfigs(configs, userId);
  const skills = await ensureSkillConfigs(userId);
  const primary = effectiveConfigs.find((config) => config.agent === 'orchestrator') ?? DEFAULT_PRIMARY;
  const specialists = effectiveConfigs.filter(
    (config) => config.agent !== 'orchestrator' && config.status !== 'archived',
  );
  for (const config of specialists) defineCrewAgent(config, skills);
  defineOrchestrator(specialists, primary, skills);
  await syncCodeToolCatalog(userId);
  return configs;
}

async function syncCrewSession(userId, sessionId, preparedConfigs) {
  const configs = preparedConfigs ?? await ensureCrewConfigs(userId);
  const primary = configs.find((config) => config.agent === 'orchestrator') ?? DEFAULT_PRIMARY;
  const missionConfig = await MissionConfigs.findOneAsync(
    { _id: sessionId, userId }, { fields: { agents: 1 } },
  );
  // `agents` absent is the backwards-compatible workspace-inherited mode.
  // Once a Mission is edited through missionAgentAdd/Remove, its explicit
  // selection remains stable when the Workspace Crew later changes.
  const selectedAgents = Array.isArray(missionConfig?.agents)
    ? new Set(missionConfig.agents) : null;
  const enabled = configs.filter((config) => (
    config.agent !== 'orchestrator'
      && config.enabled
      && config.status !== 'archived'
      && (!selectedAgents || selectedAgents.has(config.agent))
  ));
  const desired = new Set(enabled.map((config) => modelParticipantId(config.agent)));
  const participants = await Agent.participants.list(sessionId);
  for (const participant of participants) {
    if (participant.kind === 'model' && participant.agent !== 'orchestrator' && !desired.has(participant.id)) {
      await Agent.participants.remove(sessionId, participant.id);
    }
  }
  const primaryId = modelParticipantId('orchestrator');
  const primaryParticipant = participants.find((participant) => participant.id === primaryId);
  if (primaryParticipant && primaryParticipant.displayName !== primary.displayName) {
    await Agent.participants.remove(sessionId, primaryId);
  }
  await Agent.participants.add(sessionId, {
    id: primaryId,
    kind: 'model',
    role: 'member',
    agent: 'orchestrator',
    displayName: primary.displayName,
  }, { ownerName: 'You', by: primaryId });
  for (const config of enabled) {
    const participantId = modelParticipantId(config.agent);
    const existing = participants.find((participant) => participant.id === participantId);
    if (existing && existing.displayName !== config.displayName) {
      await Agent.participants.remove(sessionId, participantId);
    }
    await Agent.participants.add(sessionId, {
      id: participantId,
      kind: 'model',
      role: 'member',
      agent: config.agent,
      displayName: config.displayName,
    }, { ownerName: 'You', by: modelParticipantId('orchestrator') });
  }
  return Agent.participants.list(sessionId);
}

async function workspaceMissionSessions(userId) {
  return AgentSessions.find(
    {
      userId,
      agent: 'orchestrator',
      erasingAt: { $exists: false },
    },
    { fields: { _id: 1, title: 1, phase: 1, activeChild: 1 }, sort: { updatedAt: -1 } },
  ).fetchAsync();
}

async function syncCrewAcrossMissions(userId, preparedConfigs) {
  const configs = preparedConfigs ?? await ensureCrewConfigs(userId);
  const sessions = await workspaceMissionSessions(userId);
  // Keep roster updates bounded for workspaces with a long Mission history.
  for (let offset = 0; offset < sessions.length; offset += 12) {
    await Promise.all(sessions.slice(offset, offset + 12).map(
      (session) => reconcileConfiguredMissionCrew(userId, session._id, configs),
    ));
  }
  return sessions;
}

async function removeCrewParticipantEverywhere(userId, agent) {
  const participantId = modelParticipantId(agent);
  const sessions = await AgentSessions.find(
    {
      userId,
      erasingAt: { $exists: false },
      participants: { $elemMatch: { id: participantId } },
    },
    { fields: { _id: 1 } },
  ).fetchAsync();
  // Bound concurrent roster writes: a workspace may contain many Missions,
  // while every removed participant also clears its channel bindings.
  for (let offset = 0; offset < sessions.length; offset += 20) {
    await Promise.all(sessions.slice(offset, offset + 20).map(
      (session) => Agent.participants.remove(session._id, participantId),
    ));
  }
}

async function finalizeCrewArchive(userId, config) {
  // The Crew lifecycle fence is already durable. Revoke any parked approval
  // owned by this Agent before detaching its references so a Mission cannot
  // remain permanently awaiting a participant that no longer exists.
  await abandonPendingAgentTurns(config.agent, userId);
  await Promise.all([
    SkillConfigs.updateAsync(
      { userId, agents: config.agent },
      { $pull: { agents: config.agent }, $inc: { revision: 1 }, $set: { updatedAt: new Date() } },
      { multi: true },
    ),
    McpConfigs.updateAsync(
      { userId, managed: 'workspace', agents: config.agent },
      { $pull: { agents: config.agent }, $inc: { revision: 1 }, $set: { updatedAt: new Date() } },
      { multi: true },
    ),
    ToolCatalog.updateAsync(
      {
        userId,
        source: 'workspace-mcp',
        $or: [{ agents: config.agent }, { assignedAgents: config.agent }],
      },
      {
        $pull: { agents: config.agent, assignedAgents: config.agent },
        $set: { updatedAt: new Date() },
      },
      { multi: true },
    ),
    PulseConfigs.updateAsync(
      { userId, agent: config.agent },
      {
        $set: {
          agent: 'orchestrator',
          enabled: false,
          lastStatus: 'error',
          lastErrorCode: 'agent-archived',
          updatedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
      { multi: true },
    ),
    MissionConfigs.updateAsync(
      { userId, agents: config.agent },
      {
        $pull: { agents: config.agent },
        $inc: { revision: 1 },
        $set: { updatedAt: new Date() },
      },
      { multi: true },
    ),
  ]);
  await removeCrewParticipantEverywhere(userId, config.agent);
  // Rebuilding Agent definitions normally re-enters ensureCrewConfigs. Skip
  // archive reconciliation in that nested pass or this still-pending marker
  // would recursively finalize itself before it can be cleared.
  const configs = await rebuildMcpToolAssignments(userId, { reconcileArchives: false });
  await syncCrewAcrossMissions(userId, configs);

  // The marker is the durable receipt for this idempotent reconciliation. It
  // is cleared last so a process crash at any earlier await is recovered by
  // the next workspace bootstrap/ensure pass.
  await CrewConfigs.updateAsync(
    {
      _id: config._id,
      userId,
      agent: config.agent,
      status: 'archived',
      archiveCleanupPending: true,
    },
    {
      $unset: { archiveCleanupPending: '', archiveCleanupStartedAt: '' },
      $set: { archiveCleanupCompletedAt: new Date() },
    },
  );
}

async function reconcilePendingCrewArchives(userId) {
  const pending = await CrewConfigs.find(
    { userId, status: 'archived', archiveCleanupPending: true },
    { sort: { archivedAt: 1, _id: 1 } },
  ).fetchAsync();
  for (const config of pending) await finalizeCrewArchive(userId, config);
}

async function crewArchiveImpact(userId, config) {
  const [missionConfigs, skills, mcpServers, pulses] = await Promise.all([
    MissionConfigs.find(
      { userId },
      { fields: { _id: 1, title: 1, status: 1, agents: 1, revision: 1 } },
    ).fetchAsync(),
    SkillConfigs.find(
      { userId, agents: config.agent },
      { fields: { _id: 1, name: 1, enabled: 1, revision: 1 }, sort: { name: 1 } },
    ).fetchAsync(),
    McpConfigs.find(
      { userId, managed: 'workspace', agents: config.agent },
      {
        fields: { _id: 1, name: 1, enabled: 1, status: 1, revision: 1 },
        sort: { name: 1 },
      },
    ).fetchAsync(),
    PulseConfigs.find(
      { userId, agent: config.agent },
      {
        fields: { _id: 1, name: 1, sessionId: 1, enabled: 1, revision: 1 },
        sort: { name: 1 },
      },
    ).fetchAsync(),
  ]);
  const configuredMissionIds = missionConfigs
    .filter((mission) => mission.agents?.includes(config.agent))
    .map((mission) => mission._id);
  const sessionSelectors = [
    { participants: { $elemMatch: { kind: 'model', agent: config.agent } } },
    { 'pending.agent': config.agent },
  ];
  if (configuredMissionIds.length) sessionSelectors.push({ _id: { $in: configuredMissionIds } });
  const sessions = await AgentSessions.find(
    {
      userId,
      agent: 'orchestrator',
      erasingAt: { $exists: false },
      $or: sessionSelectors,
    },
    {
      fields: {
        _id: 1, title: 1, phase: 1, activeChild: 1, participants: 1, pending: 1,
      },
      sort: { updatedAt: -1 },
    },
  ).fetchAsync();
  const missionById = new Map(missionConfigs.map((mission) => [mission._id, mission]));
  const sessionById = new Map(sessions.map((session) => [session._id, session]));
  const affectedMissionIds = new Set([...configuredMissionIds, ...sessions.map((row) => row._id)]);
  const missionRows = [...affectedMissionIds].map((id) => {
    const session = sessionById.get(id);
    const mission = missionById.get(id);
    const pending = session?.pending?.agent === config.agent ? session.pending : null;
    return {
      id,
      name: mission?.title ?? session?.title ?? 'Untitled mission',
      status: mission?.status ?? 'active',
      revision: Number.isSafeInteger(mission?.revision) ? mission.revision : null,
      configured: !!mission?.agents?.includes(config.agent),
      participant: !!session?.participants?.some(
        (participant) => participant.kind === 'model' && participant.agent === config.agent,
      ),
      phase: session?.phase ?? null,
      active: ['streaming', 'calling', 'retrying', 'compacting'].includes(session?.phase),
      awaitingApproval: session?.phase === 'awaiting' && !!pending,
      pendingTool: pending?.name,
      pendingToolCallId: pending?.toolCallId,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const skillRows = skills.map((skill) => ({
    id: skill._id, name: skill.name, enabled: skill.enabled, revision: skill.revision ?? null,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const mcpRows = mcpServers.map((server) => ({
    id: server._id,
    name: server.name,
    enabled: server.enabled,
    status: server.status,
    revision: server.revision ?? null,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const pulseRows = pulses.map((pulse) => ({
    id: pulse._id,
    name: pulse.name,
    enabled: pulse.enabled,
    revision: pulse.revision ?? null,
    missionId: pulse.sessionId,
    missionName: missionById.get(pulse.sessionId)?.title
      ?? sessionById.get(pulse.sessionId)?.title
      ?? 'Unavailable mission',
  })).sort((left, right) => left.id.localeCompare(right.id));
  const snapshot = {
    configId: config._id,
    agent: config.agent,
    displayName: config.displayName,
    configRevision: config.revision,
    missions: missionRows,
    skills: skillRows,
    mcpServers: mcpRows,
    pulses: pulseRows,
  };
  return {
    ...snapshot,
    digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
  };
}

async function archiveCrewConfig(
  userId, configId, expectedAgent, expectedRevision, expectedImpactDigest,
) {
  await backfillCrewConfigs(userId);
  let config = await CrewConfigs.findOneAsync({ _id: configId, userId });
  if (!config) throw new Meteor.Error('no-agent', 'Crew agent not found.');
  if (config.agent === 'orchestrator') {
    throw new Meteor.Error('primary-agent', 'The primary Agent cannot be archived.');
  }
  if (config.agent !== expectedAgent) {
    throw new Meteor.Error('stale-agent', 'Agent changed while the archive dialog was open.');
  }

  if (config.status !== 'archived') {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Meteor.Error('invalid-crew', 'Archive requires the Agent revision shown in the impact dialog.');
    }
    if (typeof expectedImpactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedImpactDigest)) {
      throw new Meteor.Error('invalid-crew', 'Archive requires a valid impact receipt.');
    }
    if (config.revision !== expectedRevision) {
      throw new Meteor.Error('stale-agent', 'This Agent changed while the archive dialog was open.');
    }
    const currentImpact = await crewArchiveImpact(userId, config);
    if (currentImpact.digest !== expectedImpactDigest) {
      throw new Meteor.Error(
        'stale-impact',
        'Archive impact changed. Review the updated Missions and assignments before archiving.',
      );
    }
    const archivedAt = new Date();
    const archivedBy = humanParticipantId(userId);
    const archived = await CrewConfigs.updateAsync(
      {
        _id: configId,
        userId,
        agent: config.agent,
        revision: expectedRevision,
        status: { $ne: 'archived' },
      },
      {
        $set: {
          enabled: false,
          status: 'archived',
          archivedAt,
          archivedBy,
          archiveCleanupPending: true,
          archiveCleanupStartedAt: archivedAt,
          updatedAt: archivedAt,
        },
        $inc: { revision: 1 },
      },
    );
    if (archived !== 1) {
      const winner = await CrewConfigs.findOneAsync({ _id: configId, userId });
      if (!winner || winner.agent !== config.agent || winner.status !== 'archived') {
        throw new Meteor.Error('stale-agent', 'This Agent changed before it could be archived.');
      }
      config = winner;
    } else {
      config = {
        ...config,
        enabled: false,
        status: 'archived',
        archivedAt,
        archivedBy,
        archiveCleanupPending: true,
        archiveCleanupStartedAt: archivedAt,
        revision: config.revision + 1,
        updatedAt: archivedAt,
      };
    }
  }

  await syncCrewLearningIdentity(config);
  // Archival is visible before cleanup starts, so every dynamic execution
  // guard denies new work even if reference reconciliation needs a retry.
  // An earlier invocation may have committed the lifecycle fence and crashed
  // during cleanup. Re-running the command adopts and completes that work.
  if (config.archiveCleanupPending) await finalizeCrewArchive(userId, config);
  if (!await CrewConfigs.findOneAsync({
    _id: configId,
    userId,
    agent: config.agent,
    status: 'archived',
    revision: config.revision,
  }, { fields: { _id: 1 } })) {
    throw new Meteor.Error('stale-agent', 'Agent lifecycle changed while archive cleanup completed.');
  }
  return true;
}

const linkUrl = (token) => Meteor.absoluteUrl(`link/${token}`);
const channelSettings = Meteor.settings?.packages?.['10thfloor:agent'] ?? {};
const configKeyBytes = (() => {
  try {
    const bytes = Buffer.from(process.env.CONSTELLATION_CONFIG_KEY ?? '', 'base64');
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
})();

function secretAad(userId, kind, field) {
  return Buffer.from(`${userId}:${kind}:${field}`);
}

function encryptChannelSecret(userId, kind, field, value) {
  if (!configKeyBytes) {
    throw new Meteor.Error('secret-storage-locked', 'Secure credential storage is unavailable. Restart from the desktop app.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', configKeyBytes, iv);
  cipher.setAAD(secretAad(userId, kind, field));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptChannelSecret(userId, kind, field, box) {
  if (!configKeyBytes || box?.algorithm !== 'aes-256-gcm') throw new Error('credential store locked');
  const decipher = createDecipheriv(
    'aes-256-gcm', configKeyBytes, Buffer.from(box.iv, 'base64'),
  );
  decipher.setAAD(secretAad(userId, kind, field));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(box.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function readChannelSecretValues(userId, kind) {
  const row = await ChannelSecrets.findOneAsync({ _id: `${userId}:${kind}`, userId, kind });
  const values = {};
  for (const [field, box] of Object.entries(row?.fields ?? {})) {
    values[field] = decryptChannelSecret(userId, kind, field, box);
  }
  return values;
}

async function stopChannelWorker(kind) {
  const worker = egress.get(kind);
  if (!worker) return;
  egress.delete(kind);
  await worker.stop();
}

function buildChannelDef(kind, values) {
  const common = { agent: 'orchestrator', linkUrl };
  if (kind === 'slack') return slack({ ...common, botToken: values.botToken, signingSecret: values.signingSecret });
  if (kind === 'telegram') return telegram({ ...common, botToken: values.botToken, webhookSecret: values.webhookSecret });
  if (kind === 'whatsapp') return whatsapp({
    ...common,
    accessToken: values.accessToken,
    appSecret: values.appSecret,
    verifyToken: values.verifyToken,
  });
  if (kind === 'sms') return sms({
    ...common,
    accountSid: values.accountSid,
    authToken: values.authToken,
    webhookUrl: values.webhookUrl,
  });
  if (kind === 'email') return email({
    ...common,
    serverToken: values.serverToken,
    from: values.from,
    inboundAddress: values.inboundAddress,
    webhookUser: values.webhookUser,
    webhookPassword: values.webhookPassword,
    approvalUrl: (token) => Meteor.absoluteUrl(`verdict/${token}`),
  });
  throw new Error('unsupported channel');
}

async function setChannelStatus(row, status, lastErrorCode = null) {
  await ChannelConfigs.updateAsync(
    { _id: row._id, userId: row.userId },
    { $set: { status, lastErrorCode, runtimeUpdatedAt: new Date() } },
  );
}

async function syncChannelRuntime(row) {
  const schema = CHANNEL_SCHEMAS[row.kind];
  if (!schema || !row.enabled) {
    activeChannelDefs.delete(row.kind);
    await stopChannelWorker(row.kind);
    await setChannelStatus(row, 'disabled');
    return 'disabled';
  }
  let secrets;
  try {
    secrets = await readChannelSecretValues(row.userId, row.kind);
  } catch {
    activeChannelDefs.delete(row.kind);
    await stopChannelWorker(row.kind);
    await setChannelStatus(row, 'locked', 'credential-store-locked');
    return 'locked';
  }
  const values = { ...(row.settings ?? {}), ...secrets };
  const missing = schema.fields.filter((field) => !String(values[field.key] ?? '').trim());
  if (missing.length) {
    activeChannelDefs.delete(row.kind);
    await stopChannelWorker(row.kind);
    await setChannelStatus(row, 'incomplete', 'missing-fields');
    return 'incomplete';
  }
  try {
    activeChannelDefs.set(row.kind, buildChannelDef(row.kind, values));
    if (!egress.has(row.kind)) egress.set(row.kind, startEgress(row.kind));
    await setChannelStatus(row, 'active');
    return 'active';
  } catch {
    activeChannelDefs.delete(row.kind);
    await stopChannelWorker(row.kind);
    await setChannelStatus(row, 'error', 'adapter-configuration');
    return 'error';
  }
}

function channelProbeRequest(kind, values, signal) {
  if (kind === 'slack') {
    return {
      url: 'https://slack.com/api/auth.test',
      init: { headers: { authorization: `Bearer ${values.botToken}` }, signal },
      jsonOk: true,
    };
  }
  if (kind === 'telegram') {
    return {
      url: `https://api.telegram.org/bot${encodeURIComponent(values.botToken)}/getMe`,
      init: { signal },
      jsonOk: true,
    };
  }
  if (kind === 'whatsapp') {
    return {
      url: 'https://graph.facebook.com/v23.0/me?fields=id,name',
      init: { headers: { authorization: `Bearer ${values.accessToken}` }, signal },
    };
  }
  if (kind === 'sms') {
    const auth = Buffer.from(`${values.accountSid}:${values.authToken}`).toString('base64');
    return {
      url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(values.accountSid)}.json`,
      init: { headers: { authorization: `Basic ${auth}` }, signal },
    };
  }
  if (kind === 'email') {
    return {
      url: 'https://api.postmarkapp.com/server',
      init: { headers: { 'x-postmark-server-token': values.serverToken }, signal },
    };
  }
  throw new Meteor.Error('invalid-channel', 'Unknown channel.');
}

async function testChannelConnection(row) {
  const schema = CHANNEL_SCHEMAS[row.kind];
  if (!schema) throw new Meteor.Error('invalid-channel', 'Unknown channel.');
  let secrets;
  try {
    secrets = await readChannelSecretValues(row.userId, row.kind);
  } catch {
    return { ok: false, status: 'locked', reason: 'Credential store is locked.' };
  }
  const values = { ...(row.settings ?? {}), ...secrets };
  const missing = schema.fields.filter((field) => !String(values[field.key] ?? '').trim());
  if (missing.length) {
    return {
      ok: false,
      status: 'incomplete',
      reason: `${missing.length} required ${missing.length === 1 ? 'field is' : 'fields are'} missing.`,
    };
  }

  // Adapter construction validates provider-specific local invariants before
  // any network request. The probe itself is read-only and returns no body or
  // account identifiers to the client.
  buildChannelDef(row.kind, values);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const probe = channelProbeRequest(row.kind, values, controller.signal);
    const response = await fetch(probe.url, probe.init);
    let ok = response.ok;
    if (ok && probe.jsonOk) {
      try { ok = (await response.json())?.ok === true; } catch { ok = false; }
    }
    if (ok) return { ok: true, status: 'ready', reason: 'Provider accepted the saved credentials.' };
    const status = [401, 403].includes(response.status) ? 'unauthorized'
      : response.status === 429 ? 'rate-limited' : 'unavailable';
    const reason = status === 'unauthorized' ? 'Provider rejected the saved credentials.'
      : status === 'rate-limited' ? 'Provider rate limit reached. Try again shortly.'
        : 'Provider is unavailable or rejected the request.';
    return { ok: false, status, reason };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === 'AbortError' ? 'timeout' : 'unavailable',
      reason: error?.name === 'AbortError'
        ? 'Connection test timed out.'
        : 'Could not reach the provider.',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureChannelConfigs(userId) {
  const rows = [];
  for (const kind of CHANNEL_KINDS) {
    const id = `${userId}:${kind}`;
    let row = await ChannelConfigs.findOneAsync(id);
    if (!row) {
      const schema = CHANNEL_SCHEMAS[kind];
      const source = channelSettings[kind] ?? {};
      const settings = {};
      const encrypted = {};
      const configuredFields = [];
      for (const field of schema.fields) {
        const value = String(source[field.key] ?? '').trim();
        if (!value) continue;
        configuredFields.push(field.key);
        if (field.secret && configKeyBytes) encrypted[field.key] = encryptChannelSecret(userId, kind, field.key, value);
        if (!field.secret) settings[field.key] = value;
      }
      row = {
        _id: id,
        userId,
        kind,
        enabled: configuredFields.length === schema.fields.length,
        settings,
        configuredFields,
        status: 'disabled',
        lastErrorCode: null,
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await ChannelConfigs.insertAsync(row);
      if (Object.keys(encrypted).length) {
        await ChannelSecrets.insertAsync({
          _id: id, userId, kind, fields: encrypted, keyVersion: 1, updatedAt: new Date(),
        });
      }
    }
    rows.push(row);
  }
  for (const row of rows) await syncChannelRuntime(row);
  return ChannelConfigs.find({ userId }, { sort: { kind: 1 } }).fetchAsync();
}

function mcpRuntimeName(configId) {
  return `constellation-${createHash('sha256').update(configId).digest('hex').slice(0, 20)}`;
}

function mcpSecretId(userId, configId) {
  return `${userId}:${configId}`;
}

function encryptMcpSecret(userId, configId, field, value) {
  return encryptChannelSecret(userId, `mcp:${configId}`, field, value);
}

function decryptMcpSecret(userId, configId, field, box) {
  return decryptChannelSecret(userId, `mcp:${configId}`, field, box);
}

async function readMcpEnvironment(userId, configId) {
  const row = await McpSecrets.findOneAsync({
    _id: mcpSecretId(userId, configId), userId, configId,
  });
  const env = {};
  for (const [field, box] of Object.entries(row?.fields ?? {})) {
    env[field] = decryptMcpSecret(userId, configId, field, box);
  }
  return env;
}

function isDangerousMcpEnvKey(key) {
  return MCP_DANGEROUS_ENV.has(key) || key.startsWith('DYLD_') || key.startsWith('LD_');
}

function validateMcpEnvKey(key) {
  if (typeof key !== 'string' || !MCP_ENV_KEY.test(key)) {
    throw new Meteor.Error(
      'invalid-mcp',
      'Environment names must use uppercase letters, numbers, and underscores.',
    );
  }
  if (isDangerousMcpEnvKey(key)) {
    throw new Meteor.Error('invalid-mcp', `${key} cannot be overridden for an MCP server.`);
  }
  return key;
}

function cleanMcpCommand(value, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Meteor.Error('invalid-mcp', 'Command must be text.');
  const command = value.trim();
  if (command.length > 1024 || /[\u0000-\u001f\u007f]/.test(command)) {
    throw new Meteor.Error('invalid-mcp', 'Command is invalid or too long.');
  }
  return command;
}

function cleanMcpArgs(value, fallback = []) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 64 || value.some(
    (arg) => typeof arg !== 'string' || arg.length > 2048 || /[\u0000-\u001f\u007f]/.test(arg),
  )) {
    throw new Meteor.Error('invalid-mcp', 'Arguments must be an array of at most 64 text values.');
  }
  return [...value];
}

function cleanMcpStringList(value, field, fallback, max = 100) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > max || value.some(
    (entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 160
      || /[\u0000-\u001f\u007f]/.test(entry),
  )) {
    throw new Meteor.Error('invalid-mcp', `${field} assignments are invalid.`);
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

function cleanMcpNumber(value, field, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Meteor.Error('invalid-mcp', `${field} must be between ${min} and ${max}.`);
  }
  return Math.round(value);
}

function parseMcpEnvPatch(patch, currentKeys = []) {
  const updates = {};
  if (patch.env !== undefined) {
    if (!patch.env || typeof patch.env !== 'object' || Array.isArray(patch.env)
      || Object.keys(patch.env).length > 32) {
      throw new Meteor.Error('invalid-mcp', 'Environment must be an object with at most 32 values.');
    }
    for (const [rawKey, value] of Object.entries(patch.env)) {
      const key = validateMcpEnvKey(rawKey);
      if (typeof value !== 'string' || value.length > 8192 || value.includes('\u0000')) {
        throw new Meteor.Error('invalid-mcp', `${key} must be a text value under 8 KiB.`);
      }
      // Write-only blank fields retain the encrypted value already stored.
      if (value !== '') updates[key] = value;
    }
  }
  const removeEnv = cleanMcpStringList(patch.removeEnv, 'Environment removal', [], 32);
  for (const key of removeEnv) validateMcpEnvKey(key);
  if (removeEnv.some((key) => Object.hasOwn(updates, key))) {
    throw new Meteor.Error('invalid-mcp', 'An environment value cannot be set and removed together.');
  }
  const keys = new Set(currentKeys);
  for (const key of Object.keys(updates)) keys.add(key);
  for (const key of removeEnv) keys.delete(key);
  if (keys.size > 32) throw new Meteor.Error('invalid-mcp', 'Environment limit reached.');
  return { updates, removeEnv, envKeys: [...keys].sort() };
}

function sanitizeCatalogDescription(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function hasMongoUnsafeCatalogKey(value) {
  if (Array.isArray(value)) return value.some(hasMongoUnsafeCatalogKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    key.startsWith('$') || key.includes('.') || hasMongoUnsafeCatalogKey(child)
  ));
}

function boundedCatalogSchema(value) {
  let nodes = 0;
  const safeKey = (rawKey) => {
    // Mongo/Minimongo reject dotted keys and keys beginning with `$` anywhere
    // in a published document. `$schema` is metadata only, so omit it. Encode
    // other structural keys reversibly so `$ref`/`$defs` and dotted property
    // names can still be restored for the executable tool definition.
    if (rawKey === '$schema' || rawKey.length > 128
      || /[\u0000-\u001f\u007f]/.test(rawKey)) return null;
    const escaped = rawKey.replaceAll('%', '%25').replaceAll('.', '%2E');
    return escaped.startsWith('$') ? `%24${escaped.slice(1)}` : escaped;
  };
  function visit(input, depth = 0) {
    nodes += 1;
    if (nodes > 240 || depth > 8) return undefined;
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'string') return input.slice(0, 500);
    if (Array.isArray(input)) return input.slice(0, 48).map((item) => visit(item, depth + 1));
    if (!input || typeof input !== 'object') return undefined;
    const output = {};
    for (const [rawKey, child] of Object.entries(input).slice(0, 64)) {
      if (['pattern', 'format', 'patternProperties'].includes(rawKey)) continue;
      const key = safeKey(rawKey);
      if (!key) continue;
      const clean = visit(child, depth + 1);
      if (clean !== undefined) output[key] = clean;
    }
    return output;
  }
  const schema = visit(value) ?? { type: 'object' };
  try {
    return JSON.stringify(schema).length <= 16_000 ? schema : { type: 'object' };
  } catch {
    return { type: 'object' };
  }
}

function executableCatalogSchema(value) {
  if (Array.isArray(value)) return value.map(executableCatalogSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([safeKey, child]) => {
    const key = safeKey.replace(/^%24/, '$').replaceAll('%2E', '.').replaceAll('%25', '%');
    return [key, executableCatalogSchema(child)];
  }));
}

function mcpToolAlias(configId, remoteName) {
  const namespace = createHash('sha256').update(configId).digest('hex').slice(0, 8);
  const suffix = createHash('sha256').update(remoteName).digest('hex').slice(0, 6);
  const slug = slugifySkill(remoteName).replace(/-/g, '_').slice(0, 36) || 'tool';
  return `mcp_${namespace}_${slug}_${suffix}`;
}

function mcpCatalogId(configId, remoteName) {
  const digest = createHash('sha256').update(remoteName).digest('hex').slice(0, 20);
  return `mcp:${configId}:${digest}`;
}

const MCP_PUBLIC_FIELDS = Object.freeze({
  name: 1,
  managed: 1,
  locked: 1,
  enabled: 1,
  trusted: 1,
  command: 1,
  args: 1,
  envKeys: 1,
  agents: 1,
  toolMode: 1,
  selectedTools: 1,
  approval: 1,
  timeoutMs: 1,
  cooldownMs: 1,
  status: 1,
  lastTestStatus: 1,
  lastErrorCode: 1,
  catalogCount: 1,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  runtimeUpdatedAt: 1,
  lastTestedAt: 1,
});

async function publicMcpConfig(userId, configId) {
  return McpConfigs.findOneAsync(
    { _id: configId, userId }, { fields: MCP_PUBLIC_FIELDS },
  );
}

async function normalizeMcpInput(userId, current, patch) {
  assertOnlyKeys(
    patch,
    [
      'name', 'enabled', 'trusted', 'command', 'args', 'env', 'removeEnv',
      'agents', 'toolMode', 'selectedTools', 'approval', 'timeoutMs', 'cooldownMs',
    ],
    'invalid-mcp',
  );
  for (const field of ['enabled', 'trusted']) {
    if (patch[field] !== undefined && typeof patch[field] !== 'boolean') {
      throw new Meteor.Error('invalid-mcp', `${field} must be true or false.`);
    }
  }
  const previous = current ?? {
    name: 'New MCP server',
    enabled: false,
    trusted: false,
    command: '',
    args: [],
    envKeys: [],
    agents: ['orchestrator'],
    toolMode: 'all',
    selectedTools: [],
    approval: 'ask',
    timeoutMs: 15_000,
    cooldownMs: 30_000,
  };
  const name = cleanConfigText(patch.name, 'Name', 80, 'invalid-mcp', previous.name);
  const command = cleanMcpCommand(patch.command, previous.command);
  const args = cleanMcpArgs(patch.args, previous.args ?? []);
  const agents = cleanMcpStringList(patch.agents, 'Agent', previous.agents ?? [], 12);
  const assigned = await CrewConfigs.find(
    { userId, agent: { $in: agents }, status: { $ne: 'archived' } },
    { fields: { agent: 1 } },
  ).fetchAsync();
  if (assigned.length !== agents.length) {
    throw new Meteor.Error('invalid-mcp', 'One or more assigned agents no longer exist.');
  }
  const toolMode = patch.toolMode ?? previous.toolMode ?? 'all';
  if (!MCP_TOOL_MODES.has(toolMode)) {
    throw new Meteor.Error('invalid-mcp', 'Tool mode must be all or selected.');
  }
  const selectedTools = cleanMcpStringList(
    patch.selectedTools, 'Tool', previous.selectedTools ?? [], 100,
  );
  const approval = patch.approval ?? previous.approval ?? 'ask';
  if (!MCP_APPROVALS.has(approval)) {
    throw new Meteor.Error('invalid-mcp', 'Approval policy must be ask or blocked.');
  }
  const executableChanged = command !== previous.command
    || JSON.stringify(args) !== JSON.stringify(previous.args ?? []);
  let trusted = patch.trusted ?? previous.trusted ?? false;
  if (executableChanged && patch.trusted !== true) trusted = false;
  const requestedEnabled = patch.enabled ?? previous.enabled ?? false;
  if (requestedEnabled && (!trusted || !command || patch.trusted === false)) {
    throw new Meteor.Error(
      'mcp-untrusted',
      'Confirm that you trust this local command before enabling the MCP server.',
    );
  }
  if (requestedEnabled && toolMode === 'selected' && selectedTools.length === 0) {
    throw new Meteor.Error(
      'invalid-mcp',
      'Choose at least one discovered tool before enabling this MCP server.',
    );
  }
  const enabled = requestedEnabled && trusted;
  const env = parseMcpEnvPatch(patch, previous.envKeys ?? []);
  return {
    config: {
      name,
      managed: 'workspace',
      locked: false,
      enabled,
      trusted,
      command,
      args,
      envKeys: env.envKeys,
      agents,
      toolMode,
      selectedTools,
      approval,
      timeoutMs: cleanMcpNumber(
        patch.timeoutMs, 'Connect timeout', previous.timeoutMs ?? 15_000, 250, 60_000,
      ),
      cooldownMs: cleanMcpNumber(
        patch.cooldownMs, 'Retry cooldown', previous.cooldownMs ?? 30_000, 0, 300_000,
      ),
      status: enabled ? 'configured' : 'disabled',
      lastErrorCode: null,
      updatedAt: new Date(),
    },
    env,
  };
}

async function writeMcpEnvironment(userId, configId, env) {
  if (!Object.keys(env.updates).length && !env.removeEnv.length) return;
  const id = mcpSecretId(userId, configId);
  const current = await McpSecrets.findOneAsync({ _id: id, userId, configId });
  const fields = { ...(current?.fields ?? {}) };
  for (const [key, value] of Object.entries(env.updates)) {
    fields[key] = encryptMcpSecret(userId, configId, key, value);
  }
  for (const key of env.removeEnv) delete fields[key];
  if (!Object.keys(fields).length) {
    await McpSecrets.removeAsync({ _id: id, userId, configId });
    return;
  }
  await McpSecrets.upsertAsync(
    { _id: id, userId, configId },
    { $set: { fields, keyVersion: 1, updatedAt: new Date() } },
  );
}

async function ensureAppMcpConfigs(userId) {
  const rows = [];
  for (const source of APP_MCP_SERVERS) {
    let row = await McpConfigs.findOneAsync({ userId, managed: 'app', appKey: source.appKey });
    if (!row) {
      const now = new Date();
      const id = await McpConfigs.insertAsync({
        userId,
        appKey: source.appKey,
        name: source.name,
        managed: 'app',
        locked: true,
        enabled: true,
        trusted: true,
        command: source.displayCommand,
        args: source.displayArgs,
        envKeys: [],
        agents: source.agents,
        toolMode: 'all',
        selectedTools: [],
        approval: source.approval,
        timeoutMs: 5_000,
        cooldownMs: 5_000,
        status: 'configured',
        lastTestStatus: 'never',
        lastErrorCode: null,
        catalogCount: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      row = await McpConfigs.findOneAsync(id);
    } else {
      await McpConfigs.updateAsync(
        { _id: row._id, userId },
        { $set: {
          name: source.name,
          managed: 'app',
          locked: true,
          enabled: true,
          trusted: true,
          command: source.displayCommand,
          args: source.displayArgs,
          envKeys: [],
          agents: source.agents,
          approval: source.approval,
        } },
      );
      row = { ...row, ...source, enabled: true, trusted: true, locked: true };
    }
    rows.push(row);
  }
  return rows;
}

async function assertMcpMutationAllowed(userId, agents) {
  const affected = [...new Set(agents)];
  if (!affected.length) return;
  const busy = await AgentSessions.findOneAsync({
    userId,
    phase: { $in: MCP_ACTIVE_PHASES },
    $or: [
      { agent: { $in: affected } },
      { participants: { $elemMatch: { kind: 'model', agent: { $in: affected } } } },
    ],
  }, { fields: { phase: 1, title: 1 } });
  if (busy) {
    throw new Meteor.Error(
      'mcp-busy',
      `Wait for ${busy.title || 'the affected mission'} to finish before changing MCP runtime configuration.`,
    );
  }
}

async function authorizeMcpTool(configId, agent, sessionId) {
  const [config, session] = await Promise.all([
    McpConfigs.findOneAsync({ _id: configId }),
    AgentSessions.findOneAsync({ _id: sessionId }),
  ]);
  if (!config || !session || !config.enabled || !config.trusted
    || config.status !== 'ready' || config.userId !== session.userId
    || !config.agents?.includes(agent) || config.approval === 'blocked') {
    return false;
  }
  const crew = await CrewConfigs.findOneAsync({
    userId: session.userId,
    agent,
    enabled: true,
    status: { $ne: 'archived' },
  }, { fields: { _id: 1 } });
  if (!crew) return false;
  return 'ask';
}

function catalogToolDoc(userId, values) {
  return {
    userId,
    locked: true,
    recentCallAt: null,
    recentResult: null,
    ...values,
    updatedAt: new Date(),
  };
}

async function writeCodeToolCatalog(userId, crew, skills) {
  const enabled = crew.filter((config) => config.enabled && config.status !== 'archived');
  const byCapability = (name) => enabled
    .filter((config) => config.capabilities?.[name])
    .map((config) => config.agent);
  const rows = [];
  const add = (
    name, displayName, description, agents, approval, inputSchema, metadata = {},
  ) => {
    if (!agents.length) return;
    rows.push(catalogToolDoc(userId, {
      _id: `app:${userId}:${name}`,
      source: 'app',
      name,
      displayName,
      description,
      agents: [...new Set(agents)],
      approval,
      status: 'ready',
      inputSchema: boundedCatalogSchema(inputSchema),
      ...metadata,
    }));
  };
  const addFramework = (
    id, name, displayName, description, agents, approval, inputSchema, metadata = {},
  ) => {
    if (!agents.length) return;
    rows.push(catalogToolDoc(userId, {
      _id: `framework:${userId}:${id}`,
      source: 'framework',
      category: metadata.category,
      frameworkManaged: true,
      name,
      displayName,
      description,
      agents: [...new Set(agents)],
      approval,
      status: 'ready',
      inputSchema: boundedCatalogSchema(inputSchema),
      ...metadata,
    }));
  };
  add(
    'inspect_workspace',
    'Workspace inspection',
    'Read a bounded operational snapshot of the current mission.',
    byCapability('inspect'),
    'auto',
    { type: 'object', properties: { focus: { type: 'string' } }, required: ['focus'] },
  );
  add(
    'publish_brief',
    'Publish brief',
    'Publish a reviewed Markdown mission brief.',
    byCapability('publish'),
    'conditional',
    {
      type: 'object',
      properties: {
        title: { type: 'string' }, audience: { type: 'string' }, summary: { type: 'string' },
      },
      required: ['title', 'audience', 'summary'],
    },
    { approvalSummary: 'Mission approvals on: Ask · off: Auto' },
  );

  const primary = enabled.find((config) => config.agent === 'orchestrator');
  if (primary) {
    for (const target of enabled.filter((config) => config.agent !== 'orchestrator')) {
      addFramework(
        `delegate:${target.agent}`,
        target.agent,
        `Delegate to ${target.displayName}`,
        `Run a focused ${target.role.toLowerCase()} task with ${target.displayName}.`,
        [primary.agent],
        'auto',
        SUBAGENT_ARGS,
        {
          category: 'delegation',
          origin: 'app-roster',
          runtimeKind: 'subagent',
          targetAgent: target.agent,
          targetDisplayName: target.displayName,
          approvalSummary: 'Auto',
        },
      );
    }
  }

  const skillAssignments = enabled.map((config) => ({
    agent: config.agent,
    skills: skillsForAgent(skills, config).map((skill) => skill.name),
  })).filter((assignment) => assignment.skills.length > 0);
  const skillNames = [...new Set(skillAssignments.flatMap((assignment) => assignment.skills))]
    .sort((left, right) => left.localeCompare(right));
  addFramework(
    SKILL_TOOL_NAME,
    SKILL_TOOL_NAME,
    'Skill loader',
    'Load the full instructions for an assigned skill listed in the agent prompt.',
    skillAssignments.map((assignment) => assignment.agent),
    'auto',
    {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    {
      category: 'skills',
      origin: 'framework-built-in',
      runtimeKind: 'inline',
      skillCount: skillNames.length,
      skillNames,
      skillAssignments,
      approvalSummary: 'Auto',
    },
  );

  const primaryHasMemory = !!primary?.capabilities?.memory;
  const memoryAssignments = enabled.filter((config) => (
    config.agent === 'orchestrator'
      ? !!config.capabilities?.memory
      : primaryHasMemory || !!config.capabilities?.memory
  )).map((config) => ({
    agent: config.agent,
    access: config.agent !== 'orchestrator' && primaryHasMemory ? 'inherited' : 'configured',
  }));
  const memoryAgents = memoryAssignments.map((assignment) => assignment.agent);
  const inheritedMemoryCount = memoryAssignments.filter(
    (assignment) => assignment.access === 'inherited',
  ).length;
  const memoryAvailability = 'Available in owned, non-ephemeral root Missions; not injected into delegated child runs.';
  const memoryMetadata = {
    category: 'memory',
    origin: 'framework-built-in',
    runtimeKind: 'inline',
    accessMode: 'root-mission',
    memoryAssignments,
    assignmentSummary: inheritedMemoryCount > 0
      ? `${primary.displayName}: configured · ${inheritedMemoryCount} specialist${inheritedMemoryCount === 1 ? '' : 's'} inherited`
      : `${memoryAssignments.length} agent${memoryAssignments.length === 1 ? '' : 's'} configured`,
    ...(inheritedMemoryCount > 0 ? { inheritedFrom: 'orchestrator' } : {}),
    availabilityNote: memoryAvailability,
  };
  addFramework(
    MEMORY_SAVE_TOOL_NAME,
    MEMORY_SAVE_TOOL_NAME,
    'Save memory',
    'Save a durable preference, correction, or standing work fact for later conversations.',
    memoryAgents,
    'conditional',
    {
      type: 'object',
      properties: {
        text: {
          type: 'string', maxLength: MEMORY_TEXT_MAX, description: 'The fact, in one or two sentences.',
        },
        scope: {
          type: 'string',
          enum: ['user', 'app'],
          description: 'User memory or shared app memory.',
        },
        key: { type: 'string', maxLength: 128 },
        pinned: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    {
      ...memoryMetadata,
      approvalSummary: 'User: Auto · Shared app: Ask',
    },
  );
  addFramework(
    MEMORY_SEARCH_TOOL_NAME,
    MEMORY_SEARCH_TOOL_NAME,
    'Search memory',
    'Recall durable facts by meaning when earlier context may be relevant.',
    memoryAgents,
    'auto',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall.' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    {
      ...memoryMetadata,
      approvalSummary: 'Auto',
    },
  );
  addFramework(
    MEMORY_FORGET_TOOL_NAME,
    MEMORY_FORGET_TOOL_NAME,
    'Forget memory',
    'Remove one durable fact by its memory ID when it is wrong or no longer wanted.',
    memoryAgents,
    'conditional',
    {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    {
      ...memoryMetadata,
      approvalSummary: 'User: Auto · Shared app: Ask',
    },
  );

  const learningAssignments = enabled.map((config) => ({
    agent: config.agent,
    ...crewExperienceConfig(config.experience),
    practice: crewPracticeConfig(config.practice),
  }));
  const searchAssignments = learningAssignments.filter(
    (assignment) => assignment.recall && assignment.recent > 0,
  );
  const proposalAssignments = learningAssignments.filter((assignment) => assignment.record);
  const practiceAssignments = learningAssignments.filter((assignment) => (
    assignment.practice.acquire && assignment.recall && assignment.recent > 0
  ));
  const learningScopeLabel = (scope) => ({
    identity: 'Agent identity', owner: 'Workspace', session: 'Chat',
  })[scope] ?? 'Workspace';
  const proposalScopes = [...new Set(
    proposalAssignments.map((assignment) => learningScopeLabel(assignment.scope)),
  )];
  const approvalSummary = (assignments, select) => {
    const automatic = assignments.filter((assignment) => select(assignment) === 'auto').length;
    const reviewed = assignments.length - automatic;
    return [
      reviewed ? `${reviewed} review first` : null,
      automatic ? `${automatic} automatic` : null,
    ].filter(Boolean).join(' · ');
  };
  const catalogApproval = (assignments, select) => {
    const modes = new Set(assignments.map(select));
    return modes.size > 1 ? 'conditional' : modes.has('auto') ? 'auto' : 'ask';
  };
  const learningAvailability = 'Available in durable root turns, delegated child turns, and ephemeral Agent.ask turns through a per-trigger Memory Frame. Agent.ask erases its throwaway Frame after completion.';
  const learningMetadata = (assignments) => ({
    category: 'learning',
    origin: 'framework-built-in',
    runtimeKind: 'inline',
    accessMode: 'memory-frame',
    availabilityNote: learningAvailability,
    learningAssignments: assignments,
    assignmentSummary: `${assignments.length} enabled agent${assignments.length === 1 ? '' : 's'}`,
  });
  addFramework(
    EXPERIENCE_SEARCH_TOOL_NAME,
    EXPERIENCE_SEARCH_TOOL_NAME,
    'Search experience',
    'Recall active experiential evidence frozen into the current Agent Memory Frame.',
    searchAssignments.map((assignment) => assignment.agent),
    'auto',
    {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 512 },
        limit: { type: 'integer', minimum: 1, maximum: EXPERIENCE_RECALL_MAX },
      },
      required: ['query'],
      additionalProperties: false,
    },
    { ...learningMetadata(searchAssignments), approvalSummary: 'Auto' },
  );
  addFramework(
    EXPERIENCE_PROPOSE_TOOL_NAME,
    EXPERIENCE_PROPOSE_TOOL_NAME,
    'Propose experience',
    'Propose durable experiential evidence from an expectation/observation difference.',
    proposalAssignments.map((assignment) => assignment.agent),
    catalogApproval(proposalAssignments, (assignment) => assignment.approval),
    {
      type: 'object',
      properties: {
        expectationBasis: {
          type: 'string', enum: ['explicit', 'inferred', 'retrospective'],
        },
        expected: { type: 'string', maxLength: 2_000 },
        observed: { type: 'string', maxLength: 2_000 },
        difference: { type: 'string', maxLength: 2_000 },
        lesson: { type: 'string', maxLength: 2_000 },
        context: { type: 'string', maxLength: 256 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: [
        'expectationBasis', 'expected', 'observed', 'difference', 'lesson',
        'context', 'confidence',
      ],
      additionalProperties: false,
    },
    {
      ...learningMetadata(proposalAssignments),
      approvalSummary: `${approvalSummary(
        proposalAssignments, (assignment) => assignment.approval,
      )} · ${proposalScopes.join(' / ')} scope · survives chat deletion`,
    },
  );
  addFramework(
    PRACTICE_PROPOSE_TOOL_NAME,
    PRACTICE_PROPOSE_TOOL_NAME,
    'Propose practice',
    'Create an evidence-linked Practice candidate; configured policy may activate it as a trial.',
    practiceAssignments.map((assignment) => assignment.agent),
    'auto',
    {
      type: 'object',
      properties: {
        key: { type: 'string', maxLength: 128 },
        trigger: { type: 'string', maxLength: 2_000 },
        guidance: { type: 'string', maxLength: 2_000 },
        context: { type: 'string', maxLength: 256 },
        evidenceIds: {
          type: 'array', minItems: 1, maxItems: 50, uniqueItems: true,
          items: { type: 'string', maxLength: 256 },
        },
      },
      required: ['key', 'trigger', 'guidance', 'context', 'evidenceIds'],
      additionalProperties: false,
    },
    {
      ...learningMetadata(practiceAssignments),
      approvalSummary: `Candidate creation: Auto · validation: ${approvalSummary(
        practiceAssignments, (assignment) => assignment.practice.approval,
      ) || 'Review first'} · hardening: Review required`,
    },
  );

  const desiredIds = rows.map((row) => row._id);
  await Promise.all(rows.map((row) => {
    const { _id, ...fields } = row;
    return ToolCatalog.upsertAsync(
      { _id, userId },
      {
        $set: fields,
        ...(!Object.hasOwn(fields, 'inheritedFrom')
          ? { $unset: { inheritedFrom: '' } }
          : {}),
      },
    );
  }));
  await ToolCatalog.removeAsync({
    userId,
    source: { $in: ['app', 'framework'] },
    _id: { $nin: desiredIds },
  });
}

async function syncCodeToolCatalog(userId) {
  const previous = toolCatalogSyncByUser.get(userId) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const [crew, skills] = await Promise.all([
      CrewConfigs.find(
        { userId }, { sort: { order: 1, createdAt: 1 } },
      ).fetchAsync(),
      SkillConfigs.find(
        { userId }, { sort: { name: 1, createdAt: 1 } },
      ).fetchAsync(),
    ]);
    await writeCodeToolCatalog(userId, crew, skills);
  });
  toolCatalogSyncByUser.set(userId, pending);
  try {
    await pending;
  } finally {
    if (toolCatalogSyncByUser.get(userId) === pending) toolCatalogSyncByUser.delete(userId);
  }
}

function mcpCatalogAccess(config, remoteName, status) {
  const selected = config.toolMode !== 'selected'
    || !!config.selectedTools?.includes(remoteName);
  const available = status === 'ready' && config.enabled && config.trusted
    && config.approval !== 'blocked' && selected;
  return {
    agents: available ? (config.agents ?? []) : [],
    assignedAgents: config.agents ?? [],
    selected,
  };
}

async function updateMcpCatalogAccess(config, status) {
  const rows = await ToolCatalog.find(
    { userId: config.userId, serverId: config._id },
    { fields: { _id: 1, remoteName: 1 } },
  ).fetchAsync();
  await Promise.all(rows.map((row) => ToolCatalog.updateAsync(
    row._id,
    {
      $set: {
        status,
        ...mcpCatalogAccess(config, row.remoteName, status),
        approval: config.approval,
        updatedAt: new Date(),
      },
    },
  )));
}

async function storeMcpToolCatalog(config, tools, status = 'ready') {
  await ToolCatalog.removeAsync({ userId: config.userId, serverId: config._id });
  for (const tool of tools.slice(0, 100)) {
    await ToolCatalog.insertAsync(catalogToolDoc(config.userId, {
      _id: mcpCatalogId(config._id, tool.name),
      source: config.managed === 'app' ? 'app-mcp' : 'workspace-mcp',
      name: mcpToolAlias(config._id, tool.name),
      displayName: tool.name,
      description: sanitizeCatalogDescription(tool.description),
      serverId: config._id,
      serverName: config.name,
      remoteName: tool.name,
      ...mcpCatalogAccess(config, tool.name, status),
      approval: config.approval,
      status,
      // Discovery normalizes this before storage and before it is returned over
      // DDP. Do not encode a safe schema twice (`%2E` must stay reversible).
      inputSchema: tool.inputSchema ?? { type: 'object' },
    }));
  }
}

async function rebuildMcpToolAssignments(userId, { reconcileArchives = true } = {}) {
  runtimeMcpToolsByAgent.clear();
  const configs = await McpConfigs.find({
    userId, enabled: true, trusted: true, status: 'ready', approval: { $ne: 'blocked' },
  }).fetchAsync();
  for (const config of configs) {
    const catalog = await ToolCatalog.find(
      { userId, serverId: config._id }, { sort: { remoteName: 1 } },
    ).fetchAsync();
    const allowed = config.toolMode === 'selected'
      ? catalog.filter((tool) => config.selectedTools?.includes(tool.remoteName))
      : catalog;
    for (const agent of config.agents ?? []) {
      const specs = runtimeMcpToolsByAgent.get(agent) ?? [];
      for (const tool of allowed) {
        specs.push({
          mcp: { server: mcpRuntimeName(config._id), tool: tool.remoteName },
          name: tool.name,
          description: tool.description || `${tool.remoteName} on ${config.name}`,
          args: executableCatalogSchema(tool.inputSchema ?? { type: 'object' }),
          gate: ({ sessionId }) => authorizeMcpTool(config._id, agent, sessionId),
        });
      }
      runtimeMcpToolsByAgent.set(agent, specs);
    }
  }
  return ensureCrewConfigs(userId, { reconcileArchives });
}

async function setMcpRuntimeStatus(config, values) {
  await McpConfigs.updateAsync(
    { _id: config._id, userId: config.userId },
    { $set: { ...values, runtimeUpdatedAt: new Date() } },
  );
}

function appMcpDefinition(config) {
  const source = APP_MCP_SERVERS.find((candidate) => candidate.appKey === config.appKey);
  if (!source) throw new Error('unknown app MCP source');
  return {
    command: source.command,
    args: source.args,
    timeoutMs: config.timeoutMs,
    cooldownMs: config.cooldownMs,
  };
}

async function workspaceMcpDefinition(config) {
  const env = await readMcpEnvironment(config.userId, config._id);
  return {
    command: config.command,
    args: config.args,
    ...(Object.keys(env).length ? { env } : {}),
    timeoutMs: config.timeoutMs,
    cooldownMs: config.cooldownMs,
  };
}

async function reconcileMcpConfig(config, { testOnly = false } = {}) {
  const runtimeName = mcpRuntimeName(config._id);
  if ((!config.enabled || !config.trusted || config.approval === 'blocked') && !testOnly) {
    await unregisterMcpServer(runtimeName);
    const status = !config.enabled ? 'disabled' : (config.trusted ? 'blocked' : 'untrusted');
    await setMcpRuntimeStatus(config, { status, lastErrorCode: null });
    await updateMcpCatalogAccess(config, status);
    return { ok: true, status, tools: [] };
  }
  const currentRuntime = getMcpServerStatus(runtimeName);
  if (!testOnly && config.enabled && config.status === 'ready'
    && currentRuntime.state === 'connected') {
    await updateMcpCatalogAccess(config, 'ready');
    return { ok: true, status: 'ready', tools: [] };
  }
  if (!config.trusted) {
    await setMcpRuntimeStatus(config, {
      status: 'untrusted', lastTestStatus: 'error', lastErrorCode: 'mcp-untrusted',
    });
    return { ok: false, status: 'untrusted', tools: [], reason: 'Trust is required before starting this command.' };
  }
  let definition;
  try {
    definition = config.managed === 'app'
      ? appMcpDefinition(config)
      : await workspaceMcpDefinition(config);
  } catch {
    await unregisterMcpServer(runtimeName);
    await setMcpRuntimeStatus(config, {
      status: 'locked', lastTestStatus: 'error', lastErrorCode: 'credential-store-locked',
    });
    return { ok: false, status: 'locked', tools: [], reason: 'Secure MCP environment storage is locked.' };
  }
  try {
    Agent.mcpServer(runtimeName, definition);
  } catch {
    await unregisterMcpServer(runtimeName);
    await setMcpRuntimeStatus(config, {
      status: 'error', lastTestStatus: 'error', lastErrorCode: 'invalid-runtime-definition',
    });
    return { ok: false, status: 'error', tools: [], reason: 'The MCP runtime definition is invalid.' };
  }
  await setMcpRuntimeStatus(config, { status: 'connecting', lastErrorCode: null });
  const discovered = await discoverMcpTools(runtimeName);
  const testedAt = new Date();
  if (!discovered.ok) {
    const status = config.enabled && !testOnly ? 'error' : 'disabled';
    await setMcpRuntimeStatus(config, {
      status,
      lastTestStatus: 'error',
      lastErrorCode: 'mcp-unavailable',
      lastTestedAt: testedAt,
      catalogCount: 0,
    });
    await ToolCatalog.removeAsync({ userId: config.userId, serverId: config._id });
    if (testOnly && !config.enabled) await unregisterMcpServer(runtimeName);
    return {
      ok: false,
      status,
      tools: [],
      reason: sanitizeCatalogDescription(discovered.reason) || 'MCP server unavailable.',
    };
  }
  const tools = discovered.tools.filter(
    (tool) => typeof tool.name === 'string' && tool.name.length > 0 && tool.name.length <= 160
      && !/[\u0000-\u001f\u007f]/.test(tool.name),
  ).slice(0, 100).map((tool) => ({
    name: tool.name,
    description: sanitizeCatalogDescription(tool.description),
    inputSchema: boundedCatalogSchema(tool.inputSchema ?? { type: 'object' }),
  }));
  const status = config.enabled ? 'ready' : 'disabled';
  await storeMcpToolCatalog(config, tools, status);
  await setMcpRuntimeStatus(config, {
    status,
    lastTestStatus: 'ready',
    lastErrorCode: null,
    lastTestedAt: testedAt,
    catalogCount: tools.length,
  });
  if (testOnly && !config.enabled) await unregisterMcpServer(runtimeName);
  return { ok: true, status, tools };
}

async function reconcileAllMcpRuntime(userId) {
  await ensureAppMcpConfigs(userId);
  const configs = await McpConfigs.find(
    { userId }, { sort: { managed: 1, createdAt: 1 } },
  ).fetchAsync();
  for (const config of configs) await reconcileMcpConfig(config);
  await rebuildMcpToolAssignments(userId);
  return McpConfigs.find({ userId }, { sort: { managed: 1, name: 1 } }).fetchAsync();
}

function cleanCrewText(value, field, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Meteor.Error('invalid-crew', `${field} must be text.`);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  if (!clean) throw new Meteor.Error('invalid-crew', `${field} cannot be empty.`);
  return clean;
}

function crewNumber(value, field, fallback, min, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Meteor.Error('invalid-crew', `${field} must be between ${min} and ${max}.`);
  }
  return number;
}

export function cleanCrewModel(value, current) {
  if (value === undefined || value === current) return current;
  if (typeof value !== 'string') throw new Meteor.Error('invalid-crew', 'Model must be text.');
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean) throw new Meteor.Error('invalid-crew', 'Model cannot be empty.');
  if (clean.length > MODEL_ID_MAX) {
    throw new Meteor.Error('invalid-crew', `Model id cannot exceed ${MODEL_ID_MAX} characters.`);
  }
  return clean;
}

function normalizeCrewPatch(current, patch, availableModelIds) {
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new Meteor.Error('invalid-crew', 'Enabled must be true or false.');
  }
  const requestedColor = patch.color ?? current.color;
  if (!CREW_COLORS.has(requestedColor)) throw new Meteor.Error('invalid-crew', 'Unknown agent color.');
  const capabilities = {};
  for (const key of ['inspect', 'framing', 'memory', 'publish']) {
    const next = patch.capabilities?.[key];
    if (next !== undefined && typeof next !== 'boolean') {
      throw new Meteor.Error('invalid-crew', `${key} must be true or false.`);
    }
    capabilities[key] = next ?? current.capabilities?.[key] ?? false;
  }
  const requestedModel = cleanCrewModel(patch.model, current.model);
  if (availableModelIds) {
    try {
      assertCrewModelAvailable(current.model, requestedModel, availableModelIds);
    } catch (error) {
      throw new Meteor.Error(error.code ?? 'model-unavailable', error.message);
    }
  }
  if (patch.flexibility !== undefined
    && (!Number.isSafeInteger(patch.flexibility)
      || patch.flexibility < 0 || patch.flexibility > 1000)) {
    throw new Meteor.Error('invalid-crew', 'Practice flexibility must be an integer from 0 to 1000.');
  }
  if (patch.experience !== undefined) {
    assertOnlyKeys(
      patch.experience, ['record', 'recall', 'recent', 'scope', 'approval'], 'invalid-crew',
    );
    if (patch.experience.record !== undefined
      && typeof patch.experience.record !== 'boolean') {
      throw new Meteor.Error('invalid-crew', 'Experience recording must be true or false.');
    }
    if (patch.experience.recall !== undefined
      && typeof patch.experience.recall !== 'boolean') {
      throw new Meteor.Error('invalid-crew', 'Experience recall must be true or false.');
    }
    if (patch.experience.recent !== undefined
      && (!Number.isSafeInteger(patch.experience.recent)
        || patch.experience.recent < 0 || patch.experience.recent > EXPERIENCE_RECALL_MAX)) {
      throw new Meteor.Error(
        'invalid-crew', `Experience recall limit must be 0 to ${EXPERIENCE_RECALL_MAX}.`,
      );
    }
    if (patch.experience.scope !== undefined
      && !EXPERIENCE_SCOPES.has(patch.experience.scope)) {
      throw new Meteor.Error('invalid-crew', 'Experience scope is invalid.');
    }
    if (patch.experience.approval !== undefined
      && !LEARNING_APPROVALS.has(patch.experience.approval)) {
      throw new Meteor.Error('invalid-crew', 'Experience approval policy is invalid.');
    }
  }
  if (patch.practice !== undefined) {
    assertOnlyKeys(
      patch.practice,
      ['acquire', 'approval', 'allowScopedEvidencePromotion'],
      'invalid-crew',
    );
    if (patch.practice.acquire !== undefined
      && typeof patch.practice.acquire !== 'boolean') {
      throw new Meteor.Error('invalid-crew', 'Practice acquisition must be true or false.');
    }
    if (patch.practice.approval !== undefined
      && !LEARNING_APPROVALS.has(patch.practice.approval)) {
      throw new Meteor.Error('invalid-crew', 'Practice approval policy is invalid.');
    }
    if (patch.practice.allowScopedEvidencePromotion !== undefined
      && typeof patch.practice.allowScopedEvidencePromotion !== 'boolean') {
      throw new Meteor.Error(
        'invalid-crew', 'Scoped Experience promotion must be true or false.',
      );
    }
  }
  const requestedExperience = {
    ...crewExperienceConfig(current.experience),
    ...(patch.experience ?? {}),
  };
  if (requestedExperience.recall === true && requestedExperience.recent < 1) {
    throw new Meteor.Error(
      'invalid-crew', 'Experience recall limit must be at least 1 when recall is enabled.',
    );
  }
  const experience = crewExperienceConfig(requestedExperience);
  const practice = crewPracticeConfig({
    ...crewPracticeConfig(current.practice),
    ...(patch.practice ?? {}),
  });
  return {
    displayName: cleanCrewText(patch.displayName, 'Name', 40, current.displayName),
    role: cleanCrewText(patch.role, 'Role', 60, current.role),
    avatar: cleanCrewText(patch.avatar, 'Avatar', 2, current.avatar).slice(0, 2).toUpperCase(),
    color: requestedColor,
    instructions: cleanCrewText(patch.instructions, 'Instructions', 4000, current.instructions),
    model: requestedModel,
    enabled: patch.enabled ?? current.enabled,
    flexibility: patch.flexibility ?? current.flexibility ?? DEFAULT_CREW_FLEXIBILITY,
    experience,
    practice,
    capabilities,
    budget: {
      turns: Math.round(crewNumber(patch.budget?.turns, 'Turn budget', current.budget?.turns ?? 24, 1, 200)),
      toolCalls: Math.round(crewNumber(patch.budget?.toolCalls, 'Tool-call budget', current.budget?.toolCalls ?? 8, 0, 100)),
      spend: crewNumber(patch.budget?.spend, 'Spend cap', current.budget?.spend ?? 1, 0, 100),
    },
    updatedAt: new Date(),
  };
}

function assertOnlyKeys(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Meteor.Error(code, 'Configuration must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Meteor.Error(code, `Unknown field: ${key}.`);
  }
}

function cleanConfigText(value, field, max, code, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new Meteor.Error(code, `${field} must be text.`);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if (!clean) throw new Meteor.Error(code, `${field} cannot be empty.`);
  return clean;
}

function cleanInstructions(value, field, max, code, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new Meteor.Error(code, `${field} must be text.`);
  const clean = value.replace(/\u0000/g, '').trim().slice(0, max);
  if (!clean) throw new Meteor.Error(code, `${field} cannot be empty.`);
  return clean;
}

function cleanOptionalInstructions(value, field, max, code, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Meteor.Error(code, `${field} must be text.`);
  return value.replace(/\u0000/g, '').trim().slice(0, max);
}

function missionBudget(value, fallback = DEFAULT_MISSION_BUDGET) {
  const requested = value ?? fallback;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new Meteor.Error('invalid-mission', 'Budget must be an object.');
  }
  assertOnlyKeys(requested, ['turns', 'toolCalls', 'spend'], 'invalid-mission');
  const next = {
    turns: requested.turns ?? fallback.turns,
    toolCalls: requested.toolCalls ?? fallback.toolCalls,
    spend: requested.spend ?? fallback.spend,
  };
  if (!Number.isInteger(next.turns) || next.turns < 1 || next.turns > 1000) {
    throw new Meteor.Error('invalid-mission', 'Turn alert must be an integer from 1 to 1,000.');
  }
  if (!Number.isInteger(next.toolCalls) || next.toolCalls < 0 || next.toolCalls > 1000) {
    throw new Meteor.Error('invalid-mission', 'Tool-call alert must be an integer from 0 to 1,000.');
  }
  if (typeof next.spend !== 'number' || !Number.isFinite(next.spend)
    || next.spend < 0 || next.spend > 10_000) {
    throw new Meteor.Error('invalid-mission', 'Spend alert must be between 0 and 10,000.');
  }
  return next;
}

async function ensureMissionConfig(userId, sessionOrId) {
  const session = typeof sessionOrId === 'string'
    ? await AgentSessions.findOneAsync({ _id: sessionOrId, userId, agent: 'orchestrator' })
    : sessionOrId;
  if (!session || session.userId !== userId || session.agent !== 'orchestrator') {
    throw new Meteor.Error('no-session', 'Mission not found.');
  }
  let config = await MissionConfigs.findOneAsync({ _id: session._id, userId });
  if (!config) {
    const now = new Date();
    try {
      await MissionConfigs.insertAsync({
        _id: session._id,
        sessionId: session._id,
        userId,
        title: String(session.title || 'New mission').slice(0, 96),
        objective: '',
        status: 'active',
        primaryAgent: 'orchestrator',
        budget: { ...DEFAULT_MISSION_BUDGET },
        autoTitle: true,
        continuity: true,
        approvals: true,
        debugTraces: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      // Another local window may have initialized this mission concurrently.
    }
    config = await MissionConfigs.findOneAsync({ _id: session._id, userId });
  }
  if (!config) throw new Meteor.Error('mission-config-failed', 'Mission configuration could not be initialized.');
  if (config.debugTraces === undefined) {
    await MissionConfigs.updateAsync(
      { _id: session._id, userId, debugTraces: { $exists: false } },
      { $set: { debugTraces: false } },
    );
    config = { ...config, debugTraces: false };
  }
  return config;
}

async function materializeMissionAgentSelection(userId, sessionId) {
  let mission = await ensureMissionConfig(userId, sessionId);
  if (Array.isArray(mission.agents)) return mission;
  const configs = await ensureCrewConfigs(userId);
  const agents = configs
    .filter((config) => config.agent !== 'orchestrator'
      && config.enabled
      && config.status !== 'archived')
    .map((config) => config.agent);
  await MissionConfigs.updateAsync(
    { _id: sessionId, userId, agents: { $exists: false } },
    {
      $set: { agents, updatedAt: new Date() },
      $inc: { revision: 1 },
    },
  );
  mission = await MissionConfigs.findOneAsync({ _id: sessionId, userId });
  if (!mission || !Array.isArray(mission.agents)) {
    throw new Meteor.Error('mission-config-failed', 'Mission agent selection could not be saved.');
  }
  return mission;
}

function missionInput(current, patch) {
  assertOnlyKeys(
    patch,
    [
      'title', 'objective', 'status', 'primaryAgent', 'budget', 'autoTitle',
      'continuity', 'approvals', 'debugTraces',
    ],
    'invalid-mission',
  );
  for (const key of ['autoTitle', 'continuity', 'approvals', 'debugTraces']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      throw new Meteor.Error('invalid-mission', `${key} must be true or false.`);
    }
  }
  const status = patch.status ?? current.status ?? 'active';
  if (!MISSION_STATUSES.has(status)) {
    throw new Meteor.Error('invalid-mission', 'Status must be active, paused, or completed.');
  }
  const primaryAgent = patch.primaryAgent ?? current.primaryAgent ?? 'orchestrator';
  if (primaryAgent !== 'orchestrator') {
    throw new Meteor.Error(
      'unsupported-primary',
      'Atlas is the fixed primary agent for existing missions. Configure specialists in Crew.',
    );
  }
  return {
    title: cleanConfigText(patch.title, 'Title', 96, 'invalid-mission', current.title),
    objective: cleanOptionalInstructions(
      patch.objective, 'Objective', 2000, 'invalid-mission', current.objective ?? '',
    ),
    status,
    primaryAgent,
    budget: missionBudget(patch.budget, current.budget ?? DEFAULT_MISSION_BUDGET),
    autoTitle: patch.autoTitle ?? current.autoTitle ?? true,
    continuity: patch.continuity ?? current.continuity ?? true,
    approvals: patch.approvals ?? current.approvals ?? true,
    debugTraces: patch.debugTraces ?? current.debugTraces ?? false,
    updatedAt: new Date(),
  };
}

async function rootMissionSession(sessionId) {
  let session = await AgentSessions.findOneAsync(sessionId);
  for (let depth = 0; session?.parent?.sessionId && depth < 8; depth += 1) {
    session = await AgentSessions.findOneAsync(session.parent.sessionId);
  }
  return session?.agent === 'orchestrator' ? session : null;
}

/** Resolve the current durable Agent/Mission authority behind a process-wide definition. */
async function authorizedMissionAgent(context, agent) {
  const root = await rootMissionSession(context.sessionId);
  if (!root || root.userId !== context.userId || root.erasingAt) return null;
  const config = await CrewConfigs.findOneAsync({
    userId: root.userId,
    agent,
    enabled: true,
    status: { $ne: 'archived' },
  });
  if (!config) return null;

  // A Mission's configurable Crew contains specialists; Atlas is the root
  // participant and remains authorized by the active primary Crew row.
  if (agent === 'orchestrator') return { root, config };

  const mission = await MissionConfigs.findOneAsync(
    { _id: root._id, userId: root.userId }, { fields: { agents: 1 } },
  );
  // An explicit Mission selection is the authorization source. Consult it
  // before the live roster so a post-CAS reconciliation failure can never
  // leave a removed process-wide delegation tool callable.
  if (Array.isArray(mission?.agents) && !mission.agents.includes(agent)) return null;
  if (Array.isArray(root.participants)) {
    return root.participants.some(
      (participant) => participant.kind === 'model' && participant.agent === agent,
    ) ? { root, config } : null;
  }
  if (Array.isArray(mission?.agents) && !mission.agents.includes(agent)) return null;
  return { root, config };
}

/** Runtime authorization for process-wide subagent tool definitions. */
export async function missionAllowsAgent(context, agent) {
  return !!await authorizedMissionAgent(context, agent);
}

/**
 * Final, non-overridable Tool entitlement fence for Constellation.
 *
 * Agent definitions and prepared Tool runtimes are process/Turn snapshots,
 * while control-panel policy is live. Read the authoritative rows again so a
 * removal that lands during generation or approval wait takes effect before
 * any consequential implementation starts.
 */
export async function configuredToolEntitlement(tool, context, agent) {
  const authority = await authorizedMissionAgent(context, agent);
  if (!authority) return false;
  const { root, config } = authority;

  if (tool === 'inspect_workspace') return config.capabilities?.inspect === true;
  if (tool === 'publish_brief') return config.capabilities?.publish === true;

  if (MEMORY_TOOL_NAMES.includes(tool)) {
    if (config.capabilities?.memory === true) return true;
    if (agent === 'orchestrator') return false;
    const primary = await CrewConfigs.findOneAsync({
      userId: root.userId,
      agent: 'orchestrator',
      enabled: true,
      status: { $ne: 'archived' },
      'capabilities.memory': true,
    }, { fields: { _id: 1 } });
    return !!primary;
  }

  const experience = crewExperienceConfig(config.experience);
  if (tool === EXPERIENCE_PROPOSE_TOOL_NAME) return experience.record;
  if (tool === EXPERIENCE_SEARCH_TOOL_NAME) {
    return experience.recall && experience.recent > 0;
  }
  if (tool === PRACTICE_PROPOSE_TOOL_NAME) {
    const practice = crewPracticeConfig(config.practice);
    return practice.acquire && experience.recall && experience.recent > 0;
  }

  if (tool === SKILL_TOOL_NAME) {
    const skillName = typeof context.args?.name === 'string' ? context.args.name : '';
    if (!skillName) return false;
    return !!await SkillConfigs.findOneAsync({
      userId: root.userId,
      slug: skillName,
      enabled: true,
      agents: agent,
    }, { fields: { _id: 1 } });
  }

  // Atlas' delegation Tool is named after its target Agent. The target's own
  // Mission membership and lifecycle, rather than Atlas' broad authority,
  // determine whether a child may be born.
  if (agent === 'orchestrator') {
    const target = await CrewConfigs.findOneAsync(
      { userId: root.userId, agent: tool, primary: { $ne: true } },
      { fields: { _id: 1 } },
    );
    if (target) return missionAllowsAgent(context, tool);
  }

  // MCP aliases are catalog-backed, but both the alias row and its current
  // server configuration must agree. This also revokes one selected Tool from
  // an already-prepared runtime without disabling the whole server.
  const catalog = await ToolCatalog.findOneAsync({
    userId: root.userId,
    name: tool,
    source: { $in: ['app-mcp', 'workspace-mcp'] },
    serverId: { $exists: true },
  }, { fields: { serverId: 1, remoteName: 1 } });
  if (!catalog) return false;
  const mcp = await McpConfigs.findOneAsync({
    _id: catalog.serverId,
    userId: root.userId,
    enabled: true,
    trusted: true,
    status: 'ready',
    approval: { $ne: 'blocked' },
    agents: agent,
  }, { fields: { toolMode: 1, selectedTools: 1 } });
  if (!mcp) return false;
  return mcp.toolMode !== 'selected' || mcp.selectedTools?.includes(catalog.remoteName);
}

export async function requireActiveMissionExecution(sessionId, agent) {
  const root = await rootMissionSession(sessionId);
  if (!root) return;
  // `Agent.ask()` uses an intentionally ephemeral root and has no Mission
  // control-plane record. Every durable app root must have one; initialize the
  // normal active default rather than silently treating a missing row as allow.
  if (root.ephemeral) return;
  const mission = await ensureMissionConfig(root.userId, root);
  if (mission.status !== 'active') {
    throw new Meteor.Error(
      'mission-inactive',
      `Mission is ${mission.status}. Activate it before running work.`,
    );
  }
  if (agent && !await missionAllowsAgent(
    { userId: root.userId, sessionId }, agent,
  )) {
    throw new Meteor.Error(
      'agent-unavailable',
      'This Agent is no longer active on the Mission; provider work was not started.',
    );
  }
}

// The first hook only carries context to the app-level Provider wrapper. It is
// deliberately separate from optional prompt enrichment: if enrichment fails,
// the framework keeps the already-tagged request and the paid-work fence holds.
Agent.hook('beforeProviderRequest', withMissionExecutionContext);

Agent.hook('beforeProviderRequest', async (request, context) => {
  if (context.purpose !== 'think') return;
  const root = await rootMissionSession(context.sessionId);
  if (!root) return;
  const mission = await MissionConfigs.findOneAsync({ _id: root._id, userId: root.userId });
  if (!mission) return;
  let system = request.system;
  if (mission.objective) {
    system += `\n\n## Mission configuration\nObjective: ${mission.objective}`;
  }
  return {
    ...request,
    system,
  };
});

export const RESPONSE_STYLE_INSTRUCTION = [
  '## Response style',
  '',
  'Format human-facing replies for scanning: use short paragraphs and simple hyphen lists when useful.',
  'Put multi-line code in triple-backtick fences with a language tag, with each fence on its own line; do not fence ordinary prose.',
  'Use native tool calls instead of printing tool-call envelopes as JSON.',
].join('\n');

/** App-level presentation guidance. The framework remains format-neutral, and
 * compaction keeps its own exact output contract. Idempotence matters because
 * the same request can pass through the exchange again on a provider retry. */
export function withResponseStyle(request, context) {
  if (context.purpose !== 'think' || request.system.includes(RESPONSE_STYLE_INSTRUCTION)) {
    return request;
  }
  return {
    ...request,
    system: `${request.system}\n\n${RESPONSE_STYLE_INSTRUCTION}`,
  };
}

Agent.hook('beforeProviderRequest', withResponseStyle);

async function stopMissionExecution(userId, session) {
  let current = await AgentSessions.findOneAsync({
    _id: session._id, userId, erasingAt: { $exists: false },
  });
  for (let depth = 0; current && depth < 8; depth += 1) {
    const nextId = current.activeChild?.sessionId;
    await AgentSessions.updateAsync(
      { _id: current._id, userId, erasingAt: { $exists: false } },
      {
        $set: { phase: 'stopped', updatedAt: new Date() },
        $unset: { pendingSystem: '', pendingRelay: '' },
      },
    );
    current = nextId
      ? await AgentSessions.findOneAsync({ _id: nextId, userId })
      : null;
  }
}

const MISSION_STOP_WAIT_MS = 3_000;
const MISSION_STOP_POLL_MS = 25;

/** Reactivation cannot race the stopped Turn's final cleanup. In particular,
 *  a live parent Lease can still birth/clear an `activeChild` marker while it
 *  unwinds. Keep the Mission inactive until both durable handles are gone. */
export async function waitForMissionQuiescence(
  userId,
  sessionId,
  { timeoutMs = MISSION_STOP_WAIT_MS, pollMs = MISSION_STOP_POLL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = new Date();
    const session = await AgentSessions.findOneAsync(
      { _id: sessionId, userId, agent: 'orchestrator', erasingAt: { $exists: false } },
      { fields: { phase: 1, activeChild: 1, lease: 1 } },
    );
    if (!session) throw new Meteor.Error('no-session', 'Mission not found.');

    const rootLeaseLive = session.lease?.until instanceof Date
      && session.lease.until.getTime() > now.getTime();
    if (session.lease && !rootLeaseLive) {
      // Remove only the expired Lease we observed. Besides avoiding a false
      // wait, this prevents its former holder from passing serverId-only write
      // guards after Reactivate begins.
      await AgentSessions.updateAsync(
        {
          _id: sessionId,
          userId,
          phase: 'stopped',
          'lease.serverId': session.lease.serverId,
          'lease.until': session.lease.until,
        },
        { $unset: { lease: '' } },
      );
      continue;
    }
    if (rootLeaseLive) {
      // The stopped Turn still owns cleanup authority, including the right to
      // clear its exact active-child marker in `finally`.
    } else if (session.activeChild) {
      const marker = session.activeChild;
      const child = await AgentSessions.findOneAsync(
        { _id: marker.sessionId, userId, erasingAt: { $exists: false } },
        { fields: { phase: 1, lease: 1 } },
      );
      const childLeaseLive = child?.lease?.until instanceof Date
        && child.lease.until.getTime() > now.getTime();
      const childActive = child
        && ['streaming', 'calling', 'retrying', 'compacting'].includes(child.phase);
      if (!childActive && !childLeaseLive) {
        // The parent finalizer may have lost its Lease after Stop. Clear only
        // the exact stale hint we inspected so a newer child can never lose
        // its marker to this recovery path.
        await AgentSessions.updateAsync(
          {
            _id: sessionId,
            userId,
            phase: 'stopped',
            'activeChild.sessionId': marker.sessionId,
            'activeChild.toolCallId': marker.toolCallId,
            lease: { $exists: false },
          },
          { $unset: { activeChild: '' } },
        );
        continue;
      }
    } else {
      return session;
    }
    if (Date.now() >= deadline) {
      throw new Meteor.Error(
        'mission-stopping',
        'Mission work is still stopping. Wait a moment, then reactivate it again.',
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}

async function setMissionPulseState(userId, sessionId, active) {
  const now = new Date();
  if (!active) {
    await PulseConfigs.updateAsync(
      { userId, sessionId, enabled: true },
      {
        $set: {
          enabled: false,
          pausedByMission: true,
          lastStatus: 'paused',
          lastErrorCode: 'mission-inactive',
          updatedAt: now,
        },
        $inc: { revision: 1 },
      },
      { multi: true },
    );
    return;
  }
  const paused = await PulseConfigs.find({ userId, sessionId, pausedByMission: true }).fetchAsync();
  for (const pulse of paused) {
    await PulseConfigs.updateAsync(
      { _id: pulse._id, userId, pausedByMission: true },
      {
        $set: {
          enabled: true,
          nextRunAt: nextScheduledAt(pulse.schedule, now),
          lastStatus: 'never',
          lastErrorCode: null,
          updatedAt: now,
        },
        $unset: { pausedByMission: '' },
        $inc: { revision: 1 },
      },
    );
  }
}

async function ensurePulseConfigs(userId, sessionId) {
  const state = await PulseStates.findOneAsync({ userId });
  if (!state && sessionId) {
    for (const defaults of DEFAULT_PULSES) {
      const schedule = normalizeSchedule(defaults.schedule);
      await PulseConfigs.insertAsync({
        ...defaults,
        userId,
        sessionId,
        schedule,
        nextRunAt: nextScheduledAt(schedule, new Date()),
        lastRunAt: null,
        lastStatus: 'never',
        lastErrorCode: null,
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    await PulseStates.insertAsync({ userId, initializedAt: new Date() });
  }
  return PulseConfigs.find({ userId }, { sort: { createdAt: 1 } }).fetchAsync();
}

async function pulseInput(userId, current, patch) {
  assertOnlyKeys(
    patch,
    ['name', 'prompt', 'agent', 'sessionId', 'schedule', 'enabled'],
    'invalid-pulse',
  );
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new Meteor.Error('invalid-pulse', 'Enabled must be true or false.');
  }
  const agent = cleanConfigText(patch.agent, 'Agent', 80, 'invalid-pulse', current?.agent);
  const agentConfig = await CrewConfigs.findOneAsync({ userId, agent });
  if (!agentConfig || !agentConfig.enabled || agentConfig.status === 'archived') {
    throw new Meteor.Error('invalid-pulse', 'Select an active crew agent.');
  }
  const sessionId = cleanConfigText(
    patch.sessionId, 'Mission', 128, 'invalid-pulse', current?.sessionId,
  );
  const session = await AgentSessions.findOneAsync({ _id: sessionId, userId, agent: 'orchestrator' });
  if (!session) throw new Meteor.Error('invalid-pulse', 'Select an available mission.');
  const mission = await ensureMissionConfig(userId, session);
  const enabled = patch.enabled ?? current?.enabled ?? true;
  if (enabled && mission.status !== 'active') {
    throw new Meteor.Error('mission-inactive', 'Activate the mission before enabling a Pulse.');
  }
  let schedule;
  try {
    schedule = normalizeSchedule(patch.schedule ?? current?.schedule);
    nextScheduledAt(schedule, new Date());
  } catch (error) {
    throw new Meteor.Error('invalid-pulse', error.message);
  }
  return {
    name: cleanConfigText(patch.name, 'Name', 80, 'invalid-pulse', current?.name),
    prompt: cleanInstructions(patch.prompt, 'Instructions', 8000, 'invalid-pulse', current?.prompt),
    agent,
    sessionId,
    schedule,
    enabled,
    nextRunAt: nextScheduledAt(schedule, new Date()),
    lastErrorCode: null,
    updatedAt: new Date(),
  };
}

async function skillInput(userId, current, patch) {
  assertOnlyKeys(
    patch,
    ['name', 'description', 'content', 'enabled', 'agents'],
    'invalid-skill',
  );
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new Meteor.Error('invalid-skill', 'Enabled must be true or false.');
  }
  const name = cleanConfigText(patch.name, 'Name', 80, 'invalid-skill', current?.name);
  const slug = slugifySkill(name);
  if (!slug) throw new Meteor.Error('invalid-skill', 'Name must include a letter or number.');
  const requestedAgents = patch.agents ?? current?.agents ?? [];
  if (!Array.isArray(requestedAgents) || requestedAgents.length > 12
    || requestedAgents.some((agent) => typeof agent !== 'string')) {
    throw new Meteor.Error('invalid-skill', 'Agent assignments are invalid.');
  }
  const agents = [...new Set(requestedAgents)];
  const ownedAgents = await CrewConfigs.find(
    { userId, agent: { $in: agents }, status: { $ne: 'archived' } },
    { fields: { agent: 1 } },
  ).fetchAsync();
  if (ownedAgents.length !== agents.length) {
    throw new Meteor.Error('invalid-skill', 'One or more assigned agents no longer exist.');
  }
  const duplicate = await SkillConfigs.findOneAsync({
    userId,
    slug,
    ...(current?._id ? { _id: { $ne: current._id } } : {}),
  });
  if (duplicate) throw new Meteor.Error('duplicate-skill', 'A skill with that name already exists.');
  return {
    name,
    slug,
    description: cleanConfigText(
      patch.description, 'Description', 280, 'invalid-skill', current?.description,
    ),
    content: cleanInstructions(
      patch.content, 'Instructions', 16_000, 'invalid-skill', current?.content,
    ),
    agents,
    enabled: patch.enabled ?? current?.enabled ?? true,
    updatedAt: new Date(),
  };
}

function pulseRunId(pulseId, scheduledFor, manual = false) {
  return manual
    ? `pulse:${pulseId}:manual:${Random.id(12)}`
    : `pulse:${pulseId}:${scheduledFor.toISOString()}`;
}

async function dispatchPulse(pulse, scheduledFor, manual = false) {
  const id = pulseRunId(pulse._id, scheduledFor, manual);
  const session = await AgentSessions.findOneAsync({
    _id: pulse.sessionId, userId: pulse.userId, agent: 'orchestrator',
  });
  const mission = session
    ? await ensureMissionConfig(pulse.userId, session)
    : null;
  const agent = await CrewConfigs.findOneAsync({
    userId: pulse.userId,
    agent: pulse.agent,
    enabled: true,
    status: { $ne: 'archived' },
  });
  if (!session || !agent || mission?.status !== 'active') {
    const reason = !session
      ? 'no-session'
      : (!agent
        ? 'no-agent'
        : 'mission-inactive');
    await PulseConfigs.updateAsync(
      { _id: pulse._id, userId: pulse.userId },
      { $set: {
        lastRunAt: new Date(),
        lastStatus: reason === 'mission-inactive' ? 'paused' : 'error',
        lastErrorCode: reason,
      } },
    );
    return { ok: false, reason };
  }
  try {
    await PulseRuns.insertAsync({
      _id: id,
      pulseId: pulse._id,
      userId: pulse.userId,
      sessionId: pulse.sessionId,
      scheduledFor,
      manual,
      status: 'dispatching',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch {
    return { ok: false, reason: 'duplicate-run' };
  }
  await PulseConfigs.updateAsync(
    { _id: pulse._id, userId: pulse.userId },
    { $set: { lastRunAt: new Date(), lastStatus: 'dispatching', lastErrorCode: null } },
  );
  let outcome;
  try {
    outcome = await orchestrator.systemTurn(
      pulse.sessionId,
      pulse.prompt,
      { key: id, source: `pulse:${pulse._id}`, agent: pulse.agent },
    );
  } catch {
    outcome = { ok: false, reason: 'dispatch-error' };
  }
  const status = outcome.ok ? (outcome.ran ? 'accepted' : 'queued') : 'error';
  await PulseRuns.updateAsync(id, {
    $set: {
      status,
      result: outcome.ok ? (outcome.ran ? 'ran' : 'parked') : outcome.reason,
      updatedAt: new Date(),
    },
  });
  await PulseConfigs.updateAsync(
    { _id: pulse._id, userId: pulse.userId },
    { $set: {
      lastStatus: status,
      lastErrorCode: outcome.ok ? null : outcome.reason,
      lastRunAt: new Date(),
    } },
  );
  return outcome;
}

let scanningPulses = false;
async function scanDuePulses() {
  if (scanningPulses) return;
  scanningPulses = true;
  try {
    const now = new Date();
    const due = await PulseConfigs.find(
      { enabled: true, nextRunAt: { $lte: now } }, { sort: { nextRunAt: 1 }, limit: 20 },
    ).fetchAsync();
    for (const pulse of due) {
      const scheduledFor = pulse.nextRunAt;
      let nextRunAt;
      try {
        // Missed runs coalesce into one catch-up; old intervals are not replayed.
        nextRunAt = nextScheduledAt(pulse.schedule, now);
      } catch {
        await PulseConfigs.updateAsync(
          { _id: pulse._id, userId: pulse.userId },
          { $set: { enabled: false, lastStatus: 'error', lastErrorCode: 'invalid-schedule' } },
        );
        continue;
      }
      const claimed = await PulseConfigs.updateAsync(
        { _id: pulse._id, userId: pulse.userId, enabled: true, nextRunAt: scheduledFor },
        { $set: { nextRunAt, lastStatus: 'dispatching' } },
      );
      if (claimed === 1) await dispatchPulse(pulse, scheduledFor);
    }
  } finally {
    scanningPulses = false;
  }
}

async function crewSession(userId, sessionId) {
  const session = await AgentSessions.findOneAsync({ _id: sessionId, agent: 'orchestrator', userId });
  if (!session) throw new Meteor.Error('no-session', 'Mission not found.');
  if (['streaming', 'calling', 'retrying', 'compacting'].includes(session.phase)) {
    throw new Meteor.Error('mission-busy', 'Wait for the active turn before changing the crew.');
  }
  return session;
}

function workspaceMemberText(value, field, max, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') {
    throw new Meteor.Error('invalid-member', `${field} must be text.`);
  }
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  if (!clean && !optional) {
    throw new Meteor.Error('invalid-member', `${field} cannot be empty.`);
  }
  return clean;
}

function workspaceMemberPatch(patch, allowed) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Meteor.Error('invalid-member', 'Person settings must be an object.');
  }
  const unknown = Object.keys(patch).find((key) => !allowed.has(key));
  if (unknown) throw new Meteor.Error('invalid-member', `Unknown person field: ${unknown}.`);
}

/** Explicit public projection: adding a private field to the durable record can
 * never make it cross DDP by accident. */
export function workspaceMemberPublic(member) {
  if (!member) return null;
  return {
    _id: member._id,
    displayName: member.displayName,
    title: member.title ?? '',
    connection: WORKSPACE_MEMBER_CONNECTIONS.has(member.connection)
      ? member.connection : 'unlinked',
    surfaceKinds: Array.isArray(member.surfaceKinds) ? [...member.surfaceKinds] : [],
    revision: member.revision,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

async function workspaceMemberCreateInput(userId, memberId, patch) {
  workspaceMemberPatch(
    patch,
    new Set(['displayName', 'title', 'linkedUserId', 'identity']),
  );
  const displayName = workspaceMemberText(patch.displayName, 'Name', 80);
  const title = workspaceMemberText(patch.title ?? '', 'Title', 80, { optional: true });
  if (patch.linkedUserId !== undefined && patch.identity !== undefined) {
    throw new Meteor.Error(
      'invalid-member',
      'Choose either an app account or a Channel identity for this person.',
    );
  }

  let linkedUserId;
  let identity;
  let assurance;
  let connection = 'unlinked';
  let surfaceKinds = [];
  if (patch.linkedUserId !== undefined) {
    linkedUserId = workspaceMemberText(patch.linkedUserId, 'Account', 128);
    if (linkedUserId === userId) {
      throw new Meteor.Error('invalid-member', 'The workspace owner is already in every Mission.');
    }
    if (!await Meteor.users.findOneAsync(linkedUserId, { fields: { _id: 1 } })) {
      throw new Meteor.Error('account-not-found', 'That app account is not available.');
    }
    connection = 'account';
    surfaceKinds = ['desktop'];
  } else if (patch.identity !== undefined) {
    workspaceMemberPatch(patch.identity, new Set(['kind', 'externalUserId']));
    const kind = workspaceMemberText(patch.identity.kind, 'Channel kind', 32);
    if (!/^[a-z][a-z0-9-]*$/.test(kind)) {
      throw new Meteor.Error('invalid-member', 'Channel kind is invalid.');
    }
    const externalUserId = workspaceMemberText(
      patch.identity.externalUserId, 'Channel identity', 256,
    );
    const verified = await ChannelIdentities.findOneAsync({ kind, externalUserId });
    if (verified?.userId === userId) {
      throw new Meteor.Error('invalid-member', 'The workspace owner is already in every Mission.');
    }
    if (verified?.userId) linkedUserId = verified.userId;
    identity = { kind, externalUserId };
    assurance = verified?.assurance ?? 'none';
    connection = 'channel';
    surfaceKinds = [kind, ...(linkedUserId ? ['desktop'] : [])];
  }

  if (linkedUserId && await WorkspaceMembers.findOneAsync({ userId, linkedUserId })) {
    throw new Meteor.Error('member-exists', 'That account is already in the workspace directory.');
  }
  if (identity && await WorkspaceMembers.findOneAsync({
    userId,
    'identity.kind': identity.kind,
    'identity.externalUserId': identity.externalUserId,
  })) {
    throw new Meteor.Error('member-exists', 'That Channel identity is already in the workspace directory.');
  }

  return {
    _id: memberId,
    userId,
    participantId: `x:constellation:${memberId}`,
    displayName,
    title,
    connection,
    surfaceKinds: [...new Set(surfaceKinds)],
    ...(linkedUserId ? { linkedUserId } : {}),
    ...(identity ? { identity } : {}),
    ...(assurance ? { assurance } : {}),
  };
}

async function workspaceMemberChannelConnection(userId, memberId, rawIdentity) {
  workspaceMemberPatch(rawIdentity, new Set(['kind', 'externalUserId']));
  const kind = workspaceMemberText(rawIdentity.kind, 'Channel kind', 32);
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) {
    throw new Meteor.Error('invalid-member', 'Channel kind is invalid.');
  }
  const externalUserId = workspaceMemberText(
    rawIdentity.externalUserId, 'Channel identity', 256,
  );
  const duplicateIdentity = await WorkspaceMembers.findOneAsync({
    _id: { $ne: memberId },
    userId,
    'identity.kind': kind,
    'identity.externalUserId': externalUserId,
  });
  if (duplicateIdentity) {
    throw new Meteor.Error('member-exists', 'That Channel identity is already in the directory.');
  }
  const verified = await ChannelIdentities.findOneAsync({ kind, externalUserId });
  if (verified?.userId === userId) {
    throw new Meteor.Error('invalid-member', 'The workspace owner is already in every Mission.');
  }
  const linkedUserId = verified?.userId;
  if (linkedUserId && await WorkspaceMembers.findOneAsync({
    _id: { $ne: memberId }, userId, linkedUserId,
  })) {
    throw new Meteor.Error('member-exists', 'That account is already in the directory.');
  }
  return {
    connection: 'channel',
    surfaceKinds: [kind, ...(linkedUserId ? ['desktop'] : [])],
    identity: { kind, externalUserId },
    assurance: verified?.assurance ?? 'none',
    ...(linkedUserId ? { linkedUserId } : {}),
  };
}

function workspaceMemberConnectionChanged(before, after) {
  return before.connection !== after.connection
    || before.linkedUserId !== after.linkedUserId
    || before.assurance !== after.assurance
    || before.identity?.kind !== after.identity?.kind
    || before.identity?.externalUserId !== after.identity?.externalUserId;
}

function workspaceMemberParticipant(member) {
  return {
    id: member.participantId,
    kind: 'human',
    role: 'member',
    displayName: member.displayName,
    ...(member.linkedUserId ? { userId: member.linkedUserId } : {}),
    ...(member.identity ? { identity: member.identity } : {}),
    ...(member.assurance ? { assurance: member.assurance } : {}),
  };
}

function opaqueParticipationKey(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** Owner-only, sanitized aggregate used by both DDP and mutation replies. */
export async function missionParticipationView(userId, sessionId) {
  const session = await AgentSessions.findOneAsync({
    _id: sessionId,
    userId,
    agent: 'orchestrator',
    erasingAt: { $exists: false },
  });
  if (!session) return null;
  const [members, bindings, missionConfig] = await Promise.all([
    WorkspaceMembers.find({ userId }).fetchAsync(),
    ChannelBindings.find(
      { sessionId },
      {
        fields: {
          kind: 1,
          audience: 1,
          member: 1,
          participant: 1,
          erasingAt: 1,
          updatedAt: 1,
        },
        sort: { createdAt: 1, _id: 1 },
      },
    ).fetchAsync(),
    MissionConfigs.findOneAsync(
      { _id: sessionId, userId }, { fields: { agents: 1, updatedAt: 1 } },
    ),
  ]);
  const memberByParticipant = new Map(members.map((member) => [member.participantId, member]));
  const participantKeys = new Map();
  const participants = (session.participants ?? []).map((participant) => {
    if (participant.kind === 'model') {
      const key = `agent:${participant.agent ?? opaqueParticipationKey(participant.id)}`;
      participantKeys.set(participant.id, key);
      return {
        key,
        kind: 'agent',
        role: 'participant',
        displayName: participant.displayName,
        ...(participant.agent ? { agent: participant.agent } : {}),
        connection: 'agent',
        surfaceKinds: [],
      };
    }
    const member = memberByParticipant.get(participant.id);
    const owner = participant.role === 'owner';
    const key = owner
      ? 'owner'
      : member ? `member:${member._id}` : `human:${opaqueParticipationKey(participant.id)}`;
    participantKeys.set(participant.id, key);
    const connection = owner || participant.userId
      ? 'account' : participant.identity ? 'channel' : 'unlinked';
    const surfaceKinds = member?.surfaceKinds
      ?? (participant.identity ? [participant.identity.kind] : participant.userId ? ['desktop'] : []);
    const rawIdentity = participant.identity?.externalUserId;
    const displayName = !member && rawIdentity && participant.displayName === rawIdentity
      ? 'Channel participant' : participant.displayName;
    return {
      key,
      kind: 'human',
      role: owner ? 'owner' : 'participant',
      displayName,
      ...(member ? { memberId: member._id } : {}),
      connection: member?.connection ?? connection,
      surfaceKinds: [...new Set(surfaceKinds)],
    };
  });
  const surfaces = bindings.map((binding) => ({
    key: `surface:${opaqueParticipationKey(binding._id)}`,
    kind: binding.kind,
    audience: binding.audience,
    status: binding.erasingAt ? 'closing' : 'bound',
    ...(binding.participant && participantKeys.has(binding.participant)
      ? { participantKey: participantKeys.get(binding.participant) } : {}),
    lastActivityAt: binding.updatedAt,
  }));
  const timestamps = [
    session.updatedAt,
    missionConfig?.updatedAt,
    ...bindings.map((binding) => binding.updatedAt),
  ]
    .filter((value) => value instanceof Date);
  return {
    _id: sessionId,
    missionId: sessionId,
    phase: session.phase,
    agentMode: Array.isArray(missionConfig?.agents) ? 'custom' : 'inherit',
    participants,
    surfaces,
    updatedAt: timestamps.length
      ? new Date(Math.max(...timestamps.map((value) => value.getTime())))
      : new Date(),
  };
}

async function reconcileWorkspaceMemberParticipants(userId, member, connectionChanged) {
  const selector = {
    userId,
    erasingAt: { $exists: false },
    participants: {
      $elemMatch: { id: member.participantId, kind: 'human', role: 'member' },
    },
  };
  const sessions = connectionChanged
    ? await AgentSessions.find(selector, { fields: { _id: 1 } }).fetchAsync()
    : [];
  const set = {
    'participants.$[person].displayName': member.displayName,
    updatedAt: new Date(),
  };
  const unset = {};
  if (member.linkedUserId) set['participants.$[person].userId'] = member.linkedUserId;
  else unset['participants.$[person].userId'] = '';
  if (member.identity) set['participants.$[person].identity'] = member.identity;
  else unset['participants.$[person].identity'] = '';
  if (member.assurance) set['participants.$[person].assurance'] = member.assurance;
  else unset['participants.$[person].assurance'] = '';
  await AgentSessions.rawCollection().updateMany(
    selector,
    {
      $set: set,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    { arrayFilters: [{ 'person.id': member.participantId, 'person.kind': 'human' }] },
  );
  if (connectionChanged && sessions.length) {
    await ChannelBindings.removeAsync({
      sessionId: { $in: sessions.map((session) => session._id) },
      member: true,
      participant: member.participantId,
    });
  }
}

async function removeWorkspaceMemberParticipants(userId, participantId) {
  const sessions = await AgentSessions.find(
    {
      userId,
      erasingAt: { $exists: false },
      participants: { $elemMatch: { id: participantId, kind: 'human', role: 'member' } },
    },
    { fields: { _id: 1 } },
  ).fetchAsync();
  for (let offset = 0; offset < sessions.length; offset += 20) {
    await Promise.all(sessions.slice(offset, offset + 20).map(
      (session) => Agent.participants.remove(session._id, participantId),
    ));
  }
}

function withMissionCrewMutation(sessionId, operation) {
  const previous = missionCrewMutationLocks.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(() => undefined, () => undefined);
  missionCrewMutationLocks.set(sessionId, settled);
  return run.finally(() => {
    if (missionCrewMutationLocks.get(sessionId) === settled) {
      missionCrewMutationLocks.delete(sessionId);
    }
  });
}

function withCrewConfigMutation(userId, configId, operation) {
  const key = `${userId}:${configId}`;
  const previous = crewConfigMutationLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(() => undefined, () => undefined);
  crewConfigMutationLocks.set(key, settled);
  return run.finally(() => {
    if (crewConfigMutationLocks.get(key) === settled) crewConfigMutationLocks.delete(key);
  });
}

function withWorkspaceConfigMutation(userId, operation) {
  const previous = workspaceConfigMutationLocks.get(userId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(() => undefined, () => undefined);
  workspaceConfigMutationLocks.set(userId, settled);
  return run.finally(() => {
    if (workspaceConfigMutationLocks.get(userId) === settled) {
      workspaceConfigMutationLocks.delete(userId);
    }
  });
}

function missionCrewStringSet(value, field, maxLength) {
  if (!Array.isArray(value)) {
    throw new Meteor.Error('invalid-mission-crew', `${field} must be a list.`);
  }
  if (value.length > MAX_PARTICIPANTS) {
    throw new Meteor.Error('invalid-mission-crew', `${field} has too many entries.`);
  }
  const clean = value.map((entry) => {
    if (typeof entry !== 'string'
      || entry.length < 1
      || entry.length > maxLength
      || entry !== entry.trim()
      || /[\u0000-\u001f\u007f]/.test(entry)) {
      throw new Meteor.Error('invalid-mission-crew', `${field} contains an invalid identifier.`);
    }
    return entry;
  });
  if (new Set(clean).size !== clean.length) {
    throw new Meteor.Error('invalid-mission-crew', `${field} cannot contain duplicates.`);
  }
  return [...clean].sort((left, right) => left.localeCompare(right));
}

async function validateMissionCrewTarget(userId, sessionId, patch) {
  assertOnlyKeys(patch, ['memberIds', 'agentMode', 'agents'], 'invalid-mission-crew');
  const memberIds = missionCrewStringSet(patch.memberIds, 'People', 128);
  const requestedAgents = missionCrewStringSet(patch.agents, 'Agents', 128);
  if (!['inherit', 'custom'].includes(patch.agentMode)) {
    throw new Meteor.Error(
      'invalid-mission-crew', 'Agent mode must be inherit or custom.',
    );
  }
  if (requestedAgents.includes('orchestrator')) {
    throw new Meteor.Error(
      'invalid-mission-crew', 'Atlas is implicit and cannot be selected as a specialist.',
    );
  }

  const configs = await ensureCrewConfigs(userId);
  const enabledSpecialists = configs.filter(
    (config) => config.agent !== 'orchestrator'
      && config.enabled
      && config.status !== 'archived',
  );
  const enabledByAgent = new Map(enabledSpecialists.map((config) => [config.agent, config]));
  const invalidAgent = requestedAgents.find((agent) => !enabledByAgent.has(agent));
  if (invalidAgent) {
    throw new Meteor.Error('no-agent', 'One or more selected Crew agents are unavailable.');
  }
  const effectiveAgents = patch.agentMode === 'inherit'
    ? enabledSpecialists.map((config) => config.agent).sort((left, right) => left.localeCompare(right))
    : requestedAgents;

  const [allMembers, participants] = await Promise.all([
    WorkspaceMembers.find({ userId }).fetchAsync(),
    Agent.participants.list(sessionId),
  ]);
  const managedParticipantIds = new Set(
    allMembers.map((member) => member.participantId),
  );
  const preservedUnmanagedHumans = participants.filter(
    (participant) => participant.kind === 'human'
      && participant.role !== 'owner'
      && !managedParticipantIds.has(participant.id),
  );
  const total = 2 + memberIds.length + effectiveAgents.length + preservedUnmanagedHumans.length;
  if (total > MAX_PARTICIPANTS) {
    throw new Meteor.Error(
      'mission-crew-full', `A Mission can have at most ${MAX_PARTICIPANTS} participants.`,
    );
  }

  const selectedIds = new Set(memberIds);
  const members = allMembers.filter(
    (member) => selectedIds.has(member._id) && !member.removingAt,
  );
  if (members.length !== memberIds.length) {
    throw new Meteor.Error('no-member', 'One or more selected people are unavailable.');
  }
  const memberById = new Map(members.map((member) => [member._id, member]));
  const orderedMembers = memberIds.map((memberId) => memberById.get(memberId));
  return {
    agentMode: patch.agentMode,
    memberIds,
    members: orderedMembers,
    effectiveAgents,
    configs,
    managedParticipantIds,
  };
}

async function managedMissionParticipantIds(userId, preparedManagedParticipantIds) {
  if (preparedManagedParticipantIds) return preparedManagedParticipantIds;
  return new Set(
    (await WorkspaceMembers.find({ userId }, { fields: { participantId: 1 } }).fetchAsync())
      .map((member) => member.participantId),
  );
}

async function removeDeselectedMissionMembers(
  userId, sessionId, members, preparedManagedParticipantIds,
) {
  const desired = new Map(members.map((member) => [member.participantId, member]));
  const managedParticipantIds = await managedMissionParticipantIds(
    userId, preparedManagedParticipantIds,
  );
  const participants = await Agent.participants.list(sessionId);
  const removals = participants
    .filter((participant) => participant.kind === 'human'
      && participant.role !== 'owner'
      && managedParticipantIds.has(participant.id)
      && !desired.has(participant.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const participant of removals) {
    await Agent.participants.remove(sessionId, participant.id);
  }
  return managedParticipantIds;
}

async function addMissingMissionMembers(userId, sessionId, members) {
  const participants = await Agent.participants.list(sessionId);
  const present = new Set(participants.map((participant) => participant.id));
  for (const member of members) {
    if (present.has(member.participantId)) continue;
    const added = await Agent.participants.add(
      sessionId,
      workspaceMemberParticipant(member),
      { ownerName: 'You', by: humanParticipantId(userId) },
    );
    if (!added) {
      throw new Meteor.Error(
        'mission-crew-reconcile', 'The Mission crew could not be reconciled.',
      );
    }
    present.add(member.participantId);
  }
  return Agent.participants.list(sessionId);
}

function exactMissionCrewIds(actual, desired) {
  return actual.length === desired.size
    && actual.every((value) => desired.has(value));
}

async function verifyMissionCrewTarget(sessionId, target) {
  const participants = await Agent.participants.list(sessionId);
  const desiredAgents = new Set(['orchestrator', ...target.effectiveAgents]);
  const actualAgents = participants
    .filter((participant) => participant.kind === 'model')
    .map((participant) => participant.agent);
  const desiredMembers = new Set(target.members.map((member) => member.participantId));
  const actualMembers = participants
    .filter((participant) => participant.kind === 'human'
      && participant.role !== 'owner'
      && target.managedParticipantIds.has(participant.id))
    .map((participant) => participant.id);
  if (participants.length > MAX_PARTICIPANTS
    || !exactMissionCrewIds(actualAgents, desiredAgents)
    || !exactMissionCrewIds(actualMembers, desiredMembers)) {
    throw new Meteor.Error(
      'mission-crew-reconcile', 'The Mission crew could not be reconciled.',
    );
  }
  return participants;
}

export async function reconcileMissionMembers(
  userId, sessionId, members, preparedManagedParticipantIds,
) {
  await removeDeselectedMissionMembers(
    userId, sessionId, members, preparedManagedParticipantIds,
  );
  return addMissingMissionMembers(userId, sessionId, members);
}

export async function reconcileMissionCrewTarget(userId, sessionId, target) {
  const managedParticipantIds = await removeDeselectedMissionMembers(
    userId, sessionId, target.members, target.managedParticipantIds,
  );
  const preparedTarget = { ...target, managedParticipantIds };
  // Free every outgoing directory-controlled seat before models are added;
  // then add any incoming people after model removals/additions settle. This
  // makes exact swaps safe at the framework's hard participant cap.
  await syncCrewSession(userId, sessionId, target.configs);
  await addMissingMissionMembers(userId, sessionId, target.members);
  return verifyMissionCrewTarget(sessionId, preparedTarget);
}

async function reconcileConfiguredMissionCrew(userId, sessionId, preparedConfigs) {
  const mission = await MissionConfigs.findOneAsync(
    { _id: sessionId, userId }, { fields: { memberIds: 1, agents: 1 } },
  );
  const configs = preparedConfigs ?? await ensureCrewConfigs(userId);
  if (!Array.isArray(mission?.memberIds)) {
    return syncCrewSession(userId, sessionId, configs);
  }
  const allMembers = await WorkspaceMembers.find({ userId }).fetchAsync();
  const availableById = new Map(
    allMembers.filter((member) => !member.removingAt)
      .map((member) => [member._id, member]),
  );
  const selectedAgents = Array.isArray(mission.agents) ? new Set(mission.agents) : null;
  const effectiveAgents = configs.filter((config) => config.agent !== 'orchestrator'
      && config.enabled
      && config.status !== 'archived'
      && (!selectedAgents || selectedAgents.has(config.agent)))
    .map((config) => config.agent);
  return reconcileMissionCrewTarget(userId, sessionId, {
    configs,
    effectiveAgents,
    members: mission.memberIds
      .map((memberId) => availableById.get(memberId)).filter(Boolean),
    managedParticipantIds: new Set(allMembers.map((member) => member.participantId)),
  });
}

Meteor.publish('constellation.crew', function publishCrew() {
  if (!this.userId) return this.ready();
  return CrewConfigs.find({ userId: this.userId }, { fields: { userId: 0 } });
});

Meteor.publish('constellation.learning', async function publishLearning() {
  if (!this.userId) return this.ready();
  if (!await WorkspaceState.findOneAsync(
    { _id: 'local', ownerUserId: this.userId }, { fields: { _id: 1 } },
  )) return this.ready();
  // The package owns the reviewed field allowlists; this app only decides
  // which Agent identities the subscriber may see — its own Crew.
  const publisher = createLearningPublisher(this);
  const initialCrew = await CrewConfigs.find(
    { userId: this.userId }, { fields: { _id: 1 } },
  ).fetchAsync();
  await Promise.all(initialCrew.map((row) => publisher.addAgent(row._id)));
  const crewHandle = await CrewConfigs.find(
    { userId: this.userId }, { fields: { _id: 1 } },
  ).observeChangesAsync({
    added: (id) => {
      void publisher.addAgent(id).catch(() => {
        if (!publisher.stopped) this.error(new Meteor.Error(
          'learning-unavailable', 'Agent learning is temporarily unavailable.',
        ));
      });
    },
  });
  if (publisher.stopped) crewHandle.stop();
  else this.onStop(() => crewHandle.stop());
  if (!publisher.stopped) this.ready();
  return undefined;
});

Meteor.publish('constellation.modelCatalog', async function publishModelCatalog() {
  if (!this.userId) return this.ready();
  const catalog = await modelCatalogView(this.userId);
  this.added('constellation_model_catalog', 'available', catalog);
  this.ready();
  return undefined;
});

Meteor.publish('constellation.workspaceMembers', function publishWorkspaceMembers() {
  if (!this.userId) return this.ready();
  return WorkspaceMembers.find(
    { userId: this.userId },
    {
      fields: {
        displayName: 1,
        title: 1,
        connection: 1,
        surfaceKinds: 1,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      sort: { displayName: 1, createdAt: 1 },
    },
  );
});

Meteor.publish('constellation.missionParticipation', async function publishMissionParticipation(
  sessionId,
) {
  check(sessionId, String);
  if (!this.userId) return this.ready();
  const userId = this.userId;
  const collectionName = 'constellation_mission_participation';
  if (!await AgentSessions.findOneAsync({
    _id: sessionId,
    userId,
    agent: 'orchestrator',
    erasingAt: { $exists: false },
  }, { fields: { _id: 1 } })) return this.ready();

  let stopped = false;
  let published = false;
  let refreshQueue = Promise.resolve();
  const handles = [];
  const stopHandles = () => {
    stopped = true;
    while (handles.length) handles.pop()?.stop();
  };
  this.onStop(stopHandles);
  const refresh = async () => {
    if (stopped) return;
    const view = await missionParticipationView(userId, sessionId);
    if (!view) {
      if (published) this.removed(collectionName, sessionId);
      this.stop();
      return;
    }
    const { _id, ...fields } = view;
    if (!published) {
      this.added(collectionName, _id, fields);
      published = true;
    } else {
      this.changed(collectionName, _id, fields);
    }
  };
  const queueRefresh = () => {
    refreshQueue = refreshQueue.then(refresh).catch((error) => {
      console.warn('[constellation] Mission participation projection failed:', error?.message ?? error);
      if (!stopped) this.error(new Meteor.Error(
        'participation-unavailable', 'Mission participation is temporarily unavailable.',
      ));
    });
  };
  const watch = async (cursor, callbacks = {}) => {
    const handle = await cursor.observeChangesAsync({
      added: queueRefresh,
      changed: queueRefresh,
      removed: queueRefresh,
      ...callbacks,
    });
    if (stopped) handle.stop();
    else handles.push(handle);
  };
  await Promise.all([
    watch(AgentSessions.find(
      {
        _id: sessionId,
        userId,
        agent: 'orchestrator',
        erasingAt: { $exists: false },
      },
      { fields: { phase: 1, participants: 1, updatedAt: 1 } },
    ), { removed: () => this.stop() }),
    watch(ChannelBindings.find(
      { sessionId },
      {
        fields: {
          kind: 1,
          audience: 1,
          participant: 1,
          erasingAt: 1,
          updatedAt: 1,
        },
      },
    )),
    watch(WorkspaceMembers.find(
      { userId },
      {
        fields: {
          participantId: 1,
          displayName: 1,
          connection: 1,
          surfaceKinds: 1,
          updatedAt: 1,
        },
      },
    )),
    watch(MissionConfigs.find(
      { _id: sessionId, userId },
      { fields: { agents: 1, updatedAt: 1 } },
    )),
  ]);
  await refreshQueue;
  if (!published && !stopped) await refresh();
  if (!stopped) this.ready();
  return undefined;
});

Meteor.publish('constellation.missions', function publishMissionConfigs() {
  if (!this.userId) return this.ready();
  return MissionConfigs.find({ userId: this.userId }, { fields: { userId: 0 } });
});

Meteor.publish('constellation.pulses', function publishPulses() {
  if (!this.userId) return this.ready();
  return PulseConfigs.find({ userId: this.userId }, { fields: { userId: 0 } });
});

Meteor.publish('constellation.skills', function publishSkills() {
  if (!this.userId) return this.ready();
  return SkillConfigs.find({ userId: this.userId }, { fields: { userId: 0 } });
});

Meteor.publish('constellation.channels', function publishChannels() {
  if (!this.userId) return this.ready();
  return ChannelConfigs.find(
    { userId: this.userId },
    {
      fields: {
        kind: 1,
        enabled: 1,
        settings: 1,
        configuredFields: 1,
        status: 1,
        lastErrorCode: 1,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        runtimeUpdatedAt: 1,
      },
    },
  );
});

Meteor.publish('constellation.mcp', function publishMcpConfigs() {
  if (!this.userId) return this.ready();
  return McpConfigs.find(
    { userId: this.userId }, { fields: MCP_PUBLIC_FIELDS, sort: { managed: 1, name: 1 } },
  );
});

Meteor.publish('constellation.toolCatalog', function publishToolCatalog() {
  if (!this.userId) return this.ready();
  return ToolCatalog.find(
    { userId: this.userId },
    { fields: { userId: 0 }, sort: { source: 1, displayName: 1 }, limit: 500 },
  );
});

for (const collection of [
  WorkspaceState,
  MissionConfigs,
  CrewConfigs,
  CrewStates,
  WorkspaceMembers,
  PulseConfigs,
  PulseRuns,
  PulseStates,
  SkillConfigs,
  SkillStates,
  ChannelConfigs,
  ChannelSecrets,
  McpConfigs,
  McpSecrets,
  ToolCatalog,
]) {
  collection.deny({
    insert: () => true,
    update: () => true,
    remove: () => true,
  });
}

DDPRateLimiter.addRule(
  {
    type: 'method',
    name: (name) => typeof name === 'string' && name.startsWith('constellation.'),
    connectionId: () => true,
  },
  30,
  10_000,
);

DDPRateLimiter.addRule(
  { type: 'method', name: 'constellation.channelTest', userId: () => true },
  5,
  60_000,
);

Meteor.methods({
  async 'constellation.constitutionRevise'(agentId, expectedGeneration, body, reason) {
    check(agentId, String);
    check(expectedGeneration, Number);
    check(body, String);
    check(reason, String);
    await claimWorkspace(this.userId);
    await ownedLearningIdentity(this.userId, agentId, { active: true });
    // The package raises structured codes (e.g. identity-generation-conflict)
    // that reach DDP callers directly; nothing to translate here.
    return governedConstitutionRevise(
      LEARNING_SOURCE_NS, agentId, expectedGeneration, body, reason,
    );
  },

  async 'constellation.experienceRetract'(agentId, experienceId, reason) {
    check(agentId, String);
    check(experienceId, String);
    check(reason, String);
    await claimWorkspace(this.userId);
    await ownedLearningIdentity(this.userId, agentId, { active: true });
    return governedExperienceRetract(LEARNING_SOURCE_NS, agentId, experienceId, reason);
  },

  async 'constellation.learningReview'(agentId, target, targetId) {
    check(agentId, String);
    check(target, String);
    check(targetId, String);
    // Input contract precedes authorization so a malformed call is refused
    // as such even for identities outside this workspace.
    assertLearningReviewTarget(target);
    await claimWorkspace(this.userId);
    await ownedLearningIdentity(this.userId, agentId, { active: true });
    return governedLearningReview(LEARNING_SOURCE_NS, agentId, target, targetId, this.userId);
  },

  async 'constellation.practicePropose'(agentId, proposal) {
    check(agentId, String);
    check(proposal, Object);
    if (proposal.commandId !== undefined) check(proposal.commandId, String);
    await claimWorkspace(this.userId);
    await ownedLearningIdentity(this.userId, agentId, { active: true });
    return governedPracticePropose(LEARNING_SOURCE_NS, agentId, proposal);
  },

  async 'constellation.practiceTransition'(
    agentId, practiceId, status, reason, hardeningEvidenceId,
  ) {
    check(agentId, String);
    check(practiceId, String);
    check(status, String);
    check(reason, String);
    if (hardeningEvidenceId !== undefined) check(hardeningEvidenceId, String);
    // Same ordering rationale as learningReview: evidence contract first.
    assertPracticeTransitionEvidence(status, hardeningEvidenceId);
    await claimWorkspace(this.userId);
    await ownedLearningIdentity(this.userId, agentId, { active: true });
    return governedPracticeTransition(
      LEARNING_SOURCE_NS, agentId, practiceId, status, reason, hardeningEvidenceId,
    );
  },

  async 'constellation.bootstrap'() {
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const crew = await ensureCrewConfigs(this.userId);
    const modelCatalog = await modelCatalogView(this.userId);
    const sessions = await AgentSessions.find(
      { userId: this.userId, agent: 'orchestrator', parent: { $exists: false } },
      { sort: { updatedAt: -1 }, limit: 100 },
    ).fetchAsync();
    for (const session of sessions) await ensureMissionConfig(this.userId, session);
    const recentSession = sessions[0];
    await ensurePulseConfigs(this.userId, recentSession?._id);
    const channels = await ensureChannelConfigs(this.userId);
    const mcp = await reconcileAllMcpRuntime(this.userId);
    return {
      live,
      model: modelCatalog.defaultModel,
      channels: channels.filter((row) => row.status === 'active').map((row) => row.kind),
      agents: crew.filter(
        (row) => row.enabled && row.status !== 'archived',
      ).map((row) => row.agent),
      release: '0.2.1-rc.1',
      scheduler: true,
      secureCredentials: !!configKeyBytes,
      mcp: {
        configured: mcp.filter((row) => row.managed === 'workspace').length,
        ready: mcp.filter((row) => row.status === 'ready').length,
      },
    };
    });
  },

  async 'constellation.prepareSession'(sessionId) {
    check(sessionId, String);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const session = await AgentSessions.findOneAsync({ _id: sessionId, agent: 'orchestrator', userId: this.userId });
    if (!session) throw new Meteor.Error('no-session', 'Mission not found.');
    await ensureMissionConfig(this.userId, session);
    await ensurePulseConfigs(this.userId, sessionId);
    return reconcileConfiguredMissionCrew(this.userId, sessionId);
    });
  },

  async 'constellation.missionSave'(sessionId, expectedRevision, patch) {
    check(sessionId, String);
    check(expectedRevision, Number);
    check(patch, Object);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const session = await AgentSessions.findOneAsync({
      _id: sessionId, userId: this.userId, agent: 'orchestrator',
    });
    if (!session) throw new Meteor.Error('no-session', 'Mission not found.');
    const current = await ensureMissionConfig(this.userId, session);
    if (current.revision !== expectedRevision) {
      throw new Meteor.Error(
        'stale-mission',
        'Mission changed in another window. Reopen settings and try again.',
      );
    }
    const next = missionInput(current, patch);
    if (['streaming', 'calling', 'retrying', 'compacting'].includes(session.phase)
      && next.status === 'active') {
      throw new Meteor.Error('mission-busy', 'Pause the mission before changing its configuration.');
    }
    const reactivating = current.status !== 'active' && next.status === 'active';
    if (reactivating) {
      // This runs before the MissionConfig CAS. A fast Reactivate click can
      // wait for ordinary cleanup, but it can never make the Mission active
      // while the stopped Turn still owns a Lease or live-child marker.
      await waitForMissionQuiescence(this.userId, sessionId);
    }
    const changed = await MissionConfigs.updateAsync(
      { _id: sessionId, userId: this.userId, revision: expectedRevision },
      { $set: next, $inc: { revision: 1 } },
    );
    if (changed !== 1) throw new Meteor.Error('stale-mission', 'Mission changed in another window.');
    await AgentSessions.updateAsync(
      { _id: sessionId, userId: this.userId, agent: 'orchestrator' },
      { $set: { title: next.title, updatedAt: new Date() } },
    );
    if (next.status !== 'active') await stopMissionExecution(this.userId, session);
    else if (reactivating) {
      // A paused approval is a durable question, not discarded work. Restore
      // that exact gate when the Mission is reactivated so it never becomes a
      // hidden `pending` marker on an idle session.
      await AgentSessions.updateAsync(
        {
          _id: sessionId,
          userId: this.userId,
          agent: 'orchestrator',
          phase: 'stopped',
          activeChild: { $exists: false },
          lease: { $exists: false },
          'pending.toolCallId': { $exists: true },
          'pending.verdict': { $exists: false },
        },
        { $set: { phase: 'awaiting', updatedAt: new Date() } },
      );
      await AgentSessions.updateAsync(
        {
          _id: sessionId,
          userId: this.userId,
          agent: 'orchestrator',
          phase: 'stopped',
          activeChild: { $exists: false },
          lease: { $exists: false },
        },
        { $set: { phase: 'idle', updatedAt: new Date() } },
      );
    }
    await setMissionPulseState(this.userId, sessionId, next.status === 'active');
    await reconcileConfiguredMissionCrew(this.userId, sessionId);
    return MissionConfigs.findOneAsync(
      { _id: sessionId, userId: this.userId }, { fields: { userId: 0 } },
    );
    });
  },

  // Continuity is a preference about the NEXT launch, not this run, so it
  // needs neither the settings dialog's revision handshake nor the
  // mission-busy fence that guards execution-affecting config.
  async 'constellation.missionContinuitySet'(sessionId, enabled) {
    check(sessionId, String);
    check(enabled, Boolean);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
      const session = await AgentSessions.findOneAsync({
        _id: sessionId, userId, agent: 'orchestrator',
      });
      if (!session) throw new Meteor.Error('no-session', 'Mission not found.');
      const current = await ensureMissionConfig(userId, session);
      if (current.status === 'completed') {
        throw new Meteor.Error('mission-completed', 'A completed mission does not reopen.');
      }
      await MissionConfigs.updateAsync(
        { _id: sessionId, userId },
        { $set: { continuity: enabled }, $inc: { revision: 1 } },
      );
      return MissionConfigs.findOneAsync({ _id: sessionId, userId });
    });
  },

  async 'constellation.missionCrewSave'(sessionId, expectedMissionRevision, patch) {
    check(sessionId, String);
    check(expectedMissionRevision, Number);
    check(patch, Object);
    await claimWorkspace(this.userId);
    if (!Number.isInteger(expectedMissionRevision) || expectedMissionRevision < 1) {
      throw new Meteor.Error('invalid-mission-crew', 'Mission revision must be a positive integer.');
    }
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, () => withMissionCrewMutation(sessionId, async () => {
      const session = await crewSession(userId, sessionId);
      const current = await ensureMissionConfig(userId, session);
      if (current.revision !== expectedMissionRevision) {
        throw new Meteor.Error(
          'stale-mission', 'Mission changed in another window. Reload the crew and try again.',
        );
      }
      // Everything that can be rejected by user input is checked before the
      // MissionConfig compare-and-set, so invalid/cap failures mutate nothing.
      const target = await validateMissionCrewTarget(userId, sessionId, patch);
      const updatedAt = new Date();
      const modifier = {
        $set: {
          memberIds: target.memberIds,
          updatedAt,
          ...(target.agentMode === 'custom' ? { agents: target.effectiveAgents } : {}),
        },
        ...(target.agentMode === 'inherit' ? { $unset: { agents: 1 } } : {}),
        $inc: { revision: 1 },
      };
      const changed = await MissionConfigs.updateAsync(
        { _id: sessionId, userId, revision: expectedMissionRevision },
        modifier,
      );
      if (changed !== 1) {
        throw new Meteor.Error(
          'stale-mission', 'Mission changed in another window. Reload the crew and try again.',
        );
      }

      // Config is desired state. Re-running this call with the newly published
      // revision heals a rare post-CAS infrastructure failure; prepareSession
      // also reconciles explicit people on the next open.
      await reconcileMissionCrewTarget(userId, sessionId, target);
      const saved = await MissionConfigs.findOneAsync(
        { _id: sessionId, userId }, { fields: { revision: 1, agents: 1 } },
      );
      return {
        revision: saved.revision,
        agentMode: Array.isArray(saved.agents) ? 'custom' : 'inherit',
        participation: await missionParticipationView(userId, sessionId),
      };
    }));
  },

  async 'constellation.workspaceMemberCreate'(patch) {
    check(patch, Object);
    await claimWorkspace(this.userId);
    if (await WorkspaceMembers.find({ userId: this.userId }).countAsync()
      >= WORKSPACE_MEMBER_MAX) {
      throw new Meteor.Error('member-limit', 'Workspace people limit reached.');
    }
    const memberId = Random.id();
    const input = await workspaceMemberCreateInput(this.userId, memberId, patch);
    try {
      await WorkspaceMembers.insertAsync({
        ...input,
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (error) {
      if (error?.code === 11000 || /duplicate key/i.test(String(error?.message ?? ''))) {
        throw new Meteor.Error('member-exists', 'That person is already in the workspace directory.');
      }
      throw error;
    }
    return memberId;
  },

  async 'constellation.workspaceMemberSave'(memberId, expectedRevision, patch) {
    check(memberId, String);
    check(expectedRevision, Number);
    check(patch, Object);
    await claimWorkspace(this.userId);
    workspaceMemberPatch(
      patch, new Set(['displayName', 'title', 'identity', 'clearIdentity']),
    );
    if (patch.clearIdentity !== undefined && typeof patch.clearIdentity !== 'boolean') {
      throw new Meteor.Error('invalid-member', 'Clear identity must be true or false.');
    }
    if (patch.identity !== undefined && patch.clearIdentity === true) {
      throw new Meteor.Error(
        'invalid-member', 'Choose a Channel identity or clear the connection, not both.',
      );
    }
    const current = await WorkspaceMembers.findOneAsync({ _id: memberId, userId: this.userId });
    if (!current) throw new Meteor.Error('no-member', 'Person not found.');
    if (current.removingAt) {
      throw new Meteor.Error('member-removing', 'This person is being removed.');
    }
    if (current.revision !== expectedRevision) {
      throw new Meteor.Error(
        'stale-member', 'This person changed in another window. Reopen and try again.',
      );
    }
    const displayName = patch.displayName === undefined
      ? current.displayName : workspaceMemberText(patch.displayName, 'Name', 80);
    const title = patch.title === undefined
      ? current.title ?? ''
      : workspaceMemberText(patch.title, 'Title', 80, { optional: true });
    let connection;
    if (patch.identity !== undefined) {
      connection = await workspaceMemberChannelConnection(
        this.userId, memberId, patch.identity,
      );
    } else if (patch.clearIdentity === true) {
      connection = { connection: 'unlinked', surfaceKinds: [] };
    }
    const updatedAt = new Date();
    const set = { displayName, title, updatedAt };
    const unset = {};
    if (connection) {
      set.connection = connection.connection;
      set.surfaceKinds = connection.surfaceKinds;
      if (connection.identity) set.identity = connection.identity;
      else unset.identity = 1;
      if (connection.linkedUserId) set.linkedUserId = connection.linkedUserId;
      else unset.linkedUserId = 1;
      if (connection.assurance) set.assurance = connection.assurance;
      else unset.assurance = 1;
    }
    let changed;
    try {
      changed = await WorkspaceMembers.updateAsync(
        {
          _id: memberId,
          userId: this.userId,
          revision: expectedRevision,
          removingAt: { $exists: false },
        },
        {
          $set: set,
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
          $inc: { revision: 1 },
        },
      );
    } catch (error) {
      if (error?.code === 11000 || /duplicate key/i.test(String(error?.message ?? ''))) {
        throw new Meteor.Error('member-exists', 'That identity is already in the directory.');
      }
      throw error;
    }
    if (changed !== 1) {
      throw new Meteor.Error('stale-member', 'This person changed in another window.');
    }
    const saved = await WorkspaceMembers.findOneAsync({
      _id: memberId, userId: this.userId,
    });
    await reconcileWorkspaceMemberParticipants(
      this.userId, saved, workspaceMemberConnectionChanged(current, saved),
    );
    return workspaceMemberPublic(saved);
  },

  async 'constellation.workspaceMemberImpact'(memberId) {
    check(memberId, String);
    await claimWorkspace(this.userId);
    const member = await WorkspaceMembers.findOneAsync({ _id: memberId, userId: this.userId });
    if (!member) throw new Meteor.Error('no-member', 'Person not found.');
    const sessions = await AgentSessions.find(
      {
        userId: this.userId,
        agent: 'orchestrator',
        erasingAt: { $exists: false },
        participants: { $elemMatch: { id: member.participantId, kind: 'human' } },
      },
      { fields: { _id: 1, title: 1, updatedAt: 1 }, sort: { updatedAt: -1 } },
    ).fetchAsync();
    const missionIds = sessions.map((session) => session._id);
    const configs = missionIds.length
      ? await MissionConfigs.find(
        { _id: { $in: missionIds }, userId: this.userId },
        { fields: { title: 1, status: 1 } },
      ).fetchAsync()
      : [];
    const configById = new Map(configs.map((config) => [config._id, config]));
    return {
      memberId: member._id,
      displayName: member.displayName,
      missions: sessions.map((session) => ({
        sessionId: session._id,
        title: configById.get(session._id)?.title ?? session.title ?? 'Untitled mission',
        status: configById.get(session._id)?.status ?? 'active',
      })),
    };
  },

  async 'constellation.workspaceMemberRemove'(memberId, expectedRevision) {
    check(memberId, String);
    check(expectedRevision, Number);
    await claimWorkspace(this.userId);
    const current = await WorkspaceMembers.findOneAsync({ _id: memberId, userId: this.userId });
    if (!current) throw new Meteor.Error('no-member', 'Person not found.');
    if (current.revision !== expectedRevision) {
      throw new Meteor.Error('stale-member', 'This person changed in another window.');
    }
    let removingAt = current.removingAt;
    if (!removingAt) {
      removingAt = new Date();
      const claimed = await WorkspaceMembers.updateAsync(
        {
          _id: memberId,
          userId: this.userId,
          revision: expectedRevision,
          removingAt: { $exists: false },
        },
        { $set: { removingAt } },
      );
      if (claimed !== 1) {
        throw new Meteor.Error('stale-member', 'This person changed in another window.');
      }
    }
    // Revoke every Mission capability before deleting the directory record.
    // If cleanup fails, `removingAt` preserves an owner-visible retry handle.
    await removeWorkspaceMemberParticipants(this.userId, current.participantId);
    await MissionConfigs.updateAsync(
      { userId: this.userId, memberIds: memberId },
      {
        $pull: { memberIds: memberId },
        $inc: { revision: 1 },
        $set: { updatedAt: new Date() },
      },
      { multi: true },
    );
    const removed = await WorkspaceMembers.removeAsync({
      _id: memberId,
      userId: this.userId,
      revision: expectedRevision,
      participantId: current.participantId,
      removingAt,
    });
    if (removed !== 1) {
      throw new Meteor.Error('stale-member', 'This person changed or was already removed.');
    }
    return true;
  },

  async 'constellation.missionMemberAdd'(sessionId, memberId) {
    check(sessionId, String);
    check(memberId, String);
    await claimWorkspace(this.userId);
    await crewSession(this.userId, sessionId);
    const member = await WorkspaceMembers.findOneAsync({
      _id: memberId, userId: this.userId, removingAt: { $exists: false },
    });
    if (!member) throw new Meteor.Error('no-member', 'Person not found.');
    const added = await Agent.participants.add(
      sessionId,
      workspaceMemberParticipant(member),
      { ownerName: 'You', by: humanParticipantId(this.userId) },
    );
    if (!added) {
      throw new Meteor.Error('mission-crew-full', 'This Mission already has 16 participants.');
    }
    await MissionConfigs.updateAsync(
      { _id: sessionId, userId: this.userId, memberIds: { $exists: true } },
      {
        $addToSet: { memberIds: memberId },
        $inc: { revision: 1 },
        $set: { updatedAt: new Date() },
      },
    );
    return missionParticipationView(this.userId, sessionId);
  },

  async 'constellation.missionMemberRemove'(sessionId, memberId) {
    check(sessionId, String);
    check(memberId, String);
    await claimWorkspace(this.userId);
    await crewSession(this.userId, sessionId);
    const member = await WorkspaceMembers.findOneAsync({ _id: memberId, userId: this.userId });
    if (!member) throw new Meteor.Error('no-member', 'Person not found.');
    await Agent.participants.remove(sessionId, member.participantId);
    await MissionConfigs.updateAsync(
      { _id: sessionId, userId: this.userId, memberIds: { $exists: true } },
      {
        $pull: { memberIds: memberId },
        $inc: { revision: 1 },
        $set: { updatedAt: new Date() },
      },
    );
    return missionParticipationView(this.userId, sessionId);
  },

  async 'constellation.missionAgentAdd'(sessionId, agent) {
    check(sessionId, String);
    check(agent, String);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    await crewSession(this.userId, sessionId);
    if (agent === 'orchestrator') {
      throw new Meteor.Error('primary-agent', 'Atlas is already required for every Mission.');
    }
    const config = await CrewConfigs.findOneAsync({
      userId: this.userId,
      agent,
      enabled: true,
      status: { $ne: 'archived' },
    });
    if (!config) throw new Meteor.Error('no-agent', 'Active Crew agent not found.');
    await materializeMissionAgentSelection(this.userId, sessionId);
    await MissionConfigs.updateAsync(
      { _id: sessionId, userId: this.userId },
      {
        $addToSet: { agents: agent },
        $inc: { revision: 1 },
        $set: { updatedAt: new Date() },
      },
    );
    await syncCrewSession(this.userId, sessionId);
    return missionParticipationView(this.userId, sessionId);
    });
  },

  async 'constellation.missionAgentRemove'(sessionId, agent) {
    check(sessionId, String);
    check(agent, String);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    await crewSession(this.userId, sessionId);
    if (agent === 'orchestrator') {
      throw new Meteor.Error('primary-agent', 'Atlas is required for every Mission.');
    }
    if (!await CrewConfigs.findOneAsync({ userId: this.userId, agent })) {
      throw new Meteor.Error('no-agent', 'Crew agent not found.');
    }
    await materializeMissionAgentSelection(this.userId, sessionId);
    await MissionConfigs.updateAsync(
      { _id: sessionId, userId: this.userId },
      {
        $pull: { agents: agent },
        $inc: { revision: 1 },
        $set: { updatedAt: new Date() },
      },
    );
    await syncCrewSession(this.userId, sessionId);
    return missionParticipationView(this.userId, sessionId);
    });
  },

  async 'constellation.crewCreate'(sessionId, patch) {
    check(sessionId, String);
    if (patch !== undefined) check(patch, Object);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    await crewSession(this.userId, sessionId);
    const existing = await ensureCrewConfigs(this.userId);
    const activeCrew = existing.filter((row) => row.status !== 'archived');
    if (activeCrew.length >= 12) throw new Meteor.Error('crew-full', 'Crew limit reached.');
    const token = Random.id(8).toLowerCase();
    const config = {
      userId: this.userId,
      agent: `crew-${token}`,
      displayName: 'New agent',
      role: 'Specialist',
      avatar: 'N',
      color: 'violet',
      enabled: true,
      order: (Math.max(0, ...existing.map((row) => row.order ?? 0)) + 10),
      revision: 1,
      status: 'available',
      constitution: DEFAULT_AGENT_CONSTITUTION,
      instructions: 'Work only within the assigned scope. State assumptions and return a concise recommendation with next actions.',
      model: 'default',
      flexibility: DEFAULT_CREW_FLEXIBILITY,
      experience: { ...DEFAULT_CREW_EXPERIENCE },
      practice: { ...DEFAULT_CREW_PRACTICE },
      budget: { turns: 24, toolCalls: 8, spend: 1 },
      capabilities: { inspect: true, framing: false, memory: false, publish: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const availableModelIds = modelIdsFromCatalog(await modelCatalogView(this.userId));
    const normalized = normalizeCrewPatch(config, patch ?? {}, availableModelIds);
    const id = await CrewConfigs.insertAsync({
      ...config,
      ...normalized,
      revision: 1,
      status: normalized.enabled ? 'available' : 'unavailable',
      constitution: config.constitution,
      createdAt: config.createdAt,
    });
    await syncCrewAcrossMissions(this.userId);
    return id;
    });
  },

  async 'constellation.crewSave'(sessionId, configId, patch) {
    check(sessionId, String);
    check(configId, String);
    check(patch, Object);
    await claimWorkspace(this.userId);
    await crewSession(this.userId, sessionId);
    const userId = this.userId;
    return withCrewConfigMutation(userId, configId, async () => {
    await backfillCrewConfigs(this.userId);
    const current = await CrewConfigs.findOneAsync({ _id: configId, userId: this.userId });
    if (!current) throw new Meteor.Error('no-agent', 'Crew agent not found.');
    if (current.status === 'archived' || current.archivedAt) {
      throw new Meteor.Error('agent-archived', 'Restore this Agent before editing it.');
    }
    const { expectedRevision, ...mutablePatch } = patch;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Meteor.Error('invalid-crew', 'Expected revision must be a positive integer.');
    }
    if (current.revision !== expectedRevision) {
      throw new Meteor.Error('stale-agent', 'This Agent changed before the save started.');
    }
    const availableModelIds = modelIdsFromCatalog(await modelCatalogView(this.userId));
    const next = normalizeCrewPatch(current, mutablePatch, availableModelIds);
    if (current.agent === 'orchestrator') next.enabled = true;
    const [identity] = await Agent.learning.read.identities([current._id]).fetchAsync();
    const committed = identity?.flexibility
      ? identity.flexibility.capacity - identity.flexibility.available : 0;
    if (next.flexibility < committed) {
      throw new Meteor.Error(
        'invalid-crew',
        `Practice capacity cannot be lower than ${committed}; retire a hardened Practice first.`,
      );
    }
    // Validate and apply Identity-bound fields before committing the Crew row.
    // If the Crew CAS loses, reconcile back to the winning durable config so
    // display name and flexibility cannot drift across the two collections.
    try {
      await syncCrewLearningIdentity({ ...current, ...next });
    } catch (error) {
      if (String(error?.message ?? error).includes('flexibility cannot fall below hardened cost')) {
        throw new Meteor.Error(
          'invalid-crew', 'Practice capacity is below the current hardened Practice count.',
        );
      }
      throw error;
    }
    const saved = await CrewConfigs.updateAsync(
      {
        _id: configId,
        userId: this.userId,
        revision: expectedRevision,
        status: { $ne: 'archived' },
      },
      {
        $set: {
          ...next,
          status: next.enabled ? 'available' : 'unavailable',
        },
        $inc: { revision: 1 },
      },
    );
    if (saved !== 1) {
      const winner = await CrewConfigs.findOneAsync({ _id: configId, userId: this.userId });
      if (winner) await syncCrewLearningIdentity(winner);
      throw new Meteor.Error('stale-agent', 'This Agent changed before the save completed.');
    }
    if (!next.enabled) {
      await PulseConfigs.updateAsync(
        { userId: this.userId, agent: current.agent, enabled: true },
        {
          $set: { enabled: false, lastStatus: 'error', lastErrorCode: 'agent-disabled', updatedAt: new Date() },
          $inc: { revision: 1 },
        },
        { multi: true },
      );
    }
    await syncCrewAcrossMissions(this.userId);
    return CrewConfigs.findOneAsync({ _id: configId, userId: this.userId }, { fields: { userId: 0 } });
    });
  },

  async 'constellation.crewImpact'(configId) {
    check(configId, String);
    await claimWorkspace(this.userId);
    const config = await CrewConfigs.findOneAsync({ _id: configId, userId: this.userId });
    if (!config) throw new Meteor.Error('no-agent', 'Crew agent not found.');
    if (config.agent === 'orchestrator') {
      throw new Meteor.Error('primary-agent', 'The primary Agent cannot be archived.');
    }
    return crewArchiveImpact(this.userId, config);
  },

  async 'constellation.crewArchive'(
    sessionId, configId, expectedAgent, expectedRevision, expectedImpactDigest,
  ) {
    check(sessionId, String);
    check(configId, String);
    check(expectedAgent, String);
    check(expectedRevision, Number);
    check(expectedImpactDigest, String);
    await claimWorkspace(this.userId);
    await crewSession(this.userId, sessionId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, () => (
      withCrewConfigMutation(userId, configId, () => archiveCrewConfig(
        userId, configId, expectedAgent, expectedRevision, expectedImpactDigest,
      ))
    ));
  },

  async 'constellation.crewRestore'(configId, expectedRevision) {
    check(configId, String);
    if (expectedRevision === undefined) {
      throw new Meteor.Error('invalid-crew', 'Restore requires the archived Agent revision.');
    }
    check(expectedRevision, Number);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, () => withCrewConfigMutation(
      userId, configId, async () => {
    await backfillCrewConfigs(this.userId);
    const current = await CrewConfigs.findOneAsync({ _id: configId, userId: this.userId });
    if (!current) throw new Meteor.Error('no-agent', 'Crew agent not found.');
    if (current.status !== 'archived') {
      throw new Meteor.Error('agent-not-archived', 'This Agent is not archived.');
    }
    if (current.archiveCleanupPending) {
      throw new Meteor.Error(
        'archive-cleanup-pending',
        'This Agent is still finishing archival. Try restore again when cleanup completes.',
      );
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Meteor.Error('invalid-crew', 'Expected revision must be a positive integer.');
    }
    const restored = await CrewConfigs.updateAsync(
      {
        _id: configId,
        userId: this.userId,
        status: 'archived',
        revision: expectedRevision,
      },
      {
        $set: {
          enabled: false,
          status: 'unavailable',
          updatedAt: new Date(),
        },
        $unset: { archivedAt: '', archivedBy: '' },
        $inc: { revision: 1 },
      },
    );
    if (restored !== 1) {
      throw new Meteor.Error('stale-agent', 'This Agent changed before it could be restored.');
    }
    // Restore only the identity. Prior Mission, Skill, MCP, Pulse, and Tool
    // assignments remain detached until a person explicitly configures them.
    await syncCrewAcrossMissions(this.userId);
    return true;
      },
    ));
  },

  async 'constellation.runHeartbeat'(sessionId) {
    check(sessionId, String);
    await claimWorkspace(this.userId);
    const session = await AgentSessions.findOneAsync({ _id: sessionId, agent: 'orchestrator', userId: this.userId });
    if (!session) throw new Meteor.Error('no-session', 'Mission not found.');
    const mission = await ensureMissionConfig(this.userId, session);
    if (mission.status !== 'active') return { ok: false, reason: 'mission-inactive' };
    return orchestrator.systemTurn(
      sessionId,
      'Run the scheduled mission heartbeat. Inspect the workspace for blockers and recommend the single highest-leverage next move. Do not repeat finished work.',
      { key: `heartbeat:${Date.now()}:${Random.id(8)}`, source: 'desktop:pulse', agent: 'orchestrator' },
    );
  },

  async 'constellation.pulseCreate'(patch) {
    check(patch, Object);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const existing = await PulseConfigs.find({ userId: this.userId }).countAsync();
    if (existing >= 40) throw new Meteor.Error('pulse-limit', 'Pulse limit reached.');
    const next = await pulseInput(this.userId, null, patch);
    return PulseConfigs.insertAsync({
      ...next,
      userId: this.userId,
      lastRunAt: null,
      lastStatus: 'never',
      revision: 1,
      createdAt: new Date(),
    });
    });
  },

  async 'constellation.pulseSave'(pulseId, expectedRevision, patch) {
    check(pulseId, String);
    check(expectedRevision, Number);
    check(patch, Object);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const current = await PulseConfigs.findOneAsync({ _id: pulseId, userId: this.userId });
    if (!current) throw new Meteor.Error('no-pulse', 'Pulse not found.');
    if (current.revision !== expectedRevision) {
      throw new Meteor.Error('stale-pulse', 'Pulse changed in another window. Reopen it and try again.');
    }
    const next = await pulseInput(this.userId, current, patch);
    const changed = await PulseConfigs.updateAsync(
      { _id: pulseId, userId: this.userId, revision: expectedRevision },
      {
        $set: next,
        ...(patch.enabled !== undefined && current.pausedByMission
          ? { $unset: { pausedByMission: '' } }
          : {}),
        $inc: { revision: 1 },
      },
    );
    if (changed !== 1) throw new Meteor.Error('stale-pulse', 'Pulse changed in another window.');
    return true;
    });
  },

  async 'constellation.pulseRemove'(pulseId, expectedRevision) {
    check(pulseId, String);
    check(expectedRevision, Number);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const removed = await PulseConfigs.removeAsync({
      _id: pulseId, userId: this.userId, revision: expectedRevision,
    });
    if (removed !== 1) throw new Meteor.Error('stale-pulse', 'Pulse changed or no longer exists.');
    return true;
    });
  },

  async 'constellation.pulseRun'(pulseId) {
    check(pulseId, String);
    await claimWorkspace(this.userId);
    const pulse = await PulseConfigs.findOneAsync({ _id: pulseId, userId: this.userId });
    if (!pulse) throw new Meteor.Error('no-pulse', 'Pulse not found.');
    return dispatchPulse(pulse, new Date(), true);
  },

  async 'constellation.skillCreate'(patch) {
    check(patch, Object);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const existing = await SkillConfigs.find({ userId: this.userId }).countAsync();
    if (existing >= 60) throw new Meteor.Error('skill-limit', 'Skill limit reached.');
    const next = await skillInput(this.userId, null, patch);
    const id = await SkillConfigs.insertAsync({
      ...next, userId: this.userId, revision: 1, createdAt: new Date(),
    });
    await ensureCrewConfigs(this.userId);
    return id;
    });
  },

  async 'constellation.skillSave'(skillId, expectedRevision, patch) {
    check(skillId, String);
    check(expectedRevision, Number);
    check(patch, Object);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const current = await SkillConfigs.findOneAsync({ _id: skillId, userId: this.userId });
    if (!current) throw new Meteor.Error('no-skill', 'Skill not found.');
    if (current.revision !== expectedRevision) {
      throw new Meteor.Error('stale-skill', 'Skill changed in another window. Reopen it and try again.');
    }
    const next = await skillInput(this.userId, current, patch);
    const changed = await SkillConfigs.updateAsync(
      { _id: skillId, userId: this.userId, revision: expectedRevision },
      { $set: next, $inc: { revision: 1 } },
    );
    if (changed !== 1) throw new Meteor.Error('stale-skill', 'Skill changed in another window.');
    await ensureCrewConfigs(this.userId);
    return true;
    });
  },

  async 'constellation.skillRemove'(skillId, expectedRevision) {
    check(skillId, String);
    check(expectedRevision, Number);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const removed = await SkillConfigs.removeAsync({
      _id: skillId, userId: this.userId, revision: expectedRevision,
    });
    if (removed !== 1) throw new Meteor.Error('stale-skill', 'Skill changed or no longer exists.');
    await ensureCrewConfigs(this.userId);
    return true;
    });
  },

  async 'constellation.channelSave'(kind, expectedRevision, patch) {
    check(kind, String);
    check(expectedRevision, Number);
    check(patch, Object);
    await claimWorkspace(this.userId);
    const schema = CHANNEL_SCHEMAS[kind];
    if (!schema) throw new Meteor.Error('invalid-channel', 'Unknown channel.');
    assertOnlyKeys(patch, ['enabled', 'fields'], 'invalid-channel');
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
      throw new Meteor.Error('invalid-channel', 'Enabled must be true or false.');
    }
    assertOnlyKeys(
      patch.fields ?? {}, schema.fields.map((field) => field.key), 'invalid-channel',
    );
    const id = `${this.userId}:${kind}`;
    const current = await ChannelConfigs.findOneAsync({ _id: id, userId: this.userId });
    if (!current) throw new Meteor.Error('no-channel', 'Channel configuration not found.');
    if (current.revision !== expectedRevision) {
      throw new Meteor.Error('stale-channel', 'Channel changed in another window. Reopen it and try again.');
    }
    const secretRow = await ChannelSecrets.findOneAsync(id);
    const secretFields = { ...(secretRow?.fields ?? {}) };
    const settings = { ...(current.settings ?? {}) };
    for (const field of schema.fields) {
      if (!(field.key in (patch.fields ?? {}))) continue;
      const raw = patch.fields[field.key];
      if (typeof raw !== 'string') throw new Meteor.Error('invalid-channel', `${field.label} must be text.`);
      const value = raw.replace(/\u0000/g, '').trim().slice(0, 2048);
      if (field.secret) {
        // Secret inputs are write-only: blank retains the currently stored value.
        if (value) secretFields[field.key] = encryptChannelSecret(this.userId, kind, field.key, value);
      } else if (value) {
        if (field.type === 'url') {
          try { new URL(value); } catch { throw new Meteor.Error('invalid-channel', `${field.label} must be a valid URL.`); }
        }
        settings[field.key] = value;
      } else {
        delete settings[field.key];
      }
    }
    if (Object.keys(secretFields).length) {
      await ChannelSecrets.upsertAsync(
        { _id: id, userId: this.userId, kind },
        { $set: { fields: secretFields, keyVersion: 1, updatedAt: new Date() } },
      );
    }
    const configuredFields = schema.fields
      .filter((field) => (field.secret ? secretFields[field.key] : settings[field.key]))
      .map((field) => field.key);
    const changed = await ChannelConfigs.updateAsync(
      { _id: id, userId: this.userId, revision: expectedRevision },
      {
        $set: {
          enabled: patch.enabled ?? current.enabled,
          settings,
          configuredFields,
          updatedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
    );
    if (changed !== 1) throw new Meteor.Error('stale-channel', 'Channel changed in another window.');
    const next = await ChannelConfigs.findOneAsync(id);
    return syncChannelRuntime(next);
  },

  async 'constellation.channelTest'(kind) {
    check(kind, String);
    await claimWorkspace(this.userId);
    if (!CHANNEL_SCHEMAS[kind]) throw new Meteor.Error('invalid-channel', 'Unknown channel.');
    const row = await ChannelConfigs.findOneAsync({
      _id: `${this.userId}:${kind}`, userId: this.userId,
    });
    if (!row) throw new Meteor.Error('no-channel', 'Channel configuration not found.');
    return testChannelConnection(row);
  },

  async 'constellation.channelClear'(kind, expectedRevision) {
    check(kind, String);
    check(expectedRevision, Number);
    await claimWorkspace(this.userId);
    const schema = CHANNEL_SCHEMAS[kind];
    if (!schema) throw new Meteor.Error('invalid-channel', 'Unknown channel.');
    const id = `${this.userId}:${kind}`;
    const current = await ChannelConfigs.findOneAsync({ _id: id, userId: this.userId });
    if (!current || current.revision !== expectedRevision) {
      throw new Meteor.Error('stale-channel', 'Channel changed or no longer exists.');
    }
    await ChannelSecrets.removeAsync({ _id: id, userId: this.userId });
    const configuredFields = schema.fields
      .filter((field) => !field.secret && current.settings?.[field.key])
      .map((field) => field.key);
    await ChannelConfigs.updateAsync(
      { _id: id, userId: this.userId, revision: expectedRevision },
      {
        $set: {
          enabled: false,
          configuredFields,
          status: 'disabled',
          lastErrorCode: null,
          updatedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
    );
    activeChannelDefs.delete(kind);
    await stopChannelWorker(kind);
    return true;
  },

  async 'constellation.mcpCreate'(patch = {}) {
    check(patch, Object);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    await ensureCrewConfigs(this.userId);
    const count = await McpConfigs.find({ userId: this.userId, managed: 'workspace' }).countAsync();
    if (count >= 20) throw new Meteor.Error('mcp-limit', 'MCP server limit reached.');
    const normalized = await normalizeMcpInput(this.userId, null, patch);
    if (Object.keys(normalized.env.updates).length && !configKeyBytes) {
      throw new Meteor.Error(
        'secret-storage-locked',
        'Secure MCP environment storage is unavailable. Restart from the desktop app.',
      );
    }
    if (normalized.config.enabled) {
      await assertMcpMutationAllowed(this.userId, normalized.config.agents);
    }
    const now = new Date();
    const id = await McpConfigs.insertAsync({
      ...normalized.config,
      userId: this.userId,
      lastTestStatus: 'never',
      catalogCount: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await writeMcpEnvironment(this.userId, id, normalized.env);
    const config = await McpConfigs.findOneAsync({ _id: id, userId: this.userId });
    await reconcileMcpConfig(config);
    await rebuildMcpToolAssignments(this.userId);
    return publicMcpConfig(this.userId, id);
    });
  },

  async 'constellation.mcpSave'(configId, expectedRevision, patch) {
    check(configId, String);
    check(expectedRevision, Number);
    check(patch, Object);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const current = await McpConfigs.findOneAsync({ _id: configId, userId: this.userId });
    if (!current) throw new Meteor.Error('no-mcp', 'MCP server not found.');
    if (current.locked || current.managed !== 'workspace') {
      throw new Meteor.Error('mcp-locked', 'App-managed MCP servers are read-only.');
    }
    if (current.revision !== expectedRevision) {
      throw new Meteor.Error('stale-mcp', 'MCP server changed in another window. Reopen it and try again.');
    }
    const normalized = await normalizeMcpInput(this.userId, current, patch);
    if (Object.keys(normalized.env.updates).length && !configKeyBytes) {
      throw new Meteor.Error(
        'secret-storage-locked',
        'Secure MCP environment storage is unavailable. Restart from the desktop app.',
      );
    }
    await assertMcpMutationAllowed(
      this.userId, [...(current.agents ?? []), ...normalized.config.agents],
    );
    const changed = await McpConfigs.updateAsync(
      { _id: configId, userId: this.userId, revision: expectedRevision },
      { $set: normalized.config, $inc: { revision: 1 } },
    );
    if (changed !== 1) throw new Meteor.Error('stale-mcp', 'MCP server changed in another window.');
    await writeMcpEnvironment(this.userId, configId, normalized.env);
    const config = await McpConfigs.findOneAsync({ _id: configId, userId: this.userId });
    await reconcileMcpConfig(config);
    await rebuildMcpToolAssignments(this.userId);
    return publicMcpConfig(this.userId, configId);
    });
  },

  async 'constellation.mcpRemove'(configId, expectedRevision) {
    check(configId, String);
    check(expectedRevision, Number);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const current = await McpConfigs.findOneAsync({ _id: configId, userId: this.userId });
    if (!current || current.revision !== expectedRevision) {
      throw new Meteor.Error('stale-mcp', 'MCP server changed or no longer exists.');
    }
    if (current.locked || current.managed !== 'workspace') {
      throw new Meteor.Error('mcp-locked', 'App-managed MCP servers are read-only.');
    }
    await assertMcpMutationAllowed(this.userId, current.agents ?? []);
    const removed = await McpConfigs.removeAsync({
      _id: configId, userId: this.userId, revision: expectedRevision,
    });
    if (removed !== 1) throw new Meteor.Error('stale-mcp', 'MCP server changed or no longer exists.');
    await unregisterMcpServer(mcpRuntimeName(configId));
    await Promise.all([
      McpSecrets.removeAsync({ _id: mcpSecretId(this.userId, configId), userId: this.userId }),
      ToolCatalog.removeAsync({ userId: this.userId, serverId: configId }),
    ]);
    await rebuildMcpToolAssignments(this.userId);
    return true;
    });
  },

  async 'constellation.mcpTest'(configId) {
    check(configId, String);
    await claimWorkspace(this.userId);
    const userId = this.userId;
    return withWorkspaceConfigMutation(userId, async () => {
    const config = await McpConfigs.findOneAsync({ _id: configId, userId: this.userId });
    if (!config) throw new Meteor.Error('no-mcp', 'MCP server not found.');
    if (!config.trusted) {
      throw new Meteor.Error('mcp-untrusted', 'Confirm that you trust this local command before testing it.');
    }
    await assertMcpMutationAllowed(this.userId, config.agents ?? []);
    await disconnectMcpServer(mcpRuntimeName(configId));
    const result = await reconcileMcpConfig(config, { testOnly: true });
    await rebuildMcpToolAssignments(this.userId);
    return {
      ...result,
      runtime: getMcpServerStatus(mcpRuntimeName(configId)),
    };
    });
  },

  async 'constellation.renameSession'(sessionId, title) {
    check(sessionId, String);
    check(title, String);
    await claimWorkspace(this.userId);
    const clean = title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 96);
    if (!clean) throw new Meteor.Error('invalid-title', 'Mission title cannot be empty.');
    const session = await AgentSessions.findOneAsync({
      _id: sessionId, agent: 'orchestrator', userId: this.userId,
    });
    if (!session) throw new Meteor.Error('no-session', 'Mission not found.');
    const changed = await AgentSessions.updateAsync(
      { _id: sessionId, agent: 'orchestrator', userId: this.userId },
      { $set: { title: clean, updatedAt: new Date() } },
    );
    if (changed !== 1) throw new Meteor.Error('no-session', 'Mission not found.');
    await ensureMissionConfig(this.userId, session);
    await MissionConfigs.updateAsync(
      { _id: sessionId, userId: this.userId },
      { $set: { title: clean, updatedAt: new Date() }, $inc: { revision: 1 } },
    );
    return clean;
  },

  async 'constellation.linkChannel'(token) {
    check(token, String);
    const localAddress = this.connection?.clientAddress;
    if (!this.userId && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(localAddress)) {
      throw new Meteor.Error('not-authorized', 'Channel linking is available only from this computer.');
    }
    const ownerUserId = this.userId
      ?? (await WorkspaceState.findOneAsync('local'))?.ownerUserId;
    if (!ownerUserId) throw new Meteor.Error('workspace-unavailable', 'Open Constellation before linking this Channel.');
    await claimWorkspace(ownerUserId);
    const identity = await redeemLinkToken(token, ownerUserId);
    if (!identity) throw new Meteor.Error('bad-token', 'That linking token is invalid or expired.');
    return { kind: identity.kind };
  },

  async 'constellation.previewChannelLink'(token) {
    check(token, String);
    return previewLinkToken(token);
  },

  async 'constellation.redeemVerdict'(token) {
    check(token, String);
    return redeemVerdictToken(token);
  },

  async 'constellation.previewVerdict'(token) {
    check(token, String);
    return previewVerdictToken(token);
  },
});

// Full-app concurrency tests need a deterministic disconnected runtime before
// invoking bootstrap. Keep that synchronization seam out of production and
// retain the same ownership check as every real MCP control.
if (Meteor.isTest || Meteor.isAppTest) {
  Meteor.methods({
    async 'constellation.testMcpDisconnect'(configId) {
      check(configId, String);
      await claimWorkspace(this.userId);
      const config = await McpConfigs.findOneAsync({
        _id: configId, userId: this.userId, managed: 'workspace',
      });
      if (!config) throw new Meteor.Error('no-mcp', 'MCP server not found.');
      await disconnectMcpServer(mcpRuntimeName(configId));
      return getMcpServerStatus(mcpRuntimeName(configId));
    },
  });
}

Meteor.startup(async () => {
  await MissionConfigs.rawCollection().createIndex({ userId: 1, updatedAt: -1 });
  await MissionConfigs.rawCollection().createIndex({ userId: 1, sessionId: 1 }, { unique: true });
  await WorkspaceMembers.rawCollection().createIndex({ userId: 1, displayName: 1 });
  await WorkspaceMembers.rawCollection().createIndex(
    { userId: 1, participantId: 1 }, { unique: true },
  );
  await WorkspaceMembers.rawCollection().createIndex(
    { userId: 1, linkedUserId: 1 },
    { unique: true, partialFilterExpression: { linkedUserId: { $type: 'string' } } },
  );
  await WorkspaceMembers.rawCollection().createIndex(
    { userId: 1, 'identity.kind': 1, 'identity.externalUserId': 1 },
    {
      unique: true,
      partialFilterExpression: { 'identity.externalUserId': { $type: 'string' } },
    },
  );
  await PulseConfigs.rawCollection().createIndex({ enabled: 1, nextRunAt: 1 });
  await PulseConfigs.rawCollection().createIndex({ userId: 1, updatedAt: -1 });
  await PulseRuns.rawCollection().createIndex({ pulseId: 1, scheduledFor: -1 });
  await PulseRuns.rawCollection().createIndex(
    { updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 },
  );
  await SkillConfigs.rawCollection().createIndex({ userId: 1, slug: 1 }, { unique: true });
  await ChannelConfigs.rawCollection().createIndex({ userId: 1, kind: 1 }, { unique: true });
  await McpConfigs.rawCollection().createIndex({ userId: 1, managed: 1, updatedAt: -1 });
  await McpConfigs.rawCollection().createIndex(
    { userId: 1, appKey: 1 },
    { unique: true, partialFilterExpression: { managed: 'app' } },
  );
  await McpSecrets.rawCollection().createIndex({ userId: 1, configId: 1 }, { unique: true });
  await ToolCatalog.rawCollection().createIndex({ userId: 1, source: 1, displayName: 1 });
  await ToolCatalog.rawCollection().createIndex({ userId: 1, serverId: 1 });
  const unsafeCatalogRows = await ToolCatalog.find({}, { fields: { inputSchema: 1 } }).fetchAsync();
  for (const row of unsafeCatalogRows) {
    if (!hasMongoUnsafeCatalogKey(row.inputSchema)) continue;
    await ToolCatalog.updateAsync(
      row._id, { $set: { inputSchema: boundedCatalogSchema(row.inputSchema) } },
    );
  }

  // Core starts one worker for every stable facade. No adapter is active until
  // the workspace owner unlocks and enables its configuration.
  for (const kind of CHANNEL_KINDS) await stopChannelWorker(kind);
  Meteor.setInterval(() => { void scanDuePulses(); }, 15_000);

  const seeds = [
    ['constellation:principle:durability', 'A durable mission—not a request handler—is the center of agent work.'],
    ['constellation:principle:approval', 'Consequential actions pause at an explicit, transcript-visible approval boundary.'],
    ['constellation:principle:continuity', 'Identity, memory, and mission state stay stable when a conversation moves across surfaces.'],
  ];
  for (const [key, text] of seeds) {
    try {
      // The shared row itself has no userId. A named server-side actor satisfies
      // the core's provenance guard while `scope: 'app'` still stores no account.
      const result = await Agent.memory.save(
        'constellation-system',
        { text, scope: 'app', key, pinned: true, by: 'app' },
      );
      if (!result.ok) throw new Error(result.reason);
    } catch (error) {
      console.warn(`[constellation] could not seed work memory ${key}:`, error?.message ?? error);
    }
  }
  const startupModelCatalog = await loadBaseModelCatalog();
  const ollamaCount = startupModelCatalog.providers
    .find((provider) => provider.id === 'ollama')?.models.length ?? 0;
  console.log(`[constellation] ready — ${live ? `live provider (${model})` : 'deterministic local provider'}${ollamaCount ? ` · Ollama (${ollamaCount})` : ''}`);
  console.log(`[constellation] credential store: ${configKeyBytes ? 'OS-protected key loaded' : 'locked (launch from Electron)'}`);
});
