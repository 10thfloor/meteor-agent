import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentSessions } from 'meteor/10thfloor:agent';
import { mcpAgentToolPolicy, mcpAgentCanUseTool, mcpAgentHasToolAssignment, mcpToolCatalogAccess } from '../imports/constellation/agent-capabilities';

describe('Constellation per-agent MCP selection', function () {
  const config = { agents: ['atlas', 'signal'], toolMode: 'selected', selectedTools: ['read', 'write'],
    agentToolPolicies: [{ agent: 'atlas', toolMode: 'selected', selectedTools: ['read', 'delete'] }] };
  it('keeps existing grants unchanged when no per-agent policy exists', () => {
    assert.deepEqual(mcpAgentToolPolicy(config, 'signal'), { toolMode: 'all', selectedTools: [] });
    assert.isTrue(mcpAgentCanUseTool(config, 'signal', 'write'));
    assert.isFalse(mcpAgentCanUseTool(config, 'unassigned', 'read'));
  });
  it('intersects agent selections with the server-wide ceiling', () => {
    assert.isTrue(mcpAgentCanUseTool(config, 'atlas', 'read'));
    assert.isFalse(mcpAgentCanUseTool(config, 'atlas', 'write'));
    assert.isFalse(mcpAgentCanUseTool(config, 'atlas', 'delete'));
    assert.isTrue(mcpAgentHasToolAssignment(config, 'atlas', 'delete'), 'configured access can be unavailable globally');
    assert.isTrue(mcpAgentCanUseTool(config, 'signal', 'write'), 'another agent retains its selection');
    assert.isFalse(mcpAgentCanUseTool({ ...config, agentToolPolicies: [{ agent: 'atlas', toolMode: 'selected', selectedTools: [] }] }, 'atlas', 'read'));
  });
  it('publishes each tool’s assignments separately from connection readiness', () => {
    const ready = { ...config, enabled: true, trusted: true, approval: 'ask' };
    assert.deepEqual(mcpToolCatalogAccess(ready, 'write', 'ready'), {
      agents: ['signal'], assignedAgents: ['signal'], selected: true,
    });
    assert.deepEqual(mcpToolCatalogAccess(ready, 'read', 'disabled'), {
      agents: [], assignedAgents: ['atlas', 'signal'], selected: true,
    });
    assert.deepEqual(mcpToolCatalogAccess(ready, 'delete', 'ready'), {
      agents: [], assignedAgents: ['atlas', 'signal'], selected: false,
    });
    assert.isEmpty(mcpToolCatalogAccess({ ...ready, approval: 'blocked' }, 'read', 'ready').agents);
  });
});

if (Meteor.isServer) describe('Constellation agent capability assignments', function () {
  this.timeout(20_000);
  let runtime; let createService; let service; let owner; let skill; let server; let sessionId;
  let refreshedSkills; let refreshedMcp; let busy;
  const rejects = async (promise, code) => {
    let error; try { await promise; } catch (caught) { error = caught; }
    assert.equal(error?.error, code);
  };
  before(async () => {
    runtime = await import('../server/main');
    ({ createConstellationAgentCapabilitiesService: createService } = await import('../server/constellation-agent-capabilities'));
  });
  beforeEach(async () => {
    owner = `agent-capability-owner-${Random.id()}`;
    refreshedSkills = 0; refreshedMcp = 0; busy = false;
    for (const agent of ['orchestrator', 'researcher', 'archived']) {
      await runtime.CrewConfigs.insertAsync({ userId: owner, agent, enabled: true,
        status: agent === 'archived' ? 'archived' : 'available', revision: 1 });
    }
    skill = await runtime.SkillConfigs.insertAsync({ userId: owner, name: 'Shared skill', slug: 'shared-skill',
      description: 'Shared instructions', content: 'Do not overwrite these instructions.',
      enabled: false, agents: ['researcher'], revision: 1 });
    server = await runtime.McpConfigs.insertAsync({ userId: owner, name: 'Shared server', managed: 'app', locked: true,
      command: 'unchanged-command', enabled: true, trusted: true, status: 'ready', approval: 'ask',
      agents: ['orchestrator', 'researcher'], toolMode: 'selected', selectedTools: ['read', 'write'],
      agentToolPolicies: [{ agent: 'researcher', toolMode: 'selected', selectedTools: ['write'] }], revision: 1 });
    for (const remoteName of ['read', 'write', 'delete']) {
      await runtime.ToolCatalog.insertAsync({ userId: owner, serverId: server, source: 'app-mcp', remoteName,
        name: `capability_test_${server}_${remoteName}` });
    }
    let pending = Promise.resolve();
    service = createService({
      CrewConfigs: runtime.CrewConfigs, SkillConfigs: runtime.SkillConfigs,
      McpConfigs: runtime.McpConfigs, ToolCatalog: runtime.ToolCatalog,
      requireUser: async (userId) => { if (userId !== owner) throw new Meteor.Error('not-authorized', 'Owner only.'); },
      withMutation: (userId, operation) => { const next = pending.catch(() => {}).then(operation); pending = next; return next; },
      refreshSkills: async () => { refreshedSkills += 1; },
      refreshMcp: async () => { refreshedMcp += 1; },
      assertMcpMutationAllowed: async (userId, agents) => {
        assert.deepEqual(agents, ['orchestrator']);
        if (busy) throw new Meteor.Error('mcp-busy', 'Wait for the agent.');
      },
      publicMcpConfig: (userId, id) => runtime.McpConfigs.findOneAsync({ _id: id, userId }, { fields: { userId: 0 } }),
    });
    sessionId = `capability-session-${Random.id()}`;
    await AgentSessions.insertAsync({ _id: sessionId, userId: owner, agent: 'orchestrator', phase: 'idle',
      model: 'mock', nextSeq: 0, usage: { input: 0, output: 0, cost: 0 }, createdAt: new Date(), updatedAt: new Date() });
  });
  afterEach(async () => {
    await Promise.all([runtime.CrewConfigs, runtime.SkillConfigs, runtime.McpConfigs, runtime.ToolCatalog]
      .map((collection) => collection.removeAsync({ userId: owner })));
    await AgentSessions.removeAsync({ _id: sessionId, userId: owner });
  });
  const skillInput = () => ({ agent: 'orchestrator', skillId: skill, expectedRevision: 1, assigned: true });
  const mcpInput = () => ({ agent: 'orchestrator', serverId: server, expectedRevision: 1,
    assigned: true, toolMode: 'selected', selectedTools: ['read'] });

  it('changes a skill membership without changing its shared content, state, or other agents', async () => {
    const saved = await service.setSkill(owner, skillInput());
    assert.sameMembers(saved.agents, ['researcher', 'orchestrator']);
    assert.equal(saved.content, 'Do not overwrite these instructions.');
    assert.equal(saved.description, 'Shared instructions');
    assert.isFalse(saved.enabled);
    assert.equal(saved.revision, 2);
    assert.notProperty(saved, 'userId');
    const removed = await service.setSkill(owner, { ...skillInput(), expectedRevision: 2, assigned: false });
    assert.deepEqual(removed.agents, ['researcher']);
    assert.equal(removed.revision, 3);
    assert.equal(refreshedSkills, 2);
  });

  it('rejects stale and concurrent skill edits without dropping other assignments', async () => {
    const results = await Promise.allSettled([
      service.setSkill(owner, skillInput()), service.setSkill(owner, { ...skillInput(), agent: 'researcher', assigned: false }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.error, 'stale-skill');
    assert.sameMembers((await runtime.SkillConfigs.findOneAsync(skill)).agents, ['researcher', 'orchestrator']);
    await rejects(service.setSkill(owner, skillInput()), 'stale-skill');
  });

  it('requires ownership and an existing unarchived agent for either kind of assignment', async () => {
    for (const [call, input] of [[service.setSkill, skillInput()], [service.setMcp, mcpInput()]]) {
      await rejects(call(null, input), 'not-authorized');
      await rejects(call('other-owner', input), 'not-authorized');
      await rejects(call(owner, { ...input, agent: 'archived' }), 'no-agent');
      await rejects(call(owner, { ...input, agent: 'missing' }), 'no-agent');
    }
    await rejects(Meteor.server.method_handlers['constellation.agentSkillSet'].call({ userId: owner }, skillInput()), 'not-authorized');
    await rejects(Meteor.server.method_handlers['constellation.agentMcpSet'].call({ userId: owner }, mcpInput()), 'not-authorized');
    assert.equal((await runtime.SkillConfigs.findOneAsync(skill)).revision, 1);
    assert.equal((await runtime.McpConfigs.findOneAsync(server)).revision, 1);
  });

  it('does not accept shared content, global access, or foreign record ids as an access edit', async () => {
    await rejects(service.setSkill(owner, { ...skillInput(), content: 'Overwrite content' }), 'invalid-agent-capability');
    await rejects(service.setSkill(owner, { ...skillInput(), skillId: Random.id() }), 'no-skill');
    await rejects(service.setMcp(owner, { ...mcpInput(), command: 'other-command' }), 'invalid-agent-capability');
    await rejects(service.setMcp(owner, { ...mcpInput(), serverId: Random.id() }), 'no-mcp');
    await rejects(service.setMcp(owner, { ...mcpInput(), selectedTools: ['invented'] }), 'invalid-agent-capability');
    await rejects(service.setSkill(owner, { ...skillInput(), expectedRevision: -1 }), 'invalid-agent-capability');
    await rejects(service.setMcp(owner, { ...mcpInput(), toolMode: 'everything' }), 'invalid-agent-capability');
  });

  it('saves app-MCP access without changing the connection, server ceiling, or other agent policy', async () => {
    const saved = await service.setMcp(owner, mcpInput());
    assert.equal(saved.command, 'unchanged-command');
    assert.isTrue(saved.locked);
    assert.isTrue(saved.enabled);
    assert.deepEqual(saved.selectedTools, ['read', 'write']);
    assert.deepEqual(mcpAgentToolPolicy(saved, 'researcher'), { toolMode: 'selected', selectedTools: ['write'] });
    assert.deepEqual(mcpAgentToolPolicy(saved, 'orchestrator'), { toolMode: 'selected', selectedTools: ['read'] });
    assert.sameMembers(saved.agents, ['researcher', 'orchestrator']);
    assert.equal(saved.revision, 2);
    await rejects(service.setMcp(owner, mcpInput()), 'stale-mcp');
    assert.equal(refreshedMcp, 1);
  });

  it('removes only this agent from the server, and never resumes a disabled connection', async () => {
    await runtime.McpConfigs.updateAsync(server, { $set: { enabled: false, status: 'disabled' } });
    const saved = await service.setMcp(owner, { ...mcpInput(), assigned: false });
    assert.deepEqual(saved.agents, ['researcher']);
    assert.isFalse(saved.enabled);
    assert.equal(saved.status, 'disabled');
    assert.deepEqual(mcpAgentToolPolicy(saved, 'researcher'), { toolMode: 'selected', selectedTools: ['write'] });
  });

  it('allows revocation after a selected tool disappears from discovery', async () => {
    await service.setMcp(owner, mcpInput());
    await runtime.ToolCatalog.removeAsync({ userId: owner, serverId: server, remoteName: 'read' });
    const saved = await service.setMcp(owner, { ...mcpInput(), expectedRevision: 2, assigned: false });
    assert.deepEqual(saved.agents, ['researcher']);
    assert.equal(saved.revision, 3);
    assert.deepEqual(mcpAgentToolPolicy(saved, 'orchestrator'), { toolMode: 'selected', selectedTools: ['read'] });
    await rejects(service.setMcp(owner, { ...mcpInput(), expectedRevision: 3 }), 'invalid-agent-capability');
    assert.deepEqual((await runtime.McpConfigs.findOneAsync(server)).agents, ['researcher']);
  });

  it('rejects access edits while the affected agent is active without making partial changes', async () => {
    busy = true;
    await rejects(service.setMcp(owner, mcpInput()), 'mcp-busy');
    assert.equal((await runtime.McpConfigs.findOneAsync(server)).revision, 1);
    assert.equal(refreshedMcp, 0);
  });

  it('enforces selected tools at live dispatch even when an old runtime still contains them', async () => {
    const context = { userId: owner, sessionId, toolCallId: 'access-test' };
    const canUse = (agent, remoteName) => runtime.configuredToolEntitlement(
      `capability_test_${server}_${remoteName}`, context, agent,
    );
    assert.isTrue(await canUse('orchestrator', 'write'));
    await service.setMcp(owner, mcpInput());
    assert.isTrue(await canUse('orchestrator', 'read'));
    assert.isFalse(await canUse('orchestrator', 'write'));
    assert.isTrue(await canUse('researcher', 'write'));
    assert.isFalse(await canUse('researcher', 'read'));
    await service.setMcp(owner, { ...mcpInput(), expectedRevision: 2, selectedTools: ['delete'] });
    assert.isFalse(await canUse('orchestrator', 'delete'), 'a per-agent grant cannot override the global ceiling');
    await service.setMcp(owner, { ...mcpInput(), expectedRevision: 3, assigned: false });
    assert.isFalse(await canUse('orchestrator', 'read'));
    assert.isTrue(await canUse('researcher', 'write'));
  });
});
