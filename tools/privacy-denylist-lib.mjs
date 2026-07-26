import { execFile } from 'node:child_process';
import {
  lstat,
  readFile,
  readdir,
  readlink,
} from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { join, relative, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export const PRIVACY_PATTERN_ENV = 'LARK_BRIDGE_PRIVACY_DENYLIST_FILE';
export const PRIVACY_CATEGORY_COUNTS = Object.freeze({
  appIds: 4,
  machineRoots: 2,
  botNames: 4,
});

export async function loadPrivacyPatterns(patternFile) {
  const resolved = patternFile || process.env[PRIVACY_PATTERN_ENV];
  if (!resolved) {
    throw new Error(
      `privacy denylist input is required via --patterns-file or ${PRIVACY_PATTERN_ENV}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolve(resolved), 'utf8'));
  } catch (error) {
    throw new Error(`privacy denylist input is unreadable or invalid JSON: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('privacy denylist input must be an object');
  }

  const expectedKeys = Object.keys(PRIVACY_CATEGORY_COUNTS);
  const actualKeys = Object.keys(parsed);
  const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key));
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error('privacy denylist input must contain exactly the required categories');
  }

  const patterns = [];
  const seen = new Set();
  for (const [category, expectedCount] of Object.entries(PRIVACY_CATEGORY_COUNTS)) {
    const values = parsed[category];
    if (!Array.isArray(values) || values.length !== expectedCount) {
      throw new Error(`${category} must contain exactly ${expectedCount} patterns`);
    }
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
        throw new Error(`${category}[${index + 1}] must be a non-empty trimmed string`);
      }
      if (seen.has(value)) {
        throw new Error('privacy denylist patterns must be globally unique');
      }
      seen.add(value);
      patterns.push({
        category,
        ordinal: index + 1,
        label: `${category}[${index + 1}]`,
        value,
        bytes: Buffer.from(value, 'utf8'),
      });
    }
  }
  return patterns;
}

export async function scanPrivacyTarget({ mode, root, tarball, patterns }) {
  if (mode === 'tarball') {
    if (!tarball) throw new Error('--tarball requires a .tgz path');
    const compressed = await readFile(resolve(tarball));
    let unpacked;
    try {
      unpacked = gunzipSync(compressed);
    } catch (error) {
      throw new Error(`tarball is not a readable gzip archive: ${errorMessage(error)}`);
    }
    return scanTarEntries(unpacked, patterns);
  }

  const scanRoot = resolve(root ?? '.');
  if (mode === 'dist') {
    return scanDirectory(join(scanRoot, 'dist'), scanRoot, patterns, new Set());
  }
  if (mode !== 'tree') {
    throw new Error(`unsupported privacy scan mode: ${String(mode)}`);
  }

  const gitPaths = await listGitVisibleFiles(scanRoot);
  if (gitPaths) {
    const findings = [];
    for (const path of gitPaths) {
      const absolute = join(scanRoot, path);
      let stat;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const content = stat.isSymbolicLink()
        ? Buffer.from(await readlink(absolute), 'utf8')
        : await readFile(absolute);
      findings.push(...scanBuffer(content, path, patterns));
    }
    return findings;
  }

  return scanDirectory(
    scanRoot,
    scanRoot,
    patterns,
    new Set(['.git', 'node_modules', 'dist']),
  );
}

async function listGitVisibleFiles(root) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '-z'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

async function scanDirectory(directory, displayRoot, patterns, excludedNames) {
  const findings = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    throw new Error(`privacy scan directory is unreadable: ${errorMessage(error)}`);
  });
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const displayPath = relative(displayRoot, absolute) || entry.name;
    if (entry.isDirectory()) {
      findings.push(
        ...await scanDirectory(absolute, displayRoot, patterns, excludedNames),
      );
    } else if (entry.isSymbolicLink()) {
      findings.push(
        ...scanBuffer(Buffer.from(await readlink(absolute), 'utf8'), displayPath, patterns),
      );
    } else if (entry.isFile()) {
      findings.push(...scanBuffer(await readFile(absolute), displayPath, patterns));
    }
  }
  return findings;
}

function scanTarEntries(archive, patterns) {
  const findings = [];
  let offset = 0;
  let entries = 0;
  let pendingPath;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const rawName = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const name = pendingPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingPath = undefined;
    const sizeText = tarString(header.subarray(124, 136)).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('tarball contains an invalid entry size');
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) {
      throw new Error('tarball entry exceeds archive bounds');
    }
    const content = archive.subarray(contentStart, contentEnd);
    const type = String.fromCharCode(header[156] ?? 0);

    if (type === 'x') {
      pendingPath = parsePaxPath(content) ?? pendingPath;
    } else if (type === 'L') {
      pendingPath = tarString(content);
    } else if (type === '\0' || type === '0' || type === '') {
      entries += 1;
      findings.push(...scanBuffer(Buffer.from(name, 'utf8'), `tarball:${name}`, patterns));
      findings.push(...scanBuffer(content, `tarball:${name}`, patterns));
    }

    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (entries === 0) {
    throw new Error('tarball contains no readable file entries');
  }
  return findings;
}

function tarString(buffer) {
  const zero = buffer.indexOf(0);
  return buffer.subarray(0, zero === -1 ? buffer.length : zero).toString('utf8');
}

function parsePaxPath(buffer) {
  const text = buffer.toString('utf8');
  for (const record of text.split('\n')) {
    const separator = record.indexOf(' ');
    if (separator === -1) continue;
    const field = record.slice(separator + 1);
    if (field.startsWith('path=')) return field.slice('path='.length);
  }
  return undefined;
}

function scanBuffer(content, displayPath, patterns) {
  const findings = [];
  for (const pattern of patterns) {
    if (content.indexOf(pattern.bytes) !== -1) {
      findings.push({
        path: displayPath,
        category: pattern.category,
        ordinal: pattern.ordinal,
        label: pattern.label,
      });
    }
  }
  return findings;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
