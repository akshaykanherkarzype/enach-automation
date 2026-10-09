import { randomUUID } from 'node:crypto';
import type { BatchModule, BatchStatus, ItemStatus } from '@prisma/client';
import { env } from '../../../common/config/env.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../common/exceptions/app-error.js';
import { logger } from '../../../common/logger/logger.js';
import { buildIdempotencyKey } from '../../../common/utils/idempotency.js';
import { serializeBigInt } from '../../../common/utils/parse-size.js';
import { istDateString } from '../../../common/time/ist.js';
import { emailClient } from '../../../infrastructure/email/client.js';
import {
  dlqForModule,
  publishBatch,
  publishToQueue,
  queueForModule,
  retryQueueForModule,
} from '../../../infrastructure/rabbitmq/client.js';
import { prisma } from '../../../infrastructure/mysql/prisma.js';
import { queuePublishCounter } from '../../../plugins/metrics.js';
import type { ConfirmUploadInput, DownloadType, ValidationResult } from '../dto/types.js';
import { scheduleBatchChanged } from '../../../infrastructure/realtime/batch-events.js';
import { batchRepository } from '../repositories/batch.repository.js';
import {
  FAILURE_EMAIL_SAMPLE,
  fileService,
  isTerminalBatch,
  renderFailedCsv,
  reportDownloadName,
  storedPaymentFields,
  type FailedReportRow,
} from './file.service.js';
import { lockService } from './lock.service.js';

// In-memory validation cache keyed by uploadToken (TTL handled lightly)
const validationCache = new Map<
  string,
  { result: ValidationResult; module: BatchModule; uploadedBy: string; expiresAt: number }
>();

const CACHE_TTL_MS = 30 * 60 * 1000;
const PUBLISH_PAGE = 1_000;

function moduleLabel(module: BatchModule): string {
  return module === 'INVOICE_GENERATION' ? 'Invoice generation' : 'Invoice charge';
}

export function invalidCountFromRemarks(remarks: string | null | undefined): number {
  const match = /(?:^|;)\s*invalid=(\d+)/.exec(remarks ?? '');
  return match ? Number(match[1]) : 0;
}

function purgeExpiredCache(): void {
  const now = Date.now();
  for (const [k, v] of validationCache) {
    if (v.expiresAt < now) validationCache.delete(k);
  }
}

export class BatchService {
  async assertNoOpenBatch(module: BatchModule): Promise<void> {
    const open = await batchRepository.findOpenBatch(module);
    if (!open) return;
    throw new ConflictError(
      `${moduleLabel(module)} already has batch #${open.id} in progress. Wait until it finishes before uploading another file.`,
    );
  }

  storeValidation(
    module: BatchModule,
    uploadedBy: string,
    result: ValidationResult,
  ): { uploadToken: string; summary: Record<string, unknown> } {
    purgeExpiredCache();
    const uploadToken = randomUUID();
    validationCache.set(uploadToken, {
      result,
      module,
      uploadedBy,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return {
      uploadToken,
      summary: {
        totalRecords: result.totalRecords,
        validRecords: result.validRecords,
        duplicateCount: result.duplicateCount,
        invalidCount: result.invalidCount,
        duplicates: result.duplicates.slice(0, 100),
        invalidRows: result.invalidRows.slice(0, 100),
        originalFilename: result.originalFilename,
      },
    };
  }

  async confirmUpload(uploadToken: string): Promise<unknown> {
    const cached = validationCache.get(uploadToken);
    if (!cached || cached.expiresAt < Date.now()) {
      throw new ValidationError('Upload token expired or invalid. Please re-upload the file.');
    }

    const { result, module, uploadedBy } = cached;
    if (!result.validRows.length) {
      throw new ValidationError('No valid records to process');
    }

    await this.assertNoOpenBatch(module);
    const lockToken = await lockService.acquireModuleLock(module);

    try {
      await this.assertNoOpenBatch(module);
      const batch = await batchRepository.create({
        module,
        status: 'UPLOADED',
        uploadedBy,
        totalRecords: result.validRows.length,
        duplicateCount: result.duplicateCount,
        remarks: `invalid=${result.invalidCount}; duplicates=${result.duplicateCount}`,
      });

      await batchRepository.update(batch.id, { status: 'VALIDATING' });

      const originalKey = await fileService.uploadOriginal(
        batch.id,
        result.originalBuffer,
        result.originalFilename,
        result.contentType,
      );
      const processedKey = await fileService.uploadProcessed(batch.id, result.validRows);

      await batchRepository.update(batch.id, {
        status: 'READY',
        originalFile: originalKey,
        processedFile: processedKey,
      });

      const itemData = result.validRows.map((row) => ({
        batchId: batch.id,
        customerId: row.customerId,
        amount: row.amount,
        status: 'PENDING' as ItemStatus,
        idempotencyKey: buildIdempotencyKey(batch.id, row.customerId),
      }));

      // Chunk inserts for large files
      const chunkSize = env.BATCH_SIZE;
      for (let i = 0; i < itemData.length; i += chunkSize) {
        await batchRepository.createItems(itemData.slice(i, i + chunkSize));
      }

      const queue = queueForModule(module);
      const startedAt = new Date();
      const queued = result.validRows.length;
      await batchRepository.update(batch.id, {
        status: 'QUEUED',
        startedAt,
        processingDay: istDateString(startedAt),
        processingCount: queued,
      });

      await batchRepository.update(batch.id, { status: 'PROCESSING' });

      await batchRepository.createAudit({
        action: 'UPLOAD_CONFIRM',
        entityType: 'batch_execution',
        entityId: String(batch.id),
        actor: uploadedBy,
        details: JSON.stringify({ module, total: queued, lockToken }),
      });

      await batchRepository.update(batch.id, {
        remarks: `${batch.remarks || ''};lockToken=${lockToken}`,
      });

      validationCache.delete(uploadToken);

      // Send this before the queue publish. The worker can defer the first
      // customer for peak hours as soon as a message is visible.
      await this.sendStartedNotice({
        to: uploadedBy,
        module,
        batchId: String(batch.id),
        queued,
        duplicates: result.duplicateCount,
        invalid: result.invalidCount,
        filename: result.originalFilename,
        processingDay: istDateString(startedAt),
        queue,
      });

      await this.publishItems(queue, batch.id);

      const fresh = await batchRepository.findById(batch.id);
      scheduleBatchChanged(batch.id, true);
      return serializeBigInt(fresh);
    } catch (err) {
      await lockService.releaseModuleLock(module, lockToken);
      throw err;
    }
  }

  async list(params: {
    module?: BatchModule;
    status?: BatchStatus;
    page?: number;
    pageSize?: number;
  }) {
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 20, 100);
    const [items, total] = await batchRepository.list({
      module: params.module,
      status: params.status,
      page,
      pageSize,
    });
    const openBatch = params.module ? await batchRepository.findOpenBatch(params.module) : null;
    return serializeBigInt({ items, total, page, pageSize, openBatch });
  }

  async getById(id: bigint) {
    const batch = await batchRepository.findById(id);
    if (!batch) throw new NotFoundError('Batch not found');

    const counts = await batchRepository.recount(id);
    const done = counts.successCount + counts.failedCount;
    const progress = batch.totalRecords
      ? Math.round((done / batch.totalRecords) * 100)
      : 0;

    const startedAt = batch.startedAt?.getTime();
    const elapsedMs = startedAt ? Date.now() - startedAt : 0;
    const recordsPerMin =
      elapsedMs > 0 ? Math.round((done / elapsedMs) * 60_000) : 0;
    const remaining = Math.max(batch.totalRecords - done, 0);
    const etaMs =
      recordsPerMin > 0 ? Math.round((remaining / recordsPerMin) * 60_000) : null;

    const invalidCount = invalidCountFromRemarks(batch.remarks);
    return serializeBigInt({
      ...batch,
      ...counts,
      progress,
      remaining,
      recordsPerMin,
      etaMs,
      invalidCount,
      fileRecords: batch.totalRecords + batch.duplicateCount + invalidCount,
      durationMs: batch.completedAt && batch.startedAt
        ? batch.completedAt.getTime() - batch.startedAt.getTime()
        : elapsedMs,
      workersRunning: counts.processingCount,
    });
  }

  async getItems(
    id: bigint,
    opts: { status?: ItemStatus; page?: number; pageSize?: number },
  ) {
    const batch = await batchRepository.findById(id);
    if (!batch) throw new NotFoundError('Batch not found');
    const page = opts.page ?? 1;
    const pageSize = Math.min(opts.pageSize ?? 50, 200);
    const [items, total] = await batchRepository.findItemsByBatch(id, {
      status: opts.status,
      page,
      pageSize,
    });
    return serializeBigInt({ items, total, page, pageSize });
  }

  async getLogs(id: bigint, page = 1, pageSize = 50) {
    const batch = await batchRepository.findById(id);
    if (!batch) throw new NotFoundError('Batch not found');
    const [logs, total] = await batchRepository.listLogs(
      id,
      page,
      Math.min(pageSize, 200),
    );
    return serializeBigInt({ logs, total, page, pageSize });
  }

  async retryFailed(id: bigint, actor: string) {
    const batch = await batchRepository.findById(id);
    if (!batch) throw new NotFoundError('Batch not found');
    if (!['FAILED', 'PARTIAL_SUCCESS'].includes(batch.status)) {
      throw new ValidationError('Failed customers can be retried after the batch has finished.');
    }

    await this.assertNoOpenBatch(batch.module);
    const lockToken = await lockService.acquireModuleLock(batch.module);
    let started = false;
    try {
      await this.assertNoOpenBatch(batch.module);
      const first = await batchRepository.scanItemIds(id, 'FAILED', null, 1);
      if (!first.length) {
        throw new ValidationError('No failed records to retry');
      }

      await batchRepository.update(id, {
        status: 'PROCESSING',
        completedAt: null,
        remarks: `${batch.remarks || ''};lockToken=${lockToken}`,
      });
      started = true;
      scheduleBatchChanged(id, true);

      const queue = queueForModule(batch.module);
      let afterId: bigint | null = null;
      let count = 0;
      for (;;) {
        const rows = await batchRepository.scanItemIds(id, 'FAILED', afterId, PUBLISH_PAGE);
        if (!rows.length) break;
        const ids = rows.map((row) => row.id);
        await prisma.batchExecutionItem.updateMany({
          where: { id: { in: ids }, status: 'FAILED' },
          data: { status: 'PENDING', failureReason: null },
        });
        await publishBatch(queue, ids);
        count += ids.length;
        afterId = ids[ids.length - 1];
      }
      queuePublishCounter.inc({ queue }, count);

      await batchRepository.createAudit({
        action: 'RETRY_FAILED',
        entityType: 'batch_execution',
        entityId: String(id),
        actor,
        details: JSON.stringify({ count }),
      });

      return this.getById(id);
    } catch (err) {
      if (!started) await lockService.releaseModuleLock(batch.module, lockToken);
      throw err;
    }
  }

  async retryDlq(id: bigint, actor: string) {
    // Re-queue failed items (same as retry-failed for practical purposes;
    // DLQ messages are also re-published from failed items).
    const batch = await batchRepository.findById(id);
    if (!batch) throw new NotFoundError('Batch not found');

    const result = await this.retryFailed(id, actor);

    await batchRepository.createAudit({
      action: 'RETRY_DLQ',
      entityType: 'batch_execution',
      entityId: String(id),
      actor,
      details: JSON.stringify({ dlq: dlqForModule(batch.module) }),
    });

    return result;
  }

  async cancel(id: bigint, actor: string) {
    const batch = await batchRepository.findById(id);
    if (!batch) throw new NotFoundError('Batch not found');

    if (['COMPLETED', 'PARTIAL_SUCCESS', 'CANCELLED'].includes(batch.status)) {
      throw new ValidationError(`Cannot cancel batch in status ${batch.status}`);
    }

    await prisma.batchExecutionItem.updateMany({
      where: { batchId: id, status: { in: ['PENDING', 'RETRYING'] } },
      data: { status: 'FAILED', failureReason: 'Batch cancelled' },
    });

    await batchRepository.update(id, {
      status: 'CANCELLED',
      completedAt: new Date(),
    });
    scheduleBatchChanged(id, true);

    await this.releaseLockIfPresent(batch);

    await batchRepository.createAudit({
      action: 'CANCEL',
      entityType: 'batch_execution',
      entityId: String(id),
      actor,
    });

    return this.getById(id);
  }

  async download(id: bigint, type: DownloadType) {
    const batch = await batchRepository.findById(id);
    if (!batch) throw new NotFoundError('Batch not found');

    let key: string | null | undefined;
    switch (type) {
      case 'original':
        key = batch.originalFile;
        break;
      case 'processed':
        key = batch.processedFile;
        break;
      case 'failed':
        key = batch.failureReport;
        if (!key || !isTerminalBatch(batch.status)) {
          key = await fileService.uploadFailedReport(id, await this.failureRows(id));
          await batchRepository.update(id, { failureReport: key });
        }
        break;
      case 'success':
        key = batch.successReport;
        if (!key) {
          const success = await this.collectItems(id, 'SUCCESS');
          const traces = await batchRepository.latestTraceByItem(id);
          key = await fileService.uploadSuccessReport(
            id,
            success.map((row) => ({
              customerId: row.customerId,
              amount: row.amount.toString(),
              traceId: traces.get(String(row.id)) ?? '',
            })),
          );
          await batchRepository.update(id, { successReport: key });
        }
        break;
      default:
        throw new ValidationError('Invalid download type');
    }

    if (!key) throw new NotFoundError('File not available');
    const filename = reportDownloadName({
      module: batch.module,
      batchId: String(id),
      kind: type === 'success' ? 'accepted' : type === 'failed' ? 'failed' : type,
      date: batch.processingDay || istDateString(batch.completedAt ?? batch.uploadedAt),
      extension: type === 'original' ? key.split('.').pop() : 'csv',
    });
    const url = await fileService.signedUrl(key, filename);
    return { url, key, filename };
  }

  async finalizeIfComplete(batchId: bigint): Promise<boolean> {
    const batch = await batchRepository.findById(batchId);
    if (!batch || batch.status === 'CANCELLED') return false;

    const counts = await batchRepository.recount(batchId);
    const done = counts.successCount + counts.failedCount;

    await batchRepository.update(batchId, {
      successCount: counts.successCount,
      failedCount: counts.failedCount,
      processingCount: counts.processingCount,
    });

    if (done < batch.totalRecords) return false;

    let status: BatchStatus = 'COMPLETED';
    if (counts.failedCount > 0 && counts.successCount > 0) status = 'PARTIAL_SUCCESS';
    else if (counts.failedCount > 0 && counts.successCount === 0) status = 'FAILED';

    const failed = await this.failureRows(batchId);
    const failureKey = await fileService.uploadFailedReport(batchId, failed);

    const completedAt = new Date();
    await batchRepository.update(batchId, {
      status,
      completedAt,
      failureReport: failureKey,
      successCount: counts.successCount,
      failedCount: counts.failedCount,
      processingCount: 0,
    });

    await this.releaseLockIfPresent(batch);

    const executionTimeMs =
      batch.startedAt ? completedAt.getTime() - batch.startedAt.getTime() : 0;
    const sample = failed.slice(0, FAILURE_EMAIL_SAMPLE);
    const failedCsv = Buffer.from(renderFailedCsv(failed), 'utf8');

    const emailPayload = {
      to: batch.uploadedBy,
      module: batch.module,
      batchId: String(batchId),
      total: batch.totalRecords,
      success: counts.successCount,
      failed: counts.failedCount,
      duplicates: batch.duplicateCount,
      executionTimeMs,
      failedCsv: failed.length ? failedCsv : undefined,
      status,
      processingDay: batch.processingDay ?? undefined,
      requestedBy: batch.uploadedBy,
      failures: sample.map((row) => ({
        customerId: row.customerId,
        responseCode: row.responseCode,
        traceId: row.traceId,
        reason: row.reason,
        status: row.status,
        invoiceId: row.invoiceId,
        orderId: row.orderId,
      })),
    };

    try {
      await emailClient.sendBatchCompletion(emailPayload);
    } catch (err) {
      // Do not fail batch finalization if email delivery fails.
      logger.error({ err, batchId: String(batchId) }, 'Failed to send batch email report');
    }
    return true;
  }

  private async failureRows(batchId: bigint): Promise<FailedReportRow[]> {
    const failed = await this.collectItems(batchId, 'FAILED', true);
    const traces = failed.length ? await batchRepository.latestTraceByItem(batchId) : new Map<string, string>();
    return failed.map((row) => {
      const stored = storedPaymentFields('responseBody' in row ? row.responseBody : null);
      return {
        customerId: row.customerId,
        amount: row.amount.toString(),
        status: 'FAILED',
        responseCode: row.responseCode || '',
        retryCount: row.retryCount,
        traceId: traces.get(String(row.id)) ?? '',
        reason: row.failureReason || 'Unknown',
        invoiceId: stored.invoiceId,
        orderId: stored.orderId,
        invoiceStatus: stored.invoiceStatus,
        subscriptionRefId: stored.subscriptionRefId,
        scheduledOn: stored.scheduledOn,
      };
    });
  }

  private async sendStartedNotice(input: {
    to: string;
    module: BatchModule;
    batchId: string;
    queued: number;
    duplicates: number;
    invalid: number;
    filename: string;
    processingDay: string;
    queue: string;
  }): Promise<void> {
    try {
      await emailClient.sendBatchProgress({
        to: input.to,
        module: input.module,
        batchId: input.batchId,
        kind: 'started',
        total: input.queued,
        success: 0,
        failed: 0,
        remaining: input.queued,
        duplicates: input.duplicates,
        invalid: input.invalid,
        filename: input.filename,
        processingDay: input.processingDay,
        queue: input.queue,
        requestedBy: input.to,
      });
    } catch (err) {
      logger.error({ err, batchId: input.batchId }, 'Failed to send batch start email');
    }
  }

  private async publishItems(queue: string, batchId: bigint): Promise<number> {
    let afterId: bigint | null = null;
    let count = 0;
    for (;;) {
      const rows = await batchRepository.scanItemIds(batchId, undefined, afterId, PUBLISH_PAGE);
      if (!rows.length) break;
      const ids = rows.map((row) => row.id);
      await publishBatch(queue, ids);
      count += ids.length;
      afterId = ids[ids.length - 1];
    }
    queuePublishCounter.inc({ queue }, count);
    return count;
  }

  private async collectItems(batchId: bigint, status: ItemStatus, withResponse = false) {
    const rows: Awaited<ReturnType<typeof batchRepository.scanItemIds>> = [];
    let afterId: bigint | null = null;
    for (;;) {
      const page = await batchRepository.scanItemIds(batchId, status, afterId, PUBLISH_PAGE, withResponse);
      if (!page.length) break;
      rows.push(...page);
      afterId = page[page.length - 1].id;
    }
    return rows;
  }

  private async releaseLockIfPresent(batch: {
    module: BatchModule;
    remarks: string | null;
  }): Promise<void> {
    const match = /lockToken=([a-f0-9-]+)/i.exec(batch.remarks || '');
    if (match?.[1]) {
      await lockService.releaseModuleLock(batch.module, match[1]);
    }
  }

  // Used by confirm path type export
  async confirmFromInput(_input: ConfirmUploadInput) {
    throw new Error('Use confirmUpload(uploadToken)');
  }

  async requeueItem(itemId: bigint, delayMs: number, module: BatchModule) {
    const queue = retryQueueForModule(module);
    await publishToQueue(queue, { batchItemId: String(itemId) }, delayMs);
    queuePublishCounter.inc({ queue }, 1);
  }

  async moveToDlq(itemId: bigint, module: BatchModule) {
    const dlq = dlqForModule(module);
    await publishToQueue(dlq, { batchItemId: String(itemId) });
  }
}

export const batchService = new BatchService();
