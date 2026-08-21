// The package is server-only; this entry exists so the mocha driver has a
// client bundle to finish. One assertion, so "0 passing" never reads as a
// silently skipped suite.
import { assert } from 'chai';

describe('agent-channel-whatsapp (client)', () => {
  it('ships no client code', () => {
    assert.ok(true);
  });
});
