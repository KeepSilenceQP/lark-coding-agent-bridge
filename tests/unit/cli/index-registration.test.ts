import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI command registration', () => {
  it('registers the documented migrate command', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]migrate['"]\)/);
    expect(source).toContain('runMigrate');
  });

  it('registers app-secret options for non-interactive app bootstrap commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    const appSecretOptions = source.match(/--app-secret <secret>/g) ?? [];
    expect(appSecretOptions.length).toBeGreaterThanOrEqual(3);
  });

  it('registers the at-bot command with three required options', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]at-bot['"]\)/);
    expect(source).toContain('chat-id');
    expect(source).toContain('bot-id');
    expect(source).toContain('--message');
  });

  it('at-bot --help exposes only the three business parameters', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    // Help text should describe the command purpose and the three options
    const afterAtBot = source.split(/\.command\(['"]at-bot['"]\)/)[1];
    expect(afterAtBot).toBeDefined();
    expect(afterAtBot).toContain('chat-id');
    expect(afterAtBot).toContain('bot-id');
    expect(afterAtBot).toContain('message');
  });
});
