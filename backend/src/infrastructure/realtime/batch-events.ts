import { logger } from '../../common/logger/logger.js';
import { redis } from '../redis/client.js';

export const BATCH_EVENT_CHANNEL = 'upi-batch:events';
const COALESCE_MS = 400;

export interface BatchChangedEvent {
  type: 'batch.changed';
  batchId: string;
}

export function createBatchEventScheduler(
  publish: (batchId: string) => void,
  delayMs = COALESCE_MS,
) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule(batchId: string, immediate = false) {
      const existing = pending.get(batchId);
      if (immediate) {
        if (existing) clearTimeout(existing);
        pending.delete(batchId);
        publish(batchId);
        return;
      }
      if (existing) return;
      pending.set(
        batchId,
        setTimeout(() => {
          pending.delete(batchId);
          publish(batchId);
        }, delayMs),
      );
    },
  };
}

async function publishBatchChanged(batchId: string): Promise<void> {
  const event: BatchChangedEvent = { type: 'batch.changed', batchId };
  try {
    await redis.publish(BATCH_EVENT_CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.warn({ err, batchId }, 'Failed to publish batch update');
  }
}

const scheduler = createBatchEventScheduler((batchId) => {
  void publishBatchChanged(batchId);
});

/** Tell open dashboards that this batch changed. Bursts collapse into one update. */
export function scheduleBatchChanged(batchId: bigint | string, immediate = false): void {
  scheduler.schedule(String(batchId), immediate);
}
