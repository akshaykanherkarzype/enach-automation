import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './common/config/env.js';
import { AppError } from './common/exceptions/app-error.js';
import { logger } from './common/logger/logger.js';
import { authenticate } from './common/middleware/auth.js';
import { serializeBigInt } from './common/utils/parse-size.js';
import { registerBatchSocket } from './infrastructure/realtime/hub.js';
import { metricsPlugin } from './plugins/metrics.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { batchRoutes } from './modules/batch/routes/batch.routes.js';
import { invoiceChargeRoutes } from './modules/invoice-charge/routes/index.js';
import { invoiceGenerationRoutes } from './modules/invoice-generation/routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function buildApp() {
  const app = Fastify({
    logger: false,
    bodyLimit: env.uploadMaxBytes + 1024 * 1024,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN as `${number}${'s' | 'm' | 'h' | 'd'}` },
  });

  app.decorate('authenticate', authenticate);

  await app.register(multipart, {
    limits: { fileSize: env.uploadMaxBytes },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'UPI Batch Processing API',
        description: 'Production-grade batch upload, processing, and retry APIs',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(metricsPlugin);
  await registerBatchSocket(app);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code || 'ERROR',
        message: error.message,
        details: error.details,
      });
    }

    const err = error as Error & { validation?: unknown; statusCode?: number };
    if (err.validation) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: err.message,
        details: err.validation,
      });
    }

    logger.error({ err: error, url: request.url }, 'Unhandled error');
    return reply.status(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({
      error: 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    });
  });

  app.addHook('preSerialization', async (_request, _reply, payload) => {
    return serializeBigInt(payload);
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'upi-batch-backend',
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async () => ({ status: 'ready' }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(batchRoutes);
      await api.register(invoiceGenerationRoutes);
      await api.register(invoiceChargeRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
