/**
 * Phase 2 workspace context packet for explicitly configured non-bridge bots.
 *
 * Machine-readable JSON delivered via native mention instead of /cd.
 * The receiving bot's gateway/runtime parses this and persists a
 * session-scoped workspace/cwd — it must NOT execute /cd or /invite group.
 *
 * Schema constraints from 小A review:
 *  - primary_workspace_kind = "local"
 *  - devbox_usage = "reference_only" / "not_executable_for_xiaoa"
 *  - must_not_run = ["/cd", "/invite group"]
 */

export interface NonBridgeWorkspaceContext {
  project: string;
  task_id: string;
  coordinator: string;
  coordinator_open_id: string;
  chat_id: string;
  timestamp: number;
  kind: 'non-bridge-workspace-context';
  workspace: {
    primary_workspace_kind: 'local' | 'devbox';
    local_workspace: string;
    devbox_workspace?: string;
    devbox_usage: 'reference_only' | 'not_executable';
    devbox_note?: string;
  };
  must_not_run: string[];
  expected_action: string;
  participants: string[];
}

export function buildWorkspaceContext(opts: {
  project: string;
  taskId: string;
  coordinator: string;
  coordinatorOpenId: string;
  chatId: string;
  localWorkspace: string;
  devboxWorkspace?: string;
  participants: string[];
}): NonBridgeWorkspaceContext {
  return {
    project: opts.project,
    task_id: opts.taskId,
    coordinator: opts.coordinator,
    coordinator_open_id: opts.coordinatorOpenId,
    chat_id: opts.chatId,
    timestamp: Date.now(),
    kind: 'non-bridge-workspace-context',
    workspace: {
      primary_workspace_kind: 'local',
      local_workspace: opts.localWorkspace,
      ...(opts.devboxWorkspace ? { devbox_workspace: opts.devboxWorkspace } : {}),
      devbox_usage: 'reference_only',
      devbox_note: 'not_executable_for_xiaoa — xiaoa runtime is local-only',
    },
    must_not_run: ['/cd', '/invite group'],
    expected_action:
      'adopt workspace via gateway/runtime; persist session-scoped cwd; do not execute /cd',
    participants: opts.participants,
  };
}

/** Serialise the context packet for embedding in a post/at message body. */
export function formatContextPacket(packet: NonBridgeWorkspaceContext): string {
  return JSON.stringify(packet, null, 2);
}
