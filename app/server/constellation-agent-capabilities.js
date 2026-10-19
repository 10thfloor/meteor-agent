import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';

const commonKeys = ['agent', 'expectedRevision', 'assigned'];
function validate(input, keys) {
  check(input, Object);
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new Meteor.Error('invalid-agent-capability', 'Only access settings can be changed here.');
  }
  check(input.agent, String);
  check(input.expectedRevision, Number);
  check(input.assigned, Boolean);
  if (!input.agent || input.agent.length > 160 || !Number.isInteger(input.expectedRevision)
    || input.expectedRevision < 1) {
    throw new Meteor.Error('invalid-agent-capability', 'Choose an agent and reopen the current settings.');
  }
}

export function createConstellationAgentCapabilitiesService(host) {
  async function withAgent(userId, agent, operation) {
    await host.requireUser(userId);
    return host.withMutation(userId, async () => {
      const crew = await host.CrewConfigs.findOneAsync({ userId, agent, status: { $ne: 'archived' } });
      if (!crew || crew.archivedAt) throw new Meteor.Error('no-agent', 'This agent is no longer in the workspace.');
      return operation(crew);
    });
  }

  async function setSkill(userId, input) {
    validate(input, [...commonKeys, 'skillId']);
    check(input.skillId, String);
    return withAgent(userId, input.agent, async () => {
      const selector = { _id: input.skillId, userId };
      const skill = await host.SkillConfigs.findOneAsync(selector);
      if (!skill) throw new Meteor.Error('no-skill', 'Skill not found.');
      if (skill.revision !== input.expectedRevision) {
        throw new Meteor.Error('stale-skill', 'This skill changed. Review its current assignments and try again.');
      }
      // Target a single membership rather than replacing the shared skill or
      // trusting a browser snapshot of every other agent's assignments.
      const changed = await host.SkillConfigs.updateAsync(
        { ...selector, revision: input.expectedRevision },
        { [input.assigned ? '$addToSet' : '$pull']: { agents: input.agent },
          $set: { updatedAt: new Date() }, $inc: { revision: 1 } },
      );
      if (changed !== 1) throw new Meteor.Error('stale-skill', 'This skill changed. Try again.');
      await host.refreshSkills(userId);
      return host.SkillConfigs.findOneAsync(selector, { fields: { userId: 0 } });
    });
  }

  async function setMcp(userId, input) {
    validate(input, [...commonKeys, 'serverId', 'toolMode', 'selectedTools']);
    check(input.serverId, String);
    check(input.toolMode, String);
    check(input.selectedTools, [String]);
    if (!['all', 'selected'].includes(input.toolMode) || input.selectedTools.length > 100
      || input.selectedTools.some((name) => !name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name))) {
      throw new Meteor.Error('invalid-agent-capability', 'Choose valid tools for this agent.');
    }
    return withAgent(userId, input.agent, async () => {
      const selector = { _id: input.serverId, userId };
      const config = await host.McpConfigs.findOneAsync(selector);
      if (!config) throw new Meteor.Error('no-mcp', 'MCP server not found.');
      if (config.revision !== input.expectedRevision) {
        throw new Meteor.Error('stale-mcp', 'This server changed. Review its current access and try again.');
      }
      const selectedTools = input.toolMode === 'selected' ? [...new Set(input.selectedTools)] : [];
      // Revoking server access must work even if discovery no longer includes
      // a previously selected tool. Unknown names cannot grant anything while
      // membership is off, and a later grant will validate them afresh.
      if (input.assigned && selectedTools.length) {
        const known = await host.ToolCatalog.find({ userId, serverId: input.serverId,
          remoteName: { $in: selectedTools } }, { fields: { remoteName: 1 } }).fetchAsync();
        const names = new Set(known.map((tool) => tool.remoteName));
        if (selectedTools.some((name) => !names.has(name))) {
          throw new Meteor.Error('invalid-agent-capability', 'One or more tools are no longer in this server. Refresh its tools and try again.');
        }
      }
      await host.assertMcpMutationAllowed(userId, [input.agent]);
      const policies = (config.agentToolPolicies ?? []).filter((policy) => policy.agent !== input.agent);
      policies.push({ agent: input.agent, toolMode: input.toolMode, selectedTools });
      const changed = await host.McpConfigs.updateAsync(
        { ...selector, revision: input.expectedRevision },
        { [input.assigned ? '$addToSet' : '$pull']: { agents: input.agent },
          $set: { agentToolPolicies: policies, updatedAt: new Date() }, $inc: { revision: 1 } },
      );
      if (changed !== 1) throw new Meteor.Error('stale-mcp', 'This server changed. Try again.');
      const saved = await host.McpConfigs.findOneAsync(selector);
      await host.refreshMcp(userId, saved);
      return host.publicMcpConfig(userId, saved._id);
    });
  }
  return { setSkill, setMcp };
}

export function installConstellationAgentCapabilities(host) {
  const service = createConstellationAgentCapabilitiesService(host);
  Meteor.methods({
    async 'constellation.agentSkillSet'(input) { return service.setSkill(this.userId, input); },
    async 'constellation.agentMcpSet'(input) { return service.setMcp(this.userId, input); },
  });
  return service;
}
