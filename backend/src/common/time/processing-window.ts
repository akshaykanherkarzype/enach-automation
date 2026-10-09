import { istDateString, istParts, istWallClockToUtc, startOfNextIstDay } from './ist.js';

/** Inclusive start minute, exclusive end minute, within a single IST day. */
export interface PeakWindow {
  startMinute: number;
  endMinute: number;
}

const WINDOW_PATTERN = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

export function parsePeakWindows(raw: string): PeakWindow[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'none') return [];

  return trimmed.split(',').map((part) => {
    const token = part.trim();
    const match = WINDOW_PATTERN.exec(token);
    if (!match) {
      throw new Error(
        `Invalid PEAK_WINDOWS_IST entry "${token}". Use HH:mm-HH:mm, for example 10:00-13:00,17:00-22:00`,
      );
    }
    const startHour = Number(match[1]);
    const startMin = Number(match[2]);
    const endHour = Number(match[3]);
    const endMin = Number(match[4]);
    if (startHour > 23 || endHour > 24 || startMin > 59 || endMin > 59) {
      throw new Error(`Invalid clock time in peak window "${token}"`);
    }
    const startMinute = startHour * 60 + startMin;
    const endMinute = endHour * 60 + endMin;
    if (startMinute >= endMinute || endMinute > 24 * 60) {
      throw new Error(
        `Peak window "${token}" must start and end on the same IST day, with end after start`,
      );
    }
    return { startMinute, endMinute };
  });
}

export function peakDeferDelayMs(now: Date, windows: PeakWindow[]): number {
  const parts = istParts(now);
  const minute = parts.hour * 60 + parts.minute;
  const active = windows.find((w) => minute >= w.startMinute && minute < w.endMinute);
  if (!active) return 0;

  const day = istDateString(now);
  const resume = istWallClockToUtc(
    day,
    Math.floor(active.endMinute / 60),
    active.endMinute % 60,
  );
  return Math.max(0, resume.getTime() - now.getTime());
}

export type InvoiceGate =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Invoice generation for a batch stays on its IST processing day.
 * A queue message that arrives the next day, or inside the midnight buffer, is refused.
 */
export function invoiceCallGate(
  now: Date,
  anchorDay: string,
  dayEndBufferMs: number,
): InvoiceGate {
  const today = istDateString(now);
  if (today !== anchorDay) {
    return {
      ok: false,
      reason:
        `INVOICE_DAY_CHANGED anchor=${anchorDay} today=${today}. ` +
        `This invoice batch belongs to ${anchorDay} IST and was not sent on ${today}.`,
    };
  }

  const deadline = startOfNextIstDay(now).getTime() - Math.max(0, dayEndBufferMs);
  if (now.getTime() >= deadline) {
    return {
      ok: false,
      reason:
        `INVOICE_DAY_END_BUFFER ${dayEndBufferMs}ms. ` +
        'Refused near IST midnight so an invoice call cannot land on the next day.',
    };
  }

  return { ok: true };
}

/**
 * Milliseconds still available today, outside peak windows and before the midnight buffer.
 */
export function remainingCallableMs(
  now: Date,
  windows: PeakWindow[],
  dayEndBufferMs: number,
): number {
  const startMs = now.getTime();
  const midnight = startOfNextIstDay(now).getTime();
  const deadline = midnight - Math.max(0, dayEndBufferMs);
  if (deadline <= startMs) return 0;

  const day = istDateString(now);
  const sorted = [...windows].sort((a, b) => a.startMinute - b.startMinute);
  const callable: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const window of sorted) {
    if (window.startMinute > cursor) {
      callable.push({ start: cursor, end: window.startMinute });
    }
    cursor = Math.max(cursor, window.endMinute);
  }
  if (cursor < 24 * 60) {
    callable.push({ start: cursor, end: 24 * 60 });
  }

  let total = 0;
  for (const segment of callable) {
    const segmentStart = istWallClockToUtc(
      day,
      Math.floor(segment.start / 60),
      segment.start % 60,
    ).getTime();
    const segmentEnd =
      segment.end === 24 * 60
        ? midnight
        : istWallClockToUtc(
            day,
            Math.floor(segment.end / 60),
            segment.end % 60,
          ).getTime();
    const from = Math.max(segmentStart, startMs);
    const to = Math.min(segmentEnd, deadline);
    if (to > from) total += to - from;
  }
  return total;
}

export interface SameDayFit {
  ok: boolean;
  remainingMs: number;
  capacity: number;
  neededMs: number;
  perCallMs: number;
}

/**
 * Estimate whether every createInvoice call can be placed before the IST day ends.
 * Throughput is the slower of the start gap and (ack budget / calls in flight).
 */
export function invoiceBatchFitsToday(input: {
  recordCount: number;
  now: Date;
  windows: PeakWindow[];
  dayEndBufferMs: number;
  gapMs: number;
  callBudgetMs: number;
  maxInFlight: number;
}): SameDayFit {
  const parallel = Math.max(1, input.maxInFlight);
  const perCallMs = Math.max(1, input.gapMs, Math.ceil(input.callBudgetMs / parallel));
  const remainingMs = remainingCallableMs(input.now, input.windows, input.dayEndBufferMs);
  const capacity = Math.floor(remainingMs / perCallMs);
  const neededMs = input.recordCount * perCallMs;
  return {
    ok: input.recordCount <= capacity,
    remainingMs,
    capacity,
    neededMs,
    perCallMs,
  };
}
