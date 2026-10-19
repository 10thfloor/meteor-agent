import { Meteor } from 'meteor/meteor';
import { AgentMessages, AgentSessions } from '../common/collections';
import { ACTIVE_PHASES, type AgentSession } from '../common/types';
import { buildRunConfig, getAgent } from './registry';
import { runTurn } from './loop';
import { readTurnOutcome, MAX_SUBAGENT_DEPTH, type TurnOutcome } from './subagent';
import { beginSessionMutationOperation, withSessionOperationTransaction } from './session-operations';
import { insertInitialTranscript } from './transcript';
import { AgentWorkflowRuns, assertWorkflowRunAuthority, workflowFingerprint, type WorkflowPrimitive } from './workflows';
import type { WorkflowRun, WorkflowStepState } from '../common/workflows';

const fail = (code: string, reason: string): never => { throw new Meteor.Error(code, reason); };

function allocation(run: WorkflowRun) {
  const count = Math.max(1, run.definition.steps.filter((step) => step.primitive === 'agent').length);
  return {
    turns: Math.floor(run.definition.budget.turns / count),
    toolCalls: Math.floor(run.definition.budget.toolCalls / count),
    spend: run.definition.budget.spend / count,
  };
}

async function workflowAncestor(sessionId: string): Promise<{ session: AgentSession; run: WorkflowRun; state: WorkflowStepState } | null> {
  let session = await AgentSessions.findOneAsync(sessionId);
  for (let depth = 0; session && depth <= MAX_SUBAGENT_DEPTH; depth += 1) {
    const marker = session.parent?.toolCallId;
    if (marker?.startsWith('workflow:')) {
      if (!session.userId) fail('workflow-unavailable', 'This workflow owner is no longer available.');
      const [, runId, stepId] = marker.split(':');
      const run = await AgentWorkflowRuns.findOneAsync({ _id: runId, userId: session.userId! });
      const state = run?.states[stepId];
      if (!run || !state || state.childSessionId !== session._id) fail('workflow-unavailable', 'This workflow run is no longer available.');
      return { session, run: run!, state: state! };
    }
    if (!session.parent?.sessionId) return null;
    session = await AgentSessions.findOneAsync(session.parent.sessionId);
  }
  return null;
}

/** Host provider and tool fences call this on every resumed execution. The
 * allocations are durable, so rebuilding Crew config cannot reset a budget. */
export async function assertWorkflowSessionExecution(sessionId: string, opts: {
  toolCall?: boolean;
  /** Source-bound, tool-free post-turn reflection may outlive successful work.
   * Hosts must opt in only at their dedicated reflection Provider boundary. */
  reflection?: boolean;
} = {}): Promise<void> {
  if (opts.reflection && opts.toolCall) fail('workflow-reflection-tools', 'Reflection cannot execute tools.');
  const owned = await workflowAncestor(sessionId);
  if (!owned) return;
  const { session, run, state } = owned;
  const step = run.definition.steps.find((item) => item.id === state.id);
  if (!step) fail('workflow-unavailable', 'This workflow step is no longer available.');
  await assertWorkflowRunAuthority(run, step);
  const runStates = ['running', 'queued', 'awaiting', ...(opts.reflection ? ['completed'] : [])];
  const stepStates = ['running', 'pending', 'awaiting', ...(opts.reflection ? ['completed'] : [])];
  if (!runStates.includes(run.status) || !stepStates.includes(state.status)) {
    fail('workflow-inactive', 'This workflow run is no longer active.');
  }
  const limits = allocation(run);
  // Include nested delegation in the same allocation. These reads are a final
  // entitlement fence; the Session loop's own atomic budgets remain in force.
  const rows: AgentSession[] = [session];
  let parents = [session._id];
  for (let depth = 0; parents.length && depth < MAX_SUBAGENT_DEPTH; depth += 1) {
    const children = await AgentSessions.find({ 'parent.sessionId': { $in: parents }, userId: run.userId }).fetchAsync();
    rows.push(...children);
    parents = children.map((child) => child._id);
  }
  const spent = rows.reduce((sum, row) => ({
    turns: sum.turns + (row.budgetSpent?.turns ?? 0),
    toolCalls: sum.toolCalls + (row.budgetSpent?.toolCalls ?? 0),
    spend: sum.spend + (row.usage?.cost ?? 0),
  }), { turns: 0, toolCalls: 0, spend: 0 });
  if (spent.spend >= limits.spend || (!opts.toolCall && spent.turns > limits.turns)
    || (opts.toolCall && spent.toolCalls >= limits.toolCalls)) {
    fail('workflow-budget', 'This workflow step reached its budget.');
  }
}

async function stopChild(sessionId: string, userId: string): Promise<void> {
  let ids = [sessionId];
  for (let depth = 0; ids.length && depth <= MAX_SUBAGENT_DEPTH; depth += 1) {
    await AgentSessions.updateAsync({ _id: { $in: ids }, userId,
      phase: { $in: [...ACTIVE_PHASES, 'awaiting', 'idle'] } },
    { $set: { phase: 'stopped', updatedAt: new Date() } }, { multi: true });
    const children = await AgentSessions.find({ 'parent.sessionId': { $in: ids }, userId }, { fields: { _id: 1 } }).fetchAsync();
    ids = children.map((child) => child._id);
  }
}

async function childHadNoToolCalls(state: WorkflowStepState, run: WorkflowRun): Promise<boolean> {
  if (!state.childSessionId) return state.attempts === 0;
  const session = await AgentSessions.findOneAsync({ _id: state.childSessionId, userId: run.userId });
  if (!session || session.lease || ACTIVE_PHASES.includes(session.phase) || session.phase === 'awaiting') return false;
  const messages = await AgentMessages.find({ sessionId: session._id }, { fields: { role: 1, toolCalls: 1 } }).fetchAsync();
  return !messages.some((message) => message.role === 'tool' || message.toolCalls?.length);
}

const checkpointState = (session: AgentSession) => JSON.stringify([
  session.phase, session.nextSeq, session.updatedAt,
  session.pending, session.lease, session.pendingInput, session.pendingInputs,
  session.pendingRelay, session.pendingSystem,
]);

/** The outcome reader spans Session and Transcript reads. Activation can start
 * or finish an approved Turn between them, so accept terminal output only
 * from an unchanged, quiescent checkpoint. A changed snapshot is reconciled
 * on the next poll; it is never treated as failure or an earlier answer. */
export async function readWorkflowAgentOutcome(sessionId: string): Promise<TurnOutcome | { ok: false; kind: 'processing' }> {
  const before = await AgentSessions.findOneAsync(sessionId);
  if (!before) return { ok: false, kind: 'gone' };
  const processing = (session: AgentSession) => ACTIVE_PHASES.includes(session.phase)
    || !!session.pending?.verdict || !!(session.lease && session.lease.until > new Date());
  if (processing(before)) return { ok: false, kind: 'processing' };
  const outcome = await readTurnOutcome(sessionId);
  const after = await AgentSessions.findOneAsync(sessionId);
  if (!after) return { ok: false, kind: 'gone' };
  if (processing(after) || checkpointState(before) !== checkpointState(after)) return { ok: false, kind: 'processing' };
  return outcome;
}

/** Reuses the existing Session/Turn/Tool/approval runtime. Deterministic child
 * birth plus the persisted receipt lets retries adopt, never duplicate, work. */
export function workflowAgentPrimitive(): WorkflowPrimitive {
  return {
    name: 'agent', version: 1, label: 'Ask an agent', replay: 'idempotent',
    canReplay: childHadNoToolCalls,
    async canRetry(state, run) {
      if (!state.childSessionId) return true;
      const child = await AgentSessions.findOneAsync({ _id: state.childSessionId, userId: run.userId });
      if (child && (ACTIVE_PHASES.includes(child.phase) || child.phase === 'awaiting')) return true;
      return childHadNoToolCalls(state, run);
    },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        agent: { type: 'string', minLength: 1, maxLength: 80 },
        prompt: { type: 'string', minLength: 1, maxLength: 12_000 },
        revision: { type: 'integer', minimum: 1 },
        context: { type: 'string', enum: ['dependencies', 'none'] },
      }, required: ['agent', 'prompt', 'revision'],
    },
    async execute(input, context) {
      const name = String(input.agent);
      const config = getAgent(name);
      if (!config) return fail('workflow-agent-unavailable', 'This agent is unavailable.');
      const id = `wfs-${workflowFingerprint(context.idempotencyKey).slice(0, 40)}`;
      const receipt = { childSessionId: id, fingerprint: context.state.fingerprint, agent: name };
      await context.checkpoint(receipt, { childSessionId: id });
      let child = await AgentSessions.findOneAsync(id);
      if (child && (child.userId !== context.userId || child.agent !== name
        || child.parent?.sessionId !== context.missionId
        || child.parent?.toolCallId !== `workflow:${context.run._id}:${context.step.id}`)) {
        return fail('workflow-receipt-mismatch', 'The step receipt does not match its saved agent session.');
      }
      const limits = allocation(context.run);
      if (limits.turns < 1) return fail('workflow-budget', 'Allow at least one turn for each agent step.');
      if (!child) {
        const operation = await beginSessionMutationOperation(context.missionId);
        if (!operation) return fail('workflow-mission-unavailable', 'The mission is no longer available.');
        try {
          await context.assertActive();
          const parent = await AgentSessions.findOneAsync({ _id: context.missionId, userId: context.userId, erasingAt: { $exists: false } });
          if (!parent) return fail('workflow-mission-unavailable', 'The mission is no longer available.');
          const now = new Date();
          const dependencies = input.context === 'none' ? '' : Object.entries(context.outputs)
            .map(([key, value]) => `### ${context.run.states[key].label}\n${typeof value === 'string' ? value : JSON.stringify(value)}`)
            .join('\n\n').slice(0, 48_000);
          const prompt = `${String(input.prompt)}${dependencies ? `\n\nPrevious step results:\n${dependencies}` : ''}`;
          child = {
            _id: id, userId: context.userId, agent: name, phase: 'idle', model: config.model,
            title: context.step.label, nextSeq: 0,
            usage: { input: 0, output: 0, cost: 0 }, budgetSpent: { turns: 0, toolCalls: 0 },
            parent: { sessionId: parent._id, toolCallId: `workflow:${context.run._id}:${context.step.id}` },
            depth: (parent.depth ?? 0) + 1,
            ...(parent.participants?.length ? { participants: [
              ...parent.participants.filter((participant) => participant.kind === 'human'),
              { id: `m:${name}`, kind: 'model' as const, role: 'member' as const,
                agent: name, displayName: name, joinedAt: now },
            ] } : {}),
            createdAt: now, updatedAt: now,
          };
          if (child.depth! > MAX_SUBAGENT_DEPTH) return fail('workflow-depth', 'This mission has reached its delegation limit.');
          const initial = child;
          try {
            await withSessionOperationTransaction(operation, (mongoSession) => insertInitialTranscript(mongoSession, initial, {
              _id: `${id}-input`, role: 'user', content: prompt, createdAt: now,
            }));
          } catch (error) {
            const existing = await AgentSessions.findOneAsync(id);
            if (!existing || existing.parent?.toolCallId !== initial.parent?.toolCallId
              || !await AgentMessages.findOneAsync({ _id: `${id}-input`, content: prompt })) throw error;
            child = existing;
          }
        } finally { await operation.close(); }
      }
      await context.assertActive();
      if (child.pending || child.phase === 'awaiting' || ACTIVE_PHASES.includes(child.phase)
        || (child.lease && child.lease.until > new Date())) {
        const needsApproval = child.phase === 'awaiting' && !child.pending?.verdict;
        return { waiting: true, waitReason: needsApproval ? 'approval' : 'processing', summary: needsApproval
          ? 'Review the agent’s tool request.' : 'Agent is working.', receipt, childSessionId: id };
      }
      let retryProvider = false;
      if (child.phase === 'stopped' || child.phase === 'error') {
        if (!await childHadNoToolCalls({ ...context.state, childSessionId: id }, context.run)) {
          return fail('workflow-agent-stopped', 'The agent stopped after requesting tools. Review its conversation before creating a new run.');
        }
        await context.assertActive();
        const reset = await AgentSessions.updateAsync({ _id: id, userId: context.userId, phase: child.phase, lease: { $exists: false } },
          { $set: { phase: 'idle', updatedAt: new Date() } });
        if (!reset) return fail('workflow-agent-busy', 'The agent is still finishing its checkpoint.');
        retryProvider = true;
      }
      const reply = await AgentMessages.findOneAsync({ sessionId: id, role: 'assistant' }, { sort: { seq: -1 } });
      if (!reply || retryProvider) {
        const onAbort = () => { void stopChild(id, context.userId); };
        context.signal.addEventListener('abort', onAbort, { once: true });
        try {
          const runConfig = buildRunConfig(config, context.userId);
          const canUse = runConfig.canUse;
          const provider = runConfig.provider;
          await runTurn(id, {
            ...runConfig,
            budget: {
              ...runConfig.budget,
              turns: Math.min(limits.turns, runConfig.budget?.turns ?? Infinity),
              toolCalls: Math.min(limits.toolCalls, runConfig.budget?.toolCalls ?? Infinity),
              spend: Math.min(limits.spend, runConfig.budget?.spend ?? Infinity),
            },
            canUse: async (tool, toolContext) => {
              await context.assertActive();
              await assertWorkflowSessionExecution(toolContext.sessionId, { toolCall: true });
              return canUse ? canUse(tool, toolContext) : true;
            },
            provider: {
              ...provider,
              async *stream(request) {
                await context.assertActive();
                await assertWorkflowSessionExecution(id);
                yield* provider.stream(request);
              },
            },
          });
        } finally { context.signal.removeEventListener('abort', onAbort); }
      }
      const outcome = await readWorkflowAgentOutcome(id);
      if (!outcome.ok && outcome.kind === 'processing') {
        return { waiting: true, waitReason: 'processing', summary: 'Agent is working.', receipt, childSessionId: id };
      }
      if (!outcome.ok) {
        if (outcome.kind === 'parked') return { waiting: true, waitReason: 'approval', summary: 'Review the agent’s tool request.', receipt, childSessionId: id };
        return fail('workflow-agent-failed', 'The agent did not complete this step. Open its conversation for details.');
      }
      return { output: outcome.text.slice(0, 64_000), summary: outcome.text.slice(0, 1500), receipt, childSessionId: id };
    },
    async cancel(state, run) {
      if (state.childSessionId) await stopChild(state.childSessionId, run.userId);
    },
  };
}

export function workflowApprovalPrimitive(): WorkflowPrimitive {
  return {
    name: 'approval', version: 1, label: 'Review results', replay: 'safe', requireApproval: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 12_000 },
    }, required: ['prompt'] },
    async execute(input, context) {
      await context.assertActive();
      return { output: { approved: true, results: context.outputs }, summary: String(input.prompt) };
    },
  };
}
