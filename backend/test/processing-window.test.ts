import assert from 'node:assert/strict';
import test from 'node:test';
import {
  invoiceBatchFitsToday,
  invoiceCallGate,
  parsePeakWindows,
  peakDeferDelayMs,
  remainingCallableMs,
} from '../src/common/time/processing-window.js';

const windows = parsePeakWindows('10:00-13:00,17:00-22:00');

test('parses the default peak windows and rejects overnight windows', () => {
  assert.deepEqual(windows, [
    { startMinute: 10 * 60, endMinute: 13 * 60 },
    { startMinute: 17 * 60, endMinute: 22 * 60 },
  ]);
  assert.deepEqual(parsePeakWindows('none'), []);
  assert.throws(() => parsePeakWindows('22:00-02:00'), /same IST day/);
});

test('defers only inside 10:00-13:00 and 17:00-22:00 IST', () => {
  const at = (iso: string) => peakDeferDelayMs(new Date(iso), windows);

  assert.equal(at('2026-09-30T04:29:59.000Z'), 0); // 09:59:59 IST
  assert.equal(at('2026-09-30T04:30:00.000Z'), 3 * 60 * 60 * 1000); // 10:00 IST → 13:00
  assert.equal(at('2026-09-30T05:00:00.000Z'), 150 * 60 * 1000); // 10:30 IST → 13:00
  assert.equal(at('2026-09-30T07:29:30.000Z'), 30_000); // 12:59:30 IST → 13:00
  assert.equal(at('2026-09-30T07:30:00.000Z'), 0); // 13:00 IST
  assert.equal(at('2026-09-30T11:29:59.000Z'), 0); // 16:59:59 IST
  assert.equal(at('2026-09-30T11:30:00.000Z'), 5 * 60 * 60 * 1000); // 17:00 IST → 22:00
  assert.equal(at('2026-09-30T16:30:00.000Z'), 0); // 22:00 IST
});

test('invoice calls are refused on the next IST day and inside the midnight buffer', () => {
  const changed = invoiceCallGate(new Date('2026-09-30T19:00:00.000Z'), '2026-09-30', 300_000);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.match(changed.reason, /INVOICE_DAY_CHANGED/);

  const buffered = invoiceCallGate(new Date('2026-09-30T18:26:00.000Z'), '2026-09-30', 300_000);
  assert.equal(buffered.ok, false);
  if (!buffered.ok) assert.match(buffered.reason, /INVOICE_DAY_END_BUFFER/);

  const allowed = invoiceCallGate(new Date('2026-09-30T18:24:00.000Z'), '2026-09-30', 300_000);
  assert.equal(allowed.ok, true);
});

test('remaining callable time skips peak windows and the midnight buffer', () => {
  const now = new Date('2026-09-30T03:30:00.000Z'); // 09:00 IST
  const remaining = remainingCallableMs(now, windows, 300_000);
  // 09:00-10:00 + 13:00-17:00 + 22:00-23:55
  assert.equal(remaining, 3_600_000 + 14_400_000 + 6_900_000);
});

test('an invoice batch that cannot finish today is rejected by the fit check', () => {
  const now = new Date('2026-09-30T03:30:00.000Z');
  const small = invoiceBatchFitsToday({
    recordCount: 10,
    now,
    windows,
    dayEndBufferMs: 300_000,
    gapMs: 3000,
    callBudgetMs: 2000,
    maxInFlight: 1,
  });
  assert.equal(small.ok, true);
  assert.equal(small.perCallMs, 3000);
  assert.equal(small.capacity, Math.floor(24_900_000 / 3000));

  const huge = invoiceBatchFitsToday({
    recordCount: small.capacity + 1,
    now,
    windows,
    dayEndBufferMs: 300_000,
    gapMs: 3000,
    callBudgetMs: 2000,
    maxInFlight: 1,
  });
  assert.equal(huge.ok, false);

  const tooLate = invoiceBatchFitsToday({
    recordCount: 1,
    now: new Date('2026-09-30T18:26:00.000Z'), // 23:56 IST
    windows,
    dayEndBufferMs: 300_000,
    gapMs: 3000,
    callBudgetMs: 2000,
    maxInFlight: 1,
  });
  assert.equal(tooLate.remainingMs, 0);
  assert.equal(tooLate.ok, false);
});

test('60k customers fit before the IST day ends at 8 in flight and a 125ms gap', () => {
  const fit = invoiceBatchFitsToday({
    recordCount: 60_000,
    now: new Date('2026-09-30T03:30:00.000Z'), // 09:00 IST
    windows,
    dayEndBufferMs: 300_000,
    gapMs: 125,
    callBudgetMs: 2500,
    maxInFlight: 8,
  });
  // Slower of the 125ms gap and ceil(2500 / 8) = 313ms.
  assert.equal(fit.perCallMs, 313);
  assert.equal(fit.neededMs, 60_000 * 313);
  assert.equal(fit.ok, true);
  assert.ok(fit.neededMs < fit.remainingMs);
});
