import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePeakWindows } from '../src/common/time/processing-window.js';
import { planAfterResponse, planBeforeCall } from '../src/modules/batch/workers/attempt-plan.js';

const windows = parsePeakWindows('10:00-13:00,17:00-22:00');
const delays = [5_000, 30_000, 120_000];

const baseBefore = {
  anchorDay: '2026-09-30',
  enforcePeak: true,
  enforceSameDay: true,
  peakWindows: windows,
  dayEndBufferMs: 300_000,
};

test('peak hours defer the call until the window ends', () => {
  const plan = planBeforeCall({
    ...baseBefore,
    now: new Date('2026-09-30T05:00:00.000Z'), // 10:30 IST
    module: 'INVOICE_CHARGE',
  });
  assert.equal(plan.action, 'defer');
  if (plan.action === 'defer') {
    assert.equal(plan.delayMs, 150 * 60 * 1000);
    assert.equal(plan.reason, 'PEAK_HOURS');
  }
});

test('off-peak on the anchor day is allowed to call', () => {
  const plan = planBeforeCall({
    ...baseBefore,
    now: new Date('2026-09-30T07:30:00.000Z'), // 13:00 IST
    module: 'INVOICE_GENERATION',
  });
  assert.deepEqual(plan, { action: 'call' });
});

test('invoice generation refuses the next IST day before any HTTP call', () => {
  const plan = planBeforeCall({
    ...baseBefore,
    now: new Date('2026-09-30T19:00:00.000Z'), // 00:30 IST next day
    module: 'INVOICE_GENERATION',
  });
  assert.equal(plan.action, 'fail');
  if (plan.action === 'fail') assert.match(plan.reason, /INVOICE_DAY_CHANGED/);
});

test('charge may continue on the next day outside peak hours', () => {
  const plan = planBeforeCall({
    ...baseBefore,
    now: new Date('2026-09-30T19:00:00.000Z'),
    module: 'INVOICE_CHARGE',
    enforceSameDay: false,
  });
  assert.deepEqual(plan, { action: 'call' });
});

test('a retryable 4xx or 5xx is scheduled, and other responses are not', () => {
  const now = new Date('2026-09-30T08:00:00.000Z'); // 13:30 IST
  const retry = planAfterResponse({
    now,
    module: 'INVOICE_GENERATION',
    anchorDay: '2026-09-30',
    enforceSameDay: true,
    dayEndBufferMs: 300_000,
    response: {
      success: false,
      retryable: true,
      responseCode: 'HTTP_502',
      body: { message: 'bad gateway' },
    },
    retryCount: 0,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.deepEqual(retry, { action: 'retry', delayMs: 5_000, reason: 'bad gateway' });

  const permanent = planAfterResponse({
    now,
    module: 'INVOICE_GENERATION',
    anchorDay: '2026-09-30',
    enforceSameDay: true,
    dayEndBufferMs: 300_000,
    response: {
      success: false,
      retryable: false,
      responseCode: 'UNEXPECTED_RESPONSE',
      body: { message: 'not initiated' },
    },
    retryCount: 0,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.equal(permanent.action, 'fail');

  const done = planAfterResponse({
    now,
    module: 'INVOICE_CHARGE',
    anchorDay: '2026-09-30',
    enforceSameDay: false,
    dayEndBufferMs: 300_000,
    response: {
      success: true,
      retryable: false,
      responseCode: 'INITIATED',
      body: { status: 'initiated' },
    },
    retryCount: 1,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.deepEqual(done, { action: 'success' });
});

test('invoice retries that would land on the next IST day are failed instead', () => {
  const plan = planAfterResponse({
    now: new Date('2026-09-30T18:24:00.000Z'), // 23:54 IST; the 2 minute retry would pass the buffer
    module: 'INVOICE_GENERATION',
    anchorDay: '2026-09-30',
    enforceSameDay: true,
    dayEndBufferMs: 300_000,
    response: {
      success: false,
      retryable: true,
      responseCode: 'HTTP_500',
      body: { message: 'unavailable' },
    },
    retryCount: 2,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.equal(plan.action, 'fail');
  if (plan.action === 'fail') assert.match(plan.reason, /INVOICE_DAY_END_BUFFER|INVOICE_DAY_CHANGED/);
});

test('a rejected invoice is named INVOICE REJECTED only after the retries are used', () => {
  const body = {
    status: 'failed',
    message: 'CANNOT_CREATE_AUTOPAY_INVOICE',
    retryable: true,
    data: {
      invoiceOrder: { invoiceStatus: 'REJECTED', invoiceId: 'INV-REJECTED', orderId: 'ORD-1' },
    },
  };
  const again = planAfterResponse({
    now: new Date('2026-09-30T08:00:00.000Z'),
    module: 'INVOICE_GENERATION',
    anchorDay: '2026-09-30',
    enforceSameDay: true,
    dayEndBufferMs: 300_000,
    response: {
      success: false,
      retryable: true,
      responseCode: 'CANNOT_CREATE_AUTOPAY_INVOICE',
      body,
    },
    retryCount: 0,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.equal(again.action, 'retry');
  if (again.action === 'retry') assert.equal(again.reason, 'CANNOT_CREATE_AUTOPAY_INVOICE');

  const exhausted = planAfterResponse({
    now: new Date('2026-09-30T08:00:00.000Z'),
    module: 'INVOICE_GENERATION',
    anchorDay: '2026-09-30',
    enforceSameDay: true,
    dayEndBufferMs: 300_000,
    response: {
      success: false,
      retryable: true,
      responseCode: 'CANNOT_CREATE_AUTOPAY_INVOICE',
      body,
    },
    retryCount: 3,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.deepEqual(exhausted, { action: 'fail', reason: 'INVOICE REJECTED' });

  const other = planAfterResponse({
    now: new Date('2026-09-30T08:00:00.000Z'),
    module: 'INVOICE_GENERATION',
    anchorDay: '2026-09-30',
    enforceSameDay: true,
    dayEndBufferMs: 300_000,
    response: {
      success: false,
      retryable: true,
      responseCode: 'CANNOT_CREATE_AUTOPAY_INVOICE',
      body: { message: 'CANNOT_CREATE_AUTOPAY_INVOICE', retryable: true },
    },
    retryCount: 3,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.deepEqual(other, { action: 'fail', reason: 'CANNOT_CREATE_AUTOPAY_INVOICE' });
});

test('retries stop after the configured maximum', () => {
  const plan = planAfterResponse({
    now: new Date('2026-09-30T08:00:00.000Z'),
    module: 'INVOICE_CHARGE',
    anchorDay: '2026-09-30',
    enforceSameDay: false,
    dayEndBufferMs: 300_000,
    response: {
      success: false,
      retryable: true,
      responseCode: 'HTTP_400',
      body: {},
    },
    retryCount: 3,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.equal(plan.action, 'fail');
});

test('a busy payment slot is deferred without looking like a payment failure', () => {
  const plan = planAfterResponse({
    now: new Date('2026-09-30T08:00:00.000Z'),
    module: 'INVOICE_CHARGE',
    anchorDay: '2026-09-30',
    enforceSameDay: false,
    dayEndBufferMs: 300_000,
    response: {
      success: false,
      retryable: false,
      deferred: true,
      deferDelayMs: 4_000,
      responseCode: 'PAYMENT_SLOT_BUSY',
      body: {},
    },
    retryCount: 2,
    maxRetry: 3,
    retryDelaysMs: delays,
  });
  assert.deepEqual(plan, { action: 'defer', delayMs: 4_000, reason: 'PAYMENT_SLOT_BUSY' });
});
