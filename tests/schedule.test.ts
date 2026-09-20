import test from 'node:test';
import assert from 'node:assert/strict';
import { iso, nextDayOfMonth, scheduleFor } from '../src/core/schedule.ts';

const at = (s: string) => Math.floor(Date.parse(s) / 1000);

test('monthly lands on the same day of month, not every 30.44 days', () => {
  const start = at('2026-10-01T12:00:00Z');
  const times = scheduleFor(start, 'monthly', 14).map(iso);
  assert.equal(times[0], '2026-10-01T12:00:00Z');
  assert.equal(times[1], '2026-11-01T12:00:00Z');
  assert.equal(times[3], '2027-01-01T12:00:00Z', 'must cross the year boundary');
  assert.equal(times[12], '2027-10-01T12:00:00Z');
  assert.ok(times.every((t) => t.slice(8, 10) === '01'), 'every buy on the 1st');
});

test('a 4-year monthly plan produces 48 distinct increasing dates', () => {
  const times = scheduleFor(at('2026-10-01T12:00:00Z'), 'monthly', 48);
  assert.equal(times.length, 48);
  assert.equal(new Set(times).size, 48);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! > times[i - 1]!);
  assert.equal(iso(times[47]!), '2030-09-01T12:00:00Z');
});

test('day 31 clamps to the end of short months instead of slipping', () => {
  const times = scheduleFor(at('2027-01-31T12:00:00Z'), 'monthly', 4).map(iso);
  assert.equal(times[0], '2027-01-31T12:00:00Z');
  assert.equal(times[1], '2027-02-28T12:00:00Z', 'February must clamp, not roll into March');
  assert.equal(times[2], '2027-03-31T12:00:00Z', 'and must not stay clamped afterwards');
  assert.equal(times[3], '2027-04-30T12:00:00Z');
});

test('February 29 in a leap year', () => {
  const times = scheduleFor(at('2028-01-29T12:00:00Z'), 'monthly', 2).map(iso);
  assert.equal(times[1], '2028-02-29T12:00:00Z');
});

test('daily and weekly are plain fixed strides', () => {
  const s = at('2026-10-01T00:00:00Z');
  assert.equal(scheduleFor(s, 'daily', 3)[2]! - s, 2 * 86_400);
  assert.equal(scheduleFor(s, 'weekly', 3)[2]! - s, 2 * 604_800);
});

test('nextDayOfMonth is strictly in the future', () => {
  const now = at('2026-09-20T12:00:00Z');
  assert.equal(iso(nextDayOfMonth(now, 1)), '2026-10-01T12:00:00Z');
  // Asking on the 1st gives next month's 1st, never today.
  assert.equal(iso(nextDayOfMonth(at('2026-10-01T12:00:00Z'), 1)), '2026-11-01T12:00:00Z');
  assert.throws(() => nextDayOfMonth(now, 32), /bad day/);
});

test('rejects nonsense period counts', () => {
  assert.throws(() => scheduleFor(at('2026-10-01T12:00:00Z'), 'monthly', 0), /bad period/);
  assert.throws(() => scheduleFor(at('2026-10-01T12:00:00Z'), 'monthly', 1.5), /bad period/);
});
