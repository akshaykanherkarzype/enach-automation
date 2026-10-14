import { env } from '../../common/config/env.js';

export const CANCEL_UNPAID_PATH = '/payment-service/api/v2/bulk/autopay/cancelUnpaidInvoices';

export interface CancelUnpaidRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: '[]';
}

export function cancelUnpaidRequest(baseUrl: string, apiKey: string): CancelUnpaidRequest {
  const base = baseUrl.trim().replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = apiKey.trim();
  if (key) headers['x-api-key'] = key;
  return {
    url: `${base}${CANCEL_UNPAID_PATH}`,
    method: 'POST',
    headers,
    body: '[]',
  };
}

export interface CancelUnpaidResult {
  ok: boolean;
  message: string;
  body: Record<string, unknown>;
}

export function interpretCancelUnpaid(statusCode: number, body: unknown): CancelUnpaidResult {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const providerStatus = String(record.status ?? '').toLowerCase();
  const message = typeof record.message === 'string' && record.message.trim() ? record.message : '';
  const ok = statusCode >= 200 && statusCode < 300 && providerStatus === 'success';
  return {
    ok,
    message: message || (ok ? 'Old unpaid invoices were cancelled.' : 'Payment service did not cancel unpaid invoices.'),
    body: record,
  };
}

export async function postCancelUnpaid(fetchFn: typeof fetch = fetch): Promise<CancelUnpaidResult> {
  const request = cancelUnpaidRequest(env.PAYMENT_SERVICE_BASE_URL, env.X_API_KEY);
  if (!env.PAYMENT_SERVICE_BASE_URL.trim()) {
    return { ok: false, message: 'Payment service URL is not configured.', body: {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.API_TIMEOUT);
  try {
    const response = await fetchFn(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { message: text.slice(0, 500) };
      }
    }
    return interpretCancelUnpaid(response.status, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Payment service did not respond.';
    return { ok: false, message, body: {} };
  } finally {
    clearTimeout(timer);
  }
}
