import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPressureToBudget,
  classifyPressure,
  eventLoopLagMs,
  hostReadings,
  presentHost,
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
  paymentRssSlowMb: 1024,
  paymentRssPauseMb: 1536,
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
  assert.equal(slow.sample.memoryPct, 82);

  const readings = hostReadings({ memoryPct: 82, diskPct: 28, cpuPct: 76, eventLoopP99Ms: 40 }, thresholds);
  assert.deepEqual(
    readings.map((row) => row.status),
    ['Elevated', 'Usual', 'Elevated', 'Usual', 'Usual'],
  );

  const paused = classifyPressure({ memoryPct: 91, diskPct: 93, cpuPct: 40 }, thresholds);
  assert.equal(paused.level, 'pause');
  assert.deepEqual(paused.reasons, ['memory 91%', 'disk 93%']);

  const loop = classifyPressure({ eventLoopP99Ms: 1_200 }, thresholds);
  assert.equal(loop.level, 'pause');
  assert.deepEqual(loop.reasons, ['event loop 1200ms']);
});

test('payment-service memory pauses calls while the host still looks ordinary', () => {
  const rising = classifyPressure({ memoryPct: 45, diskPct: 20, cpuPct: 26, paymentRssMb: 1100 }, thresholds);
  assert.equal(rising.level, 'slow');
  assert.deepEqual(rising.reasons, ['payment service 1100 MB']);

  const full = classifyPressure({ memoryPct: 45, diskPct: 20, cpuPct: 26, paymentRssMb: 1800 }, thresholds);
  assert.equal(full.level, 'pause');
  assert.deepEqual(full.reasons, ['payment service 1800 MB']);

  const reading = hostReadings({ paymentRssMb: 1800 }, thresholds).find((row) => row.label === 'Payment service');
  assert.equal(reading?.value, '1.8 GB');
  assert.equal(reading?.status, 'Pause');
});

test('a live host snapshot names the instance and every reading', () => {
  const snapshot = presentHost(
    { memoryPct: 57.4, diskPct: 28.1, cpuPct: 31.8, eventLoopP99Ms: 11 },
    'respo-prod',
    new Date('2026-10-09T11:40:00.000Z'),
  );
  assert.equal(snapshot.instance, 'respo-prod');
  assert.equal(snapshot.level, 'ok');
  assert.equal(snapshot.readings.length, 5);
  assert.equal(snapshot.readings[0].label, 'Memory');
  assert.equal(snapshot.readings[2].value, '32%');
  assert.equal(snapshot.sampledAt, '2026-10-09T11:40:00.000Z');
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
