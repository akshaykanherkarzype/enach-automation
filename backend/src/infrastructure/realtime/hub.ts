import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';
import { serializeBigInt } from '../../common/utils/parse-size.js';
import { batchService } from '../../modules/batch/services/batch.service.js';
import { BATCH_EVENT_CHANNEL, type BatchChangedEvent } from './batch-events.js';

const AUTH_WAIT_MS = 5_000;
const PING_MS = 20_000;

const clients = new Set<WebSocket>();
let subscriber: Redis | null = null;

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const allowed = env.CORS_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean);
  return allowed.includes(origin);
}

function snapshotOf(batch: Record<string, unknown>) {
  return {
    id: batch.id,
    module: batch.module,
    status: batch.status,
    uploadedBy: batch.uploadedBy,
    uploadedAt: batch.uploadedAt,
    startedAt: batch.startedAt ?? null,
    completedAt: batch.completedAt ?? null,
    totalRecords: batch.totalRecords,
    successCount: batch.successCount,
    failedCount: batch.failedCount,
    duplicateCount: batch.duplicateCount,
    processingCount: batch.processingCount,
    progress: batch.progress,
    remaining: batch.remaining,
    recordsPerMin: batch.recordsPerMin,
    etaMs: batch.etaMs ?? null,
    durationMs: batch.durationMs,
    workersRunning: batch.workersRunning,
  };
}

function broadcast(payload: unknown): void {
  const raw = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(raw);
  }
}

async function publishSnapshot(batchId: string): Promise<void> {
  try {
    const batch = serializeBigInt(await batchService.getById(BigInt(batchId))) as Record<string, unknown>;
    broadcast({ type: 'batch.updated', batch: snapshotOf(batch) });
  } catch (err) {
    logger.warn({ err, batchId }, 'Skipped batch snapshot');
  }
}

export async function registerBatchSocket(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  if (!subscriber) {
    subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    subscriber.on('error', (err: Error) => {
      logger.error({ err }, 'Batch socket subscriber error');
    });
    await subscriber.connect();
    await subscriber.subscribe(BATCH_EVENT_CHANNEL);
    subscriber.on('message', (channel: string, message: string) => {
      if (channel !== BATCH_EVENT_CHANNEL) return;
      try {
        const event = JSON.parse(message) as BatchChangedEvent;
        if (event?.type === 'batch.changed' && event.batchId) {
          void publishSnapshot(event.batchId);
        }
      } catch (err) {
        logger.warn({ err }, 'Ignored malformed batch event');
      }
    });
    logger.info({ channel: BATCH_EVENT_CHANNEL }, 'Batch socket subscribed');
  }

  app.get('/api/v1/ws', { websocket: true }, (socket, request) => {
    if (!allowedOrigin(request.headers.origin)) {
      socket.close(4003, 'origin');
      return;
    }

    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) socket.close(4001, 'auth timeout');
    }, AUTH_WAIT_MS);

    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, PING_MS);

    const close = () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      clients.delete(socket);
    };

    socket.on('close', close);
    socket.on('error', close);
    socket.on('message', (raw: Buffer | string) => {
      let message: { type?: string; token?: string };
      try {
        message = JSON.parse(String(raw)) as { type?: string; token?: string };
      } catch {
        socket.close(4002, 'invalid message');
        return;
      }

      if (!authed) {
        if (message.type !== 'auth' || !message.token) {
          socket.close(4001, 'unauthorized');
          return;
        }
        try {
          app.jwt.verify(message.token);
        } catch {
          socket.close(4001, 'unauthorized');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        clients.add(socket);
        socket.send(JSON.stringify({ type: 'ready' }));
        return;
      }
    });
  });
}

export async function closeBatchSocket(): Promise<void> {
  for (const client of clients) client.close(1001, 'server shutdown');
  clients.clear();
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
  }
}
