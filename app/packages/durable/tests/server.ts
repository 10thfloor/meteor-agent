import { startupComplete } from 'meteor/10thfloor:durable';

// The mocha runner does not wait for Meteor.startup callbacks, so on a slow
// boot the early suites would race method and publication registration.
// Every suite waits behind the prelude.
before(async function awaitPackageStartup() {
  this.timeout(120_000);
  await startupComplete;
});

import './loader.test';
import './conformance.test';
import './storage.test';
import './in-flight.test';
import './harness.test';
import './host.test';
import './handover.test';
import './durable.test';
import './reactivity.test';
import './bench.test';
import './integration.server';
