import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = [
  'app/packages/agent/types',
  'app/packages/agent/index.d.ts',
  'app/packages/agent-channel-slack/types',
  'app/packages/agent-channel-slack/index.d.ts',
  'app/packages/agent-channel-telegram/types',
  'app/packages/agent-channel-telegram/index.d.ts',
  'app/packages/agent-channel-whatsapp/types',
  'app/packages/agent-channel-whatsapp/index.d.ts',
  'app/packages/agent-channel-sms/types',
  'app/packages/agent-channel-sms/index.d.ts',
  'app/packages/agent-channel-email/types',
  'app/packages/agent-channel-email/index.d.ts',
];

// `git diff` does not report newly emitted, untracked declarations. Porcelain
// status covers modified, deleted, and untracked generated files alike.
const status = execFileSync(
  'git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...generated],
  { cwd: repo, encoding: 'utf8' },
).trim();

if (status) {
  console.error('Generated declarations are not current:');
  console.error(status);
  process.exitCode = 1;
} else {
  console.log('Generated declarations match the committed type surface.');
}
