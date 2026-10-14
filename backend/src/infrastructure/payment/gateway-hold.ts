import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';
import { redis } from '../redis/client.js';

const HOLD_KEY = 'lock:payment:gateway-hold';

/**
 * One 502, 503, 504, or client timeout stops every invoice and charge call.
 * The timestamp is shared, so a later timeout in the same window does not start a new wait.
 */
export async function armGatewayHold(now = Date.now()): Promise<number> {
  const holdMs = env.GATEWAY_OUTAGE_HOLD_MS;
  const until = now + holdMs;
  try {
    const existing = Number(await redis.get(HOLD_KEY));
    const nextUntil = Number.isFinite(existing) && existing > until ? existing : until;
    const ttlSec = Math.max(1, Math.ceil((nextUntil - now) / 1000));
    await redis.set(HOLD_KEY, String(nextUntil), 'EX', ttlSec);
    logger.warn({ holdMs, resumesAt: new Date(nextUntil).toISOString() }, 'Payment calls paused after a gateway timeout');
    return Math.max(1_000, nextUntil - now);
  } catch (err) {
    logger.warn({ err }, 'Gateway hold was not stored; pausing this worker for the configured window');
    return holdMs;
  }
}

/** Milliseconds left on the shared pause. Zero means invoice and charge calls may start. */
export async function gatewayHoldRemaining(now = Date.now()): Promise<number> {
  try {
    const until = Number(await redis.get(HOLD_KEY));
    if (!Number.isFinite(until) || until <= now) return 0;
    return until - now;
  } catch (err) {
    logger.warn({ err }, 'Gateway hold could not be read');
    return 0;
  }
}
