import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptiveConfigFromEnv,
  applyLatencySample,
  rateHoldBudget,
  type AdaptiveConfig,
  type LatencyControl,
} from '../src/infrastructure/payment/adaptive-pace.js';

/** Matches backend/.env: 8 in flight, 125ms gap. Widest gap is max(125, 125×16, 2000) = 2000. */
const config: AdaptiveConfig = {
  maxInFlight: 8,
  minGapMs: 125,
  maxGapMs: 2_000,
  minSamples: 8,
  slowRatio: 2,
  severeRatio: 4,
  recoverRatio: 1.3,
  increaseCooldownMs: 20_000,
  alpha: 0.3,
};

function feed(samples: number[], startAt = 0, stepMs = 1_000, initial: LatencyControl | null = null) {
  let state = initial;
  samples.forEach((sample, index) => {
    state = applyLatencySample(state, sample, startAt + index * stepMs, config);
  });
  if (!state) throw new Error('expected state');
  return state;
}

test('a rate-limit hold sends one call at a time until the window passes', () => {
  const hold = rateHoldBudget(config);
  assert.equal(hold.inFlight, 1);
  assert.equal(hold.gapMs, 1_000);
});

test('the configured ceiling is 8 calls and a 125ms gap', () => {
  const fromEnv = adaptiveConfigFromEnv();
  assert.equal(fromEnv.maxInFlight, 8);
  assert.equal(fromEnv.minGapMs, 125);
  assert.equal(fromEnv.maxGapMs, 2_000);
});

test('the first calls learn a baseline and keep the configured ceiling', () => {
  const state = feed(Array(8).fill(1_000));
  assert.equal(state.samples, 8);
  assert.equal(state.inFlight, 8);
  assert.equal(state.gapMs, 125);
  assert.ok(state.baselineMs <= 1_000);
});

test('a sustained slower response cuts in-flight calls and widens the gap', () => {
  const warm = feed(Array(8).fill(1_000));
  const slowed = feed(Array(6).fill(5_000), 30_000, 1_000, warm);
  assert.ok(slowed.inFlight < warm.inFlight);
  assert.ok(slowed.inFlight >= 1);
  assert.ok(slowed.gapMs > warm.gapMs);
  assert.ok(slowed.gapMs <= config.maxGapMs);
});

test('a severe slowdown leaves a single call in flight', () => {
  const warm = feed(Array(8).fill(1_000));
  const stalled = feed(Array(8).fill(12_000), 30_000, 1_000, warm);
  assert.equal(stalled.inFlight, 1);
  assert.equal(stalled.gapMs, config.maxGapMs);
});

test('recovery adds calls back without passing the ceiling', () => {
  const warm = feed(Array(8).fill(1_000));
  const slowed = feed([8_000], 30_000, 1_000, warm);
  assert.equal(slowed.inFlight, 4);
  assert.equal(slowed.gapMs, 250);

  let state = slowed;
  let increased = false;
  for (let i = 0; i < 30; i += 1) {
    const before = state.inFlight;
    state = applyLatencySample(state, 1_000, 40_000 + i * 25_000, config);
    if (state.inFlight > before) increased = true;
  }
  assert.equal(increased, true);
  assert.equal(state.inFlight, config.maxInFlight);
  assert.equal(state.gapMs, config.minGapMs);
});

test('a slow first call does not lock the baseline above later fast calls', () => {
  const state = feed([8_000, ...Array(7).fill(500)]);
  assert.ok(state.baselineMs < 2_000);
  assert.equal(state.inFlight, config.maxInFlight);
});
