import type { FastifyInstance } from 'fastify';

/**
 * Module-specific hooks/routes for Invoice Generation.
 * Shared batch APIs live under modules/batch; this namespace is reserved
 * for future generation-specific endpoints.
 */
export async function invoiceGenerationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/invoice-generation/info', async () => ({
    module: 'INVOICE_GENERATION',
    queue: 'invoice-generation-queue',
    api: 'POST /payment-service/api/v2/upi/invoice/generate',
  }));
}
