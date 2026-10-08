import { env } from '../../common/config/env.js';
import { sleep } from '../../common/utils/parse-size.js';
import { redis } from '../redis/client.js';
import { loadPaceBudget } from './adaptive-pace.js';
import { runWithPaymentLimit } from './slot.js';

const INFLIGHT_KEY = 'lock:payment:inflight';
const LAST_START_KEY = 'lock:payment:last-start';

/**
 * Atomically admits a call when fewer than max-in-flight permits are held
 * and the previous start was at least gapMs ago.
 * Returns 1 when admitted, otherwise milliseconds the caller should wait.
 */
const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local maxInFlight = tonumber(ARGV[2])
local leaseMs = tonumber(ARGV[3])
local token = ARGV[4]
local gapMs = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local count = redis.call('ZCARD', KEYS[1])
if count >= maxInFlight then
  return 40
end
if gapMs > 0 then
  local last = tonumber(redis.call('GET', KEYS[2]) or '0')
  local wait = gapMs - (now - last)
  if wait > 0 then
    return wait
  end
  redis.call('SET', KEYS[2], tostring(now), 'PX', math.max(gapMs * 20, 1000))
end
redis.call('ZADD', KEYS[1], now + leaseMs, token)
redis.call('PEXPIRE', KEYS[1], leaseMs + 60000)
return 1
`;

const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

/**
 * Eight calls may wait on payment-service at once, with 125ms between starts.
 * That is the same concurrent load data-pipeline already sends.
 */
export function pacePaymentCall<T>(work: () => Promise<T>): Promise<T> {
  const leaseMs = env.API_TIMEOUT + 15_000;
  return runWithPaymentLimit(work, {
    waitMs: env.PAYMENT_SLOT_WAIT_MS,
    sleepFn: sleep,
    tryAcquire: async (token) => {
      const budget = await loadPaceBudget();
      const result = await redis.eval(
        ACQUIRE_SCRIPT,
        2,
        INFLIGHT_KEY,
        LAST_START_KEY,
        String(Date.now()),
        String(budget.inFlight),
        String(leaseMs),
        token,
        String(budget.gapMs),
      );
      const code = Number(result);
      if (code === 1) return 'ok';
      return Number.isFinite(code) && code > 0 ? code : 40;
    },
    release: async (token) => {
      await redis.eval(RELEASE_SCRIPT, 1, INFLIGHT_KEY, token);
    },
  });
}
