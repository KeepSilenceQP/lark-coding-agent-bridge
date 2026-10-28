import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repack the exact maintained .1 distribution; never rebuild unrelated code.
// Source-map sourcesContent supplies the matching TypeScript review patch.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const base = join(vendor, 'larksuite-channel-0.6.0-qp.1.tgz');
const expectedSha256 = '449ee16106a1afd2557f817e867988c09a7b44be609a24967ff061482ab51bff';
const actualSha256 = createHash('sha256').update(await readFile(base)).digest('hex');
if (actualSha256 !== expectedSha256) throw new Error(`Unexpected base tarball SHA-256: ${actualSha256}`);

function replaceOnce(text, before, after) {
  const start = text.indexOf(before);
  if (start < 0 || text.indexOf(before, start + before.length) >= 0) {
    throw new Error(`Patch context must occur exactly once: ${JSON.stringify(before.slice(0, 90))}`);
  }
  return text.slice(0, start) + after + text.slice(start + before.length);
}

function patchBundle(text) {
  for (const [before, after] of [
    ['let stopped = false;\n\tconst tick = async () => {', 'let stopped = false;\n\tlet ticking = false;\n\tconst tick = async () => {'],
    ['const status = getConnectionStatus();', 'let status = getConnectionStatus();'],
    ['\t\tif (!await httpProbe(domain)) {', `\t\tconst reachable = await httpProbe(domain);
\t\tif (stopped) return;
\t\tstatus = getConnectionStatus();
\t\tif (!status || status.state === "connected") {
\t\t\tconsecutiveDown = 0;
\t\t\tnetworkDownTicks = 0;
\t\t\treturn;
\t\t}
\t\tif (!reachable) {`],
    ['\t\t\t} catch (err) {\n\t\t\t\tlogger.error?.("channel: keepalive force-reconnect failed", err);', '\t\t\t} catch (err) {\n\t\t\t\tif (stopped) return;\n\t\t\t\tlogger.error?.("channel: keepalive force-reconnect failed", err);'],
    ['\tconst timer = setInterval(() => {\n\t\ttick().catch((err) => logger.error?.("channel: keepalive tick failed", err));\n\t}, intervalMs);', `\tconst timer = setInterval(() => {
\t\tif (stopped || ticking) return;
\t\tticking = true;
\t\ttick().catch((err) => logger.error?.("channel: keepalive tick failed", err)).finally(() => { ticking = false; });
\t}, intervalMs);`],
    ['\tasync forceReconnect() {\n\t\ttry {', '\tasync forceReconnect() {\n\t\tif (!this.connected) return;\n\t\ttry {'],
    ['\tasync disconnect() {\n\t\tif (!this.connected) return;', '\tasync disconnect() {\n\t\tif (!this.connected) return;\n\t\tthis.connected = false;'],
    ['\t\tthis.connected = false;\n\t\tthis.connectPromise = void 0;\n\t}', '\t\tthis.connectPromise = void 0;\n\t}'],
  ]) text = replaceOnce(text, before, after);
  // The edited bundles no longer match upstream positions. Do not ship stale
  // source maps or misleading sourceMappingURL references.
  return text.replace(/\n\/\/# sourceMappingURL=index\.(?:mjs|cjs)\.map\s*$/, '\n');
}

function patchSource(name, text) {
  const edits = name === 'keepalive.ts' ? [
    ['  let stopped = false;', '  let stopped = false;\n  let ticking = false;'],
    ['    const status = getConnectionStatus();', '    let status = getConnectionStatus();'],
    ['    const reachable = await httpProbe(domain);', `    const reachable = await httpProbe(domain);
    // stop() or the SDK's own recovery may have won while the probe awaited.
    if (stopped) return;
    status = getConnectionStatus();
    if (!status || status.state === 'connected') {
      consecutiveDown = 0;
      networkDownTicks = 0;
      return;
    }`],
    ["      } catch (err) {\n        logger.error?.('channel: keepalive force-reconnect failed', err);", "      } catch (err) {\n        if (stopped) return;\n        logger.error?.('channel: keepalive force-reconnect failed', err);"],
    ["  const timer = setInterval(() => {\n    void tick().catch((err) => logger.error?.('channel: keepalive tick failed', err));\n  }, intervalMs);", `  const timer = setInterval(() => {
    // Keep probe/handshake work single-flight, including custom short intervals.
    if (stopped || ticking) return;
    ticking = true;
    void tick().catch((err) => logger.error?.('channel: keepalive tick failed', err))
      .finally(() => { ticking = false; });
  }, intervalMs);`],
  ] : [
    ['  private async forceReconnect(): Promise<void> {', '  private async forceReconnect(): Promise<void> {\n    if (!this.connected) return;'],
    ['  async disconnect(): Promise<void> {\n    if (!this.connected) return;', '  async disconnect(): Promise<void> {\n    if (!this.connected) return;\n    this.connected = false;'],
    ['    this.connected = false;\n    this.connectPromise = undefined;\n  }', '    this.connectPromise = undefined;\n  }'],
  ];
  for (const [before, after] of edits) text = replaceOnce(text, before, after);
  return text;
}

const scratch = await mkdtemp(join(tmpdir(), 'larksuite-channel-repack-'));
try {
  execFileSync('tar', ['-xzf', base, '-C', scratch]);
  const pkgDir = join(scratch, 'package');
  const dist = join(pkgDir, 'dist');
  const sourceMap = JSON.parse(await readFile(join(dist, 'index.mjs.map'), 'utf8'));
  const diffs = [];
  for (const name of ['keepalive.ts', 'channel.ts']) {
    const source = sourceMap.sourcesContent[sourceMap.sources.indexOf(`../src/${name}`)];
    if (typeof source !== 'string') throw new Error(`Missing original source: ${name}`);
    const oldPath = join(scratch, `old-${name}`);
    const newPath = join(scratch, `new-${name}`);
    await writeFile(oldPath, source);
    await writeFile(newPath, patchSource(name, source));
    const diff = spawnSync('diff', ['-U0', '--label', `a/src/${name}`, '--label', `b/src/${name}`, oldPath, newPath], { encoding: 'utf8' });
    if (diff.status !== 1) throw new Error(`Source diff failed: ${diff.stderr}`);
    diffs.push(diff.stdout);
  }
  await mkdir(join(vendor, 'patches'), { recursive: true });
  await writeFile(join(vendor, 'patches', 'larksuite-channel-0.6.0-qp.2.patch'), diffs.join(''));
  for (const name of ['index.mjs', 'index.cjs']) {
    const path = join(dist, name);
    await writeFile(path, patchBundle(await readFile(path, 'utf8')));
    await rm(`${path}.map`);
  }
  const manifestPath = join(pkgDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== '0.6.0-qp.1') throw new Error('Unexpected base package version');
  manifest.version = '0.6.0-qp.2';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', vendor], { cwd: pkgDir, encoding: 'utf8' }));
  const artifact = join(vendor, packed[0].filename);
  console.log(JSON.stringify({ artifact, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
