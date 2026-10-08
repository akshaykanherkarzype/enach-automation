# UPI Batch Backend

Production-oriented Fastify API and RabbitMQ workers for UPI Invoice Generation and Invoice Charge batch processing.

## Stack

- Node.js 22 + TypeScript + Fastify
- Prisma + MySQL
- RabbitMQ (two queues + DLQs)
- Redis (distributed locks)
- AWS S3 / MinIO
- Mock payment client (swap later for real payment-service)
- Pino logs, Prometheus `/metrics`, OpenAPI `/docs`

## Quick start

From repo root:

```bash
docker compose up -d
cd backend
cp .env.example .env   # already configured for compose ports
npm install
npx prisma migrate deploy
npm run dev            # API on :4000
npm run dev:worker     # consumers (separate terminal)
```

Compose ports (to avoid host conflicts):

| Service  | Host port |
|----------|-----------|
| MySQL    | 3307      |
| Redis    | 6380      |
| RabbitMQ | 5673 (UI 15673) |
| MinIO    | 9000 (console 9001) |

## Auth (dev)

| User | Password | Roles |
|------|----------|-------|
| `admin@zype.local` | `password` | VIEW, UPLOAD, RETRY |
| `uploader@zype.local` | `password` | VIEW, UPLOAD |
| `viewer@zype.local` | `password` | VIEW |

`POST /api/v1/auth/login` → JWT Bearer token.

## Main APIs

- `POST /api/v1/batches/:module/upload` — multipart CSV/XLSX (`invoice-generation` \| `invoice-charge`)
- `POST /api/v1/batches/:module/confirm` — `{ uploadToken }`
- `GET /api/v1/batches` — list
- `GET /api/v1/batches/:id` — details + progress metrics
- `GET /api/v1/batches/:id/items`
- `GET /api/v1/batches/:id/logs`
- `POST /api/v1/batches/:id/retry-failed`
- `POST /api/v1/batches/:id/retry-dlq`
- `POST /api/v1/batches/:id/cancel`
- `GET /api/v1/batches/:id/download/:type` — signed URL (`original` \| `processed` \| `failed` \| `success`)

Swagger: [http://localhost:4000/docs](http://localhost:4000/docs)

## Workers

- Queues: `invoice-generation-queue`, `invoice-charge-queue`
- DLQs: `invoice-generation-dlq`, `invoice-charge-dlq`
- Payload: `{ "batchItemId": "123" }` only
- Retries: 5s → 30s → 2m (`RETRY_DELAYS_MS`), only when payment-service sets `retryable: true`, or the call throws / returns 5xx
- Idempotency key: `batchId_customerId`
- Graceful shutdown on SIGTERM/SIGINT
- HTTP mode sends one customer object per UPI request
- HTTP mode skips IST peak hours `10:00–13:00` and `17:00–22:00`
- A charge before the invoice minimum age is deferred and does not use a retry

Speed is set in `.env` in this order. The slowest limit wins. Restart the worker after a change.

| Order | Variable | Default | Role |
| --- | --- | --- | --- |
| 1 | `QUEUE_CONSUMERS` | 2 | Listeners per queue. Does not multiply prefetch. |
| 2 | `QUEUE_CONCURRENCY` | 12 | Customers held at once. Keep this above the in-flight cap. |
| 3 | `PAYMENT_MAX_IN_FLIGHT` | 8 | Ceiling on payment calls waiting together. Same as data-pipeline's 8 jobs. Drops when responses slow down. |
| 4 | `PAYMENT_REQUEST_GAP_MS` | 125 | Minimum pause between call starts. Same as data-pipeline's Respo pause. Widens when responses slow down. |

Each UPI call waits for the gateway. `API_TIMEOUT=120000`. `BATCH_SIZE` is the MySQL insert size only.

Details and how to go faster or slower: [docs/payment-integration.md](docs/payment-integration.md).

## Email (batch completion)

When a batch finishes, nodemailer sends one report (and `failed.csv` when there are failures) to the uploader and `BATCH_REPORT_EMAIL` (default `akshay.kanherkar@getzype.com`).

Transport order:

1. SMTP (`SMTP_HOST`, `SMTP_PORT`, `EMAIL_ADDRESS`, `EMAIL_PASSWORD`) — same shape as loan-service
2. SES (`AWS_ACCESS_KEY_ID_SES`, `AWS_SECRET_ACCESS_KEY_SES`, `AWS_REGION`, `FROM_EMAIL_ADDRESS`)
3. Log stub when `EMAIL_ENABLED` is false or neither transport is configured

## Config

`.env.example` is grouped in the same order as a running batch: app, databases, worker speed, files, login, payment-service, email. Copy it to `.env` and restart the API and the worker after edits.

```bash
npm test
```
