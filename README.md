# UPI Batch Processing Platform

Greenfield platform for high-volume UPI invoice generation and charge batches.

Two **independent** projects (ready to split into separate git repos):

```
E-Nach/
  backend/     # Fastify API + RabbitMQ workers
  frontend/    # React dashboard
  docker-compose.yml
  samples/
```

## Architecture

1. Upload CSV/XLSX (`customer_id`, `final_nach_amount`)
2. Validate + dedupe → S3 original/processed files
3. Create `batch_execution` + `batch_execution_items`
4. Publish `{ batchItemId }` to module-specific RabbitMQ queues
5. Workers call **mock** payment APIs, log attempts, retry with backoff, DLQ on permanent failure
6. Dashboard polls progress; email report stub on completion

Redis enforces **one active batch per module**.

## Local setup

```bash
# 1. Infrastructure
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env
npm install
npx prisma migrate deploy
npm run dev          # terminal 1 — API :4000
npm run dev:worker   # terminal 2 — consumers

# 3. Frontend
cd ../frontend
cp .env.example .env
npm install
npm run dev          # :5173
```

Sample file: [`samples/customers.csv`](samples/customers.csv)

Login: `admin@zype.local` / `password`

## Docs

- [STARTUP.md](STARTUP.md) — how to start the API, worker, and dashboard, and how to run a file
- [backend/README.md](backend/README.md)
- [frontend/README.md](frontend/README.md)
- API Swagger: http://localhost:4000/docs
- RabbitMQ UI: http://localhost:15673 (batch / batch)
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)

## Payment integration

`PAYMENT_CLIENT=mock` by default (`MockPaymentClient`).

`PAYMENT_CLIENT=http` calls the synchronous UPI autopay routes with **one customer per request**:

- `POST /payment-service/api/v2/upi/autopay/invoice`
- `POST /payment-service/api/v2/upi/autopay/charge`

A `200` body of `{ "status": "success", "retryable": false }` is success, including `AUTOPAY_INVOICE_ALREADY_CREATED`. The worker follows the response `retryable` flag. Transport errors and HTTP 5xx are retried. `INVOICE_NOT_READY_FOR_CHARGE` is deferred until the invoice is old enough, without using a retry. `PAYMENT_MAX_IN_FLIGHT` is 8 and `PAYMENT_REQUEST_GAP_MS` is 125, the same concurrent load data-pipeline already sends. `API_TIMEOUT` stays 120000, because each call waits for the gateway. Calls are skipped during IST peak hours (10:00–13:00 and 17:00–22:00).

See [backend/docs/payment-integration.md](backend/docs/payment-integration.md).
