export type StopTargetClass = 'bot' | 'user';

export interface TriggerResolution {
  chainId: string;
  status: 'current' | 'historical';
}

export type StopAddedDecision =
  | { kind: 'silent-drop'; reason: 'unknown-user-trigger' }
  | { kind: 'no-work' }
  | { kind: 'fail-closed' }
  | { kind: 'stop' };

export interface StopAddedDecisionInput {
  targetClass: StopTargetClass;
  hasWork: boolean;
  trigger: TriggerResolution | undefined;
  botTargetIsCurrent: boolean;
}

/** Decide control-plane behavior after route, sender and Reaction permission gates. */
export function decideStopAdded(input: StopAddedDecisionInput): StopAddedDecision {
  if (input.targetClass === 'user' && !input.trigger) {
    return { kind: 'silent-drop', reason: 'unknown-user-trigger' };
  }
  if (!input.hasWork) return { kind: 'no-work' };
  if (input.targetClass === 'user' && input.trigger?.status === 'historical') {
    return { kind: 'fail-closed' };
  }
  if (input.targetClass === 'user' && input.trigger?.status === 'current') {
    return { kind: 'stop' };
  }
  return input.botTargetIsCurrent ? { kind: 'stop' } : { kind: 'fail-closed' };
}

export interface StopAddedEffects {
  interrupt: () => void;
  cancelPending: () => void;
}

export interface StopAddedExecutionResult {
  replyKind: 'no-work' | 'stopped' | 'fail-closed';
  message: string;
}

export function executeStopAdded(
  decision: StopAddedDecision,
  effects: StopAddedEffects,
): StopAddedExecutionResult | undefined {
  if (decision.kind === 'silent-drop') return undefined;
  if (decision.kind === 'no-work') {
    return { replyKind: 'no-work', message: '当前没有需要停止的任务。' };
  }
  if (decision.kind === 'fail-closed') {
    return {
      replyKind: 'fail-closed',
      message: '该 Reaction 未停止当前任务，如需停止请使用 /stop 命令。',
    };
  }
  effects.interrupt();
  effects.cancelPending();
  return { replyKind: 'stopped', message: '已停止当前任务。' };
}
