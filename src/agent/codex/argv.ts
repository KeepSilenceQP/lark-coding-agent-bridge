import type { SandboxMode } from '../../config/profile-schema';

export interface BuildCodexArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  developerInstructions?: string;
  /** Forwarded to `codex exec --model`. Omitted uses the Codex default. */
  model?: string;
  reasoningEffort?: string;
  serviceTier?: 'fast' | 'default';
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  const globalFlags = [
    '--sandbox',
    input.sandbox,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`] : []),
    ...(input.serviceTier ? ['-c', `service_tier=${JSON.stringify(input.serviceTier)}`] : []),
    ...(input.serviceTier === 'fast' ? ['-c', 'features.fast_mode=true'] : []),
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    ...(input.developerInstructions === undefined
      ? []
      : ['-c', `developer_instructions=${JSON.stringify(input.developerInstructions)}`]),
    ...(input.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
    '-C',
    input.cwd,
  ];

  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  if (input.threadId) {
    return [
      'exec',
      ...globalFlags,
      'resume',
      '--json',
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    'exec',
    '--json',
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}
