import { resolveAppSecret } from '../config/secret-resolver';
import type { TenantBrand } from '../config/schema';
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

// ── Tenant access token ───────────────────────────────────────────────

interface TenantAccessTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface LarkApiResponse {
  code: number;
  msg?: string;
  data?: { message_id?: string };
}

/**
 * Send a restart receipt using the raw Lark / Feishu REST API with a
 * stable derived uuid for end-to-end idempotency. Credentials are resolved
 * deterministically from the profile (not marker / env).
 */
export async function sendRestartReceipt(
  params: ReceiptSendParams,
): Promise<ReceiptSendResult> {
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

  // Get a short-lived tenant access token for this send session.
  const token = await getTenantAccessToken(
    domain,
    cfg.accounts.app.id,
    appSecret,
  );
  if (!token) {
    log.warn('receipt', 'token-failed', { receiptId: params.receiptId });
    return { ok: false };
  }

  const body = buildReceiptRequestBody(params);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const messageId = await sendLarkMessage(
        domain,
        token,
        params.returnRoute,
        body,
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
 * Compatibility wrapper: send via the raw API path. Callers that already
 * hold a connected LarkChannel can also use this single path — credentials
 * are always resolved from the profile.
 */
export async function sendRestartReceiptViaChannel(
  _channel: unknown,
  params: ReceiptSendParams,
): Promise<ReceiptSendResult> {
  return sendRestartReceipt(params);
}

// ── Low-level API callers (exported for test inspection) ───────────────

export async function getTenantAccessToken(
  domain: string,
  appId: string,
  appSecret: string,
): Promise<string | null> {
  const url = `${domain}/open-apis/auth/v3/tenant_access_token/internal`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!res.ok) {
    throw new Error(`tenant_access_token request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as TenantAccessTokenResponse;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(
      `tenant_access_token error: code=${data.code} msg=${data.msg ?? '-'}`,
    );
  }
  return data.tenant_access_token;
}

export function buildReceiptRequestBody(params: ReceiptSendParams): string {
  return JSON.stringify({
    content: JSON.stringify({ text: formatReceiptText(params) }),
    msg_type: 'text',
    uuid: params.uuid,
  });
}

export async function sendLarkMessage(
  domain: string,
  token: string,
  route: ReturnRoute,
  bodyJson: string,
): Promise<string> {
  // Reply to an existing message — the reply lands in the same chat/topic
  // as the parent message.
  const url = `${domain}/open-apis/im/v1/messages/${encodeURIComponent(route.replyTo)}/reply`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: bodyJson,
  });

  if (!res.ok) {
    throw new Error(`message reply failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as LarkApiResponse;
  if (data.code !== 0) {
    throw new Error(
      `message reply error: code=${data.code} msg=${data.msg ?? '-'}`,
    );
  }

  return data.data?.message_id ?? '';
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatReceiptText(params: ReceiptSendParams): string {
  const { profile, receiptId, kind, newPid, reason, deployRevision } = params;
  if (kind === 'success') {
    const parts = [
      `重启成功`,
      `profile: ${profile}`,
      `receiptId: ${receiptId}`,
      ...(newPid !== undefined ? [`newPid: ${newPid}`] : []),
      ...(deployRevision ? [`deployRevision: ${deployRevision}`] : []),
    ];
    return parts.join('\n');
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
  return [
    `重启失败`,
    `profile: ${profile}`,
    `receiptId: ${receiptId}`,
    `reason: ${label}`,
  ].join('\n');
}

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|5\d\d/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
