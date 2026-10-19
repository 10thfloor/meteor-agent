import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

// Isolated DOM and intercepted transport: never writes to the workspace or calls a model.
if (Meteor.isClient) describe('Constellation agent capability controls', function () {
  let initializeAgentCapabilities;
  let fixture; let ui; let config; let skills; let servers; let tools; let calls; let response; let opens; let counts;
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await frame(); };
  const $ = (selector) => fixture.querySelector(selector);
  const focus = (key) => [...fixture.querySelectorAll('[data-access-focus]')].find((node) => node.dataset.accessFocus === key);
  const click = (key) => { const control = focus(key); assert.ok(control, `missing ${key}`); control.click(); };
  const change = (control, value) => {
    if (control.type === 'checkbox') control.checked = value; else control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const skill = (id, agents = [], enabled = true) => ({ _id: id, name: id, description: `${id} instructions`, agents, enabled, revision: 1 });
  const server = (patch = {}) => ({ _id: 'server', name: 'Local tools', agents: ['atlas'], enabled: true, trusted: true,
    status: 'ready', managed: 'app', locked: true, approval: 'ask', toolMode: 'all', selectedTools: [], revision: 1, ...patch });
  const tool = (name, patch = {}) => ({ _id: name, name: `local_${name}`, remoteName: name, displayName: name,
    source: 'app-mcp', serverId: 'server', status: 'ready', approval: 'ask', agents: ['atlas'], ...patch });
  before(async () => { ({ initializeAgentCapabilities } = await import('../client/agent-capabilities.js')); });
  beforeEach(() => {
    config = { _id: 'agent', agent: 'atlas', displayName: 'Atlas', enabled: true, status: 'active' };
    skills = []; servers = []; tools = []; calls = []; opens = []; counts = null;
    fixture = document.createElement('section'); fixture.className = 'crew-form';
    const skillMount = document.createElement('div'); const toolMount = document.createElement('div'); const decisionMount = document.createElement('div');
    fixture.append(skillMount, toolMount, decisionMount); document.body.append(fixture);
    response = async (method, input) => {
      if (method === 'constellation.agentSkillSet') {
        const row = skills.find((item) => item._id === input.skillId);
        return { ...row, revision: row.revision + 1, agents: input.assigned ? [...row.agents, input.agent] : row.agents.filter((agent) => agent !== input.agent) };
      }
      const row = servers.find((item) => item._id === input.serverId);
      return { ...row, revision: row.revision + 1,
        agents: input.assigned ? [...new Set([...row.agents, input.agent])] : row.agents.filter((agent) => agent !== input.agent),
        agentToolPolicies: [{ agent: input.agent, toolMode: input.toolMode, selectedTools: input.selectedTools }] };
    };
    ui = initializeAgentCapabilities({ skillsMount: skillMount, toolsMount: toolMount, decisionsMount: decisionMount,
      getSkills: () => skills, getServers: () => servers, getTools: () => tools,
      callMethod: (method, input) => { calls.push({ method, input }); return response(method, input); },
      openSkill: (...args) => opens.push(['skill', ...args]), openMcp: (...args) => opens.push(['mcp', ...args]),
      configureLearning: (...args) => opens.push(['learning', ...args]), openSkillsTab: () => opens.push(['skills-tab']),
      onCounts: (value) => { counts = value; } });
  });
  afterEach(() => { ui.destroy(); fixture.remove(); });

  it('lists only assigned skills and distinguishes skill and agent availability', () => {
    skills = [skill('Enabled skill', ['atlas']), skill('Paused skill', ['atlas'], false), skill('Someone else', ['signal'])];
    ui.render(config);
    assert.include(fixture.textContent, 'Assigned skills · 2'); assert.strictEqual(counts.skills, 2);
    assert.include($('[data-skill-id="Enabled skill"]').textContent, 'Enabled');
    assert.include($('[data-skill-id="Paused skill"]').textContent, 'Skill disabled');
    assert.notInclude(fixture.textContent, 'Someone else');
    ui.render({ ...config, enabled: false });
    assert.include($('[data-skill-id="Enabled skill"]').textContent, 'Agent disabled');
    assert.include($('[data-skill-id="Paused skill"]').textContent, 'Skill disabled');
  });

  it('assigns disabled shared skills without enabling them, and removes only this agent', async () => {
    skills = [skill('Research', ['signal'], false)]; ui.render(config); click('skill-picker'); click('skill-assign:Research'); await settle();
    assert.deepEqual(calls[0], { method: 'constellation.agentSkillSet', input: { agent: 'atlas', skillId: 'Research', expectedRevision: 1, assigned: true } });
    assert.strictEqual(counts.skills, 1); assert.include($('[data-skill-id="Research"]').textContent, 'Skill disabled');
    assert.include($('[data-skill-id="Research"]').textContent, 'edits affect 2 agents');
    skills = [{ ...skills[0], agents: ['signal', 'atlas'], revision: 2 }]; ui.render(config);
    click('skill-assign:Research'); await settle();
    assert.deepEqual(calls[1].input, { agent: 'atlas', skillId: 'Research', expectedRevision: 2, assigned: false });
    assert.strictEqual(counts.skills, 0); assert.notInclude(Object.keys(calls[1].input), 'enabled');
  });

  it('opens the shared editor and preassigns new skills through the existing editor', () => {
    skills = [skill('Shared', ['atlas', 'signal'])]; ui.render(config);
    $('[data-skill-edit="Shared"]').click(); $('[data-agent-create-skill]').click();
    assert.deepEqual(opens, [['skill', 'Shared', { assignAgent: 'atlas' }], ['skill', null, { assignAgent: 'atlas' }]]);
    assert.include(fixture.textContent, 'Shared skill · edits affect 2 agents.');
  });

  it('preserves search focus across reactive updates and closes the picker with Escape', () => {
    skills = [skill('Research'), skill('Operations')]; ui.render(config); click('skill-picker');
    const search = focus('skill-search'); search.value = 'Res'; search.dispatchEvent(new Event('input', { bubbles: true }));
    ui.render(config);
    assert.strictEqual(document.activeElement, focus('skill-search')); assert.strictEqual(focus('skill-search').value, 'Res');
    assert.ok($('[data-skill-id="Research"]')); assert.isNull($('[data-skill-id="Operations"]'));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); focus('skill-search').dispatchEvent(enter);
    assert.isTrue(enter.defaultPrevented, 'search must not submit the agent form');
    focus('skill-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.isUndefined(focus('skill-search')); assert.strictEqual(document.activeElement, focus('skill-picker'));
  });

  it('blocks duplicate saves and shows an error without losing the original assignment', async () => {
    skills = [skill('Shared', ['atlas'])]; let reject;
    response = () => new Promise((resolve, fail) => { reject = fail; }); ui.render(config);
    focus('skill-assign:Shared').focus(); click('skill-assign:Shared'); click('skill-assign:Shared');
    assert.lengthOf(calls, 1); assert.isTrue(focus('skill-assign:Shared').disabled);
    assert.ok($('[data-state="saving"][role="status"]'));
    reject({ reason: 'This skill changed. Reload and try again.' }); await settle();
    assert.include($('[role="alert"]').textContent, 'This skill changed'); assert.strictEqual(counts.skills, 1);
    assert.isFalse(focus('skill-assign:Shared').disabled); assert.strictEqual(document.activeElement, focus('skill-assign:Shared'));
    skills = [{ ...skills[0], revision: 4 }]; response = async () => ({ ...skills[0], agents: [], revision: 5 });
    ui.render(config); click('skill-assign:Shared'); await settle(); assert.strictEqual(calls[1].input.expectedRevision, 4);
  });

  it('does not assign capabilities to unsaved or archived agents', () => {
    skills = [skill('Shared', ['atlas'])]; servers = [server()]; tools = [tool('read')];
    ui.render({ agent: 'atlas', enabled: true }); click('skill-picker'); click('skill-create');
    assert.include(fixture.textContent, 'Save this agent'); assert.lengthOf(calls, 0); assert.lengthOf(opens, 0);
    ui.render({ ...config, _id: 'draft:atlas', _draft: true }); click('skill-picker'); click('skill-create');
    assert.include(fixture.textContent, 'Save this agent'); assert.lengthOf(calls, 0); assert.lengthOf(opens, 0);
    ui.render({ ...config, status: 'archived' }); click('skill-assign:Shared');
    assert.isTrue(focus('server-access:server').disabled); assert.lengthOf(calls, 0);
    assert.include(fixture.textContent, 'Restore this agent');
  });

  it('edits built-in MCP access while preserving the server-wide selection ceiling', async () => {
    servers = [server({ toolMode: 'selected', selectedTools: ['read'] })]; tools = [tool('read'), tool('write')]; ui.render(config);
    assert.include($('[data-server-id="server"] summary').textContent, '1 available');
    assert.isTrue(focus('server-tool:server:write').disabled); assert.isFalse(focus('server-tool:server:write').checked);
    assert.isUndefined(focus('server-configure:server')); assert.include(fixture.textContent, 'Connection managed by app');
    change(focus('server-mode:server'), 'selected'); await settle();
    assert.deepEqual(calls[0], { method: 'constellation.agentMcpSet', input: { agent: 'atlas', serverId: 'server', expectedRevision: 1,
      assigned: true, toolMode: 'selected', selectedTools: ['read'] } });
    assert.isFalse(focus('server-tool:server:read').disabled); assert.isTrue(focus('server-tool:server:write').disabled);
    assert.include(fixture.textContent, 'Not allowed by server settings');
    assert.notInclude(Object.keys(calls[0].input), 'command'); assert.notInclude(Object.keys(calls[0].input), 'agents');
  });

  it('requires explicit server access, then saves individual tool choices', async () => {
    servers = [server({ agents: [], agentToolPolicies: [{ agent: 'atlas', toolMode: 'selected', selectedTools: ['read'] }] })];
    tools = [tool('read', { agents: [] }), tool('write', { agents: [] })]; ui.render(config);
    assert.include($('[data-server-id="server"] summary').textContent, 'Access off');
    assert.isTrue(focus('server-mode:server').disabled); assert.isTrue(focus('server-tool:server:read').disabled); assert.isFalse(focus('server-tool:server:read').checked);
    change(focus('server-access:server'), true); await settle();
    assert.strictEqual(calls[0].input.assigned, true); assert.deepEqual(calls[0].input.selectedTools, ['read']);
    change(focus('server-tool:server:write'), true); await settle();
    assert.deepEqual(calls[1].input.selectedTools, ['read', 'write']); assert.strictEqual(calls[1].input.expectedRevision, 2);
  });

  it('distinguishes unavailable connections from access off without granting permissions', async () => {
    servers = [server({ enabled: false, status: 'disabled' })]; tools = [tool('read')]; ui.render(config);
    assert.include($('[data-server-id="server"] summary').textContent, 'Unavailable'); assert.include(fixture.textContent, 'Server disabled');
    let reject; response = () => new Promise((resolve, fail) => { reject = fail; });
    change(focus('server-access:server'), false);
    assert.isTrue(focus('server-access:server').disabled); assert.strictEqual($('.agent-mcp-body').getAttribute('aria-busy'), 'true');
    reject({ reason: 'Wait for the current mission to finish.' }); await settle();
    assert.isTrue(focus('server-access:server').checked); assert.include($('[role="alert"]').textContent, 'Wait for the current mission');
    assert.lengthOf(calls, 1);
  });

  it('shows derived tool access and routes configuration to the existing controls', () => {
    tools = [
      { name: 'inspect_workspace', displayName: 'Workspace inspection', source: 'app', agents: ['atlas'] },
      { name: 'load_skill', displayName: 'Skill loader', category: 'skills', source: 'framework', agents: ['atlas'] },
      { name: 'experience', displayName: 'Search experience', category: 'learning', source: 'framework', agents: ['signal'] },
      { name: 'signal', displayName: 'Delegate to Signal', category: 'delegation', source: 'framework', agents: ['atlas'] },
      { name: 'evaluate_decision_node', displayName: 'Evaluate decision node', category: 'decisions', source: 'app', agents: [], assignedAgents: ['atlas'], status: 'unavailable', statusLabel: 'Needs key' },
    ]; ui.render(config);
    assert.isNull($('[data-tool-name="inspect_workspace"]'), 'the parent owns built-in capability switches');
    assert.include($('[data-tool-name="load_skill"]').textContent, 'Available');
    assert.include($('[data-tool-name="experience"]').textContent, 'Access off');
    assert.include($('[data-tool-name="signal"]').textContent, 'Follows mission crew');
    assert.include($('[data-tool-name="evaluate_decision_node"]').textContent, 'Needs key');
    assert.notInclude(fixture.textContent, 'Always available');
    click('derived:Skill tools'); click('derived:Learning tools');
    assert.deepEqual(opens, [['skills-tab'], ['learning', 'atlas']]);
  });
});
