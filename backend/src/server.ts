import { env } from './common/config/env.js';
import { logger } from './common/logger/logger.js';
import { connectPrisma, disconnectPrisma } from './infrastructure/mysql/prisma.js';
import { connectRabbitMq, disconnectRabbitMq } from './infrastructure/rabbitmq/client.js';
import { connectRedis, disconnectRedis } from './infrastructure/redis/client.js';
import { ensureBucket } from './infrastructure/s3/client.js';
import { closeBatchSocket } from './infrastructure/realtime/hub.js';
import { buildApp } from './app.js';

async function main() {
  await connectPrisma();
  await connectRedis();
  await connectRabbitMq();
  await ensureBucket();

  const app = await buildApp();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down API server');
    await closeBatchSocket();
    await app.close();
    await disconnectRabbitMq();
    await disconnectRedis();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(`API listening on http://${env.HOST}:${env.PORT}`);
  logger.info(`Swagger docs at http://${env.HOST}:${env.PORT}/docs`);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start API server');
  process.exit(1);
});
