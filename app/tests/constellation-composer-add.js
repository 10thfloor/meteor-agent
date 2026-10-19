import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

if (Meteor.isClient) describe('Composer Add menu', function () {
  this.timeout(10_000);
  let initialize; let chat; let ui; let state; let dependency; let calls; let attachments; let plans; let enables; let pickerCount; let response;
  const ready = () => ({ enabled: !!state.environment?.keepFiles && !!state.environment?.workspaceId && !state.environment.erasedAt,
    canUpload: state.active && state.connected && state.environment?.keepFiles && state.environment.status === 'ready', reason: '', count: 0 });
  const row = (name, type = 'file', directory = '/workspace') => ({ name, type, path: `${directory}/${name}`, size: 10 });
  const popover = () => document.getElementById(ui.control.getAttribute('aria-controls'));
  const field = (name) => popover().querySelector(`[data-add="${name}"]`);
  const defer = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
  const settle = async (check) => { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) assert.fail('Composer Add did not settle'); await new Promise((resolve) => setTimeout(resolve, 5)); Tracker.flush(); } };
  const refresh = (patch) => { state = { ...state, ...patch }; dependency.changed(); Tracker.flush(); };
  before(async () => { ({ initializeComposerAdd: initialize } = await import('../client/composer-add')); });
  beforeEach(() => {
    dependency = new Tracker.Dependency(); calls = []; attachments = []; plans = []; enables = []; pickerCount = 0;
    state = { userId: 'owner', missionId: 'mission-a', active: true, connected: true, environment: { keepFiles: true, workspaceId: 'sprite-a', status: 'ready' } };
    chat = document.createElement('div'); chat.attachShadow({ mode: 'open' }).innerHTML = '<div class="composer" aria-busy="false"><slot name="composer-toolbar"></slot></div>';
    chat.focusComposer = () => { chat.dataset.focused = 'true'; }; document.body.append(chat);
    response = async ({ path }) => ({ path, entries: [row('report.txt')] });
    ui = initialize({ chat, snapshot: () => { dependency.depend(); return state; },
      files: { getReadiness: ready, openPicker: () => { pickerCount += 1; }, attachExisting: (rows, scope) => { attachments.push({ rows, scope }); return true; } },
      listFiles: async (input) => { calls.push(input); return response(input); }, openPlans: (anchor) => plans.push(anchor), enableFilesystem: (id) => enables.push(id) });
    Tracker.flush();
  });
  afterEach(() => { ui.dispose(); chat.remove(); Tracker.flush(); });

  it('groups uploads, mission files and plan context behind a readable native popover', () => {
    assert.equal(ui.control.textContent.trim(), 'Add'); assert.equal(ui.control.slot, 'composer-toolbar');
    assert.equal(ui.control.getAttribute('aria-label'), 'Add to message'); assert.equal(popover().getAttribute('popover'), 'auto');
    ui.control.click(); assert.isTrue(popover().matches(':popover-open')); assert.equal(ui.control.getAttribute('aria-expanded'), 'true');
    assert.include(field('upload').textContent, 'Upload files'); assert.include(field('choose').textContent, 'Choose mission file');
    assert.include(field('plan').textContent, 'does not run'); assert.isAtLeast(parseFloat(getComputedStyle(ui.control).fontSize), 13); assert.isEmpty(calls);
    field('upload').click(); assert.equal(pickerCount, 1); assert.isFalse(popover().matches(':popover-open')); assert.isEmpty(attachments);
    ui.showMenu(); field('plan').click(); assert.deepEqual(plans, [ui.control]); assert.isEmpty(calls); assert.isEmpty(enables);
  });
  it('offers explicit filesystem setup without allocating or uploading from the menu', () => {
    refresh({ environment: { keepFiles: false, status: 'not-created' } }); ui.showMenu();
    assert.include(field('upload').textContent, 'Enable mission filesystem'); assert.isTrue(field('choose').disabled);
    assert.isFalse(field('plan').disabled); assert.isEmpty(enables); assert.isEmpty(calls);
    field('upload').click(); assert.deepEqual(enables, ['mission-a']); assert.equal(pickerCount, 0); assert.isEmpty(attachments);
  });
  it('browses folders and searches locally without reading or sending file bytes', async () => {
    response = async ({ path }) => ({ path, entries: path === '/workspace' ? [row('docs', 'directory'), row('report.txt')] : [row('review.md', 'file', path), row('data.csv', 'file', path)] });
    ui.showFiles(); await settle(() => field('results').querySelectorAll('[data-file-path]').length === 2);
    field('results').querySelector('[data-file-path="/workspace/docs"]').click(); await settle(() => field('folder').textContent === 'docs' && !field('search').disabled);
    field('search').value = 'review'; field('search').dispatchEvent(new Event('input')); assert.equal(field('results').querySelectorAll('[data-file-path]').length, 1);
    field('results').querySelector('[data-file-path]').click();
    assert.deepEqual(calls, [{ missionId: 'mission-a', path: '/workspace' }, { missionId: 'mission-a', path: '/workspace/docs' }]);
    assert.deepEqual(attachments[0].rows, [row('review.md', 'file', '/workspace/docs')]); assert.equal(attachments[0].scope.missionId, 'mission-a');
    assert.isFalse(popover().matches(':popover-open')); assert.equal(chat.dataset.focused, 'true'); assert.equal(pickerCount, 0);
  });
  it('provides parent navigation, empty states and safely rendered in-folder rows', async () => {
    response = async ({ path }) => ({ path, entries: path === '/workspace' ? [row('docs', 'directory'), row('<script>.txt'), row('bad', 'file', '/other'), { ...row('escaped'), path: '/workspace/../secret' }] : [] });
    ui.showFiles(); await settle(() => field('results').querySelectorAll('[data-file-path]').length === 2);
    assert.isNull(field('results').querySelector('script')); assert.isTrue(field('up').hidden); assert.equal(field('root').textContent, 'Mission files');
    field('results').querySelector('[data-file-path="/workspace/docs"]').click(); await settle(() => field('results').textContent.includes('empty'));
    assert.isFalse(field('root').disabled); assert.isFalse(field('up').hidden); field('up').click(); await settle(() => !field('search').disabled);
    assert.equal(calls.at(-1).path, '/workspace'); field('search').value = 'missing'; field('search').dispatchEvent(new Event('input'));
    assert.include(field('results').textContent, 'No files match'); assert.isEmpty(attachments);
  });
  it('shows loading and safe retry errors without exposing raw exception payloads', async () => {
    const pending = defer(); response = () => pending.promise; ui.showFiles();
    assert.equal(field('results').getAttribute('aria-busy'), 'true'); assert.exists(field('results').querySelector('.composer-file-spinner')); assert.isTrue(field('search').disabled);
    pending.reject(new Error('{"private":"payload"}')); await settle(() => !!field('retry')); assert.notInclude(field('results').textContent, 'private');
    response = async ({ path }) => ({ path, entries: [row('retried.txt')] }); field('retry').click();
    await settle(() => field('results').textContent.includes('retried.txt')); assert.equal(calls.length, 2); assert.isEmpty(attachments);
  });
  it('rejects stale results when mission, account or filesystem changes', async () => {
    for (const change of [{ missionId: 'mission-b' }, { userId: 'other-owner' }, { environment: { ...state.environment, workspaceId: 'sprite-b' } }]) {
      const pending = defer(); response = () => pending.promise; ui.showFiles(); refresh(change);
      assert.isFalse(popover().matches(':popover-open')); pending.resolve({ path: '/workspace', entries: [row('stale.txt')] });
      await Promise.resolve(); await Promise.resolve(); assert.isEmpty(attachments); assert.notInclude(field('results').textContent, 'stale.txt');
    }
  });
  it('closes on send or filesystem revocation and supports Escape and arrow keys', async () => {
    ui.showMenu(); field('upload').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); assert.strictEqual(document.activeElement, field('choose'));
    field('choose').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.strictEqual(document.activeElement, ui.control);
    ui.showFiles(); await settle(() => field('results').querySelector('[data-file-path]'));
    refresh({ environment: { ...state.environment, keepFiles: false } }); assert.isFalse(popover().matches(':popover-open'));
    ui.showMenu(); chat.shadowRoot.querySelector('.composer').setAttribute('aria-busy', 'true');
    await settle(() => ui.control.disabled); assert.isFalse(popover().matches(':popover-open')); assert.isEmpty(attachments);
  });
  it('tears down the toolbar, popover and unfinished results', async () => {
    const pending = defer(); response = () => pending.promise; ui.showFiles(); const id = popover().id;
    ui.dispose(); pending.resolve({ path: '/workspace', entries: [row('late.txt')] }); await Promise.resolve();
    assert.isNull(document.getElementById(id)); assert.isNull(chat.querySelector('[data-composer-add]')); assert.isEmpty(attachments);
  });
});
