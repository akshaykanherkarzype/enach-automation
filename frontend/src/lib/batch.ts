export const TERMINAL_BATCH_STATUSES = [
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'FAILED',
  'CANCELLED',
] as const;

export const SOCKET_FALLBACK_MS = 15_000;

export function isBatchLive(status?: string | null): boolean {
  return Boolean(status) && !TERMINAL_BATCH_STATUSES.includes(status as (typeof TERMINAL_BATCH_STATUSES)[number]);
}

export function apiMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err && 'response' in err) {
    const message = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
    if (message) return message;
  }
  return fallback;
}

export function formatIst(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const formatted = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${formatted} IST`;
}

export function formatDuration(ms?: number | null): string {
  if (ms == null || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

export function formatCount(value?: number | null): string {
  return new Intl.NumberFormat('en-IN').format(value ?? 0);
}

/** Saved name: module, batch id, failed, and the batch's IST day. */
export function failedDownloadName(batch: {
  id: string;
  module: string;
  processingDay?: string | null;
  completedAt?: string | null;
  uploadedAt?: string | null;
}): string {
  const moduleSlug = batch.module === 'INVOICE_CHARGE' ? 'invoice-charge' : 'invoice-generation';
  const fromClock = istDay(batch.completedAt || batch.uploadedAt || '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(batch.processingDay ?? '')
    ? batch.processingDay
    : fromClock || 'undated';
  return `${moduleSlug}_batch-${batch.id}_failed_${day}.csv`;
}

function istDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return parts;
}

/** Stays below 100 until every customer is accepted or failed. */
export function completionPercent(done: number, total: number): number {
  if (!total || total < 0) return 0;
  if (done >= total) return 100;
  return Math.floor((done / total) * 100);
}
