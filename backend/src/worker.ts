import { env } from './common/config/env.js';
import { logger } from './common/logger/logger.js';
import { connectPrisma, disconnectPrisma } from './infrastructure/mysql/prisma.js';
import {
  cancelConsumer,
  connectRabbitMq,
  consumeQueue,
  disconnectRabbitMq,
} from './infrastructure/rabbitmq/client.js';
import { connectRedis, disconnectRedis } from './infrastructure/redis/client.js';
import { processBatchItem } from './modules/batch/workers/item.worker.js';

const consumerTags: string[] = [];
let inFlight = 0;
let shuttingDown = false;

async function startConsumers(): Promise<void> {
  await connectRabbitMq();

  const queues = [
    { name: env.INVOICE_GENERATION_QUEUE, consumers: env.QUEUE_CONSUMERS },
    { name: env.INVOICE_CHARGE_QUEUE, consumers: env.QUEUE_CONSUMERS },
  ];

  for (const q of queues) {
    for (let i = 0; i < q.consumers; i++) {
      const tag = await consumeQueue(q.name, async (payload) => {
        if (shuttingDown) {
          throw new Error('Shutting down — message will be nacked');
        }
        inFlight += 1;
        try {
          await processBatchItem(payload, q.name);
        } finally {
          inFlight -= 1;
        }
      });
      consumerTags.push(tag);
      logger.info({ queue: q.name, consumer: i + 1, tag }, 'Consumer started');
    }
  }

  logger.info(
    {
      concurrency: env.QUEUE_CONCURRENCY,
      consumersPerQueue: env.QUEUE_CONSUMERS,
      totalConsumers: consumerTags.length,
    },
    'Workers ready',
  );
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, inFlight }, 'Graceful shutdown: stop consuming new messages');

  for (const tag of consumerTags) {
    try {
      await cancelConsumer(tag);
    } catch (err) {
      logger.warn({ err, tag }, 'Failed to cancel consumer');
    }
  }

  const deadline = Date.now() + 60_000;
  while (inFlight > 0 && Date.now() < deadline) {
    logger.info({ inFlight }, 'Waiting for in-flight work to finish');
    await new Promise((r) => setTimeout(r, 500));
  }

  if (inFlight > 0) {
    logger.warn({ inFlight }, 'Shutdown deadline reached with in-flight work remaining');
  }

  await disconnectRabbitMq();
  await disconnectRedis();
  await disconnectPrisma();
  logger.info('Worker exited cleanly');
  process.exit(0);
}

async function main() {
  await connectPrisma();
  await connectRedis();
  await startConsumers();

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start worker');
  process.exit(1);
});
