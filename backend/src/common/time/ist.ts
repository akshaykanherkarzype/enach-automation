/** India Standard Time is a fixed UTC+05:30 offset (no daylight saving). */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export interface IstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function istParts(date: Date): IstParts {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

export function istDateString(date: Date): string {
  const p = istParts(date);
  const month = String(p.month).padStart(2, '0');
  const day = String(p.day).padStart(2, '0');
  return `${p.year}-${month}-${day}`;
}

/** Convert an IST wall-clock time on `yyyy-mm-dd` to a UTC instant. */
export function istWallClockToUtc(
  date: string,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const [year, month, day] = date.split('-').map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(asUtc - IST_OFFSET_MS);
}

export function startOfNextIstDay(now: Date): Date {
  const [year, month, day] = istDateString(now).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
  const nextDate = [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, '0'),
    String(next.getUTCDate()).padStart(2, '0'),
  ].join('-');
  return istWallClockToUtc(nextDate, 0, 0);
}

/**
 * Calendar day the batch is anchored to.
 * Prefer the value stored when the batch started so a restart cannot move the anchor.
 */
export function batchAnchorDay(
  processingDay: string | null | undefined,
  startedAt: Date | null | undefined,
  now: Date,
): string {
  if (processingDay && /^\d{4}-\d{2}-\d{2}$/.test(processingDay)) {
    return processingDay;
  }
  if (startedAt) return istDateString(startedAt);
  return istDateString(now);
}
