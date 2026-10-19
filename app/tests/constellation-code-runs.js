import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';

if (Meteor.isClient) describe('Compact code run browser', function () {
  this.timeout(8_000);
  let initialize; let fixture;
  const wait = async (test) => { const until = Date.now() + 4000; while (!test()) { if (Date.now() > until) assert.fail('Code run browser did not settle.'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  const flush = () => Tracker.flush();
  const $ = (name) => fixture.root.querySelector(`[data-runs="${name}"]`);
  const job = (id = 'run-a', patch = {}) => ({ _id: id, missionId: 'mission-a', sessionId: 'mission-a', agent: 'orchestrator', title: 'Calculate totals',
    language: 'python', status: 'completed', createdAt: new Date('2026-09-20T16:00:00Z'), startedAt: new Date('2026-09-20T16:00:01Z'), completedAt: new Date('2026-09-20T16:00:04Z'),
    artifacts: [], stdout: '5050', stderr: '', code: 'print(sum(range(101)))', exitCode: 0, ...patch });
  const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const change = (name, value) => { $(name).value = value; $(name).dispatchEvent(new Event(name === 'search' ? 'input' : 'change', { bubbles: true })); };
  before(async () => { ({ initializeCodeRuns: initialize } = await import('../client/code-runs')); });
  beforeEach(() => {
    const root = document.createElement('section'); root.style.cssText = 'position:fixed;inset:40px;z-index:99999;background:#151817;'; document.body.append(root);
    fixture = { root, jobs: new Mongo.Collection(null), calls: [], subscriptions: [], navigation: [], downloads: [], environments: [], connected: true,
      dependency: new Tracker.Dependency(), response: async (name, args) => name === 'historyPage' ? { rows: [job()], nextCursor: null } : name === 'getRun' ? job(args.jobId, { missionId: args.missionId }) : {},
      attachment: async () => '/test/result.txt' };
    fixture.mount = (global = false) => {
      fixture.controller?.dispose();
      fixture.controller = initialize({ root, jobs: fixture.jobs, global,
        method: (name, args) => { fixture.calls.push({ name, args }); return fixture.response(name, args); },
        subscribe: (...args) => { const sub = { args, stopped: false, ready: () => true, stop() { this.stopped = true; } }; fixture.subscriptions.push(sub); return sub; },
        connectionStatus: () => { fixture.dependency.depend(); return { connected: fixture.connected }; },
        crew: () => [{ agent: 'orchestrator', displayName: 'Atlas' }, { agent: 'researcher', displayName: 'Signal' }],
        missions: () => [{ _id: 'mission-a', title: 'Analysis' }, { _id: 'mission-b', title: 'Research' }],
        agentName: (id) => id === 'orchestrator' ? 'Atlas' : 'Signal', missionName: (id) => id === 'mission-a' ? 'Analysis' : 'Research',
        navigateToMissionWork: (...args) => fixture.navigation.push(args), openEnvironment: (id) => fixture.environments.push(id),
        attachmentUrl: (...args) => fixture.attachment(...args), download: (url) => fixture.downloads.push(url),
      });
    };
    fixture.mount();
  });
  afterEach(() => { fixture.controller.dispose(); fixture.root.remove(); });

  it('lists compact metadata and fetches source/output only for the explicitly selected run', async () => {
    fixture.controller.setActive({ missionId: 'mission-a', active: true });
    await wait(() => fixture.root.querySelector('tbody tr'));
    assert.deepEqual([...fixture.root.querySelectorAll('th')].map((cell) => cell.textContent), ['Status', 'Run', 'Agent', 'Duration', 'Files', 'Started']);
    assert.deepEqual(fixture.calls, [{ name: 'historyPage', args: { missionId: 'mission-a', limit: 25 } }]);
    assert.isTrue($('detail').hidden); assert.notInclude(fixture.root.querySelector('tbody').textContent, '5050');
    fixture.root.querySelector('[data-cell="title"]').click();
    await wait(() => $('stdout').textContent === '5050');
    assert.deepEqual(fixture.calls.at(-1), { name: 'getRun', args: { missionId: 'mission-a', jobId: 'run-a' } });
    assert.include($('detail-meta').textContent, 'Atlas'); assert.include($('detail-meta').textContent, '3s');
    assert.isFalse($('detail').hidden);
  });

  it('announces loading with a visible spinner and keeps host reactive activation idempotent', async () => {
    const page = deferred(); const detail = deferred();
    fixture.response = (name) => name === 'historyPage' ? page.promise : detail.promise;
    let activationCount = 0;
    const activation = Tracker.autorun(() => { activationCount += 1; fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' }); });
    try {
      flush(); assert.equal(activationCount, 1); assert.lengthOf(fixture.calls, 2);
      assert.equal($('table-scroll').getAttribute('aria-busy'), 'true'); assert.equal($('detail').getAttribute('aria-busy'), 'true');
      assert.equal($('notice').dataset.busy, 'true'); assert.equal($('detail-notice').dataset.busy, 'true');
      assert.equal(getComputedStyle($('notice'), '::before').display, 'inline-block');
      page.resolve({ rows: [job()], nextCursor: null }); detail.resolve(job());
      await wait(() => $('table-scroll').getAttribute('aria-busy') === 'false' && $('detail').getAttribute('aria-busy') === 'false');
      flush(); assert.equal(activationCount, 1, 'controller updates never resubscribe the host computation');
    } finally { activation.stop(); }
  });

  it('opens an exact older linked run without selecting another row or trusting another mission', async () => {
    const detail = deferred(); fixture.response = (name) => name === 'historyPage' ? Promise.resolve({ rows: [job()], nextCursor: null }) : detail.promise;
    fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'older-than-page' });
    await wait(() => fixture.root.querySelector('tbody tr'));
    assert.include($('detail-notice').textContent, 'Loading run');
    assert.isNull(fixture.root.querySelector('tbody [aria-current="true"]'));
    detail.resolve(job('older-than-page', { title: 'Earlier analysis' }));
    await wait(() => $('title').textContent === 'Earlier analysis');
    fixture.response = async () => job('wrong', { missionId: 'mission-b' });
    fixture.controller.selectRun('missing', 'mission-a');
    await wait(() => $('detail-notice').textContent.includes('unavailable in this mission'));
    assert.equal($('stdout').textContent, '');
  });

  it('pages metadata with opaque cursors and resets them when filters change', async () => {
    fixture.response = async (name, args) => name === 'historyPage' ? { rows: [job(args.cursor ? 'page-two' : 'page-one')], nextCursor: args.cursor ? null : 'opaque-next' } : {};
    fixture.controller.setActive({ missionId: 'mission-a', active: true });
    await wait(() => !$('next').disabled); $('next').click();
    await wait(() => fixture.root.querySelector('[data-job-id="page-two"]'));
    assert.deepEqual(fixture.calls.at(-1).args, { missionId: 'mission-a', cursor: 'opaque-next', limit: 25 });
    assert.equal($('page-label').textContent, 'Page 2 · 1 run');
    change('status', 'failed');
    await wait(() => fixture.calls.at(-1).args.status === 'failed');
    assert.notProperty(fixture.calls.at(-1).args, 'cursor'); assert.isTrue($('previous').disabled);
    change('agent', 'researcher'); change('search', 'spreadsheets');
    await wait(() => fixture.calls.at(-1).args.search === 'spreadsheets');
    assert.deepEqual(fixture.calls.at(-1).args, { missionId: 'mission-a', search: 'spreadsheets', status: 'failed', agent: 'researcher', limit: 25 });
  });

  it('preserves page boundaries when new live runs arrive between page requests', async () => {
    const page = Array.from({ length: 25 }, (_, index) => job(`old-${index + 1}`, { createdAt: new Date(100000 - index * 1000) }));
    fixture.response = async (name, args) => ({ rows: args.cursor ? [job('old-26', { createdAt: new Date(75000) })] : page, nextCursor: args.cursor ? null : 'after-old-25' });
    fixture.controller.setActive({ missionId: 'mission-a', active: true }); await wait(() => !$('next').disabled);
    fixture.jobs.insert(job('new-1', { createdAt: new Date(110000) })); fixture.jobs.insert(job('new-2', { createdAt: new Date(120000) })); flush();
    assert.include($('notice').textContent, '2 new runs available');
    assert.ok(fixture.root.querySelector('[data-job-id="old-24"]')); assert.ok(fixture.root.querySelector('[data-job-id="old-25"]'));
    assert.isNull(fixture.root.querySelector('[data-job-id="new-1"]'));
    $('next').click(); await wait(() => fixture.root.querySelector('[data-job-id="old-26"]'));
    assert.equal(fixture.calls.at(-1).args.cursor, 'after-old-25');
  });

  it('recovers from an expired cursor by refreshing from the first page', async () => {
    fixture.response = async (name, args) => {
      if (args.cursor) throw { error: 'execution-invalid-cursor', reason: 'History changed. Refresh the list.' };
      return { rows: [job()], nextCursor: 'expired-on-restart' };
    };
    fixture.controller.setActive({ missionId: 'mission-a', active: true }); await wait(() => !$('next').disabled);
    $('next').click(); await wait(() => $('notice').getAttribute('role') === 'alert');
    assert.include($('notice').textContent, 'Refresh'); $('refresh').click();
    await wait(() => $('page-label').textContent.startsWith('Page 1') && fixture.root.querySelector('tbody tr') && !$('refresh').disabled);
    assert.notProperty(fixture.calls.at(-1).args, 'cursor');
    assert.equal(fixture.calls.filter((call) => call.args.cursor).length, 1);
  });

  it('shows mission metadata globally and ignores stale responses after choosing a mission', async () => {
    fixture.mount(true); const old = deferred();
    fixture.response = (name, args) => args.missionId ? Promise.resolve({ rows: [job('filtered', { missionId: args.missionId })], nextCursor: null }) : old.promise;
    fixture.controller.setActive({ active: true }); change('mission', 'mission-b');
    await wait(() => fixture.root.querySelector('[data-job-id="filtered"]'));
    old.resolve({ rows: [job('stale')], nextCursor: null }); await Promise.resolve(); flush();
    assert.isNull(fixture.root.querySelector('[data-job-id="stale"]'));
    assert.include(fixture.root.querySelector('thead').textContent, 'Mission');
    assert.include(fixture.root.querySelector('tbody').textContent, 'Research');
    assert.isTrue(fixture.subscriptions[0].stopped);
  });

  it('keeps selected tabs, keyed controls and scrolling through live updates', async () => {
    fixture.jobs.insert(job()); fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' });
    await wait(() => $('stdout').textContent === '5050');
    const row = fixture.root.querySelector('tbody tr'); const button = row.querySelector('button'); button.focus();
    const codeTab = fixture.root.querySelector('[data-runs-tab="code"]'); codeTab.click();
    $('detail-scroll').scrollTop = 5;
    fixture.jobs.update('run-a', { $set: { stdout: 'updated', code: 'print(42)', title: 'Updated totals' } }); flush();
    assert.strictEqual(fixture.root.querySelector('tbody tr'), row); assert.strictEqual(row.querySelector('button'), button);
    assert.equal(codeTab.getAttribute('aria-selected'), 'true'); assert.equal($('code').textContent, 'print(42)');
    assert.equal(fixture.calls.filter((call) => call.name === 'getRun').length, 1);
  });

  it('supports keyboard tabs with labelled result panels', async () => {
    fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' }); await wait(() => $('stdout').textContent === '5050');
    const output = fixture.root.querySelector('[data-runs-tab="output"]');
    const code = fixture.root.querySelector('[data-runs-tab="code"]');
    output.focus(); output.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    assert.strictEqual(document.activeElement, code); assert.equal(code.getAttribute('aria-selected'), 'true');
    const panel = document.getElementById(code.getAttribute('aria-controls'));
    assert.equal(panel.getAttribute('aria-labelledby'), code.id); assert.isFalse(panel.hidden);
    code.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    assert.strictEqual(document.activeElement, output);
  });

  it('preserves each mission’s filters and selection while ignoring inactive replies', async () => {
    fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' }); await wait(() => $('stdout').textContent === '5050');
    change('agent', 'researcher'); await wait(() => fixture.calls.at(-1).args.agent === 'researcher');
    fixture.controller.selectRun('run-a', 'mission-a'); await wait(() => !$('detail').hidden && $('stdout').textContent === '5050');
    fixture.controller.setActive({ missionId: 'mission-a', active: false });
    const callCount = fixture.calls.length; fixture.controller.setActive({ missionId: 'mission-a', active: false });
    assert.equal(fixture.calls.length, callCount);
    fixture.controller.setActive({ missionId: 'mission-b', active: true }); await wait(() => fixture.calls.some((call) => call.args.missionId === 'mission-b'));
    fixture.controller.setActive({ missionId: 'mission-a', active: true });
    assert.equal($('agent').value, 'researcher');
    await wait(() => $('title').textContent === 'Calculate totals');
    assert.isTrue(fixture.subscriptions.some((sub) => sub.stopped));
  });

  it('links saved results to mission Files and keeps download secondary', async () => {
    fixture.response = async (name, args) => name === 'historyPage' ? { rows: [job()], nextCursor: null } : job(args.jobId, { artifacts: [{ id: 'file-a', name: 'totals.csv' }] });
    fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' }); await wait(() => $('files').querySelector('button'));
    fixture.root.querySelector('[data-runs-tab="files"]').click();
    $('files').querySelector('button').click();
    assert.deepEqual(fixture.navigation, [['files', 'mission-a', { attachmentId: 'file-a' }]]);
    $('files').querySelector('.op-link').click(); await wait(() => fixture.downloads.length === 1);
    assert.deepEqual(fixture.downloads, ['/test/result.txt']);
  });

  it('drops an old download after closing and reopening the same mission/run', async () => {
    const pending = deferred(); fixture.attachment = () => pending.promise;
    fixture.response = async (name, args) => name === 'historyPage' ? { rows: [job()], nextCursor: null } : job(args.jobId, { artifacts: [{ id: 'file-a', name: 'result.txt' }] });
    fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' }); await wait(() => $('files').querySelector('.op-link'));
    $('files').querySelector('.op-link').click();
    fixture.controller.setActive({ missionId: 'mission-a', active: false }); fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' });
    pending.resolve('/old-download'); await Promise.resolve(); await Promise.resolve();
    assert.isEmpty(fixture.downloads);
  });

  it('does not clear existing output during refresh or finish a download from a closed detail pane', async () => {
    const download = deferred(); const refreshing = deferred(); fixture.attachment = () => download.promise;
    const value = job('run-a', { artifacts: [{ id: 'file-a', name: 'result.txt' }] });
    fixture.response = async (name) => name === 'historyPage' ? { rows: [value], nextCursor: null } : value;
    fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' }); await wait(() => $('stdout').textContent === '5050');
    fixture.response = (name) => name === 'getRun' ? refreshing.promise : Promise.resolve({ rows: [value], nextCursor: null });
    $('refresh').click(); assert.equal($('stdout').textContent, '5050');
    refreshing.resolve(value); await wait(() => !$('detail-notice').textContent.includes('Loading'));
    $('files').querySelector('.op-link').click(); $('close-detail').click(); fixture.controller.selectRun('run-a', 'mission-a');
    download.resolve('/stale-detail-download'); await Promise.resolve(); await Promise.resolve();
    assert.isEmpty(fixture.downloads);
  });

  it('stops the exact run once, keeps saved files, and offers scoped recovery for unknown work', async () => {
    const stopping = deferred(); let value = job('run-a', { status: 'queued', completedAt: undefined, persistent: true, cleanupPending: false });
    fixture.response = (name) => name === 'getRun' ? Promise.resolve(value) : name === 'stop' ? stopping.promise : Promise.resolve({ rows: [value], nextCursor: null });
    fixture.controller.setActive({ missionId: 'mission-a', active: true, jobId: 'run-a' }); await wait(() => !$('stop').hidden);
    assert.isTrue($('cleanup').hidden); $('stop').click(); $('stop').click();
    assert.equal(fixture.calls.filter((call) => call.name === 'stop').length, 1); assert.isTrue($('stop').disabled);
    value = { ...value, status: 'unknown' }; stopping.resolve({});
    await wait(() => !$('environment').hidden); $('environment').click();
    assert.deepEqual(fixture.environments, ['mission-a']);
  });

  it('shows safe retryable failures without printing raw transport data', async () => {
    fixture.response = async () => { throw new Error('{"token":"private"}'); };
    fixture.controller.setActive({ missionId: 'mission-a', active: true }); await wait(() => $('notice').getAttribute('role') === 'alert');
    assert.include($('notice').textContent, 'Could not load runs'); assert.notInclude(fixture.root.textContent, 'private');
    fixture.response = async (name, args) => name === 'historyPage' ? { rows: [job()], nextCursor: null } : job(args.jobId);
    $('refresh').click(); await wait(() => fixture.root.querySelector('tbody tr'));
    fixture.connected = false; fixture.dependency.changed(); flush();
    assert.include($('notice').textContent, 'Connection lost'); assert.ok(fixture.root.querySelector('tbody tr'));
  });
});
