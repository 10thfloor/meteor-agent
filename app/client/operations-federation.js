import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { escapeHtml as esc, element as $, stateBadge, createDialog, showDialog, busyAction } from './operations';

export function initializeFederation(host) {
  const Configs = new Mongo.Collection('constellation_federation');
  Meteor.subscribe('constellation.federation');
  let config = null;
  let revision = 0;
  let selectedServerId = null;
  let resources = [];
  let prompts = [];
  let secret = '';
  const dialog = createDialog('federation-dialog', 'Share access', `<form id="federation-form"><div class="op-scroll"><div class="op-section-heading"><h3>Local MCP endpoint</h3><span id="federation-status"></span></div><label class="op-check op-prominent-check"><input type="checkbox" id="federation-enabled">Allow connected apps to use selected agents and missions</label><p class="op-hint">Connections require an access token. Only apps on this computer can connect.</p><fieldset class="op-agent-choices"><legend>Shared agents</legend><div id="federation-agents"></div></fieldset><fieldset class="op-agent-choices"><legend>Shared missions</legend><div id="federation-missions"></div><p class="op-hint">Connected apps can send messages into these missions. Existing approval rules still apply.</p></fieldset><label>Endpoint<div class="op-copy-field"><input id="federation-endpoint" readonly><button type="button" class="secondary-action" id="federation-copy-endpoint">Copy</button></div></label><section class="op-evidence-section"><div class="op-section-heading"><h3>Access token</h3><span id="federation-token-hint" class="op-muted">No token</span></div><div class="op-inline-actions"><button id="federation-generate" class="secondary-action" type="button">Create token</button><button id="federation-revoke" class="danger-button" type="button">Revoke access</button></div><div id="federation-secret" hidden><p class="op-hint">Copy this token now. It is shown only once.</p><div class="op-copy-field"><input id="federation-token" type="password" readonly aria-label="New access token"><button id="federation-copy-token" class="secondary-action" type="button">Copy token</button></div></div></section><div id="federation-errors"></div></div><footer class="op-footer"><span class="op-muted">Changes apply to new requests</span><button type="submit" class="primary-action">Save access</button></footer></form>`);
  const contentDialog = createDialog('mcp-content-dialog', 'Resources &amp; prompts', `<div class="op-scroll"><div class="op-section-heading"><h3 id="mcp-content-server">Server content</h3><button class="secondary-action" id="mcp-content-refresh" type="button">Refresh</button></div><div id="mcp-content-errors"></div><section class="op-evidence-section"><h3>Resources</h3><div id="mcp-resource-list"></div></section><section class="op-evidence-section"><h3>Prompts</h3><div id="mcp-prompt-list"></div></section><div id="mcp-content-preview"></div></div>`, 'op-dialog-wide');

  function renderConfig() {
    revision = config?.revision ?? 0;
    $('federation-enabled').checked = config?.enabled === true;
    $('federation-status').innerHTML = stateBadge(config?.enabled ? 'enabled' : 'disabled');
    $('federation-agents').innerHTML = host.crew().filter((row) => row.enabled).map((row) => `<label class="op-agent-choice"><input type="checkbox" value="${esc(row.agent)}" ${config?.agentIds?.includes(row.agent) ? 'checked' : ''}><span><strong>${esc(row.displayName)}</strong><small>${esc(row.role)}</small></span></label>`).join('');
    $('federation-missions').innerHTML = host.missions().map((row) => `<label class="op-agent-choice"><input type="checkbox" value="${esc(row._id)}" ${config?.missionIds?.includes(row._id) ? 'checked' : ''}><span><strong>${esc(row.title || 'Untitled mission')}</strong></span></label>`).join('') || '<p class="op-hint">No active missions.</p>';
    $('federation-endpoint').value = config?.endpoint ?? `${window.location.origin}/constellation/mcp`;
    $('federation-token-hint').textContent = config?.tokenHint ? `Ending ${config.tokenHint}` : 'No token';
    $('federation-generate').textContent = config?.tokenHint ? 'Replace token' : 'Create token';
    $('federation-revoke').disabled = !config?.tokenHint && !config?.enabled;
  }
  $('open-federation').addEventListener('click', () => {
    secret = ''; $('federation-secret').hidden = true; $('federation-token').value = '';
    renderConfig(); showDialog(dialog);
  });
  dialog.addEventListener('close', () => { secret = ''; $('federation-token').value = ''; $('federation-secret').hidden = true; });
  $('federation-form').addEventListener('submit', (event) => {
    event.preventDefault(); void busyAction(event.submitter, $('federation-errors'), 'Saving…', async () => {
      const agentIds = [...$('federation-agents').querySelectorAll('input:checked')].map((input) => input.value);
      const missionIds = [...$('federation-missions').querySelectorAll('input:checked')].map((input) => input.value);
      await Meteor.callAsync('constellation.federationConfigure', { enabled: $('federation-enabled').checked, agentIds, missionIds, expectedRevision: revision });
      revision = Configs.findOne('current')?.revision ?? revision + 1;
      host.toast('Shared access saved.');
    });
  });
  $('federation-generate').addEventListener('click', (event) => void busyAction(event.currentTarget, $('federation-errors'), 'Creating…', async () => {
    const result = await Meteor.callAsync('constellation.federationRotateToken');
    secret = result.token; $('federation-token').value = secret; $('federation-secret').hidden = false;
    $('federation-token-hint').textContent = `Ending ${result.tokenHint}`;
    revision = Configs.findOne('current')?.revision ?? revision;
    $('federation-revoke').disabled = false;
    $('federation-token').focus();
  }));
  $('federation-revoke').addEventListener('click', (event) => void busyAction(event.currentTarget, $('federation-errors'), 'Revoking…', async () => {
    await Meteor.callAsync('constellation.federationRevoke');
    secret = ''; $('federation-secret').hidden = true; $('federation-token').value = '';
    config = Configs.findOne('current'); renderConfig(); host.toast('Access revoked.');
  }));
  $('federation-copy-endpoint').addEventListener('click', (event) => void busyAction(event.currentTarget, $('federation-errors'), 'Copying…', async () => { await navigator.clipboard.writeText($('federation-endpoint').value); host.toast('Endpoint copied.'); }));
  $('federation-copy-token').addEventListener('click', (event) => void busyAction(event.currentTarget, $('federation-errors'), 'Copying…', async () => { if (secret) { await navigator.clipboard.writeText(secret); host.toast('Access token copied.'); } }));
  Tracker.autorun(() => {
    config = Configs.findOne('current');
    if (dialog.open) {
      $('federation-status').innerHTML = stateBadge(config?.enabled ? 'enabled' : 'disabled');
      // Keep the loaded edit revision: concurrent changes must fail closed.
    }
  });

  function contentText(result) {
    const blocks = result.contents ?? result.content ?? result.messages?.flatMap((message) => Array.isArray(message.content) ? message.content : [message.content]) ?? [];
    return blocks.map((block) => block?.text ?? (block?.blob ? `[${block.mimeType ?? 'Binary resource'}]` : '')).filter(Boolean).join('\n\n') || 'No text content returned.';
  }
  function preview(title, result) {
    const container = $('mcp-content-preview');
    container.innerHTML = `<section class="op-content-preview"><div class="op-section-heading"><h3>${esc(title)}</h3><button id="mcp-close-preview" class="op-link" type="button">Close preview</button></div><div class="op-result">${esc(contentText(result))}</div></section>`;
    $('mcp-close-preview').addEventListener('click', () => container.replaceChildren());
    container.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  }
  async function loadContent() {
    if (!selectedServerId) throw new Error('Select an MCP server first.');
    $('mcp-resource-list').innerHTML = '<div class="op-loading" role="status"><span></span>Loading resources…</div>';
    $('mcp-prompt-list').innerHTML = '<div class="op-loading" role="status"><span></span>Loading prompts…</div>';
    const results = await Promise.allSettled([
      Meteor.callAsync('constellation.mcpResources', { serverId: selectedServerId }),
      Meteor.callAsync('constellation.mcpPrompts', { serverId: selectedServerId }),
    ]);
    if (results[0].status === 'fulfilled') {
      resources = results[0].value.resources ?? results[0].value ?? [];
      $('mcp-resource-list').innerHTML = resources.length ? resources.map((row, index) => `<article class="op-resource-row"><div><strong>${esc(row.name ?? row.uri)}</strong><span>${esc(row.description ?? row.uri)}</span></div><button type="button" class="secondary-action" data-resource-index="${index}">Read resource</button></article>`).join('') : '<p class="op-hint">This server has no resources.</p>';
    } else $('mcp-resource-list').textContent = results[0].reason?.reason || results[0].reason?.message || 'Resources could not be loaded.';
    if (results[1].status === 'fulfilled') {
      prompts = results[1].value.prompts ?? results[1].value ?? [];
      $('mcp-prompt-list').innerHTML = prompts.length ? prompts.map((row, index) => `<details class="op-prompt"><summary><strong>${esc(row.name)}</strong><span>${esc(row.description)}</span></summary><form data-prompt-index="${index}">${(row.arguments ?? []).map((arg) => `<label>${esc(arg.name)}${arg.required ? '' : ' (optional)'}<input name="${esc(arg.name)}" ${arg.required ? 'required' : ''} maxlength="4000"><small>${esc(arg.description)}</small></label>`).join('')}<button type="submit" class="secondary-action">Preview prompt</button></form></details>`).join('') : '<p class="op-hint">This server has no prompts.</p>';
    } else $('mcp-prompt-list').textContent = results[1].reason?.reason || results[1].reason?.message || 'Prompts could not be loaded.';
    $('mcp-resource-list').querySelectorAll('[data-resource-index]').forEach((button) => button.addEventListener('click', () => void busyAction(button, $('mcp-content-errors'), 'Reading…', async () => {
      const resource = resources[Number(button.dataset.resourceIndex)];
      preview(resource.name ?? 'Resource', await Meteor.callAsync('constellation.mcpReadResource', { serverId: selectedServerId, uri: resource.uri }));
    })));
    $('mcp-prompt-list').querySelectorAll('form').forEach((form) => form.addEventListener('submit', (event) => {
      event.preventDefault(); void busyAction(event.submitter, $('mcp-content-errors'), 'Loading…', async () => {
        const prompt = prompts[Number(form.dataset.promptIndex)];
        preview(prompt.name, await Meteor.callAsync('constellation.mcpGetPrompt', { serverId: selectedServerId, name: prompt.name, args: Object.fromEntries(new FormData(form)) }));
      });
    }));
  }
  $('browse-mcp-content').addEventListener('click', () => {
    selectedServerId = host.selectedMcp(); $('mcp-content-preview').replaceChildren();
    $('mcp-content-server').textContent = $('mcp-detail-name').textContent;
    showDialog(contentDialog); void busyAction(null, $('mcp-content-errors'), 'Loading…', loadContent);
  });
  $('mcp-content-refresh').addEventListener('click', (event) => void busyAction(event.currentTarget, $('mcp-content-errors'), 'Refreshing…', loadContent));
}
