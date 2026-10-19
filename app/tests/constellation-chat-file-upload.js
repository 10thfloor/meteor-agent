import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';
import { defineAgentChat } from 'meteor/10thfloor:agent';
import { planReferenceHandles } from '../imports/constellation/plan-references';

if (Meteor.isClient) describe('Chat file uploads', function () {
  this.timeout(15_000);
  const tag = 'constellation-upload-test';
  let initialize; let chat; let mount; let ui; let state; let dependency;
  let uploads; let submissions; let opened; let toasts; let upload; let submit;
  let previousHandler;
  const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
  };
  const waitFor = async (condition, message = 'Upload state did not settle') => {
    const until = Date.now() + 8000;
    while (!condition()) {
      if (Date.now() >= until) assert.fail(message);
      await new Promise((resolve) => setTimeout(resolve, 10));
      Tracker.flush();
    }
  };
  const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); Tracker.flush(); };
  const refresh = (patch = {}) => { state = { ...state, ...patch }; dependency.changed(); Tracker.flush(); };
  const button = () => chat.querySelector('[data-chat-upload]');
  const context = () => chat.querySelector('[data-chat-files]');
  const cards = () => [...chat.querySelectorAll('[data-chat-file-id]')];
  const file = (name = 'report.txt', contents = 'hello\n', type = 'text/plain') => new File([contents], name, { type });
  const result = (payload, patch = {}) => ({ status: 'completed', path: `/workspace/uploads/${payload.name}`, name: payload.name,
    size: atob(payload.content).length, contentType: payload.contentType, ...patch });
  const send = async (text = 'Please review this.', mode = 'ask', recipient = 'm:operator') => {
    chat.composerMode = mode; chat.recipient = mode === 'note' ? undefined : recipient;
    chat.setDraft(text); await chat.submitDraft(); await tick();
  };

  before(async () => {
    defineAgentChat(tag);
    ({ initializeChatFileUpload: initialize } = await import('../client/chat-file-upload'));
  });
  beforeEach(() => {
    dependency = new Tracker.Dependency(); uploads = []; submissions = []; opened = []; toasts = [];
    const missionId = `upload-fixture-${Random.id()}`;
    state = { missionId, userId: 'upload-owner', active: true, connected: true,
      environment: { keepFiles: true, workspaceId: 'sprite1', status: 'ready' },
      settings: { providerConfigured: true, connectionStatus: 'connected', limits: { maxArtifactBytes: 5000000 } } };
    mount = document.createElement('section'); mount.style.cssText = 'width:720px;min-height:300px;';
    chat = document.createElement(tag); chat.setAttribute('agent', 'orchestrator'); chat.setAttribute('session-id', missionId);
    chat.setAttribute('multiline', ''); chat.setAttribute('composer-layout', 'panel');
    mount.append(chat); document.body.append(mount);
    chat.agentInstance.session = () => ({ _id: state.missionId, agent: 'orchestrator', phase: 'idle', participants: [] });
    chat.agentInstance.messages = () => ({ fetch: () => [] });
    chat.agentInstance.send = async () => { assert.fail('Fixture must use the existing submission handler.'); };
    chat.agentInstance.contribute = async () => { assert.fail('Fixture must use the existing submission handler.'); };
    upload = async (payload) => result(payload);
    submit = async () => 'saved-message';
    previousHandler = async (submission) => { submissions.push(submission); return submit(submission); };
    chat.submissionHandler = previousHandler;
    ui = initialize({ chat, snapshot: () => { dependency.depend(); return state; },
      upload: (payload) => { uploads.push(payload); return upload(payload); },
      openFiles: (...args) => opened.push(args), toast: (...args) => toasts.push(args) });
    Tracker.flush();
  });
  afterEach(() => { ui?.dispose(); mount?.remove(); Tracker.flush(); });

  it('uses a compact accessible toolbar button and inline context, not another dialog', () => {
    const control = button(); assert.exists(control); assert.isFalse(control.hidden); assert.isFalse(control.disabled);
    assert.equal(control.type, 'button'); assert.equal(control.slot, 'composer-toolbar');
    assert.match(control.getAttribute('aria-label') || control.title || control.textContent, /file|upload/i);
    assert.exists(control.querySelector('svg')); assert.isAtMost(control.textContent.trim().length, 30);
    assert.exists(chat.querySelector('input[type="file"]')); assert.isTrue(chat.querySelector('input[type="file"]').multiple);
    assert.equal(context().slot, 'composer-context'); assert.isTrue(context().hidden);
    assert.isNull(chat.querySelector('dialog')); assert.isEmpty(uploads); assert.isEmpty(submissions);
  });

  it('opens the real file input from the toolbar and uploads its change event in the captured mission', async () => {
    const picker = chat.querySelector('input[type="file"]');
    let pickerOpened = 0; picker.click = () => { pickerOpened += 1; };
    const missionId = state.missionId;
    chat.setDraft('Keep this draft'); button().click(); assert.equal(pickerOpened, 1);
    const selection = new DataTransfer(); selection.items.add(file('picked.txt'));
    picker.files = selection.files; assert.lengthOf(picker.files, 1); assert.isNotEmpty(picker.value);
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(picker.value, ''); assert.lengthOf(picker.files, 0);
    await waitFor(() => uploads.length === 1 && cards()[0]?.dataset.state === 'ready');
    assert.equal(uploads[0].missionId, missionId); assert.equal(uploads[0].name, 'picked.txt');
    assert.equal(chat.draftText, 'Keep this draft'); assert.isEmpty(submissions);
    // The change event cannot silently reuse the previous picker scope.
    const unsolicitedSelection = new DataTransfer(); unsolicitedSelection.items.add(file('not-deliberately-picked.txt'));
    picker.files = unsolicitedSelection.files; assert.lengthOf(picker.files, 1);
    picker.dispatchEvent(new Event('change', { bubbles: true })); await tick();
    assert.lengthOf(uploads, 1); assert.equal(picker.value, '');
  });

  it('does not redirect an open picker from its original mission to a newly selected mission', async () => {
    const picker = chat.querySelector('input[type="file"]');
    let pickerOpened = 0; picker.click = () => { pickerOpened += 1; };
    const origin = state.missionId; button().click(); assert.equal(pickerOpened, 1);
    refresh({ missionId: `${origin}-other` }); chat.setAttribute('session-id', state.missionId); await tick();
    const selection = new DataTransfer(); selection.items.add(file('picked-before-switch.txt'));
    picker.files = selection.files; assert.lengthOf(picker.files, 1);
    picker.dispatchEvent(new Event('change', { bubbles: true })); await tick();
    assert.isEmpty(uploads); assert.isEmpty(cards()); assert.isEmpty(submissions); assert.equal(picker.value, '');
    // Opening the picker again deliberately targets the currently selected mission.
    button().click(); assert.equal(pickerOpened, 2);
    // Use a new picker selection: resetting input.value may clear the FileList
    // shared with the preceding synthetic DataTransfer in Chromium.
    const nextSelection = new DataTransfer(); nextSelection.items.add(file('picked-after-switch.txt'));
    picker.files = nextSelection.files; assert.lengthOf(picker.files, 1);
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => uploads.length === 1 && cards()[0]?.dataset.state === 'ready');
    assert.equal(uploads[0].missionId, `${origin}-other`); assert.equal(uploads[0].name, 'picked-after-switch.txt');
    assert.isEmpty(submissions);
  });

  it('reacts to connection and mission permissions without requiring code-run access', async () => {
    state.settings.enabled = false; refresh(); assert.isFalse(button().disabled);
    for (const patch of [{ active: false }, { connected: false }, { missionId: null }]) {
      const before = { ...state }; refresh(patch);
      assert.isTrue(button().disabled || button().hidden);
      await ui.selectFiles([file()]); assert.isEmpty(uploads); refresh(before);
    }
    const original = state.settings;
    refresh({ settings: { ...original, providerConfigured: false } });
    assert.isTrue(button().disabled || button().hidden); await ui.selectFiles([file()]); assert.isEmpty(uploads);
    refresh({ settings: original }); assert.isFalse(button().disabled);
  });

  it('fails closed for missing, provisioning and unknown filesystem states', async () => {
    const ready = state.environment;
    for (const environment of [null, { ...ready, keepFiles: false }, { ...ready, workspaceId: null },
      { ...ready, status: 'provisioning' }, { ...ready, status: 'unknown' }, { ...ready, status: 'needs-attention' }]) {
      refresh({ environment });
      assert.isTrue(button().disabled || button().hidden);
      await ui.selectFiles([file()]); assert.isEmpty(uploads);
    }
    refresh({ environment: ready }); assert.isFalse(button().disabled);
  });

  it('uploads exact bytes and mission metadata without sending a message or starting an agent', async () => {
    chat.setDraft('Unfinished draft');
    await ui.selectFiles([file()]); await tick();
    assert.lengthOf(uploads, 1);
    assert.deepInclude(uploads[0], { missionId: state.missionId, name: 'report.txt', content: 'aGVsbG8K', contentType: 'text/plain' });
    assert.match(uploads[0].requestId, /^[A-Za-z0-9_-]{16,64}$/);
    assert.notProperty(uploads[0], 'userId'); assert.notProperty(uploads[0], 'workspaceId');
    assert.lengthOf(cards(), 1); assert.include(context().textContent, 'report.txt'); assert.isFalse(context().hidden);
    assert.equal(chat.draftText, 'Unfinished draft'); assert.isEmpty(submissions);
    assert.isTrue(chat.allowEmptySubmit);
  });

  it('uses the safe binary MIME fallback and rejects files above 5 MB before reading bytes', async () => {
    await ui.selectFiles([file('binary.dat', 'data', '')]); await tick();
    assert.equal(uploads[0].contentType, 'application/octet-stream');
    let read = false;
    await ui.selectFiles([{ name: 'too-large.bin', size: 5000001, type: 'application/octet-stream', arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } }]); await tick();
    assert.isFalse(read); assert.lengthOf(uploads, 1);
    assert.isTrue(toasts.length > 0 || /large|limit|MB/i.test(context().textContent));
  });

  it('bounds a multi-file selection to ten composer references', async () => {
    await ui.selectFiles(Array.from({ length: 11 }, (_, index) => file(`input-${index}.txt`))); await tick();
    assert.isAtMost(cards().length, 10); assert.isAtMost(uploads.length, 10);
    assert.isTrue(toasts.length > 0 || /limit|ten|10/i.test(context().textContent));
    assert.isEmpty(submissions);
  });

  it('keeps recipient and submission mode when appending file references', async () => {
    await ui.selectFiles([file()]); await tick();
    await send('Check the evidence.', 'ask', 'm:researcher');
    assert.lengthOf(submissions, 1); assert.equal(submissions[0].recipient, 'm:researcher'); assert.equal(submissions[0].mode, 'ask');
    assert.equal(submissions[0].sessionId, state.missionId); assert.include(submissions[0].text, 'Check the evidence.');
    assert.include(submissions[0].text, '`/workspace/uploads/report.txt`');
    assert.isEmpty(cards()); assert.isTrue(context().hidden);
    await ui.selectFiles([file('note.txt')]); await tick(); await send('', 'note');
    assert.lengthOf(submissions, 2); assert.equal(submissions[1].mode, 'note'); assert.isUndefined(submissions[1].recipient);
    assert.match(submissions[1].text, /shared|files/i); assert.include(submissions[1].text, '/workspace/uploads/note.txt');
  });

  it('allows a file-only ask but does not auto-submit while uploading', async () => {
    await ui.selectFiles([file()]); await tick(); assert.isEmpty(submissions);
    await send('', 'ask', 'm:operator');
    assert.lengthOf(submissions, 1); assert.match(submissions[0].text, /review|files/i);
    assert.equal(submissions[0].recipient, 'm:operator'); assert.isEmpty(cards());
  });

  it('opens uploaded files in their mission and removes only composer references', async () => {
    await ui.selectFiles([file()]); await tick();
    cards()[0].querySelector('[data-file-open]').click();
    assert.deepEqual(opened, [[state.missionId, '/workspace/uploads/report.txt']]);
    const remove = cards()[0].querySelector('[data-file-remove]');
    assert.match(remove.getAttribute('aria-label') || remove.title || remove.textContent, /remove/i); remove.click(); await tick();
    assert.isEmpty(cards()); assert.lengthOf(uploads, 1); assert.isEmpty(submissions);
    assert.isFalse(chat.allowEmptySubmit);
  });

  it('keeps text editable and references visible while an upload is pending', async () => {
    const pending = deferred(); upload = () => pending.promise;
    const selecting = ui.selectFiles([file()]); await waitFor(() => uploads.length === 1);
    chat.setDraft('Draft stays editable');
    assert.equal(chat.getAttribute('send-disabled'), 'true'); assert.notEqual(chat.getAttribute('aria-disabled'), 'true');
    const input = chat.shadowRoot.querySelector('[part~="input"]'); assert.isFalse(input.disabled); assert.isFalse(input.readOnly);
    assert.lengthOf(cards(), 1);
    await send('Draft stays editable'); assert.isEmpty(submissions); assert.equal(chat.draftText, 'Draft stays editable');
    pending.resolve(result(uploads[0])); await selecting; await tick();
    assert.notEqual(chat.getAttribute('send-disabled'), 'true'); assert.lengthOf(cards(), 1);
  });

  it('uploads serially and removing pending references never resurrects them or uploads a removed queued file', async () => {
    const first = deferred(), second = deferred();
    upload = (payload) => payload.name === 'first.txt' ? first.promise : second.promise;
    const selecting = ui.selectFiles([file('first.txt'), file('second.txt'), file('third.txt')]);
    await waitFor(() => uploads.length === 1); await tick();
    assert.deepEqual(uploads.map((entry) => entry.name), ['first.txt']);
    assert.lengthOf(cards(), 3);
    for (const name of ['first.txt', 'third.txt']) {
      cards().find((card) => card.textContent.includes(name)).querySelector('[data-file-remove]').click();
    }
    await tick(); assert.lengthOf(cards(), 1); assert.include(cards()[0].textContent, 'second.txt');
    first.resolve(result(uploads[0]));
    await waitFor(() => uploads.length === 2); await tick();
    assert.deepEqual(uploads.map((entry) => entry.name), ['first.txt', 'second.txt']);
    assert.lengthOf(cards(), 1); assert.equal(chat.getAttribute('send-disabled'), 'true');
    second.resolve(result(uploads[1])); await selecting; await tick();
    assert.lengthOf(uploads, 2); assert.lengthOf(cards(), 1); assert.isEmpty(submissions);
    await send('Review the remaining file.');
    assert.lengthOf(submissions, 1); assert.include(submissions[0].text, '/workspace/uploads/second.txt');
    assert.notInclude(submissions[0].text, '/workspace/uploads/first.txt');
    assert.notInclude(submissions[0].text, '/workspace/uploads/third.txt');
  });

  it('keeps failed uploads and their draft for deliberate retry', async () => {
    upload = async () => { throw { reason: 'Connection unavailable' }; };
    await ui.selectFiles([file()]); await tick();
    assert.lengthOf(cards(), 1); assert.exists(cards()[0].querySelector('[data-file-retry]'));
    assert.equal(chat.getAttribute('send-disabled'), 'true');
    await send('Do not lose this draft'); assert.isEmpty(submissions); assert.equal(chat.draftText, 'Do not lose this draft');
    upload = async (payload) => result(payload);
    cards()[0].querySelector('[data-file-retry]').click();
    await waitFor(() => uploads.length === 2 && chat.getAttribute('send-disabled') !== 'true');
    assert.equal(uploads[1].requestId, uploads[0].requestId, 'retry must keep the idempotency key');
    await send('Do not lose this draft'); assert.lengthOf(submissions, 1);
  });

  it('uses a new request identity only after the server definitively rejected the prior upload', async () => {
    upload = async () => { throw { error: 'execution-file-request-rejected', reason: 'This upload was not accepted.' }; };
    await ui.selectFiles([file()]); await tick();
    assert.lengthOf(uploads, 1); assert.equal(chat.getAttribute('send-disabled'), 'true');
    upload = async (payload) => result(payload);
    cards()[0].querySelector('[data-file-retry]').click();
    await waitFor(() => uploads.length === 2 && chat.getAttribute('send-disabled') !== 'true');
    assert.notEqual(uploads[1].requestId, uploads[0].requestId);
    assert.equal(uploads[1].name, uploads[0].name); assert.equal(uploads[1].content, uploads[0].content);
    assert.isEmpty(submissions); assert.lengthOf(cards(), 1);
  });

  it('requires a different filename after a collision and retries under a new request identity', async () => {
    upload = async () => { throw { error: 'execution-file-exists', reason: 'A file with this name already exists.' }; };
    await ui.selectFiles([file('report.txt')]); await tick();
    const rename = cards()[0].querySelector('[data-file-rename]');
    assert.exists(rename); assert.equal(rename.value, 'report.txt');
    assert.match(rename.getAttribute('aria-label'), /name/i);
    cards()[0].querySelector('[data-file-retry]').click(); await tick();
    assert.lengthOf(uploads, 1, 'retry without renaming must not overwrite the existing file');
    const currentRename = cards()[0].querySelector('[data-file-rename]');
    currentRename.value = 'report-revised.txt'; currentRename.dispatchEvent(new Event('input', { bubbles: true }));
    upload = async (payload) => result(payload);
    cards()[0].querySelector('[data-file-retry]').click();
    await waitFor(() => uploads.length === 2 && cards()[0]?.dataset.state === 'ready');
    assert.equal(uploads[1].name, 'report-revised.txt'); assert.equal(uploads[1].content, uploads[0].content);
    assert.notEqual(uploads[1].requestId, uploads[0].requestId);
    assert.isNull(cards()[0].querySelector('[data-file-rename]')); assert.isEmpty(submissions);
    await send('Read the renamed file.');
    assert.include(submissions[0].text, '/workspace/uploads/report-revised.txt');
    assert.notInclude(submissions[0].text, '/workspace/uploads/report.txt');
  });

  it('does not treat unknown or pending server outcomes as ready references', async () => {
    for (const status of ['unknown', 'pending']) {
      upload = async (payload) => result(payload, { status });
      await ui.selectFiles([file(`${status}.txt`)]); await tick();
      assert.equal(chat.getAttribute('send-disabled'), 'true');
      await send('Hold until verified'); assert.isEmpty(submissions);
      cards().forEach((card) => card.querySelector('[data-file-remove]').click()); await tick();
    }
    upload = async (payload) => result(payload, { previousEnvironment: true });
    await ui.selectFiles([file('old-environment.txt')]); await tick();
    assert.equal(chat.getAttribute('send-disabled'), 'true'); await send('Do not use a stale path'); assert.isEmpty(submissions);
  });

  it('retains ready context until the wrapped send succeeds, including failed sends', async () => {
    await ui.selectFiles([file()]); await tick();
    const pending = deferred(); submit = () => pending.promise;
    chat.setDraft('Review after upload'); const sending = chat.submitDraft();
    await waitFor(() => submissions.length === 1); assert.lengthOf(cards(), 1);
    pending.reject(new Error('Message was not saved')); await sending; await tick();
    assert.lengthOf(cards(), 1); assert.equal(chat.draftText, 'Review after upload');
    submit = async () => 'saved'; await chat.submitDraft(); await tick();
    assert.lengthOf(submissions, 2); assert.isEmpty(cards());
  });

  it('isolates in-flight uploads when changing mission or account', async () => {
    const pending = deferred(); upload = () => pending.promise;
    const origin = state.missionId; const selecting = ui.selectFiles([file('original.txt')]);
    await waitFor(() => uploads.length === 1);
    refresh({ missionId: `${origin}-other` }); chat.setAttribute('session-id', state.missionId); await tick();
    assert.isEmpty(cards());
    pending.resolve(result(uploads[0])); await selecting; await tick();
    assert.isEmpty(cards()); assert.equal(uploads[0].missionId, origin); assert.isEmpty(submissions);
    refresh({ missionId: origin, userId: 'different-user' }); chat.setAttribute('session-id', origin); await tick();
    assert.isEmpty(cards()); assert.isEmpty(opened);
  });

  it('blocks sending existing references if filesystem permission changes', async () => {
    await ui.selectFiles([file()]); await tick();
    refresh({ environment: { ...state.environment, keepFiles: false } });
    assert.lengthOf(cards(), 1); assert.equal(chat.getAttribute('send-disabled'), 'true');
    await send('Wait for restored access'); assert.isEmpty(submissions); assert.equal(chat.draftText, 'Wait for restored access');
    refresh({ environment: { ...state.environment, keepFiles: true } });
    assert.notEqual(chat.getAttribute('send-disabled'), 'true');
  });

  it('does not parse # filenames as plans and refuses exact plan commands with files attached', async () => {
    upload = async (payload) => result(payload, { path: '/workspace/uploads/notes #release.md' });
    await ui.selectFiles([file('notes #release.md')]); await tick(); await send('Read this file.');
    assert.lengthOf(submissions, 1); assert.deepEqual(planReferenceHandles(submissions[0].text), []);
    await ui.selectFiles([file('plan-input.txt')]); await tick();
    let failure;
    chat.addEventListener('agent-chat:error', (event) => { failure = event.detail; }, { once: true });
    await send('Run #release');
    assert.lengthOf(submissions, 1); assert.lengthOf(cards(), 1); assert.equal(chat.draftText, 'Run #release');
    assert.exists(failure); assert.match(failure.message, /files|plan/i);
  });

  it('keeps plan-like crew notes as notes while sharing their file references', async () => {
    await ui.selectFiles([file()]); await tick();
    await send('Run #release', 'note');
    assert.lengthOf(submissions, 1); assert.equal(submissions[0].mode, 'note');
    assert.isUndefined(submissions[0].recipient); assert.include(submissions[0].text, 'Run #release');
    assert.include(submissions[0].text, '`/workspace/uploads/report.txt`');
    assert.isEmpty(cards());
  });

  it('disposes its wrapper, controls and pending references without deleting uploaded files', async () => {
    await ui.selectFiles([file()]); await tick();
    ui.dispose(); assert.equal(chat.submissionHandler, previousHandler);
    assert.isNull(button()); assert.isNull(context()); assert.isFalse(chat.allowEmptySubmit);
    assert.lengthOf(uploads, 1); assert.isEmpty(submissions);
    refresh({ active: false }); assert.isNull(button());
  });

  it('supports an external Add trigger and attaches existing paths without uploading', async () => {
    ui.dispose(); chat.submissionHandler = previousHandler;
    ui = initialize({ chat, externalTrigger: true, snapshot: () => { dependency.depend(); return state; },
      upload: (payload) => { uploads.push(payload); return upload(payload); }, openFiles: (...args) => opened.push(args), toast: (...args) => toasts.push(args) });
    Tracker.flush(); assert.isNull(button()); assert.isTrue(ui.getReadiness().canUpload);
    const existing = { path: '/workspace/research/report.md', type: 'file', size: 12 };
    assert.isTrue(ui.attachExisting([existing], state)); await tick();
    assert.isTrue(ui.attachExisting([existing], state)); await tick(); assert.lengthOf(cards(), 1); assert.isEmpty(uploads);
    assert.equal(ui.getReadiness().count, 1); cards()[0].querySelector('[data-file-open]').click(); assert.deepEqual(opened, [[state.missionId, existing.path]]);
    await send('Use the saved report.', 'ask', 'm:researcher'); assert.include(submissions[0].text, '`/workspace/research/report.md`');
    assert.equal(submissions[0].recipient, 'm:researcher'); assert.isEmpty(uploads); assert.isEmpty(cards());
  });

  it('rejects stale or invalid existing references and bounds them with uploads', async () => {
    const existing = { path: '/workspace/report.md', type: 'file' }; const original = state;
    refresh({ environment: { ...state.environment, workspaceId: 'replacement' } }); assert.isFalse(ui.attachExisting([existing], original));
    for (const entry of [{ ...existing, path: '/etc/passwd' }, { ...existing, path: '/workspace/../secret' }, { ...existing, type: 'directory' }]) assert.isFalse(ui.attachExisting([entry], state));
    assert.isEmpty(cards()); assert.isEmpty(uploads);
    assert.isTrue(ui.attachExisting(Array.from({ length: 10 }, (_, index) => ({ ...existing, path: `/workspace/file-${index}.txt` })), state)); await tick();
    assert.equal(ui.getReadiness().count, 10); assert.isFalse(ui.getReadiness().canUpload);
    assert.isFalse(ui.attachExisting([existing], state)); assert.lengthOf(cards(), 10);
    refresh({ environment: { ...state.environment, keepFiles: false } }); assert.isFalse(ui.attachExisting([existing], state));
    assert.equal(chat.getAttribute('send-disabled'), 'true'); assert.isEmpty(uploads);
  });

  it('clears prior-account file context before a synchronous send can beat reactive repaint', async () => {
    ui.attachExisting([{ path: '/workspace/private-report.txt', type: 'file', size: 12 }], state); await tick();
    state = { ...state, userId: 'new-owner' };
    await chat.submissionHandler({ sessionId: state.missionId, text: 'New account message', mode: 'ask', recipient: 'm:researcher' });
    assert.lengthOf(submissions, 1); assert.equal(submissions[0].text, 'New account message');
    assert.notInclude(submissions[0].text, 'private-report'); assert.isEmpty(uploads); await tick(); assert.isEmpty(cards());
  });

  it('ignores a late upload completion and further selections after disposal', async () => {
    const pending = deferred(); upload = () => pending.promise;
    const selecting = ui.selectFiles([file('in-flight.txt')]);
    await waitFor(() => uploads.length === 1);
    chat.setDraft('Keep the unfinished message');
    ui.dispose();
    await ui.selectFiles([file('after-dispose.txt')]);
    pending.resolve(result(uploads[0])); await selecting; await tick();
    assert.lengthOf(uploads, 1); assert.isEmpty(submissions); assert.isEmpty(opened);
    assert.isNull(button()); assert.isNull(context()); assert.isNull(chat.querySelector('input[type="file"]'));
    assert.equal(chat.submissionHandler, previousHandler); assert.isFalse(chat.allowEmptySubmit);
    assert.equal(chat.draftText, 'Keep the unfinished message'); assert.isNull(chat.getAttribute('send-disabled'));
  });
});
