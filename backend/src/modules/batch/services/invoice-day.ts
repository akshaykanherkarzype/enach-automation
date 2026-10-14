import { istDateString, istWallClockToUtc } from '../../../common/time/ist.js';

export interface InvoiceDayBatch {
  module: string;
  processingDay: string | null;
  uploadedAt: Date;
}

/** Inclusive start and exclusive end of an IST calendar day, as UTC instants. */
export function istDayBounds(day: string): { start: Date; end: Date } {
  const start = istWallClockToUtc(day, 0, 0);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * Any invoice-generation batch anchored to today blocks cancelling older unpaid invoices.
 * Charge batches never block. Status does not matter: queued, running, finished, and cancelled all count.
 */
export function blocksInvoiceCancel(batch: InvoiceDayBatch, today: string): boolean {
  if (batch.module !== 'INVOICE_GENERATION') return false;
  if (batch.processingDay === today) return true;
  return istDateString(batch.uploadedAt) === today;
}

export function invoiceCancelDecision(batches: InvoiceDayBatch[], today: string) {
  const batchesToday = batches.filter((batch) => blocksInvoiceCancel(batch, today)).length;
  return { day: today, allowed: batchesToday === 0, batchesToday };
}

export function invoiceGenerationDayWhere(day: string, bounds: { start: Date; end: Date }) {
  return {
    module: 'INVOICE_GENERATION' as const,
    OR: [{ processingDay: day }, { uploadedAt: { gte: bounds.start, lt: bounds.end } }],
  };
}
