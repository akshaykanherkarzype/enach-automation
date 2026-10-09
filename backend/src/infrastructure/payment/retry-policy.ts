import type { PaymentOperation, PaymentResponse } from './types.js';
import { istDateString, istWallClockToUtc } from '../../common/time/ist.js';

/** payment-service `responseStatuses.SUCCESS`. */
export const SUCCESS_STATUS = 'success';

/** An unpaid invoice already exists, or the gateway created one. Both are success. */
export const INVOICE_SUCCESS_MESSAGES = [
  'AUTOPAY_INVOICE_CREATED_SUCCESSFULLY',
  'AUTOPAY_INVOICE_ALREADY_CREATED',
] as const;

export const CHARGE_SUCCESS_MESSAGE = 'AUTOPAY_CHARGE_CREATED_SUCCESSFULLY';

/**
 * Charge is refused until the invoice is `MINIMUM_CHARGE_DIFF_HRS` old (default 36).
 * payment-service marks this retryable, but the short retry schedule cannot wait that long.
 */
export const INVOICE_NOT_READY_MESSAGE = 'INVOICE_NOT_READY_FOR_CHARGE';

/**
 * Charge is refused while the invoice's scheduled day is still in the future (IST).
 * payment-service marks this retryable. The short retry schedule cannot wait until that day.
 */
export const INVOICE_NOT_DUE_MESSAGE = 'INVOICE_NOT_DUE_FOR_CHARGE';

export const UPI_PATHS: Record<PaymentOperation, string> = {
  generate: '/payment-service/api/v2/upi/autopay/invoice',
  charge: '/payment-service/api/v2/upi/autopay/charge',
};

/** GET /payment-service/api/v2/healthCheck → { status: "UP" } when the process is serving. */
export const HEALTH_PATH = '/payment-service/api/v2/healthCheck';
export const HEALTH_UP_STATUS = 'UP';
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;
/** Wait before trying the customer again while payment-service is down. Does not use MAX_RETRY. */
export const HEALTH_DEFER_MS = 30_000;
/** Reuse one health result across the in-flight calls of a large batch. */
export const HEALTH_CACHE_MS = 5_000;
/** Missing or rejected x-api-key. Requeue without counting this against MAX_RETRY. */
export const API_KEY_DEFER_MS = 60_000;
const API_KEY_MESSAGES = new Set(['API_KEY_NOT_PROVIDED_IN_HEADERS', 'UNAUTHORIZED']);

/**
 * payment-service `express-rate-limit`: 25,000 requests per IP per 60 seconds
 * on `/payment-service`. Health check is registered before that limiter.
 * 8 in flight and a 125ms gap stay near 480 calls a minute, under that cap.
 */
export const PAYMENT_RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_BUFFER_MS = 2_000;

const NOT_READY_BUFFER_MS = 5 * 60 * 1000;
const NOT_READY_FALLBACK_MS = 60 * 60 * 1000;
const NOT_READY_PROBE_MS = 15 * 60 * 1000;
const NOT_READY_CAP_MS = 48 * 60 * 60 * 1000;

type Interpreted = Omit<PaymentResponse, 'latencyMs'>;

function nestedRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

/**
 * The fields worth keeping from a UPI response. Invoice success still has
 * invoiceStatus UNPAID and order status INITIALIZED. The amount is invoiceAmount.
 * created_date / updated_date arrive as database literals and are left out.
 */
export function paymentResultRecord(body: Record<string, unknown>): Record<string, unknown> {
  const data = nestedRecord(body.data);
  const record: Record<string, unknown> = {};
  if (body.status !== undefined) record.status = body.status;
  if (body.message !== undefined) record.message = body.message;
  if (body.retryable !== undefined) record.retryable = body.retryable;

  const invoiceOrder = nestedRecord(data.invoiceOrder);
  const autopayOrder = nestedRecord(data.autopayOrder);
  const order = { ...autopayOrder, ...invoiceOrder };
  const gateway = data.paymentGatewayProvider ?? order.paymentGatewayProvider;
  const customerId = data.customerId ?? order.customerId;
  if (customerId !== undefined) record.customerId = customerId;
  if (typeof gateway === 'string') record.paymentGatewayProvider = gateway;
  if (typeof order.status === 'string') record.orderStatus = order.status;

  for (const key of [
    'invoiceId',
    'orderId',
    'subscriptionRefId',
    'invoiceStatus',
    'invoiceAmount',
    'currency',
    'scheduledOn',
    'pgScheduledOn',
    'cycle',
    'initiatedOn',
  ] as const) {
    const value = order[key] ?? (key === 'scheduledOn' ? data.scheduledOn : undefined);
    if (value !== undefined && value !== null && typeof value !== 'object') record[key] = value;
  }
  return record;
}

export const INVOICE_REJECTED_REASON = 'INVOICE REJECTED';

/**
 * A rejected invoice is retryable at the gateway. Once those retries are used,
 * the stored reason should say the invoice was rejected.
 */
export function terminalFailureReason(body: Record<string, unknown>, fallback: string): string {
  const message = typeof body.message === 'string' ? body.message : '';
  const invoiceStatus = paymentResultRecord(body).invoiceStatus;
  if (
    message === 'CANNOT_CREATE_AUTOPAY_INVOICE' &&
    typeof invoiceStatus === 'string' &&
    invoiceStatus.toUpperCase() === 'REJECTED'
  ) {
    return INVOICE_REJECTED_REASON;
  }
  return fallback;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (typeof body === 'string' && body.trim()) {
    return { message: body.slice(0, 500) };
  }
  return {};
}

function successMessages(operation: PaymentOperation): readonly string[] {
  return operation === 'generate' ? INVOICE_SUCCESS_MESSAGES : [CHARGE_SUCCESS_MESSAGE];
}

/**
 * moment.diff('hours') truncates, so the remaining wait is at most
 * (minimumChargeHours - invoiceAndChargeDiffHours) hours. Round up to a minute
 * and add a short buffer so the next call is past the gateway minimum.
 */
export function invoiceNotReadyDelayMs(body: Record<string, unknown>): number {
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return NOT_READY_FALLBACK_MS;

  const fields = data as Record<string, unknown>;
  const diffHours = Number(fields.invoiceAndChargeDiffHours);
  const minimumHours = Number(fields.minimumChargeHours);
  if (!Number.isFinite(diffHours) || !Number.isFinite(minimumHours)) return NOT_READY_FALLBACK_MS;

  const remainingHours = Math.max(0, minimumHours - diffHours);
  if (remainingHours === 0) return NOT_READY_PROBE_MS;

  const delay = remainingHours * 3_600_000 + NOT_READY_BUFFER_MS;
  const capped = Math.min(NOT_READY_CAP_MS, Math.max(60_000, delay));
  return Math.ceil(capped / 60_000) * 60_000;
}

/**
 * Wait until 00:00 IST on the scheduled day, then try the charge.
 * A date with no timezone is that IST day. An instant with a timezone uses its IST date.
 */
export function invoiceNotDueDelayMs(body: Record<string, unknown>, now = new Date()): number {
  const raw = nestedRecord(body.data).scheduledOn;
  if (typeof raw !== 'string' || !raw.trim()) return NOT_READY_FALLBACK_MS;

  const dueAt = scheduledDayStart(raw.trim());
  if (!dueAt) return NOT_READY_FALLBACK_MS;

  const wait = dueAt.getTime() - now.getTime() + 60_000;
  if (wait <= 60_000) return NOT_READY_PROBE_MS;
  const capped = Math.min(NOT_READY_CAP_MS, Math.max(60_000, wait));
  return Math.ceil(capped / 60_000) * 60_000;
}

function scheduledDayStart(raw: string): Date | null {
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
  if (zoned) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return istWallClockToUtc(istDateString(parsed), 0, 0);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) return null;
  return istWallClockToUtc(match[1], 0, 0);
}

/**
 * A dropped connection, timeout, or 5xx with no `retryable` field (a 502 from the
 * proxy is the usual case) should be checked against /healthCheck before it
 * consumes a retry.
 */
export function needsHealthProbe(statusCode: number, body: unknown): boolean {
  const record = asRecord(body);
  if (typeof record.retryable === 'boolean') return false;
  if (statusCode === 0) return true;
  return statusCode >= 500 && statusCode <= 599;
}

function headerValue(headers: { get(name: string): string | null } | undefined, name: string): string {
  return headers?.get(name)?.trim() ?? '';
}

/**
 * How long to wait after HTTP 429. Uses Retry-After when payment-service sends it,
 * otherwise the limiter's 60 second window. Does not consume MAX_RETRY.
 */
export function rateLimitDelayMs(
  headers?: { get(name: string): string | null },
  now = Date.now(),
): number {
  const raw = headerValue(headers, 'retry-after') || headerValue(headers, 'ratelimit-reset');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds < 24 * 60 * 60) {
      return Math.max(1_000, Math.ceil(seconds * 1_000) + RATE_LIMIT_BUFFER_MS);
    }
    const at = Date.parse(raw);
    if (Number.isFinite(at)) {
      return Math.max(1_000, at - now + RATE_LIMIT_BUFFER_MS);
    }
  }
  return PAYMENT_RATE_WINDOW_MS + RATE_LIMIT_BUFFER_MS;
}

export function isHealthUp(statusCode: number, body: unknown): boolean {
  if (statusCode < 200 || statusCode >= 300) return false;
  const record = asRecord(body);
  return String(record.status ?? '').toUpperCase() === HEALTH_UP_STATUS;
}

/** Service is down. Requeue without counting this against MAX_RETRY. */
export function deferWhilePaymentServiceDown(previous: Interpreted): Interpreted {
  const cause = previous.responseCode || `HTTP_${previous.statusCode}`;
  return {
    success: false,
    retryable: false,
    deferred: true,
    deferDelayMs: HEALTH_DEFER_MS,
    statusCode: previous.statusCode,
    responseCode: 'PAYMENT_SERVICE_UNAVAILABLE',
    body: {
      ...previous.body,
      cause,
      message:
        'Payment-service healthCheck did not return status UP. The customer will be tried again without using a retry.',
    },
  };
}

/**
 * Success is a synchronous 2xx with status `success` and a known message.
 * `retryable` on the body is authoritative for failures.
 * A 5xx or transport error with no flag is retried only after /healthCheck is UP.
 * `INVOICE_NOT_READY_FOR_CHARGE` is deferred, not counted as a retry.
 */
export function interpretPaymentHttpResponse(
  statusCode: number,
  body: unknown,
  operation: PaymentOperation,
  headers?: { get(name: string): string | null },
): Interpreted {
  const record = asRecord(body);
  const status = String(record.status ?? '').toLowerCase();
  const message = typeof record.message === 'string' ? record.message : '';
  const flagged = typeof record.retryable === 'boolean' ? record.retryable : undefined;

  if (statusCode === 401 || API_KEY_MESSAGES.has(message)) {
    return {
      success: false,
      retryable: false,
      deferred: true,
      deferDelayMs: API_KEY_DEFER_MS,
      statusCode,
      responseCode: 'PAYMENT_API_KEY_REJECTED',
      body: record,
    };
  }

  if (statusCode === 429) {
    return {
      success: false,
      retryable: false,
      deferred: true,
      deferDelayMs: rateLimitDelayMs(headers),
      statusCode,
      responseCode: 'RATE_LIMITED',
      body: {
        ...record,
        message:
          message ||
          'Payment-service rate limit reached. The customer will be tried again without using a retry.',
      },
    };
  }

  const succeeded =
    statusCode >= 200 &&
    statusCode < 300 &&
    status === SUCCESS_STATUS &&
    successMessages(operation).includes(message) &&
    flagged !== true;

  if (succeeded) {
    return {
      success: true,
      retryable: false,
      statusCode,
      responseCode: message,
      body: record,
    };
  }

  if (message === INVOICE_NOT_READY_MESSAGE && flagged !== false) {
    return {
      success: false,
      retryable: false,
      deferred: true,
      deferDelayMs: invoiceNotReadyDelayMs(record),
      statusCode,
      responseCode: INVOICE_NOT_READY_MESSAGE,
      body: record,
    };
  }

  if (message === INVOICE_NOT_DUE_MESSAGE && flagged !== false) {
    return {
      success: false,
      retryable: false,
      deferred: true,
      deferDelayMs: invoiceNotDueDelayMs(record),
      statusCode,
      responseCode: INVOICE_NOT_DUE_MESSAGE,
      body: record,
    };
  }

  const retryable =
    flagged ??
    (statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599));

  const responseCode =
    flagged !== undefined && message
      ? message
      : retryable
        ? `HTTP_${statusCode}`
        : message || 'UNEXPECTED_RESPONSE';

  return {
    success: false,
    retryable,
    statusCode,
    responseCode,
    body: record,
  };
}

export function interpretTransportError(error: unknown): Interpreted {
  const message = error instanceof Error ? error.message : 'Payment request failed';
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return {
    success: false,
    retryable: true,
    statusCode: 0,
    responseCode: timedOut ? 'TIMEOUT' : 'TRANSPORT_ERROR',
    body: {
      message: timedOut
        ? 'Payment-service did not respond before API_TIMEOUT. The UPI call waits for the gateway, so the timeout must cover that work.'
        : message.slice(0, 500),
    },
  };
}

export function interpretSlotBusy(deferDelayMs: number): Interpreted {
  return {
    success: false,
    retryable: false,
    deferred: true,
    deferDelayMs,
    statusCode: 0,
    responseCode: 'PAYMENT_SLOT_BUSY',
    body: {
      message: 'Waiting for the payment-service call slot timed out; will try again without using a retry',
    },
  };
}
