import amqp, { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';

export type QueuePayload = { batchItemId: string };

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

const QUEUE_CONFIG = {
  durable: true,
  arguments: {
    'x-queue-type': 'classic',
  },
};

export async function connectRabbitMq(): Promise<Channel> {
  if (channel) return channel;

  connection = await amqp.connect(env.RABBITMQ_URL);
  channel = await connection.createChannel();
  await channel.prefetch(env.QUEUE_CONCURRENCY);

  const queues = [
    env.INVOICE_GENERATION_QUEUE,
    env.INVOICE_CHARGE_QUEUE,
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

export function getChannel(): Channel {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }
  return channel;
}

export async function publishToQueue(queue: string, payload: QueuePayload, delayMs = 0): Promise<void> {
  const ch = getChannel();
  const content = Buffer.from(JSON.stringify(payload));

  if (delayMs > 0) {
    // Use per-message expiration via a temporary delayed queue pattern
    const delayQueue = `${queue}.delay.${delayMs}`;
    await ch.assertQueue(delayQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue,
        'x-message-ttl': delayMs,
        'x-expires': delayMs + 60_000,
      },
    });
    ch.sendToQueue(delayQueue, content, {
      persistent: true,
      contentType: 'application/json',
    });
    return;
  }

  ch.sendToQueue(queue, content, {
    persistent: true,
    contentType: 'application/json',
  });
}

export async function publishBatch(
  queue: string,
  itemIds: Array<bigint | number | string>,
): Promise<void> {
  for (const id of itemIds) {
    await publishToQueue(queue, { batchItemId: String(id) });
  }
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
        logger.error({ err, queue }, 'Consumer handler failed; nacking without requeue');
        ch.nack(msg, false, false);
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

export function dlqForModule(module: 'INVOICE_GENERATION' | 'INVOICE_CHARGE'): string {
  return module === 'INVOICE_GENERATION'
    ? env.INVOICE_GENERATION_DLQ
    : env.INVOICE_CHARGE_DLQ;
}
