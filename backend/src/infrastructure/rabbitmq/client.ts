import amqp, { ConfirmChannel, ChannelModel, ConsumeMessage } from 'amqplib';
import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';

export type QueuePayload = { batchItemId: string };

let connection: ChannelModel | null = null;
let channel: ConfirmChannel | null = null;

/** Queue expiry deletes every waiting message and does not dead-letter them. */
const DELAY_QUEUE_LEASE_MS = 24 * 60 * 60 * 1000;

export function delayQueueSetup(delayMs: number): { ttlMs: number; expiresMs: number } {
  const ttlMs = Math.max(1, Math.ceil(delayMs));
  return { ttlMs, expiresMs: ttlMs + DELAY_QUEUE_LEASE_MS };
}

const QUEUE_CONFIG = {
  durable: true,
  arguments: {
    'x-queue-type': 'classic',
  },
};

export async function connectRabbitMq(): Promise<Channel> {
  if (channel) return channel;

  connection = await amqp.connect(env.RABBITMQ_URL);
  channel = await connection.createConfirmChannel();
  await channel.prefetch(env.QUEUE_CONCURRENCY);

  const queues = [
    env.INVOICE_GENERATION_QUEUE,
    env.INVOICE_CHARGE_QUEUE,
    retryQueueName(env.INVOICE_GENERATION_QUEUE),
    retryQueueName(env.INVOICE_CHARGE_QUEUE),
    env.INVOICE_GENERATION_DLQ,
    env.INVOICE_CHARGE_DLQ,
  ];

  for (const q of queues) {
    await channel.assertQueue(q, QUEUE_CONFIG);
  }

  connection.on('error', (err) => logger.error({ err }, 'RabbitMQ connection error'));
  connection.on('close', () => {
    logger.warn('RabbitMQ connection closed');
    connection = null;
    channel = null;
  });

  logger.info('RabbitMQ connected and queues asserted');
  return channel;
}

export function getChannel(): ConfirmChannel {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }
  return channel;
}

export async function publishToQueue(queue: string, payload: QueuePayload, delayMs = 0): Promise<void> {
  const ch = getChannel();
  const content = Buffer.from(JSON.stringify(payload));

  if (delayMs > 0) {
    // One queue per delay so a long wait cannot block a short one.
    // The lease is a full day past the message TTL. A short lease deletes
    // the queue and discards messages that have not dead-lettered yet.
    const delayQueue = `${queue}.delay.${Math.max(1, Math.ceil(delayMs))}`;
    const { ttlMs, expiresMs } = delayQueueSetup(delayMs);
    await ch.assertQueue(delayQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue,
        'x-message-ttl': ttlMs,
        'x-expires': expiresMs,
      },
    });
    ch.sendToQueue(delayQueue, content, {
      persistent: true,
      contentType: 'application/json',
    });
    await ch.waitForConfirms();
    return;
  }

  ch.sendToQueue(queue, content, {
    persistent: true,
    contentType: 'application/json',
  });
  await ch.waitForConfirms();
}

export async function publishBatch(
  queue: string,
  itemIds: Array<bigint | number | string>,
): Promise<void> {
  for (const id of itemIds) {
    await publishToQueue(queue, { batchItemId: String(id) });
  }
}

const REQUEUABLE_DB_CODES = new Set(['P1001', 'P1008', 'P1017', 'P2024']);

/** A database outage must put the customer back. Dropping it leaves the row pending forever. */
export function shouldRequeueHandlerError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.startsWith('Shutting down')) return true;
  const code = 'code' in err && typeof err.code === 'string' ? err.code : '';
  if (REQUEUABLE_DB_CODES.has(code)) return true;
  return (
    err.message.includes("Can't reach database server") ||
    err.message.includes('Server has closed the connection')
  );
}

export type MessageHandler = (payload: QueuePayload, msg: ConsumeMessage) => Promise<void>;

export async function consumeQueue(
  queue: string,
  handler: MessageHandler,
  options?: { consumerTag?: string },
): Promise<string> {
  const ch = getChannel();
  const { consumerTag } = await ch.consume(
    queue,
    async (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString()) as QueuePayload;
        await handler(payload, msg);
        ch.ack(msg);
      } catch (err) {
        const requeue = shouldRequeueHandlerError(err);
        logger.error({ err, queue, requeue }, 'Consumer handler failed');
        try {
          ch.nack(msg, false, requeue);
        } catch (nackErr) {
          logger.error({ err: nackErr, queue }, 'Failed to nack message');
        }
      }
    },
    { noAck: false, consumerTag: options?.consumerTag },
  );
  return consumerTag;
}

export async function cancelConsumer(consumerTag: string): Promise<void> {
  const ch = getChannel();
  await ch.cancel(consumerTag);
}

export async function disconnectRabbitMq(): Promise<void> {
  try {
    await channel?.close();
  } catch {
    /* ignore */
  }
  try {
    await connection?.close();
  } catch {
    /* ignore */
  }
  channel = null;
  connection = null;
}

export function queueForModule(module: 'INVOICE_GENERATION' | 'INVOICE_CHARGE'): string {
  return module === 'INVOICE_GENERATION'
    ? env.INVOICE_GENERATION_QUEUE
    : env.INVOICE_CHARGE_QUEUE;
}

/** Delay queues dead-letter here so a due retry is consumed beside the main file. */
export function retryQueueName(queue: string): string {
  return `${queue}-retry`;
}

export function retryQueueForModule(module: 'INVOICE_GENERATION' | 'INVOICE_CHARGE'): string {
  return retryQueueName(queueForModule(module));
}

export function dlqForModule(module: 'INVOICE_GENERATION' | 'INVOICE_CHARGE'): string {
  return module === 'INVOICE_GENERATION'
    ? env.INVOICE_GENERATION_DLQ
    : env.INVOICE_CHARGE_DLQ;
}
