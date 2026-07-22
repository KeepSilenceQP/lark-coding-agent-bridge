import type { LarkChannel } from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { resolveAppSecret } from '../config/secret-resolver';
import type { AppPaths } from '../config/app-paths';
import type { AppConfig, TenantBrand } from '../config/schema';
import { log } from '../core/logger';
import type { ReturnRoute } from './restart-receipt';
import { resolveProfileRuntime } from './profile-runtime';

export interface ReceiptSendParams {
  profile: string;
  returnRoute: ReturnRoute;
  receiptId: string;
  kind: 'success' | 'failure';
  uuid: string;
  newPid?: number;
  reason?: string;
  deployRevision?: string;
}

export interface ReceiptSendResult {
  ok: boolean;
  messageId?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Send a restart receipt using a one-off channel instance resolved from
 * profile credentials. Uses deterministic app credentials (not marker/env).
 * Retries bounded by MAX_RETRIES with exponential backoff on transient errors.
 */
export async function sendRestartReceipt(
  params: ReceiptSendParams,
): Promise<ReceiptSendResult> {
  const text = buildReceiptText(params);
  // Resolve profile runtime to get credentials
  const { cfg, appPaths } = await resolveProfileRuntime({
    profile: params.profile,
    allowBootstrap: false,
  });
  const domain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

  const appSecret = await resolveAppSecret(cfg, {
    secretsFile: appPaths.secretsFile,
    keystoreSaltFile: appPaths.keystoreSaltFile,
  });

  const channel = createLarkChannel({
    appId: cfg.accounts.app.id,
    appSecret,
    domain,
    source: 'lark-channel-bridge',
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const messageId = await sendReceiptMessage(
        channel,
        params.returnRoute,
        text,
        params.uuid,
      );
      return { ok: true, messageId };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) break;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  log.warn('receipt', 'send-failed', {
    receiptId: params.receiptId,
    kind: params.kind,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    attempts: MAX_RETRIES,
  });
  return { ok: false };
}

/**
 * Send a receipt using an already-connected channel (new bridge path).
 */
export async function sendRestartReceiptViaChannel(
  channel: LarkChannel,
  params: ReceiptSendParams,
): Promise<ReceiptSendResult> {
  const text = buildReceiptText(params);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const messageId = await sendReceiptMessage(
        channel,
        params.returnRoute,
        text,
        params.uuid,
      );
      return { ok: true, messageId };
    } catch (err) {
      if (!isRetryable(err)) break;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  return { ok: false };
}

async function sendReceiptMessage(
  channel: LarkChannel,
  route: ReturnRoute,
  text: string,
  _uuid: string,
): Promise<string> {
  // LarkChannel.send() throws on error; result always has messageId.
  // _uuid is accepted for idempotency but not passed through to the SDK
  // (Feishu server-side dedup handles duplicates with the same payload).
  const result = await channel.send(
    route.chatId,
    { markdown: text },
    {
      replyTo: route.replyTo,
      ...(route.threadId ? { replyInThread: true } : {}),
    },
  );
  return result.messageId;
}

function buildReceiptText(params: ReceiptSendParams): string {
  const { profile, receiptId, kind, newPid, reason, deployRevision } = params;
  if (kind === 'success') {
    const lines = [
      `**重启成功**`,
      ``,
      `- profile: \`${profile}\``,
      `- receiptId: \`${receiptId}\``,
      ...(newPid !== undefined ? [`- newPid: \`${newPid}\``] : []),
      ...(deployRevision ? [`- deployRevision: \`${deployRevision}\``] : []),
    ];
    return lines.join('\n');
  }
  // failure
  const label =
    reason === 'service-action-failure'
      ? '服务操作失败'
      : reason === 'startup-timeout'
        ? '启动超时'
        : reason === 'receipt-delivery-failure'
          ? '通知发送失败'
          : reason ?? '未知错误';
  const lines = [
    `**重启失败**`,
    ``,
    `- profile: \`${profile}\``,
    `- receiptId: \`${receiptId}\``,
    `- reason: \`${label}\``,
  ];
  return lines.join('\n');
}

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|5\d\d/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
