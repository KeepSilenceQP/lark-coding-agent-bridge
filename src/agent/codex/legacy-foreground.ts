import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

const MAX_HEADER_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;

export interface LegacyForegroundMetadata {
  childThreadIds: string[];
  completedCallIds: string[];
  reason: 'verified' | 'no-explicit-foreground' | 'untrusted-path' | 'identity-mismatch' |
    'unreadable' | 'header-limit';
}

/** Read only the API-resolved parent rollout, retaining lifecycle metadata only. */
export async function readLegacyForegroundMetadata(
  path: unknown,
  threadId: string,
  turnId: string,
  candidates: readonly string[],
): Promise<LegacyForegroundMetadata> {
  const empty = (reason: LegacyForegroundMetadata['reason']): LegacyForegroundMetadata =>
    ({ childThreadIds: [], completedCallIds: [], reason });
  if (typeof path !== 'string' || !isAbsolute(path) || !basename(path).startsWith('rollout-') ||
      !basename(path).endsWith(`-${threadId}.jsonl`) || /[/\\]/.test(threadId)) {
    return empty('untrusted-path');
  }
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return empty('untrusted-path');
      const header = Buffer.alloc(Math.min(stat.size, MAX_HEADER_BYTES));
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const newline = header.subarray(0, bytesRead).indexOf(10);
      if (newline < 0) return empty('header-limit');
      const first = parseRecord(header.subarray(0, newline).toString('utf8'));
      if (first?.type !== 'session_meta' || record(first.payload)?.id !== threadId) {
        return empty('identity-mismatch');
      }
      const offset = Math.max(0, stat.size - MAX_TAIL_BYTES);
      const tail = Buffer.alloc(stat.size - offset);
      const read = await file.read(tail, 0, tail.length, offset);
      let text = tail.subarray(0, read.bytesRead).toString('utf8');
      if (offset > 0) text = text.slice(text.indexOf('\n') + 1);
      const calls = new Set<string>();
      const returned = new Set<string>();
      const spawned = new Map<string, string>();
      for (const line of text.split('\n')) {
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES) continue;
        const entry = parseRecord(line);
        const payload = record(entry?.payload);
        if (!payload) continue;
        if (entry?.type === 'history_mutation' && payload.turn_id === turnId && Array.isArray(payload.items)) {
          if ((payload.version !== undefined && payload.version !== 1) ||
              (payload.operation !== undefined && payload.operation !== 'append')) continue;
          for (const value of payload.items) {
            const item = record(value);
            const id = string(item?.call_id);
            if (!id) continue;
            if (item?.type === 'function_call' && ['Agent', 'spawn_agent'].includes(String(item.name))) calls.add(id);
            if (item?.type === 'function_call_output') returned.add(id);
          }
        }
        if (entry?.type !== 'event_msg' || payload.type !== 'collab_agent_spawn_end' ||
            payload.run_in_background !== false || payload.status === 'failed' ||
            (payload.sender_thread_id !== undefined && payload.sender_thread_id !== threadId)) continue;
        const callId = string(payload.call_id);
        const childId = string(payload.new_thread_id);
        if (callId && calls.has(callId) && childId && candidates.includes(childId)) spawned.set(callId, childId);
      }
      const completedCallIds = [...spawned.keys()].filter((id) => returned.has(id));
      return {
        childThreadIds: [...spawned].filter(([id]) => !returned.has(id)).map(([, child]) => child),
        completedCallIds,
        reason: spawned.size ? 'verified' : 'no-explicit-foreground',
      };
    } finally {
      await file.close();
    }
  } catch {
    // Do not include paths, record text or parse errors in diagnostics.
    return empty('unreadable');
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(line)); } catch { return undefined; }
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
