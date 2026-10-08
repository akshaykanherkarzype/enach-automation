import { randomUUID } from 'node:crypto';

export class PaymentSlotBusyError extends Error {
  constructor() {
    super('Timed out waiting for a payment-service call permit');
    this.name = 'PaymentSlotBusyError';
  }
}

export interface PaymentLimitDeps {
  waitMs: number;
  /** 'ok' when a permit was taken. A number is how long to wait before trying again. */
  tryAcquire: (token: string) => Promise<'ok' | number>;
  release: (token: string) => Promise<void>;
  sleepFn: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Limits how many payment-service calls run at once, shared by every worker.
 * The permit is released when the HTTP call finishes. A crashed worker loses
 * the permit when its lease expires.
 */
export async function runWithPaymentLimit<T>(
  work: () => Promise<T>,
  deps: PaymentLimitDeps,
): Promise<T> {
  const now = deps.now ?? Date.now;
  const token = randomUUID();
  const deadline = now() + Math.max(0, deps.waitMs);
  let acquired = false;

  while (now() <= deadline) {
    const result = await deps.tryAcquire(token);
    if (result === 'ok') {
      acquired = true;
      break;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const wait = Math.min(Math.max(result, 20), remaining);
    await deps.sleepFn(wait);
  }

  if (!acquired) {
    throw new PaymentSlotBusyError();
  }

  try {
    return await work();
  } finally {
    try {
      await deps.release(token);
    } catch {
      // The lease expires if Redis is briefly unavailable.
    }
  }
}
