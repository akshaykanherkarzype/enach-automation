export type PaymentOperation = 'generate' | 'charge';

export interface PaymentRequest {
  customerId: string;
  amount: number;
  operation: PaymentOperation;
  idempotencyKey: string;
  batchId: string;
  batchItemId: string;
  traceId: string;
}

export interface PaymentResponse {
  success: boolean;
  /**
   * True when payment-service set `retryable: true`, or the call never got a body
   * (transport error, timeout, 5xx, 429). Permanent 400s are false.
   */
  retryable: boolean;
  /**
   * True when the call was not made (slot wait). Requeue without consuming a retry.
   */
  deferred?: boolean;
  deferDelayMs?: number;
  statusCode: number;
  responseCode: string;
  body: Record<string, unknown>;
  latencyMs: number;
}

export interface PaymentClient {
  execute(request: PaymentRequest): Promise<PaymentResponse>;
}
