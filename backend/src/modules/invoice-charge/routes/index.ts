import type { FastifyInstance } from 'fastify';

/**
 * Module-specific hooks/routes for Invoice Charge.
 */
export async function invoiceChargeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/invoice-charge/info', async () => ({
    module: 'INVOICE_CHARGE',
    queue: 'invoice-charge-queue',
    api: 'POST /payment-service/api/v2/upi/invoice/charge',
  }));
}
