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

/** Stays below 100 until every customer is accepted or failed. */
export function completionPercent(done: number, total: number): number {
  if (!total || total < 0) return 0;
  if (done >= total) return 100;
  return Math.floor((done / total) * 100);
}
