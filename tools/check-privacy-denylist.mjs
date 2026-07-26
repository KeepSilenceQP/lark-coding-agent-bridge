#!/usr/bin/env node

import {
  loadPrivacyPatterns,
  PRIVACY_CATEGORY_COUNTS,
  scanPrivacyTarget,
} from './privacy-denylist-lib.mjs';

const args = process.argv.slice(2);
const modeFlags = args.filter((arg) =>
  arg === '--tree' || arg === '--dist' || arg === '--tarball'
);
if (modeFlags.length !== 1) {
  fail('choose exactly one mode: --tree, --dist, or --tarball <path>');
}

const modeFlag = modeFlags[0];
const mode = modeFlag.slice(2);
const root = optionValue(args, '--root') ?? process.cwd();
const patternFile = optionValue(args, '--patterns-file');
const tarball = mode === 'tarball' ? valueAfter(args, '--tarball') : undefined;

try {
  const patterns = await loadPrivacyPatterns(patternFile);
  const findings = await scanPrivacyTarget({ mode, root, tarball, patterns });
  if (findings.length > 0) {
    const unique = new Map(
      findings.map((finding) => [
        `${finding.path}\0${finding.label}`,
        finding,
      ]),
    );
    for (const finding of unique.values()) {
      console.error(`privacy denylist hit: ${finding.path} (${finding.label})`);
    }
    fail(`${unique.size} current-content finding(s) detected`);
  }
  const total = Object.values(PRIVACY_CATEGORY_COUNTS)
    .reduce((sum, count) => sum + count, 0);
  console.log(`privacy ${mode} scan passed: ${total} protected patterns, 0 findings`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return valueAfter(argv, flag);
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function fail(message) {
  console.error(`privacy denylist check failed: ${message}`);
  process.exit(1);
}
