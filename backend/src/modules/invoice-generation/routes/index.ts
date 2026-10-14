import type { FastifyInstance } from 'fastify';
import { ROLES } from '../../../common/constants/index.js';
import { requireRoles } from '../../../common/middleware/auth.js';
import {
  cancelOldUnpaidInvoices,
  invoiceCancelEligibility,
} from '../../batch/services/invoice-cancel.service.js';

/**
 * Module-specific routes for Invoice Generation.
 * Shared batch APIs live under modules/batch.
 */
export async function invoiceGenerationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/invoice-generation/info', async () => ({
    module: 'INVOICE_GENERATION',
    queue: 'invoice-generation-queue',
    api: 'POST /payment-service/api/v2/upi/invoice/generate',
  }));

  app.get(
    '/invoice-generation/cancel-unpaid',
    { preHandler: [requireRoles(ROLES.UPLOAD)] },
    async () => invoiceCancelEligibility(),
  );

  app.post(
    '/invoice-generation/cancel-unpaid',
    { preHandler: [requireRoles(ROLES.UPLOAD)] },
    async (request) => cancelOldUnpaidInvoices(request.user.email),
  );
}
