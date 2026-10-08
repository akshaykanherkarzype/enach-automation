import { randomUUID } from 'node:crypto';
import type { BatchModule, ItemStatus } from '@prisma/client';
import { env } from '../../../common/config/env.js';
import { API_NAMES } from '../../../common/constants/index.js';
import { logger } from '../../../common/logger/logger.js';
import { batchAnchorDay } from '../../../common/time/ist.js';
import { toJsonSafe } from '../../../common/utils/parse-size.js';
import { currentPressure, HOST_PRESSURE_DEFER_MS } from '../../../infrastructure/payment/host-pressure.js';
import { buildSingleCustomerPayload } from '../../../infrastructure/payment/payload.js';
import { paymentClient } from '../../../infrastructure/payment/index.js';
import type { PaymentResponse } from '../../../infrastructure/payment/types.js';
import type { QueuePayload } from '../../../infrastructure/rabbitmq/client.js';
import {
  activeWorkersGauge,
  apiLatencyHistogram,
  dlqCounter,
  queueConsumeCounter,
  retryCounter,
} from '../../../plugins/metrics.js';
import { scheduleBatchChanged } from '../../../infrastructure/realtime/batch-events.js';
import { batchRepository } from '../repositories/batch.repository.js';
import { batchService } from '../services/batch.service.js';
import { lockService } from '../services/lock.service.js';
import { notifyBatchEpisode } from '../services/progress-notice.service.js';
import { planAfterResponse, planBeforeCall } from './attempt-plan.js';

function apiNameForModule(module: BatchModule): string {
  return module === 'INVOICE_GENERATION'
    ? API_NAMES.INVOICE_GENERATE
    : API_NAMES.INVOICE_CHARGE;
}

function operationForModule(module: BatchModule): 'generate' | 'charge' {
  return module === 'INVOICE_GENERATION' ? 'generate' : 'charge';
}

function waitingStatus(retryCount: number): ItemStatus {
  return retryCount > 0 ? 'RETRYING' : 'PENDING';
}

function paymentServiceAnswered(response: PaymentResponse): boolean {
  return (
    response.responseCode !== 'PAYMENT_SERVICE_UNAVAILABLE' &&
    response.responseCode !== 'PAYMENT_SLOT_BUSY' &&
    response.responseCode !== 'INVALID_PAYLOAD'
  );
}

async function notifyProgress(input: {
  batchId: bigint;
  module: BatchModule;
  uploadedBy: string;
  total: number;
  episode: 'payment' | 'peak' | 'host';
  next: 'down' | 'up' | 'paused' | 'running';
  cause?: string;
  resumesAt?: Date;
}): Promise<void> {
  await notifyBatchEpisode(input);
}

async function heartbeatBatchLock(module: BatchModule, remarks: string | null): Promise<void> {
  const match = /lockToken=([a-f0-9-]+)/i.exec(remarks || '');
  if (!match?.[1]) return;
  try {
    await lockService.heartbeat(module, match[1]);
  } catch (err) {
    logger.warn({ err, module }, 'Failed to extend batch lock');
  }
}

/**
 * Process a single batch item. Idempotent: SUCCESS items are skipped.
 * Each payment call still carries one customer. HTTP mode allows several of those calls in flight.
 */
export async function processBatchItem(
  payload: QueuePayload,
  queueName: string,
): Promise<void> {
  const itemId = BigInt(payload.batchItemId);
  activeWorkersGauge.inc({ queue: queueName });

  try {
    const item = await batchRepository.findItemById(itemId);
    if (!item) {
      logger.warn({ itemId: payload.batchItemId }, 'Batch item not found; acking');
      queueConsumeCounter.inc({ queue: queueName, result: 'missing' });
      return;
    }

    if (item.batch.status === 'CANCELLED') {
      queueConsumeCounter.inc({ queue: queueName, result: 'cancelled' });
      return;
    }

    // Idempotency: already succeeded — do not call API again
    if (item.status === 'SUCCESS') {
      logger.info(
        { itemId: payload.batchItemId, idempotencyKey: item.idempotencyKey },
        'Skipping already successful item',
      );
      queueConsumeCounter.inc({ queue: queueName, result: 'idempotent_skip' });
      scheduleBatchChanged(item.batchId, await batchService.finalizeIfComplete(item.batchId));
      return;
    }

    const module = item.batch.module;
    await heartbeatBatchLock(module, item.batch.remarks);

    const now = new Date();
    const anchorDay = batchAnchorDay(item.batch.processingDay, item.batch.startedAt, now);
    const remoteGuards = env.PAYMENT_CLIENT === 'http';
    // The UPI invoice route returns an existing unpaid invoice. It does not cancel
    // the previous day's invoices, so a batch may continue after midnight.
    const enforceSameDay = false;

    let before = planBeforeCall({
      now,
      module,
      anchorDay,
      enforcePeak: remoteGuards,
      enforceSameDay,
      peakWindows: env.peakWindows,
      dayEndBufferMs: env.INVOICE_DAY_END_BUFFER_MS,
    });

    if (before.action === 'call' && remoteGuards) {
      const pressure = await currentPressure(now.getTime());
      if (pressure.level === 'pause') {
        before = {
          action: 'defer',
          delayMs: HOST_PRESSURE_DEFER_MS,
          reason: 'HOST_PRESSURE',
        };
      }
    }

    if (before.action === 'defer') {
      await batchRepository.updateItem(itemId, { status: waitingStatus(item.retryCount) });
      await batchService.requeueItem(itemId, before.delayMs, module);
      queueConsumeCounter.inc({ queue: queueName, result: 'deferred' });
      logger.info(
        { itemId: payload.batchItemId, delayMs: before.delayMs, reason: before.reason },
        'Deferred payment call',
      );
      if (before.reason === 'PEAK_HOURS') {
        await notifyProgress({
          batchId: item.batchId,
          module,
          uploadedBy: item.batch.uploadedBy,
          total: item.batch.totalRecords,
          episode: 'peak',
          next: 'paused',
          resumesAt: new Date(now.getTime() + before.delayMs),
        });
      }
      if (before.reason === 'HOST_PRESSURE') {
        const pressure = await currentPressure(now.getTime());
        await notifyProgress({
          batchId: item.batchId,
          module,
          uploadedBy: item.batch.uploadedBy,
          total: item.batch.totalRecords,
          episode: 'host',
          next: 'paused',
          cause: pressure.reasons.join(', '),
        });
      }
      scheduleBatchChanged(item.batchId);
      return;
    }

    if (remoteGuards) {
      await notifyProgress({
        batchId: item.batchId,
        module,
        uploadedBy: item.batch.uploadedBy,
        total: item.batch.totalRecords,
        episode: 'peak',
        next: 'running',
      });
      await notifyProgress({
        batchId: item.batchId,
        module,
        uploadedBy: item.batch.uploadedBy,
        total: item.batch.totalRecords,
        episode: 'host',
        next: 'running',
      });
    }

    if (before.action === 'fail') {
      await failItem(itemId, module, queueName, item.batchId, before.reason, item.retryCount);
      return;
    }

    const traceId = randomUUID();
    const retryNo = item.retryCount;

    await batchRepository.updateItem(itemId, {
      status: 'PROCESSING',
      startedAt: item.startedAt ?? new Date(),
    });

    let requestBody: ReturnType<typeof buildSingleCustomerPayload> | undefined;
    try {
      requestBody = buildSingleCustomerPayload(item.customerId, Number(item.amount));
    } catch {
      requestBody = undefined;
    }

    let response: PaymentResponse;
    try {
      response = await paymentClient.execute({
        customerId: item.customerId,
        amount: Number(item.amount),
        operation: operationForModule(module),
        idempotencyKey: item.idempotencyKey,
        batchId: String(item.batchId),
        batchItemId: String(itemId),
        traceId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Payment request failed';
      response = {
        success: false,
        retryable: true,
        statusCode: 0,
        responseCode: 'TRANSPORT_ERROR',
        body: { message },
        latencyMs: 0,
      };
    }

    apiLatencyHistogram.observe(
      { operation: operationForModule(module), result: response.success ? 'success' : 'failed' },
      response.latencyMs,
    );

    if (!response.deferred || response.statusCode > 0) {
      await batchRepository.createLog({
        apiName: apiNameForModule(module),
        request: toJsonSafe({
          body: requestBody ?? { customerId: item.customerId, amount: Number(item.amount) },
          idempotencyKey: item.idempotencyKey,
        }),
        response: toJsonSafe({
          status: response.body.status,
          message: response.body.message,
          responseCode: response.responseCode,
        }),
        statusCode: response.statusCode,
        latency: response.latencyMs,
        retryNo,
        traceId,
        batch: { connect: { id: item.batchId } },
        item: { connect: { id: itemId } },
      });
    }

    const after = planAfterResponse({
      now: new Date(),
      module,
      anchorDay,
      enforceSameDay,
      dayEndBufferMs: env.INVOICE_DAY_END_BUFFER_MS,
      response,
      retryCount: item.retryCount,
      maxRetry: env.MAX_RETRY,
      retryDelaysMs: env.retryDelaysMs,
    });

    if (after.action === 'success') {
      await batchRepository.updateItem(itemId, {
        status: 'SUCCESS',
        responseCode: response.responseCode,
        responseBody: toJsonSafe(response.body),
        completedAt: new Date(),
        failureReason: null,
      });
      queueConsumeCounter.inc({ queue: queueName, result: 'success' });
      if (remoteGuards) {
        await notifyProgress({
          batchId: item.batchId,
          module,
          uploadedBy: item.batch.uploadedBy,
          total: item.batch.totalRecords,
          episode: 'payment',
          next: 'up',
        });
      }
      scheduleBatchChanged(item.batchId, await batchService.finalizeIfComplete(item.batchId));
      return;
    }

    if (after.action === 'defer') {
      await batchRepository.updateItem(itemId, { status: waitingStatus(item.retryCount) });
      await batchService.requeueItem(itemId, after.delayMs, module);
      queueConsumeCounter.inc({ queue: queueName, result: 'deferred' });
      logger.info(
        { itemId: payload.batchItemId, delayMs: after.delayMs, reason: after.reason },
        'Deferred payment call',
      );
      if (after.reason === 'PAYMENT_SERVICE_UNAVAILABLE') {
        const cause = typeof response.body.cause === 'string' ? response.body.cause : 'HTTP_502';
        await notifyProgress({
          batchId: item.batchId,
          module,
          uploadedBy: item.batch.uploadedBy,
          total: item.batch.totalRecords,
          episode: 'payment',
          next: 'down',
          cause,
        });
      } else if (remoteGuards && paymentServiceAnswered(response)) {
        await notifyProgress({
          batchId: item.batchId,
          module,
          uploadedBy: item.batch.uploadedBy,
          total: item.batch.totalRecords,
          episode: 'payment',
          next: 'up',
        });
      }
      scheduleBatchChanged(item.batchId);
      return;
    }

    if (after.action === 'retry') {
      const nextRetry = item.retryCount + 1;
      await batchRepository.updateItem(itemId, {
        status: 'RETRYING',
        retryCount: nextRetry,
        failureReason: after.reason,
        responseCode: response.responseCode,
        responseBody: toJsonSafe(response.body),
      });
      retryCounter.inc({ module });
      await batchService.requeueItem(itemId, after.delayMs, module);
      queueConsumeCounter.inc({ queue: queueName, result: 'retry' });
      logger.info(
        { itemId: payload.batchItemId, nextRetry, delayMs: after.delayMs },
        'Scheduled retry',
      );
      if (remoteGuards && paymentServiceAnswered(response)) {
        await notifyProgress({
          batchId: item.batchId,
          module,
          uploadedBy: item.batch.uploadedBy,
          total: item.batch.totalRecords,
          episode: 'payment',
          next: 'up',
        });
      }
      scheduleBatchChanged(item.batchId);
      return;
    }

    if (remoteGuards && paymentServiceAnswered(response)) {
      await notifyProgress({
        batchId: item.batchId,
        module,
        uploadedBy: item.batch.uploadedBy,
        total: item.batch.totalRecords,
        episode: 'payment',
        next: 'up',
      });
    }

    const storedRetry = response.retryable ? item.retryCount + 1 : item.retryCount;
    await failItem(itemId, module, queueName, item.batchId, after.reason, storedRetry, response);
  } finally {
    activeWorkersGauge.dec({ queue: queueName });
  }
}

async function failItem(
  itemId: bigint,
  module: BatchModule,
  queueName: string,
  batchId: bigint,
  reason: string,
  retryCount: number,
  response?: PaymentResponse,
): Promise<void> {
  await batchRepository.updateItem(itemId, {
    status: 'FAILED',
    retryCount,
    failureReason: reason,
    responseCode: response?.responseCode,
    responseBody: response ? toJsonSafe(response.body) : undefined,
    completedAt: new Date(),
  });

  await batchService.moveToDlq(itemId, module);
  dlqCounter.inc({ queue: queueName });
  queueConsumeCounter.inc({ queue: queueName, result: 'failed' });
  logger.warn({ itemId: String(itemId), reason }, 'Batch item failed');
  scheduleBatchChanged(batchId, await batchService.finalizeIfComplete(batchId));
}
