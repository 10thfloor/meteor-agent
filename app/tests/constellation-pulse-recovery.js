import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) describe('Constellation Pulse polling recovery', function () {
  let scan;
  before(async () => { ({ scanDuePulses: scan } = await import('../server/main.js')); });

  it('contains a database timeout and retries on the next scan without exposing connection details', async () => {
    const warnings = [];
    const error = new Error('mongodb://private-host/?credential=not-for-logs');
    error.name = 'PoolClearedOnNetworkError';
    await scan({ findDue: async () => { throw error; }, warn: (message) => warnings.push(message) });
    let retried = false;
    await scan({ findDue: async (now) => { assert.instanceOf(now, Date); retried = true; return []; },
      warn: (message) => warnings.push(message) });
    assert.isTrue(retried);
    assert.lengthOf(warnings, 1);
    assert.include(warnings[0], 'PoolClearedOnNetworkError');
    assert.include(warnings[0], 'next scheduled check');
    assert.notInclude(warnings[0], 'private-host');
    assert.notInclude(warnings[0], 'credential');
  });

  it('does not overlap scans and releases the guard after failure', async () => {
    let rejectRead;
    const pending = new Promise((_resolve, reject) => { rejectRead = reject; });
    const warnings = [];
    const first = scan({ findDue: () => pending, warn: (message) => warnings.push(message) });
    let reads = 0;
    const next = { findDue: async () => { reads += 1; return []; } };
    await scan(next);
    assert.equal(reads, 0);
    rejectRead(new Error('temporarily offline'));
    await first;
    await scan(next);
    assert.equal(reads, 1);
    assert.lengthOf(warnings, 1);
  });

  it('keeps repeated failures bounded to regular scans and sanitizes malformed error names', async () => {
    const warnings = [];
    let reads = 0;
    const dependencies = { findDue: async () => { reads += 1; throw { name: 'mongodb://private-host' }; },
      warn: (message) => warnings.push(message) };
    await scan(dependencies);
    await scan(dependencies);
    assert.equal(reads, 2);
    assert.lengthOf(warnings, 2);
    assert.isTrue(warnings.every((message) => message.includes('(Error)') && !message.includes('private-host')));
    await scan({ findDue: async () => [] });
  });
});
