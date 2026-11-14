import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { describe, expect, it } from 'vitest';
import { createRootConfig, saveRootConfig } from '../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { createRouteLease } from '../../src/runtime/route-lease';
import { readPending, readTerminal } from '../../src/runtime/restart-receipt';

const run = promisify(execFile);

describe('pre-qp.15 supervisor self-upgrade process handoff', () => {
  it.each(['v0.7.1-qp.13', 'v0.7.1-qp.14'])('lets the actual %s helper restart the shared service and receive the new-process receipt', async (tag) => {
    // Keep the generated bundles under node_modules so external dependencies
    // resolve normally. No user profile, OS service, or network is accessed.
    const dir = await mkdtemp(join(process.cwd(), 'node_modules', '.legacy-supervisor-'));
    const profile = 'trae-cli';
    const profileDir = join(dir, 'profiles', profile);
    const oldPid = 2147483000;
    const source = (path: string) => resolve(process.cwd(), path).replaceAll('\\', '/');
    const state = join(dir, 'service.json');
    const entry = join(dir, 'fixture.ts');
    try {
      const profileConfig = (id: string) => createDefaultProfileConfig({
        agentKind: 'codex', codex: { binaryPath: process.execPath },
        accounts: { app: { id, secret: 'fixture-only', tenant: 'feishu' } },
      });
      const config = createRootConfig('codex', profileConfig('cli_codex'));
      config.profiles[profile] = profileConfig('cli_fixture');
      config.profiles.other = profileConfig('cli_other');
      await saveRootConfig(config, join(dir, 'config.json'));
      await mkdir(join(dir, 'registry'), { recursive: true });
      await writeFile(join(dir, 'registry', 'processes.json'), JSON.stringify({ entries:
        [profile, 'codex', 'other'].map((name) => ({
          id: name, pid: oldPid, appId: name === profile ? 'cli_fixture' : `cli_${name}`,
          tenant: 'feishu', profileName: name, agentKind: 'codex', configPath: join(dir, 'config.json'),
          version: tag, botName: name, startedAt: new Date().toISOString(),
        })),
      }));
      await writeFile(state, JSON.stringify({ pid: oldPid }));
      const lease = await createRouteLease(profileDir, {
        bridgePid: oldPid, chatId: 'oc_original', threadId: 'omt_original', replyTo: 'om_original',
      });
      // Freeze the legacy implementation from the released tag, rather than
      // approximating its consume/launch behavior using current production code.
      const oldSource = execFileSync('git', ['show', `${tag}:src/runtime/deferred-service-restart.ts`],
        { encoding: 'utf8' })
        .replace("'../platform/spawn'", JSON.stringify(source('src/platform/spawn.ts')))
        .replace("'./restart-receipt'", JSON.stringify(source('src/runtime/restart-receipt.ts')));
      await writeFile(join(dir, 'legacy.ts'), oldSource);
      await writeFile(entry, `
        import { runServiceRestart } from ${JSON.stringify(source('src/cli/commands/service.ts'))};
        import { handleNewBridgePendingReceipt } from ${JSON.stringify(source('src/bot/channel.ts'))};
        import { startSupervisorProfiles } from ${JSON.stringify(source('src/runtime/supervisor-resume.ts'))};
        import { mkdir, writeFile, appendFile } from 'node:fs/promises';
        import { join } from 'node:path';
        const root = process.env.LARK_CHANNEL_HOME!;
        const profile = 'trae-cli';
        if (process.argv[2] === 'new-runtime') {
          globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            if (String(url).endsWith('/tenant_access_token/internal')) {
              return new Response(JSON.stringify({ code: 0, tenant_access_token: 'fixture-only' }));
            }
            if (!String(url).includes('/im/v1/messages/om_original/reply')) throw new Error('unexpected fixture HTTP');
            await appendFile(join(root, 'receipts.jsonl'), JSON.stringify({ url: String(url), body: JSON.parse(String(options?.body)) }) + '\\n');
            return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_receipt' } }));
          }) as typeof fetch;
          await mkdir(join(root, 'registry'), { recursive: true });
          await writeFile(join(root, 'service.json'), JSON.stringify({ pid: process.pid }));
          const entries: object[] = [];
          await startSupervisorProfiles({ rootDir: root, defaultProfile: 'codex',
            startProfile: async (name) => {
              entries.push({
                id: name, pid: process.pid, appId: name === profile ? 'cli_fixture' : 'cli_' + name,
                tenant: 'feishu', profileName: name, agentKind: 'codex', configPath: join(root, 'config.json'),
                startedAt: new Date().toISOString(), version: 'new-runtime', botName: name,
              });
              await writeFile(join(root, 'registry', 'processes.json'), JSON.stringify({ entries }));
              await handleNewBridgePendingReceipt({} as never, name, join(root, 'profiles', name));
            },
            onError: (_name, error) => { throw error; },
          });
        } else {
          await runServiceRestart({ profile });
        }
      `);
      await build({
        entry: { fixture: entry, legacy: join(dir, 'legacy.ts') }, outDir: dir,
        format: ['esm'], platform: 'node', target: 'node20', config: false, silent: true,
        outExtension: () => ({ js: '.mjs' }),
        esbuildOptions(options) { options.loader = { ...options.loader, '.html': 'text' }; },
        esbuildPlugins: [{ name: 'fixture-service-manager', setup(builder) {
          builder.onLoad({ filter: /[/\\]daemon[/\\]service-adapter\.ts$/ }, () => ({
            loader: 'ts', contents: `
              import { readFileSync, existsSync, appendFileSync } from 'node:fs';
              import { join } from 'node:path';
              import { execFile } from 'node:child_process';
              import { promisify } from 'node:util';
              export function getServiceAdapter(id: string) {
                const root = process.env.LARK_CHANNEL_HOME!;
                return { fileExists: () => id === 'supervisor', isRunning: () => true,
                  describeStatus: () => readFileSync(join(root, 'service.json'), 'utf8'),
                  parseStatus: (raw: string) => ({ pid: String(JSON.parse(raw).pid) }),
                  restart: async () => {
                    if (!existsSync(join(root, 'reply-finished'))) throw new Error('interrupted reply');
                    appendFileSync(join(root, 'service-actions'), id + '\\n');
                    await promisify(execFile)(process.execPath, [process.argv[1]!, 'new-runtime'], { env: process.env });
                    return { ok: true, stderr: '' };
                  },
                };
              }
            `,
          }));
        } }],
      });
      const cli = join(dir, 'fixture.mjs');
      const env = { ...process.env, LARK_CHANNEL: '1', LARK_CHANNEL_HOME: dir,
        LARK_CHANNEL_PROFILE: profile, LARK_CHANNEL_BRIDGE_PID: String(oldPid),
        LARK_CHANNEL_ROUTE_ID: lease!.routeId };
      const request = await run(process.execPath, [cli, 'request'], { env });
      expect(request.stdout).toContain('已安排旧版 supervisor 首次升级重启');
      expect(await readPending(profileDir)).toMatchObject({ serviceId: 'supervisor', oldPid });
      await expect(readFile(join(dir, 'service-actions'))).rejects.toMatchObject({ code: 'ENOENT' });
      const legacy = await import(pathToFileURL(join(dir, 'legacy.mjs')).href);
      const consumed = await legacy.consumeDeferredServiceRestart(profileDir, oldPid);
      expect(consumed.format).toBe('new');
      expect(consumed.serviceId).toBeUndefined(); // The old runtime discards the new field.
      await writeFile(join(dir, 'reply-finished'), 'final reply delivered');
      const helperExit = new Promise<number | null>((resolveExit, reject) => {
        legacy.launchDeferredServiceRestart(profile, { cliPath: cli, env,
          spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
            const helper = spawn(command, args, options);
            helper.once('error', reject);
            helper.once('close', resolveExit);
            return helper;
          },
        });
      });
      expect(await helperExit).toBe(0);
      expect(await readTerminal(profileDir, consumed.receiptId)).toMatchObject({ kind: 'success', outcome: 'completed' });
      expect(await readFile(join(dir, 'service-actions'), 'utf8')).toBe('supervisor\n');
      const receipts = (await readFile(join(dir, 'receipts.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].body.reply_in_thread).toBe(true);
      expect(JSON.parse(receipts[0].body.content).text).toContain('重启成功');
      expect(await readPending(profileDir)).toBeUndefined();
      expect(JSON.parse(await readFile(state, 'utf8')).pid).not.toBe(oldPid);
      const fleet = JSON.parse(await readFile(join(dir, 'registry', 'processes.json'), 'utf8')).entries;
      expect(fleet.map((bot: { profileName: string }) => bot.profileName)).toEqual(['trae-cli', 'codex', 'other']);
      expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).activeProfile).toBe('codex');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
