import { assert } from 'chai';
import { NAMES, DELTA_CAP_BYTES } from '../common/names';

describe('10thfloor:agent scaffold', () => {
  it('exposes stable collection names', () => {
    assert.equal(NAMES.sessions, 'agent_sessions');
    assert.equal(NAMES.messages, 'agent_messages');
    assert.equal(NAMES.deltas, 'agent_deltas');
  });

  it('sizes the delta cap in bytes', () => {
    assert.isAbove(DELTA_CAP_BYTES, 1024 * 1024);
  });
});
