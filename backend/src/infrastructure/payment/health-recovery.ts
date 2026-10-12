import { redis } from '../redis/client.js';

const STATE_KEY = 'lock:payment:health';
const STATE_TTL_SECONDS = 60 * 60;

/** After health returns UP, keep calls off so payment-service can finish loading configuration. */
export const DEFAULT_RECOVER_SETTLE_MS = 60_000;

export interface HealthRecovery {
  phase: 'down' | 'settling';
  until: number;
}

export interface HealthHold {
  delayMs: number;
  reason: 'PAYMENT_SERVICE_UNAVAILABLE' | 'PAYMENT_SERVICE_SETTLING';
}

export interface HealthProbeResult {
  next: HealthRecovery | null;
  hold: HealthHold | null;
}

/**
 * A failed health check marks the service down. The first UP after that starts
 * a settle window. Calls made in that window are deferred and do not use a retry.
 * A later UP with no outage does not wait.
 */
export function applyHealthProbe(
  current: HealthRecovery | null,
  up: boolean,
  now: number,
  settleMs: number,
  downRecheckMs: number,
): HealthProbeResult {
  if (!up) {
    return {
      next: { phase: 'down', until: now },
      hold: { delayMs: downRecheckMs, reason: 'PAYMENT_SERVICE_UNAVAILABLE' },
    };
  }

  if (current?.phase === 'down') {
    const delayMs = Math.max(1_000, settleMs);
    return {
      next: { phase: 'settling', until: now + delayMs },
      hold: { delayMs, reason: 'PAYMENT_SERVICE_SETTLING' },
    };
  }

  if (current?.phase === 'settling' && current.until > now) {
    return {
      next: current,
      hold: { delayMs: current.until - now, reason: 'PAYMENT_SERVICE_SETTLING' },
    };
  }

  return { next: null, hold: null };
}

/** Before a payment call. A down service is probed by the caller; this only reads the clock. */
export function holdBeforeCall(current: HealthRecovery | null, now: number): HealthHold | null {
  if (!current) return null;
  if (current.phase === 'settling' && current.until > now) {
    return { delayMs: current.until - now, reason: 'PAYMENT_SERVICE_SETTLING' };
  }
  if (current.phase === 'settling') return null;
  return null;
}

export function parseHealthRecovery(raw: string): HealthRecovery | null {
  try {
    const value = JSON.parse(raw) as Partial<HealthRecovery>;
    if (!value || (value.phase !== 'down' && value.phase !== 'settling') || typeof value.until !== 'number') {
      return null;
    }
    return { phase: value.phase, until: value.until };
  } catch {
    return null;
  }
}

export interface HealthRecoveryStore {
  load(): Promise<HealthRecovery | null>;
  save(next: HealthRecovery | null): Promise<void>;
}

export function redisHealthStore(): HealthRecoveryStore {
  return {
    async load() {
      const raw = await redis.get(STATE_KEY);
      return raw ? parseHealthRecovery(raw) : null;
    },
    async save(next) {
      if (!next) {
        await redis.del(STATE_KEY);
        return;
      }
      await redis.set(STATE_KEY, JSON.stringify(next), 'EX', STATE_TTL_SECONDS);
    },
  };
}

export function memoryHealthStore(initial: HealthRecovery | null = null): HealthRecoveryStore {
  let current = initial;
  return {
    async load() {
      return current;
    },
    async save(next) {
      current = next;
    },
  };
}
