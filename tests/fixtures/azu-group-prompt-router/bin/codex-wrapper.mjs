#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const realCodex = requiredEnv('AZU_REAL_CODEX_BINARY');
const logPath = requiredEnv('AZU_WRAPPER_LOG');

if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
  record({ kind: 'version' });
  run(args);
} else if (args[0] === 'debug' && args[1] === 'prompt-input') {
  record({ kind: 'prompt-input-probe' });
  run(args);
} else if (args[0] === 'exec') {
  if (args.includes('resume') || args.includes('--add-dir')) fail('resume/add-dir is forbidden');
  const developerInstructions = readDeveloperInstructions(args);
  const developerHash = createHash('sha256').update(developerInstructions).digest('hex');
  const expectedHash = requiredEnv('AZU_EXPECTED_DEVELOPER_HASH');
  const schemaPath = requiredEnv('AZU_PROBE_SCHEMA');
  const lastMessagePath = requiredEnv('AZU_LAST_MESSAGE_PATH');
  const safe = developerHash === expectedHash;
  record({
    kind: 'exec',
    developerHash,
    developerBytes: Buffer.byteLength(developerInstructions),
    developerInstructionsMatch: safe,
    ephemeral: true,
    outputSchema: true,
    outputLastMessage: true,
    resume: false,
    addDir: false
  });
  if (!safe) fail('developer instructions hash mismatch');
  run([
    'exec',
    '--ephemeral',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    lastMessagePath,
    ...args.slice(1)
  ]);
} else {
  fail('unsupported wrapper invocation');
}

function readDeveloperInstructions(values) {
  for (let index = 0; index < values.length - 1; index += 1) {
    if (values[index] !== '-c' && values[index] !== '--config') continue;
    const entry = values[index + 1];
    if (!entry.startsWith('developer_instructions=')) continue;
    const encoded = entry.slice('developer_instructions='.length);
    return JSON.parse(encoded);
  }
  fail('developer instructions missing');
}

function run(values) {
  const child = spawn(realCodex, values, { env: process.env, stdio: 'inherit' });
  child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(70);
  });
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 70);
  });
}

function record(value) {
  appendFileSync(logPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail(`missing ${name}`);
  return value;
}

function fail(message) {
  process.stderr.write(`azu codex wrapper: ${message}\n`);
  process.exit(64);
}
