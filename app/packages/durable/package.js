Package.describe({
  name: '10thfloor:durable',
  version: '0.0.1',
  summary: 'Pi Durable on Meteor: a MongoDB storage backend for @earendil-works/pi-durable',
  git: 'https://github.com/10thfloor/meteor-agent.git',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.5');
  api.use(['ecmascript', 'typescript', 'mongo'], 'server');
  api.mainModule('server/index.ts', 'server');
});

Package.onTest((api) => {
  api.use(['ecmascript', 'typescript', 'mongo']);
  api.use('meteortesting:mocha');
  api.use('10thfloor:durable', 'server');
  // Split by architecture: server tests must never reach the client bundle.
  api.mainModule('tests/server.ts', 'server');
  api.mainModule('tests/client.ts', 'client');
});
