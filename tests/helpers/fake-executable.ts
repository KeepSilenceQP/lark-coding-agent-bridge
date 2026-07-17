import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeVersionExecutable(
  root: string,
  name: string,
  version: string,
  marker = '',
): Promise<string> {
  await mkdir(root, { recursive: true });
  const file = join(root, process.platform === 'win32' && !isCmd(name) ? `${name}.CMD` : name);
  await writeVersionExecutableFile(file, version, marker);
  return file;
}

export async function writeVersionExecutableFile(
  file: string,
  version: string,
  marker = '',
): Promise<void> {
  if (isCmd(file)) {
    const remark = marker ? `rem ${marker}\r\n` : '';
    await writeFile(file, `@echo off\r\necho ${version}\r\n${remark}`, { mode: 0o755 });
    return;
  }

  const comment = marker ? `// ${marker}\n` : '';
  await writeFile(file, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n${comment}`, {
    mode: 0o755,
  });
  await chmod(file, 0o755);
}

export async function writeCodexPromptInputExecutable(
  root: string,
  name: string,
  version: string,
  recordPath: string,
  promptInputMode:
    | 'valid'
    | 'wrong-role'
    | 'delayed-valid'
    | 'malformed'
    | 'nonzero'
    | 'duplicate'
    | 'overflow'
    | 'ignore-term' = 'valid',
): Promise<string> {
  await mkdir(root, { recursive: true });
  const file = join(root, name);
  const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  args,
  cwd: process.cwd(),
  env: {
    CODEX_HOME: process.env.CODEX_HOME,
    LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,
    LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,
    LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,
    LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,
  },
}) + '\\n');
if (args.includes('--version')) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'prompt-input') {
  const configIndex = args.indexOf('-c');
  const config = configIndex >= 0 ? args[configIndex + 1] : '';
  const prefix = 'developer_instructions=';
  const encoded = config.startsWith(prefix) ? config.slice(prefix.length) : '';
  let developerText = encoded;
  try { developerText = JSON.parse(encoded); } catch {}
  const userText = args.at(-1) ?? '';
  const mode = ${JSON.stringify(promptInputMode)};
  if (mode === 'nonzero') {
    console.error('debug prompt-input unsupported');
    process.exit(2);
  }
  if (mode === 'malformed') {
    console.log('{not-json');
    process.exit(0);
  }
  if (mode === 'overflow' || mode === 'ignore-term') {
    process.on('SIGTERM', () => {
      appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ signal: 'SIGTERM' }) + '\\n');
    });
    if (mode === 'overflow') process.stdout.write('x'.repeat(4096));
    setInterval(() => {}, 1000);
    return;
  }
  const wrongRole = mode === 'wrong-role';
  const emit = () => {
    const messages = [
      { role: wrongRole ? 'user' : 'developer', content: [{ type: 'input_text', text: developerText }] },
      { role: wrongRole ? 'developer' : 'user', content: [{ type: 'input_text', text: userText }] },
    ];
    if (mode === 'duplicate') messages.push({ role: 'developer', content: [{ type: 'input_text', text: developerText }] });
    console.log(JSON.stringify(messages));
    process.exit(0);
  };
  if (mode === 'delayed-valid') {
    process.on('SIGTERM', () => {
      appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ signal: 'SIGTERM' }) + '\\n');
      process.exit(0);
    });
    setTimeout(emit, 300);
  } else {
    emit();
  }
  return;
}
console.error('unsupported fake codex invocation');
process.exit(2);
`;
  await writeFile(file, script, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

function isCmd(path: string): boolean {
  return path.toLowerCase().endsWith('.cmd');
}
