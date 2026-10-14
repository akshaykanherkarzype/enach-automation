import { randomUUID } from 'node:crypto';
import { AppError, ConflictError } from '../../../common/exceptions/app-error.js';
import { istDateString } from '../../../common/time/ist.js';
import { acquireLock, releaseLock } from '../../../infrastructure/redis/client.js';
import { postCancelUnpaid } from '../../../infrastructure/payment/cancel-unpaid.js';
import { batchRepository } from '../repositories/batch.repository.js';
import { invoiceCancelDecision, istDayBounds } from './invoice-day.js';

const CANCEL_LOCK = 'lock:invoice:cancel-unpaid';

export async function invoiceCancelEligibility(now = new Date()) {
  const today = istDateString(now);
  const batches = await batchRepository.invoiceGenerationOnDay(today, istDayBounds(today));
  return invoiceCancelDecision(batches, today);
}

export async function cancelOldUnpaidInvoices(actor: string, now = new Date()) {
  const today = istDateString(now);
  const token = randomUUID();
  const locked = await acquireLock(CANCEL_LOCK, 180, token);
  if (!locked) {
    throw new ConflictError('Old unpaid invoices are already being cancelled.');
  }
  try {
    const batches = await batchRepository.invoiceGenerationOnDay(today, istDayBounds(today));
    const decision = invoiceCancelDecision(batches, today);
    if (!decision.allowed) {
      throw new ConflictError(
        `Invoice generation already has ${decision.batchesToday} batch(es) for ${today}. Old invoices stay as they are.`,
      );
    }
    const result = await postCancelUnpaid();
    if (!result.ok) {
      throw new AppError(502, result.message, 'INVOICE_CANCEL_FAILED', result.body);
    }
    await batchRepository.createAudit({
      action: 'CANCEL_OLD_UNPAID_INVOICES',
      entityType: 'invoice',
      entityId: today,
      actor,
      details: JSON.stringify({ message: result.message }),
    });
    return { day: today, message: result.message, providerResponses: result.body.providerResponses ?? [] };
  } finally {
    await releaseLock(CANCEL_LOCK, token);
  }
}
