import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repo, 'release.json'), 'utf8'));
const failures = [];

const fail = (file, message) => failures.push(`${file}: ${message}`);
const read = (file) => readFileSync(join(repo, file), 'utf8');
const exactlyOne = (text, regex) => [...text.matchAll(regex)];

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.packageVersion)) {
  fail('release.json', 'packageVersion is not a supported semantic version');
}
if (!/^v\d+\.\d+\.\d+$/.test(manifest.stableTag)) {
  fail('release.json', 'stableTag must be a v-prefixed stable semantic version');
}
const isPrerelease = manifest.packageVersion.includes('-');
const releaseTag = process.env.RELEASE_TAG?.trim() ?? '';
if (!isPrerelease
  && manifest.stableTag !== `v${manifest.packageVersion}`) {
  fail('release.json', 'a stable packageVersion must equal stableTag');
}
// A candidate must point docs at an already-published stable tag. A tag build
// must also prove every referenced tag exists. On an untagged stable-promotion
// PR, however, the new stable tag is intentionally created only after CI.
if (isPrerelease || releaseTag) {
  try {
    execFileSync(
      'git', ['rev-parse', '--verify', `refs/tags/${manifest.stableTag}^{commit}`],
      { cwd: repo, stdio: 'ignore' },
    );
  } catch {
    fail('release.json', `stableTag does not resolve to a local Git tag: ${manifest.stableTag}`);
  }
}
if (releaseTag && releaseTag !== `v${manifest.packageVersion}`) {
  fail(
    'release.json',
    `tag build ${releaseTag} does not match packageVersion v${manifest.packageVersion}`,
  );
}

const packageRoot = join(repo, 'app/packages');
const describedDirectories = readdirSync(packageRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => {
    try { readFileSync(join(packageRoot, entry.name, 'package.js')); return true; } catch { return false; }
  })
  .map((entry) => entry.name)
  .sort();
const declaredDirectories = manifest.packages.map((pkg) => pkg.directory).sort();
if (JSON.stringify(describedDirectories) !== JSON.stringify(declaredDirectories)) {
  fail('release.json', 'package set does not exactly cover app/packages/*/package.js');
}
if (manifest.packages.filter((pkg) => pkg.role === 'core').length !== 1) {
  fail('release.json', 'package set must contain exactly one core package');
}
if (manifest.packages.some((pkg) => pkg.role !== 'core' && pkg.role !== 'channel')) {
  fail('release.json', 'every package role must be exactly core or channel');
}
const core = manifest.packages.find((pkg) => pkg.role === 'core');
if (core?.name !== '10thfloor:agent' || core?.directory !== 'agent') {
  fail('release.json', '10thfloor:agent in app/packages/agent must be the core package');
}
if (new Set(manifest.packages.map((pkg) => pkg.name)).size !== manifest.packages.length
  || new Set(manifest.packages.map((pkg) => pkg.directory)).size !== manifest.packages.length) {
  fail('release.json', 'package names and directories must be unique');
}

for (const pkg of manifest.packages) {
  const descriptor = `app/packages/${pkg.directory}/package.js`;
  const source = read(descriptor);
  const names = exactlyOne(source, /name:\s*'([^']+)'/g);
  const versions = exactlyOne(source, /version:\s*'([^']+)'/g);
  if (names.length !== 1 || names[0][1] !== pkg.name) {
    fail(descriptor, 'Package.describe.name does not match the package set');
  }
  if (versions.length !== 1 || versions[0][1] !== manifest.packageVersion) {
    fail(descriptor, 'Package.describe.version does not match packageVersion');
  }
  if (pkg.role === 'channel') {
    const pins = exactlyOne(source, /api\.use\('10thfloor:agent@([^']+)'/g);
    if (pins.length !== 1 || pins[0][1] !== manifest.packageVersion) {
      fail(descriptor, 'core dependency must exactly match packageVersion');
    }
  }
  const metadataPath = `app/packages/${pkg.directory}/package-types.json`;
  let metadata;
  try {
    metadata = JSON.parse(read(metadataPath));
  } catch {
    fail(metadataPath, 'declaration metadata is missing or invalid JSON');
    continue;
  }
  const keys = metadata && typeof metadata === 'object' ? Object.keys(metadata) : [];
  if (keys.length !== 1 || keys[0] !== 'typesEntry'
    || typeof metadata.typesEntry !== 'string' || metadata.typesEntry === '') {
    fail(metadataPath, 'must contain exactly one non-empty string field: typesEntry');
    continue;
  }
  const packageDirectory = resolve(repo, `app/packages/${pkg.directory}`);
  const declaration = resolve(packageDirectory, metadata.typesEntry);
  if (isAbsolute(metadata.typesEntry) || relative(packageDirectory, declaration).startsWith('..')) {
    fail(metadataPath, 'typesEntry must stay within its package directory');
    continue;
  }
  try {
    readFileSync(declaration);
  } catch {
    fail(metadataPath, `typesEntry does not exist: ${metadata.typesEntry}`);
  }
}

const mcp = read('app/packages/agent/server/mcp/client.ts');
const runtimeVersions = exactlyOne(
  mcp, /\{ name: '10thfloor:agent', version: '([^']+)' \}/g,
);
if (runtimeVersions.length !== 1 || runtimeVersions[0][1] !== manifest.packageVersion) {
  fail('app/packages/agent/server/mcp/client.ts', 'runtime identity does not match packageVersion');
}

const appPackage = read('app/package.json');
for (const pkg of manifest.packages) {
  const testPath = `./packages/${pkg.directory}`;
  if (!appPackage.includes(testPath)) {
    fail('app/package.json', `test command omits ${pkg.name}`);
  }
  if (pkg.role === 'channel'
    && !appPackage.includes(`packages/${pkg.directory}/tsconfig.types.json`)) {
    fail('app/package.json', `declaration generation omits ${pkg.name}`);
  }
}

const rootReadme = read('README.md');
const documentedTags = [
  ...exactlyOne(rootReadme, /github\.com\/10thfloor\/meteor-agent\/tree\/(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g),
  ...exactlyOne(rootReadme, /git clone --branch (v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g),
].map((match) => match[1]);
if (documentedTags.length === 0 || documentedTags.some((tag) => tag !== manifest.stableTag)) {
  fail('README.md', 'stable release links and clone commands must all match stableTag');
}
const landingTags = exactlyOne(
  read('docs/index.html'),
  /<span class="eyebrow-chip">(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)<\/span>/g,
).map((match) => match[1]);
if (landingTags.length !== 1 || landingTags[0] !== manifest.stableTag) {
  fail('docs/index.html', 'release chip must match stableTag');
}

if (failures.length > 0) {
  console.error('Release package-set check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Release package set is consistent: ${manifest.packages.length} packages at `
      + `${manifest.packageVersion}; stable docs at ${manifest.stableTag}.`,
  );
}
