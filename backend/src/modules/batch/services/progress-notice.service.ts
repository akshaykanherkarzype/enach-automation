import type { BatchModule } from '@prisma/client';
import { formatIstTimestamp } from '../../../infrastructure/email/content.js';
import { emailClient } from '../../../infrastructure/email/client.js';
import { logger } from '../../../common/logger/logger.js';
import { redis } from '../../../infrastructure/redis/client.js';
import { batchRepository } from '../repositories/batch.repository.js';

export type NoticeEpisode = 'payment' | 'peak' | 'host';
export type NoticeState = 'down' | 'up' | 'paused' | 'running';

const NOTICE_TTL_SECONDS = 48 * 60 * 60;

/**
 * One email per transition. A pause is announced once. A resume is announced
 * only after that pause. A later pause can be announced again.
 */
export function shouldNotifyTransition(current: string | null, next: NoticeState): boolean {
  if (next === 'down' || next === 'paused') return current !== next;
  if (next === 'up') return current === 'down';
  return current === 'paused';
}

const CLAIM_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then current = '' end
local next = ARGV[1]
local allow = 0
if next == 'down' or next == 'paused' then
  if current ~= next then allow = 1 end
elseif next == 'up' then
  if current == 'down' then allow = 1 end
elseif next == 'running' then
  if current == 'paused' then allow = 1 end
end
if allow == 0 then return 'NO' end
redis.call('SET', KEYS[1], next, 'EX', ARGV[2])
return 'OK|' .. current
`;

function noticeKey(batchId: bigint, episode: NoticeEpisode): string {
  return `notify:batch:${batchId}:${episode}`;
}

async function claimTransition(
  key: string,
  next: NoticeState,
): Promise<{ claimed: boolean; previous: string }> {
  const result = await redis.eval(CLAIM_SCRIPT, 1, key, next, String(NOTICE_TTL_SECONDS));
  const value = String(result);
  if (!value.startsWith('OK|')) return { claimed: false, previous: '' };
  return { claimed: true, previous: value.slice(3) };
}

async function restoreTransition(key: string, previous: string): Promise<void> {
  if (!previous) {
    await redis.del(key);
    return;
  }
  await redis.set(key, previous, 'EX', NOTICE_TTL_SECONDS);
}

export async function notifyBatchEpisode(input: {
  batchId: bigint;
  module: BatchModule;
  uploadedBy: string;
  total: number;
  episode: NoticeEpisode;
  next: NoticeState;
  cause?: string;
  resumesAt?: Date;
  customerId?: string;
  responseCode?: string;
  traceId?: string;
}): Promise<void> {
  const key = noticeKey(input.batchId, input.episode);
  let claim: { claimed: boolean; previous: string };
  try {
    claim = await claimTransition(key, input.next);
  } catch (err) {
    logger.error({ err, batchId: String(input.batchId) }, 'Failed to claim batch progress notice');
    return;
  }
  if (!claim.claimed) return;

  try {
    const counts = await batchRepository.recount(input.batchId);
    const remaining = Math.max(0, input.total - counts.successCount - counts.failedCount);
    const kind =
      input.episode === 'payment'
        ? input.next === 'down'
          ? 'payment_paused'
          : 'payment_resumed'
        : input.episode === 'host'
          ? input.next === 'paused'
            ? 'host_paused'
            : 'host_resumed'
          : input.next === 'paused'
            ? 'peak_paused'
            : 'peak_resumed';

    await emailClient.sendBatchProgress({
      to: input.uploadedBy,
      module: input.module,
      batchId: String(input.batchId),
      kind,
      total: input.total,
      success: counts.successCount,
      failed: counts.failedCount,
      remaining,
      cause: input.cause,
      resumesAt: input.resumesAt ? formatIstTimestamp(input.resumesAt) : undefined,
      customerId: input.customerId,
      responseCode: input.responseCode,
      traceId: input.traceId,
    });
  } catch (err) {
    logger.error(
      { err, batchId: String(input.batchId), episode: input.episode, next: input.next },
      'Failed to send batch progress notice',
    );
    try {
      await restoreTransition(key, claim.previous);
    } catch (restoreErr) {
      logger.error({ err: restoreErr, key }, 'Failed to restore batch progress notice claim');
    }
  }
}
