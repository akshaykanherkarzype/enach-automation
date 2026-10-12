import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';
import { redis } from '../redis/client.js';
import type { PaceBudget } from './adaptive-pace.js';

/** Re-check after a pause. Does not use MAX_RETRY. */
export const HOST_PRESSURE_DEFER_MS = 30_000;
const SAMPLE_TTL_MS = 15_000;
const STALE_MS = 120_000;
const STATE_KEY = 'lock:payment:pressure';
const REFRESH_LOCK_KEY = 'lock:payment:pressure:refresh';
const METRICS_PATH = '/payment-service/api/v2/metrics';
const EVENT_LOOP_GAUGE = 'payment_service_nodejs_eventloop_lag_p99_seconds';

export type PressureLevel = 'ok' | 'slow' | 'pause';

export interface HostSample {
  memoryPct?: number;
  diskPct?: number;
  cpuPct?: number;
  /** payment-service process event-loop lag, milliseconds. */
  eventLoopP99Ms?: number;
  /** payment-service process RSS, mebibytes. */
  paymentRssMb?: number;
}

export interface PressureThresholds {
  memorySlow: number;
  memoryPause: number;
  diskSlow: number;
  diskPause: number;
  cpuSlow: number;
  cpuPause: number;
  eventLoopSlowMs: number;
  eventLoopPauseMs: number;
  paymentRssSlowMb: number;
  paymentRssPauseMb: number;
}

export interface PressureDecision {
  level: PressureLevel;
  reasons: string[];
  sample: HostSample;
}

export interface HostReading {
  label: string;
  value: string;
  status: 'Usual' | 'Elevated' | 'Pause';
}

export interface PressureBudgetLimits {
  maxInFlight: number;
  minGapMs: number;
  maxGapMs: number;
}

const OK: PressureDecision = { level: 'ok', reasons: [], sample: {} };

export function pressureThresholdsFromEnv(): PressureThresholds {
  return {
    memorySlow: env.HOST_MEM_SLOW,
    memoryPause: env.HOST_MEM_PAUSE,
    diskSlow: env.HOST_DISK_SLOW,
    diskPause: env.HOST_DISK_PAUSE,
    cpuSlow: env.HOST_CPU_SLOW,
    cpuPause: env.HOST_CPU_PAUSE,
    eventLoopSlowMs: env.HOST_EVENT_LOOP_SLOW_MS,
    eventLoopPauseMs: env.HOST_EVENT_LOOP_PAUSE_MS,
    paymentRssSlowMb: env.HOST_PAYMENT_RSS_SLOW_MB,
    paymentRssPauseMb: env.HOST_PAYMENT_RSS_PAUSE_MB,
  };
}

function worse(level: PressureLevel, next: PressureLevel): PressureLevel {
  if (level === 'pause' || next === 'pause') return 'pause';
  if (level === 'slow' || next === 'slow') return 'slow';
  return 'ok';
}

/**
 * Host percentages come from the same Prometheus queries as the PM2 dashboard.
 * Event-loop lag comes from payment-service `GET /payment-service/api/v2/metrics`.
 * A missing signal is ignored. Pause wins over a slowdown.
 */
export function classifyPressure(
  sample: HostSample,
  thresholds: PressureThresholds = pressureThresholdsFromEnv(),
): PressureDecision {
  let level: PressureLevel = 'ok';
  const reasons: string[] = [];

  const consider = (
    value: number | undefined,
    slowAt: number,
    pauseAt: number,
    label: string,
    unit: string,
  ) => {
    if (value === undefined || !Number.isFinite(value)) return;
    if (value >= pauseAt) {
      level = 'pause';
      reasons.push(`${label} ${Math.round(value)}${unit}`);
      return;
    }
    if (value >= slowAt) {
      level = worse(level, 'slow');
      reasons.push(`${label} ${Math.round(value)}${unit}`);
    }
  };

  consider(sample.memoryPct, thresholds.memorySlow, thresholds.memoryPause, 'memory', '%');
  consider(sample.diskPct, thresholds.diskSlow, thresholds.diskPause, 'disk', '%');
  consider(sample.cpuPct, thresholds.cpuSlow, thresholds.cpuPause, 'cpu', '%');
  consider(
    sample.eventLoopP99Ms,
    thresholds.eventLoopSlowMs,
    thresholds.eventLoopPauseMs,
    'event loop',
    'ms',
  );
  consider(
    sample.paymentRssMb,
    thresholds.paymentRssSlowMb,
    thresholds.paymentRssPauseMb,
    'payment service',
    ' MB',
  );

  return { level, reasons, sample };
}

function readingStatus(value: number | undefined, slowAt: number, pauseAt: number): HostReading['status'] {
  if (value === undefined || !Number.isFinite(value) || value < slowAt) return 'Usual';
  if (value >= pauseAt) return 'Pause';
  return 'Elevated';
}

function readingValue(value: number | undefined, unit: string): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (unit === ' MB') {
    if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
    return `${Math.round(value)} MB`;
  }
  return `${Math.round(value)}${unit}`;
}

/** Every host signal, including the ones still in the usual range. */
export function hostReadings(
  sample: HostSample,
  thresholds: PressureThresholds = pressureThresholdsFromEnv(),
): HostReading[] {
  return [
    {
      label: 'Memory',
      value: readingValue(sample.memoryPct, '%'),
      status: readingStatus(sample.memoryPct, thresholds.memorySlow, thresholds.memoryPause),
    },
    {
      label: 'Disk',
      value: readingValue(sample.diskPct, '%'),
      status: readingStatus(sample.diskPct, thresholds.diskSlow, thresholds.diskPause),
    },
    {
      label: 'CPU',
      value: readingValue(sample.cpuPct, '%'),
      status: readingStatus(sample.cpuPct, thresholds.cpuSlow, thresholds.cpuPause),
    },
    {
      label: 'Event loop',
      value: readingValue(sample.eventLoopP99Ms, ' ms'),
      status: readingStatus(sample.eventLoopP99Ms, thresholds.eventLoopSlowMs, thresholds.eventLoopPauseMs),
    },
    {
      label: 'Payment service',
      value: readingValue(sample.paymentRssMb, ' MB'),
      status: readingStatus(sample.paymentRssMb, thresholds.paymentRssSlowMb, thresholds.paymentRssPauseMb),
    },
  ];
}

/** First sample of a Prometheus instant-query response. */
export function prometheusValue(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const result = (body as { data?: { result?: unknown } }).data?.result;
  if (!Array.isArray(result) || !result[0] || typeof result[0] !== 'object') return undefined;
  const value = (result[0] as { value?: unknown }).value;
  if (!Array.isArray(value)) return undefined;
  const parsed = Number(value[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** One unlabelled gauge from a Prometheus text scrape. */
export function readGauge(text: string, name: string): number | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const rest = line.slice(name.length);
    if (rest[0] !== ' ' && rest[0] !== '{') continue;
    const parsed = Number(rest.trim().split(/\s+/).pop());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function eventLoopLagMs(metricsText: string): number | undefined {
  const seconds = readGauge(metricsText, EVENT_LOOP_GAUGE);
  if (seconds === undefined) return undefined;
  return seconds * 1_000;
}

/**
 * Slow: half the ceiling, gap at least 500ms. Pause: one call and the widest gap.
 * Never raises a budget that latency or a rate limit already cut.
 */
export function applyPressureToBudget(
  budget: PaceBudget,
  level: PressureLevel,
  limits: PressureBudgetLimits,
): PaceBudget {
  if (level === 'ok') return budget;
  if (level === 'pause') {
    return { inFlight: 1, gapMs: Math.max(budget.gapMs, limits.maxGapMs) };
  }
  return {
    inFlight: Math.max(1, Math.min(budget.inFlight, Math.floor(limits.maxInFlight / 2))),
    gapMs: Math.min(
      limits.maxGapMs,
      Math.max(budget.gapMs, 500, limits.minGapMs * 4),
    ),
  };
}

function hostQueries(instance: string): { memory: string; disk: string; cpu: string; paymentRss: string } {
  const host = instance.replace(/"/g, '');
  return {
    memory: `((node_memory_MemTotal_bytes{instance="${host}"} - node_memory_MemAvailable_bytes{instance="${host}"}) / node_memory_MemTotal_bytes{instance="${host}"}) * 100`,
    disk: `100 - ((node_filesystem_avail_bytes{instance="${host}",mountpoint="/",fstype!="rootfs"} / node_filesystem_size_bytes{instance="${host}",mountpoint="/",fstype!="rootfs"}) * 100)`,
    cpu: `100 - (avg by (instance) (irate(node_cpu_seconds_total{mode="idle",instance="${host}"}[5m])) * 100)`,
    paymentRss: `max(pm2_memory{instance="${host}",name="payment-service"})`,
  };
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
  if (!response.ok) return undefined;
  return response.json();
}

async function sampleHost(): Promise<HostSample> {
  const sample: HostSample = {};
  const base = env.GRAFANA_PROMETHEUS_URL.trim().replace(/\/$/, '');
  if (base) {
    const queries = hostQueries(env.HOST_METRICS_INSTANCE);
    const [memory, disk, cpu, paymentRss] = await Promise.all(
      [queries.memory, queries.disk, queries.cpu, queries.paymentRss].map(async (query) => {
        try {
          const body = await readJson(`${base}/api/v1/query?query=${encodeURIComponent(query)}`);
          return prometheusValue(body);
        } catch (err) {
          logger.warn({ err }, 'Host metric query failed');
          return undefined;
        }
      }),
    );
    sample.memoryPct = memory;
    sample.diskPct = disk;
    sample.cpuPct = cpu;
    if (paymentRss !== undefined) sample.paymentRssMb = paymentRss / (1024 * 1024);
  }

  const origin = env.PAYMENT_SERVICE_BASE_URL.trim().replace(/\/$/, '');
  if (origin) {
    try {
      const response = await fetch(`${origin}${METRICS_PATH}`, { signal: AbortSignal.timeout(4_000) });
      if (response.ok) sample.eventLoopP99Ms = eventLoopLagMs(await response.text());
    } catch (err) {
      logger.warn({ err }, 'Payment-service metrics scrape failed');
    }
  }
  return sample;
}

interface StoredPressure {
  at: number;
  decision: PressureDecision;
}

function parseStored(raw: string): StoredPressure | null {
  try {
    const value = JSON.parse(raw) as {
      at?: number;
      level?: PressureLevel;
      reasons?: string[];
      sample?: HostSample;
    };
    if (!value || typeof value.at !== 'number' || (value.level !== 'ok' && value.level !== 'slow' && value.level !== 'pause')) {
      return null;
    }
    const sample = value.sample && typeof value.sample === 'object' ? value.sample : {};
    return {
      at: value.at,
      decision: { level: value.level, reasons: Array.isArray(value.reasons) ? value.reasons : [], sample },
    };
  } catch {
    return null;
  }
}

let local: StoredPressure | null = null;

/** Latest host and process pressure. A failed scrape keeps the last sample, then the normal pace. */
export async function currentPressure(now = Date.now()): Promise<PressureDecision> {
  if (!env.hostPressure || env.PAYMENT_CLIENT !== 'http') return OK;
  if (local && now - local.at < SAMPLE_TTL_MS) return local.decision;

  try {
    const stored = parseStored((await redis.get(STATE_KEY)) ?? '');
    if (stored && now - stored.at < SAMPLE_TTL_MS) {
      local = stored;
      return stored.decision;
    }

    const locked = await redis.set(REFRESH_LOCK_KEY, '1', 'PX', 8_000, 'NX');
    if (locked !== 'OK') {
      if (stored && now - stored.at < STALE_MS) return stored.decision;
      return local?.decision ?? OK;
    }

    const decision = classifyPressure(await sampleHost());
    const next = { at: now, decision };
    await redis.set(
      STATE_KEY,
      JSON.stringify({ at: now, level: decision.level, reasons: decision.reasons, sample: decision.sample }),
      'EX',
      180,
    );
    const previous = local?.decision.level;
    local = next;
    if (decision.level !== 'ok') {
      logger.warn({ level: decision.level, reasons: decision.reasons }, 'Payment pace limited by host pressure');
    } else if (previous && previous !== 'ok') {
      logger.info('Host pressure is back in range; payment pace restored');
    }
    return decision;
  } catch (err) {
    logger.warn({ err }, 'Host pressure check failed; keeping the normal pace');
    return local?.decision ?? OK;
  }
}

export interface HostSnapshot {
  instance: string;
  level: PressureLevel;
  readings: HostReading[];
  sampledAt: string;
}

export function presentHost(sample: HostSample, instance: string, at = new Date()): HostSnapshot {
  return {
    instance,
    level: classifyPressure(sample).level,
    readings: hostReadings(sample),
    sampledAt: at.toISOString(),
  };
}

function sampleHasReading(sample: HostSample): boolean {
  return [sample.memoryPct, sample.diskPct, sample.cpuPct, sample.eventLoopP99Ms, sample.paymentRssMb].some(
    (value) => value !== undefined,
  );
}

/** Current respo-prod gauges for the dashboard. Uses the shared sample while it is fresh. */
export async function liveHostMetrics(now = Date.now()): Promise<HostSnapshot> {
  const decision = await currentPressure(now);
  if (sampleHasReading(decision.sample)) {
    return presentHost(decision.sample, env.HOST_METRICS_INSTANCE, new Date(now));
  }
  try {
    return presentHost(await sampleHost(), env.HOST_METRICS_INSTANCE, new Date(now));
  } catch (err) {
    logger.warn({ err }, 'Live host metrics were not available');
    return presentHost({}, env.HOST_METRICS_INSTANCE, new Date(now));
  }
}
