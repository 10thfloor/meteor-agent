Package.describe({
  name: '10thfloor:agent-channel-sms',
  version: '0.1.0',
  summary: 'SMS (Twilio) channel for 10thfloor:agent — one lens, one transport, one profile',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.5');
  api.use(['ecmascript', 'typescript'], 'server');
  api.use('10thfloor:agent', 'server');
  api.mainModule('server/index.ts', 'server');
});

Package.onTest((api) => {
  api.use(['ecmascript', 'typescript']);
  api.use('meteortesting:mocha');
  api.use(['10thfloor:agent', '10thfloor:agent-channel-sms'], 'server');
  api.mainModule('tests/server.ts', 'server');
  api.mainModule('tests/client.ts', 'client');
});
