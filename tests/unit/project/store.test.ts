import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  disableProjectRoleAssignment,
  readProjectRoleAssignment,
  readProjectRoleAssignmentState,
  updateProjectRoleAssignment,
  type ProjectRoleAssignment,
} from '../../../src/project/store.js';

const tempDirs: string[] = [];

function assignment(workspace: string): ProjectRoleAssignment {
  return {
    workspace,
    decisionOwner: { openId: `owner-${workspace}` },
    coordinator: { botId: `coordinator-${workspace}`, name: 'Coordinator' },
    planWriter: { botId: `writer-${workspace}`, name: 'Writer' },
    implementer: { botId: `implementer-${workspace}`, name: 'Implementer' },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('project role assignment store', () => {
  it('serializes concurrent chat updates without losing either assignment', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'bridge-project-store-'));
    tempDirs.push(profileDir);
    const path = join(profileDir, 'projects.json');

    await Promise.all([
      updateProjectRoleAssignment(path, 'chat-a', assignment('workspace-a')),
      updateProjectRoleAssignment(path, 'chat-b', assignment('workspace-b')),
    ]);

    await expect(readProjectRoleAssignment(profileDir, 'chat-a')).resolves.toEqual(
      assignment('workspace-a'),
    );
    await expect(readProjectRoleAssignment(profileDir, 'chat-b')).resolves.toEqual(
      assignment('workspace-b'),
    );
  });

  it('does not expose obsolete derived-role fields from persisted data', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'bridge-project-store-'));
    tempDirs.push(profileDir);
    await writeFile(join(profileDir, 'projects.json'), JSON.stringify({
      chats: {
        'chat-a': {
          ...assignment('workspace-a'),
          planReviewer: { botId: 'legacy-reviewer', name: 'Legacy Reviewer' },
          codeReviewer: { botId: 'legacy-code-reviewer', name: 'Legacy Code Reviewer' },
          fix: { botId: 'legacy-fix', name: 'Legacy Fix' },
        },
      },
    }));

    const loaded = await readProjectRoleAssignment(profileDir, 'chat-a');
    expect(loaded).toEqual(assignment('workspace-a'));
    expect(loaded).not.toHaveProperty('planReviewer');
    expect(loaded).not.toHaveProperty('codeReviewer');
    expect(loaded).not.toHaveProperty('fix');
  });

  it('preserves but does not expose a disabled assignment until a complete update re-enables it', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'bridge-project-store-'));
    tempDirs.push(profileDir);
    const path = join(profileDir, 'projects.json');
    const original = assignment('workspace-a');

    await updateProjectRoleAssignment(path, 'chat-a', original);
    await disableProjectRoleAssignment(path, 'chat-a', 'bootstrap_incomplete');

    await expect(readProjectRoleAssignment(profileDir, 'chat-a')).resolves.toBeUndefined();
    await expect(readProjectRoleAssignmentState(profileDir, 'chat-a')).resolves.toEqual({
      assignment: original,
      usable: false,
      disabledReason: 'bootstrap_incomplete',
    });

    const replacement = assignment('workspace-b');
    await updateProjectRoleAssignment(path, 'chat-a', replacement);
    await expect(readProjectRoleAssignment(profileDir, 'chat-a')).resolves.toEqual(replacement);
    await expect(readProjectRoleAssignmentState(profileDir, 'chat-a')).resolves.toEqual({
      assignment: replacement,
      usable: true,
    });
  });
});
