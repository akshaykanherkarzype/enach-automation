import type { FastifyInstance } from 'fastify';
import { ROLES } from '../../../common/constants/index.js';
import { authenticate, requireRoles } from '../../../common/middleware/auth.js';
import { batchController } from '../controllers/batch.controller.js';

export async function batchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.post(
    '/batches/:module/upload',
    { preHandler: [requireRoles(ROLES.UPLOAD)] },
    (req, reply) => batchController.upload(req, reply),
  );

  app.post(
    '/batches/:module/confirm',
    { preHandler: [requireRoles(ROLES.UPLOAD)] },
    (req, reply) => batchController.confirm(req, reply),
  );

  app.get('/batches', (req, reply) => batchController.list(req, reply));

  app.get('/batches/:id', (req, reply) => batchController.getById(req, reply));

  app.get('/batches/:id/items', (req, reply) => batchController.getItems(req, reply));

  app.get('/batches/:id/logs', (req, reply) => batchController.getLogs(req, reply));

  app.post(
    '/batches/:id/retry-failed',
    { preHandler: [requireRoles(ROLES.RETRY)] },
    (req, reply) => batchController.retryFailed(req, reply),
  );

  app.post(
    '/batches/:id/retry-dlq',
    { preHandler: [requireRoles(ROLES.RETRY)] },
    (req, reply) => batchController.retryDlq(req, reply),
  );

  app.post(
    '/batches/:id/cancel',
    { preHandler: [requireRoles(ROLES.UPLOAD)] },
    (req, reply) => batchController.cancel(req, reply),
  );

  app.get('/batches/:id/download/:type', (req, reply) =>
    batchController.download(req, reply),
  );
}
