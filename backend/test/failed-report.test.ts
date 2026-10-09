import assert from 'node:assert/strict';
import test from 'node:test';
import { contentDisposition } from '../src/infrastructure/s3/client.js';
import { invalidCountFromRemarks } from '../src/modules/batch/services/batch.service.js';
import { renderFailedCsv, reportDownloadName, storedPaymentFields } from '../src/modules/batch/services/file.service.js';

test('a failed report keeps status, the reason, and the payment ids', () => {
  const csv = renderFailedCsv([
    {
      customerId: '8840034',
      amount: '7312.00',
      status: 'FAILED',
      responseCode: 'CANNOT_CREATE_AUTOPAY_INVOICE',
      retryCount: 3,
      traceId: 'trace-1',
      reason: 'INVOICE REJECTED',
      invoiceId: 'INV-REJECTED',
      orderId: 'ORD-1',
      invoiceStatus: 'REJECTED',
      subscriptionRefId: 'SUB-1',
      scheduledOn: '2026-10-11 00:00:00',
    },
  ]);
  assert.match(csv, /customer_id,final_nach_amount,status,response_code,failure_reason,invoice_id,order_id/);
  assert.match(csv, /8840034,7312\.00,FAILED,CANNOT_CREATE_AUTOPAY_INVOICE,INVOICE REJECTED,INV-REJECTED,ORD-1,REJECTED/);
  assert.match(csv, /trace-1/);
});

test('stored payment fields are read back from the item body', () => {
  const fields = storedPaymentFields(
    JSON.stringify({
      message: 'CANNOT_CHARGE_SUBSCRIPTION_PLAN',
      invoiceId: 'INV-CHARGE',
      orderId: 'ORD-CHARGE',
      invoiceStatus: 'UNPAID',
      subscriptionRefId: 'SUB-9',
      scheduledOn: '2026-10-11 00:00:00',
    }),
  );
  assert.equal(fields.invoiceId, 'INV-CHARGE');
  assert.equal(fields.orderId, 'ORD-CHARGE');
  assert.equal(fields.invoiceStatus, 'UNPAID');
  assert.equal(storedPaymentFields('not-json').orderId, '');
  assert.equal(storedPaymentFields(null).invoiceId, '');
});

test('a failed download is named with the module, batch, and day', () => {
  assert.equal(
    reportDownloadName({
      module: 'INVOICE_GENERATION',
      batchId: '14',
      kind: 'failed',
      date: '2026-10-09',
    }),
    'invoice-generation_batch-14_failed_2026-10-09.csv',
  );
  assert.equal(
    reportDownloadName({
      module: 'INVOICE_CHARGE',
      batchId: '15',
      kind: 'failed',
      date: 'not-a-date',
    }),
    'invoice-charge_batch-15_failed_undated.csv',
  );
  assert.equal(
    contentDisposition('invoice-generation_batch-14_failed_2026-10-09.csv'),
    'attachment; filename="invoice-generation_batch-14_failed_2026-10-09.csv"',
  );
});

test('invalid rows are recovered from the batch remarks', () => {
  assert.equal(invalidCountFromRemarks('invalid=4; duplicates=2;lockToken=abc'), 4);
  assert.equal(invalidCountFromRemarks(null), 0);
});
