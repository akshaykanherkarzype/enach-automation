import { stringify } from 'csv-stringify/sync';
import type { ParsedRow } from '../dto/types.js';
import {
  buildBatchKey,
  getSignedDownloadUrl,
  uploadBuffer,
} from '../../../infrastructure/s3/client.js';

export const FAILURE_EMAIL_SAMPLE = 5;

const TERMINAL_BATCH = new Set(['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED']);

export function isTerminalBatch(status: string): boolean {
  return TERMINAL_BATCH.has(status);
}

/** Saved name for a batch file: module, batch id, kind, and IST day. */
export function reportDownloadName(input: {
  module: string;
  batchId: string;
  kind: 'failed' | 'accepted' | 'processed' | 'original';
  date: string;
  extension?: string;
}): string {
  const moduleSlug = input.module === 'INVOICE_CHARGE' ? 'invoice-charge' : 'invoice-generation';
  const extension = (input.extension || 'csv').replace(/^\./, '').toLowerCase() || 'csv';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : 'undated';
  return `${moduleSlug}_batch-${input.batchId}_${input.kind}_${day}.${extension}`;
}

export interface FailedReportRow {
  customerId: string;
  amount: string;
  status: string;
  responseCode: string;
  retryCount: number;
  traceId: string;
  reason: string;
  invoiceId: string;
  orderId: string;
  invoiceStatus: string;
  subscriptionRefId: string;
  scheduledOn: string;
}

export interface StoredPaymentFields {
  invoiceId: string;
  orderId: string;
  invoiceStatus: string;
  subscriptionRefId: string;
  scheduledOn: string;
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (value == null || typeof value === 'object') return '';
  return String(value);
}

/** Fields kept on the item after a payment call. The stored body is already flat. */
export function storedPaymentFields(raw: string | null | undefined): StoredPaymentFields {
  let record: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      record = {};
    }
  }
  return {
    invoiceId: textField(record, 'invoiceId'),
    orderId: textField(record, 'orderId'),
    invoiceStatus: textField(record, 'invoiceStatus'),
    subscriptionRefId: textField(record, 'subscriptionRefId'),
    scheduledOn: textField(record, 'scheduledOn'),
  };
}

export function renderFailedCsv(rows: FailedReportRow[]): string {
  return stringify(
    rows.map((row) => ({
      customer_id: row.customerId,
      final_nach_amount: row.amount,
      status: row.status,
      response_code: row.responseCode,
      failure_reason: row.reason,
      invoice_id: row.invoiceId,
      order_id: row.orderId,
      invoice_status: row.invoiceStatus,
      subscription_ref_id: row.subscriptionRefId,
      scheduled_on: row.scheduledOn,
      retry_count: row.retryCount,
      trace_id: row.traceId,
    })),
    { header: true },
  );
}

export class FileService {
  async uploadOriginal(
    batchId: bigint,
    buffer: Buffer,
    filename: string,
    contentType: string,
  ): Promise<string> {
    const ext = filename.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
    const key = buildBatchKey(batchId, `original.${ext}`);
    await uploadBuffer(key, buffer, contentType);
    return key;
  }

  async uploadProcessed(batchId: bigint, rows: ParsedRow[]): Promise<string> {
    const csv = stringify(
      rows.map((r) => ({ customer_id: r.customerId, final_nach_amount: r.amount })),
      { header: true },
    );
    const key = buildBatchKey(batchId, 'processed.csv');
    await uploadBuffer(key, Buffer.from(csv, 'utf8'), 'text/csv');
    return key;
  }

  async uploadFailedReport(batchId: bigint, rows: FailedReportRow[]): Promise<string> {
    const key = buildBatchKey(batchId, 'failed.csv');
    await uploadBuffer(key, Buffer.from(renderFailedCsv(rows), 'utf8'), 'text/csv');
    return key;
  }

  async uploadSuccessReport(
    batchId: bigint,
    rows: Array<{ customerId: string; amount: string; traceId: string }>,
  ): Promise<string> {
    const csv = stringify(
      rows.map((r) => ({
        customer_id: r.customerId,
        final_nach_amount: r.amount,
        trace_id: r.traceId,
      })),
      { header: true },
    );
    const key = buildBatchKey(batchId, 'success.csv');
    await uploadBuffer(key, Buffer.from(csv, 'utf8'), 'text/csv');
    return key;
  }

  signedUrl(key: string, filename?: string) {
    return getSignedDownloadUrl(key, filename);
  }
}

export const fileService = new FileService();
