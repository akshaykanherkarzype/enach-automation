# Payment-service integration

Workers call the synchronous UPI autopay routes. Each call carries **one** customer.

## Routes

| Module | Method and path | Body |
| --- | --- | --- |
| Invoice generation | `POST /payment-service/api/v2/upi/autopay/invoice` | `{ "customerId": 10188945, "amount": 7068 }` |
| Invoice charge | `POST /payment-service/api/v2/upi/autopay/charge` | `{ "customerId": 10188946, "amount": 7066 }` |

`PAYMENT_SERVICE_BASE_URL` is the origin only (`http://payment-service:3000`). The client appends the path.

Set `PAYMENT_CLIENT=http`. `PAYMENT_CLIENT=mock` keeps the local stub and does not apply the in-flight cap, the gap, or peak hours.

The body is an object. An array is rejected by payment-service as `INVALID_REQUEST_FORMAT` with `retryable: false`.

## Success

payment-service finishes the gateway call before it answers. HTTP 200 with `status: "success"` and `retryable: false` is success:

- invoice created: `AUTOPAY_INVOICE_CREATED_SUCCESSFULLY`
- unpaid invoice already exists: `AUTOPAY_INVOICE_ALREADY_CREATED`
- charge created: `AUTOPAY_CHARGE_CREATED_SUCCESSFULLY`

An existing unpaid invoice is success. The route does not cancel older invoices.

## Retries

payment-service sets `retryable` on every UPI response. The worker follows that flag.

Retried (`retryable: true`), up to `MAX_RETRY` with `RETRY_DELAYS_MS` (default 5s, 30s, 2m):

- gateway failure: `CANNOT_CREATE_AUTOPAY_INVOICE`, `CANNOT_CHARGE_SUBSCRIPTION_PLAN`
- an unexpected throw inside payment-service (HTTP 400 with `retryable: true`)

Not retried (`retryable: false`). The item is failed once:

- invalid body (`INVALID_REQUEST_FORMAT`, `CUSTOMER_ID_NOT_PROVIDED`, `INVALID_CUSTOMER_ID`, `PAYMENT_AMOUNT_NOT_PROVIDED`)
- `NO_ACTIVE_AUTOPAY_SUBSCRIPTION_FOUND`
- `NO_UNPAID_INVOICES_FOUND_TO_CHARGE`

A dropped connection, a timeout, or HTTP 5xx with no `retryable` field (a proxy `502` is the usual case) is checked with `GET /payment-service/api/v2/healthCheck`.

- Health returns HTTP 200 and `{ "status": "UP" }`: the process is serving, so the customer is retried on the normal schedule and the attempt counts toward `MAX_RETRY`.
- Health is not `UP`, or the probe itself fails: the customer is queued again after 30 seconds. That wait does not use a retry, so an outage cannot fail the row after three attempts.

HTTP 429 is payment-service's rate limit (25,000 requests per IP per minute). The customer is queued again for the `Retry-After` time, or 62 seconds when that header is missing. That wait does not use a retry, and every worker drops to one call at a time until the window passes. A bare HTTP 400 without the flag is not retried. A body that already sets `retryable` is followed as-is and is not sent to the health check. The health probe is cached for 5 seconds so a burst of failures shares one `GET /payment-service/api/v2/healthCheck`.

`INVOICE_NOT_READY_FOR_CHARGE` is `retryable: true` because the invoice is younger than `MINIMUM_CHARGE_DIFF_HRS` (default 36). The short retry schedule cannot wait that long, so the worker defers the item and does not consume a retry. The wait is `(minimumChargeHours - invoiceAndChargeDiffHours)` hours plus 5 minutes, taken from the response `data`.

## How fast a batch runs

Set these in `backend/.env` in this order. Restart the worker after a change. They apply when `PAYMENT_CLIENT=http`. `mock` ignores the in-flight cap, the gap, and peak hours.

| Order | Variable | What it does | Default |
| --- | --- | --- | --- |
| 1 | `QUEUE_CONSUMERS` | Listeners started on each queue. Invoice and charge share one RabbitMQ connection, so 2 does not multiply concurrency. | 2 |
| 2 | `QUEUE_CONCURRENCY` | Customers this worker may hold at once (RabbitMQ prefetch). Keep it a little above `PAYMENT_MAX_IN_FLIGHT`. | 12 |
| 3 | `PAYMENT_MAX_IN_FLIGHT` | Ceiling on how many customers may be waiting on the gateway at once. Matches data-pipeline's 8 parallel jobs. The worker uses fewer when response time rises. | 8 |
| 4 | `PAYMENT_REQUEST_GAP_MS` | Minimum pause between call starts. Matches data-pipeline's 125ms Respo pause. The worker widens this when response time rises. | 125 |

`PAYMENT_ADAPTIVE=true` (the default) shares one pace across workers. The first calls learn a normal response time. When the moving average stays at least twice that normal, in-flight calls are cut in half and the gap doubles. At four times normal, only one call runs and the gap opens to its widest: the larger of 2 seconds and 16 times `PAYMENT_REQUEST_GAP_MS`, and never more than 10 seconds. With the current 125ms gap that widest pause is 2 seconds. When response time comes back, one call is added every 20 seconds until the ceiling of 8 is reached. `PAYMENT_ADAPTIVE=false` keeps 8 in flight and the 125ms gap fixed.

Calls per second is the smaller of:

- `1000 / PAYMENT_REQUEST_GAP_MS`
- `PAYMENT_MAX_IN_FLIGHT / seconds the gateway call takes`

`API_TIMEOUT` (default 120000, 2 minutes) is how long one call may wait for the gateway result. A shorter limit aborts with `The operation was aborted due to timeout` and that timeout is retried.

## Peak hours

Calls are not sent during these IST windows (default):

- 10:00–13:00
- 17:00–22:00

The item stays pending (or retrying, if it already failed once) and is queued for the moment the window ends. Change the windows with `PEAK_WINDOWS_IST`. Set `PEAK_WINDOWS_IST=none` to send at any hour. Windows must start and end on the same IST day.

Peak-hour deferral does not consume a retry. A charge that is not yet 36 hours old is deferred the same way.

## Email

Notices go to the uploader and `BATCH_REPORT_EMAIL`. A pause or resume is sent **once per batch per episode**, not once per customer. Redis remembers the episode for 48 hours. If sending fails, the claim is released so a later customer can send it.

| When | Subject | What it reports |
| --- | --- | --- |
| First HTTP 502, timeout, or dropped connection while `/healthCheck` is not UP | Paused — payment-service unavailable | Accepted, failed, and remaining. Waiting customers are not failed. |
| The next call after that outage, once payment-service answers again | Resumed — payment-service is back | The same counts, after processing has started again. |
| First customer held for a peak window | Paused — peak hours | Accepted, failed, remaining, and the IST time calls resume. |
| First customer allowed through after that window | Resumed — peak hours ended | Accepted, failed, and remaining. |
| Every customer is accepted or failed | Completion report, unchanged | Final status, counts, and `failed.csv` when needed. |

A later outage or the next peak window sends a new pair. The completion report is still sent when the batch finishes.

Transport, in order:

1. SMTP when `SMTP_HOST`, `EMAIL_ADDRESS`, and `EMAIL_PASSWORD` are set. This matches loan-service (`port` 465 is implicit TLS, otherwise STARTTLS).
2. SES when `AWS_ACCESS_KEY_ID_SES`, `AWS_SECRET_ACCESS_KEY_SES`, and `AWS_REGION` are set.
3. Log-only stub when `EMAIL_ENABLED` is false or neither transport is configured.

Failed customers are attached as `failed.csv`. The mail states that success means payment-service returned `status: success`.

## Operate

```bash
cd backend
npx prisma migrate deploy
npm test
npm run dev:worker
```

Required when `PAYMENT_CLIENT=http`:

- `PAYMENT_SERVICE_BASE_URL`
- Redis (the call slot)
- a completion-mail transport if operators should be notified

Restart the worker after changing `PAYMENT_CLIENT` or the base URL.
