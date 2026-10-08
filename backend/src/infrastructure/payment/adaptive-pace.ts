import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';
import { redis } from '../redis/client.js';

const STATE_KEY = 'lock:payment:pace';
const RATE_HOLD_KEY = 'lock:payment:rate-hold';
const STATE_TTL_SECONDS = 60 * 60;

export interface PaceBudget {
  inFlight: number;
  gapMs: number;
}

export interface LatencyControl extends PaceBudget {
  ewmaMs: number;
  baselineMs: number;
  samples: number;
  lastAdjustAt: number;
}

export interface AdaptiveConfig {
  maxInFlight: number;
  minGapMs: number;
  maxGapMs: number;
  minSamples: number;
  /** Cut concurrency when the moving average reaches this multiple of the baseline. */
  slowRatio: number;
  /** Drop to one call when the average reaches this multiple. */
  severeRatio: number;
  /** Add a call back when the average is at or below this multiple. */
  recoverRatio: number;
  increaseCooldownMs: number;
  /** Weight of the newest sample. 0.3 means a slow stretch shows up within a handful of calls. */
  alpha: number;
}

export function adaptiveConfigFromEnv(): AdaptiveConfig {
  const minGapMs = Math.max(0, env.PAYMENT_REQUEST_GAP_MS);
  const maxGapMs = Math.min(10_000, Math.max(minGapMs, minGapMs * 16, 2_000));
  return {
    maxInFlight: Math.max(1, env.PAYMENT_MAX_IN_FLIGHT),
    minGapMs,
    maxGapMs,
    minSamples: 8,
    slowRatio: 2,
    severeRatio: 4,
    recoverRatio: 1.3,
    increaseCooldownMs: 20_000,
    alpha: 0.3,
  };
}

export function configuredBudget(config: AdaptiveConfig = adaptiveConfigFromEnv()): PaceBudget {
  return { inFlight: config.maxInFlight, gapMs: config.minGapMs };
}

/**
 * The first samples learn a baseline. After that, a sustained rise in response
 * time cuts how many calls may run at once and widens the gap. A return to the
 * baseline adds one call back at a time.
 */
export function applyLatencySample(
  current: LatencyControl | null,
  sampleMs: number,
  now: number,
  config: AdaptiveConfig,
): LatencyControl {
  const sample = Math.max(1, Math.round(sampleMs));
  const base: LatencyControl = current ?? {
    ewmaMs: sample,
    baselineMs: sample,
    samples: 0,
    inFlight: config.maxInFlight,
    gapMs: config.minGapMs,
    lastAdjustAt: now,
  };

  const samples = base.samples + 1;
  const ewmaMs = base.samples === 0 ? sample : config.alpha * sample + (1 - config.alpha) * base.ewmaMs;
  let baselineMs = base.baselineMs;
  let inFlight = Math.min(config.maxInFlight, Math.max(1, base.inFlight));
  let gapMs = Math.min(config.maxGapMs, Math.max(config.minGapMs, base.gapMs));
  let lastAdjustAt = base.lastAdjustAt;
  const ratio = ewmaMs / Math.max(1, baselineMs);

  if (samples >= config.minSamples && ratio >= config.severeRatio) {
    inFlight = 1;
    gapMs = config.maxGapMs;
    lastAdjustAt = now;
  } else if (samples >= config.minSamples && ratio >= config.slowRatio) {
    inFlight = Math.max(1, Math.floor(inFlight / 2));
    gapMs = Math.min(config.maxGapMs, Math.max(config.minGapMs, gapMs * 2));
    lastAdjustAt = now;
  } else if (
    samples >= config.minSamples &&
    ratio <= config.recoverRatio &&
    now - lastAdjustAt >= config.increaseCooldownMs
  ) {
    inFlight = Math.min(config.maxInFlight, inFlight + 1);
    gapMs = Math.max(config.minGapMs, Math.floor((gapMs + config.minGapMs) / 2));
    baselineMs = baselineMs + (ewmaMs - baselineMs) * 0.05;
    lastAdjustAt = now;
  }

  if (ewmaMs < baselineMs) baselineMs = ewmaMs;

  return {
    ewmaMs: Math.round(ewmaMs),
    baselineMs: Math.round(Math.max(1, baselineMs)),
    samples,
    inFlight,
    gapMs: Math.round(gapMs),
    lastAdjustAt,
  };
}

function parseControl(raw: string): LatencyControl | null {
  try {
    const value = JSON.parse(raw) as Partial<LatencyControl>;
    if (!value || typeof value.ewmaMs !== 'number' || typeof value.inFlight !== 'number') return null;
    return {
      ewmaMs: value.ewmaMs,
      baselineMs: typeof value.baselineMs === 'number' ? value.baselineMs : value.ewmaMs,
      samples: typeof value.samples === 'number' ? value.samples : 0,
      inFlight: value.inFlight,
      gapMs: typeof value.gapMs === 'number' ? value.gapMs : env.PAYMENT_REQUEST_GAP_MS,
      lastAdjustAt: typeof value.lastAdjustAt === 'number' ? value.lastAdjustAt : 0,
    };
  } catch {
    return null;
  }
}

const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[1] then
  return current
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 'OK'
`;

export function rateHoldBudget(config: AdaptiveConfig = adaptiveConfigFromEnv()): PaceBudget {
  return {
    inFlight: 1,
    gapMs: Math.min(config.maxGapMs, Math.max(config.minGapMs, 1_000)),
  };
}

/** One call at a time until payment-service's rate-limit window passes. Shared by every worker. */
export async function noteRateLimited(delayMs: number): Promise<void> {
  const holdMs = Math.max(1_000, Math.round(delayMs));
  try {
    await redis.set(RATE_HOLD_KEY, '1', 'PX', holdMs);
    logger.warn({ holdMs }, 'Payment pace held after a rate limit');
  } catch (err) {
    logger.warn({ err }, 'Could not store the payment rate-limit hold');
  }
}

export async function loadPaceBudget(): Promise<PaceBudget> {
  const config = adaptiveConfigFromEnv();
  const fallback = configuredBudget(config);
  try {
    const held = await redis.exists(RATE_HOLD_KEY);
    if (held) return rateHoldBudget(config);
  } catch (err) {
    logger.warn({ err }, 'Payment rate-limit hold unavailable');
  }
  if (!env.paymentAdaptive) return fallback;
  try {
    const raw = await redis.get(STATE_KEY);
    if (!raw) return fallback;
    const parsed = parseControl(raw);
    if (!parsed) return fallback;
    return {
      inFlight: Math.min(config.maxInFlight, Math.max(1, parsed.inFlight)),
      gapMs: Math.min(config.maxGapMs, Math.max(config.minGapMs, parsed.gapMs)),
    };
  } catch (err) {
    logger.warn({ err }, 'Payment pace state unavailable; using the configured cap');
    return fallback;
  }
}

/** Record one UPI call's duration. Shared by every worker through Redis. */
export async function notePaymentLatency(sampleMs: number, now = Date.now()): Promise<void> {
  if (!env.paymentAdaptive || !Number.isFinite(sampleMs) || sampleMs <= 0) return;
  const config = adaptiveConfigFromEnv();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = (await redis.get(STATE_KEY)) ?? '';
    const current = raw ? parseControl(raw) : null;
    const next = applyLatencySample(current, sampleMs, now, config);
    const saved = await redis.eval(CAS_SCRIPT, 1, STATE_KEY, raw, JSON.stringify(next), String(STATE_TTL_SECONDS));
    if (saved !== 'OK') continue;

    const changed =
      !current || current.inFlight !== next.inFlight || current.gapMs !== next.gapMs;
    if (changed && next.samples >= config.minSamples) {
      logger.info(
        {
          inFlight: next.inFlight,
          gapMs: next.gapMs,
          ewmaMs: next.ewmaMs,
          baselineMs: next.baselineMs,
          maxInFlight: config.maxInFlight,
        },
        'Payment pace adjusted to response time',
      );
    }
    return;
  }
}
