import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHealthProbe, holdBeforeCall } from '../src/infrastructure/payment/health-recovery.js';
import { HEALTH_DEFER_MS } from '../src/infrastructure/payment/retry-policy.js';

const settleMs = 60_000;
const now = 1_000_000;

test('a healthy service does not wait, and a down service is rechecked', () => {
  const open = applyHealthProbe(null, true, now, settleMs, HEALTH_DEFER_MS);
  assert.equal(open.hold, null);
  assert.equal(open.next, null);

  const down = applyHealthProbe(null, false, now, settleMs, HEALTH_DEFER_MS);
  assert.equal(down.next?.phase, 'down');
  assert.equal(down.hold?.reason, 'PAYMENT_SERVICE_UNAVAILABLE');
  assert.equal(down.hold?.delayMs, HEALTH_DEFER_MS);
});

test('the first UP after an outage waits for configuration to load', () => {
  const down = applyHealthProbe(null, false, now, settleMs, HEALTH_DEFER_MS).next;
  const settling = applyHealthProbe(down, true, now + 30_000, settleMs, HEALTH_DEFER_MS);
  assert.equal(settling.next?.phase, 'settling');
  assert.equal(settling.hold?.reason, 'PAYMENT_SERVICE_SETTLING');
  assert.equal(settling.hold?.delayMs, settleMs);
  assert.equal(settling.next?.until, now + 30_000 + settleMs);

  const still = holdBeforeCall(settling.next, now + 40_000);
  assert.equal(still?.reason, 'PAYMENT_SERVICE_SETTLING');
  assert.equal(still?.delayMs, settling.next!.until - (now + 40_000));

  const ready = holdBeforeCall(settling.next, settling.next!.until);
  assert.equal(ready, null);

  const later = applyHealthProbe(null, true, settling.next!.until + 1_000, settleMs, HEALTH_DEFER_MS);
  assert.equal(later.hold, null);
});
