import { log } from '../core/logger';
import type { AgentCapability } from '../agent/capability';
import { resolveModelArg } from '../agent/models';
import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { RunExecution, RunExecutor } from '../runtime/run-executor';
import type { ReplacementReservation, RunReservation } from './active-runs';
import { RunRejected, type RunRejectedCode } from '../runtime/errors';
import type { SessionCatalog } from '../session/catalog';
import type {
  PromptBindingIdentity,
  PromptBindingOrigin,
} from '../session/prompt-binding-ledger';
import type { PromptRunAdmission } from '../session/prompt-run-admission';
import type {
  PromptSessionDecision,
  PromptSessionService,
} from '../session/prompt-session-service';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface StartRunFlowInput {
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  systemPromptAddendum?: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  promptSession?: {
    service: PromptSessionService;
    origin: PromptBindingOrigin;
    /** Startup retry for the same user turn must reuse the first resolution. */
    reuseDecision?: PromptSessionDecision;
  };
  workspaces: WorkspaceStore;
  executor: RunExecutor;
  /** Optional reservation acquired at the PendingQueue dequeue boundary. */
  reservation?: RunReservation;
  now: number;
  stopGraceMs?: number;
  /** Opaque route ID for deferred self-restart. Bridge-internal, passed to AgentRunOptions. */
  routeId?: string;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunFlowRejectCode =
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode
  | 'prompt-session-unavailable'
  | 'pinned-restart-not-codex'
  | 'pinned-restart-cwd-changed'
  | 'pinned-restart-policy-changed'
  | 'pinned-restart-thread-unavailable'
  | 'pinned-restart-thread-changed';

export interface PreparePinnedCodexRunInput {
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  promptSession?: {
    service: PromptSessionService;
    origin: PromptBindingOrigin;
  };
  workspaces: WorkspaceStore;
  expected: {
    cwdRealpath: string;
    policyFingerprint: string;
    threadId: string;
  };
  now: number;
  systemPromptAddendum?: string;
}

export interface PreparedPinnedCodexRun {
  scopeId: string;
  policy: RunPolicyAllow;
  cwdRealpath: string;
  threadId: string;
  systemPromptAddendum?: string;
  promptSession?: {
    service: PromptSessionService;
    identity: PromptBindingIdentity;
    origin: PromptBindingOrigin;
    decision: PromptSessionDecision;
  };
}

export type PreparePinnedCodexRunResult =
  | { ok: true; prepared: PreparedPinnedCodexRun }
  | { ok: false; rejectReason: { code: RunFlowRejectCode; userVisible: string } };

/**
 * Revalidate every durable identity used by an edit restart before the old
 * process is stopped. The returned plan pins immutable policy/cwd/thread data;
 * it never falls back to a fresh session.
 */
export async function preparePinnedCodexRun(
  input: PreparePinnedCodexRunInput,
): Promise<PreparePinnedCodexRunResult> {
  const reject = (code: RunFlowRejectCode, userVisible: string): PreparePinnedCodexRunResult => ({
    ok: false,
    rejectReason: { code, userVisible },
  });
  if (input.capability.agentId !== 'codex' || input.profileConfig.agentKind !== 'codex') {
    return reject('pinned-restart-not-codex', '当前运行不支持消息修正重启。');
  }
  const requestedCwd =
    input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) return reject(workspace.reason, workspace.userVisible);
  if (workspace.cwdRealpath !== input.expected.cwdRealpath) {
    return reject('pinned-restart-cwd-changed', '工作目录已变化，未停止当前运行。');
  }
  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) return { ok: false, rejectReason: policy.rejectReason };
  if (policy.policyFingerprint !== input.expected.policyFingerprint) {
    return reject('pinned-restart-policy-changed', '运行策略已变化，未停止当前运行。');
  }
  const catalogEntry = input.sessionCatalog?.activeFor({
    scopeId: input.scopeId,
    agentId: 'codex',
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  });
  if (!catalogEntry?.threadId) {
    return reject('pinned-restart-thread-unavailable', '当前 Codex thread 尚未持久化，未停止当前运行。');
  }
  if (catalogEntry.threadId !== input.expected.threadId) {
    return reject('pinned-restart-thread-changed', '当前 Codex thread 已变化，未停止当前运行。');
  }

  let preparedPromptSession: PreparedPinnedCodexRun['promptSession'];
  let systemPromptAddendum = input.systemPromptAddendum;
  if (input.promptSession) {
    const identity: PromptBindingIdentity = {
      scopeId: input.scopeId,
      agentId: 'codex',
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    };
    let decision: PromptSessionDecision;
    try {
      decision = await input.promptSession.service.prepareSession({
        identity,
        origin: input.promptSession.origin,
        existingAgentSessionId: input.expected.threadId,
      });
    } catch (err) {
      log.warn('prompt-session', 'prepare-failed', { scope: input.scopeId, err: String(err) });
      return reject('prompt-session-unavailable', '当前会话状态不可用，未停止当前运行。');
    }
    const decidedThread = decision.kind === 'resume'
      ? decision.agentSessionId
      : decision.kind === 'dormant'
        ? decision.existingAgentSessionId
        : undefined;
    if (decidedThread !== input.expected.threadId) {
      return reject('pinned-restart-thread-changed', '当前 prompt session 已变化，未停止当前运行。');
    }
    systemPromptAddendum = decision.kind === 'resume'
      ? decision.systemPromptAddendum
      : systemPromptAddendum;
    preparedPromptSession = {
      service: input.promptSession.service,
      identity,
      origin: input.promptSession.origin,
      decision,
    };
  }
  return {
    ok: true,
    prepared: {
      scopeId: input.scopeId,
      policy,
      cwdRealpath: workspace.cwdRealpath,
      threadId: input.expected.threadId,
      ...(systemPromptAddendum !== undefined ? { systemPromptAddendum } : {}),
      ...(preparedPromptSession ? { promptSession: preparedPromptSession } : {}),
    },
  };
}

export async function startPreparedPinnedCodexRun(input: {
  prepared: PreparedPinnedCodexRun;
  executor: RunExecutor;
  replacement: ReplacementReservation;
  profileConfig: ProfileConfig;
  stopGraceMs?: number;
  routeId?: string;
  observability?: StartRunFlowInput['observability'];
}): Promise<StartRunFlowResult> {
  const promptSession = input.prepared.promptSession;
  const admission = promptSession?.service.admitRun({
    runId: `${input.prepared.scopeId}:${Date.now()}`,
    source: promptSession.origin.source,
  });
  admission?.markIdentifierDurable();
  try {
    const execution = await input.executor.submit({
      scopeId: input.prepared.scopeId,
      policy: input.prepared.policy,
      threadId: input.prepared.threadId,
      systemPromptAddendum: input.prepared.systemPromptAddendum,
      model: resolveModelArg(
        input.profileConfig.agentKind,
        input.profileConfig.preferences.model,
      ),
      stopGraceMs: input.stopGraceMs,
      routeId: input.routeId,
      observability: input.observability,
      replacement: input.replacement,
    });
    return {
      ok: true,
      execution,
      policy: input.prepared.policy,
      cwdRealpath: input.prepared.cwdRealpath,
      resumeFrom: input.prepared.threadId,
      ...(promptSession && admission
        ? {
            promptSession: {
              identity: promptSession.identity,
              origin: promptSession.origin,
              decision: promptSession.decision,
              admission,
            },
          }
        : {}),
    };
  } catch (err) {
    admission?.finishWithoutIdentifier();
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible: '修正后的运行启动失败，原运行已停止。',
        },
      };
    }
    throw err;
  }
}

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
      promptSession?: {
        identity: PromptBindingIdentity;
        origin: PromptBindingOrigin;
        decision: PromptSessionDecision;
        admission: PromptRunAdmission;
      };
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  const reservation = input.reservation ?? input.executor.reserveScope(input.scopeId);
  if (!reservation) {
    return {
      ok: false,
      rejectReason: {
        code: 'run-already-active',
        userVisible: '当前会话已有运行在执行，请稍后再试或先停止当前运行。',
      },
    };
  }
  if (reservation.signal.aborted) {
    reservation.release();
    return {
      ok: false,
      rejectReason: {
        code: 'run-interrupted',
        userVisible: '当前任务已中断。',
      },
    };
  }
  const requestedCwd =
    input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  let workspace: WorkingDirectoryResolveResult;
  try {
    workspace = await resolveWorkingDirectory(requestedCwd);
  } catch (error) {
    reservation.release();
    throw error;
  }
  if (!workspace.ok) {
    reservation.release();
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }

  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) {
    reservation.release();
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  let resumeFrom: string | undefined;
  let sessionId: string | undefined;
  let threadId: string | undefined;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    });
    if (catalogEntry?.agentId === 'claude') {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (catalogEntry?.agentId === 'codex') {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
  }
  if (!resumeFrom && input.capability.agentId === 'claude') {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    sessionId = resumeFrom;
    const stale = input.sessions.getRaw(input.scopeId);
    if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }

  let promptSessionContext:
    | {
        identity: PromptBindingIdentity;
        origin: PromptBindingOrigin;
        decision: PromptSessionDecision;
        admission: PromptRunAdmission;
      }
    | undefined;
  let systemPromptAddendum = input.systemPromptAddendum;
  if (input.promptSession) {
    const identity: PromptBindingIdentity = {
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    };
    try {
      const decision =
        input.promptSession.reuseDecision ??
        (await input.promptSession.service.prepareSession({
          identity,
          origin: input.promptSession.origin,
          signal: reservation.signal,
          ...(resumeFrom ? { existingAgentSessionId: resumeFrom } : {}),
        }));
      if (decision.kind === 'fresh') {
        sessionId = undefined;
        threadId = undefined;
        resumeFrom = undefined;
        systemPromptAddendum = decision.systemPromptAddendum;
      } else if (decision.kind === 'resume') {
        resumeFrom = decision.agentSessionId;
        sessionId = input.capability.agentId === 'claude' ? decision.agentSessionId : undefined;
        threadId = input.capability.agentId === 'codex' ? decision.agentSessionId : undefined;
        systemPromptAddendum = decision.systemPromptAddendum;
      }
      const admission = input.promptSession.service.admitRun({
        runId: `${input.scopeId}:${input.now}`,
        source: input.promptSession.origin.source,
      });
      if (
        decision.kind === 'resume' ||
        (decision.kind === 'dormant' && decision.existingAgentSessionId)
      ) {
        admission.markIdentifierDurable();
      }
      promptSessionContext = {
        identity,
        origin: input.promptSession.origin,
        decision,
        admission,
      };
    } catch (err) {
      log.warn('prompt-session', 'prepare-failed', {
        scope: input.scopeId,
        interrupted: reservation.signal.aborted,
        err: String(err),
      });
      reservation.release();
      return {
        ok: false,
        rejectReason: {
          code: reservation.signal.aborted
            ? 'run-interrupted'
            : 'prompt-session-unavailable',
          userVisible: reservation.signal.aborted
            ? '当前任务已中断。'
            : '当前会话状态不可用，请稍后重试或联系管理员检查配置。',
        },
        workspace,
      };
    }
  }

  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      policy,
      sessionId,
      threadId,
      systemPromptAddendum,
      model: resolveModelArg(
        input.profileConfig.agentKind,
        input.profileConfig.preferences.model,
      ),
      images:
        input.capability.agentId === 'codex'
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      routeId: input.routeId,
      observability: input.observability,
      reservation,
    });
  } catch (err) {
    promptSessionContext?.admission.finishWithoutIdentifier();
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(promptSessionContext ? { promptSession: promptSessionContext } : {}),
  };
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system') return;
  if (input.capability.agentId === 'claude' && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'claude',
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
  if (input.capability.agentId === 'codex' && input.event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'codex',
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId,
    });
  }
}

export async function recordRunSessionEventAwaited(
  input: RecordRunSessionEventInput,
): Promise<void> {
  if (input.event.type !== 'system') return;
  if (input.capability.agentId === 'claude' && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    await Promise.all([
      input.sessions.setAwaited(input.scopeId, input.event.sessionId, cwdRealpath),
      input.sessionCatalog?.upsertActiveAwaited({
        scopeId: input.scopeId,
        agentId: 'claude',
        cwdRealpath,
        policyFingerprint: input.policy.policyFingerprint,
        sessionId: input.event.sessionId,
      }),
    ]);
    return;
  }
  if (input.capability.agentId === 'codex' && input.event.threadId) {
    await input.sessionCatalog?.upsertActiveAwaited({
      scopeId: input.scopeId,
      agentId: 'codex',
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId,
    });
  }
}
