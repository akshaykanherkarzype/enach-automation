# Startup

Start the infrastructure once, then run the API, the worker, and the frontend in three terminals.

## 1. Infrastructure

```bash
cd "/home/akshay/Desktop/Zype/E-Nach UPI/E-Nach"
docker compose up -d
```

| Service | URL |
| --- | --- |
| MySQL | `127.0.0.1:3307` |
| Redis | `127.0.0.1:6380` |
| RabbitMQ | `127.0.0.1:5673` (UI http://localhost:15673, user `batch` / `batch`) |
| MinIO | http://localhost:9000 (console http://localhost:9001, `minioadmin` / `minioadmin`) |

## 2. Backend API

Terminal 1:

```bash
cd "/home/akshay/Desktop/Zype/E-Nach UPI/E-Nach/backend"
npx prisma migrate deploy
npm run dev
```

- API: http://localhost:4000
- Swagger: http://localhost:4000/docs

## 3. Backend worker

Terminal 2. The worker sends the invoice and charge calls. Without it, a confirmed file stays queued.

```bash
cd "/home/akshay/Desktop/Zype/E-Nach UPI/E-Nach/backend"
npm run dev:worker
```

The log line `Workers ready` means it is listening.

With `PAYMENT_CLIENT=http`, the worker keeps 8 payment calls in flight and waits 125ms between starts, the same load data-pipeline sends. Restart the worker after changing those values in `.env`.

## 4. Frontend

Terminal 3:

```bash
cd "/home/akshay/Desktop/Zype/E-Nach UPI/E-Nach/frontend"
npm run dev
```

- Dashboard: http://localhost:5173
- Login: `admin@zype.local` / `password`

Other dev users (same password): `uploader@zype.local` (view and upload), `viewer@zype.local` (view only).

## Run a file

1. In `backend/.env`, `PAYMENT_CLIENT=mock` uses the local stub. Set `PAYMENT_CLIENT=http` and `PAYMENT_SERVICE_BASE_URL` for the real payment-service. Restart the worker after that change.
2. On the dashboard, open **Invoice Generation** or **Invoice Charge**.
3. Upload a CSV or XLSX. The required headers are `customer_id` and `final_nach_amount`. Casing and spaces do not matter (`Final_nach_amount` is accepted). Extra columns are ignored.
4. Check the summary (valid, duplicate, invalid), then confirm.
5. Open the batch. Status moves from `PROCESSING` to `COMPLETED`, `PARTIAL_SUCCESS`, or `FAILED`. Each row is `PENDING`, `PROCESSING`, `SUCCESS`, or `FAILED`.
6. The worker log shows one line per customer: success, retry, or deferred during peak hours (10:00–13:00 and 17:00–22:00 IST).
7. When the batch finishes, a mail goes to the uploader and `BATCH_REPORT_EMAIL`.

## If the service stops

| When it stopped | What to do |
| --- | --- |
| During upload, before the token comes back | Upload the file again. Nothing was saved. |
| After upload, before confirm, and the API was restarted | Upload again. The token was only in memory. |
| After confirm, while calls are running | Start `npm run dev:worker` again. Do not upload the same file. Customers already `SUCCESS` are not called again. A customer whose call was in progress may be called once more. |

A second file for the same module stays blocked until the running batch finishes.

## How to tell it is working

- API Swagger opens at http://localhost:4000/docs.
- Worker log contains `Workers ready`.
- Dashboard batch status changes and the success count increases.
- RabbitMQ UI (http://localhost:15673) shows the queue draining.
- A completion mail arrives when the batch reaches a final status.
