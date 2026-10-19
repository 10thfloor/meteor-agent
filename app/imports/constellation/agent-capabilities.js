/** A missing per-agent policy preserves the server's existing assignments. */
export function mcpAgentToolPolicy(config, agent) {
  const policy = config?.agentToolPolicies?.find((row) => row.agent === agent);
  return {
    toolMode: policy?.toolMode === 'selected' ? 'selected' : 'all',
    selectedTools: Array.isArray(policy?.selectedTools) ? policy.selectedTools : [],
  };
}

export function mcpAgentHasToolAssignment(config, agent, remoteName) {
  if (!config?.agents?.includes(agent)) return false;
  const policy = mcpAgentToolPolicy(config, agent);
  return policy.toolMode !== 'selected' || policy.selectedTools.includes(remoteName);
}

/** The server-wide selection remains a ceiling, never an agent-level grant. */
export function mcpAgentCanUseTool(config, agent, remoteName) {
  return mcpAgentHasToolAssignment(config, agent, remoteName)
    && (config.toolMode !== 'selected' || !!config.selectedTools?.includes(remoteName));
}

export function mcpToolCatalogAccess(config, remoteName, status) {
  const selected = config.toolMode !== 'selected' || !!config.selectedTools?.includes(remoteName);
  const available = status === 'ready' && config.enabled && config.trusted
    && config.approval !== 'blocked' && selected;
  const assignedAgents = (config.agents ?? [])
    .filter((agent) => mcpAgentHasToolAssignment(config, agent, remoteName));
  return { agents: available ? assignedAgents : [], assignedAgents, selected };
}
