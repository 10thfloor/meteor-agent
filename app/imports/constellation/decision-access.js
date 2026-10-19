/** Catalog visibility is not a grant. Execution still rechecks server policy. */
export function decisionToolAccess(name, crew, settings = {}) {
  const creating = name === 'create_decision_node';
  const evaluating = name === 'evaluate_decision_node';
  const policies = crew.filter((agent) => agent.enabled && agent.status !== 'archived').map((agent) => ({
    agent: agent.agent,
    use: settings.agentPolicies?.[agent.agent]?.use === true,
    create: settings.agentPolicies?.[agent.agent]?.create ?? 'disabled',
  }));
  const assignedAgents = policies.filter((policy) => policy.use
    && (!creating || ['ask', 'auto'].includes(policy.create))).map((policy) => policy.agent);
  const connectionOff = settings.enabled !== true;
  const needsKey = evaluating && settings.providerConfigured !== true;
  const statusLabel = connectionOff ? 'Connection off' : needsKey ? 'Needs key'
    : !assignedAgents.length ? 'No access' : 'Available';
  const ready = !connectionOff && !needsKey && assignedAgents.length > 0;
  return {
    agents: ready ? assignedAgents : [],
    assignedAgents,
    decisionPolicies: policies,
    status: ready ? 'ready' : needsKey && !connectionOff ? 'unavailable' : 'disabled',
    statusLabel,
    decisionAction: connectionOff || needsKey ? 'connection' : 'access',
    availabilityNote: connectionOff ? 'Enable the Jev connection, then allow agents to use decisions.'
      : needsKey ? 'Add a TypeSafe key to evaluate decisions. Finding and creating definitions do not call TypeSafe.'
        : !assignedAgents.length ? creating ? 'Allow an agent to create decisions in Decision access.'
          : 'Allow an agent to use assigned decisions in Decision access.'
          : creating ? 'New decisions stay in the current mission. Each agent’s creation policy controls review.'
            : 'Use is limited to assigned decisions available in the current mission.',
  };
}

export function decisionAgentAccessSummary(policy = {}) {
  const use = policy.use === true;
  const create = use && policy.create === 'auto' ? 'Automatic'
    : use && policy.create === 'ask' ? 'Ask for approval' : 'Off';
  return { text: `Use: ${use ? 'Assigned decisions' : 'Off'} · Create: ${create}`, state: use ? 'enabled' : 'disabled' };
}
