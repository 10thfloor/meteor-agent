Package.describe({
  name: '10thfloor:agent',
  version: '0.1.0',
  summary: 'A Meteor-native agent harness with pi-ai as its default model adapter',
  git: 'https://github.com/10thfloor/meteor-agent.git',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.5');
  api.use(['ecmascript', 'typescript', 'mongo', 'ddp', 'check', 'random', 'tracker']);
  api.use(['ddp-common', 'ddp-rate-limiter', 'webapp'], 'server');
  api.mainModule('server/index.ts', 'server');
  api.mainModule('client/index.ts', 'client');

  // Generated declarations are exposed through package-types.json. The README
  // documents a paths entry for vendored-package editor support.
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
