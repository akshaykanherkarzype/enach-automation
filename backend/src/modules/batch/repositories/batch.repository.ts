import type { BatchModule, BatchStatus, ItemStatus, Prisma } from '@prisma/client';
import { prisma } from '../../../infrastructure/mysql/prisma.js';

export const OPEN_BATCH_STATUSES: BatchStatus[] = [
  'UPLOADED',
  'VALIDATING',
  'READY',
  'QUEUED',
  'PROCESSING',
];

const PAGE_SCAN = 1_000;

export class BatchRepository {
  create(data: Prisma.BatchExecutionCreateInput) {
    return prisma.batchExecution.create({ data });
  }

  findById(id: bigint) {
    return prisma.batchExecution.findUnique({ where: { id } });
  }

  findByIdWithCounts(id: bigint) {
    return prisma.batchExecution.findUnique({ where: { id } });
  }

  findOpenBatch(module: BatchModule) {
    return prisma.batchExecution.findFirst({
      where: { module, status: { in: OPEN_BATCH_STATUSES } },
      orderBy: { id: 'desc' },
      select: { id: true, status: true },
    });
  }

  list(params: {
    module?: BatchModule;
    status?: BatchStatus;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.BatchExecutionWhereInput = {};
    if (params.module) where.module = params.module;
    if (params.status) where.status = params.status;

    return Promise.all([
      prisma.batchExecution.findMany({
        where,
        orderBy: { uploadedAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      prisma.batchExecution.count({ where }),
    ]);
  }

  update(id: bigint, data: Prisma.BatchExecutionUpdateInput) {
    return prisma.batchExecution.update({ where: { id }, data });
  }

  createItems(data: Prisma.BatchExecutionItemCreateManyInput[]) {
    return prisma.batchExecutionItem.createMany({ data });
  }

  findItemsByBatch(
    batchId: bigint,
    opts?: { status?: ItemStatus; page?: number; pageSize?: number },
  ) {
    const page = opts?.page ?? 1;
    const pageSize = opts?.pageSize ?? 50;
    const where: Prisma.BatchExecutionItemWhereInput = { batchId };
    if (opts?.status) where.status = opts.status;

    return Promise.all([
      prisma.batchExecutionItem.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.batchExecutionItem.count({ where }),
    ]);
  }

  findItemById(id: bigint) {
    return prisma.batchExecutionItem.findUnique({
      where: { id },
      include: { batch: true },
    });
  }

  findFailedItemIds(batchId: bigint) {
    return prisma.batchExecutionItem.findMany({
      where: { batchId, status: 'FAILED' },
      select: { id: true },
    });
  }

  updateItem(id: bigint, data: Prisma.BatchExecutionItemUpdateInput) {
    return prisma.batchExecutionItem.update({ where: { id }, data });
  }

  createLog(data: Prisma.BatchExecutionLogCreateInput) {
    return prisma.batchExecutionLog.create({ data });
  }

  listLogs(batchId: bigint, page: number, pageSize: number) {
    return Promise.all([
      prisma.batchExecutionLog.findMany({
        where: { batchId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          item: {
            select: { customerId: true, batchId: true },
          },
        },
      }),
      prisma.batchExecutionLog.count({ where: { batchId } }),
    ]);
  }

  async recount(batchId: bigint) {
    const grouped = await prisma.batchExecutionItem.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    const countOf = (status: ItemStatus) =>
      grouped.find((row) => row.status === status)?._count._all ?? 0;
    const successCount = countOf('SUCCESS');
    const failedCount = countOf('FAILED');
    const processingCount = countOf('PROCESSING');
    const pendingCount = countOf('PENDING');
    const retryingCount = countOf('RETRYING');

    return {
      successCount,
      failedCount,
      processingCount: processingCount + pendingCount + retryingCount,
      pendingCount,
      retryingCount,
    };
  }

  /** Walk a batch in id order without loading it all at once. */
  async scanItemIds(
    batchId: bigint,
    status: ItemStatus | undefined,
    afterId: bigint | null,
    take = PAGE_SCAN,
    withResponse = false,
  ) {
    return prisma.batchExecutionItem.findMany({
      where: {
        batchId,
        ...(status ? { status } : {}),
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: {
        id: true,
        customerId: true,
        amount: true,
        failureReason: true,
        responseCode: true,
        retryCount: true,
        ...(withResponse ? { responseBody: true } : {}),
      },
      orderBy: { id: 'asc' },
      take,
    });
  }

  /** Latest payment trace for each customer in the batch. */
  async latestTraceByItem(batchId: bigint): Promise<Map<string, string>> {
    const rows = await prisma.$queryRaw<Array<{ batchItemId: bigint; traceId: string | null }>>`
      SELECT log_row.batchItemId AS batchItemId, log_row.traceId AS traceId
      FROM batch_execution_logs AS log_row
      INNER JOIN (
        SELECT batchItemId, MAX(id) AS id
        FROM batch_execution_logs
        WHERE batchId = ${batchId}
        GROUP BY batchItemId
      ) AS latest ON latest.id = log_row.id
    `;
    const traces = new Map<string, string>();
    for (const row of rows) {
      if (row.traceId) traces.set(String(row.batchItemId), row.traceId);
    }
    return traces;
  }

  createAudit(data: Prisma.AuditLogCreateInput) {
    return prisma.auditLog.create({ data });
  }

  findPendingItemsForBatch(batchId: bigint, take: number) {
    return prisma.batchExecutionItem.findMany({
      where: { batchId, status: { in: ['PENDING', 'RETRYING'] } },
      take,
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  }
}

export const batchRepository = new BatchRepository();
