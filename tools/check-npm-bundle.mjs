import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const channelSpec = bridgePackage.dependencies?.['@larksuite/channel'];
const expectedVersion = /^file:vendor\/larksuite-channel-(.+)\.tgz$/.exec(channelSpec ?? '')?.[1];
const channelDir = join(root, 'node_modules', '@larksuite', 'channel');

function fail(message) {
  console.error(`npm bundle preflight failed: ${message}`);
  console.error(
    'Prepare the release from a clean npm layout with `npm install --install-links=true`.',
  );
  process.exit(1);
}

if (!expectedVersion) {
  fail(`unsupported @larksuite/channel dependency spec: ${String(channelSpec)}`);
}

let channelStat;
try {
  channelStat = await lstat(channelDir);
} catch {
  fail('node_modules/@larksuite/channel is missing');
}

if (channelStat.isSymbolicLink()) {
  fail('node_modules/@larksuite/channel is a symlink (pnpm layouts cannot be bundled safely)');
}

const channelPackage = JSON.parse(
  await readFile(join(channelDir, 'package.json'), 'utf8').catch(() =>
    fail('node_modules/@larksuite/channel/package.json is unreadable'),
  ),
);

if (channelPackage.version !== expectedVersion) {
  fail(
    `installed @larksuite/channel is ${String(channelPackage.version)}, expected ${expectedVersion}`,
  );
}

const requireFromChannel = createRequire(join(channelDir, 'package.json'));
for (const dependency of Object.keys(channelPackage.dependencies ?? {})) {
  try {
    requireFromChannel.resolve(dependency);
  } catch {
    fail(`@larksuite/channel runtime dependency is not resolvable: ${dependency}`);
  }
}

console.log(
  `npm bundle preflight passed: @larksuite/channel@${channelPackage.version} runtime closure is resolvable`,
);
