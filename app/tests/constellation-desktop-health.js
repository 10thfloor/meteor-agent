import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) describe('Constellation desktop readiness', function () {
  let createHandler;
  before(async () => { ({ createDesktopHealthHandler: createHandler } = await import('../server/desktop-health.js')); });
  const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; this.writableEnded = true; } });
  const request = { url: '/__constellation/health', method: 'GET' };

  it('checks application and database readiness without returning workspace data', async () => {
    let started = false; let reads = 0;
    const handler = createHandler({ ready: () => started, probe: async () => { reads += 1; return { private: 'not exposed' }; } });
    const starting = response(); await handler(request, starting);
    assert.equal(starting.statusCode, 503); assert.equal(reads, 0);
    started = true;
    const live = response(); await handler(request, live);
    assert.equal(live.statusCode, 200); assert.equal(reads, 1);
    assert.deepEqual(JSON.parse(live.body), { service: 'constellation', status: 'ready' });
    assert.equal(live.headers['Cache-Control'], 'no-store');
  });

  it('contains database failures and becomes healthy again on a later check', async () => {
    let failing = true;
    const handler = createHandler({ ready: () => true, probe: async () => {
      if (failing) throw new Error('mongodb://private-token@host');
    } });
    const failed = response(); await handler(request, failed);
    assert.equal(failed.statusCode, 503); assert.notInclude(failed.body, 'private-token');
    failing = false;
    const recovered = response(); await handler(request, recovered);
    assert.equal(recovered.statusCode, 200);
  });

  it('bounds responses and shares a stuck probe without accumulating database reads', async () => {
    let finish; let reads = 0;
    const handler = createHandler({ ready: () => true, timeoutMs: 5, probe: () => {
      reads += 1; return new Promise((resolve) => { finish = resolve; });
    } });
    const first = response(); const second = response();
    await Promise.all([handler(request, first), handler(request, second)]);
    assert.equal(first.statusCode, 503); assert.equal(second.statusCode, 503); assert.equal(reads, 1);
    finish(); await Promise.resolve(); await Promise.resolve();
  });

  it('accepts only read-only methods and leaves unrelated routes alone', async () => {
    let reads = 0; let next = 0;
    const handler = createHandler({ ready: () => true, probe: async () => { reads += 1; } });
    const elsewhere = response();
    await handler({ ...request, url: '/another-route' }, elsewhere, () => { next += 1; });
    assert.equal(next, 1); assert.equal(reads, 0); assert.isUndefined(elsewhere.body);
    const post = response(); await handler({ ...request, method: 'POST' }, post);
    assert.equal(post.statusCode, 405); assert.equal(reads, 0);
    const head = response(); await handler({ ...request, method: 'HEAD' }, head);
    assert.equal(head.statusCode, 200); assert.isUndefined(head.body);
  });
});
