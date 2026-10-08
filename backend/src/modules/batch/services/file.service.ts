import { stringify } from 'csv-stringify/sync';
import type { ParsedRow } from '../dto/types.js';
import {
  buildBatchKey,
  getSignedDownloadUrl,
  uploadBuffer,
} from '../../../infrastructure/s3/client.js';

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

  async uploadFailedReport(
    batchId: bigint,
    rows: Array<{ customerId: string; amount: string; reason: string }>,
  ): Promise<string> {
    const csv = stringify(
      rows.map((r) => ({
        customer_id: r.customerId,
        final_nach_amount: r.amount,
        failure_reason: r.reason,
      })),
      { header: true },
    );
    const key = buildBatchKey(batchId, 'failed.csv');
    await uploadBuffer(key, Buffer.from(csv, 'utf8'), 'text/csv');
    return key;
  }

  async uploadSuccessReport(
    batchId: bigint,
    rows: Array<{ customerId: string; amount: string }>,
  ): Promise<string> {
    const csv = stringify(
      rows.map((r) => ({
        customer_id: r.customerId,
        final_nach_amount: r.amount,
      })),
      { header: true },
    );
    const key = buildBatchKey(batchId, 'success.csv');
    await uploadBuffer(key, Buffer.from(csv, 'utf8'), 'text/csv');
    return key;
  }

  signedUrl(key: string) {
    return getSignedDownloadUrl(key);
  }
}

export const fileService = new FileService();
