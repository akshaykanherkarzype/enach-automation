export function buildIdempotencyKey(batchId: bigint | number | string, customerId: string): string {
  return `${batchId}_${customerId}`;
}
