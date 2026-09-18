import { createHash } from 'node:crypto';
import type { ProfileConfig, SandboxMode } from '../config/profile-schema';
import { canonicalizeJcs } from '../session/jcs';
import type { AccessDecision } from './access';

export interface FingerprintInputV2 {
  cwdRealpath: string;
  sandbox: SandboxMode;
  accessPolicyDigest: string;
  resourceScopeDigest: string;
  attachmentPolicyShapeDigest: string;
  codexHome?: string;
  inheritCodexHome: boolean;
}

export interface ResourceScopeDigestInput {
  source: 'im' | 'card' | 'comment';
  chatId?: string;
  threadId?: string;
  commentScopeId?: string;
  resourceBindings?: string[];
}

export interface AttachmentPolicyShapeInput {
  kind: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
  originalName?: string;
  size?: number;
  hash?: string;
  path?: string;
}

export function policyFingerprint(input: FingerprintInputV2): string {
  return digestCanonical({
    version: 2,
    cwdRealpath: input.cwdRealpath,
    sandbox: input.sandbox,
    accessPolicyDigest: input.accessPolicyDigest,
    resourceScopeDigest: input.resourceScopeDigest,
    attachmentPolicyShapeDigest: input.attachmentPolicyShapeDigest,
    codexHome: input.codexHome ?? null,
    inheritCodexHome: input.inheritCodexHome,
  });
}

/** Pre-fix digest retained only for exact, one-generation session adoption. */
export function accessPolicyDigest(access: ProfileConfig['access']): string {
  return digestCanonical({
    admins: [...access.admins].sort(),
    allowedChats: [...access.allowedChats].sort(),
    allowedUsers: [...access.allowedUsers].sort(),
    groupResponseMode: access.groupResponseMode,
    requireMentionInGroup: access.requireMentionInGroup,
    ownerNoMentionChats: [...access.ownerNoMentionChats].sort(),
  });
}

/**
 * Session identity depends on the access result for this accepted request,
 * rather than every entry in the profile-wide allowlists. Access is still
 * evaluated for every request before a run can start.
 */
export function accessDecisionDigest(access: AccessDecision): string {
  return digestCanonical({
    ok: access.ok,
    reason: access.reason,
  });
}

export function resourceScopeDigest(input: ResourceScopeDigestInput): string {
  return digestCanonical({
    source: input.source,
    chatId: input.chatId ?? null,
    threadId: input.threadId ?? null,
    commentScopeId: input.commentScopeId ?? null,
    resourceBindings: [...(input.resourceBindings ?? [])].sort(),
  });
}

export function attachmentPolicyShapeDigest(input: AttachmentPolicyShapeInput[]): string {
  const shape = input
    .map((item) => ({
      kind: item.kind,
      requiredness: item.requiredness ?? null,
      decision: item.decision ?? null,
      rejectionReason: item.rejectionReason ?? null,
    }))
    .sort((a, b) => canonicalizeJcs(a).localeCompare(canonicalizeJcs(b)));
  return digestCanonical(shape);
}

export function attachmentPolicyConfigDigest(input: ProfileConfig['attachments']): string {
  return digestCanonical({
    maxCount: input.maxCount,
    maxBytes: input.maxBytes,
    maxFileBytes: input.maxFileBytes,
    imageMaxBytes: input.imageMaxBytes,
  });
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizeJcs(value))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}
