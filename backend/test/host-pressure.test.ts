import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPressureToBudget,
  classifyPressure,
  eventLoopLagMs,
  prometheusValue,
  type PressureThresholds,
} from '../src/infrastructure/payment/host-pressure.js';

const thresholds: PressureThresholds = {
  memorySlow: 80,
  memoryPause: 90,
  diskSlow: 85,
  diskPause: 92,
  cpuSlow: 75,
  cpuPause: 90,
  eventLoopSlowMs: 250,
  eventLoopPauseMs: 1_000,
};

const limits = { maxInFlight: 8, minGapMs: 125, maxGapMs: 2_000 };

test('the current respo-prod board stays at the normal pace', () => {
  const decision = classifyPressure(
    { memoryPct: 57.4, diskPct: 28.1, cpuPct: 31.8, eventLoopP99Ms: 11 },
    thresholds,
  );
  assert.equal(decision.level, 'ok');
  assert.deepEqual(decision.reasons, []);
});

test('a high host signal slows the batch, and a critical one pauses it', () => {
  const slow = classifyPressure({ memoryPct: 82, diskPct: 28, cpuPct: 40 }, thresholds);
  assert.equal(slow.level, 'slow');
  assert.deepEqual(slow.reasons, ['memory 82%']);

  const paused = classifyPressure({ memoryPct: 91, diskPct: 93, cpuPct: 40 }, thresholds);
  assert.equal(paused.level, 'pause');
  assert.deepEqual(paused.reasons, ['memory 91%', 'disk 93%']);

  const loop = classifyPressure({ eventLoopP99Ms: 1_200 }, thresholds);
  assert.equal(loop.level, 'pause');
  assert.deepEqual(loop.reasons, ['event loop 1200ms']);
});

test('a missing signal is ignored', () => {
  const decision = classifyPressure({}, thresholds);
  assert.equal(decision.level, 'ok');
});

test('prometheus and payment-service metric text are read as numbers', () => {
  assert.equal(
    prometheusValue({
      status: 'success',
      data: { resultType: 'vector', result: [{ value: [1, '58.2'] }] },
    }),
    58.2,
  );
  assert.equal(prometheusValue({ data: { result: [] } }), undefined);

  const text = [
    '# HELP payment_service_nodejs_eventloop_lag_p99_seconds lag',
    'payment_service_nodejs_eventloop_lag_p99_seconds 0.25',
    'payment_service_nodejs_eventloop_lag_p99_seconds_sum 9',
  ].join('\n');
  assert.equal(eventLoopLagMs(text), 250);
});

test('pressure lowers the shared pace and does not raise a pace already cut', () => {
  const slowed = applyPressureToBudget({ inFlight: 8, gapMs: 125 }, 'slow', limits);
  assert.equal(slowed.inFlight, 4);
  assert.equal(slowed.gapMs, 500);

  const alreadyCut = applyPressureToBudget({ inFlight: 2, gapMs: 1_000 }, 'slow', limits);
  assert.equal(alreadyCut.inFlight, 2);
  assert.equal(alreadyCut.gapMs, 1_000);

  const paused = applyPressureToBudget({ inFlight: 8, gapMs: 125 }, 'pause', limits);
  assert.equal(paused.inFlight, 1);
  assert.equal(paused.gapMs, 2_000);
});
