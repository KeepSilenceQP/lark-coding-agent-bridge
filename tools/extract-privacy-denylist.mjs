#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import {
  loadPrivacyPatterns,
  PRIVACY_CATEGORY_COUNTS,
} from './privacy-denylist-lib.mjs';

const execFileAsync = promisify(execFile);
const KNOWN_BAD_COMMITS = ['a0464f7', '665ad74'];
const REGISTRY_PATH = 'src/project/bot-registry.ts';

export async function extractPrivacyDenylist({ root = process.cwd(), output }) {
  if (!output) throw new Error('--output is required');

  let extracted;
  for (const commit of KNOWN_BAD_COMMITS) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', resolve(root), 'show', `${commit}:${REGISTRY_PATH}`],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      );
      const candidate = {
        appIds: collect(stdout, /appId:\s*'([^']+)'/g),
        machineRoots: collect(stdout, /root:\s*'([^']+)'/g),
        botNames: collect(stdout, /canonicalName:\s*'([^']+)'/g),
      };
      if (hasExpectedCounts(candidate)) {
        extracted = candidate;
        break;
      }
    } catch {
      // Try the other known commit. Missing history ultimately fails closed.
    }
  }
  if (!extracted) {
    throw new Error('could not derive the complete privacy denylist from known history');
  }

  const destination = resolve(output);
  await writeFile(destination, `${JSON.stringify(extracted)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(destination, 0o600);
  await loadPrivacyPatterns(destination);
  return destination;
}

function collect(source, regex) {
  return [...new Set([...source.matchAll(regex)].map((match) => match[1]))];
}

function hasExpectedCounts(candidate) {
  return Object.entries(PRIVACY_CATEGORY_COUNTS).every(
    ([category, count]) => candidate[category]?.length === count,
  );
}

function parseArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  const rootIndex = argv.indexOf('--root');
  return {
    output: outputIndex >= 0 ? argv[outputIndex + 1] : undefined,
    root: rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await extractPrivacyDenylist(parseArgs(process.argv.slice(2)));
    console.log(`privacy denylist derived: ${result} (protected values omitted)`);
  } catch (error) {
    console.error(
      `privacy denylist extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
