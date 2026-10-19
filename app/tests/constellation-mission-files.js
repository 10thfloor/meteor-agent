import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';

if (Meteor.isClient) describe('Mission Files browser', function () {
  this.timeout(8000);
  let initialize; let fixture;
  const field = (name) => fixture.root.querySelector(`[data-files="${name}"]`);
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const settle = async (check) => { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) assert.fail('Files did not settle'); Tracker.flush(); await new Promise((resolve) => setTimeout(resolve, 5)); } };
  const file = (id = 'file-a', patch = {}) => ({ id, _id: id, name: `${id}.txt`, size: 4, contentType: 'text/plain', origin: 'tool', ...patch });
  before(async () => { ({ initializeMissionFiles: initialize } = await import('../client/mission-files')); });
  beforeEach(() => {
    const root = document.createElement('div'); root.style.cssText = 'width:1000px;height:680px;'; document.body.append(root);
    fixture = { root, calls: [], downloads: [], runs: [], environmentCalls: [], online: true, account: 'test-owner', changed: new Tracker.Dependency(), environments: new Mongo.Collection(null), response: async () => ({ rows: [], nextCursor: null }) };
    fixture.controller = initialize({ root, userId: () => { fixture.changed.depend(); return fixture.account; }, environments: fixture.environments, config: () => fixture.config, openConnection: () => { fixture.connectionOpened = true; }, connected: () => { fixture.changed.depend(); return fixture.online; },
      method: async (name, input) => { fixture.calls.push({ name, input }); return fixture.response(name, input); },
      openRun: (...args) => fixture.runs.push(args), downloadFile: (value) => fixture.downloads.push(value), openEnvironment: (...args) => fixture.environmentCalls.push(args) });
  });
  afterEach(() => { fixture.controller.dispose(); fixture.root.remove(); Tracker.flush(); });

  it('reads saved uploads and results without contacting or allocating a Sprite', async () => {
    fixture.response = async (name) => name === 'missionFiles' ? { rows: [file('report', { name: '<report>.html', runId: 'run-one' })], nextCursor: null }
      : { name: '<report>.html', contentType: 'text/html', content: btoa('<script>window.unsafe = true</script>') };
    fixture.controller.open('mission-a', { location: 'saved' }); await settle(() => field('list').children.length === 1);
    assert.isNull(field('list').querySelector('report'));
    assert.include(field('list').textContent, 'Original');
    field('list').querySelector('button').click(); await settle(() => !!field('content').querySelector('code'));
    assert.isNull(field('content').querySelector('script')); assert.include(field('content').textContent, '<script>');
    assert.sameMembers(fixture.calls.map(({ name }) => name), ['missionFiles', 'getEnvironment', 'readMissionFile']);
    assert.isEmpty(fixture.downloads, 'selection opens a viewer instead of downloading');
    field('origin').click(); assert.deepEqual(fixture.runs, [['run-one', 'mission-a']]);
    field('download').click(); assert.lengthOf(fixture.downloads, 1);
  });

  it('uses the app’s compact control sizes and separates environment actions from locations', async () => {
    fixture.controller.open('mission-a', { location: 'saved' }); await settle(() => !field('refresh').disabled);
    assert.equal(getComputedStyle(field('working')).fontSize, '13px');
    assert.equal(field('working').textContent, 'Mission files'); assert.isNull(field('up')); assert.isNull(field('location'));
    const utilities = field('settings').closest('[role="group"]');
    assert.equal(utilities.getAttribute('aria-label'), 'Environment tools');
    assert.strictEqual(field('points').parentElement, utilities);
    for (const name of ['settings', 'points']) {
      const button = field(name);
      assert.isTrue(button.classList.contains('toolbar-button'));
      assert.isFalse(button.classList.contains('op-link'));
      assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
      assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
      assert.equal(getComputedStyle(button).textDecorationLine, 'none');
      assert.equal(getComputedStyle(button).fontSize, '12px');
      button.click();
    }
    assert.deepEqual(fixture.environmentCalls, [['mission-a', 'settings'], ['mission-a', 'points']]);
    assert.isNull(field('saved'));
    assert.deepEqual(fixture.calls.map(({ name }) => name), ['missionFiles', 'getEnvironment']);
  });

  it('keeps the icon-only download named, keyboard accessible and disabled until the file loads', async () => {
    const read = deferred();
    fixture.response = async (name) => name === 'missionFiles' ? { rows: [file('report', { name: 'report.csv' })], nextCursor: null }
      : name === 'getEnvironment' ? { status: 'not-created' } : read.promise;
    fixture.controller.open('mission-a', { location: 'saved' }); await settle(() => field('list').children.length === 1);
    field('list').querySelector('button').click();
    const download = field('download');
    assert.isTrue(download.disabled);
    assert.equal(download.textContent.trim(), '');
    assert.equal(download.getAttribute('aria-label'), 'Download report.csv');
    assert.equal(download.title, 'Download report.csv');
    assert.equal(download.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.isTrue(download.classList.contains('icon-only'));
    assert.equal(getComputedStyle(download).width, '34px');
    assert.equal(getComputedStyle(download).height, '34px');
    read.resolve({ name: 'report.csv', contentType: 'text/csv', content: btoa('a,b') });
    await settle(() => !download.disabled); download.focus();
    assert.strictEqual(document.activeElement, download);
    download.click(); assert.lengthOf(fixture.downloads, 1);
    assert.equal(getComputedStyle(field('viewer-name')).fontSize, '14px');
  });

  it('paginates saved files and opens an exact deep-linked file outside the loaded page', async () => {
    fixture.response = async (name, input) => name === 'readMissionFile' ? { name: 'older.txt', size: 3, content: btoa('old'), contentType: 'text/plain' }
      : input.cursor ? { rows: [file('older')], nextCursor: null } : { rows: [file()], nextCursor: 'next-page' };
    fixture.controller.open('mission-a', { attachmentId: 'older' }); await settle(() => field('content').textContent === 'old');
    assert.equal(field('viewer-name').textContent, 'older.txt'); assert.equal(fixture.calls.at(-1).input.attachmentId, 'older');
    field('more').click(); await settle(() => field('list').children.length === 2 && field('more').hidden && !field('refresh').disabled);
    assert.equal(fixture.calls.at(-1).input.cursor, 'next-page'); assert.isTrue(field('more').hidden);
  });

  it('browses working folders and displays source safely with download secondary', async () => {
    fixture.response = async (name, input) => name === 'getEnvironment' ? { missionId: input.missionId, status: 'ready', workspaceId: 'sprite' }
      : name === 'readEnvironmentFile' ? { name: 'main.py', contentType: 'text/x-python', content: btoa('print("hello")') }
        : input.path === '/workspace/src' ? { path: input.path, entries: [{ name: 'main.py', path: '/workspace/src/main.py', type: 'file', size: 14 }] }
          : { path: '/workspace', entries: [{ name: 'src', path: '/workspace/src', type: 'directory' }] };
    fixture.controller.open('mission-a', { location: 'working' }); await settle(() => field('list').children.length === 1);
    assert.equal(field('working').getAttribute('aria-current'), 'location'); field('list').querySelector('button').click(); await settle(() => field('path').textContent === '/workspace/src');
    field('list').querySelector('button').click(); await settle(() => field('content').textContent.includes('print'));
    assert.deepEqual(fixture.calls.at(-1), { name: 'readEnvironmentFile', input: { missionId: 'mission-a', path: '/workspace/src/main.py' } });
    assert.isEmpty(fixture.downloads); assert.isTrue(field('origin').hidden);
  });

  it('rejects stale listings and file content across mission and tab changes', async () => {
    const first = deferred(); const read = deferred();
    fixture.response = async (name, input) => name === 'readMissionFile' ? read.promise : input.missionId === 'mission-a' ? first.promise : { rows: [file('current')], nextCursor: null };
    fixture.controller.open('mission-a', { location: 'saved' }); fixture.controller.open('mission-b', { location: 'saved' }); await settle(() => field('list').textContent.includes('current'));
    first.resolve({ rows: [file('stale')], nextCursor: null }); await Promise.resolve(); await Promise.resolve();
    assert.notInclude(field('list').textContent, 'stale'); field('list').querySelector('button').click();
    fixture.controller.setActive({ missionId: 'mission-b', tab: 'chat' });
    read.resolve({ name: 'stale.txt', contentType: 'text/plain', content: btoa('stale response') }); await Promise.resolve(); await Promise.resolve();
    assert.notInclude(field('content').textContent, 'stale response'); assert.isEmpty(fixture.downloads);
  });

  it('uses read-only save-point paths and saves a copy without restoring current files', async () => {
    fixture.response = async (name) => name === 'getEnvironment' ? { status: 'ready', workspaceId: 'sprite', savePoints: [{ id: 'point-one', label: 'Before cleanup' }] }
      : name === 'environmentFiles' ? { path: '/workspace', entries: [{ name: 'old.txt', path: '/workspace/old.txt', type: 'file' }] }
        : { name: 'old.txt', content: btoa('old'), contentType: 'text/plain' };
    fixture.controller.open('mission-a', { location: 'working', savePointId: 'point-one' }); await settle(() => field('list').children.length === 1);
    assert.include(field('history-label').textContent, 'Before cleanup'); field('list').querySelector('button').click(); await settle(() => field('content').textContent === 'old');
    assert.equal(fixture.calls.at(-1).input.savePointId, 'point-one'); field('recover').click(); await settle(() => field('viewer-notice').textContent.includes('Copy restored'));
    assert.deepEqual(fixture.calls.at(-1), { name: 'recoverEnvironmentFile', input: { missionId: 'mission-a', path: '/workspace/old.txt', savePointId: 'point-one' } });
    assert.notInclude(fixture.calls.map(({ name }) => name), 'restoreSavePoint'); field('current').click(); await settle(() => fixture.calls.at(-1).name === 'environmentFiles' && !fixture.calls.at(-1).input.savePointId);
  });

  it('does not substitute current files when a save point cannot be mounted', async () => {
    fixture.response = async (name) => { if (name === 'getEnvironment') return { status: 'ready' }; throw { reason: 'This save point is not mounted. Restore the environment to use it.' }; };
    fixture.controller.open('mission-a', { savePointId: 'unmounted' }); await settle(() => field('notice').textContent.includes('not mounted'));
    assert.equal(field('notice').getAttribute('role'), 'alert'); assert.isEmpty(field('list').children);
    assert.equal(fixture.calls.at(-1).input.savePointId, 'unmounted'); assert.notInclude(fixture.calls.map(({ name }) => name), 'restoreSavePoint');
  });

  it('bounds text, never executes SVG, and gives unsupported binaries a download fallback', async () => {
    let result = { name: 'large.txt', contentType: 'text/plain', content: btoa('a'.repeat(200_100)) };
    fixture.response = async (name) => name === 'missionFiles' ? { rows: [file()], nextCursor: null } : result;
    fixture.controller.open('mission-a', { location: 'saved' }); await settle(() => field('list').children.length === 1);
    field('list').querySelector('button').click(); await settle(() => !field('download').disabled);
    assert.equal(field('content').querySelector('code').textContent.length, 200_000); assert.include(field('content').textContent, 'first 200 KB');
    result = { name: 'unsafe.svg', contentType: 'image/svg+xml', content: btoa('<svg onload="alert(1)"></svg>') };
    field('list').querySelector('button').click(); await settle(() => field('content').textContent.includes('<svg'));
    assert.isNull(field('content').querySelector('svg,img,iframe,object,embed'));
    result = { name: 'file.zip', contentType: 'application/zip', content: btoa('binary') };
    field('list').querySelector('button').click(); await settle(() => field('content').textContent.includes('can’t be displayed'));
    assert.isFalse(field('download').disabled);
  });

  it('shows reconnect and stale-file hints without silent remote rereads', async () => {
    const env = { _id: 'env', missionId: 'mission-a', status: 'ready', updatedAt: new Date(1000) }; fixture.environments.insert(env);
    fixture.response = async (name) => name === 'getEnvironment' ? env : { path: '/workspace', entries: [{ name: 'result.txt', path: '/workspace/result.txt', type: 'file' }] };
    fixture.controller.open('mission-a', { location: 'working' }); await settle(() => field('list').children.length === 1);
    fixture.environments.update('env', { $set: { updatedAt: new Date(2000), operationKind: 'read' } }); Tracker.flush();
    assert.isTrue(field('notice').hidden, 'read-lock timestamps do not invalidate freshly browsed files');
    fixture.environments.update('env', { $set: { updatedAt: new Date(3000), operationKind: 'run', currentJobId: 'new-run' } }); Tracker.flush();
    assert.include(field('notice').textContent, 'Refresh'); assert.lengthOf(fixture.calls.filter(({ name }) => name === 'environmentFiles'), 1);
    fixture.online = false; fixture.changed.changed(); Tracker.flush(); assert.include(field('notice').textContent, 'Reconnecting'); assert.isTrue(field('refresh').disabled);
    fixture.controller.setActive({ missionId: 'mission-b', tab: 'chat' }); fixture.online = true; fixture.changed.changed(); Tracker.flush();
    assert.lengthOf(fixture.calls, 3, 'chat selection does not read or wake a Sprite');
  });

  it('keeps the folder and selected file when returning from Chat without another Sprite read', async () => {
    fixture.response = async (name, input) => name === 'getEnvironment' ? { status: 'ready', workspaceId: 'sprite' }
      : name === 'readEnvironmentFile' ? { name: 'main.py', content: btoa('print(1)'), contentType: 'text/plain' }
        : input.path === '/workspace/src' ? { path: input.path, entries: [{ name: 'main.py', path: '/workspace/src/main.py', type: 'file' }] }
          : { path: '/workspace', entries: [{ name: 'src', path: '/workspace/src', type: 'directory' }] };
    fixture.controller.open('mission-a', { location: 'working' }); await settle(() => field('list').children.length === 1);
    field('list').querySelector('button').click(); await settle(() => field('path').textContent === '/workspace/src');
    field('list').querySelector('button').click(); await settle(() => field('content').textContent === 'print(1)');
    const count = fixture.calls.length; fixture.controller.setActive({ missionId: 'mission-a', tab: 'chat' });
    fixture.controller.setActive({ missionId: 'mission-a', tab: 'files' }); await Promise.resolve();
    assert.equal(field('path').textContent, '/workspace/src'); assert.equal(field('viewer-name').textContent, 'main.py');
    assert.equal(field('content').textContent, 'print(1)'); assert.lengthOf(fixture.calls, count);
  });

  it('keeps recovery scoped and cannot strand the next selection in a pending state', async () => {
    const recovery = deferred(); fixture.response = async (name) => name === 'getEnvironment' ? { status: 'ready' }
      : name === 'environmentFiles' ? { entries: [{ name: 'a.txt', path: '/workspace/a.txt', type: 'file' }, { name: 'b.txt', path: '/workspace/b.txt', type: 'file' }] }
        : name === 'recoverEnvironmentFile' ? recovery.promise : { name: 'a.txt', content: btoa('a'), contentType: 'text/plain' };
    fixture.controller.open('mission-a', { savePointId: 'point' }); await settle(() => field('list').children.length === 2);
    field('list').querySelector('button').click(); await settle(() => !field('download').disabled); field('recover').click();
    const other = field('list').querySelectorAll('button')[1]; assert.isTrue(other.disabled); other.click();
    assert.equal(field('viewer-name').textContent, 'a.txt'); recovery.resolve({}); await settle(() => !field('recover').disabled);
    assert.isFalse(other.disabled); assert.equal(field('recover').textContent, 'Restore a copy'); assert.isFalse(field('refresh').disabled);
  });


  const working = (name = 'report.txt', patch = {}) => ({ name, path: `/workspace/${name}`, type: 'file', writable: true, size: 4, ...patch });
  const ready = (patch = {}) => ({ status: 'ready', keepFiles: true, workspaceId: 'sprite', fileRevision: 1, ...patch });
  const fileRead = (entry = working(), text = 'original', hash = 'original-hash') => ({ ...entry, contentType: 'text/plain', content: btoa(text), hash });
  const mutations = () => fixture.calls.filter(({ name }) => name === 'mutateEnvironmentFile');
  const submit = () => field('action-body').querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const rename = (name) => { field('rename-name').value = name; field('rename-name').dispatchEvent(new Event('input', { bubbles: true })); field('rename-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); };
  const typeEdit = (text) => { field('editor').value = text; field('editor').dispatchEvent(new Event('input', { bubbles: true })); };
  const mockWorking = (files = [working()]) => { fixture.response = async (name) => name === 'getEnvironment' ? ready() : name === 'environmentFiles' ? { path: '/workspace', entries: files } : fileRead(files[0]); };
  const mockMutableWorking = (initial = [working()]) => {
    let files = [...initial];
    fixture.response = async (name, input) => {
      if (name === 'missionFiles') return { rows: [] };
      if (name === 'getEnvironment') return ready();
      if (name === 'environmentFiles') return { path: input.path, entries: files.filter((entry) => entry.path.slice(0, entry.path.lastIndexOf('/')) === input.path) };
      if (name === 'readEnvironmentFile') {
        const entry = files.find((row) => row.path === input.path); assert.exists(entry, `Unexpected read: ${input.path}`);
        return fileRead(entry, entry.text || entry.name);
      }
      if (name === 'mutateEnvironmentFile') {
        const prior = files.find((row) => row.path === input.path);
        if (input.action === 'delete') { files = files.filter((row) => row !== prior); return {}; }
        const path = input.destination || input.path;
        const entry = working(path.slice(path.lastIndexOf('/') + 1), { ...prior, path, name: path.slice(path.lastIndexOf('/') + 1), ...(input.text === undefined ? {} : { text: input.text }) });
        if (['rename', 'move', 'write'].includes(input.action)) files = files.filter((row) => row !== prior);
        files.push(entry); return { entry };
      }
      assert.fail(`Unexpected file method: ${name}`);
    };
  };
  const pickUpload = (name = 'uploaded.txt') => {
    field('upload-input').click = () => {}; field('upload').click();
    const transfer = new DataTransfer(); transfer.items.add(new File(['uploaded'], name, { type: 'text/plain' }));
    field('upload-input').files = transfer.files; field('upload-input').dispatchEvent(new Event('change'));
    submit();
  };
  const openWorking = async () => { fixture.controller.open('mission-a'); await settle(() => field('list').children.length > 0 && !field('refresh').disabled); };
  const openWorkingFile = async () => { await openWorking(); field('list').querySelector('[data-file-key]').click(); await settle(() => !field('download').disabled); };

  it('defaults to Sprite files without provisioning on view or requiring code execution', async () => {
    fixture.config = { providerConfigured: true, enabled: false, connectionStatus: 'connected' }; fixture.response = async () => ({ status: 'not-created' });
    fixture.controller.open('mission-a'); await settle(() => !field('enable-panel').hidden);
    assert.deepEqual(fixture.calls, [{ name: 'missionFiles', input: { missionId: 'mission-a', limit: 50 } }, { name: 'getEnvironment', input: { missionId: 'mission-a' } }]);
    assert.equal(field('working').getAttribute('aria-pressed'), 'true'); assert.isNull(field('saved'));
    assert.include(field('enable-hint').textContent, 'charges'); assert.equal(field('enable').textContent, 'Enable mission filesystem'); assert.isNull(field('trash')); assert.isNull(field('file-history'));
  });
  it('centers the filesystem action beneath its heading and hint', async () => {
    fixture.response = async () => ({ status: 'not-created' });
    fixture.controller.open('mission-a'); await settle(() => !field('enable-panel').hidden);
    for (const width of [800, 1200]) {
      fixture.root.style.width = `${width}px`;
      for (const label of ['Enable mission filesystem', 'Connect Sprites', 'Creating filesystem…']) {
        field('enable').textContent = label;
        const button = field('enable').getBoundingClientRect();
        const heading = field('enable-panel').querySelector('h3').getBoundingClientRect();
        assert.closeTo(button.x + button.width / 2, heading.x + heading.width / 2, 1);
      }
    }
  });
  it('enables only after a click with loading and duplicate-request protection', async () => {
    const pending = deferred(); let enabled = false;
    fixture.response = async (name) => name === 'enableFilesystem' ? pending.promise : name === 'getEnvironment' ? enabled ? ready() : { status: 'not-created' } : { path: '/workspace', entries: [] };
    fixture.controller.open('mission-a'); await settle(() => !field('enable-panel').hidden); field('enable').click(); field('enable').click();
    assert.isTrue(field('enable').disabled); assert.equal(field('enable').dataset.loading, 'true'); assert.lengthOf(fixture.calls.filter(({ name }) => name === 'enableFilesystem'), 1);
    enabled = true; pending.resolve(ready()); await settle(() => field('enable-panel').hidden && !field('refresh').disabled);
    assert.deepEqual(fixture.calls.at(-1), { name: 'environmentFiles', input: { missionId: 'mission-a', path: '/workspace' } });
  });
  it('opens connection settings instead of provisioning without credentials', async () => {
    fixture.config = { providerConfigured: false }; fixture.response = async () => ({ status: 'not-created' });
    fixture.controller.open('mission-a'); await settle(() => !field('enable-panel').hidden); assert.equal(field('enable').textContent, 'Connect Sprites'); field('enable').click();
    assert.isTrue(fixture.connectionOpened); assert.deepEqual(fixture.calls.map(({ name }) => name), ['missionFiles', 'getEnvironment']);
  });
  it('makes original attachments and preserved copies read-only', async () => {
    const old = file('legacy:old', { legacyEntryId: 'old', legacy: true, legacyPath: '/notes/old.txt' });
    fixture.response = async (name) => name === 'missionFiles' ? { rows: [old] } : { ...old, content: btoa('preserved') };
    fixture.controller.open('mission-a', { location: 'existing' }); await settle(() => field('list').children.length === 1); field('list').querySelector('button').click(); await settle(() => !field('download').disabled);
    assert.deepEqual(fixture.calls.at(-1).input, { missionId: 'mission-a', legacyEntryId: 'old' });
    assert.include(field('viewer-meta').textContent, 'Existing file'); assert.notInclude(field('viewer-meta').textContent, 'Waiting to move'); assert.include(field('viewer-meta').textContent, '/notes/old.txt');
    assert.include(field('list').textContent, 'Preserved copy');
    for (const name of ['edit', 'file-actions', 'new-folder', 'new-file', 'upload']) assert.isTrue(field(name).hidden);
    assert.isNull(field('list').querySelector('[data-file-actions]')); assert.sameMembers(fixture.calls.map(({ name }) => name), ['missionFiles', 'getEnvironment', 'readMissionFile']);
  });
  it('creates folders and files directly in the Sprite directory', async () => {
    fixture.response = async (name, input) => name === 'getEnvironment' ? ready() : name === 'environmentFiles' ? { path: '/workspace', entries: [] } : { action: input.action, path: input.path };
    fixture.controller.open('mission-a'); await settle(() => !field('new').disabled); field('new').click(); field('new-folder').click(); field('action-name').value = 'notes'; submit(); await settle(() => mutations().length === 1 && !field('refresh').disabled); field('new').click(); field('new-file').click(); field('action-name').value = 'notes.txt'; submit(); await settle(() => mutations().length === 2);
    assert.deepEqual(mutations().map(({ input }) => input), [{ missionId: 'mission-a', action: 'createFolder', path: '/workspace/notes' }, { missionId: 'mission-a', action: 'write', path: '/workspace/notes.txt', text: '' }]);
  });
  it('uploads bytes to the Sprite and preserves readable errors', async () => {
    fixture.response = async (name) => { if (name === 'mutateEnvironmentFile') throw { message: '{"secret":"private"}' }; return name === 'getEnvironment' ? ready() : { path: '/workspace', entries: [] }; };
    fixture.controller.open('mission-a'); await settle(() => !field('upload').disabled); const transfer = new DataTransfer(); transfer.items.add(new File(['hello'], 'hello.txt', { type: 'text/plain' })); field('upload-input').click = () => {}; field('upload').click(); field('upload-input').files = transfer.files; field('upload-input').dispatchEvent(new Event('change')); submit(); await settle(() => !field('action-error').hidden);
    assert.deepEqual(mutations()[0].input, { missionId: 'mission-a', path: '/workspace/hello.txt', action: 'upload', content: btoa('hello'), contentType: 'text/plain' }); assert.notInclude(field('action-error').textContent, 'private'); assert.include(field('action-error').textContent, 'Try again'); assert.equal(field('action-name').value, 'hello.txt');
  });
  it('requires save or discard before leaving dirty edits', async () => {
    mockWorking([working('a.txt'), working('b.txt')]); await openWorkingFile(); field('edit').click(); typeEdit('draft changes'); field('list').querySelector('[data-file-key="/workspace/b.txt"]').click(); assert.include(field('action-title').textContent, 'Save changes'); assert.lengthOf(fixture.calls.filter(({ name }) => name === 'readEnvironmentFile'), 1);
    field('keep-editing').click(); assert.equal(field('editor').value, 'draft changes'); assert.strictEqual(document.activeElement, field('editor')); field('refresh').click(); field('discard-edits').click(); await settle(() => !field('refresh').disabled); assert.isNull(field('editor')); assert.isTrue(field('draft-banner').hidden);
  });
  it('locks duplicate saves and uses the original content hash', async () => {
    const pending = deferred(); let text = 'original'; fixture.response = async (name) => name === 'missionFiles' ? { rows: [], migration: { remaining: 0 } } : name === 'getEnvironment' ? ready() : name === 'environmentFiles' ? { path: '/workspace', entries: [working()] } : name === 'readEnvironmentFile' ? fileRead(working(), text) : pending.promise;
    await openWorkingFile(); field('edit').click(); typeEdit('updated'); field('save-edit').click(); field('save-edit').click(); assert.isTrue(field('editor').disabled); assert.equal(field('save-edit').dataset.loading, 'true'); assert.lengthOf(mutations(), 1); assert.deepEqual(mutations()[0].input, { missionId: 'mission-a', path: '/workspace/report.txt', action: 'write', text: 'updated', expectedHash: 'original-hash' });
    text = 'updated'; pending.resolve({ entry: working() }); await settle(() => !field('editor') && field('content').textContent === 'updated');
  });
  it('keeps conflicting drafts across missions with their original hash and draft download', async () => {
    let hash = 'original-hash'; fixture.response = async (name, input) => { if (name === 'mutateEnvironmentFile') throw { reason: 'This file changed after you opened it. Reload before saving.' }; return name === 'getEnvironment' ? ready() : name === 'readEnvironmentFile' ? fileRead(working(), 'original', hash) : { path: '/workspace', entries: input.missionId === 'mission-a' ? [working()] : [] }; };
    await openWorkingFile(); field('edit').click(); typeEdit('my changes'); fixture.controller.open('mission-b'); await settle(() => !field('refresh').disabled); hash = 'new-hash'; fixture.controller.open('mission-a'); await settle(() => !field('draft-banner').hidden && !field('refresh').disabled); field('resume-draft').click(); await settle(() => !!field('editor')); field('save-edit').click(); await settle(() => field('viewer-notice').textContent.includes('changed')); assert.equal(mutations()[0].input.expectedHash, 'original-hash'); assert.equal(field('editor').value, 'my changes'); field('download-draft').click(); assert.equal(atob(fixture.downloads[0].content), 'my changes');
  });
  it('renames, moves and copies using exact Sprite paths without overwrite flags', async () => {
    fixture.response = async (name, input) => name === 'getEnvironment' ? ready() : name === 'environmentFiles' ? { path: input.path, entries: input.path === '/workspace' ? [working(), working('archive', { type: 'directory' })] : [] } : fileRead();
    await openWorking(); field('list').querySelector('[data-file-key="/workspace/report.txt"]').click(); await settle(() => !field('download').disabled);
    for (const [action, destination] of [['rename', '/workspace/renamed.txt'], ['move', '/workspace/archive/report.txt'], ['copy', '/workspace/copy.txt']]) {
      field('file-actions').click(); field(action + '-file').click(); const before = mutations().length;
      if (action === 'rename') rename('renamed.txt');
      else {
        if (action === 'move') { field('destination-folders').querySelector('[data-destination-folder="/workspace/archive"]').click(); await settle(() => !field('submit-action').disabled); }
        else field('destination-name').value = 'copy.txt';
        submit();
      }
      await settle(() => mutations().length === before + 1 && !field('refresh').disabled);
      const change = mutations().at(-1).input; assert.equal(change.action, action); assert.equal(change.path, '/workspace/report.txt'); assert.equal(change.destination, destination); assert.notProperty(change, 'overwrite');
      field('list').querySelector('[data-file-key="/workspace/report.txt"]').click(); await settle(() => !field('download').disabled);
    }
  });
  it('deletes only after permanent deletion is explicitly confirmed', async () => {
    mockWorking([working('notes', { type: 'directory' })]); await openWorking(); field('list').querySelector('[data-file-actions]').click(); field('delete-file').click(); assert.include(field('action-body').textContent, 'everything inside'); assert.include(field('action-body').textContent, 'cannot be undone'); assert.isEmpty(mutations()); field('close-action').click(); assert.isEmpty(mutations()); field('list').querySelector('[data-file-actions]').click(); field('delete-file').click(); field('confirm-delete').click(); await settle(() => mutations().length === 1); assert.deepEqual(mutations()[0].input, { missionId: 'mission-a', path: '/workspace/notes', action: 'delete', confirm: true });
  });
  it('keeps app-managed files and save points read-only', async () => {
    fixture.response = async (name) => name === 'getEnvironment' ? ready() : name === 'environmentFiles' ? { path: '/workspace', entries: [working('input.txt', { path: '/workspace/inputs/input.txt', writable: false })] } : fileRead(working('input.txt', { path: '/workspace/inputs/input.txt', writable: false }));
    await openWorkingFile(); assert.isTrue(field('edit').disabled); field('file-actions').click(); assert.include(field('row-menu').textContent, 'Read-only'); assert.isNull(field('delete-file')); fixture.controller.open('mission-a', { savePointId: 'point' }); await settle(() => !field('refresh').disabled); field('list').querySelector('[data-file-key]').click(); await settle(() => !field('download').disabled);
    for (const name of ['edit', 'file-actions', 'new-folder', 'new-file', 'upload']) assert.isTrue(field(name).hidden); assert.isEmpty(mutations());
  });
  it('copies a managed snapshot into a working path only while the filesystem is enabled', async () => {
    const entry = working('report.txt', { path: '/workspace/attachments/report.txt', writable: false });
    fixture.environments.insert({ _id: 'env', missionId: 'mission-a', ...ready() });
    fixture.response = async (name) => name === 'missionFiles' ? { rows: [], migration: { remaining: 0 } } : name === 'getEnvironment' ? ready()
      : name === 'environmentFiles' ? { path: '/workspace/attachments', entries: [entry] } : name === 'readEnvironmentFile' ? fileRead(entry) : {};
    await openWorkingFile(); assert.isTrue(field('edit').disabled); assert.isFalse(field('file-actions').disabled); field('file-actions').click();
    for (const action of ['rename-file', 'move-file', 'delete-file']) assert.isNull(field(action));
    assert.isFalse(field('copy-file').disabled); fixture.environments.update('env', { $set: { keepFiles: false } }); Tracker.flush(); assert.isTrue(field('copy-file').disabled);
    fixture.environments.update('env', { $set: { keepFiles: true } }); Tracker.flush(); field('copy-file').click(); await settle(() => !field('submit-action').disabled); assert.equal(field('destination-name').value, 'report.txt'); assert.include(field('destination-breadcrumbs').textContent, 'Mission files');
    fixture.environments.update('env', { $set: { keepFiles: false } }); Tracker.flush(); assert.isTrue(field('submit-action').disabled); submit(); assert.isEmpty(mutations());
    fixture.environments.update('env', { $set: { keepFiles: true } }); Tracker.flush(); submit(); await settle(() => mutations().length === 1 && !field('refresh').disabled);
    assert.deepEqual(mutations()[0].input, { missionId: 'mission-a', action: 'copy', path: '/workspace/attachments/report.txt', destination: '/workspace/report.txt' });
  });
  it('shows agent file changes without waking Sprites or replacing dirty edits', async () => {
    fixture.environments.insert({ _id: 'env', missionId: 'mission-a', ...ready() }); mockWorking(); await openWorkingFile(); field('edit').click(); typeEdit('unsaved'); const count = fixture.calls.length; fixture.environments.update('env', { $set: { fileRevision: 2 } }); Tracker.flush(); assert.include(field('notice').textContent, 'Refresh'); assert.equal(field('editor').value, 'unsaved'); assert.lengthOf(fixture.calls, count);
  });
  it('disables saving while the mission filesystem is turned off without losing the draft', async () => {
    fixture.environments.insert({ _id: 'env', missionId: 'mission-a', ...ready() }); mockWorking(); await openWorkingFile(); field('edit').click(); typeEdit('unsaved');
    fixture.environments.update('env', { $set: { keepFiles: false } }); Tracker.flush();
    assert.isTrue(field('save-edit').disabled); assert.include(field('editor-state').textContent, 'Edits kept'); assert.equal(field('editor').value, 'unsaved');
    field('save-edit').click(); assert.isEmpty(mutations()); assert.isFalse(field('download-draft').disabled);
    fixture.environments.update('env', { $set: { keepFiles: true } }); Tracker.flush(); assert.isFalse(field('save-edit').disabled); assert.equal(field('editor').value, 'unsaved');
  });
  it('ignores a mutation that completes after switching missions', async () => {
    const pending = deferred(); fixture.response = async (name, input) => name === 'missionFiles' ? { rows: [], migration: { remaining: 0 } } : name === 'getEnvironment' ? ready() : name === 'environmentFiles' ? { path: '/workspace', entries: input.missionId === 'mission-a' ? [working()] : [] } : name === 'readEnvironmentFile' ? fileRead() : pending.promise;
    await openWorkingFile(); field('file-actions').click(); field('rename-file').click(); rename('renamed.txt'); fixture.controller.open('mission-b'); await settle(() => !field('refresh').disabled); pending.resolve({ entry: working('renamed.txt') }); await Promise.resolve(); await Promise.resolve(); assert.isEmpty(field('list').children); assert.isTrue(field('action-panel').hidden); assert.notInclude(field('viewer-name').textContent, 'renamed');
  });
  it('opens a chat file reference in its Sprite directory rather than a separate storage view', async () => {
    const path = '/workspace/attachments/report.txt';
    fixture.response = async (name) => name === 'missionFiles' ? { rows: [file('linked', { path, storage: 'sprite', needsMigration: false, runId: 'run-one' })], migration: { remaining: 0 } }
      : name === 'getEnvironment' ? ready() : name === 'readMissionFile' ? { name: 'report.txt', content: btoa('linked file'), contentType: 'text/plain', storage: 'sprite', path }
        : { path: '/workspace/attachments', entries: [working('report.txt', { path, writable: false })] };
    fixture.controller.open('mission-a', { attachmentId: 'linked' }); await settle(() => field('content').textContent === 'linked file' && !field('download').disabled);
    assert.include(field('breadcrumbs').textContent, 'Mission files'); assert.equal(field('path').textContent, '/workspace/attachments');
    assert.equal(field('list').querySelector('[data-file-key]').dataset.fileKey, path); assert.isNull(field('migration'));
    assert.isNull(fixture.root.querySelector('.mission-files-locations [data-files="saved"]')); assert.isTrue(field('edit').disabled);
    field('origin').click(); assert.deepEqual(fixture.runs, [['run-one', 'mission-a']]);
  });
  it('opens a working-file deep link by browsing its parent and selecting the exact file', async () => {
    const entry = working('Uploaded notes.txt', { path: '/workspace/research/Uploaded notes.txt' });
    fixture.response = async (name, input) => name === 'missionFiles' ? { rows: [] } : name === 'getEnvironment' ? ready()
      : name === 'environmentFiles' ? { path: input.path, entries: [entry] } : fileRead(entry, 'uploaded text');
    fixture.controller.open('mission-a', { filePath: entry.path, location: 'working', savePointId: null });
    await settle(() => field('content').textContent === 'uploaded text' && !field('download').disabled);
    assert.deepEqual(fixture.calls.filter(({ name }) => name === 'environmentFiles'), [{ name: 'environmentFiles', input: { missionId: 'mission-a', path: '/workspace/research' } }]);
    assert.deepEqual(fixture.calls.at(-1), { name: 'readEnvironmentFile', input: { missionId: 'mission-a', path: entry.path } });
    assert.equal(field('viewer-name').textContent, entry.name); assert.equal(field('path').textContent, '/workspace/research');
    assert.equal(field('list').querySelector('[data-file-key]').getAttribute('aria-pressed'), 'true'); assert.isEmpty(mutations());
  });
  it('reads an exact working-file link even when it is absent from the bounded folder listing', async () => {
    fixture.response = async (name, input) => name === 'missionFiles' ? { rows: [] } : name === 'getEnvironment' ? ready()
      : name === 'environmentFiles' ? { path: input.path, entries: [working('different.txt')] } : fileRead(working('linked.txt'), 'linked contents');
    fixture.controller.open('mission-a', { filePath: '/workspace/linked.txt' });
    await settle(() => field('content').textContent === 'linked contents');
    assert.equal(fixture.calls.at(-1).input.path, '/workspace/linked.txt'); assert.equal(field('viewer-name').textContent, 'linked.txt');
    assert.isEmpty(fixture.downloads); assert.isEmpty(mutations());
  });
  it('does not reuse a previously viewed save point for a current working-file link', async () => {
    const entry = working('current.txt');
    fixture.response = async (name, input) => name === 'missionFiles' ? { rows: [] } : name === 'getEnvironment' ? ready()
      : name === 'environmentFiles' ? { path: input.path, entries: [entry] } : fileRead(entry, input.savePointId ? 'historical' : 'current');
    fixture.controller.open('mission-a', { savePointId: 'before-change' }); await settle(() => !field('refresh').disabled);
    fixture.controller.open('mission-a', { filePath: entry.path, location: 'working', savePointId: null });
    await settle(() => field('content').textContent === 'current');
    assert.isTrue(field('history').hidden); assert.notProperty(fixture.calls.at(-1).input, 'savePointId'); assert.isEmpty(mutations());
  });
  it('guards dirty file edits when following a composer link back from Chat', async () => {
    const original = working('original.txt'); const linked = working('linked.txt', { path: '/workspace/research/linked.txt' });
    fixture.response = async (name, input) => name === 'missionFiles' ? { rows: [] } : name === 'getEnvironment' ? ready()
      : name === 'environmentFiles' ? { path: input.path, entries: input.path === '/workspace/research' ? [linked] : [original] }
        : fileRead(input.path === linked.path ? linked : original, input.path === linked.path ? 'linked text' : 'original');
    await openWorkingFile(); field('edit').click(); typeEdit('keep this draft');
    fixture.controller.setActive({ missionId: 'mission-a', tab: 'chat' });
    const count = fixture.calls.length;
    fixture.controller.open('mission-a', { filePath: linked.path, location: 'working', savePointId: null });
    assert.include(field('action-title').textContent, 'Save changes'); assert.equal(field('editor').value, 'keep this draft'); assert.lengthOf(fixture.calls, count);
    field('keep-editing').click(); assert.equal(field('editor').value, 'keep this draft');
    fixture.controller.open('mission-a', { filePath: linked.path }); field('discard-edits').click();
    await settle(() => field('content').textContent === 'linked text');
    assert.equal(field('path').textContent, '/workspace/research'); assert.isTrue(field('draft-banner').hidden); assert.isEmpty(mutations());
  });
  it('ignores a deep-link read that finishes after a different mission is opened', async () => {
    const pending = deferred(); const entry = working('linked.txt');
    fixture.response = async (name, input) => name === 'missionFiles' ? { rows: [] } : name === 'getEnvironment' ? ready()
      : name === 'environmentFiles' ? { path: input.path, entries: [entry] }
        : input.missionId === 'mission-a' ? pending.promise : fileRead(entry, 'new mission');
    fixture.controller.open('mission-a', { filePath: entry.path }); await settle(() => fixture.calls.some(({ name }) => name === 'readEnvironmentFile'));
    fixture.controller.open('mission-b', { filePath: entry.path }); await settle(() => field('content').textContent === 'new mission');
    pending.resolve(fileRead(entry, 'old mission')); await Promise.resolve(); await Promise.resolve();
    assert.equal(field('content').textContent, 'new mission'); assert.equal(fixture.calls.at(-1).input.missionId, 'mission-b'); assert.isEmpty(mutations());
  });
  it('rejects invalid working-file deep links before reading a remote path', async () => {
    for (const filePath of ['/etc/passwd', '/workspace', '/workspace/../private', '/workspace/folder/', '/workspace/.constellation-secret/file', '/workspace/a\\b.txt']) {
      fixture.controller.open('mission-a', { filePath });
      assert.include(field('notice').textContent, '/workspace');
    }
    assert.isEmpty(fixture.calls); assert.isEmpty(fixture.downloads);
  });
  it('keeps one-time migration controls out of Files even when legacy records exist', async () => {
    fixture.response = async (name) => name === 'missionFiles' ? { rows: [], migration: { remaining: 14 } } : name === 'getEnvironment' ? ready() : { path: '/workspace', entries: [] };
    fixture.controller.open('mission-a'); await settle(() => !field('refresh').disabled);
    for (const name of ['migration', 'migrate', 'saved', 'confirm-migrate']) assert.isNull(field(name));
    assert.notInclude(fixture.root.textContent, 'Move existing files');
    assert.notInclude(fixture.calls.map(({ name }) => name), 'migrateMissionFiles');
    assert.equal(field('working').textContent, 'Mission files');
  });
  it('gates uploads on explicit filesystem enablement even when old files exist', async () => {
    fixture.response = async (name) => name === 'missionFiles' ? { rows: [file('old', { needsMigration: true, storage: 'database' })], migration: { remaining: 1 } } : { status: 'not-created', keepFiles: false };
    fixture.controller.open('mission-a'); await settle(() => !field('enable-panel').hidden);
    assert.isTrue(field('upload').disabled); assert.include(field('enable-hint').textContent, 'before uploading'); assert.isNull(field('migrate'));
    assert.notInclude(fixture.calls.map(({ name }) => name), 'enableFilesystem'); assert.notInclude(fixture.calls.map(({ name }) => name), 'migrateMissionFiles');
  });
  it('shows a useful unavailable-file error for an absent Sprite without falling back to local bytes', async () => {
    fixture.response = async (name) => {
      if (name === 'missionFiles') return { rows: [], migration: { remaining: 0 } };
      if (name === 'getEnvironment') return { status: 'not-created' };
      throw { reason: 'This file’s Sprite is unavailable. Check Mission filesystem.' };
    };
    fixture.controller.open('mission-a', { attachmentId: 'missing' }); await settle(() => field('notice').textContent.includes('Sprite is unavailable'));
    assert.isTrue(field('download').disabled); assert.isFalse(field('enable-panel').hidden); assert.isEmpty(field('content').children);
  });

  it('keeps the list full width until preview opens and closing preserves the folder without rereading', async () => {
    const entry = working('notes.txt', { path: '/workspace/research/notes.txt' });
    fixture.response = async (name, input) => name === 'getEnvironment' ? ready() : name === 'environmentFiles' ? { path: input.path, entries: [entry] } : fileRead(entry);
    fixture.controller.open('mission-a', { path: '/workspace/research' }); await settle(() => !field('refresh').disabled);
    const split = fixture.root.querySelector('.mission-files-split'), listPane = fixture.root.querySelector('.mission-files-list-pane'), viewer = fixture.root.querySelector('.mission-file-viewer');
    assert.isTrue(viewer.hidden); assert.closeTo(listPane.getBoundingClientRect().width, split.getBoundingClientRect().width, 1);
    assert.include(field('breadcrumbs').textContent, 'Mission files'); assert.include(field('breadcrumbs').textContent, 'research');
    field('list').querySelector('[data-file-key]').click(); await settle(() => !field('download').disabled);
    assert.isFalse(viewer.hidden); assert.isBelow(listPane.getBoundingClientRect().width, split.getBoundingClientRect().width);
    const count = fixture.calls.length; field('close-preview').click();
    assert.isTrue(viewer.hidden); assert.equal(field('path').textContent, '/workspace/research'); assert.lengthOf(fixture.calls, count);
    assert.strictEqual(document.activeElement, field('list').querySelector('[data-file-key]'));
    assert.closeTo(listPane.getBoundingClientRect().width, split.getBoundingClientRect().width, 1);
  });

  it('keeps row-only rename, copy and upload in the full-width list without reading their returned files', async () => {
    mockMutableWorking(); await openWorking();
    const viewer = fixture.root.querySelector('.mission-file-viewer');
    field('list').querySelector('[data-file-actions]').click(); field('rename-file').click(); rename('renamed.txt');
    await settle(() => mutations().length === 1 && !field('refresh').disabled && !!field('list').querySelector('[data-file-key="/workspace/renamed.txt"]'));
    assert.isTrue(viewer.hidden);
    field('list').querySelector('[data-file-actions="/workspace/renamed.txt"]').click(); field('copy-file').click();
    field('destination-name').value = 'copy.txt'; submit();
    await settle(() => mutations().length === 2 && !field('refresh').disabled && !!field('list').querySelector('[data-file-key="/workspace/copy.txt"]'));
    assert.isTrue(viewer.hidden);
    pickUpload(); await settle(() => mutations().length === 3 && !field('refresh').disabled && !!field('list').querySelector('[data-file-key="/workspace/uploaded.txt"]'));
    assert.isTrue(viewer.hidden); assert.equal(fixture.root.querySelector('.mission-files-split').dataset.preview, 'false');
    assert.isEmpty(fixture.calls.filter(({ name }) => name === 'readEnvironmentFile'));
  });

  it('keeps the current preview through copy and upload but follows its own rename', async () => {
    mockMutableWorking(); await openWorkingFile();
    const beforeReads = fixture.calls.filter(({ name }) => name === 'readEnvironmentFile').length;
    field('file-actions').click(); field('copy-file').click(); field('destination-name').value = 'copy.txt'; submit();
    await settle(() => mutations().length === 1 && !field('refresh').disabled && field('viewer-name').textContent === 'report.txt');
    assert.equal(field('content').textContent, 'report.txt');
    assert.lengthOf(fixture.calls.filter(({ name }) => name === 'readEnvironmentFile'), beforeReads);
    pickUpload(); await settle(() => mutations().length === 2 && !field('refresh').disabled && field('viewer-name').textContent === 'report.txt');
    assert.equal(field('content').textContent, 'report.txt');
    assert.lengthOf(fixture.calls.filter(({ name }) => name === 'readEnvironmentFile'), beforeReads);
    field('file-actions').click(); field('rename-file').click(); rename('renamed.txt');
    await settle(() => mutations().length === 3 && !field('download').disabled && field('viewer-name').textContent === 'renamed.txt');
    assert.equal(fixture.calls.at(-1).input.path, '/workspace/renamed.txt');
    assert.equal(field('list').querySelector('[data-file-key="/workspace/renamed.txt"]').getAttribute('aria-pressed'), 'true');
  });

  it('does not replace an open preview when a different file is renamed or deleted', async () => {
    mockMutableWorking([working(), working('other.txt')]); await openWorking();
    field('list').querySelector('[data-file-key="/workspace/report.txt"]').click(); await settle(() => !field('download').disabled);
    field('list').querySelector('[data-file-actions="/workspace/other.txt"]').click(); field('rename-file').click(); rename('other-renamed.txt');
    await settle(() => mutations().length === 1 && !field('refresh').disabled && field('viewer-name').textContent === 'report.txt');
    field('list').querySelector('[data-file-actions="/workspace/other-renamed.txt"]').click(); field('delete-file').click(); field('confirm-delete').click();
    await settle(() => mutations().length === 2 && !field('refresh').disabled && field('viewer-name').textContent === 'report.txt');
    assert.equal(field('content').textContent, 'report.txt'); assert.lengthOf(fixture.calls.filter(({ name }) => name === 'readEnvironmentFile'), 1);
    field('file-actions').click(); field('delete-file').click(); field('confirm-delete').click();
    await settle(() => mutations().length === 3 && !field('refresh').disabled);
    assert.isTrue(fixture.root.querySelector('.mission-file-viewer').hidden); assert.isEmpty(field('content').textContent);
  });

  it('opens a deliberately created New file and keeps the saved editor result in view', async () => {
    mockMutableWorking(); await openWorking(); field('new').click(); field('new-file').click(); field('action-name').value = 'new.txt'; submit();
    await settle(() => field('viewer-name').textContent === 'new.txt' && !field('download').disabled);
    assert.isFalse(fixture.root.querySelector('.mission-file-viewer').hidden);
    field('edit').click(); typeEdit('new contents'); field('save-edit').click();
    await settle(() => !field('editor') && field('content').textContent === 'new contents');
    assert.equal(field('viewer-name').textContent, 'new.txt'); assert.equal(mutations().at(-1).input.expectedHash, 'original-hash');
  });

  it('does not restore a prior preview over a newer deep link while mutation refresh is pending', async () => {
    const original = working('original.txt'), newer = working('newer.txt');
    const listing = deferred(); let refreshPending = false; let listingStarted = false;
    fixture.response = async (name, input) => name === 'missionFiles' ? { rows: [] } : name === 'getEnvironment' ? ready()
      : name === 'mutateEnvironmentFile' ? (refreshPending = true, { entry: working('copy.txt') })
        : name === 'environmentFiles' ? refreshPending ? (refreshPending = false, listingStarted = true, listing.promise) : { path: input.path, entries: [original, newer] }
          : fileRead(input.path === newer.path ? newer : original, input.path === newer.path ? 'newer contents' : 'original');
    fixture.controller.open('mission-a', { filePath: original.path }); await settle(() => !field('download').disabled);
    field('file-actions').click(); field('copy-file').click(); submit();
    await settle(() => listingStarted);
    fixture.controller.open('mission-a', { filePath: newer.path }); await settle(() => field('content').textContent === 'newer contents');
    listing.resolve({ path: '/workspace', entries: [original, newer, working('copy.txt')] }); await Promise.resolve(); await Promise.resolve();
    assert.equal(field('viewer-name').textContent, 'newer.txt'); assert.equal(field('content').textContent, 'newer contents');
  });

  it('uses named icon controls, a keyboard New menu and row-local actions without opening a dialog', async () => {
    mockWorking(); await openWorking();
    assert.equal(field('refresh').textContent, ''); assert.match(field('refresh').getAttribute('aria-label'), /refresh/i);
    field('new').click(); assert.isFalse(field('new-menu').hidden); assert.equal(field('new').getAttribute('aria-expanded'), 'true');
    assert.strictEqual(document.activeElement, field('new-folder'));
    field('new-folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.strictEqual(document.activeElement, field('new-file'));
    field('new-file').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.isTrue(field('new-menu').hidden); assert.strictEqual(document.activeElement, field('new'));
    const control = field('list').querySelector('[data-file-actions]'); control.click();
    assert.equal(control.getAttribute('aria-expanded'), 'true'); assert.isFalse(field('row-menu').hidden); assert.isTrue(field('action-panel').hidden);
    assert.isTrue(fixture.root.querySelector('.mission-file-viewer').hidden);
    field('rename-file').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.isTrue(field('row-menu').hidden); assert.strictEqual(document.activeElement, control); assert.isEmpty(mutations());
  });

  it('renames in the row, validates collisions and supports Escape without writing', async () => {
    mockWorking([working(), working('taken.txt')]); await openWorking();
    field('list').querySelector('[data-file-actions="/workspace/report.txt"]').click(); field('rename-file').click();
    assert.isTrue(field('action-panel').hidden); assert.exists(field('rename-form')); assert.strictEqual(document.activeElement, field('rename-name'));
    rename('taken.txt'); assert.isEmpty(mutations()); assert.include(field('rename-error').textContent, 'already');
    rename('../outside.txt'); assert.isEmpty(mutations()); assert.include(field('rename-error').textContent, 'slashes');
    field('rename-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.isNull(field('rename-form')); assert.isEmpty(mutations());
    assert.strictEqual(document.activeElement, field('list').querySelector('[data-file-key="/workspace/report.txt"]'));
  });

  it('uses a folder picker that excludes managed folders and descendants of the moved folder', async () => {
    const source = working('research', { type: 'directory' });
    fixture.response = async (name, input) => name === 'getEnvironment' ? ready() : name === 'environmentFiles' ? { path: input.path, entries: input.path === '/workspace'
      ? [source, working('archive', { type: 'directory' }), working('inputs', { type: 'directory' })]
      : [working('nested', { path: '/workspace/archive/nested', type: 'directory' })] } : {};
    await openWorking(); field('list').querySelector('[data-file-actions="/workspace/research"]').click(); field('move-file').click();
    assert.isNull(field('destination-path')); assert.equal(field('destination-name').value, 'research');
    assert.isNull(field('destination-folders').querySelector('[data-destination-folder="/workspace/research"]'));
    assert.isNull(field('destination-folders').querySelector('[data-destination-folder="/workspace/inputs"]'));
    field('destination-folders').querySelector('[data-destination-folder="/workspace/archive"]').click(); await settle(() => !field('submit-action').disabled);
    assert.include(field('destination-breadcrumbs').textContent, 'archive'); assert.equal(field('path').textContent, '/workspace');
    submit(); await settle(() => mutations().length === 1);
    assert.deepEqual(mutations()[0].input, { missionId: 'mission-a', action: 'move', path: '/workspace/research', destination: '/workspace/archive/research' });
  });

  it('keeps dialogs keyboard focused and identifies the exact permanent-delete target', async () => {
    mockWorking([working('notes', { type: 'directory' })]); await openWorking();
    field('list').querySelector('[data-file-actions]').click(); field('delete-file').click();
    const dialog = field('action-panel').querySelector('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true'); assert.equal(dialog.getAttribute('aria-labelledby'), field('action-title').id);
    assert.isTrue(fixture.root.querySelector('.mission-file-browser').inert); assert.equal(field('action-body').querySelector('code').textContent, '/workspace/notes');
    assert.include(field('action-body').textContent, 'everything inside');
    const buttons = [...dialog.querySelectorAll('button')]; buttons.at(-1).focus();
    buttons.at(-1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.strictEqual(document.activeElement, field('close-action'));
    field('close-action').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.isTrue(field('action-panel').hidden); assert.isFalse(fixture.root.querySelector('.mission-file-browser').inert); assert.isEmpty(mutations());
  });

  it('protects unsaved text when closing its preview', async () => {
    mockWorking(); await openWorkingFile(); field('edit').click(); typeEdit('keep this draft');
    field('close-preview').click(); assert.include(field('action-title').textContent, 'Save changes');
    field('keep-editing').click(); assert.equal(field('editor').value, 'keep this draft');
    assert.isFalse(fixture.root.querySelector('.mission-file-viewer').hidden); assert.isEmpty(mutations());
  });

  it('does not attach a file picker selection to a different mission after navigation', async () => {
    mockWorking(); await openWorking();
    field('upload-input').click = () => {}; field('upload').click();
    fixture.controller.open('mission-b'); await settle(() => !field('refresh').disabled);
    const transfer = new DataTransfer(); transfer.items.add(new File(['old'], 'old-mission.txt', { type: 'text/plain' }));
    field('upload-input').files = transfer.files; field('upload-input').dispatchEvent(new Event('change'));
    assert.isTrue(field('action-panel').hidden); assert.isEmpty(mutations()); assert.equal(field('upload-input').value, '');
  });

  it('clears preview and drafts on account changes and ignores a pending prior-account read', async () => {
    mockWorking(); await openWorkingFile(); field('edit').click(); typeEdit('private draft');
    const pending = deferred(); fixture.response = async (name) => name === 'readEnvironmentFile' ? pending.promise : name === 'getEnvironment' ? ready() : { path: '/workspace', entries: [working()] };
    field('close-preview').click(); field('discard-edits').click(); field('list').querySelector('[data-file-key]').click();
    fixture.account = 'another-owner'; fixture.changed.changed(); Tracker.flush();
    pending.resolve(fileRead(working(), 'private contents')); await Promise.resolve(); await Promise.resolve();
    assert.isEmpty(field('list').children); assert.isEmpty(field('content').textContent); assert.isTrue(field('draft-banner').hidden);
    assert.isTrue(fixture.root.querySelector('.mission-file-viewer').hidden); assert.isEmpty(mutations());
  });
});
