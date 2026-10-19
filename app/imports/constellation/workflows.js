export const WORKFLOW_STRATEGIES = Object.freeze([
  { id: 'workflow', label: 'Workflow', hint: 'Run steps after their dependencies finish.' },
  { id: 'supervisor', label: 'Supervisor', hint: 'The first agent plans; specialists work; the last agent combines results.' },
  { id: 'handoff', label: 'Handoff', hint: 'Each agent receives the previous agent’s result.' },
  { id: 'council', label: 'Council', hint: 'Agents work independently; the last step combines their results.' },
]);

export const WORKFLOW_DEFAULT_BUDGET = Object.freeze({
  steps: 32, timeoutMs: 600_000, turns: 40, toolCalls: 20, spend: 5,
});

/** Strategy changes have visible, deterministic dependency semantics. */
export function workflowDependencies(steps, strategy) {
  return steps.map((step, index) => {
    let dependsOn = Array.isArray(step.dependsOn) ? [...step.dependsOn] : [];
    if (strategy === 'handoff') dependsOn = index ? [steps[index - 1].id] : [];
    if (strategy === 'council') dependsOn = index === steps.length - 1
      ? steps.slice(0, index).map((item) => item.id) : [];
    if (strategy === 'supervisor') dependsOn = index === 0 ? []
      : index === steps.length - 1
        ? steps.slice(1, index).map((item) => item.id).concat(index === 1 ? [steps[0].id] : [])
        : [steps[0].id];
    return { ...step, dependsOn };
  });
}

/** This contract describes values only. Permissions and actions remain host-owned. */
export function decisionBranchSchema(questions = {}) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
    question.type === 'choice' ? { type: 'choice', choices: Object.keys(question.criteria ?? {}) }
      : question.type === 'score' ? { type: 'score', min: 0, max: (question.criteria?.length ?? 1) - 1 }
        : { type: 'noul', min: 0, max: 1 },
  ]));
}

export function workflowConditionLabel(condition, steps = []) {
  if (!condition) return '';
  const source = steps.find((step) => step.id === condition.stepId)?.label ?? 'Decision';
  if (condition.otherwise) return `${source}: no other branch matches`;
  const operator = ({ eq: 'is', neq: 'is not', gte: '≥', gt: '>', lte: '≤', lt: '<' })[condition.operator] ?? condition.operator;
  return `${source} · ${condition.questionId} ${operator} ${condition.value}${condition.minConfidence !== undefined ? ` · confidence ≥ ${Math.round(condition.minConfidence * 100)}%` : ''}`;
}

export function workflowTemplate({ strategy = 'workflow', agents = [], objective = '' } = {}) {
  const names = agents.map((agent) => typeof agent === 'string' ? agent : agent.agent);
  const primary = names.includes('orchestrator') ? 'orchestrator' : names[0];
  const specialist = names.find((agent) => agent !== primary) ?? primary;
  if (!primary) return [];
  const prompt = objective.trim() || 'Complete the mission objective and report the evidence for your result.';
  const steps = strategy === 'supervisor' ? [
    { id: 'plan', label: 'Plan', primitive: 'agent', agent: primary, prompt: `Plan the work for this objective: ${prompt}` },
    { id: 'work', label: 'Specialist work', primitive: 'agent', agent: specialist, prompt: 'Complete the assigned work in the plan. Return evidence and unresolved questions.' },
    { id: 'finish', label: 'Combine results', primitive: 'agent', agent: primary, prompt: 'Combine the completed work into a clear answer. State what meets the objective and what remains.' },
  ] : [
    { id: 'work', label: 'Work', primitive: 'agent', agent: specialist, prompt },
    { id: 'review', label: 'Review result', primitive: 'agent', agent: primary, prompt: 'Review the available results against the mission objective. Correct gaps and return a clear final answer.', dependsOn: ['work'] },
  ];
  return workflowDependencies(steps.map((step) => ({ requireApproval: false, dependsOn: [], ...step })), strategy);
}

export function workflowStatusLabel(status) {
  return ({ queued: 'Queued', pending: 'Not started', running: 'Working', awaiting: 'Needs review',
    completed: 'Complete', skipped: 'Skipped', failed: 'Needs attention', cancelled: 'Stopped' })[status] ?? 'Not started';
}
