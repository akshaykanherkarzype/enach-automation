import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';
import { notePaymentLatency, noteRateLimited } from './adaptive-pace.js';
import { HttpPaymentClient } from './http-client.js';
import { MockPaymentClient } from './mock-client.js';
import { pacePaymentCall } from './pacer.js';
import type { PaymentClient } from './types.js';

export type { PaymentClient, PaymentRequest, PaymentResponse, PaymentOperation } from './types.js';

export function createPaymentClient(): PaymentClient {
  if (env.PAYMENT_CLIENT === 'http') {
    logger.info(
      {
        baseUrl: env.PAYMENT_SERVICE_BASE_URL,
        gapMs: env.PAYMENT_REQUEST_GAP_MS,
        maxInFlight: env.PAYMENT_MAX_IN_FLIGHT,
        adaptive: env.paymentAdaptive,
        timeoutMs: env.API_TIMEOUT,
      },
      'Using payment-service HTTP client (one customer per UPI autopay request)',
    );
    return new HttpPaymentClient({
      baseUrl: env.PAYMENT_SERVICE_BASE_URL,
      timeoutMs: env.API_TIMEOUT,
      slotRetryDelayMs: 5_000,
      pace: pacePaymentCall,
      onLatency: (latencyMs) => {
        void notePaymentLatency(latencyMs);
      },
      onRateLimit: (delayMs) => {
        void noteRateLimited(delayMs);
      },
    });
  }
  return new MockPaymentClient();
}

export const paymentClient = createPaymentClient();
