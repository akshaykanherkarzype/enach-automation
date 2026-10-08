import { env } from '../../common/config/env.js';
import { sleep } from '../../common/utils/parse-size.js';
import type { PaymentClient, PaymentRequest, PaymentResponse } from './types.js';

export class MockPaymentClient implements PaymentClient {
  async execute(request: PaymentRequest): Promise<PaymentResponse> {
    const start = Date.now();
    await sleep(env.MOCK_PAYMENT_LATENCY_MS);

    const success = Math.random() < env.MOCK_PAYMENT_SUCCESS_RATE;
    const latencyMs = Date.now() - start;

    if (success) {
      return {
        success: true,
        retryable: false,
        statusCode: 200,
        responseCode: 'SUCCESS',
        body: {
          status: 'success',
          message:
            request.operation === 'generate'
              ? 'AUTOPAY_INVOICE_CREATED_SUCCESSFULLY'
              : 'AUTOPAY_CHARGE_CREATED_SUCCESSFULLY',
          customerId: request.customerId,
          amount: request.amount,
          idempotencyKey: request.idempotencyKey,
          mock: true,
        },
        latencyMs,
      };
    }

    return {
      success: false,
      retryable: true,
      statusCode: 422,
      responseCode: 'MOCK_FAILURE',
      body: {
        status: 'failed',
        message: 'MOCK_PAYMENT_REJECTED',
        customerId: request.customerId,
        amount: request.amount,
        mock: true,
      },
      latencyMs,
    };
  }
}
