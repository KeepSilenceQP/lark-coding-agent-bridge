import type { AppPaths } from '../config/app-paths';
import {
  readTerminal, cleanupReceiptArtifacts, createClaim, readClaim, createAttempt,
  deletePending, createTerminal, makeClaimUuid, type ReturnRoute,
} from './restart-receipt';
import { sendRestartReceipt } from './restart-receipt-sender';

/** Shared by the detached helper and the still-running supervisor on failure. */
export async function sendHelperFailureReceipt(
  profile: string,
  appPaths: Pick<AppPaths, 'profileDir'>,
  receiptId: string,
  returnRoute: ReturnRoute,
  reason: 'service-action-failure' | 'startup-timeout',
): Promise<void> {
  const kind = 'failure' as const;
  const uuid = makeClaimUuid(receiptId, kind);
  if (await readTerminal(appPaths.profileDir, receiptId)) {
    await cleanupReceiptArtifacts(appPaths.profileDir, receiptId).catch(() => {});
    return;
  }
  const claimed = await createClaim(appPaths.profileDir, {
    receiptId, kind, payload: returnRoute, uuid, claimedAt: new Date().toISOString(),
  });
  if (!claimed) {
    const existing = await readClaim(appPaths.profileDir, receiptId);
    if (existing && existing.kind !== kind) return;
  }
  const attempted = await createAttempt(appPaths.profileDir, {
    receiptId, ownerPid: process.pid, attemptedAt: new Date().toISOString(),
  });
  if (!attempted) return;
  await deletePending(appPaths.profileDir, receiptId);
  if (await readTerminal(appPaths.profileDir, receiptId)) {
    await cleanupReceiptArtifacts(appPaths.profileDir, receiptId).catch(() => {});
    return;
  }
  const result = await sendRestartReceipt({ profile, returnRoute, receiptId, kind, uuid, reason });
  if (result.ok && result.messageId) {
    await createTerminal(appPaths.profileDir, {
      receiptId, kind, outcome: 'completed', messageId: result.messageId,
    });
    console.log(`✓ 已发送失败通知: ${reason}`);
  } else {
    await createTerminal(appPaths.profileDir, { receiptId, kind, outcome: 'delivery-failed', reason });
    console.error(`✗ 发送失败通知失败: ${reason}`);
  }
  await cleanupReceiptArtifacts(appPaths.profileDir, receiptId).catch(() => {});
}
