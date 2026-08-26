Package.describe({
  name: '10thfloor:agent-channel-telegram',
  version: '0.1.0',
  summary: 'Telegram channel for 10thfloor:agent — one lens, one transport, one profile',
  git: 'https://github.com/10thfloor/meteor-agent.git',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.5');
  api.use(['ecmascript', 'typescript'], 'server');
  api.use('10thfloor:agent@0.1.0', 'server');
  api.mainModule('server/index.ts', 'server');
});

Package.onTest((api) => {
  api.use(['ecmascript', 'typescript']);
  api.use('meteortesting:mocha');
  api.use(['10thfloor:agent', '10thfloor:agent-channel-telegram'], 'server');
  api.mainModule('tests/server.ts', 'server');
  api.mainModule('tests/client.ts', 'client');
});
