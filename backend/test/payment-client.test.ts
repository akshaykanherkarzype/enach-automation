import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSingleCustomerPayload,
  PaymentPayloadError,
} from '../src/infrastructure/payment/payload.js';
import {
  HEALTH_DEFER_MS,
  HEALTH_PATH,
  UPI_PATHS,
  interpretPaymentHttpResponse,
  rateLimitDelayMs,
  PAYMENT_RATE_WINDOW_MS,
  interpretTransportError,
  invoiceNotReadyDelayMs,
  isHealthUp,
  needsHealthProbe,
} from '../src/infrastructure/payment/retry-policy.js';
import { HttpPaymentClient } from '../src/infrastructure/payment/http-client.js';
import { PaymentSlotBusyError } from '../src/infrastructure/payment/slot.js';

test('each UPI call is one customer object', () => {
  assert.deepEqual(buildSingleCustomerPayload('10188945', 7068), {
    customerId: 10188945,
    amount: 7068,
  });
  assert.deepEqual(buildSingleCustomerPayload('10188946', 7066.004), {
    customerId: 10188946,
    amount: 7066,
  });
  assert.throws(() => buildSingleCustomerPayload('101', 0), PaymentPayloadError);
  assert.throws(() => buildSingleCustomerPayload('  ', 10), PaymentPayloadError);
});

test('paths stay on the UPI autopay routes', () => {
  assert.equal(UPI_PATHS.generate, '/payment-service/api/v2/upi/autopay/invoice');
  assert.equal(UPI_PATHS.charge, '/payment-service/api/v2/upi/autopay/charge');
});

test('synchronous success messages are final, including an invoice that already exists', () => {
  const created = interpretPaymentHttpResponse(
    200,
    {
      status: 'success',
      message: 'AUTOPAY_INVOICE_CREATED_SUCCESSFULLY',
      retryable: false,
    },
    'generate',
  );
  assert.equal(created.success, true);
  assert.equal(created.retryable, false);
  assert.equal(created.responseCode, 'AUTOPAY_INVOICE_CREATED_SUCCESSFULLY');

  const existing = interpretPaymentHttpResponse(
    200,
    {
      status: 'success',
      message: 'AUTOPAY_INVOICE_ALREADY_CREATED',
      retryable: false,
    },
    'generate',
  );
  assert.equal(existing.success, true);
  assert.equal(existing.retryable, false);

  const charged = interpretPaymentHttpResponse(
    200,
    {
      status: 'success',
      message: 'AUTOPAY_CHARGE_CREATED_SUCCESSFULLY',
      retryable: false,
    },
    'charge',
  );
  assert.equal(charged.success, true);
  assert.equal(charged.retryable, false);

  const oldAck = interpretPaymentHttpResponse(
    200,
    { status: 'initiated', message: 'BULK_INVOICE_CREATE_INITIATED_SUCCESSFULLY', retryable: false },
    'generate',
  );
  assert.equal(oldAck.success, false);
  assert.equal(oldAck.retryable, false);
});

test('the payment-service retryable flag decides 400s, and a bare 5xx is still retried', () => {
  const permanent = interpretPaymentHttpResponse(
    400,
    {
      status: 'failed',
      message: 'NO_ACTIVE_AUTOPAY_SUBSCRIPTION_FOUND',
      retryable: false,
    },
    'generate',
  );
  assert.equal(permanent.success, false);
  assert.equal(permanent.retryable, false);
  assert.equal(permanent.responseCode, 'NO_ACTIVE_AUTOPAY_SUBSCRIPTION_FOUND');

  const noInvoice = interpretPaymentHttpResponse(
    400,
    {
      status: 'failed',
      message: 'NO_UNPAID_INVOICES_FOUND_TO_CHARGE',
      retryable: false,
    },
    'charge',
  );
  assert.equal(noInvoice.retryable, false);

  const gateway = interpretPaymentHttpResponse(
    400,
    {
      status: 'failed',
      message: 'CANNOT_CREATE_AUTOPAY_INVOICE',
      retryable: true,
    },
    'generate',
  );
  assert.equal(gateway.retryable, true);
  assert.equal(gateway.responseCode, 'CANNOT_CREATE_AUTOPAY_INVOICE');

  const proxy = interpretPaymentHttpResponse(502, 'upstream', 'charge');
  assert.equal(proxy.success, false);
  assert.equal(proxy.retryable, true);
  assert.equal(proxy.responseCode, 'HTTP_502');

  const bare400 = interpretPaymentHttpResponse(400, { message: 'nope' }, 'charge');
  assert.equal(bare400.retryable, false);
});

test('an invoice that is too young is deferred for the remaining minimum age', () => {
  const delay = invoiceNotReadyDelayMs({
    data: { invoiceAndChargeDiffHours: 35, minimumChargeHours: 36 },
  });
  assert.equal(delay, 65 * 60 * 1000);

  const waiting = interpretPaymentHttpResponse(
    400,
    {
      status: 'failed',
      message: 'INVOICE_NOT_READY_FOR_CHARGE',
      retryable: true,
      data: { invoiceAndChargeDiffHours: 10, minimumChargeHours: 36 },
    },
    'charge',
  );
  assert.equal(waiting.success, false);
  assert.equal(waiting.retryable, false);
  assert.equal(waiting.deferred, true);
  assert.equal(waiting.deferDelayMs, 26 * 3_600_000 + 5 * 60_000);
  assert.equal(waiting.responseCode, 'INVOICE_NOT_READY_FOR_CHARGE');
});

test('thrown transport errors and timeouts are retryable', () => {
  const transport = interpretTransportError(new Error('ECONNREFUSED'));
  assert.equal(transport.retryable, true);
  assert.equal(transport.responseCode, 'TRANSPORT_ERROR');

  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  assert.equal(interpretTransportError(timeout).responseCode, 'TIMEOUT');
  assert.equal(interpretTransportError(timeout).retryable, true);
});

test('http client posts one customer and honors success, retryable, and socket errors', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const client = new HttpPaymentClient({
    baseUrl: 'http://payment.test/',
    timeoutMs: 1000,
    pace: async (work) => work(),
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(
        JSON.stringify({
          status: 'success',
          message: 'AUTOPAY_INVOICE_CREATED_SUCCESSFULLY',
          retryable: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const ok = await client.execute({
    customerId: '10188945',
    amount: 7068,
    operation: 'generate',
    idempotencyKey: '9_10188945',
    batchId: '9',
    batchItemId: '1',
    traceId: 'trace-1',
  });

  assert.equal(ok.success, true);
  assert.equal(ok.retryable, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://payment.test/payment-service/api/v2/upi/autopay/invoice');
  assert.deepEqual(JSON.parse(calls[0].body), { customerId: 10188945, amount: 7068 });

  const failing = new HttpPaymentClient({
    baseUrl: 'http://payment.test',
    timeoutMs: 1000,
    pace: async (work) => work(),
    fetchFn: async (url) => {
      if (String(url).endsWith(HEALTH_PATH)) {
        return new Response(JSON.stringify({ status: 'UP', message: 'Payment Service is UP' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('upstream', { status: 502 });
    },
  });
  const failed = await failing.execute({
    customerId: '10188946',
    amount: 7066,
    operation: 'charge',
    idempotencyKey: '9_10188946',
    batchId: '9',
    batchItemId: '2',
    traceId: 'trace-2',
  });
  assert.equal(failed.success, false);
  assert.equal(failed.retryable, true);
  assert.equal(failed.deferred, undefined);
  assert.equal(failed.responseCode, 'HTTP_502');

  const permanent = new HttpPaymentClient({
    baseUrl: 'http://payment.test',
    timeoutMs: 1000,
    pace: async (work) => work(),
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          status: 'failed',
          message: 'NO_UNPAID_INVOICES_FOUND_TO_CHARGE',
          retryable: false,
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
  });
  const stopped = await permanent.execute({
    customerId: '10188946',
    amount: 7066,
    operation: 'charge',
    idempotencyKey: '9_10188946',
    batchId: '9',
    batchItemId: '6',
    traceId: 'trace-6',
  });
  assert.equal(stopped.retryable, false);
  assert.equal(stopped.responseCode, 'NO_UNPAID_INVOICES_FOUND_TO_CHARGE');

  const throwing = new HttpPaymentClient({
    baseUrl: 'http://payment.test',
    timeoutMs: 1000,
    pace: async (work) => work(),
    fetchFn: async (url) => {
      if (String(url).endsWith(HEALTH_PATH)) {
        return new Response(JSON.stringify({ status: 'UP' }), { status: 200 });
      }
      throw new Error('socket hang up');
    },
  });
  const thrown = await throwing.execute({
    customerId: '10188947',
    amount: 100,
    operation: 'charge',
    idempotencyKey: '9_10188947',
    batchId: '9',
    batchItemId: '3',
    traceId: 'trace-3',
  });
  assert.equal(thrown.retryable, true);
  assert.equal(thrown.responseCode, 'TRANSPORT_ERROR');

  const busy = new HttpPaymentClient({
    baseUrl: 'http://payment.test',
    timeoutMs: 1000,
    slotRetryDelayMs: 4000,
    pace: async () => {
      throw new PaymentSlotBusyError();
    },
    fetchFn: async () => {
      throw new Error('should not be called');
    },
  });
  const deferred = await busy.execute({
    customerId: '10188948',
    amount: 100,
    operation: 'generate',
    idempotencyKey: '9_10188948',
    batchId: '9',
    batchItemId: '4',
    traceId: 'trace-4',
  });
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.retryable, false);
  assert.equal(deferred.deferDelayMs, 4000);

  const invalid = await client.execute({
    customerId: '10188945',
    amount: -1,
    operation: 'generate',
    idempotencyKey: '9_10188945',
    batchId: '9',
    batchItemId: '5',
    traceId: 'trace-5',
  });
  assert.equal(invalid.retryable, false);
  assert.equal(invalid.responseCode, 'INVALID_PAYLOAD');
  assert.equal(calls.length, 1);
});

test('a 502 while healthCheck is down is deferred and does not use a retry', async () => {
  const calls: string[] = [];
  const client = new HttpPaymentClient({
    baseUrl: 'http://payment.test',
    timeoutMs: 1000,
    pace: async (work) => work(),
    fetchFn: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith(HEALTH_PATH)) {
        return new Response('bad gateway', { status: 502 });
      }
      return new Response('upstream', { status: 502 });
    },
  });

  const down = await client.execute({
    customerId: '10188946',
    amount: 7066,
    operation: 'charge',
    idempotencyKey: '9_10188946',
    batchId: '9',
    batchItemId: '2',
    traceId: 'trace-2',
  });

  assert.deepEqual(calls, [
    'http://payment.test/payment-service/api/v2/upi/autopay/charge',
    `http://payment.test${HEALTH_PATH}`,
  ]);
  assert.equal(down.success, false);
  assert.equal(down.retryable, false);
  assert.equal(down.deferred, true);
  assert.equal(down.deferDelayMs, HEALTH_DEFER_MS);
  assert.equal(down.statusCode, 502);
  assert.equal(down.responseCode, 'PAYMENT_SERVICE_UNAVAILABLE');
  assert.equal(down.body.cause, 'HTTP_502');

  assert.equal(needsHealthProbe(502, { message: 'upstream' }), true);
  assert.equal(needsHealthProbe(0, { message: 'socket hang up' }), true);
  assert.equal(
    needsHealthProbe(400, { message: 'CANNOT_CREATE_AUTOPAY_INVOICE', retryable: true }),
    false,
  );
  assert.equal(isHealthUp(200, { status: 'UP', message: 'Payment Service is UP' }), true);
  assert.equal(isHealthUp(200, { status: 'DOWN' }), false);
  assert.equal(needsHealthProbe(429, 'Too many requests'), false);
  assert.equal(isHealthUp(502, { status: 'UP' }), false);
});

test('a rate limit waits out the window and does not use a retry', async () => {
  const limited = interpretPaymentHttpResponse(429, 'Too many requests from this IP, please try again in an hour!', 'charge');
  assert.equal(limited.deferred, true);
  assert.equal(limited.retryable, false);
  assert.equal(limited.responseCode, 'RATE_LIMITED');
  assert.equal(limited.deferDelayMs, PAYMENT_RATE_WINDOW_MS + 2_000);

  const headers = { get: (name: string) => (name === 'retry-after' ? '30' : null) };
  assert.equal(rateLimitDelayMs(headers, 0), 32_000);

  const holds: number[] = [];
  const calls: string[] = [];
  const client = new HttpPaymentClient({
    baseUrl: 'http://payment.test',
    timeoutMs: 1000,
    pace: async (work) => work(),
    onRateLimit: (delayMs) => {
      holds.push(delayMs);
    },
    fetchFn: async (url) => {
      calls.push(String(url));
      return new Response('Too many requests from this IP, please try again in an hour!', {
        status: 429,
        headers: { 'retry-after': '45' },
      });
    },
  });

  const result = await client.execute({
    customerId: '10188949',
    amount: 100,
    operation: 'charge',
    idempotencyKey: '9_10188949',
    batchId: '9',
    batchItemId: '6',
    traceId: 'trace-6',
  });

  assert.deepEqual(calls, ['http://payment.test/payment-service/api/v2/upi/autopay/charge']);
  assert.equal(result.deferred, true);
  assert.equal(result.retryable, false);
  assert.equal(result.deferDelayMs, 47_000);
  assert.deepEqual(holds, [47_000]);
});

test('a burst of failures shares one healthCheck', async () => {
  const calls: string[] = [];
  const client = new HttpPaymentClient({
    baseUrl: 'http://payment.test',
    timeoutMs: 1000,
    pace: async (work) => work(),
    fetchFn: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith(HEALTH_PATH)) {
        return new Response(JSON.stringify({ status: 'DOWN' }), { status: 503 });
      }
      return new Response('upstream', { status: 502 });
    },
  });

  const request = {
    customerId: '10188950',
    amount: 100,
    operation: 'charge' as const,
    idempotencyKey: '9_10188950',
    batchId: '9',
    batchItemId: '7',
    traceId: 'trace-7',
  };
  await client.execute(request);
  await client.execute({ ...request, batchItemId: '8', traceId: 'trace-8' });

  assert.equal(calls.filter((url) => url.endsWith(HEALTH_PATH)).length, 1);
});
