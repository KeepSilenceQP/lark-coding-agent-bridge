import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCapability, codexCapability } from '../../../src/agent/capability';
import type { AccessMode } from '../../../src/config/permissions';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import {
  evaluateRunPolicy,
  type RunPolicyInput,
  type ScopeContext,
} from '../../../src/policy/run-policy';

describe('run policy', () => {
  it('rejects when the upstream access decision denies the actor', () => {
    const result = evaluateRunPolicy({
      ...baseInput(),
      access: { ok: false, reason: 'denied-user' },
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'access-denied',
      },
    });
  });

  it('allows any resolved working directory because cwd is not an authorization boundary', () => {
    const result = evaluateRunPolicy({
      ...baseInput(),
      requestedCwd: '/outside/project',
      cwdRealpath: '/outside/project',
      profileConfig: profile(),
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    ['full', 'danger-full-access', 'bypassPermissions'],
    ['workspace', 'workspace-write', 'acceptEdits'],
    ['read-only', 'read-only', 'plan'],
  ] as const)(
    'maps %s access to Codex sandbox and Claude permission mode',
    (accessMode, sandbox, permissionMode) => {
      const result = evaluateRunPolicy(
        baseInput({
          profileConfig: profile({
            permissions: {
              defaultAccess: accessMode,
              maxAccess: accessMode,
            },
          }),
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected run policy to allow');
      expect(result.accessMode).toBe(accessMode);
      expect(result.sandbox).toBe(sandbox);
      expect(result.permissionMode).toBe(permissionMode);
    },
  );

  it('does not raise access above capability maxAccess', () => {
    const result = evaluateRunPolicy({
      ...baseInput({
        profileConfig: profile({
          agentKind: 'codex',
          permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
        }),
      }),
      capability: codexCapability(
        profile({
          agentKind: 'codex',
          permissions: { defaultAccess: 'read-only', maxAccess: 'read-only' },
        }),
      ),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run policy to allow');
    expect(result.accessMode).toBe('read-only');
    expect(result.sandbox).toBe('read-only');
    expect(result.permissionMode).toBe('plan');
  });

  it('returns an expiry and a stable policy fingerprint for accepted runs', () => {
    const input = baseInput({ now: 1000 });
    const result = evaluateRunPolicy(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run policy to allow');
    expect(result.expiresAt).toBeGreaterThan(1000);
    expect(result.policyFingerprint).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(evaluateRunPolicy(input)).toMatchObject({
      ok: true,
      policyFingerprint: result.policyFingerprint,
    });
  });

  it('keeps the fingerprint stable when profile-wide access lists change', () => {
    const input = baseInput();
    const before = evaluateRunPolicy(input);
    input.profileConfig.access.allowedChats.push('oc_other');
    input.profileConfig.access.ownerNoMentionChats.push('oc_chat');
    const after = evaluateRunPolicy(input);

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error('expected run policy to allow');
    expect(after.policyFingerprint).toBe(before.policyFingerprint);
  });

  it('changes the fingerprint when the effective access decision changes', () => {
    const allowedUser = evaluateRunPolicy(baseInput());
    const owner = evaluateRunPolicy({
      ...baseInput(),
      access: { ok: true, reason: 'owner' },
    });

    expect(allowedUser.ok).toBe(true);
    expect(owner.ok).toBe(true);
    if (!allowedUser.ok || !owner.ok) throw new Error('expected run policy to allow');
    expect(owner.policyFingerprint).not.toBe(allowedUser.policyFingerprint);
    expect(allowedUser.compatiblePolicyFingerprints).toHaveLength(1);
  });

  it('fingerprints the attachment policy shape instead of concrete run attachments', () => {
    const noAttachment = evaluateRunPolicy(baseInput());
    const withAcceptedImage = evaluateRunPolicy({
      ...baseInput(),
      attachments: [
        {
          kind: 'image',
          requiredness: 'optional',
          decision: 'accepted',
          originalName: 'sensitive-name.png',
          size: 123,
          hash: 'hash-a',
          path: '/profile/media/hash-a.png',
        },
      ],
    });
    const stricterPolicy = evaluateRunPolicy({
      ...baseInput({
        profileConfig: profile({
          attachments: { maxFileBytes: 1 },
        }),
      }),
    });

    expect(noAttachment.ok).toBe(true);
    expect(withAcceptedImage.ok).toBe(true);
    expect(stricterPolicy.ok).toBe(true);
    if (!noAttachment.ok || !withAcceptedImage.ok || !stricterPolicy.ok) {
      throw new Error('expected run policy to allow');
    }
    expect(withAcceptedImage.policyFingerprint).toBe(noAttachment.policyFingerprint);
    expect(stricterPolicy.policyFingerprint).not.toBe(noAttachment.policyFingerprint);
  });

  it('fails closed for unverified folder resource bindings', () => {
    const result = evaluateRunPolicy({
      ...baseInput(),
      scope: scope({
        resourceBindings: [{ kind: 'folder', id: 'fld_secret', verified: false }],
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'folder-allowlist-unverified',
      },
    });
  });

  it('uses frozen access only for migration while keeping every other policy boundary live', () => {
    const input = baseInput();
    const before = evaluateRunPolicy(input);
    if (!before.ok) throw new Error('expected allow');
    const oldFingerprint = before.compatiblePolicyFingerprints![0];
    input.profileConfig.access.ownerNoMentionChats.push('unrelated-chat');
    const after = evaluateRunPolicy(input);
    if (!after.ok) throw new Error('expected allow');
    expect(after.compatiblePolicyFingerprints).toContain(oldFingerprint);
    expect(after.compatiblePolicyFingerprints?.[0]).toBe(oldFingerprint);
    for (const change of [
      { cwdRealpath: '/other-workspace' },
      { codexHome: '/other-codex-home' },
      { inheritCodexHome: true },
      { scope: { ...input.scope, chatId: 'another-chat' } },
      { scope: { ...input.scope, threadId: 'another-topic' } },
      { scope: { ...input.scope, resourceBindings: [{ kind: 'doc' as const, id: 'doc-other', verified: true }] } },
      { profileConfig: { ...input.profileConfig, permissions: { defaultAccess: 'read-only' as const, maxAccess: 'read-only' as const } } },
      { profileConfig: { ...input.profileConfig, attachments: { ...input.profileConfig.attachments, maxCount: 1 } } },
    ]) {
      const changed = evaluateRunPolicy({ ...input, ...change });
      if (!changed.ok) throw new Error('expected allow with distinct identity');
      expect(changed.compatiblePolicyFingerprints).not.toContain(oldFingerprint);
    }
    expect(evaluateRunPolicy({ ...input, access: { ok: false, reason: 'denied-chat' } }))
      .toMatchObject({ ok: false, rejectReason: { code: 'access-denied' } });
  });

  it('is pure policy calculation and does not import IO or API clients', () => {
    const source = readFileSync(join(process.cwd(), 'src/policy/run-policy.ts'), 'utf8');

    expect(source).not.toMatch(/from ['"]node:fs|from ['"]node:fs\/promises|fs\.realpath|fs\.stat|statSync|realpathSync/);
    expect(source).not.toMatch(/rawClient|LarkChannel|createLarkChannel/);
    expect(source).not.toMatch(/writeFile|mkdir|rm\(/);
  });
});

function baseInput(overrides: Partial<RunPolicyInput> = {}): RunPolicyInput {
  const profileConfig = overrides.profileConfig ?? profile();
  return {
    scope: scope(),
    attachments: [],
    prompt: 'hello',
    requestedCwd: '/repo/project',
    cwdRealpath: '/repo/project',
    access: { ok: true, reason: 'allowed-user' },
    capability: claudeCapability(profileConfig),
    profileConfig,
    now: 1000,
    ...overrides,
  };
}

function profile(options: {
  agentKind?: 'claude' | 'codex';
  permissions?: {
    defaultAccess: AccessMode;
    maxAccess: AccessMode;
  };
  attachments?: Partial<ProfileConfig['attachments']>;
} = {}) {
  const cfg = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(options.agentKind === 'codex'
      ? { codex: { binaryPath: '/usr/local/bin/codex' } }
      : {}),
    permissions: options.permissions,
  });
  return {
    ...cfg,
    attachments: {
      ...cfg.attachments,
      ...options.attachments,
    },
    workspaces: cfg.workspaces,
  };
}

function scope(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return {
    source: 'im',
    chatId: 'oc_chat',
    actorId: 'ou_user',
    ...overrides,
  };
}
