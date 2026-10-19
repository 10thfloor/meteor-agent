import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';

if (Meteor.isClient) describe('Mission Services controls', function () {
  this.timeout(8000);
  let initialize; let fixture;
  const field = (name, root = fixture.root) => root.querySelector(`[data-services="${name}"]`);
  const action = (name) => fixture.root.querySelector(`[data-service-action="${name}"]`);
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const settle = async (check) => { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) assert.fail('Services did not settle'); Tracker.flush(); await new Promise((resolve) => setTimeout(resolve, 5)); } };
  const env = (patch = {}) => ({ status: 'ready', workspaceId: 'sprite', keepFiles: true, ...patch });
  const service = (patch = {}) => ({ name: 'analysis', command: 'python', args: ['-m', 'http.server', '8080'], directory: '/workspace', httpPort: 8080, status: 'running', ...patch });
  const submit = () => field('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  before(async () => { ({ initializeMissionServices: initialize } = await import('../client/mission-services')); });
  beforeEach(() => {
    const root = document.createElement('div'); document.body.append(root);
    fixture = { root, calls: [], opened: [], online: true, changed: new Tracker.Dependency(), response: async (name) => name === 'getEnvironment' ? env() : [] };
    fixture.controller = initialize({ root, prefix: `services-${Random.id()}`, connected: () => { fixture.changed.depend(); return fixture.online; },
      method: async (name, input) => { fixture.calls.push({ name, input }); return fixture.response(name, input); }, openPreview: (url) => fixture.opened.push(url), openEnvironment() {} });
  });
  afterEach(() => { fixture.controller.dispose(); fixture.root.remove(); Tracker.flush(); });

  it('names services clearly and saves definitions without silently starting them', async () => {
    fixture.response = async (name, input) => name === 'getEnvironment' ? env() : name === 'savePreview' ? { ...input, status: 'not-started' } : [];
    fixture.controller.open('mission-a'); await settle(() => !field('add').disabled);
    assert.notInclude(fixture.root.textContent.toLowerCase(), 'preview'); assert.include(fixture.root.textContent, 'Stop run does not stop services');
    field('add').click(); field('name').value = 'analysis'; field('command').value = 'python'; field('args').value = '-m\nhttp.server\n8080'; submit();
    await settle(() => field('list').children.length === 1);
    assert.deepEqual(fixture.calls.at(-1), { name: 'savePreview', input: { missionId: 'mission-a', name: 'analysis', command: 'python', args: ['-m', 'http.server', '8080'], directory: '/workspace', httpPort: 8080 } });
    assert.notInclude(fixture.calls.map(({ name }) => name), 'startPreview'); assert.isTrue(field('editor').hidden);
    assert.include(field('list').textContent, '/workspace · Port 8080'); assert.isTrue(action('open').disabled);
  });

  it('starts, opens, and stops only the exact mission service selected', async () => {
    let value = service({ status: 'not-started' });
    fixture.response = async (name) => name === 'getEnvironment' ? env() : name === 'listPreviews' ? [value] : name === 'startPreview' ? (value = { ...value, status: 'running' })
      : name === 'stopPreview' ? (value = { ...value, status: 'stopped' }) : { url: 'https://example.sprites.app', auth: 'sprite', privateAccess: 'admins' };
    fixture.controller.open('mission-a'); await settle(() => !!action('start') && !action('start').disabled);
    action('start').click(); await settle(() => field('list').textContent.includes('Running'));
    assert.deepEqual(fixture.calls.at(-1), { name: 'startPreview', input: { missionId: 'mission-a', name: 'analysis' } });
    action('open').click(); await settle(() => fixture.opened.length === 1 && !action('open').disabled);
    assert.equal(fixture.opened[0], 'https://example.sprites.app/'); assert.isNull(field('list').querySelector('a'));
    action('stop').click(); await settle(() => field('list').textContent.includes('Stopped'));
    assert.deepEqual(fixture.calls.at(-1), { name: 'stopPreview', input: { missionId: 'mission-a', name: 'analysis' } });
    assert.notInclude(fixture.calls.map(({ name }) => name), 'deleteEnvironment');
  });

  it('checks current authorization on every opening and rejects unsafe or public URLs', async () => {
    let link = { url: 'https://example.sprites.app', auth: 'sprite', privateAccess: 'admins' };
    fixture.response = async (name) => name === 'getEnvironment' ? env() : name === 'listPreviews' ? [service()] : link;
    fixture.controller.open('mission-a'); await settle(() => !!action('open') && !action('open').disabled);
    action('open').click(); await settle(() => fixture.opened.length === 1 && !action('open').disabled);
    for (const invalid of [{ ...link, url: 'https://example.sprites.app.attacker.invalid/' }, { ...link, url: 'javascript:alert(1)' }, { ...link, privateAccess: 'public' }, { ...link, url: 'https://user:secret@example.sprites.app/' }]) {
      link = invalid; action('open').click(); await settle(() => !action('open').disabled); assert.lengthOf(fixture.opened, 1);
    }
    assert.lengthOf(fixture.calls.filter(({ name }) => name === 'privatePreview'), 5);
    assert.include(field('notice').textContent, 'Private access');
    fixture.response = async (name) => { if (name === 'privatePreview') throw { reason: 'Connected API permissions changed. Review grants first.' }; return {}; };
    action('open').click(); await settle(() => field('notice').textContent.includes('permissions changed')); assert.lengthOf(fixture.opened, 1);
  });

  it('deduplicates a pending Open and ignores stale links after switching away', async () => {
    const link = deferred(); fixture.response = async (name) => name === 'getEnvironment' ? env() : name === 'listPreviews' ? [service()] : link.promise;
    fixture.controller.open('mission-a'); await settle(() => !!action('open') && !action('open').disabled);
    action('open').click(); action('open').click(); assert.equal(action('open').textContent, 'Checking access…'); assert.lengthOf(fixture.calls.filter(({ name }) => name === 'privatePreview'), 1);
    assert.equal(getComputedStyle(action('open'), '::before').position, 'static');
    assert.equal(getComputedStyle(action('open'), '::after').content, 'none');
    assert.notEqual(getComputedStyle(action('open')).color, 'rgba(0, 0, 0, 0)');
    fixture.controller.setActive({ missionId: 'mission-a', tab: 'chat' }); link.resolve({ url: 'https://old.sprites.app', auth: 'sprite', privateAccess: 'admins' });
    await Promise.resolve(); await Promise.resolve(); assert.isEmpty(fixture.opened);
  });

  it('ignores old lists after switching missions and does no work merely for Chat', async () => {
    const old = deferred(); fixture.response = async (name, input) => name === 'getEnvironment' ? env() : input.missionId === 'mission-a' ? old.promise : [service({ name: 'current' })];
    fixture.controller.setActive({ missionId: 'mission-a', tab: 'chat' }); assert.isEmpty(fixture.calls);
    fixture.controller.open('mission-a'); await settle(() => fixture.calls.some(({ name }) => name === 'listPreviews'));
    fixture.controller.open('mission-b'); await settle(() => field('list').textContent.includes('current'));
    old.resolve([service({ name: 'wrong-mission' })]); await Promise.resolve(); await Promise.resolve(); assert.notInclude(field('list').textContent, 'wrong-mission');
  });

  it('preserves a failed configuration draft and confirms deletion separately', async () => {
    fixture.response = async (name) => { if (name === 'getEnvironment') return env(); if (name === 'listPreviews') return [service({ status: 'stopped' })]; if (name === 'savePreview') throw { reason: 'Review connected API permissions first.' }; return { deleted: true }; };
    fixture.controller.open('mission-a'); await settle(() => !!action('configure') && !action('configure').disabled);
    action('configure').click(); field('command').value = 'new-script'; submit(); await settle(() => field('notice').textContent.includes('Review connected'));
    assert.equal(field('command').value, 'new-script'); assert.isFalse(field('editor').hidden); assert.isTrue(field('name').readOnly);
    action('delete').click(); const dialog = document.querySelector('dialog[open] [data-services="delete-confirm"]').closest('dialog');
    assert.include(dialog.textContent, 'Working files and saved mission files stay unchanged'); assert.notInclude(fixture.calls.map(({ name }) => name), 'deletePreview');
    field('delete-confirm', dialog).click(); await settle(() => !dialog.open);
    assert.deepEqual(fixture.calls.at(-1), { name: 'deletePreview', input: { missionId: 'mission-a', name: 'analysis', confirm: true } }); assert.isEmpty(field('list').children);
  });

  it('offers actionable prerequisites without provisioning and preserves Stop during recoverable faults', async () => {
    fixture.response = async () => env({ status: 'not-created', workspaceId: null, keepFiles: false }); fixture.controller.open('mission-a'); await settle(() => field('notice').textContent.includes('Turn on Keep working files'));
    assert.isTrue(field('add').disabled); assert.deepEqual(fixture.calls.map(({ name }) => name), ['getEnvironment']);
    fixture.response = async (name) => name === 'getEnvironment' ? env({ status: 'needs-attention' }) : [service()]; fixture.controller.open('mission-b'); await settle(() => !!action('stop'));
    assert.isFalse(action('stop').disabled); assert.isTrue(action('start').disabled); assert.isTrue(action('open').disabled);
    fixture.online = false; fixture.changed.changed(); Tracker.flush(); assert.isTrue(action('stop').disabled); assert.include(field('notice').textContent, 'Reconnecting');
  });
});
