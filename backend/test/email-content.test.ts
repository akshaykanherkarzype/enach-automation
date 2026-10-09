import assert from 'node:assert/strict';
import test from 'node:test';
import { reportRecipients } from '../src/infrastructure/email/client.js';
import {
  buildCompletionMail,
  buildProgressMail,
  buildSmtpTransportOptions,
} from '../src/infrastructure/email/content.js';
import { shouldNotifyTransition } from '../src/modules/batch/services/progress-notice.service.js';

const base = {
  to: 'ops@getzype.com',
  batchId: '42',
  total: 3,
  success: 2,
  failed: 1,
  duplicates: 0,
  executionTimeMs: 65_000,
  status: 'PARTIAL_SUCCESS',
  failedCsv: Buffer.from('customer_id,final_nach_amount,failure_reason\n1,10,HTTP_502\n'),
};

test('completion mail describes the UPI result and attaches failures', () => {
  const invoice = buildCompletionMail({ ...base, module: 'INVOICE_GENERATION' });
  assert.match(invoice.subject, /PARTIAL_SUCCESS/);
  assert.match(invoice.subject, /Invoice Generation #42/);
  assert.match(invoice.text, /status success/);
  assert.match(invoice.text, /unpaid invoice already existed/);
  assert.match(invoice.html, /<!DOCTYPE html>/);
  assert.match(invoice.html, /Invoice Generation/);
  assert.match(invoice.html, /Partial success/);
  assert.match(invoice.html, /batch_42_failed\.csv/);
  assert.match(invoice.text, /every failed customer/);
  assert.match(invoice.html, />\s*2\s*</);
  assert.equal(invoice.attachments.length, 1);
  assert.equal(invoice.attachments[0].filename, 'batch_42_failed.csv');
  assert.equal(invoice.attachments[0].content.toString(), base.failedCsv.toString());
  assert.equal(invoice.attachments[0].contentType, 'text/csv');

  const charge = buildCompletionMail({
    ...base,
    module: 'INVOICE_CHARGE',
    failed: 0,
    success: 3,
    status: 'COMPLETED',
    failedCsv: undefined,
  });
  assert.match(charge.subject, /Invoice Charge #42/);
  assert.match(charge.text, /created the UPI charge/);
  assert.match(charge.text, /No failed records/);
  assert.match(charge.html, /Completed/);
  assert.match(charge.html, /No failures/);
  assert.equal(charge.attachments.length, 0);
});

test('a start notice says how many customers were queued', () => {
  const started = buildProgressMail({
    to: 'ops@getzype.com',
    module: 'INVOICE_GENERATION',
    batchId: '15',
    kind: 'started',
    total: 50000,
    success: 0,
    failed: 0,
    remaining: 50000,
    duplicates: 12,
    invalid: 3,
    filename: 'customers.csv',
  });
  assert.match(started.subject, /Started — Invoice Generation #15/);
  assert.match(started.text, /started for 50,000 customers/);
  assert.match(started.text, /Duplicates skipped: 12/);
  assert.match(started.text, /Invalid rows: 3/);
  assert.match(started.text, /File: customers.csv/);
  assert.match(started.html, /Queued/);
  assert.equal(started.attachments.length, 0);

  const traced = buildProgressMail({
    to: 'ops@getzype.com',
    module: 'INVOICE_CHARGE',
    batchId: '15',
    kind: 'payment_paused',
    total: 1000,
    success: 10,
    failed: 0,
    remaining: 990,
    cause: 'HTTP_502',
    customerId: '10188945',
    responseCode: 'HTTP_502',
    traceId: 'trace-abc',
  });
  assert.match(traced.text, /Trace ID: trace-abc/);
  assert.match(traced.text, /Customer: 10188945/);
  assert.match(traced.html, /trace-abc/);

  const finished = buildCompletionMail({
    ...base,
    module: 'INVOICE_GENERATION',
    processingDay: '2026-10-09',
    requestedBy: 'ops@getzype.com',
    failed: 8,
    failures: [
      {
        customerId: '10188945',
        responseCode: 'CANNOT_CHARGE_SUBSCRIPTION_PLAN',
        traceId: 'trace-fail-1',
        reason: 'CANNOT_CHARGE_SUBSCRIPTION_PLAN',
        status: 'FAILED',
        invoiceId: 'INV-1',
        orderId: 'ORD-1',
      },
    ],
  });
  assert.match(finished.text, /Processing day: 2026-10-09 IST/);
  assert.match(finished.text, /trace-fail-1/);
  assert.match(finished.text, /INV-1/);
  assert.match(finished.text, /ORD-1/);
  assert.match(finished.text, /every failed customer is in the attachment/);
  assert.match(finished.text, /7 more in the attachment/);
  assert.match(finished.html, /Sample failures/);
  assert.match(finished.html, /trace-fail-1/);
  assert.match(finished.html, /7 more in the attached file/);
  assert.equal(finished.html.split('trace-fail-1').length - 1, 1);
});

test('progress notices are sent once per outage or peak window and show remaining work', () => {
  assert.equal(shouldNotifyTransition(null, 'down'), true);
  assert.equal(shouldNotifyTransition('down', 'down'), false);
  assert.equal(shouldNotifyTransition('down', 'up'), true);
  assert.equal(shouldNotifyTransition(null, 'up'), false);
  assert.equal(shouldNotifyTransition('up', 'down'), true);
  assert.equal(shouldNotifyTransition(null, 'paused'), true);
  assert.equal(shouldNotifyTransition('paused', 'paused'), false);
  assert.equal(shouldNotifyTransition('paused', 'running'), true);
  assert.equal(shouldNotifyTransition(null, 'running'), false);

  const paused = buildProgressMail({
    to: 'ops@getzype.com',
    module: 'INVOICE_GENERATION',
    batchId: '42',
    kind: 'payment_paused',
    total: 1000,
    success: 400,
    failed: 10,
    remaining: 590,
    cause: 'HTTP_502',
  });
  assert.match(paused.subject, /Paused — payment-service unavailable/);
  assert.match(paused.subject, /Invoice Generation #42/);
  assert.match(paused.text, /once for this outage/);
  assert.match(paused.text, /Signal: HTTP_502/);
  assert.match(paused.text, /Remaining: 590/);
  assert.match(paused.html, /<!DOCTYPE html>/);
  assert.match(paused.html, /Service unavailable/);
  assert.match(paused.html, /not once per customer/);
  assert.equal(paused.attachments.length, 0);

  const resumed = buildProgressMail({
    to: 'ops@getzype.com',
    module: 'INVOICE_CHARGE',
    batchId: '42',
    kind: 'payment_resumed',
    total: 1000,
    success: 410,
    failed: 10,
    remaining: 580,
  });
  assert.match(resumed.subject, /Resumed — payment-service is back/);
  assert.match(resumed.text, /responding again/);

  const peak = buildProgressMail({
    to: 'ops@getzype.com',
    module: 'INVOICE_GENERATION',
    batchId: '7',
    kind: 'peak_paused',
    total: 100,
    success: 20,
    failed: 0,
    remaining: 80,
    resumesAt: '08 Oct 2026, 13:00 IST',
  });
  assert.match(peak.subject, /Paused — peak hours/);
  assert.match(peak.text, /Resumes: 08 Oct 2026, 13:00 IST/);
  assert.match(peak.html, /Remaining/);

  const afterPeak = buildProgressMail({
    to: 'ops@getzype.com',
    module: 'INVOICE_GENERATION',
    batchId: '7',
    kind: 'peak_resumed',
    total: 100,
    success: 20,
    failed: 0,
    remaining: 80,
  });
  assert.match(afterPeak.subject, /Resumed — peak hours ended/);
  assert.match(afterPeak.text, /peak window has ended/);

  const host = buildProgressMail({
    to: 'ops@getzype.com',
    module: 'INVOICE_CHARGE',
    batchId: '9',
    kind: 'host_paused',
    total: 50000,
    success: 1000,
    failed: 2,
    remaining: 48998,
    cause: 'memory 91%, cpu 92%',
  });
  assert.match(host.subject, /Paused — host under pressure/);
  assert.match(host.text, /Signal: memory 91%, cpu 92%/);
  assert.match(host.text, /not marked failed/);
});

test('completion mail skips the local admin login', () => {
  assert.deepEqual(reportRecipients('admin@zype.local', 'ops@getzype.com'), ['ops@getzype.com']);
  assert.deepEqual(reportRecipients('Admin@Zype.Local', 'ops@getzype.com'), ['ops@getzype.com']);
  assert.deepEqual(reportRecipients('uploader@getzype.com', 'ops@getzype.com'), [
    'uploader@getzype.com',
    'ops@getzype.com',
  ]);
});

test('SMTP options match the loan-service transport', () => {
  assert.deepEqual(
    buildSmtpTransportOptions({
      host: 'smtp.example.com',
      port: 587,
      user: 'mailer@getzype.com',
      pass: 'secret',
    }),
    {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'mailer@getzype.com', pass: 'secret' },
    },
  );

  assert.equal(
    buildSmtpTransportOptions({
      host: 'smtp.example.com',
      port: 465,
      user: 'mailer@getzype.com',
      pass: 'secret',
    }).secure,
    true,
  );
});
