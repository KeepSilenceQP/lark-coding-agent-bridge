import type { AgentEvent } from '../types';
import { isDeepStrictEqual } from 'node:util';
import { log } from '../../core/logger';

export type CodexFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

// Bridge compatibility policy: allow long foreground waits plus scheduling
// grace, but bound silence when an MCP/collab completion is lost.
const TOOL_MAX_SILENCE_MS = 65 * 60_000;

export class CodexJsonlTranslator {
  private threadId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private lastAgentMessage: string | undefined;
  private readonly startedItems = new Set<string>();
  private readonly completedItems = new Set<string>();
  private readonly toolProgress = new Map<string, readonly unknown[]>();
  private drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.type) {
      case 'thread.started':
        return this.translateThreadStarted(raw);
      case 'turn.started':
        this.lastAgentMessage = undefined;
        return [];
      case 'item.started':
        return this.translateItemStarted(raw);
      case 'item.updated':
        return this.translateItemStarted(raw, true);
      case 'item.completed':
        return this.translateItemCompleted(raw);
      case 'agent_message':
        return this.translateAgentMessage(raw);
      case 'turn.completed':
        return this.translateTurnCompleted(raw);
      case 'turn.failed':
        return this.translateTerminalError(raw, 'codex turn failed');
      case 'error':
        return this.translateNonTerminalError(raw, 'codex error');
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: CodexFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      return [
        {
          type: 'error',
          message: truncate(`codex stream ended before a terminal event${detail}`, 4096),
          terminationReason: 'failed',
        },
      ];
    }
    return [{ type: 'done', threadId: this.threadId, terminationReason: reason }];
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateThreadStarted(raw: Record<string, unknown>): AgentEvent[] {
    const threadId = stringValue(raw.thread_id ?? raw.threadId);
    if (!threadId) {
      this.drift.anomalies++;
      return [];
    }
    this.threadId = threadId;
    return [{ type: 'system', threadId }];
  }

  private translateItemStarted(raw: Record<string, unknown>, updated = false): AgentEvent[] {
    const item = recordValue(raw.item);
    if (!item || !isToolItem(item)) return [];
    const id = stringValue(item.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (this.completedItems.has(id)) return [];
    if (isTerminalToolStatus(item.status)) return this.translateItemCompleted(raw);
    if (item.status !== undefined && item.status !== 'in_progress') return [];
    this.lastAgentMessage = undefined;
    const progress = toolProgressValue(item);
    if (this.startedItems.has(id)) {
      if (!updated || isDeepStrictEqual(this.toolProgress.get(id), progress)) return [];
      this.toolProgress.set(id, progress);
      return [{ type: 'tool_progress', id }];
    }
    this.startedItems.add(id);
    this.toolProgress.set(id, progress);
    return [
      {
        type: 'tool_use',
        id,
        name: String(item.type),
        ...(item.type !== 'command_execution' ? { maxSilenceMs: TOOL_MAX_SILENCE_MS } : {}),
        // Do not copy MCP arguments or child prompts into cards/logs.
        input: item.type === 'command_execution'
          ? { command: stringValue(item.command) ?? '' }
          : {
              tool: stringValue(item.tool) ?? '',
              ...(item.type === 'mcp_tool_call' ? { server: stringValue(item.server) ?? '' } : {}),
            },
      },
    ];
  }

  private translateItemCompleted(raw: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(raw.item);
    if (!item) return [];
    if (item.type === 'agent_message') {
      const message = stringValue(item.text ?? item.message);
      return message ? this.emitAgentMessage(message) : [];
    }
    if (!isToolItem(item)) return [];
    this.lastAgentMessage = undefined;
    const id = stringValue(item.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (this.completedItems.has(id)) return [];
    if (!this.startedItems.has(id)) {
      this.drift.anomalies++;
    }
    this.startedItems.delete(id);
    this.completedItems.add(id);
    this.toolProgress.delete(id);
    const exitCode = numberValue(item.exit_code);
    return [
      {
        type: 'tool_result',
        id,
        output: item.type === 'command_execution'
          ? stringValue(item.output ?? item.aggregated_output ?? item.stdout) ?? ''
          : stringValue(item.status) ?? 'completed',
        isError: (exitCode !== undefined && exitCode !== 0) ||
          (isTerminalToolStatus(item.status) && item.status !== 'completed') ||
          Boolean(item.error),
      },
    ];
  }

  private translateAgentMessage(raw: Record<string, unknown>): AgentEvent[] {
    const message = stringValue(raw.message ?? raw.text);
    if (!message) return [];
    return this.emitAgentMessage(message);
  }

  private emitAgentMessage(message: string): AgentEvent[] {
    // Codex versions may announce one message twice: once as a raw
    // `agent_message` and once as a completed agent-message item. They are two
    // protocol shapes for the same output, not two user-visible paragraphs.
    if (message === this.lastAgentMessage) return [];
    this.lastAgentMessage = message;
    return [{ type: 'text', delta: message }];
  }

  private translateTurnCompleted(raw: Record<string, unknown>): AgentEvent[] {
    this.terminal = true;
    const events: AgentEvent[] = [];
    const usage = recordValue(raw.usage);
    if (usage) {
      events.push({
        type: 'usage',
        inputTokens: numberValue(usage.input_tokens ?? usage.inputTokens),
        outputTokens: numberValue(usage.output_tokens ?? usage.outputTokens),
        cachedInputTokens: numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens),
        reasoningOutputTokens: numberValue(
          usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
        ),
      });
    }
    events.push({ type: 'done', threadId: this.threadId, terminationReason: 'normal' });
    return events;
  }

  private translateTerminalError(raw: Record<string, unknown>, fallback: string): AgentEvent[] {
    this.terminal = true;
    const message = errorMessage(raw, fallback);
    return [
      {
        type: 'error',
        message: truncate(message, 4096),
        terminationReason: 'failed',
      },
    ];
  }

  private translateNonTerminalError(raw: Record<string, unknown>, fallback: string): AgentEvent[] {
    const message = errorMessage(raw, fallback);
    this.lastNonTerminalError = message;
    log.warn('jsonl', 'error_event', { message: truncate(message, 500) });
    return [];
  }
}

function isToolItem(item: Record<string, unknown>): boolean {
  return item.type === 'command_execution' || item.type === 'collab_tool_call' ||
    item.type === 'mcp_tool_call';
}

function isTerminalToolStatus(status: unknown): boolean {
  return typeof status === 'string' &&
    ['completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'declined'].includes(status);
}

function toolProgressValue(item: Record<string, unknown>): readonly unknown[] {
  if (item.type === 'command_execution') {
    return [stringValue(item.output ?? item.aggregated_output ?? item.stdout) ?? ''];
  }
  if (item.type === 'collab_tool_call') return [recordValue(item.agents_states) ?? {}];
  return [item.result ?? null];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function errorMessage(raw: Record<string, unknown>, fallback: string): string {
  const nested = recordValue(raw.error);
  return (
    stringValue(raw.message) ??
    stringValue(nested?.message) ??
    stringValue(raw.error) ??
    fallback
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
