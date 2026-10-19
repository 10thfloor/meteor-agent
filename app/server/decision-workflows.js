import { Meteor } from 'meteor/meteor';
import { workflowFingerprint } from 'meteor/10thfloor:agent';
import { decisionBranchSchema } from '../imports/constellation/workflows';
import { normalizeDecisionState } from '../imports/constellation/decisions';

const serviceFailures = {
  'decision-key-missing': 'Add a TypeSafe API key in Decisions connection settings, then start a new run.',
  'decision-key-locked': 'The saved TypeSafe key is locked. Open Constellation on the desktop or configure TYPESAFE_API_KEY.',
  'decision-key-rejected': 'TypeSafe rejected the API key. Update it in Decisions connection settings.',
  'decisions-disabled': 'Enable Decisions in its connection settings before running this plan.',
  'decision-access-denied': 'This agent no longer has access to the decision. Check its Decisions access and save the plan again.',
  'decision-not-found': 'This decision is no longer available in the mission.',
  'decision-revision-changed': 'This decision changed. Save the plan again before running it.',
  'decision-disabled': 'This decision is disabled. Enable it and save the plan again.',
  'decision-budget-exhausted': 'The mission reached its decision call or token limit. Review Decisions usage before starting another run.',
  'decision-request-unresolved': 'The previous decision request has no confirmed result. Review Decisions history before starting a new run.',
  'decision-network-error': 'TypeSafe could not be reached. Review Decisions history before starting a new run.',
  'decision-timeout': 'The decision timed out. Review Decisions history before starting a new run.',
  'decision-cancelled': 'The decision was cancelled.',
  'decision-provider-busy': 'TypeSafe is busy. Try a new run later.',
  'invalid-decision': 'The decision input is invalid. Check its required fields and previous-step results.',
};

export async function withWorkflowDecisionFailure(operation) {
  try { return await operation(); } catch (error) {
    const reason = serviceFailures[error?.error];
    if (reason) throw new Meteor.Error(`workflow-${error.error}`, reason);
    throw error;
  }
}

export function workflowDecisionState(input, outputs = {}) {
  const state = { ...input.state };
  if (input.context === 'dependencies' && Object.keys(outputs).length) {
    const field = input.inputFields.find((item) => item.key === input.contextField && item.type === 'text');
    if (!field) throw new Meteor.Error('workflow-decision-input', 'Choose a text input for previous results.');
    const previous = Object.entries(outputs).map(([id, output]) => `${id}: ${typeof output === 'string' ? output : JSON.stringify(output)}`).join('\n\n');
    state[field.key] = [state[field.key], 'Previous step results:', previous].filter(Boolean).join('\n\n');
  }
  return normalizeDecisionState(state, { inputFields: input.inputFields });
}

/** A fixed host-owned primitive. A saved question never supplies executable code. */
export function workflowDecisionPrimitive(decisions) {
  return {
    name: 'decision', version: 1, label: 'Decision node', replay: 'idempotent',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: {
        nodeId: { type: 'string', minLength: 1, maxLength: 120 }, revision: { type: 'integer', minimum: 1 },
        agent: { type: 'string', minLength: 1, maxLength: 120 }, agentRevision: { type: 'integer', minimum: 1 },
        nodeName: { type: 'string', minLength: 1, maxLength: 120 },
        state: { type: 'object' }, context: { enum: ['none', 'dependencies'] }, contextField: { type: 'string' },
        inputFields: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object' } },
        definition: { type: 'object' },
      }, required: ['nodeId', 'revision', 'agent', 'agentRevision', 'nodeName', 'state', 'context', 'contextField', 'inputFields', 'definition'] },
    branchSchema: (input) => decisionBranchSchema(input.definition.questions),
    // A new run is an explicit request for a new judgment. Within the same run,
    // the service's durable request key adopts a completed receipt or refuses an
    // uncertain attempt; it never repeats a paid request after a crash blindly.
    canReplay: async () => true,
    async execute(input, context) {
      await context.assertActive();
      const serviceContext = { userId: context.userId, sessionId: context.missionId, agent: input.agent,
        workflowRunId: context.run._id, workflowStepId: context.step.id,
        signal: context.signal, assertActive: context.assertActive };
      const node = await withWorkflowDecisionFailure(() => decisions.resolveNode(serviceContext, input.nodeId, input.revision));
      if (workflowFingerprint([node.definition, node.inputFields]) !== workflowFingerprint([input.definition, input.inputFields])) {
        throw new Meteor.Error('workflow-decision-changed', 'This decision changed. Save the plan again before running it.');
      }
      const state = await withWorkflowDecisionFailure(async () => workflowDecisionState(input, context.outputs));
      const result = await withWorkflowDecisionFailure(() => decisions.evaluate(serviceContext, {
        nodeId: input.nodeId, revision: input.revision, state, purpose: 'workflow', requestKey: context.idempotencyKey,
      }));
      await context.assertActive();
      if (result.status !== 'completed') throw new Meteor.Error('workflow-decision-incomplete', 'The decision did not complete. Review its history before trying again.');
      const answers = result.answers;
      const summary = Object.entries(answers).map(([id, answer]) => {
        const value = answer.type === 'noul' ? `${Math.round(answer.noul * 100)}% yes`
          : answer.type === 'score' ? `${Number(answer.score.toFixed(2))}` : answer.choice;
        return `${id}: ${value}${answer.confidence !== undefined ? ` · ${Math.round(answer.confidence * 100)}% confidence` : ''}`;
      }).join('\n');
      return { output: { answers }, summary,
        receipt: { decisionRunId: result._id, nodeId: input.nodeId, nodeRevision: input.revision, model: result.model } };
    },
  };
}
