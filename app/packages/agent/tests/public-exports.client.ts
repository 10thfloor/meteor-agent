import { assert } from 'chai';
import * as PublicApi from 'meteor/10thfloor:agent';

describe('client public exports', () => {
  it('exports ClientAgent as the browser Agent alias', () => {
    const api = PublicApi as typeof PublicApi & { ClientAgent?: unknown };
    assert.strictEqual(api.ClientAgent, api.Agent);
  });
});
