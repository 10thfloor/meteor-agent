import { createHash } from 'node:crypto';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { validateToolArgs } from './tools';
import type {
  WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepResult,
  WorkflowStepState, WorkflowReplay, WorkflowBranchField, WorkflowCondition,
} from '../common/workflows';

export * from '../common/workflows';
export const AgentWorkflowRuns = new Mongo.Collection<WorkflowRun>(
  'agent_workflow_runs', { _preventAutopublish: true } as any,
);

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const LEASE_MS = 30_000;
const MAX_BYTES = 256 * 1024;
/** Mongo's generated path type cannot express a runtime step ID. Keep that
 * single dynamic-path adapter here, after IDs have passed validation. */
async function updateRun(selector: Record<string, unknown>, modifier: Record<string, unknown>): Promise<{ matchedCount: number; modifiedCount: number }> {
  return AgentWorkflowRuns.rawCollection().updateOne(selector as any, modifier as any);
}
const failure = (code: string, message: string): never => {
  throw new Meteor.Error(code, message);
};

/** Canonical, bounded JSON also prevents Mongo path/operator injection. */
export function workflowCanonical(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 20) return failure('invalid-workflow', 'Workflow data is nested too deeply.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) {
      return failure('invalid-workflow', 'Workflow data must contain plain JSON values.');
    }
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map((part) => visit(part, depth + 1));
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        return failure('invalid-workflow', 'Workflow data must contain plain objects.');
      }
      const record: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        if (key.startsWith('$') || key.includes('.') || FORBIDDEN.has(key)) {
          return failure('invalid-workflow', 'Workflow data contains an unsupported field name.');
        }
        record[key] = visit((item as Record<string, unknown>)[key], depth + 1);
      }
      result = record;
    }
    seen.delete(item);
    return result;
  };
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json) > MAX_BYTES) return failure('invalid-workflow', 'Workflow data is too large.');
  return json;
}

export const workflowFingerprint = (value: unknown): string =>
  createHash('sha256').update(workflowCanonical(value)).digest('hex');

export interface WorkflowContext {
  run: WorkflowRun;
  step: WorkflowStep;
  state: WorkflowStepState;
  userId: string;
  missionId: string;
  signal: AbortSignal;
  idempotencyKey: string;
  outputs: Record<string, unknown>;
  /** Re-read lease, cancellation and host authorization before external work. */
  assertActive(): Promise<void>;
  /** Save a reconciliation receipt before a side effect can become ambiguous. */
  checkpoint(receipt: Record<string, unknown>, extra?: { childSessionId?: string }): Promise<void>;
}

export interface WorkflowPrimitive {
  name: string;
  version: number;
  label: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  replay: WorkflowReplay;
  /** Approval policy is developer-owned; a JSON graph can only tighten it. */
  requireApproval?: boolean;
  /** Developer-owned contract for branching on output.answers. */
  branchSchema?(input: Record<string, unknown>): Record<string, WorkflowBranchField>;
  execute(input: Record<string, unknown>, context: WorkflowContext): Promise<WorkflowStepResult>;
  /** Guarded replay must inspect actual receipts, not a model's assertion. */
  canReplay?(state: WorkflowStepState, run: WorkflowRun): Promise<boolean>;
  /** Optional reconciliation guard for idempotent primitives with terminal
   * external receipts that must not be repeated. */
  canRetry?(state: WorkflowStepState, run: WorkflowRun): Promise<boolean>;
  cancel?(state: WorkflowStepState, run: WorkflowRun): Promise<void>;
}

const settled = (status: string) => status === 'completed' || status === 'skipped';

/** Fail closed on missing or malformed answers, including on fallback branches. */
export function workflowConditionMatches(condition: Exclude<WorkflowCondition, { otherwise: true }>, output: unknown): boolean {
  const answer = (output as any)?.answers?.[condition.questionId];
  if (!answer || answer.type !== condition.type) failure('workflow-branch-result', 'The decision returned no valid answer for this branch.');
  const actual = answer[condition.type];
  if (condition.type === 'choice' ? typeof actual !== 'string' : typeof actual !== 'number' || !Number.isFinite(actual)) {
    failure('workflow-branch-result', 'The decision returned an invalid branch value.');
  }
  if (condition.minConfidence !== undefined) {
    if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
      || answer.confidence < 0 || answer.confidence > 1) failure('workflow-branch-result', 'The decision returned invalid confidence.');
    if (answer.confidence < condition.minConfidence) return false;
  }
  switch (condition.operator) {
    case 'eq': return actual === condition.value;
    case 'neq': return actual !== condition.value;
    case 'gte': return actual >= condition.value;
    case 'gt': return actual > condition.value;
    case 'lte': return actual <= condition.value;
    case 'lt': return actual < condition.value;
    default: return failure('workflow-branch-invalid', 'This branch condition is not supported.');
  }
}

export interface WorkflowEngineOptions {
  namespace: string;
  /** Required and checked at start, resume and each execution boundary. */
  authorize(userId: string, missionId: string, step?: WorkflowStep): Promise<boolean>;
}

const workflowAuthorities = new Map<string, WorkflowEngineOptions['authorize']>();

/** Recovery and approval resumes enter the existing Agent runtime, so its
 * host fence resolves the same live workflow authority as the graph worker. */
export async function assertWorkflowRunAuthority(run: WorkflowRun, step?: WorkflowStep): Promise<void> {
  const authorize = workflowAuthorities.get(run.namespace);
  if (!authorize || !(await authorize(run.userId, run.missionId, step))) {
    failure('workflow-not-authorized', 'This mission, agent, or saved agent version is no longer available.');
  }
  if (step?.when) {
    const decision = run.definition.steps.find((item) => item.id === step.when!.stepId);
    if (!decision || !await authorize!(run.userId, run.missionId, decision)) {
      failure('workflow-not-authorized', 'This branch’s decision is no longer available. Save the plan again before running it.');
    }
  }
}

/** Each host owns its registry. Changing implementation requires a new
 * primitive version; persisted graphs continue to resolve their exact version. */
export class WorkflowEngine {
  private primitives = new Map<string, WorkflowPrimitive>();
  private active = new Map<string, AbortController>();
  private polling = false;

  constructor(private readonly options: WorkflowEngineOptions) {
    if (!ID.test(options.namespace)) failure('invalid-workflow', 'A workflow namespace is required.');
    workflowAuthorities.set(options.namespace, options.authorize);
  }

  register(primitive: WorkflowPrimitive): this {
    if (!ID.test(primitive.name) || !Number.isSafeInteger(primitive.version) || primitive.version < 1
      || !['safe', 'idempotent', 'guarded', 'never'].includes(primitive.replay)
      || (primitive.replay === 'guarded' && !primitive.canReplay)) {
      return failure('invalid-workflow', 'Invalid workflow primitive registration.');
    }
    const key = `${primitive.name}@${primitive.version}`;
    if (this.primitives.has(key)) failure('workflow-version-exists', 'This primitive version is already registered.');
    workflowCanonical(primitive.inputSchema);
    this.primitives.set(key, Object.freeze({ ...primitive }));
    return this;
  }

  catalog(): Array<Omit<WorkflowPrimitive, 'execute' | 'canReplay' | 'canRetry' | 'cancel' | 'branchSchema'>> {
    return [...this.primitives.values()].map(({ execute, canReplay, canRetry, cancel, branchSchema, ...publicFields }) => publicFields);
  }

  private primitive(step: WorkflowStep): WorkflowPrimitive {
    return this.primitives.get(`${step.primitive}@${step.version}`)
      ?? failure('workflow-primitive-unavailable', `The ${step.label} action version is unavailable.`);
  }

  private async policyHints(primitive: WorkflowPrimitive, state: WorkflowStepState, run: WorkflowRun) {
    let replayAllowed = primitive.replay === 'safe';
    let retryAllowed = ['safe', 'idempotent'].includes(primitive.replay);
    try { if (primitive.canReplay) replayAllowed = await primitive.canReplay(state, run); } catch { replayAllowed = false; }
    try {
      if (primitive.canRetry) retryAllowed = await primitive.canRetry(state, run);
      else if (primitive.replay === 'guarded') retryAllowed = replayAllowed;
    } catch { retryAllowed = false; }
    return { replayAllowed, retryAllowed };
  }

  async validate(value: WorkflowDefinition): Promise<WorkflowDefinition> {
    const definition = JSON.parse(workflowCanonical(value)) as WorkflowDefinition;
    if (!ID.test(definition.id) || !Number.isSafeInteger(definition.revision) || definition.revision < 1
      || typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > 120
      || !['workflow', 'supervisor', 'handoff', 'council'].includes(definition.strategy)
      || !Array.isArray(definition.steps) || definition.steps.length < 1 || definition.steps.length > 32) {
      return failure('invalid-workflow', 'Name, version, strategy and 1–32 steps are required.');
    }
    const budget = definition.budget;
    if (!budget || !Number.isSafeInteger(budget.steps) || budget.steps < definition.steps.length || budget.steps > 128
      || !Number.isSafeInteger(budget.timeoutMs) || budget.timeoutMs < 1000 || budget.timeoutMs > 3_600_000
      || !Number.isSafeInteger(budget.turns) || budget.turns < 1 || budget.turns > 1000
      || !Number.isSafeInteger(budget.toolCalls) || budget.toolCalls < 0 || budget.toolCalls > 1000
      || !Number.isFinite(budget.spend) || budget.spend < 0 || budget.spend > 10_000) {
      return failure('invalid-workflow', 'Set valid step, time, turn, tool-call and spend limits.');
    }
    const ids = new Set<string>();
    for (const step of definition.steps) {
      if (!ID.test(step.id) || FORBIDDEN.has(step.id) || ids.has(step.id)
        || typeof step.label !== 'string' || !step.label.trim() || step.label.length > 120
        || !Array.isArray(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length
        || !step.input || Array.isArray(step.input) || typeof step.input !== 'object'
        || (step.requireApproval !== undefined && typeof step.requireApproval !== 'boolean')
        || (step.dependencyMode !== undefined && !['all', 'any'].includes(step.dependencyMode))) {
        return failure('invalid-workflow', 'Each step needs a unique ID, label, input and dependencies.');
      }
      ids.add(step.id);
      const primitive = this.primitive(step);
      const verdict = await validateToolArgs(primitive.inputSchema, step.input);
      if (!verdict.ok) failure('invalid-workflow', `${step.label}: ${verdict.reason}`);
    }
    for (const step of definition.steps) {
      const condition = step.when;
      if (!condition) continue;
      const source = definition.steps.find((item) => item.id === condition.stepId);
      if (!source || !step.dependsOn.includes(source.id)) failure('invalid-workflow', 'A branch must depend directly on its decision step.');
      const schema = this.primitive(source!).branchSchema?.(source!.input);
      if (!schema) failure('invalid-workflow', 'Choose a typed decision step for this branch.');
      if ('otherwise' in condition) {
        if (condition.otherwise !== true || Object.keys(condition).some((key) => !['stepId', 'otherwise'].includes(key))) {
          failure('invalid-workflow', 'Use a valid fallback branch.');
        }
        if (!definition.steps.some((item) => item.when?.stepId === source!.id && !('otherwise' in item.when))) {
          failure('invalid-workflow', 'Add a result condition before its fallback branch.');
        }
        if (definition.steps.filter((item) => item.when?.stepId === source!.id && 'otherwise' in item.when).length > 1) {
          failure('invalid-workflow', 'Use only one fallback for each decision.');
        }
        continue;
      }
      const field = schema![condition.questionId];
      if (Object.keys(condition).some((key) => !['stepId', 'questionId', 'type', 'operator', 'value', 'minConfidence'].includes(key))
        || !field || field.type !== condition.type
        || !(field.type === 'choice' ? ['eq', 'neq'] : ['eq', 'neq', 'gte', 'gt', 'lte', 'lt']).includes(condition.operator)
        || (field.type === 'choice' ? typeof condition.value !== 'string' || !field.choices?.includes(condition.value)
          : typeof condition.value !== 'number' || !Number.isFinite(condition.value)
            || condition.value < (field.min ?? 0) || condition.value > (field.max ?? 1))
        || (condition.minConfidence !== undefined && (field.type === 'noul' || typeof condition.minConfidence !== 'number'
          || !Number.isFinite(condition.minConfidence) || condition.minConfidence < 0 || condition.minConfidence > 1))) {
        failure('invalid-workflow', 'Choose a valid typed result and threshold for the branch.');
      }
    }
    const visited = new Set<string>();
    while (visited.size < ids.size) {
      const next = definition.steps.filter((step) => !visited.has(step.id)
        && step.dependsOn.every((id) => visited.has(id)));
      if (!next.length) failure('invalid-workflow', 'Dependencies must name existing steps and cannot form a loop.');
      for (const step of next) visited.add(step.id);
    }
    return definition;
  }

  async get(runId: string, userId: string): Promise<WorkflowRun> {
    if (typeof runId !== 'string' || !ID.test(runId) || typeof userId !== 'string' || !userId) {
      return failure('workflow-not-found', 'Run not found.');
    }
    const run = await AgentWorkflowRuns.findOneAsync({ _id: runId, userId, namespace: this.options.namespace });
    if (!run) return failure('workflow-not-found', 'Run not found.');
    return run;
  }

  private async permitted(run: WorkflowRun, step?: WorkflowStep): Promise<void> {
    if (!(await this.options.authorize(run.userId, run.missionId, step))) {
      failure('workflow-not-authorized', 'This mission, agent, or saved agent version is no longer available. Check the mission and save the plan again.');
    }
    if (step?.when) {
      const decision = run.definition.steps.find((item) => item.id === step.when!.stepId);
      if (!decision || !await this.options.authorize(run.userId, run.missionId, decision)) {
        failure('workflow-not-authorized', 'This branch’s decision is no longer available. Save the plan again before running it.');
      }
    }
  }

  async start(args: {
    userId: string; missionId: string; definition: WorkflowDefinition; requestKey: string;
  }): Promise<string> {
    const definition = await this.validate(args.definition);
    if (typeof args.userId !== 'string' || !args.userId || typeof args.missionId !== 'string'
      || !ID.test(args.missionId) || typeof args.requestKey !== 'string' || !ID.test(args.requestKey)) {
      failure('invalid-workflow', 'An owner, mission and request key are required.');
    }
    const id = `wf-${workflowFingerprint([this.options.namespace, args.userId, args.missionId, args.requestKey]).slice(0, 40)}`;
    const hash = workflowFingerprint(definition);
    const existing = await AgentWorkflowRuns.findOneAsync(id);
    if (existing) {
      if (existing.definitionHash !== hash) failure('workflow-request-conflict', 'This request key belongs to another workflow version.');
      await this.permitted(existing);
      return id;
    }
    const now = new Date();
    const states = Object.fromEntries(definition.steps.map((step) => [step.id, {
      id: step.id, label: step.label, primitive: step.primitive,
      ...(typeof step.input.agent === 'string' ? { agent: step.input.agent } : {}),
      status: 'pending' as const, attempts: 0,
      fingerprint: workflowFingerprint({ definitionHash: hash, step }),
      idempotencyKey: `${id}-${step.id}`,
    }]));
    const run: WorkflowRun = {
      _id: id, namespace: this.options.namespace, userId: args.userId, missionId: args.missionId,
      definitionRevision: definition.revision, definitionHash: hash, definition,
      name: definition.name, strategy: definition.strategy, states,
      status: 'queued', executions: 0, activeMs: 0, createdAt: now, updatedAt: now,
    };
    await this.permitted(run);
    for (const step of definition.steps) await this.permitted(run, step);
    try { await AgentWorkflowRuns.insertAsync(run); }
    catch (error) {
      const winner = await AgentWorkflowRuns.findOneAsync(id);
      if (!winner || winner.definitionHash !== hash) throw error;
    }
    this.wake(id);
    return id;
  }

  wake(runId: string): void {
    Meteor.defer(() => {
      void this.drive(runId).catch(() => console.error('[10thfloor:agent] workflow worker could not finish its checkpoint'));
    });
  }

  private async write(runId: string, token: string, set: Record<string, unknown>, inc?: Record<string, number>, unset?: string[]): Promise<void> {
    const result = await updateRun({
      _id: runId, namespace: this.options.namespace, status: 'running',
      'lease.token': token, 'lease.until': { $gt: new Date() },
    }, { $set: { ...set, updatedAt: new Date() }, ...(inc ? { $inc: inc } : {}),
      ...(unset?.length ? { $unset: Object.fromEntries(unset.map((key) => [key, ''])) } : {}),
    });
    // Re-adopting an identical receipt can be a real no-op when both writes
    // share the same millisecond. Ownership is proved by the fenced match,
    // not by whether Mongo needed to change the document.
    if (result.matchedCount !== 1) failure('workflow-lease-lost', 'This worker no longer owns the run.');
  }

  async drive(runId: string): Promise<void> {
    if (this.active.has(runId)) return;
    const token = Random.id();
    const now = new Date();
    const claimed = await updateRun({
      _id: runId, namespace: this.options.namespace, status: { $in: ['queued', 'running'] },
      $or: [{ lease: { $exists: false } }, { 'lease.until': { $lt: now } }],
    }, { $set: { status: 'running', lease: { token, until: new Date(now.getTime() + LEASE_MS) }, updatedAt: now } });
    if (claimed.modifiedCount !== 1) return;
    const controller = new AbortController();
    this.active.set(runId, controller);
    let renewing = false;
    const renew = Meteor.setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.write(runId, token, { 'lease.until': new Date(Date.now() + LEASE_MS) })
        .catch(() => controller.abort()).finally(() => { renewing = false; });
    }, LEASE_MS / 3);
    const began = Date.now();
    let expiry: ReturnType<typeof Meteor.setTimeout> | undefined;
    try {
      let run = await AgentWorkflowRuns.findOneAsync(runId) as WorkflowRun;
      await this.permitted(run);
      if (workflowFingerprint(run.definition) !== run.definitionHash) failure('workflow-invalid-snapshot', 'The saved run definition changed.');
      await this.validate(run.definition);
      const remaining = run.definition.budget.timeoutMs - run.activeMs;
      if (remaining <= 0) failure('workflow-budget', 'The run reached its time limit.');
      expiry = Meteor.setTimeout(() => controller.abort(), remaining);
      // A vanished worker cannot cause an unreviewed second side effect.
      for (const state of Object.values(run.states)) {
        if (state.status !== 'running') continue;
        const step = run.definition.steps.find((item) => item.id === state.id)!;
        const primitive = this.primitive(step);
        if (!['safe', 'idempotent'].includes(primitive.replay)) {
          await this.write(runId, token, { [`states.${state.id}.status`]: 'failed', [`states.${state.id}.error`]: 'Execution was interrupted. Review its receipts before running it again.' });
        } else await this.write(runId, token, { [`states.${state.id}.status`]: 'pending' });
      }
      while (!controller.signal.aborted) {
        run = await AgentWorkflowRuns.findOneAsync(runId) as WorkflowRun;
        await this.permitted(run);
        const states = Object.values(run.states);
        if (states.some((state) => state.status === 'failed')) {
          await this.write(runId, token, { status: 'failed', error: 'A step needs attention.', finishedAt: new Date() });
          return;
        }
        if (states.every((state) => settled(state.status))) {
          await this.write(runId, token, { status: 'completed', finishedAt: new Date() });
          return;
        }
        const candidates = run.definition.steps.filter((step) => run.states[step.id].status === 'pending'
          && step.dependsOn.every((id) => settled(run.states[id].status)));
        const ready: WorkflowStep[] = [];
        let skipped = false;
        for (const step of candidates) {
          let reason = '';
          const finished = step.dependsOn.filter((id) => run.states[id].status === 'completed');
          if (step.dependsOn.length && (step.dependencyMode === 'any' ? !finished.length : finished.length !== step.dependsOn.length)) {
            reason = 'Skipped because a required branch did not run.';
          } else if (step.when) {
            const source = run.states[step.when.stepId];
            if (source.status === 'skipped') reason = 'Skipped because the decision did not run.';
            else {
              const matches = 'otherwise' in step.when
                ? !run.definition.steps.some((item) => item.when?.stepId === step.when!.stepId && !('otherwise' in item.when)
                  && workflowConditionMatches(item.when, source.output))
                : workflowConditionMatches(step.when, source.output);
              if (!matches) reason = 'otherwise' in step.when ? 'Skipped: another decision branch matched.' : 'Skipped: the decision did not match this condition.';
            }
          }
          if (reason) {
            await this.write(runId, token, { [`states.${step.id}.status`]: 'skipped', [`states.${step.id}.summary`]: reason,
              [`states.${step.id}.completedAt`]: new Date(), [`states.${step.id}.replayAllowed`]: true });
            skipped = true;
          } else ready.push(step);
        }
        if (!ready.length) {
          if (skipped) continue;
          await this.write(runId, token, { status: 'awaiting' });
          return;
        }
        const dispatches = ready.filter((step) => !run.states[step.id].childSessionId).length;
        if (run.executions + dispatches > run.definition.budget.steps) failure('workflow-budget', 'The run reached its step limit.');
        // Independent graph nodes execute concurrently. A chain remains serial.
        await Promise.all(ready.map((step) => this.execute(run, step, token, controller)));
      }
      failure('workflow-budget', 'The run reached its time limit or was interrupted.');
    } catch (error) {
      controller.abort();
      // Raw application exceptions may contain secrets; keep them out of UI.
      const code = (error as Meteor.Error)?.error;
      const reason = typeof code === 'string' && code.startsWith('workflow-')
        ? (error as Meteor.Error).reason : 'The run could not finish. Review its steps and try again.';
      try { await this.write(runId, token, { status: 'failed', error: reason, finishedAt: new Date() }); } catch { /* Stop or lease loss wins. */ }
    } finally {
      controller.abort();
      if (expiry !== undefined) Meteor.clearTimeout(expiry);
      Meteor.clearInterval(renew);
      this.active.delete(runId);
      await updateRun({ _id: runId, 'lease.token': token }, {
        $unset: { lease: '' }, $inc: { activeMs: Date.now() - began },
      });
    }
  }

  private async execute(run: WorkflowRun, step: WorkflowStep, token: string, controller: AbortController): Promise<void> {
    const primitive = this.primitive(step);
    const state = run.states[step.id];
    const path = `states.${step.id}`;
    const outputs = Object.fromEntries(step.dependsOn.filter((id) => run.states[id].status === 'completed')
      .map((id) => [id, run.states[id].output ?? null]));
    const fingerprint = workflowFingerprint({ definitionHash: run.definitionHash, step, outputs });
    const assertActive = async (): Promise<void> => {
      if (controller.signal.aborted) failure('workflow-interrupted', 'The run was interrupted.');
      const current = await AgentWorkflowRuns.findOneAsync({ _id: run._id, status: 'running', 'lease.token': token, 'lease.until': { $gt: new Date() } });
      if (!current) failure('workflow-lease-lost', 'This worker no longer owns the run.');
      await this.permitted(current!, step);
    };
    try {
      await assertActive();
      if ((primitive.requireApproval || step.requireApproval) && state.approval?.fingerprint !== fingerprint) {
        await this.write(run._id, token, { [`${path}.status`]: 'awaiting', [`${path}.waitReason`]: 'approval', [`${path}.fingerprint`]: fingerprint, [`${path}.summary`]: 'Review this step to continue.' });
        return;
      }
      if (state.approval?.approved === false) failure('workflow-denied', 'This step was declined.');
      await this.write(run._id, token, { [`${path}.status`]: 'running', [`${path}.startedAt`]: new Date(), [`${path}.fingerprint`]: fingerprint },
        state.childSessionId ? undefined : { [`${path}.attempts`]: 1, executions: 1 }, [`${path}.waitReason`]);
      const result = await primitive.execute(step.input, {
        run, step, state: { ...state, fingerprint }, userId: run.userId, missionId: run.missionId,
        signal: controller.signal, idempotencyKey: state.idempotencyKey,
        outputs,
        assertActive,
        checkpoint: async (receipt, extra = {}) => {
          workflowCanonical(receipt);
          await assertActive();
          await this.write(run._id, token, { [`${path}.receipt`]: receipt, ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [`${path}.${key}`, value])) });
        },
      });
      await assertActive();
      workflowCanonical(result);
      if (result.waitReason !== undefined && !['processing', 'approval'].includes(result.waitReason)) {
        failure('workflow-result-invalid', 'The step returned an unsupported wait reason.');
      }
      if (primitive.outputSchema && !result.waiting) {
        const valid = await validateToolArgs(primitive.outputSchema, result.output);
        if (!valid.ok) failure('workflow-result-invalid', 'The step result did not match its output schema.');
      }
      const set: Record<string, unknown> = {
        [`${path}.status`]: result.waiting ? 'awaiting' : 'completed',
        [`${path}.summary`]: String(result.summary ?? (result.waiting ? 'Waiting for this step.' : 'Complete')).slice(0, 4000),
        ...(result.waiting ? { [`${path}.waitReason`]: result.waitReason ?? 'processing' } : {}),
        ...(!result.waiting ? { [`${path}.completedAt`]: new Date() } : {}),
      };
      for (const key of ['output', 'receipt', 'childSessionId'] as const) {
        if (result[key] !== undefined) set[`${path}.${key}`] = result[key];
      }
      if (!result.waiting) {
        const hints = await this.policyHints(primitive, { ...state, ...result, status: 'completed' }, run);
        set[`${path}.replayAllowed`] = hints.replayAllowed;
        set[`${path}.retryAllowed`] = hints.retryAllowed;
      }
      await this.write(run._id, token, set, undefined, result.waiting ? undefined : [`${path}.waitReason`]);
    } catch (error) {
      const code = (error as Meteor.Error)?.error;
      const reason = typeof code === 'string' && code.startsWith('workflow-')
        ? (error as Meteor.Error).reason : 'This step could not finish. Its receipts are preserved.';
      try {
        const current = await AgentWorkflowRuns.findOneAsync(run._id);
        const hints = await this.policyHints(primitive, current?.states[step.id] ?? state, run);
        await this.write(run._id, token, { [`${path}.status`]: 'failed', [`${path}.error`]: reason,
          [`${path}.retryAllowed`]: hints.retryAllowed, [`${path}.replayAllowed`]: hints.replayAllowed }, undefined, [`${path}.waitReason`]);
      } catch { /* Stop wins. */ }
    }
  }

  async approve(args: { runId: string; userId: string; stepId: string; fingerprint: string; approved: boolean }): Promise<void> {
    const run = await this.get(args.runId, args.userId);
    const step = run.definition.steps.find((item) => item.id === args.stepId);
    if (!step) failure('workflow-step-not-found', 'Step not found.');
    await this.permitted(run, step);
    const state = run.states[args.stepId];
    if (state.fingerprint !== args.fingerprint || state.status !== 'awaiting' || state.childSessionId
      || !['running', 'awaiting'].includes(run.status)) {
      failure('workflow-review-changed', 'This step changed. Review its current request.');
    }
    const changed = await updateRun({
      _id: run._id, userId: args.userId, status: { $in: ['running', 'awaiting'] },
      [`states.${args.stepId}.status`]: 'awaiting', [`states.${args.stepId}.fingerprint`]: args.fingerprint,
    }, { $set: {
      [`states.${args.stepId}.approval`]: { fingerprint: args.fingerprint, approved: args.approved, userId: args.userId, at: new Date() },
      [`states.${args.stepId}.status`]: args.approved ? 'pending' : 'failed',
      ...(!args.approved ? { [`states.${args.stepId}.error`]: 'Declined by the owner.' } : {}),
      ...(run.status === 'awaiting' ? { status: 'queued' } : {}), updatedAt: new Date(),
    }, $unset: { [`states.${args.stepId}.waitReason`]: '' } });
    if (changed.modifiedCount !== 1) failure('workflow-review-changed', 'This request was already answered.');
    this.wake(run._id);
  }

  async cancel(runId: string, userId: string): Promise<void> {
    const run = await this.get(runId, userId);
    const changed = await updateRun({
      _id: runId, userId, status: { $in: ['queued', 'running', 'awaiting'] },
    }, { $set: { status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() } });
    if (!changed.modifiedCount) return;
    this.active.get(runId)?.abort();
    await Promise.all(run.definition.steps.map(async (step) => {
      const state = run.states[step.id];
      if (['pending', 'running', 'awaiting'].includes(state.status)) {
        await this.primitive(step).cancel?.(state, run);
        await updateRun({ _id: runId, status: 'cancelled' }, {
          $set: { [`states.${step.id}.status`]: 'cancelled' },
          $unset: { [`states.${step.id}.waitReason`]: '' },
        });
      }
    }));
  }

  async retry(runId: string, userId: string, stepId: string): Promise<void> {
    const run = await this.get(runId, userId);
    const step = run.definition.steps.find((item) => item.id === stepId);
    if (!step || !['failed', 'awaiting'].includes(run.status)
      || !['failed', 'awaiting'].includes(run.states[stepId]?.status)) failure('workflow-retry-unavailable', 'This step is not ready to retry.');
    await this.permitted(run, step);
    const primitive = this.primitive(step!);
    if (primitive.canRetry && !await primitive.canRetry(run.states[stepId], run)) {
      failure('workflow-replay-unsafe', 'This agent stopped after requesting tools. Review its conversation before creating a new run.');
    }
    if (!['safe', 'idempotent'].includes(primitive.replay)
      && !(primitive.replay === 'guarded' && await primitive.canReplay!(run.states[stepId], run))) {
      failure('workflow-replay-unsafe', 'This action may already have changed something. Review its receipts before creating a new run.');
    }
    const changed = await updateRun({ _id: runId, userId, status: run.status, lease: { $exists: false } }, {
      $set: { status: 'queued', [`states.${stepId}.status`]: 'pending', updatedAt: new Date() },
      $unset: { error: '', finishedAt: '', [`states.${stepId}.error`]: '', [`states.${stepId}.waitReason`]: '',
        ...(run.states[stepId].approval?.approved === false ? { [`states.${stepId}.approval`]: '' } : {}),
      },
    });
    if (!changed.modifiedCount) failure('workflow-busy', 'The run is still checkpointing. Try again.');
    this.wake(runId);
  }

  async replay(args: { runId: string; userId: string; stepId: string; requestKey: string }): Promise<string> {
    const prior = await this.get(args.runId, args.userId);
    if (!['completed', 'failed', 'cancelled'].includes(prior.status) || prior.lease) failure('workflow-busy', 'Finish or stop this run before replaying it.');
    if (!prior.states[args.stepId]) failure('workflow-step-not-found', 'Step not found.');
    const affected = new Set([args.stepId]);
    for (let index = 0; index < prior.definition.steps.length; index += 1) {
      for (const step of prior.definition.steps) if (step.dependsOn.some((id) => affected.has(id))) affected.add(step.id);
    }
    for (const step of prior.definition.steps) {
      if (!affected.has(step.id)) {
        if (!settled(prior.states[step.id].status)) {
          failure('workflow-replay-incomplete', 'Choose an earlier step that includes the unfinished branches.');
        }
        continue;
      }
      await this.permitted(prior, step);
      const primitive = this.primitive(step);
      const state = prior.states[step.id];
      if (state.attempts > 0 && primitive.replay !== 'safe'
        && !(primitive.canReplay && await primitive.canReplay(state, prior))) {
        failure('workflow-replay-unsafe', `${step.label} may have external effects. Review its receipts before creating a new run.`);
      }
    }
    // Insert with no worker before replacing checkpoints, so a worker can
    // never observe the all-pending intermediate replay graph.
    if (typeof args.requestKey !== 'string' || !ID.test(args.requestKey)) failure('invalid-workflow', 'A request key is required.');
    const id = `wf-${workflowFingerprint([this.options.namespace, args.userId, prior._id, args.stepId, args.requestKey]).slice(0, 40)}`;
    if (await AgentWorkflowRuns.findOneAsync({ _id: id, userId: args.userId })) return id;
    const now = new Date();
    const states = Object.fromEntries(prior.definition.steps.map((step) => [step.id,
      !affected.has(step.id) && settled(prior.states[step.id].status)
        ? { ...prior.states[step.id] }
        : { id: step.id, label: step.label, primitive: step.primitive,
          ...(typeof step.input.agent === 'string' ? { agent: step.input.agent } : {}),
          status: 'pending' as const, attempts: 0, fingerprint: prior.states[step.id].fingerprint,
          idempotencyKey: `${id}-${step.id}` },
    ]));
    const run: WorkflowRun = {
      _id: id, userId: args.userId, missionId: prior.missionId, namespace: this.options.namespace,
      definition: prior.definition, definitionHash: prior.definitionHash,
      definitionRevision: prior.definitionRevision, name: prior.name, strategy: prior.strategy,
      states, executions: 0, activeMs: 0, status: 'queued', createdAt: now, updatedAt: now,
      parentRunId: prior._id, replayFrom: args.stepId,
    };
    try { await AgentWorkflowRuns.insertAsync(run); } catch (error) {
      if (!await AgentWorkflowRuns.findOneAsync({ _id: id, userId: args.userId })) throw error;
    }
    this.wake(id);
    return id;
  }

  /** Recover queued/interrupted runs and reconcile durable external waits. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = await AgentWorkflowRuns.find({ namespace: this.options.namespace,
        status: { $in: ['queued', 'running', 'awaiting'] } }, { limit: 64, sort: { updatedAt: 1 } }).fetchAsync();
      for (const row of rows) {
        if (row.status === 'awaiting' && !row.lease) {
          const external = Object.values(row.states).filter((state) => state.status === 'awaiting' && state.childSessionId);
          const ready = Object.values(row.states).some((state) => state.status === 'pending' || state.status === 'failed');
          if (external.length || ready) {
            await updateRun({ _id: row._id, status: 'awaiting', lease: { $exists: false } }, {
              $set: { status: 'queued', ...Object.fromEntries(external.map((state) => [`states.${state.id}.status`, 'pending'])) },
            });
          }
        }
        this.wake(row._id);
      }
    } finally { this.polling = false; }
  }
}
