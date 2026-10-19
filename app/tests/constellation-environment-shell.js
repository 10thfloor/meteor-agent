import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';
import { AgentSessions } from 'meteor/10thfloor:agent';

if (Meteor.isClient) describe('Mission environment entry point', function () {
  this.timeout(15_000);
  const $ = (id) => document.getElementById(id);
  const waitUntil = async (predicate) => {
    const until = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > until) assert.fail('Mission environment entry point did not settle.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const closeDialog = async (dialog) => {
    if (!dialog?.open) return;
    const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    dialog.close(); await closed;
  };

  it('opens the edited mission’s environment without allocating and returns to its unsaved settings', async () => {
    await waitUntil(() => Meteor.userId() && $('app-frame')?.dataset.startupState === 'ready');
    document.querySelector('[data-view="missions"]').click();
    await waitUntil(() => $('mission-chat').getAttribute('session-id'));
    const missionId = $('mission-chat').getAttribute('session-id');
    const original = Meteor.callAsync;
    const calls = [];
    Meteor.callAsync = function (name, ...args) {
      if (name.startsWith('constellation.execution.')) {
        calls.push({ name, args });
        if (name === 'constellation.execution.getEnvironment') return Promise.resolve({ missionId,
          keepFiles: false, allowedAgents: [], retention: 'keep', status: 'not-created', savePoints: [] });
        return Promise.reject({ reason: 'This navigation test cannot start remote work.' });
      }
      return original.call(this, name, ...args);
    };
    try {
      $('configure-mission').click();
      await waitUntil(() => $('mission-dialog').open);
      const title = $('mission-config-title'); const savedTitle = title.value;
      title.value = `${savedTitle} draft`; title.dispatchEvent(new Event('input', { bubbles: true }));
      const opener = $('mission-environment-settings');
      opener.focus(); opener.click();
      const child = await (async () => {
        await waitUntil(() => document.querySelector('dialog.execution-environment-dialog[open]'));
        return document.querySelector('dialog.execution-environment-dialog[open]');
      })();
      await waitUntil(() => calls.length > 0);
      assert.deepEqual(calls, [{ name: 'constellation.execution.getEnvironment', args: [{ missionId }] }]);
      assert.isTrue($('mission-dialog').open);
      assert.equal(title.value, `${savedTitle} draft`);
      const closed = new Promise((resolve) => child.addEventListener('close', resolve, { once: true }));
      child.close(); await closed;
      assert.strictEqual(document.activeElement, opener);
      assert.isTrue($('mission-dialog').open);
      assert.equal(title.value, `${savedTitle} draft`);
      title.value = savedTitle; title.dispatchEvent(new Event('input', { bubbles: true }));
      Tracker.flush();
    } finally {
      Meteor.callAsync = original;
      for (const dialog of document.querySelectorAll('dialog.execution-environment-dialog[open]')) await closeDialog(dialog);
      await closeDialog($('mission-dialog'));
      await new Promise(requestAnimationFrame);
    }
  });

  it('returns from central code permissions to both captured mission and file-sharing drafts', async () => {
    await waitUntil(() => Meteor.userId() && $('app-frame')?.dataset.startupState === 'ready');
    document.querySelector('[data-view="missions"]').click();
    await waitUntil(() => $('mission-chat').getAttribute('session-id'));
    const missionId = $('mission-chat').getAttribute('session-id');
    const original = Meteor.callAsync; const calls = [];
    const field = (dialog, name) => dialog.querySelector(`[data-execution="${name}"]`);
    let savedTitle; let child;
    Meteor.callAsync = function (name, ...args) {
      if (name.startsWith('constellation.execution.')) {
        calls.push({ name, args });
        if (name === 'constellation.execution.getEnvironment') return Promise.resolve({ missionId: args[0].missionId,
          keepFiles: false, allowedAgents: [], retention: 'keep', status: 'not-created', savePoints: [] });
        return Promise.reject({ reason: 'This navigation test cannot start remote work or change permissions.' });
      }
      return original.call(this, name, ...args);
    };
    try {
      $('configure-mission').click();
      await waitUntil(() => $('mission-dialog').open);
      const title = $('mission-config-title'); savedTitle = title.value;
      const draftTitle = `${savedTitle} — unsaved navigation draft`;
      title.value = draftTitle; title.dispatchEvent(new Event('input', { bubbles: true }));
      assert.equal($('mission-form').dataset.dirty, 'true');
      const opener = $('mission-environment-settings'); opener.focus(); opener.click();
      await waitUntil(() => document.querySelector('dialog.execution-environment-dialog[open]'));
      child = document.querySelector('dialog.execution-environment-dialog[open]');
      await waitUntil(() => !field(child, 'env-settings-fields').disabled);
      const missionScope = child.querySelector('.op-dialog-scope').textContent;
      field(child, 'env-keep-files').checked = true;
      field(child, 'env-retention').value = 'delete-on-completion';
      const sharedAgent = field(child, 'env-agents').querySelector('input');
      assert.ok(sharedAgent, 'the selected mission has at least its coordinator');
      sharedAgent.checked = true;
      const agentId = sharedAgent.value;
      field(child, 'env-settings-form').dispatchEvent(new Event('change', { bubbles: true }));
      assert.isNull(field(child, 'env-agents').querySelector('button'), 'sharing has no duplicate permission editor');
      field(child, 'env-manage-permissions').focus(); field(child, 'env-manage-permissions').click();
      await waitUntil(() => !child.open && !$('mission-dialog').open && $('capability-tab-execution').getAttribute('aria-selected') === 'true');
      await new Promise(requestAnimationFrame);
      assert.equal($('workspace-shell').dataset.currentView, 'capabilities');
      assert.equal($('mission-chat').getAttribute('session-id'), missionId);
      assert.equal(title.value, draftTitle, 'suspending the parent does not reset its draft');
      assert.equal($('mission-form').dataset.dirty, 'true', 'suspending keeps the guarded editor baseline and dirty state');
      assert.isNull(document.querySelector('dialog.execution-dialog[open]'), 'permissions are edited in Code, not another dialog');
      const row = $('execution-panel').querySelector(`[data-agent="${CSS.escape(agentId)}"]`);
      const policy = field(row, 'policy');
      assert.ok(policy); assert.include(policy.getAttribute('aria-label'), 'all missions');
      await waitUntil(() => document.activeElement === policy);
      assert.isFalse(field($('execution-panel'), 'access-return').hidden);
      field($('execution-panel'), 'return-environment').click();
      await waitUntil(() => child.open && $('mission-dialog').open && !field(child, 'env-settings-fields').disabled);
      // Parent restoration includes focus/scroll work in the next animation
      // frame. Let that navigation settle before simulating a second close.
      await new Promise(requestAnimationFrame);
      assert.equal($('workspace-shell').dataset.currentView, 'missions');
      assert.equal($('mission-chat').getAttribute('session-id'), missionId);
      assert.equal(child.querySelector('.op-dialog-scope').textContent, missionScope);
      assert.equal(title.value, draftTitle);
      assert.equal($('mission-form').dataset.dirty, 'true', 'returning preserves the unsaved-change guard');
      assert.strictEqual(child._returnFocus, opener, 'restored child keeps the original Environment opener');
      assert.isTrue(field(child, 'env-keep-files').checked);
      assert.equal(field(child, 'env-retention').value, 'delete-on-completion');
      assert.deepEqual([...field(child, 'env-agents').querySelectorAll('input:checked')].map((input) => input.value), [agentId]);
      assert.deepEqual(calls, [
        { name: 'constellation.execution.getEnvironment', args: [{ missionId }] },
        { name: 'constellation.execution.getEnvironment', args: [{ missionId }] },
      ], 'navigation only reads the captured environment; it does not save, allocate, or grant access');
      const closed = new Promise((resolve) => child.addEventListener('close', resolve, { once: true }));
      child.close(); await closed;
      assert.isTrue($('mission-dialog').open);
      assert.strictEqual(document.activeElement, opener, `Closing restored environment focused ${document.activeElement?.outerHTML}`);
      assert.equal(title.value, draftTitle);
    } finally {
      Meteor.callAsync = original;
      await closeDialog(child);
      if (savedTitle !== undefined) {
        $('mission-config-title').value = savedTitle;
        $('mission-config-title').dispatchEvent(new Event('input', { bubbles: true }));
      }
      await closeDialog($('mission-dialog'));
      document.querySelector('[data-view="missions"]').click();
      Tracker.flush();
      await new Promise(requestAnimationFrame);
    }
  });
});

if (Meteor.isServer) describe('Mission execution lifecycle fence', function () {
  it('does not reactivate while code execution is still stopping', async () => {
    const app = await import('../server/main');
    const id = `environment-stop-${Random.id()}`; const userId = `environment-owner-${Random.id()}`;
    const original = app.constellationExecution.missionExecutionsQuiescent;
    let ready = false;
    try {
      await AgentSessions.insertAsync({ _id: id, userId, agent: 'orchestrator', phase: 'stopped', createdAt: new Date() });
      app.constellationExecution.missionExecutionsQuiescent = async (owner, mission) => {
        assert.equal(owner, userId); assert.equal(mission, id); return ready;
      };
      let error;
      try { await app.waitForMissionQuiescence(userId, id, { timeoutMs: 40, pollMs: 5 }); }
      catch (caught) { error = caught; }
      assert.equal(error?.error, 'mission-stopping');
      ready = true;
      assert.equal((await app.waitForMissionQuiescence(userId, id))._id, id);
    } finally {
      app.constellationExecution.missionExecutionsQuiescent = original;
      await AgentSessions.removeAsync(id);
    }
  });
});
