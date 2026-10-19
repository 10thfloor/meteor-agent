import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';
import { defineAgentChat } from 'meteor/10thfloor:agent';
import { parsePlanRunCommand, planReferenceHandles } from '../imports/constellation/plan-references';

// Exercise the real composer and host integration against local read models.
// Fixture transport never saves a plan, launches an agent, or changes memory.
if (Meteor.isClient) describe('Constellation plans in chat', function () {
  this.timeout(20_000);
  const waitUntil = async (condition, message) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() >= deadline) assert.fail(message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const part = (chat, name) => chat.shadowRoot.querySelector('[part~="' + name + '"]');
  const reactiveCell = (initial) => {
    const dependency = new Tracker.Dependency();
    let value = initial;
    return {
      get() { dependency.depend(); return value; },
      set(next) { if (next !== value) { value = next; dependency.changed(); } },
    };
  };
  const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
  };
  let initializePlanChat;
  let initializeChatFileUpload;
  let initializeMissionRecipients;
  let fixture;
  let originalCall;

  before(async () => {
    await waitUntil(() => Meteor.userId()
      && document.getElementById('app-frame')?.dataset.startupState === 'ready',
    'the app did not become ready for isolated chat fixtures');
    ({ initializePlanChat } = await import('../client/plan-chat.js'));
    ({ initializeChatFileUpload } = await import('../client/chat-file-upload.js'));
    ({ initializeMissionRecipients } = await import('../client/mission-recipients.js'));
    defineAgentChat('agent-chat');
  });

  beforeEach(() => {
    const id = 'chat-plan-fixture-' + Random.id();
    const mount = document.createElement('section');
    mount.style.cssText = 'position:fixed;inset:30px;z-index:100000;background:var(--ink,#121612);';
    const chat = document.createElement('agent-chat');
    chat.setAttribute('agent', id);
    chat.setAttribute('session-id', id);
    chat.setAttribute('multiline', '');
    chat.setAttribute('composer-layout', 'panel');
    mount.append(chat);
    document.body.append(mount);
    fixture = {
      id, mount, chat, current: reactiveCell(id),
      configs: new Mongo.Collection(null), definitions: new Mongo.Collection(null), runs: new Mongo.Collection(null),
      calls: [], openedPlans: [], openedChildren: [], toasts: [], plans: [],
      request: async () => ({ kind: 'message' }),
      catalog: async () => ({ plans: fixture.plans }),
      preview: async ({ missionId }) => ({
        definition: {
          ...(fixture.plans.find((plan) => plan.missionId === missionId) ?? {}),
          steps: [
            { id: 'prepare', label: 'Prepare the release notes', primitive: 'agent', agent: 'researcher' },
            { id: 'review', label: 'Review the evidence', primitive: 'agent', agent: 'reviewer' },
          ],
        },
        eligibleAgents: [{ id: 'researcher', name: 'Researcher' }, { id: 'reviewer', name: 'Reviewer' }],
      }),
    };
    fixture.configs.insert({ _id: id, title: 'Fixture mission', status: 'active' });
    originalCall = Meteor.callAsync;
    Meteor.callAsync = function planChatTransport(method, ...args) {
      const input = args[0];
      const ours = typeof input === 'object' && input !== null
        && (String(input.missionId ?? '').startsWith(fixture.id) || String(input.runId ?? '').startsWith(fixture.id));
      if (method === 'constellation.workflowPlans' && ours) {
        fixture.calls.push({ method, args });
        return Promise.resolve().then(() => fixture.catalog(input));
      }
      if (method === 'constellation.workflowGet' && ours) {
        fixture.calls.push({ method, args });
        return Promise.resolve().then(() => fixture.preview(input));
      }
      if (method === 'constellation.workflowChatSend' && ours) {
        fixture.calls.push({ method, args });
        return Promise.resolve().then(() => fixture.request(method, input));
      }
      if (['agent.send', 'agent.contribute'].includes(method) && input === fixture.id) {
        fixture.calls.push({ method, args });
        return Promise.resolve('fixture-message-' + Random.id());
      }
      return originalCall.call(this, method, ...args);
    };
  });

  afterEach(async () => {
    try {
      fixture?.files?.dispose?.();
      fixture?.integration?.dispose?.();
      fixture?.recipients?.dispose?.();
      fixture?.mount.remove();
      await nextFrame();
      Tracker.flush();
    } finally {
      Meteor.callAsync = originalCall;
      fixture = undefined;
    }
  });

  function initialize(options = {}) {
    fixture.integration = initializePlanChat({
      subscribe: false,
      chat: fixture.chat,
      currentMission: () => fixture.current.get(),
      missionConfig: (id = fixture.current.get()) => fixture.configs.findOne(id),
      definitions: fixture.definitions,
      runs: fixture.runs,
      openPlan: (...args) => fixture.openedPlans.push(args),
      openChild: (...args) => fixture.openedChildren.push(args),
      toast: (...args) => fixture.toasts.push(args),
      ...options,
    });
    fixture.button = fixture.integration.button;
    fixture.picker = fixture.integration.picker;
    fixture.context = fixture.integration.context;
    Tracker.flush();
    return fixture.integration;
  }

  function initializeFiles() {
    fixture.uploads = [];
    fixture.files = initializeChatFileUpload({
      chat: fixture.chat,
      snapshot: () => ({
        missionId: fixture.current.get(), userId: 'chat-plan-file-fixture-owner', active: true, connected: true,
        environment: { keepFiles: true, workspaceId: fixture.id + '-sprite', status: 'ready' },
        settings: { providerConfigured: true, connectionStatus: 'connected', limits: { maxArtifactBytes: 5_000_000 } },
      }),
      upload: async (payload) => {
        fixture.uploads.push(payload);
        return { status: 'completed', path: '/workspace/uploads/' + payload.name, name: payload.name,
          size: atob(payload.content).length, contentType: payload.contentType };
      },
      openFiles: () => assert.fail('Sharing a file should not navigate away from the chat'),
      toast: (...args) => fixture.toasts.push(args),
    });
    Tracker.flush();
    return fixture.files;
  }

  async function attachFile(name = 'source #literal `draft`.txt') {
    await fixture.files.selectFiles([new File(['Fixture evidence'], name, { type: 'text/plain' })]);
    Tracker.flush();
    await waitUntil(() => fixture.chat.querySelector('[data-chat-file-id][data-state="ready"]'),
      'uploaded fixture file did not become ready');
    return '/workspace/uploads/' + name;
  }

  const savedPlan = (overrides = {}) => ({
    handle: 'review-plan', missionId: fixture.id, revision: 3, name: 'Review the release',
    missionTitle: 'Fixture mission', status: 'active', stepCount: 2, ...overrides,
  });
  const mutations = () => fixture.calls.filter(({ method }) => !['constellation.workflowPlans', 'constellation.workflowGet'].includes(method));
  const pickerRows = () => [...fixture.picker.querySelectorAll('[data-select-plan]')];
  const draft = () => part(fixture.chat, 'input');
  const pickerOpen = () => fixture.picker.matches(':popover-open');
  const chips = () => [...fixture.context.querySelectorAll('[data-plan-attachment]')];
  const attachment = (handle) => fixture.context.querySelector('[data-plan-attachment="' + handle + '"]');
  const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  async function openPicker() {
    fixture.button.click();
    await waitUntil(() => pickerOpen()
      && fixture.picker.querySelector('#chat-plan-list').getAttribute('aria-busy') === 'false',
    'the saved plan picker did not finish loading');
  }
  async function selectPlan(handle = 'review-plan') {
    await openPicker();
    const choice = fixture.picker.querySelector('[data-select-plan="' + handle + '"]');
    assert.ok(choice, 'the saved plan should be selectable');
    choice.click();
    await waitUntil(() => !pickerOpen() && attachment(handle), 'choosing a plan did not attach it');
    await nextFrame();
  }
  async function openPreview(handle = 'review-plan') {
    const chip = attachment(handle);
    assert.ok(chip, 'preview must be opened from a selected attachment');
    chip.querySelector('[data-plan-preview]').click();
    await waitUntil(() => fixture.picker.querySelector('.plan-preview-steps'), 'the selected plan preview did not load');
    return fixture.picker.querySelector('[data-plan-run]');
  }
  async function submit(text, mode = 'ask') {
    fixture.chat.composerMode = mode;
    const chat = fixture.chat;
    const outcome = new Promise((resolve) => {
      const complete = (event) => {
        chat.removeEventListener('agent-chat:submitted', complete);
        chat.removeEventListener('agent-chat:error', complete);
        resolve(event.type);
      };
      chat.addEventListener('agent-chat:submitted', complete);
      chat.addEventListener('agent-chat:error', complete);
    });
    chat.setDraft(text, { focus: true });
    part(chat, 'send').click();
    const result = await outcome;
    await waitUntil(() => part(chat, 'composer').getAttribute('aria-busy') !== 'true',
      'composer did not finish its fixture submission');
    return result;
  }

  it('opens from the shared Add control without a second toolbar button and restores focus', async () => {
    fixture.plans = [savedPlan()];
    initialize({ externalTrigger: true });
    assert.isNull(fixture.chat.querySelector('#chat-add-plan'));
    const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add';
    add.slot = 'composer-toolbar'; fixture.chat.append(add);
    add.focus(); fixture.integration.openBrowse(add);
    await waitUntil(() => pickerRows().length === 1, 'the externally opened plan picker did not load');
    press(fixture.picker, 'Escape');
    await waitUntil(() => document.activeElement === add, 'Escape should restore focus to Add');
    fixture.integration.openBrowse(add);
    await waitUntil(() => pickerRows().length === 1, 'the plan picker did not reopen');
    pickerRows()[0].click();
    await nextFrame();
    assert.ok(attachment('review-plan'));
    assert.equal(fixture.chat.shadowRoot.activeElement, draft(), 'attaching returns to writing');
    assert.isEmpty(mutations(), 'browsing and attaching do not execute a plan');
  });

  it('attaches a named plan without changing or sending the draft, and allows removing it', async () => {
    fixture.plans = [savedPlan(), savedPlan({ handle: 'design-review', name: 'Design review',
      missionId: fixture.id + '-design', missionTitle: 'Design mission', revision: 7 })];
    initialize();
    assert.equal(fixture.button.textContent.trim(), 'Plans');
    assert.equal(fixture.button.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(fixture.picker.tagName, 'DIV', 'plan discovery should not open a modal dialog');
    assert.equal(fixture.picker.getAttribute('popover'), 'auto');
    assert.equal(fixture.context.slot, 'composer-context');
    fixture.chat.setDraft('Compare these before launch', { selectionStart: 8, selectionEnd: 13, focus: true });
    await openPicker();
    const search = fixture.picker.querySelector('#chat-plan-search');
    search.value = 'design';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    assert.lengthOf(pickerRows(), 1);
    assert.include(pickerRows()[0].textContent, 'Design review');
    pickerRows()[0].click();
    await waitUntil(() => attachment('design-review'), 'the readable plan attachment did not appear');
    await nextFrame();
    assert.isFalse(pickerOpen());
    assert.equal(fixture.chat.draftText, 'Compare these before launch');
    assert.include(attachment('design-review').textContent, 'Design review');
    assert.notInclude(draft().value, '#design-review', 'protocol handles should not replace the message draft');
    assert.equal(fixture.chat.shadowRoot.activeElement, draft());
    assert.isEmpty(mutations(), 'selecting context must never start work');
    const remove = attachment('design-review').querySelector('[data-plan-remove]');
    assert.match(remove.getAttribute('aria-label'), /remove.*design review/i);
    remove.click();
    assert.isEmpty(chips());
    assert.equal(fixture.chat.draftText, 'Compare these before launch');
    assert.isEmpty(mutations());
  });

  it('uses the same picker for # and removes only the active token when attaching a plan', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    await fixture.integration.refresh();
    const text = 'Compare #rev before launch';
    draft().value = text;
    draft().focus();
    draft().setSelectionRange('Compare #rev'.length, 'Compare #rev'.length);
    draft().dispatchEvent(new Event('input', { bubbles: true }));
    await waitUntil(pickerOpen, '# did not open the plan picker');
    assert.equal(fixture.picker.querySelector('#chat-plan-search').value, 'rev');
    assert.isTrue(part(fixture.chat, 'typeahead').hidden, 'do not show a second plan selector inside the composer');
    fixture.picker.querySelector('[data-select-plan="review-plan"]').click();
    await waitUntil(() => attachment('review-plan') && !pickerOpen(), 'the plan token did not become an attachment');
    assert.equal(fixture.chat.draftText, 'Compare  before launch');
    assert.isEmpty(mutations());
  });

  it('supports keyboard discovery and returns focus to the unchanged draft after dismissal', async () => {
    fixture.plans = [savedPlan(), savedPlan({ handle: 'second-plan', name: 'Second plan', missionId: fixture.id + '-second' })];
    initialize();
    fixture.chat.setDraft('Keep this unfinished thought.', { selectionStart: 5, selectionEnd: 5, focus: true });
    await openPicker();
    const search = fixture.picker.querySelector('#chat-plan-search');
    assert.strictEqual(document.activeElement, search);
    press(search, 'ArrowDown');
    assert.strictEqual(document.activeElement, pickerRows()[0]);
    press(document.activeElement, 'End');
    assert.strictEqual(document.activeElement, pickerRows().at(-1));
    press(document.activeElement, 'Home');
    assert.strictEqual(document.activeElement, pickerRows()[0]);
    press(document.activeElement, 'Escape');
    await waitUntil(() => fixture.chat.shadowRoot.activeElement === draft(), 'dismissal did not return composer focus');
    assert.equal(fixture.chat.draftText, 'Keep this unfinished thought.');
    assert.isEmpty(chips());
    assert.isEmpty(mutations());
  });

  it('preserves the focused Select or Preview action when the plan catalog refreshes', async () => {
    fixture.plans = [savedPlan(), savedPlan({ handle: 'second-plan', name: 'Second plan', missionId: fixture.id + '-second' })];
    initialize();
    fixture.chat.setDraft('Keep my place in this draft.');
    await openPicker();
    const search = fixture.picker.querySelector('#chat-plan-search');
    const list = fixture.picker.querySelector('#chat-plan-list');
    for (const action of ['data-select-plan', 'data-preview-plan']) {
      const selector = '[' + action + '="second-plan"]';
      const previous = fixture.picker.querySelector(selector);
      previous.focus();
      assert.strictEqual(document.activeElement, previous);
      const pending = deferred();
      fixture.catalog = () => pending.promise;
      const refresh = fixture.integration.refresh();
      assert.equal(list.getAttribute('aria-busy'), 'true');
      assert.strictEqual(document.activeElement, search, 'loading should retain focus inside the chooser');
      pending.resolve({ plans: fixture.plans });
      await refresh;
      const replacement = fixture.picker.querySelector(selector);
      assert.ok(replacement);
      assert.notStrictEqual(replacement, previous, 'the fixture must exercise a replaced catalog row');
      assert.strictEqual(document.activeElement, replacement, 'refresh should restore the same plan action');
      assert.equal(fixture.chat.draftText, 'Keep my place in this draft.');
    }
    assert.isEmpty(chips(), 'restoring keyboard focus must not select or execute a plan');
    assert.isEmpty(mutations());
  });

  it('shows loading and recoverable catalog error and empty states without losing the draft', async () => {
    const pending = deferred();
    fixture.catalog = () => pending.promise;
    initialize();
    fixture.chat.setDraft('Keep this unsent note.');
    fixture.button.click();
    const list = fixture.picker.querySelector('#chat-plan-list');
    assert.equal(list.getAttribute('aria-busy'), 'true');
    assert.match(list.textContent, /loading plans/i);
    assert.ok(list.querySelector('[role="status"]'));
    pending.reject(new Error('The plan list is offline.'));
    await waitUntil(() => list.querySelector('[role="alert"]'), 'catalog failure was not visible');
    assert.include(list.textContent, 'The plan list is offline.');
    fixture.catalog = async () => ({ plans: [] });
    list.querySelector('[data-plan-retry]').click();
    await waitUntil(() => list.querySelector('[data-plan-create]'), 'empty catalog did not offer the plan editor');
    assert.match(list.textContent, /no saved plans/i);
    list.querySelector('[data-plan-create]').click();
    assert.deepEqual(fixture.openedPlans[0].slice(0, 3), [fixture.id, 'plan', null]);
    assert.equal(fixture.chat.draftText, 'Keep this unsent note.');
    assert.isEmpty(mutations());
  });

  it('previews the pinned plan with loading feedback and assignments before any execution', async () => {
    const pending = deferred();
    fixture.plans = [savedPlan()];
    const ready = await fixture.preview({ missionId: fixture.id });
    fixture.preview = () => pending.promise;
    initialize();
    await selectPlan();
    attachment('review-plan').querySelector('[data-plan-preview]').click();
    await waitUntil(() => fixture.picker.querySelector('.plan-preview-status'), 'the preview did not show its loading state');
    assert.match(fixture.picker.querySelector('.plan-preview-status').textContent, /loading/i);
    assert.isTrue(!fixture.picker.querySelector('[data-plan-run]') || fixture.picker.querySelector('[data-plan-run]').disabled,
      'a preview that has not loaded cannot execute');
    pending.resolve(ready);
    await waitUntil(() => fixture.picker.querySelector('.plan-preview-steps'), 'the plan steps did not load');
    const steps = fixture.picker.querySelector('.plan-preview-steps');
    assert.include(steps.textContent, 'Prepare the release notes');
    assert.include(steps.textContent, 'Review the evidence');
    assert.match(steps.textContent, /researcher/i);
    assert.match(steps.textContent, /reviewer/i);
    fixture.picker.querySelector('[data-plan-open]').click();
    assert.deepEqual(fixture.openedPlans[0].slice(0, 3), [fixture.id, 'plan', null]);
    assert.isEmpty(mutations(), 'reading a preview or opening the plan must not execute it');
  });

  it('shows a failed preview without allowing a run against unreadable plan data', async () => {
    fixture.plans = [savedPlan()];
    fixture.preview = async () => { throw new Error('This plan cannot be loaded.'); };
    initialize();
    await selectPlan();
    attachment('review-plan').querySelector('[data-plan-preview]').click();
    await waitUntil(() => /This plan cannot be loaded/.test(fixture.picker.textContent), 'preview failure was hidden');
    const run = fixture.picker.querySelector('[data-plan-run]');
    assert.isTrue(!run || run.disabled);
    assert.ok(attachment('review-plan'), 'preview failure must not discard selected context');
    assert.isEmpty(mutations());
  });

  it('visibly disables preview actions while the composer is busy or unavailable and restores them afterward', async () => {
    const pending = deferred();
    fixture.plans = [savedPlan()];
    fixture.request = () => pending.promise;
    initialize();
    await selectPlan();
    const run = await openPreview();
    const attach = fixture.picker.querySelector('[data-plan-attach]');
    assert.isFalse(run.disabled);
    assert.isFalse(attach.disabled);
    fixture.chat.setDraft('Discuss the selected plan.');
    const sending = fixture.chat.submitDraft();
    await waitUntil(() => run.disabled && attach.disabled, 'visible preview actions did not reflect the pending message');
    assert.isTrue(pickerOpen(), 'the visible preview should remain available to read');
    assert.strictEqual(fixture.picker.querySelector('[data-plan-run]'), run,
      'a busy-state update should not replace the focused preview controls');
    run.click();
    attach.click();
    assert.lengthOf(mutations(), 1, 'disabled preview controls must not launch additional work');
    pending.resolve({ kind: 'message' });
    await sending;
    await waitUntil(() => !run.disabled && !attach.disabled, 'preview actions did not recover when the message finished');
    fixture.chat.setAttribute('aria-disabled', 'true');
    await waitUntil(() => run.disabled && attach.disabled, 'preview actions did not reflect the unavailable composer');
    run.click();
    attach.click();
    assert.lengthOf(mutations(), 1);
    fixture.chat.removeAttribute('aria-disabled');
    await waitUntil(() => !run.disabled && !attach.disabled, 'preview actions did not recover with the composer');
  });

  it('runs explicitly from the preview while preserving the unfinished draft and unrelated attachments', async () => {
    const pending = deferred();
    fixture.plans = [savedPlan(), savedPlan({ handle: 'other-plan', name: 'Other plan', missionId: fixture.id + '-other' })];
    fixture.request = () => pending.promise;
    initialize();
    fixture.chat.recipient = 'm:researcher';
    fixture.chat.setDraft('Before publishing, ask me about the audience.');
    await selectPlan('other-plan');
    await selectPlan();
    const run = await openPreview();
    assert.include(fixture.picker.querySelector('#chat-plan-run-routing').textContent, 'not the chat recipient');
    assert.isFalse(run.disabled);
    run.click();
    await waitUntil(() => mutations().length === 1, 'explicit Run did not submit a command');
    assert.equal(mutations()[0].method, 'constellation.workflowChatSend');
    assert.deepInclude(mutations()[0].args[0], { missionId: fixture.id, text: 'Run #review-plan', mode: 'agent' });
    assert.deepEqual(mutations()[0].args[0].references, [{ handle: 'review-plan', missionId: fixture.id, revision: 3 }]);
    assert.notProperty(mutations()[0].args[0], 'recipient', 'a plan uses its own saved step agents');
    assert.equal(fixture.chat.draftText, 'Before publishing, ask me about the audience.');
    assert.isTrue(fixture.picker.querySelector('[data-plan-run]').disabled, 'a pending run must not accept a duplicate click');
    fixture.picker.querySelector('[data-plan-run]').click();
    assert.lengthOf(mutations(), 1);
    pending.resolve({ kind: 'run', runId: fixture.id + '-run' });
    await waitUntil(() => !attachment('review-plan'), 'successful explicit run did not clear its attachment');
    assert.ok(attachment('other-plan'), 'running one plan must not discard other context');
    assert.equal(fixture.chat.draftText, 'Before publishing, ask me about the audience.');
  });

  it('treats attached plans as context on Send, including empty drafts and a draft containing only Run', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    for (const text of ['What should change?', 'Run', '']) {
      await selectPlan();
      assert.equal(await submit(text), 'agent-chat:submitted');
      const sent = mutations().at(-1);
      assert.equal(sent.method, 'constellation.workflowChatSend');
      assert.equal(sent.args[0].mode, 'agent');
      assert.equal(sent.args[0].text, text ? text + '\n\nPlan context: #review-plan' : 'Plan context: #review-plan');
      assert.isNull(parsePlanRunCommand(sent.args[0].text), 'attaching context must not create an execution command');
      assert.deepEqual(sent.args[0].references, [{ handle: 'review-plan', missionId: fixture.id, revision: 3 }]);
    }
    await selectPlan();
    await submit('Run #review-plan', 'note');
    assert.equal(mutations().at(-1).args[0].mode, 'note', 'crew notes must never start a plan');
  });

  it('keeps ordinary messages and notes on their usual paths while honoring intentionally typed run commands', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    await fixture.integration.refresh();
    await submit('What should we review next?');
    assert.equal(mutations().at(-1).method, 'agent.send');
    await submit('The review is tomorrow.', 'note');
    assert.equal(mutations().at(-1).method, 'agent.contribute');
    await submit("Run this mission's plan when QA approves.");
    assert.equal(mutations().at(-1).method, 'agent.send');
    await submit("Run this mission's plan.");
    assert.equal(mutations().at(-1).method, 'constellation.workflowChatSend');
    await submit('Run #review-plan');
    assert.deepInclude(mutations().at(-1).args[0], { text: 'Run #review-plan', mode: 'agent' });
  });

  it('preserves the selected recipient on ordinary sends and never routes crew notes', async () => {
    initialize(); fixture.chat.recipient = 'm:researcher';
    await submit('Please review the release.');
    assert.equal(mutations().at(-1).method, 'agent.send');
    assert.deepEqual(mutations().at(-1).args[4], { to: 'm:researcher' });
    await submit('The release is tomorrow.', 'note');
    assert.equal(mutations().at(-1).method, 'agent.contribute');
    assert.isUndefined(mutations().at(-1).args[4]);
  });

  it('forwards recipient to an existing submission handler without waking note recipients', async () => {
    const delivered = [];
    fixture.chat.submissionHandler = async (submission) => { delivered.push(submission); };
    initialize(); fixture.chat.recipient = 'm:researcher';
    await submit('Review this.');
    assert.deepInclude(delivered[0], { sessionId: fixture.id, text: 'Review this.', mode: 'ask', recipient: 'm:researcher' });
    await submit('A crew note.', 'note');
    assert.notProperty(delivered[1], 'recipient'); assert.isEmpty(mutations());
  });

  it('routes attached plan context and changes retry identity when the recipient changes', async () => {
    fixture.plans = [savedPlan()]; initialize(); await selectPlan();
    fixture.chat.recipient = 'm:researcher';
    fixture.request = async () => { throw new Error('Connection interrupted.'); };
    await submit('Review this plan.'); const first = mutations().at(-1).args[0];
    assert.equal(first.recipient, 'm:researcher');
    await submit('Review this plan.'); assert.equal(mutations().at(-1).args[0].requestKey, first.requestKey);
    fixture.chat.recipient = 'm:reviewer';
    await submit('Review this plan.'); const changed = mutations().at(-1).args[0];
    assert.equal(changed.recipient, 'm:reviewer'); assert.notEqual(changed.requestKey, first.requestKey);
    assert.equal(changed.text, first.text); assert.deepEqual(changed.references, first.references);
    fixture.request = async () => ({ kind: 'note' });
    await submit('Discuss #review-plan later.', 'note');
    assert.notProperty(mutations().at(-1).args[0], 'recipient');
  });

  it('shares selected plan and uploaded-file context together with the explicit chat recipient', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    initializeFiles(); // Files wrap the plan handler, as in the real app.
    await selectPlan();
    const path = await attachFile();
    fixture.recipients = initializeMissionRecipients({ chat: fixture.chat,
      storage: { getItem: () => null, setItem: () => {} },
    });
    fixture.recipients.update({ session: { _id: fixture.id, agent: 'orchestrator', participants: [
      { id: 'm:orchestrator', kind: 'model', agent: 'orchestrator', displayName: 'Atlas' },
      { id: 'm:operator', kind: 'model', agent: 'operator', displayName: 'Relay' },
    ] }, primary: { label: 'Atlas' }, userId: 'plan-routing-fixture', mode: 'ask', writable: true, status: 'active' });
    assert.isTrue(fixture.recipients.choose('operator', { focus: false }));
    assert.equal(fixture.chat.recipient, 'm:operator');
    assert.equal(fixture.chat.getAttribute('submit-label'), 'Send');
    assert.equal(await submit('Review the plan against this file.'), 'agent-chat:submitted');
    Tracker.flush();
    const requests = mutations();
    assert.lengthOf(requests, 1, 'one message must carry both contexts');
    assert.equal(requests[0].method, 'constellation.workflowChatSend');
    const sent = requests[0].args[0];
    assert.equal(sent.recipient, 'm:operator');
    assert.equal(sent.mode, 'agent');
    assert.include(sent.text, 'Plan context: #review-plan');
    assert.include(sent.text, path, 'the literal Sprite path is preserved, including # and backticks');
    assert.deepEqual(planReferenceHandles(sent.text), ['review-plan'], 'filename fragments are never extra plans');
    assert.deepEqual(sent.references, [{ handle: 'review-plan', missionId: fixture.id, revision: 3 }]);
    assert.lengthOf(fixture.uploads, 1);
    assert.isEmpty(chips());
    assert.isNull(fixture.chat.querySelector('[data-chat-file-id]'));
    assert.isFalse(fixture.chat.allowEmptySubmit, 'both context contributions clear after success');
  });

  it('preserves plan and file context on a failed send and shares them as a non-waking crew note', async () => {
    fixture.plans = [savedPlan()];
    initialize(); initializeFiles(); await selectPlan();
    const path = await attachFile('reference #not-a-plan.txt');
    fixture.chat.recipient = 'm:operator';
    fixture.request = async () => { throw new Error('Connection interrupted.'); };
    const text = 'Review this evidence against the plan.';
    assert.equal(await submit(text), 'agent-chat:error');
    assert.equal(fixture.chat.draftText, text, 'failed submission restores only the user-authored draft');
    assert.lengthOf(chips(), 1);
    assert.exists(fixture.chat.querySelector('[data-chat-file-id][data-state="ready"]'));
    assert.isTrue(fixture.chat.allowEmptySubmit);
    assert.equal(mutations()[0].args[0].recipient, 'm:operator');
    fixture.request = async () => ({ kind: 'note' });
    assert.equal(await submit('Shared context for later.', 'note'), 'agent-chat:submitted');
    Tracker.flush();
    const sent = mutations().at(-1).args[0];
    assert.equal(sent.mode, 'note');
    assert.notProperty(sent, 'recipient', 'a file-bearing note must not wake the previously selected agent');
    assert.include(sent.text, path);
    assert.deepEqual(planReferenceHandles(sent.text), ['review-plan']);
    assert.lengthOf(fixture.uploads, 1, 'retrying a message must not reupload its Sprite file');
    assert.isEmpty(chips());
    assert.isNull(fixture.chat.querySelector('[data-chat-file-id]'));
    assert.isFalse(fixture.chat.allowEmptySubmit);
  });

  it('does not apply a selected chat recipient to an explicitly typed plan launch', async () => {
    fixture.plans = [savedPlan()]; initialize(); await fixture.integration.refresh();
    fixture.chat.recipient = 'm:researcher';
    await submit('Run #review-plan');
    assert.equal(mutations().at(-1).method, 'constellation.workflowChatSend');
    assert.notProperty(mutations().at(-1).args[0], 'recipient');
  });

  it('retains a failed command and its request identity when the unchanged send is retried', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    await fixture.integration.refresh();
    const text = 'Run #review-plan';
    fixture.request = async () => { throw new Error('Connection interrupted. Try again.'); };
    assert.equal(await submit(text), 'agent-chat:error');
    assert.equal(fixture.chat.draftText, text);
    const first = mutations().at(-1).args[0];
    assert.deepEqual(first.references, [{ handle: 'review-plan', missionId: fixture.id, revision: 3 }]);
    assert.isString(first.requestKey);
    fixture.request = async () => ({ kind: 'run', runId: fixture.id + '-run' });
    assert.equal(await submit(text), 'agent-chat:submitted');
    const retried = mutations().at(-1).args[0];
    assert.equal(retried.requestKey, first.requestKey, 'a lost reply must not create a second run');
    assert.deepEqual(retried.references, first.references);
  });

  it('holds the selected version after a stale rejection until the person deliberately selects a newer one', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    await selectPlan();
    fixture.plans = [savedPlan({ revision: 4 })];
    await fixture.integration.refresh();
    fixture.request = async () => { throw new Meteor.Error('workflow-conflict', 'Select the saved plan again.'); };
    await submit('Discuss this plan.');
    await submit('Discuss this plan.');
    assert.deepEqual(mutations().map(({ args }) => args[0].references[0].revision), [3, 3],
      'retrying must not silently select a version the person has not chosen');
    const previousKey = mutations().at(-1).args[0].requestKey;
    await selectPlan();
    fixture.request = async () => ({ kind: 'message' });
    await submit('Discuss this plan.');
    assert.equal(mutations().at(-1).args[0].references[0].revision, 4);
    assert.notEqual(mutations().at(-1).args[0].requestKey, previousKey, 'new context must have a new request identity');
  });

  it('replaces a failed request identity when a new saved version is deliberately attached', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    await selectPlan();
    fixture.request = async () => { throw new Error('Connection interrupted. Try again.'); };
    await submit('Discuss this plan.');
    const failed = mutations().at(-1).args[0];
    fixture.plans = [savedPlan({ revision: 4 })];
    await fixture.integration.refresh();
    await selectPlan();
    fixture.request = async () => ({ kind: 'message' });
    await submit('Discuss this plan.');
    const sent = mutations().at(-1).args[0];
    assert.deepEqual(sent.references, [{ handle: 'review-plan', missionId: fixture.id, revision: 4 }]);
    assert.notEqual(sent.requestKey, failed.requestKey,
      'a deliberate context change must not replay a previous request with its old references');
  });

  it('preserves the draft and pinned version when an explicit Run fails and is retried', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    fixture.chat.setDraft('A separate unfinished message.');
    await selectPlan();
    fixture.request = async () => { throw new Error('The connection was interrupted.'); };
    (await openPreview()).click();
    await waitUntil(() => fixture.picker.querySelector('[role="alert"]'), 'run failure did not remain visible in the preview');
    assert.equal(fixture.chat.draftText, 'A separate unfinished message.');
    assert.ok(attachment('review-plan'));
    const failed = mutations().at(-1).args[0];
    fixture.request = async () => ({ kind: 'run', runId: fixture.id + '-retried' });
    fixture.picker.querySelector('[data-plan-run]').click();
    await waitUntil(() => !attachment('review-plan'), 'the explicit run retry did not finish');
    assert.equal(mutations().at(-1).args[0].requestKey, failed.requestKey);
    assert.deepEqual(mutations().at(-1).args[0].references, failed.references);
    assert.equal(fixture.chat.draftText, 'A separate unfinished message.');
  });

  it('shows a stale preview and requires explicit use of the latest version before running', async () => {
    fixture.plans = [savedPlan()];
    initialize();
    await selectPlan();
    fixture.plans = [savedPlan({ revision: 4 })];
    await fixture.integration.refresh();
    attachment('review-plan').querySelector('[data-plan-preview]').click();
    await waitUntil(() => fixture.picker.querySelector('[data-plan-use-latest]'), 'stale preview did not offer an explicit version choice');
    assert.match(fixture.picker.querySelector('.plan-preview-status').textContent, /changed|newer|version|saved/i);
    const run = fixture.picker.querySelector('[data-plan-run]');
    assert.isTrue(!run || run.disabled);
    assert.isEmpty(mutations());
    fixture.picker.querySelector('[data-plan-use-latest]').click();
    await waitUntil(() => fixture.picker.querySelector('[data-plan-run]') && !fixture.picker.querySelector('[data-plan-run]').disabled,
      'explicitly selecting the latest version did not update the preview');
    fixture.request = async () => ({ kind: 'run', runId: fixture.id + '-fresh' });
    fixture.picker.querySelector('[data-plan-run]').click();
    await waitUntil(() => mutations().length === 1, 'the newly reviewed version did not run');
    assert.equal(mutations()[0].args[0].references[0].revision, 4);
  });

  it('discards a late catalog response and clears attachments when switching missions', async () => {
    const oldRequest = deferred();
    const nextId = fixture.id + '-next';
    fixture.plans = [savedPlan()];
    initialize();
    await selectPlan();
    fixture.catalog = ({ missionId }) => missionId === fixture.id ? oldRequest.promise
      : Promise.resolve({ plans: [savedPlan({ handle: 'next-plan', missionId: nextId, name: 'Next mission plan' })] });
    void fixture.integration.refresh();
    fixture.button.click();
    assert.isTrue(pickerOpen());
    fixture.configs.insert({ _id: nextId, title: 'Next mission', status: 'active' });
    fixture.current.set(nextId);
    fixture.chat.setAttribute('session-id', nextId);
    Tracker.flush();
    await waitUntil(() => fixture.chat.mentionSources['#'].lookup('next-plan'), 'the next mission catalog did not load');
    oldRequest.resolve({ plans: [savedPlan({ handle: 'old-plan' })] });
    await nextFrame();
    assert.isFalse(pickerOpen());
    assert.isEmpty(chips(), 'old mission attachments must not appear in the new conversation');
    assert.isNull(fixture.chat.mentionSources['#'].lookup('old-plan'));
    assert.ok(fixture.chat.mentionSources['#'].lookup('next-plan'));
    assert.isEmpty(mutations());
  });

  it('ignores an old mission send completion without clearing a new mission attachment or its pin', async () => {
    const oldSend = deferred();
    const nextId = fixture.id + '-next';
    fixture.plans = [savedPlan()];
    fixture.request = (_method, input) => input.missionId === fixture.id ? oldSend.promise
      : Promise.resolve({ kind: 'message' });
    initialize();
    await selectPlan();
    fixture.chat.setDraft('Discuss this plan.');
    part(fixture.chat, 'send').click();
    await waitUntil(() => fixture.button.disabled, 'Plans should be unavailable while the message is pending');
    fixture.configs.insert({ _id: nextId, title: 'Next mission', status: 'active' });
    fixture.plans = [savedPlan({ missionId: nextId, revision: 7 })];
    fixture.current.set(nextId);
    fixture.chat.setAttribute('session-id', nextId);
    Tracker.flush();
    await waitUntil(() => fixture.chat.sessionId === nextId && !fixture.button.disabled,
      'the new mission composer did not become ready');
    await selectPlan();
    fixture.plans = [savedPlan({ missionId: nextId, revision: 8 })];
    await fixture.integration.refresh();
    oldSend.resolve({ kind: 'run', runId: fixture.id + '-old' });
    await nextFrame();
    assert.ok(attachment('review-plan'), 'old completion must not discard the new selection');
    assert.isEmpty(fixture.toasts, 'an old mission completion must not announce a run in the new chat');
    await submit('Discuss this plan.');
    assert.deepEqual(mutations().at(-1).args[0].references,
      [{ handle: 'review-plan', missionId: nextId, revision: 7 }]);
  });

  it('scopes an explicit pending Run to its mission without unblocking or clearing a later run', async () => {
    const oldRun = deferred();
    const nextRun = deferred();
    const nextId = fixture.id + '-next';
    fixture.plans = [savedPlan()];
    fixture.request = (_method, input) => input.missionId === fixture.id ? oldRun.promise : nextRun.promise;
    initialize();
    await selectPlan();
    (await openPreview()).click();
    await waitUntil(() => mutations().length === 1, 'the first explicit run did not start');
    fixture.configs.insert({ _id: nextId, title: 'Next mission', status: 'active' });
    fixture.plans = [savedPlan({ missionId: nextId, revision: 7 })];
    fixture.current.set(nextId);
    fixture.chat.setAttribute('session-id', nextId);
    Tracker.flush();
    await waitUntil(() => !fixture.button.disabled, 'a pending old-mission run must not disable the new conversation');
    fixture.chat.setDraft('The new mission draft.');
    await selectPlan();
    (await openPreview()).click();
    await waitUntil(() => mutations().length === 2, 'the new mission could not start its own plan');
    oldRun.resolve({ kind: 'run', runId: fixture.id + '-old' });
    await nextFrame();
    assert.isTrue(fixture.picker.querySelector('[data-plan-run]').disabled,
      'an old completion must not re-enable a different pending run');
    assert.ok(attachment('review-plan'));
    assert.isEmpty(fixture.toasts);
    assert.equal(fixture.chat.draftText, 'The new mission draft.');
    nextRun.resolve({ kind: 'run', runId: fixture.id + '-new' });
    await waitUntil(() => !attachment('review-plan'), 'the new mission run did not finish');
    assert.lengthOf(fixture.toasts, 1);
    assert.equal(fixture.chat.draftText, 'The new mission draft.');
  });

  it('keeps the anchored plan picker clickable above overlapping composer controls and drawer chrome', async () => {
    fixture.chat.id = 'mission-chat';
    fixture.mount.style.cssText = 'position:fixed;left:30px;top:60px;width:min(680px,calc(100vw - 60px));height:420px;z-index:100000;';
    fixture.chat.style.height = '100%';
    const toolbar = document.createElement('div');
    toolbar.className = 'mission-recipient';
    toolbar.slot = 'composer-header';
    let coveredClicks = 0;
    const modeButton = document.createElement('button');
    modeButton.type = 'button';
    modeButton.textContent = 'Ask Atlas';
    modeButton.addEventListener('click', () => { coveredClicks += 1; });
    toolbar.append(modeButton);
    fixture.chat.append(toolbar);
    fixture.plans = [savedPlan()];
    initialize();
    await openPicker();
    await nextFrame();
    const choice = fixture.picker.querySelector('[data-select-plan="review-plan"]');
    const rect = choice.getBoundingClientRect();
    assert.isAbove(rect.width, 20);
    assert.isAbove(rect.height, 20);
    // Put real app toolbar/drawer surfaces under the same pixel. A native
    // popover must win even when ordinary application z-indexes are enormous.
    const underlayStyle = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top
      + 'px;width:' + rect.width + 'px;height:' + rect.height
      + 'px;margin:0;max-width:none;z-index:2147483647;background:rgb(240, 20, 20);';
    toolbar.style.cssText = underlayStyle;
    modeButton.style.cssText = 'width:100%;height:100%;';
    const drawer = document.createElement('aside');
    drawer.className = 'op-drawer';
    drawer.style.cssText = underlayStyle;
    drawer.addEventListener('click', () => { coveredClicks += 1; });
    fixture.mount.append(drawer);
    await nextFrame();
    const toolbarRect = toolbar.getBoundingClientRect();
    const drawerRect = drawer.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    assert.isAtLeast(x, toolbarRect.left);
    assert.isAtMost(x, toolbarRect.right);
    assert.isAtLeast(y, toolbarRect.top);
    assert.isAtMost(y, toolbarRect.bottom);
    assert.isAtLeast(y, drawerRect.top);
    assert.isAtMost(y, drawerRect.bottom);
    const hit = document.elementFromPoint(x, y);
    assert.isTrue(hit === choice || choice.contains(hit), 'the plan choice must win actual document hit testing');
    hit.click();
    await waitUntil(() => attachment('review-plan'), 'the visible plan choice could not be clicked');
    assert.equal(coveredClicks, 0);
    assert.isEmpty(mutations());
  });
});
