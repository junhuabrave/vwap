/** Turning a cadence into concrete execution timestamps. */
import type { Cadence } from './types.ts';

export const SECONDS = { daily: 86_400, weekly: 604_800, monthly: 2_629_746 } as const;

/**
 * Execution times for a plan.
 *
 * Monthly means "the same day-of-month each month", not "every 30.44 days".
 * A plan that says the 1st must land on the 1st, and calendar months are not
 * equal lengths. Day-of-month values past the end of a short month clamp to the
 * last day, so the 31st becomes Feb 28 rather than silently slipping to Mar 3.
 */
export function scheduleFor(startAt: number, cadence: Cadence, periods: number): number[] {
  if (!Number.isInteger(periods) || periods <= 0) throw new RangeError(`bad period count: ${periods}`);
  if (!Number.isFinite(startAt) || startAt < 0) throw new RangeError(`bad start time: ${startAt}`);

  if (cadence !== 'monthly') {
    const step = SECONDS[cadence];
    return Array.from({ length: periods }, (_, i) => startAt + i * step);
  }

  const start = new Date(startAt * 1000);
  const dom = start.getUTCDate();
  const out: number[] = [];
  for (let i = 0; i < periods; i++) {
    const y = start.getUTCFullYear();
    const m = start.getUTCMonth() + i;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const d = Math.min(dom, lastDay);
    out.push(
      Math.floor(
        Date.UTC(y, m, d, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()) / 1000,
      ),
    );
  }
  return out;
}

/** Next occurrence of a day-of-month at a given UTC hour, strictly after `from`. */
export function nextDayOfMonth(from: number, dayOfMonth: number, utcHour = 12): number {
  if (dayOfMonth < 1 || dayOfMonth > 31) throw new RangeError(`bad day of month: ${dayOfMonth}`);
  const d = new Date(from * 1000);
  for (let i = 0; i < 3; i++) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + i;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const t = Math.floor(Date.UTC(y, m, Math.min(dayOfMonth, lastDay), utcHour) / 1000);
    if (t > from) return t;
  }
  throw new Error('unreachable: no future date found');
}

export const iso = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().replace('.000', '');
