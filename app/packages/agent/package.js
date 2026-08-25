Package.describe({
  name: '10thfloor:agent',
  version: '0.1.0',
  summary: 'A Pi-based agent harness for Meteor 3.5+',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.5');
  api.use(['ecmascript', 'typescript', 'mongo', 'ddp', 'check', 'random', 'tracker']);
  api.use(['ddp-common', 'ddp-rate-limiter', 'webapp'], 'server');
  api.mainModule('server/index.ts', 'server');
  api.mainModule('client/index.ts', 'client');

  // Types: consuming apps use a `paths` entry pointing at `index.d.ts` (see
  // README "Types"). zodern:types doesn't work here yet — it resolves against
  // the isopack build dir, and `package.js` has no `__dirname` to enumerate
  // the ~50 generated declaration files. Revisit when the package is published.
});

Package.onTest((api) => {
  api.use(['ecmascript', 'typescript', 'mongo', 'ddp', 'check', 'random', 'tracker']);
  api.use(['ddp-common', 'ddp-rate-limiter', 'webapp'], 'server');
  api.use('meteortesting:mocha');
  api.use('10thfloor:agent');
  // Split by architecture: server tests must never reach the client bundle.
  api.mainModule('tests/server.ts', 'server');
  api.mainModule('tests/client.ts', 'client');
});
