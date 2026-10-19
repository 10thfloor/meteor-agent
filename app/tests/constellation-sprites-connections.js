import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) describe('Sprites connected API permission inventory', function () {
  let normalize; let inspect;
  before(async () => { ({ normalizeSpritesConnections: normalize, inspectSpritesConnections: inspect } = await import('../server/sprites-connections')); });
  const connection = (access_policy, patch = {}) => ({ id: 'conn_1', provider: 'github', provider_account_name: 'Project', access_policy, ...patch });
  it('keeps deny-by-default and unrelated grants out; includes matching labels/prefix and broad grants', () => {
    assert.isEmpty(normalize({ connections: [connection({})] }).connections);
    for (const policy of [{ name_prefix: 'production-' }, { name_prefix: 'production-', sprite_labels: ['private'] }]) {
      assert.isEmpty(normalize({ connections: [connection(policy)] }).connections);
    }
    for (const policy of [{ allow_all: true }, { name_prefix: 'constellation-' }, { name_prefix: 'constellation-mission-specific' }, { sprite_labels: ['constellation-scratch'] }, { sprite_labels: ['private'] }, { name_prefix: 'constellation-', sprite_labels: ['private'] }]) {
      assert.lengthOf(normalize({ connections: [connection(policy)] }).connections, 1);
    }
  });
  it('returns only permission metadata, never provider credentials, snippets, or arbitrary URLs', () => {
    const result = normalize({ connections: [connection({ allow_all: true }, { token: 'SECRET', provider_info: { private: 'SECRET' }, usage_snippet: 'SECRET' })] });
    assert.notInclude(JSON.stringify(result), 'SECRET');
    assert.deepEqual(result.connections[0].policy, { allowAll: true, namePrefix: '', labels: [], allowedEndpoints: [], blockedEndpoints: [] });
  });
  it('fingerprints permission changes and rejects unknown policy fields or incomplete inventories', () => {
    const a = normalize({ connections: [connection({ allow_all: true })] });
    const b = normalize({ connections: [connection({ allow_all: true, allowed_endpoints: ['/repos/*'] })] });
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.throws(() => normalize({ connections: [connection({ new_grant: true })] }));
    assert.throws(() => normalize({ connections: [], next_cursor: 'more' }));
    assert.throws(() => normalize({ connections: [connection({ allow_all: 'true' })] }));
  });
  it('uses a bounded, non-redirecting, read-only host request and redacts failures', async () => {
    let request;
    const result = await inspect({ token: 'private-fixture-token', fetchImpl: async (url, options) => {
      request = { url, options }; return new Response(JSON.stringify({ connections: [] }));
    } });
    assert.isEmpty(result.connections); assert.equal(request.options.redirect, 'error'); assert.isUndefined(request.options.method);
    assert.equal(request.url, 'https://api.sprites.dev/v1/oauth/connections');
    try { await inspect({ token: 'private-fixture-token', fetchImpl: async () => { throw new Error('private-fixture-token'); } }); assert.fail('must reject'); }
    catch (error) { assert.notInclude(error.message, 'private-fixture-token'); }
  });
});
