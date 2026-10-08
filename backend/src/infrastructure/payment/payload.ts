export class PaymentPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentPayloadError';
  }
}

export interface SingleCustomerPayment {
  customerId: number | string;
  amount: number;
}

/**
 * UPI autopay invoice and charge accept one customer object, not an array.
 */
export function buildSingleCustomerPayload(
  customerId: string,
  amount: number,
): SingleCustomerPayment {
  return {
    customerId: toPaymentCustomerId(customerId),
    amount: normalizeAmount(amount),
  };
}

export function toPaymentCustomerId(customerId: string): number | string {
  const value = customerId.trim();
  if (!value) {
    throw new PaymentPayloadError('customerId is required');
  }
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  return value;
}

export function normalizeAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaymentPayloadError('amount must be a positive number');
  }
  return Math.round(amount * 100) / 100;
}
