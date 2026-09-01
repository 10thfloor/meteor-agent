import { startupComplete } from 'meteor/10thfloor:agent';

// The mocha runner does not wait for Meteor.startup callbacks, so on a slow
// boot the early suites race method/publication registration — the exact
// startup race that broke CI. Every suite waits behind the prelude.
before(async function awaitPackageStartup() {
  this.timeout(120_000);
  await startupComplete;
});

import './smoke.test';
import './merge.test';
import './loader.test';
import './piai.test';
import './capped.test';
import './tools.test';
import './schema.test';
import './lease.test';
import './loop.test';
import './provider-exchange.test';
import './ask.test';
import './session-lifecycle.test';
import './activation.test';
import './transcript.test';
import './subagent.test';
import './mcp.test';
import './skills.test';
import './fork.test';
import './candidates.test';
import './watcher.test';
import './channels.test';
import './attachments.test';
import './participants.test';
import './system-turn.test';
import './system-turn-budget.test';
import './system-turn-relay.test';
import './media.test';
import './downloads.test';
import './multimodal.test';
import './memory.test';
import './learning.test';
import './learning-loop.test';
import './perf.test';
import './integration.server';
