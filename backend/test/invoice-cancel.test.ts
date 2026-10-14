import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelUnpaidRequest,
  interpretCancelUnpaid,
} from '../src/infrastructure/payment/cancel-unpaid.js';
import {
  blocksInvoiceCancel,
  invoiceCancelDecision,
  invoiceGenerationDayWhere,
  istDayBounds,
  type InvoiceDayBatch,
} from '../src/modules/batch/services/invoice-day.js';

const today = '2026-10-14';

function batch(overrides: Partial<InvoiceDayBatch> = {}): InvoiceDayBatch {
  return {
    module: 'INVOICE_GENERATION',
    processingDay: null,
    uploadedAt: new Date('2026-10-13T18:30:00.000Z'),
    ...overrides,
  };
}

test('IST day bounds for 2026-10-14 run from 18:30 UTC to the next 18:30 UTC', () => {
  const bounds = istDayBounds(today);
  assert.equal(bounds.start.toISOString(), '2026-10-13T18:30:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-10-14T18:30:00.000Z');
  assert.equal(bounds.end.getTime() - bounds.start.getTime(), 24 * 60 * 60 * 1000);
});

test('cancel is allowed only when no invoice-generation batch is anchored to today', () => {
  const statuses = ['UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
  for (const _status of statuses) {
    const started = batch({ processingDay: today, uploadedAt: new Date('2026-10-12T10:00:00.000Z') });
    assert.equal(blocksInvoiceCancel(started, today), true);
  }

  const uploadedToday = batch({
    processingDay: null,
    uploadedAt: new Date('2026-10-13T18:30:00.000Z'),
  });
  const uploadedJustBefore = batch({
    processingDay: '2026-10-13',
    uploadedAt: new Date('2026-10-13T18:29:59.000Z'),
  });
  const chargeToday = batch({
    module: 'INVOICE_CHARGE',
    processingDay: today,
    uploadedAt: new Date('2026-10-14T04:00:00.000Z'),
  });

  assert.equal(blocksInvoiceCancel(uploadedToday, today), true);
  assert.equal(blocksInvoiceCancel(uploadedJustBefore, today), false);
  assert.equal(blocksInvoiceCancel(chargeToday, today), false);

  assert.deepEqual(invoiceCancelDecision([], today), { day: today, allowed: true, batchesToday: 0 });
  assert.deepEqual(invoiceCancelDecision([chargeToday, uploadedJustBefore], today), {
    day: today,
    allowed: true,
    batchesToday: 0,
  });
  assert.deepEqual(invoiceCancelDecision([uploadedToday, chargeToday, batch({ processingDay: today })], today), {
    day: today,
    allowed: false,
    batchesToday: 2,
  });
});

test('the day query looks only at invoice generation by processing day or upload time', () => {
  const bounds = istDayBounds(today);
  assert.deepEqual(invoiceGenerationDayWhere(today, bounds), {
    module: 'INVOICE_GENERATION',
    OR: [
      { processingDay: today },
      { uploadedAt: { gte: bounds.start, lt: bounds.end } },
    ],
  });
});

test('cancel unpaid invoices posts an empty JSON array to payment-service', () => {
  const withKey = cancelUnpaidRequest('https://prod.respo.co.in/', 'secret-key');
  assert.equal(
    withKey.url,
    'https://prod.respo.co.in/payment-service/api/v2/bulk/autopay/cancelUnpaidInvoices',
  );
  assert.equal(withKey.method, 'POST');
  assert.equal(withKey.body, '[]');
  assert.equal(withKey.headers['content-type'], 'application/json');
  assert.equal(withKey.headers['x-api-key'], 'secret-key');

  const withoutKey = cancelUnpaidRequest('https://prod.respo.co.in', '  ');
  assert.equal(withoutKey.headers['x-api-key'], undefined);
  assert.equal(withoutKey.body, '[]');
});

test('a cancel response counts only when HTTP is successful and status is success', () => {
  const ok = interpretCancelUnpaid(200, {
    status: 'success',
    message: 'BULK_INVOICE_STATUS_UPDATE_SUCCESS',
    providerResponses: [{ provider: 'BILLDESK' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.message, 'BULK_INVOICE_STATUS_UPDATE_SUCCESS');

  assert.equal(interpretCancelUnpaid(200, { status: 'Success' }).ok, true);
  assert.equal(interpretCancelUnpaid(200, { status: 'failed', message: 'NO_INVOICES' }).ok, false);
  assert.equal(interpretCancelUnpaid(500, { status: 'success' }).ok, false);
  assert.equal(interpretCancelUnpaid(200, 'not-json').ok, false);
  assert.equal(interpretCancelUnpaid(200, null).ok, false);
  assert.match(interpretCancelUnpaid(502, {}).message, /did not cancel/i);
});
