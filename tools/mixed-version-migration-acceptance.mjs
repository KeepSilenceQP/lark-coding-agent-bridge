#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { build } from 'tsup';

const execFileAsync = promisify(execFile);
const HISTORICAL_SOURCE_REF = 'fd872acea804be938a87e0a16089cb7084dfb97d';
const HISTORICAL_FILES = [
  'src/config/app-paths.ts',
  'src/config/permissions.ts',
  'src/config/profile-schema.ts',
  'src/config/profile-store.ts',
  'src/config/schema.ts',
  'src/platform/atomic-write.ts',
];
const BRIDGE_ENV_PREFIX = 'LARK_CHANNEL_';
const EXTRA_BRIDGE_ENV_KEYS = new Set(['LARKSUITE_CLI_CONFIG_DIR']);
const PROFILE = 'fixture-alpha';
const SELF_ENTRY = Object.freeze({
  name: 'Fixture Alpha Bot',
  aliases: ['Fixture Coordinator'],
  appId: 'cli_fixture_alpha',
});
const OTHER_ENTRY = Object.freeze({
  name: 'Fixture Beta Bot',
  aliases: ['Fixture Implementer'],
  appId: 'cli_fixture_beta',
});

export async function runMixedVersionMigrationAcceptance({
  repositoryRoot = process.cwd(),
} = {}) {
  const repo = resolve(repositoryRoot);
  await assertRepositorySource(repo);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'bridge-mixed-version-'));
  const liveWriters = new Set();
  const writerEvidence = [];

  try {
    const artifacts = await buildWriterArtifacts(repo, temporaryRoot);
    const isolatedEnvironment = makeIsolatedEnvironment(join(temporaryRoot, 'env-proof'));
    assertEnvironmentIsolation(isolatedEnvironment, temporaryRoot);

    const newInstall = await exerciseNewInstall({
      temporaryRoot,
      artifacts,
      liveWriters,
      writerEvidence,
    });
    const upgrade = await exerciseUpgrade({
      temporaryRoot,
      artifacts,
      liveWriters,
      writerEvidence,
    });
    const rollbackReupgrade = await exerciseRollbackReupgrade({
      temporaryRoot,
      artifacts,
      liveWriters,
      writerEvidence,
    });

    if (liveWriters.size !== 0) {
      throw new Error('acceptance leaked a controlled writer process');
    }

    return {
      evidenceBoundary: {
        oldArtifact: 'historical-source-build',
        historicalSourceRef: HISTORICAL_SOURCE_REF,
        publishedOldBinaryTested: false,
        note: 'Historical serializer source was bundled into a temporary controlled artifact.',
      },
      isolation: {
        temporaryRootOnly: true,
        inheritedBridgeEnvironmentCleared: true,
        serviceManagerCalls: 0,
        globalPackageMutations: 0,
        userConfigReads: 0,
      },
      artifacts: {
        old: publicArtifactEvidence(artifacts.old),
        new: publicArtifactEvidence(artifacts.new),
      },
      writerEvidence,
      paths: {
        newInstall,
        upgrade,
        rollbackReupgrade,
      },
    };
  } finally {
    await Promise.allSettled([...liveWriters].map((writer) => stopWriter(writer)));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function exerciseNewInstall({
  temporaryRoot,
  artifacts,
  liveWriters,
  writerEvidence,
}) {
  const state = await createState(join(temporaryRoot, 'new-install'), {
    includeRegistry: true,
    entries: [],
  });
  const writer = await startWriter({
    generation: 'new',
    artifact: artifacts.new,
    state,
    liveWriters,
    writerEvidence,
    phase: 'new-install',
  });
  await writer.request({ action: 'save', registry: { entries: [SELF_ENTRY] } });
  const afterSelfRegistration = await readStoredRoot(state.configFile);
  assertRegistryNames(afterSelfRegistration, [SELF_ENTRY.name]);

  await writer.request({
    action: 'save',
    registry: { entries: [SELF_ENTRY, OTHER_ENTRY] },
  });
  const afterExplicitEntries = await readStoredRoot(state.configFile);
  assertRegistryNames(afterExplicitEntries, [SELF_ENTRY.name, OTHER_ENTRY.name]);
  await stopWriter(writer);

  return {
    emptyRegistryCreated: true,
    singleNewWriterStarted: true,
    selfRegistrationPersisted: true,
    explicitOtherEntryPersisted: true,
    readbackEntryCount: afterExplicitEntries.botRegistry.entries.length,
  };
}

async function exerciseUpgrade({
  temporaryRoot,
  artifacts,
  liveWriters,
  writerEvidence,
}) {
  const state = await createState(join(temporaryRoot, 'upgrade'), {
    includeRegistry: false,
  });
  const oldWriter = await startWriter({
    generation: 'old',
    artifact: artifacts.old,
    state,
    liveWriters,
    writerEvidence,
    phase: 'upgrade-old-writer',
  });

  const blocked = assertGateBlocksOldWriters(liveWriters);
  if (!blocked) throw new Error('upgrade gate did not block a live old writer');

  const hazard = await createState(join(temporaryRoot, 'upgrade-hazard-probe'), {
    includeRegistry: true,
    entries: [SELF_ENTRY, OTHER_ENTRY],
  });
  const hazardWriter = await startWriter({
    generation: 'old',
    artifact: artifacts.old,
    state: hazard,
    liveWriters,
    writerEvidence,
    phase: 'upgrade-hazard-probe',
  });
  await hazardWriter.request({ action: 'save' });
  const afterHistoricalSave = await readStoredRoot(hazard.configFile);
  if (Object.hasOwn(afterHistoricalSave, 'botRegistry')) {
    throw new Error('historical writer unexpectedly preserved botRegistry');
  }
  await stopWriter(hazardWriter);

  const oldPid = oldWriter.pid;
  await stopWriter(oldWriter);
  assertNoOldWriters(liveWriters);
  if (isPidAlive(oldPid)) throw new Error('old writer PID remains alive after controlled stop');

  const backup = await backupState(state, join(temporaryRoot, 'upgrade-backup'));
  const newWriter = await startWriter({
    generation: 'new',
    artifact: artifacts.new,
    state,
    liveWriters,
    writerEvidence,
    phase: 'upgrade-new-writer',
  });
  await newWriter.request({ action: 'save', registry: { entries: [SELF_ENTRY] } });
  await newWriter.request({
    action: 'save',
    registry: { entries: [SELF_ENTRY, OTHER_ENTRY] },
  });
  const upgraded = await readStoredRoot(state.configFile);
  assertRegistryNames(upgraded, [SELF_ENTRY.name, OTHER_ENTRY.name]);
  await delay(75);
  const stable = await readStoredRoot(state.configFile);
  assertRegistryNames(stable, [SELF_ENTRY.name, OTHER_ENTRY.name]);
  await stopWriter(newWriter);

  return {
    gateBlockedBeforeOldStop: blocked,
    historicalSaveDroppedRegistry: true,
    allOldWritersStoppedBeforeUpgradeWrite: true,
    oldPidConfirmedExited: true,
    backupMode: backup.mode,
    newWriterReadbackEntryCount: upgraded.botRegistry.entries.length,
    noOldOverwriteAfterUpgrade: true,
  };
}

async function exerciseRollbackReupgrade({
  temporaryRoot,
  artifacts,
  liveWriters,
  writerEvidence,
}) {
  const state = await createState(join(temporaryRoot, 'rollback-reupgrade'), {
    includeRegistry: true,
    entries: [SELF_ENTRY, OTHER_ENTRY],
  });
  const currentWriter = await startWriter({
    generation: 'new',
    artifact: artifacts.new,
    state,
    liveWriters,
    writerEvidence,
    phase: 'rollback-current-writer',
  });
  await currentWriter.request({ action: 'save' });
  await stopWriter(currentWriter);

  const rollbackBackup = await backupState(
    state,
    join(temporaryRoot, 'rollback-backup'),
  );
  const oldWriter = await startWriter({
    generation: 'old',
    artifact: artifacts.old,
    state,
    liveWriters,
    writerEvidence,
    phase: 'rollback-old-writer',
  });
  await oldWriter.request({ action: 'save' });
  const oldCompatible = await readStoredRoot(state.configFile);
  if (Object.hasOwn(oldCompatible, 'botRegistry')) {
    throw new Error('rollback did not produce an old-compatible config');
  }
  const registryBackup = await readStoredRoot(rollbackBackup.configFile);
  assertRegistryNames(registryBackup, [SELF_ENTRY.name, OTHER_ENTRY.name]);

  const reupgradeBlocked = assertGateBlocksOldWriters(liveWriters);
  if (!reupgradeBlocked) {
    throw new Error('re-upgrade gate did not block a live rollback writer');
  }
  const oldPid = oldWriter.pid;
  await stopWriter(oldWriter);
  assertNoOldWriters(liveWriters);
  if (isPidAlive(oldPid)) {
    throw new Error('rollback old writer PID remains alive before re-upgrade');
  }

  await restoreState(rollbackBackup, state);
  const restored = await readStoredRoot(state.configFile);
  assertRegistryNames(restored, [SELF_ENTRY.name, OTHER_ENTRY.name]);
  const restoredActive = (await readFile(state.activeProfileFile, 'utf8')).trim();
  if (restoredActive !== PROFILE) {
    throw new Error('active-profile backup was not restored');
  }

  const reupgradeWriter = await startWriter({
    generation: 'new',
    artifact: artifacts.new,
    state,
    liveWriters,
    writerEvidence,
    phase: 'reupgrade-new-writer',
  });
  await reupgradeWriter.request({ action: 'save' });
  const finalRoot = await readStoredRoot(state.configFile);
  assertRegistryNames(finalRoot, [SELF_ENTRY.name, OTHER_ENTRY.name]);
  await stopWriter(reupgradeWriter);

  return {
    allNewWritersStoppedBeforeRollback: true,
    rollbackBackupMode: rollbackBackup.mode,
    oldCompatibleConfigDroppedRegistry: true,
    registryRemainedInBackup: true,
    reupgradeBlockedUntilOldStop: reupgradeBlocked,
    oldPidConfirmedExitedBeforeRestore: true,
    backupRestoredRegistry: true,
    activeProfileRestored: true,
    finalReadbackEntryCount: finalRoot.botRegistry.entries.length,
  };
}

async function buildWriterArtifacts(repositoryRoot, temporaryRoot) {
  const oldSourceRoot = join(temporaryRoot, 'historical-source');
  for (const path of HISTORICAL_FILES) {
    const destination = join(oldSourceRoot, path);
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repositoryRoot, 'show', `${HISTORICAL_SOURCE_REF}:${path}`],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ).catch((error) => {
      throw new Error(
        `historical writer source is unavailable at ${HISTORICAL_SOURCE_REF}: ${errorMessage(error)}`,
      );
    });
    await writePrivateFile(destination, stdout);
  }

  const oldPackage = JSON.parse(
    (await execFileAsync(
      'git',
      ['-C', repositoryRoot, 'show', `${HISTORICAL_SOURCE_REF}:package.json`],
      { encoding: 'utf8' },
    )).stdout,
  );
  const currentPackage = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  );

  const old = await buildWriterArtifact({
    sourceRoot: oldSourceRoot,
    outputRoot: join(temporaryRoot, 'artifacts', 'old'),
    sourceRef: HISTORICAL_SOURCE_REF,
    version: String(oldPackage.version),
    dependencyRoot: repositoryRoot,
  });
  const currentRef = (
    await execFileAsync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    })
  ).stdout.trim();
  const current = await buildWriterArtifact({
    sourceRoot: repositoryRoot,
    outputRoot: join(temporaryRoot, 'artifacts', 'new'),
    sourceRef: currentRef,
    version: String(currentPackage.version),
    dependencyRoot: repositoryRoot,
  });
  return { old, new: current };
}

async function buildWriterArtifact({
  sourceRoot,
  outputRoot,
  sourceRef,
  version,
  dependencyRoot,
}) {
  const entry = join(outputRoot, 'writer-entry.ts');
  const profileStore = join(sourceRoot, 'src/config/profile-store.ts')
    .replaceAll('\\', '/');
  await writePrivateFile(
    entry,
    writerEntrySource(profileStore),
  );
  const outDir = join(outputRoot, 'bundle');
  await build({
    entry: { writer: entry },
    outDir,
    clean: true,
    dts: false,
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    splitting: false,
    sourcemap: false,
    silent: true,
    noExternal: [/.*/],
    esbuildOptions(options) {
      options.nodePaths = [join(dependencyRoot, 'node_modules')];
    },
    outExtension: () => ({ js: '.cjs' }),
  });
  const path = join(outDir, 'writer.cjs');
  const bytes = await readFile(path);
  return {
    path,
    sourceRef,
    version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function writerEntrySource(profileStore) {
  return `
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { loadRootConfig, saveRootConfig } from ${JSON.stringify(profileStore)};

const configFile = process.env.ACCEPTANCE_CONFIG;
const meta = JSON.parse(process.env.ACCEPTANCE_META || '{}');
if (!configFile) throw new Error('ACCEPTANCE_CONFIG is required');
main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\\n');
  process.exit(1);
});

async function main() {
  write({ event: 'ready', pid: process.pid, ...meta });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const command = JSON.parse(line);
    try {
      if (command.action === 'shutdown') {
        write({ event: 'stopping', requestId: command.requestId, pid: process.pid });
        process.exit(0);
      }
      if (command.action !== 'save') throw new Error('unsupported action');
      const root = await loadRootConfig(configFile);
      if (!root) throw new Error('isolated root config is missing');
      if (command.registry !== undefined) root.botRegistry = command.registry;
      await saveRootConfig(root, configFile);
      const stored = JSON.parse(await readFile(configFile, 'utf8'));
      write({
        event: 'saved',
        requestId: command.requestId,
        pid: process.pid,
        hasRegistry: Object.hasOwn(stored, 'botRegistry'),
        entryCount: stored.botRegistry?.entries?.length ?? 0,
      });
    } catch (error) {
      write({
        event: 'error',
        requestId: command.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
`;
}

async function startWriter({
  generation,
  artifact,
  state,
  liveWriters,
  writerEvidence,
  phase,
}) {
  assertPathInside(state.temporaryRoot, state.configFile);
  const env = makeIsolatedEnvironment(state.rootDir, {
    ACCEPTANCE_CONFIG: state.configFile,
    ACCEPTANCE_META: JSON.stringify({
      generation,
      sourceRef: artifact.sourceRef,
      version: artifact.version,
      artifact: basename(artifact.path),
    }),
  });
  assertEnvironmentIsolation(env, state.temporaryRoot);
  const child = spawn(process.execPath, [artifact.path], {
    cwd: state.rootDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const writer = createWriterController(child, generation);
  liveWriters.add(writer);
  writer.onExit = () => liveWriters.delete(writer);
  const ready = await writer.ready;
  if (ready.pid !== child.pid) throw new Error('writer PID handshake mismatch');
  writerEvidence.push({
    phase,
    generation,
    pid: ready.pid,
    artifact: basename(artifact.path),
    artifactSha256: artifact.sha256,
    sourceRef: artifact.sourceRef,
    version: artifact.version,
  });
  return writer;
}

function createWriterController(child, generation) {
  let nextRequest = 1;
  let exited = false;
  let stderr = '';
  let exitHook;
  const messages = [];
  const waiters = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiterIndex = waiters.findIndex((waiter) => waiter.match(message));
    if (waiterIndex === -1) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    waiter.resolve(message);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitHook?.();
      resolve({ code, signal });
    });
  });

  function waitFor(match, timeoutMs = 5_000) {
    const index = messages.findIndex(match);
    if (index !== -1) {
      const [message] = messages.splice(index, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`writer response timeout; stderr=${stderr.trim() || '<empty>'}`));
      }, timeoutMs);
      const waiter = {
        match,
        resolve(message) {
          clearTimeout(timer);
          resolveWait(message);
        },
      };
      waiters.push(waiter);
    });
  }

  const controller = {
    child,
    generation,
    set onExit(hook) {
      exitHook = hook;
    },
    get pid() {
      return child.pid;
    },
    get exited() {
      return exited;
    },
    ready: waitFor((message) => message.event === 'ready'),
    async request(command) {
      if (exited) throw new Error('writer has already exited');
      const requestId = nextRequest++;
      child.stdin.write(`${JSON.stringify({ ...command, requestId })}\n`);
      const response = await waitFor((message) => message.requestId === requestId);
      if (response.event === 'error') throw new Error(response.message);
      return response;
    },
    exitPromise,
  };
  return controller;
}

async function stopWriter(writer) {
  if (writer.exited) return;
  await writer.request({ action: 'shutdown' }).catch(() => {});
  writer.child.stdin.end();
  const result = await Promise.race([
    writer.exitPromise,
    delay(5_000).then(() => ({ timeout: true })),
  ]);
  if (result?.timeout) {
    throw new Error(`controlled writer PID ${writer.pid} did not exit`);
  }
}

function assertGateBlocksOldWriters(liveWriters) {
  const old = [...liveWriters].filter(
    (writer) => writer.generation === 'old' && !writer.exited,
  );
  return old.length > 0;
}

function assertNoOldWriters(liveWriters) {
  if (assertGateBlocksOldWriters(liveWriters)) {
    throw new Error('old writer remains active at the upgrade write boundary');
  }
}

async function createState(rootDir, { includeRegistry, entries = [] }) {
  const configFile = join(rootDir, 'config.json');
  const activeProfileFile = join(rootDir, 'active-profile');
  const root = fixtureRoot();
  if (includeRegistry) root.botRegistry = { entries };
  await writeJson600(configFile, root);
  await writePrivateFile(activeProfileFile, `${PROFILE}\n`);
  return {
    temporaryRoot: dirname(rootDir),
    rootDir,
    configFile,
    activeProfileFile,
  };
}

function fixtureRoot() {
  return {
    schemaVersion: 2,
    activeProfile: PROFILE,
    preferences: {},
    profiles: {
      [PROFILE]: {
        schemaVersion: 2,
        agentKind: 'claude',
        mode: 'personal',
        accounts: {
          app: {
            id: SELF_ENTRY.appId,
            secret: 'fixture-secret-only-not-real',
            tenant: 'feishu',
          },
        },
        preferences: {
          messageReply: 'markdown',
          showToolCalls: 'brief',
        },
        access: {
          allowedUsers: [],
          allowedChats: [],
          admins: [],
          botAdmins: [],
          groupResponseMode: 'mention-only',
          requireMentionInGroup: true,
          ownerNoMentionChats: [],
        },
        workspaces: {},
        permissions: {
          defaultAccess: 'workspace',
          maxAccess: 'full',
        },
        attachments: {
          maxCount: 4,
          maxBytes: 8_000_000,
          maxFileBytes: 4_000_000,
          imageMaxBytes: 4_000_000,
          cacheTtlMs: 60_000,
          cacheMaxBytes: 16_000_000,
        },
        comments: {},
        larkCli: {
          identityPreset: 'bot-only',
        },
      },
    },
  };
}

async function backupState(state, backupRoot) {
  const configFile = join(backupRoot, 'config.json');
  const activeProfileFile = join(backupRoot, 'active-profile');
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await copyFile(state.configFile, configFile);
  await copyFile(state.activeProfileFile, activeProfileFile);
  await chmod(configFile, 0o600);
  await chmod(activeProfileFile, 0o600);
  const configMode = await ownerOnlyMode(configFile);
  const activeMode = await ownerOnlyMode(activeProfileFile);
  return {
    configFile,
    activeProfileFile,
    mode: process.platform === 'win32'
      ? 'owner-only-requested-platform-limited'
      : `${configMode}/${activeMode}`,
  };
}

async function restoreState(backup, state) {
  await copyFile(backup.configFile, state.configFile);
  await copyFile(backup.activeProfileFile, state.activeProfileFile);
  await chmod(state.configFile, 0o600);
  await chmod(state.activeProfileFile, 0o600);
}

async function ownerOnlyMode(path) {
  const mode = (await stat(path)).mode & 0o777;
  if (process.platform !== 'win32' && mode !== 0o600) {
    throw new Error(`backup is not mode 0600: ${basename(path)}`);
  }
  return mode.toString(8).padStart(3, '0');
}

async function readStoredRoot(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assertRegistryNames(root, expectedNames) {
  const actual = root.botRegistry?.entries?.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `registry readback mismatch: expected ${expected.length}, got ${actual?.length ?? 0}`,
    );
  }
}

function makeIsolatedEnvironment(rootDir, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(BRIDGE_ENV_PREFIX) || EXTRA_BRIDGE_ENV_KEYS.has(key)) {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    LARK_CHANNEL: '0',
    LARK_CHANNEL_HOME: rootDir,
    LARK_CHANNEL_PROFILE: PROFILE,
    LARK_CHANNEL_CONFIG: join(rootDir, 'config.json'),
    LARKSUITE_CLI_CONFIG_DIR: join(rootDir, 'profiles', PROFILE, 'lark-cli'),
    ...extra,
  };
}

function assertEnvironmentIsolation(env, temporaryRoot) {
  if (env.LARK_CHANNEL !== '0') {
    throw new Error('controlled writer must not inherit live bridge mode');
  }
  for (const key of [
    'LARK_CHANNEL_HOME',
    'LARK_CHANNEL_CONFIG',
    'LARKSUITE_CLI_CONFIG_DIR',
  ]) {
    assertPathInside(temporaryRoot, env[key]);
  }
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(BRIDGE_ENV_PREFIX) && !EXTRA_BRIDGE_ENV_KEYS.has(key)) {
      continue;
    }
    if (Object.hasOwn(env, key) && env[key] === process.env[key]) {
      throw new Error(`bridge environment key was inherited unchanged: ${key}`);
    }
  }
}

function assertPathInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (rel.startsWith('..') || rel === '..' || resolve(path) === resolve(root)) {
    throw new Error('acceptance path escaped its temporary root');
  }
}

async function writeJson600(path, value) {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateFile(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

async function assertRepositorySource(root) {
  const packagePath = join(root, 'package.json');
  const parsed = JSON.parse(await readFile(packagePath, 'utf8'));
  if (parsed.name !== '@penn.qp/lark-channel-bridge') {
    throw new Error('mixed-version acceptance must run from the bridge repository');
  }
}

function publicArtifactEvidence(artifact) {
  return {
    artifact: basename(artifact.path),
    artifactSha256: artifact.sha256,
    sourceRef: artifact.sourceRef,
    version: artifact.version,
  };
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const evidence = await runMixedVersionMigrationAcceptance();
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error(`mixed-version migration acceptance failed: ${errorMessage(error)}`);
    process.exit(1);
  }
}
