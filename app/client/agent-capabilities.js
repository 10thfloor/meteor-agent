import { mcpAgentToolPolicy, mcpAgentCanUseTool } from '../imports/constellation/agent-capabilities.js';

const text = (tag, content, className) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
};
const messageOf = (error) => error?.reason || error?.message || 'Could not save. Try again.';
const byName = (a, b) => String(a.displayName || a.name || '').localeCompare(String(b.displayName || b.name || ''));
const inactive = (config) => !config?.enabled || config.status === 'archived';
const isMcp = (tool) => String(tool.source).endsWith('-mcp');
const stateLabel = (state) => ({ disabled: 'Server disabled', untrusted: 'Trust required', locked: 'Server locked',
  connecting: 'Connecting…', cooldown: 'Cooling down', incomplete: 'Setup incomplete', configured: 'Not tested',
  'not-tested': 'Not tested', error: 'Connection error', unavailable: 'Server unavailable' })[state] || 'Server unavailable';

/** Agent-local controls mutate the same shared records as Capabilities. */
export function initializeAgentCapabilities(host) {
  const resolveMount = (value, fallback) => typeof value === 'string' ? document.getElementById(value)
    : value || document.getElementById(fallback);
  const skillsMount = resolveMount(host.skillsMount, 'agent-skills-content');
  const toolsMount = resolveMount(host.toolsMount, 'agent-tools-content');
  const decisionsMount = resolveMount(host.decisionsMount, 'agent-decision-tool-list');
  let current = null; let currentKey; let pickerOpen = false; let query = ''; let destroyed = false;
  const pending = new Set(); const feedback = new Map(); const overrides = new Map(); const openServers = new Set();
  const saved = () => !!current?._id && !current._draft && !String(current._id).startsWith('draft:');
  const mutable = () => saved() && current.status !== 'archived';
  const keyFor = (kind, id, agent = current?.agent) => `${agent}:${kind}:${id}`;
  const button = (label, action, key, className = 'secondary-action') => {
    const node = text('button', label, className); node.type = 'button';
    if (key) node.dataset.accessFocus = key;
    node.addEventListener('click', action); return node;
  };
  const badge = (label, tone = 'muted') => {
    const node = text('span', label, 'agent-access-state'); node.dataset.tone = tone; return node;
  };
  const hint = (copy) => text('p', copy, 'agent-access-hint');
  const rows = (kind, get) => (get?.() || []).map((row) => {
    const overrideKey = `${kind}:${row._id}`; const override = overrides.get(overrideKey);
    if (!override) return row;
    if ((row.revision ?? 0) >= (override.revision ?? 0)) { overrides.delete(overrideKey); return row; }
    return override;
  });
  const fieldFeedback = (kind, id) => {
    const key = keyFor(kind, id); const status = feedback.get(key);
    if (!status && !pending.has(key)) return null;
    const node = text('p', pending.has(key) ? 'Saving…' : status?.message, 'agent-access-feedback');
    node.setAttribute('role', status?.error ? 'alert' : 'status');
    node.dataset.state = pending.has(key) ? 'saving' : status?.error ? 'error' : 'saved';
    return node;
  };
  const renderPreservingFocus = () => {
    if (destroyed) return;
    render(current);
  };
  const focusKey = (key) => [...(skillsMount?.querySelectorAll('[data-access-focus]') || []), ...(toolsMount?.querySelectorAll('[data-access-focus]') || [])]
    .find((node) => node.dataset.accessFocus === key && !node.disabled);
  async function save(kind, row, input, success) {
    const agent = current?.agent; const key = keyFor(kind, row._id, agent);
    if (!mutable() || pending.has(key)) return;
    const focus = document.activeElement?.dataset.accessFocus;
    pending.add(key); feedback.delete(key); renderPreservingFocus();
    try {
      const result = await host.callMethod(kind === 'skill' ? 'constellation.agentSkillSet' : 'constellation.agentMcpSet', {
        agent, ...(kind === 'skill' ? { skillId: row._id } : { serverId: row._id }), expectedRevision: row.revision, ...input,
      });
      if (result?._id) overrides.set(`${kind}:${result._id}`, result);
      feedback.set(key, { message: success }); host.toast?.(success);
    } catch (error) {
      feedback.set(key, { message: messageOf(error), error: true });
    } finally {
      pending.delete(key);
      if (current?.agent === agent) {
        const restore = document.activeElement === document.body || skillsMount?.contains(document.activeElement) || toolsMount?.contains(document.activeElement);
        renderPreservingFocus();
        if (restore && focus) (focusKey(focus) || focusKey(kind === 'skill' ? 'skill-picker' : `server-summary:${row._id}`))?.focus({ preventScroll: true });
      }
    }
  }
  function skillRow(skill, assigned) {
    const row = text('article', undefined, 'agent-access-row'); row.dataset.skillId = skill._id;
    const copy = text('div', undefined, 'agent-access-copy');
    const title = text('div', undefined, 'agent-access-title'); title.append(text('strong', skill.name));
    title.append(badge(!skill.enabled ? 'Skill disabled' : inactive(current) ? 'Agent disabled' : 'Enabled',
      skill.enabled && !inactive(current) ? 'ready' : 'muted'));
    copy.append(title); if (skill.description) copy.append(hint(skill.description));
    if (assigned && (skill.agents?.length || 0) > 1) copy.append(hint(`Shared skill · edits affect ${skill.agents.length} agents.`));
    const actions = text('div', undefined, 'agent-access-actions');
    const edit = button('Edit skill', () => host.openSkill?.(skill._id, { assignAgent: current.agent }), `skill-edit:${skill._id}`, 'agent-access-link');
    edit.dataset.skillEdit = skill._id;
    edit.disabled = !mutable();
    if (assigned) actions.append(edit);
    const assign = button(assigned ? 'Remove from agent' : 'Assign', () => void save('skill', skill, { assigned: !assigned },
      assigned ? `${skill.name} removed from ${current.displayName || current.agent}.` : `${skill.name} assigned.`), `skill-assign:${skill._id}`,
    assigned ? 'agent-access-link agent-access-remove' : 'secondary-action');
    assign.disabled = !mutable() || pending.has(keyFor('skill', skill._id));
    if (pending.has(keyFor('skill', skill._id))) { assign.textContent = 'Saving…'; assign.dataset.loading = 'true'; }
    actions.append(assign); row.append(copy, actions);
    const status = fieldFeedback('skill', skill._id); if (status) row.append(status);
    return row;
  }
  function renderSkills(skills) {
    if (!skillsMount) return;
    skillsMount.classList.add('agent-capabilities'); skillsMount.replaceChildren();
    const assigned = skills.filter((skill) => skill.agents?.includes(current?.agent)).sort(byName);
    const header = text('div', undefined, 'agent-access-heading');
    header.append(text('h3', `Assigned skills${assigned.length ? ` · ${assigned.length}` : ''}`));
    const actions = text('div', undefined, 'agent-access-actions');
    const add = button(pickerOpen ? 'Done adding' : 'Add skills', () => {
      pickerOpen = !pickerOpen; query = ''; renderPreservingFocus();
      if (pickerOpen) skillsMount.querySelector('input[type="search"]')?.focus();
    }, 'skill-picker'); add.disabled = !mutable(); add.setAttribute('aria-expanded', String(pickerOpen));
    const create = button('Create skill', () => host.openSkill?.(null, { assignAgent: current.agent }), 'skill-create', 'agent-access-link');
    create.dataset.agentCreateSkill = '';
    create.disabled = !mutable(); actions.append(add, create); header.append(actions); skillsMount.append(header);
    if (!saved()) { skillsMount.append(hint('Save this agent to assign skills.')); return; }
    if (current.status === 'archived') skillsMount.append(hint('Restore this agent to change assignments.'));
    else skillsMount.append(hint('Assignments save immediately.'));
    if (pickerOpen) {
      const picker = text('div', undefined, 'agent-skill-picker'); picker.setAttribute('aria-label', 'Add skills');
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search skills';
      search.setAttribute('aria-label', 'Search skills to assign'); search.dataset.accessFocus = 'skill-search'; search.value = query;
      search.addEventListener('input', () => { query = search.value; renderPreservingFocus(); });
      search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') event.preventDefault();
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); pickerOpen = false; query = ''; renderPreservingFocus();
        skillsMount.querySelector('[data-access-focus="skill-picker"]')?.focus();
      });
      picker.append(search);
      const available = skills.filter((skill) => !skill.agents?.includes(current.agent)
        && `${skill.name} ${skill.description || ''}`.toLowerCase().includes(query.trim().toLowerCase())).sort(byName);
      const list = text('div', undefined, 'agent-skill-picker-list');
      available.forEach((skill) => list.append(skillRow(skill, false)));
      if (!available.length) list.append(hint(query ? 'No matching skills.' : 'All workspace skills are assigned.'));
      picker.append(list); skillsMount.append(picker);
    }
    const list = text('div', undefined, 'agent-access-list'); assigned.forEach((skill) => list.append(skillRow(skill, true)));
    if (!assigned.length) list.append(hint('No skills assigned.'));
    skillsMount.append(list);
  }
  const globallySelected = (server, tool) => server.toolMode !== 'selected' || server.selectedTools?.includes(tool.remoteName);
  function mcpStatus(server, tools) {
    if (!server.agents?.includes(current?.agent)) return { label: 'Access off', reason: '', tone: 'muted' };
    if (inactive(current)) return { label: 'Unavailable', reason: 'Agent disabled', tone: 'muted' };
    const ready = server.enabled && server.trusted && server.status === 'ready' && server.approval !== 'blocked';
    if (!ready) return { label: 'Unavailable', reason: server.approval === 'blocked' ? 'Blocked by server policy'
      : !server.enabled ? 'Server disabled' : !server.trusted ? 'Trust required' : stateLabel(server.status), tone: 'warning' };
    const allowed = tools.filter((tool) => mcpAgentCanUseTool(server, current.agent, tool.remoteName)
      && ['ready', 'available', 'registered'].includes(tool.status || 'ready') && tool.approval !== 'blocked');
    return allowed.length ? { label: `${allowed.length} available`, reason: '', tone: 'ready' }
      : { label: 'Unavailable', reason: tools.length ? 'No tools selected' : 'No tools discovered', tone: 'warning' };
  }
  function mcpRow(server, tools) {
    const group = text('details', undefined, 'agent-mcp-group'); group.dataset.serverId = server._id;
    group.open = openServers.has(server._id);
    group.addEventListener('toggle', () => { if (!group.isConnected) return; if (group.open) openServers.add(server._id); else openServers.delete(server._id); });
    const state = mcpStatus(server, tools); const summary = text('summary', undefined, 'agent-access-title');
    summary.dataset.accessFocus = `server-summary:${server._id}`;
    summary.append(text('strong', server.name), badge(state.label, state.tone)); group.append(summary);
    const body = text('div', undefined, 'agent-mcp-body');
    const key = keyFor('mcp', server._id); const busy = pending.has(key); const assigned = server.agents?.includes(current?.agent) || false;
    const policy = mcpAgentToolPolicy(server, current?.agent); const editable = mutable() && !busy;
    const change = (patch) => void save('mcp', server, { assigned, ...policy, ...patch }, 'Access saved.');
    const options = text('div', undefined, 'agent-mcp-options');
    const allow = text('label', undefined, 'agent-access-check'); const access = document.createElement('input'); access.type = 'checkbox';
    access.checked = assigned; access.disabled = !editable; access.dataset.accessFocus = `server-access:${server._id}`;
    access.setAttribute('aria-label', `Allow ${current?.displayName || 'agent'} access to ${server.name}`);
    access.addEventListener('change', () => change({ assigned: access.checked })); allow.append(access, text('span', 'Allow access'));
    options.append(allow);
    if (server.managed === 'app') options.append(text('span', 'Connection managed by app', 'agent-access-hint'));
    else options.append(button('Configure server', () => host.openMcp?.(server._id), `server-configure:${server._id}`, 'agent-access-link'));
    body.append(options);
    if (state.reason) body.append(hint(state.reason));
    const modeLabel = text('label', undefined, 'agent-tool-mode'); modeLabel.append(text('span', 'Tools'));
    const mode = document.createElement('select'); mode.setAttribute('aria-label', `Tools from ${server.name}`);
    mode.dataset.accessFocus = `server-mode:${server._id}`;
    for (const [value, label] of [['all', 'All allowed tools'], ['selected', 'Choose tools']]) {
      const option = text('option', label); option.value = value; mode.append(option);
    }
    mode.value = policy.toolMode; mode.disabled = !editable || !assigned;
    mode.addEventListener('change', () => change({ toolMode: mode.value,
      selectedTools: mode.value === 'selected' ? tools.filter((tool) => globallySelected(server, tool) && tool.status !== 'removed').map((tool) => tool.remoteName) : policy.selectedTools }));
    modeLabel.append(mode); body.append(modeLabel);
    if (assigned && policy.toolMode === 'all') body.append(hint('Includes new tools allowed by this server.'));
    const list = text('div', undefined, 'agent-mcp-tools');
    for (const tool of tools.sort(byName)) {
      const permitted = globallySelected(server, tool) && tool.status !== 'removed';
      const row = text('label', undefined, 'agent-mcp-tool');
      const check = document.createElement('input'); check.type = 'checkbox';
      check.checked = assigned && permitted && (policy.toolMode === 'all' || policy.selectedTools.includes(tool.remoteName));
      check.disabled = !editable || !assigned || policy.toolMode === 'all' || !permitted;
      check.dataset.accessFocus = `server-tool:${server._id}:${tool.remoteName}`;
      check.setAttribute('aria-label', `Allow ${tool.displayName || tool.remoteName}`);
      check.addEventListener('change', () => change({ toolMode: 'selected', selectedTools: check.checked
        ? [...new Set([...policy.selectedTools, tool.remoteName])] : policy.selectedTools.filter((name) => name !== tool.remoteName) }));
      const copy = text('span', undefined, 'agent-access-copy'); copy.append(text('strong', tool.displayName || tool.remoteName || tool.name));
      if (tool.description) copy.append(text('small', tool.description));
      if (!permitted) copy.append(text('small', tool.status === 'removed' ? 'No longer provided by this server' : 'Not allowed by server settings', 'agent-access-restriction'));
      else if (tool.status && !['ready', 'available', 'registered'].includes(tool.status)) copy.append(text('small', tool.status === 'conflict' ? 'Tool name conflict' : 'Tool unavailable', 'agent-access-restriction'));
      row.append(check, copy); list.append(row);
    }
    if (!tools.length) list.append(hint(server.managed === 'app' ? 'No tools discovered.' : 'No tools discovered. Open server settings to test the connection.'));
    body.append(list); const status = fieldFeedback('mcp', server._id); if (status) body.append(status);
    body.setAttribute('aria-busy', String(busy)); group.append(body); return group;
  }
  function derivedState(tool) {
    if (inactive(current)) return ['Unavailable', 'Agent disabled', 'muted'];
    if (!tool.agents?.includes(current?.agent)) {
      const assigned = tool.assignedAgents?.includes(current?.agent);
      return assigned ? ['Unavailable', tool.statusLabel || 'Not ready', 'warning'] : ['Access off', '', 'muted'];
    }
    if (tool.approval === 'blocked' || !['available', 'ready', 'registered'].includes(tool.status || 'ready')) {
      return ['Unavailable', tool.statusLabel || 'Not ready', 'warning'];
    }
    return ['Available', tool.category === 'delegation' ? 'Follows mission crew' : '', 'ready'];
  }
  function derivedGroup(title, tools, action, actionLabel, fallback) {
    const section = text('section', undefined, 'agent-derived-group'); const header = text('div', undefined, 'agent-access-heading');
    header.append(text('h4', title));
    if (action) { const manage = button(actionLabel, action, `derived:${title}`, 'agent-access-link'); manage.disabled = !mutable(); header.append(manage); }
    section.append(header);
    for (const tool of tools.sort(byName)) {
      const row = text('div', undefined, 'agent-access-row'); row.dataset.toolName = tool.name;
      const copy = text('div', undefined, 'agent-access-copy'); copy.append(text('strong', tool.displayName || tool.name));
      const [label, reason, tone] = derivedState(tool); if (reason) copy.append(hint(reason));
      row.append(copy, badge(label, tone)); section.append(row);
    }
    if (!tools.length && fallback) section.append(hint(fallback)); return section;
  }
  function renderTools(tools, servers) {
    if (!toolsMount) return;
    toolsMount.classList.add('agent-capabilities'); toolsMount.replaceChildren();
    const mcpHeader = text('div', undefined, 'agent-access-heading'); mcpHeader.append(text('h3', 'MCP servers')); toolsMount.append(mcpHeader);
    if (!saved()) { toolsMount.append(hint('Save this agent to assign MCP tools.')); return; }
    toolsMount.append(hint(current.status === 'archived' ? 'Restore this agent to change access.' : 'Access changes save immediately.'));
    for (const server of servers.sort(byName)) toolsMount.append(mcpRow(server, tools.filter((tool) => tool.serverId === server._id)));
    if (!servers.length) {
      toolsMount.append(hint('No MCP servers.'));
      if (host.openMcp) toolsMount.append(button('Add MCP server', () => host.openMcp(null), 'mcp-add', 'agent-access-link'));
    }
    const other = tools.filter((tool) => !isMcp(tool) && !['inspect_workspace', 'publish_brief'].includes(tool.name) && tool.category !== 'memory');
    toolsMount.append(derivedGroup('Skill tools', other.filter((tool) => ['skill', 'skills'].includes(tool.category)),
      host.openSkillsTab, 'Manage skills', 'Assign an enabled skill to make the skill loader available.'));
    toolsMount.append(derivedGroup('Learning tools', other.filter((tool) => tool.category === 'learning'),
      host.configureLearning ? () => host.configureLearning(current.agent) : null, 'Manage learning', 'Access off · enable experience or practice in learning settings.'));
    const delegation = other.filter((tool) => tool.category === 'delegation' && tool.agents?.includes(current.agent));
    if (delegation.length) toolsMount.append(derivedGroup('Delegation', delegation));
    const app = other.filter((tool) => !['skill', 'skills', 'learning', 'delegation', 'decisions', 'execution'].includes(tool.category));
    if (app.length) toolsMount.append(derivedGroup('App tools', app));
  }
  function render(config) {
    if (destroyed) return;
    const active = document.activeElement;
    const inside = skillsMount?.contains(active) || toolsMount?.contains(active);
    const focus = inside ? active?.dataset.accessFocus : null;
    const selection = inside && active?.type === 'search' ? [active.selectionStart, active.selectionEnd] : null;
    const nextKey = config?._id || config?.agent || 'new';
    if (currentKey !== nextKey) { pickerOpen = false; query = ''; openServers.clear(); currentKey = nextKey; }
    current = config;
    const skills = rows('skill', host.getSkills); const servers = rows('mcp', host.getServers); const tools = host.getTools?.() || [];
    renderSkills(skills); renderTools(tools, servers);
    if (decisionsMount) {
      decisionsMount.classList.add('agent-capabilities'); decisionsMount.replaceChildren();
      const list = derivedGroup('Decision tools', tools.filter((tool) => tool.category === 'decisions'));
      list.classList.add('agent-decision-tool-rows'); decisionsMount.append(list);
    }
    host.onCounts?.({ skills: skills.filter((skill) => skill.agents?.includes(config?.agent)).length,
      tools: inactive(config) ? 0 : tools.filter((tool) => tool.agents?.includes(config?.agent)).length });
    if (focus) {
      const next = focusKey(focus); if (next) { next.focus({ preventScroll: true }); if (selection) next.setSelectionRange(...selection); }
    }
  }
  return { render, destroy() { destroyed = true; skillsMount?.replaceChildren(); toolsMount?.replaceChildren(); decisionsMount?.replaceChildren(); } };
}
