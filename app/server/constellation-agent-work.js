import { Meteor } from 'meteor/meteor';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { AgentSessions, AgentMessages, AgentWorkflowRuns } from 'meteor/10thfloor:agent';
import { missionConversationIds } from './mission-topics';
import { isMissionRoot } from '../imports/constellation/topics';

const STATUSES = new Set(['working', 'waiting', 'completed', 'failed', 'stopped']);
const ACTIVE = new Set(['streaming', 'calling', 'compacting', 'retrying']);
const LABELS = { working: 'Working', waiting: 'Needs approval', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };
const SESSION_FIELDS = { _id: 1, userId: 1, agent: 1, phase: 1, title: 1, parent: 1,
  participants: 1, createdAt: 1, updatedAt: 1, activeChild: 1, missionTopic: 1, thread: 1 };
const fail = (code, reason) => { throw new Meteor.Error(code, reason); };
const request = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-agent-work', 'Choose a mission and agent assignment.');
  return input;
};
const id = (value, label) => {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\u0000-\u001f]/.test(value)) {
    fail('invalid-agent-work', `Choose a valid ${label}.`);
  }
  return value;
};

/** These summaries are display data, never a second transcript or reasoning feed. */
export function agentWorkProse(value, max = 12_000) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  // Tool receipts contain JSON-encoded strings. Decode strings only, never
  // stringify arbitrary tool objects into the user-facing work panel.
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'string') return null;
    text = parsed;
  } catch { /* Ordinary prose is already displayable. */ }
  text = text.replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/```(?:json|jsonc)\s*[\s\S]*?```/gi, '[Structured data omitted.]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  // A decoded string can itself be a JSON object or a truncated JSON payload.
  if (!text || /^[\[{]/.test(text) && (/^\{\s*"/.test(text) || /^\[\s*(?:\{|\[|")/.test(text))) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function nameFor(agent, session, crew) {
  const saved = crew.get(agent)?.displayName;
  const participant = session?.participants?.find((person) => person.kind === 'model' && person.agent === agent)?.displayName;
  const historic = participant && participant !== agent ? participant : null;
  return agentWorkProse(saved || historic || ({ orchestrator: 'Atlas', researcher: 'Signal', operator: 'Relay', critic: 'Vela' })[agent] || agent, 100) || 'Agent';
}

function readCursor(value, filter) {
  if (value === undefined || value === null || value === '') return { horizon: new Date(), before: null };
  if (typeof value !== 'string' || value.length > 2000) fail('invalid-agent-work', 'Refresh the agent work list.');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail('invalid-agent-work', 'Refresh the agent work list.'); }
  const horizon = new Date(parsed?.horizon);
  const before = new Date(parsed?.before?.at);
  if (parsed?.v !== 1 || parsed.missionId !== filter.missionId || parsed.agent !== filter.agent || parsed.status !== filter.status
    || !Number.isFinite(horizon.getTime()) || horizon.getTime() > Date.now() + 5000
    || !Number.isFinite(before.getTime()) || before > horizon || typeof parsed.before?.id !== 'string'
    || !parsed.before.id || parsed.before.id.length > 160) fail('invalid-agent-work', 'Refresh the agent work list.');
  return { horizon, before: { at: before, id: parsed.before.id } };
}

function writeCursor(filter, horizon, last) {
  return Buffer.from(JSON.stringify({ v: 1, ...filter, horizon, before: { at: last.createdAt, id: last._id } })).toString('base64url');
}

/** Read-only, mission-scoped access to durable delegation records. */
export function createConstellationAgentWorkService({ requireUser, CrewConfigs,
  Sessions = AgentSessions, Messages = AgentMessages, WorkflowRuns = AgentWorkflowRuns }) {
  const mission = async (userId, missionId) => {
    if (!userId) fail('not-authorized', 'Sign in to view agent work.');
    await requireUser(userId);
    id(missionId, 'mission');
    const root = await Sessions.findOneAsync({ _id: missionId, userId, agent: 'orchestrator',
      'parent.sessionId': { $exists: false }, erasingAt: { $exists: false }, purgingAt: { $exists: false } }, { fields: SESSION_FIELDS });
    if (!root) fail('no-session', 'Mission not found.');
    if (!isMissionRoot(root)) fail('no-session', 'Mission not found.');
    // Work is delegated from #general, from any topic and from any thread.
    return { ...root, conversationIds: await missionConversationIds(Sessions, userId, root._id) };
  };

  // Traversal is based on saved parent edges, not recent chat messages or the
  // current roster. Owner checks at EVERY edge exclude mixed-owner ancestry.
  // Mongo detects cycles; cursor pages are stable even when new work arrives.
  const workPipeline = (root) => [
    { $match: { _id: { $in: root.conversationIds ?? [root._id] }, userId: root.userId, erasingAt: { $exists: false }, purgingAt: { $exists: false } } },
    { $graphLookup: { from: Sessions.rawCollection().collectionName, startWith: '$_id', connectFromField: '_id', connectToField: 'parent.sessionId',
      as: 'work', restrictSearchWithMatch: { userId: root.userId, erasingAt: { $exists: false }, purgingAt: { $exists: false } } } },
    { $unwind: '$work' }, { $replaceRoot: { newRoot: '$work' } },
  ];
  const descendants = async (root, { agent, before, horizon, limit }) => {
    const collection = Sessions.rawCollection();
    const selector = { createdAt: { $lte: horizon }, ...(agent ? { agent } : {}),
      ...(before ? { $or: [{ createdAt: { $lt: before.at } }, { createdAt: before.at, _id: { $lt: before.id } }] } : {}) };
    return collection.aggregate([
      ...workPipeline(root), { $match: selector },
      { $sort: { createdAt: -1, _id: -1 } }, { $limit: limit }, { $project: SESSION_FIELDS },
    ], { maxTimeMS: 10_000 }).toArray();
  };

  const crewFor = async (userId) => new Map((await CrewConfigs.find({ userId },
    { fields: { agent: 1, displayName: 1 } }).fetchAsync()).map((row) => [row.agent, row]));

  async function decorate(root, sessions, crew, detailed = false) {
    if (!sessions.length) return [];
    const sessionIds = sessions.map((session) => session._id);
    const parentIds = [...new Set(sessions.map((session) => session.parent.sessionId))];
    const [parents, assignments, replies, receipts, workflows] = await Promise.all([
      Sessions.find({ _id: { $in: parentIds }, userId: root.userId, erasingAt: { $exists: false }, purgingAt: { $exists: false } }, { fields: SESSION_FIELDS }).fetchAsync(),
      Messages.rawCollection().aggregate([{ $match: { sessionId: { $in: sessionIds }, role: 'user' } },
        { $sort: { seq: 1 } }, { $group: { _id: '$sessionId', row: { $first: { content: '$content', createdAt: '$createdAt' } } } }]).toArray(),
      Messages.rawCollection().aggregate([{ $match: { sessionId: { $in: sessionIds }, role: 'assistant' } },
        { $sort: { seq: -1 } }, { $group: { _id: '$sessionId', row: { $first: { content: '$content', streaming: '$streaming', createdAt: '$createdAt' } } } }]).toArray(),
      Messages.find({ sessionId: { $in: parentIds }, role: 'tool', childSessionId: { $in: sessionIds } },
        { fields: { sessionId: 1, childSessionId: 1, toolCallId: 1, content: 1, error: 1, displayContent: 1, transcriptContent: 1, createdAt: 1, seq: 1 }, sort: { seq: -1 } }).fetchAsync(),
      WorkflowRuns.find({ userId: root.userId, missionId: root._id, namespace: 'constellation' },
        { fields: { name: 1, states: 1, status: 1 } }).fetchAsync(),
    ]);
    const parentMap = new Map(parents.map((row) => [row._id, row]));
    const assignmentMap = new Map(assignments.map((row) => [row._id, row.row]));
    const replyMap = new Map(replies.map((row) => [row._id, row.row]));
    const receiptMap = new Map();
    for (const receipt of receipts) if (!receiptMap.has(receipt.childSessionId)) receiptMap.set(receipt.childSessionId, receipt);
    const workflowMap = new Map();
    for (const run of workflows) for (const [stepId, state] of Object.entries(run.states || {})) {
      if (state.childSessionId && sessions.some((session) => session._id === state.childSessionId
        && session.parent.toolCallId === `workflow:${run._id}:${stepId}`)) workflowMap.set(state.childSessionId, { run, state });
    }
    return sessions.filter((session) => parentMap.has(session.parent.sessionId)).map((session) => {
      const parent = parentMap.get(session.parent.sessionId);
      const workflow = workflowMap.get(session._id);
      const isPlan = !!workflow || session.parent.toolCallId?.startsWith('workflow:');
      const planName = agentWorkProse(workflow?.run.name, 100) || 'Plan';
      const requester = isPlan ? { agent: null, displayName: planName } : { agent: parent.agent, displayName: nameFor(parent.agent, parent, crew) };
      const candidateReceipt = receiptMap.get(session._id);
      const receipt = candidateReceipt && (!session.parent.toolCallId || candidateReceipt.toolCallId === session.parent.toolCallId) ? candidateReceipt : null;
      const reply = replyMap.get(session._id);
      const assignment = agentWorkProse(assignmentMap.get(session._id)?.content) || 'Assignment unavailable.';
      let result = { state: 'pending', text: null };
      let completedAt;
      if (isPlan) {
        if (workflow?.state.status === 'completed') {
          result = { state: 'returned', text: agentWorkProse(workflow.state.output) || agentWorkProse(workflow.state.summary) || 'Result recorded.' };
          completedAt = workflow.state.completedAt;
        } else if (workflow?.state.status === 'failed') result = { state: 'failed', text: 'No completed result was returned to the plan.' };
        else if (workflow?.state.status === 'awaiting' && workflow.state.waitReason === 'approval') result = { state: 'awaiting', text: 'The plan is waiting for approval.' };
        else if (!workflow) result = { state: 'unavailable', text: 'The saved plan result is unavailable.' };
      } else if (receipt?.sessionId === parent._id) {
        if (receipt.error?.error === 'subagent-parked') result = { state: 'awaiting', text: `${requester.displayName} received an approval-waiting notice, not a completed result.` };
        else if (receipt.error) result = { state: 'failed', text: `No completed result was returned to ${requester.displayName}.` };
        else {
          result = { state: 'returned', text: agentWorkProse(receipt.content) || agentWorkProse(receipt.transcriptContent) || agentWorkProse(receipt.displayContent) || 'Result recorded.' };
          completedAt = receipt.createdAt;
        }
      }
      let status = session.phase === 'awaiting' ? 'waiting' : session.phase === 'error' ? 'failed'
        : session.phase === 'stopped' ? 'stopped' : ACTIVE.has(session.phase) || session.activeChild ? 'working'
          : result.state === 'returned' || reply?.content && !reply.streaming ? 'completed'
            : result.state === 'failed' ? 'failed' : 'working';
      if (workflow?.state.status === 'failed' && !ACTIVE.has(session.phase)) status = 'failed';
      if (status === 'completed') completedAt ??= reply?.createdAt || session.updatedAt;
      const displayName = nameFor(session.agent, session, crew);
      return { sessionId: session._id, agent: session.agent, displayName, status, statusLabel: LABELS[status],
        label: agentWorkProse(workflow?.state.label || session.title, 140) || `${displayName}’s work`,
        createdAt: session.createdAt, ...(completedAt ? { completedAt } : {}), requester,
        assignmentPreview: assignment.replace(/\s+/g, ' ').slice(0, 240), resultReturned: result.state === 'returned',
        source: isPlan ? 'plan' : 'delegation', ...(isPlan ? { planName } : {}),
        result: detailed ? result : { state: result.state, text: null },
        ...(detailed ? { assignment, parentSessionId: parent._id, phase: session.phase } : {}),
      };
    });
  }

  return {
    async list(userId, input = {}) {
      request(input);
      const root = await mission(userId, input.missionId);
      const agent = input.agent === undefined || input.agent === '' ? '' : id(input.agent, 'agent');
      const status = input.status === undefined || input.status === '' ? '' : input.status;
      if (status && !STATUSES.has(status)) fail('invalid-agent-work', 'Choose a valid work status.');
      const limit = input.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('invalid-agent-work', 'Load 1–50 agent assignments at a time.');
      const filter = { missionId: root._id, agent, status };
      const { horizon, before: initialBefore } = readCursor(input.cursor, filter);
      const crew = await crewFor(userId);
      const items = [];
      let before = initialBefore;
      let last = null;
      let hasMore = false;
      // A filtered page can scan at most 500 records; an opaque continuation
      // keeps older work reachable without an unbounded request.
      for (let batch = 0; batch < 5 && items.length < limit; batch += 1) {
        const sessions = await descendants(root, { agent, before, horizon, limit: 101 });
        if (!sessions.length) { hasMore = false; break; }
        const page = sessions.slice(0, 100);
        const rows = await decorate(root, page, crew);
        const byId = new Map(rows.map((row) => [row.sessionId, row]));
        for (let index = 0; index < page.length; index += 1) {
          const session = page[index];
          last = session;
          const row = byId.get(session._id);
          if (row && (!status || row.status === status)) items.push(row);
          hasMore = index < page.length - 1 || sessions.length > page.length;
          if (items.length === limit) break;
        }
        if (!hasMore || items.length === limit) break;
        before = { at: last.createdAt, id: last._id };
      }
      const agents = new Map([...crew.keys()].map((key) => [key, { agent: key, displayName: nameFor(key, null, crew) }]));
      const historicalAgents = await Sessions.rawCollection().aggregate([...workPipeline(root),
        { $group: { _id: '$agent', participants: { $first: '$participants' } } },
      ], { maxTimeMS: 10_000 }).toArray();
      for (const row of historicalAgents) agents.set(row._id, { agent: row._id, displayName: nameFor(row._id, row, crew) });
      await mission(userId, root._id); // Revocation or deletion during the reads fails closed.
      return { items, nextCursor: hasMore && last ? writeCursor(filter, horizon, last) : null,
        agents: [...agents.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)), refreshedAt: new Date() };
    },
    async detail(userId, input = {}) {
      request(input);
      const root = await mission(userId, input.missionId);
      id(input.sessionId, 'agent assignment');
      const child = await Sessions.findOneAsync({ _id: input.sessionId, userId, erasingAt: { $exists: false }, purgingAt: { $exists: false } }, { fields: SESSION_FIELDS });
      if (!child?.parent?.sessionId) fail('no-session', 'Agent work not found.');
      let current = child;
      const visited = new Set([child._id]);
      const conversations = new Set(root.conversationIds);
      while (current.parent?.sessionId && !conversations.has(current.parent.sessionId)) {
        if (visited.has(current.parent.sessionId) || visited.size > 100) fail('no-session', 'Agent work not found.');
        current = await Sessions.findOneAsync({ _id: current.parent.sessionId, userId, erasingAt: { $exists: false }, purgingAt: { $exists: false } }, { fields: SESSION_FIELDS });
        if (!current) fail('no-session', 'Agent work not found.');
        visited.add(current._id);
      }
      if (!conversations.has(current.parent?.sessionId)) fail('no-session', 'Agent work not found.');
      const rows = await decorate(root, [child], await crewFor(userId), true);
      await mission(userId, root._id);
      if (!rows[0] || !await Sessions.findOneAsync({ _id: child._id, userId, erasingAt: { $exists: false }, purgingAt: { $exists: false } }, { fields: { _id: 1 } })) fail('no-session', 'Agent work not found.');
      return rows[0];
    },
  };
}

export function installConstellationAgentWork(host) {
  const service = createConstellationAgentWorkService(host);
  Meteor.methods({
    'constellation.agentWork.list'(input) { return service.list(this.userId, input); },
    'constellation.agentWork.detail'(input) { return service.detail(this.userId, input); },
  });
  DDPRateLimiter.addRule({ type: 'method', name: (name) => name.startsWith('constellation.agentWork.'), userId: (value) => !!value }, 120, 60_000);
  Meteor.startup(async () => {
    await AgentSessions.rawCollection().createIndex({ userId: 1, 'parent.sessionId': 1, createdAt: -1 });
    await AgentMessages.rawCollection().createIndex({ childSessionId: 1, sessionId: 1, role: 1 });
  });
  return service;
}
