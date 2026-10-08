import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const queuePublishCounter = new client.Counter({
  name: 'batch_queue_publish_total',
  help: 'Messages published to queues',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const queueConsumeCounter = new client.Counter({
  name: 'batch_queue_consume_total',
  help: 'Messages consumed from queues',
  labelNames: ['queue', 'result'] as const,
  registers: [registry],
});

export const apiLatencyHistogram = new client.Histogram({
  name: 'batch_payment_api_latency_ms',
  help: 'Payment API latency in ms',
  labelNames: ['operation', 'result'] as const,
  buckets: [50, 100, 200, 500, 1000, 2000, 5000],
  registers: [registry],
});

export const retryCounter = new client.Counter({
  name: 'batch_item_retries_total',
  help: 'Item retry attempts',
  labelNames: ['module'] as const,
  registers: [registry],
});

export const dlqCounter = new client.Counter({
  name: 'batch_dlq_total',
  help: 'Messages moved to DLQ',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const activeWorkersGauge = new client.Gauge({
  name: 'batch_active_workers',
  help: 'In-flight worker tasks',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const metricsPlugin = fp(async (app: FastifyInstance) => {
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
});
