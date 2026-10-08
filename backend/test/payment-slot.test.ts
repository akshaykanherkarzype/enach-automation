import assert from 'node:assert/strict';
import test from 'node:test';
import { PaymentSlotBusyError, runWithPaymentLimit } from '../src/infrastructure/payment/slot.js';

test('a permit is waited for, the call runs, then the permit is released', async () => {
  const events: string[] = [];
  let attempts = 0;
  const result = await runWithPaymentLimit(async () => {
    events.push('work');
    return 'ok';
  }, {
    waitMs: 1000,
    now: () => 0,
    tryAcquire: async () => {
      attempts += 1;
      events.push(`acquire:${attempts}`);
      return attempts > 1 ? 'ok' : 80;
    },
    release: async () => {
      events.push('release');
    },
    sleepFn: async (ms) => {
      events.push(`sleep:${ms}`);
    },
  });

  assert.equal(result, 'ok');
  assert.deepEqual(events, ['acquire:1', 'sleep:80', 'acquire:2', 'work', 'release']);
});

test('a failed call still releases the permit', async () => {
  const events: string[] = [];
  await assert.rejects(
    () =>
      runWithPaymentLimit(async () => {
        events.push('work');
        throw new Error('boom');
      }, {
        waitMs: 0,
        now: () => 0,
        tryAcquire: async () => 'ok',
        release: async () => {
          events.push('release');
        },
        sleepFn: async () => {
          events.push('sleep');
        },
      }),
    /boom/,
  );
  assert.deepEqual(events, ['work', 'release']);
});

test('waiting past the deadline raises PaymentSlotBusyError and does not call payment-service', async () => {
  let now = 0;
  let worked = false;
  await assert.rejects(
    () =>
      runWithPaymentLimit(async () => {
        worked = true;
        return 1;
      }, {
        waitMs: 100,
        now: () => now,
        tryAcquire: async () => 80,
        release: async () => undefined,
        sleepFn: async (ms) => {
          now += ms;
        },
      }),
    PaymentSlotBusyError,
  );
  assert.equal(worked, false);
});
