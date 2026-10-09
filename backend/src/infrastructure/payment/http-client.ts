import { PaymentPayloadError, buildSingleCustomerPayload } from './payload.js';
import {
  HEALTH_CACHE_MS,
  HEALTH_PATH,
  HEALTH_PROBE_TIMEOUT_MS,
  UPI_PATHS,
  deferWhilePaymentServiceDown,
  interpretPaymentHttpResponse,
  interpretSlotBusy,
  interpretTransportError,
  isHealthUp,
  needsHealthProbe,
} from './retry-policy.js';
import { PaymentSlotBusyError } from './slot.js';
import type { PaymentClient, PaymentRequest, PaymentResponse } from './types.js';

export type PaceFn = <T>(work: () => Promise<T>) => Promise<T>;

export interface HttpPaymentClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  /** Serializes calls and sleeps after each one. Defaults to no extra pacing. */
  pace?: PaceFn;
  /** Delay used when the slot wait times out, so the item is deferred rather than failed. */
  slotRetryDelayMs?: number;
  /** Called with the UPI call duration so the shared pace can shed load. */
  onLatency?: (latencyMs: number) => void;
  /** Called when payment-service returns 429, so every worker slows together. */
  onRateLimit?: (delayMs: number) => void;
  /** Sent as x-api-key on the invoice and charge calls. Health check does not use it. */
  apiKey?: string;
}

/**
 * Calls the synchronous UPI autopay routes with one customer object.
 * Success is HTTP 200 with status `success`. Failures carry `retryable`.
 */
export class HttpPaymentClient implements PaymentClient {
  private readonly fetchFn: typeof fetch;
  private readonly pace: PaceFn;
  private healthCache: { until: number; up: boolean } | null = null;

  constructor(private readonly options: HttpPaymentClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.pace = options.pace ?? ((work) => work());
  }

  async execute(request: PaymentRequest): Promise<PaymentResponse> {
    const start = Date.now();
    let body: ReturnType<typeof buildSingleCustomerPayload>;
    try {
      body = buildSingleCustomerPayload(request.customerId, request.amount);
    } catch (error) {
      const message = error instanceof PaymentPayloadError ? error.message : 'Invalid payment payload';
      return {
        success: false,
        retryable: false,
        statusCode: 0,
        responseCode: 'INVALID_PAYLOAD',
        body: { message },
        latencyMs: Date.now() - start,
      };
    }

    const origin = this.options.baseUrl.replace(/\/$/, '');
    const path = UPI_PATHS[request.operation];
    const url = `${origin}${path}`;

    try {
      const result = await this.pace(async () => {
        const controllerStart = Date.now();
        try {
          const response = await this.fetchFn(url, {
            method: 'POST',
            headers: this.paymentHeaders(request.traceId, request.idempotencyKey),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });

          const rawText = await response.text();
          let parsed: unknown = {};
          if (rawText) {
            try {
              parsed = JSON.parse(rawText) as unknown;
            } catch {
              parsed = rawText;
            }
          }

          const interpreted = interpretPaymentHttpResponse(
            response.status,
            parsed,
            request.operation,
            response.headers,
          );
          if (interpreted.responseCode === 'RATE_LIMITED') {
            this.options.onRateLimit?.(interpreted.deferDelayMs ?? 0);
          }
          return { ...interpreted, latencyMs: Date.now() - controllerStart };
        } catch (error) {
          if (error instanceof PaymentSlotBusyError) throw error;
          return {
            ...interpretTransportError(error),
            latencyMs: Date.now() - controllerStart,
          };
        }
      });

      if (result.latencyMs > 0) this.options.onLatency?.(result.latencyMs);

      if (result.retryable && needsHealthProbe(result.statusCode, result.body)) {
        const up = await this.paymentServiceIsUp(origin, request.traceId);
        if (!up) {
          return {
            ...deferWhilePaymentServiceDown(result),
            latencyMs: Date.now() - start,
          };
        }
      }
      return result;
    } catch (error) {
      if (error instanceof PaymentSlotBusyError) {
        return {
          ...interpretSlotBusy(this.options.slotRetryDelayMs ?? 5_000),
          latencyMs: Date.now() - start,
        };
      }
      const transport = {
        ...interpretTransportError(error),
        latencyMs: Date.now() - start,
      };
      if (transport.latencyMs > 0) this.options.onLatency?.(transport.latencyMs);
      const up = await this.paymentServiceIsUp(origin, request.traceId);
      if (!up) {
        return {
          ...deferWhilePaymentServiceDown(transport),
          latencyMs: Date.now() - start,
        };
      }
      return transport;
    }
  }

  /** Invoice and charge require x-api-key. Health check is registered before that middleware. */
  private paymentHeaders(traceId: string, idempotencyKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-request-id': traceId,
      'x-idempotency-key': idempotencyKey,
    };
    const apiKey = this.options.apiKey?.trim();
    if (apiKey) headers['x-api-key'] = apiKey;
    return headers;
  }

  /** GET /payment-service/api/v2/healthCheck. A failed probe means the service is down. */
  private async paymentServiceIsUp(origin: string, traceId: string): Promise<boolean> {
    const now = Date.now();
    if (this.healthCache && this.healthCache.until > now) return this.healthCache.up;
    const up = await this.probeHealth(origin, traceId);
    this.healthCache = { until: now + HEALTH_CACHE_MS, up };
    return up;
  }

  private async probeHealth(origin: string, traceId: string): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${origin}${HEALTH_PATH}`, {
        method: 'GET',
        headers: { 'x-request-id': traceId },
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      const rawText = await response.text();
      let parsed: unknown = {};
      if (rawText) {
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch {
          parsed = rawText;
        }
      }
      return isHealthUp(response.status, parsed);
    } catch {
      return false;
    }
  }
}
