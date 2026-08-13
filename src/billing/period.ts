/**
 * Calendar arithmetic for billing.
 *
 * Every boundary here is a DATE in the property's timezone, never an instant.
 * "Rent is due on the 5th" is a calendar fact: generating from UTC would post
 * charges hours early for a Pittsburgh property and levy late fees before the
 * grace period actually elapsed. All of this is pure so it can be tested
 * without a clock or a database.
 */

/** A calendar month of billing, e.g. { year: 2026, month: 9 }. */
export interface BillingPeriod {
  year: number;
  /** 1-12, not zero-based — this is a human calendar month, not a JS one. */
  month: number;
}

/** YYYY-MM, used to build idempotency keys. */
export function periodKey(period: BillingPeriod): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

/** Dates are stored as @db.Date; UTC midnight keeps them from drifting a day. */
export function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

export function daysInMonth(period: BillingPeriod): number {
  return new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
}

export function periodStart(period: BillingPeriod): Date {
  return utcDate(period.year, period.month, 1);
}

export function periodEnd(period: BillingPeriod): Date {
  return utcDate(period.year, period.month, daysInMonth(period));
}

/**
 * The calendar date at `instant` in `timeZone`, as YYYY-MM-DD.
 *
 * Intl is used rather than a date library because it carries the IANA database
 * and handles DST transitions correctly, which naive offset math does not.
 */
export function localDateString(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is what we want and is stable.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function localPeriod(instant: Date, timeZone: string): BillingPeriod {
  const [year, month] = localDateString(instant, timeZone).split("-").map(Number);
  return { year: year!, month: month! };
}

/** Parses YYYY-MM-DD into a UTC-midnight Date. */
export function parseDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return utcDate(y!, m!, d!);
}

export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Whole days from `a` to `b`, inclusive of both endpoints. */
export function inclusiveDayCount(a: Date, b: Date): number {
  if (b.getTime() < a.getTime()) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * The due date for a period, clamped to the month length.
 *
 * `rent_due_day` is constrained to 1-28 in the schema precisely so this cannot
 * silently skip February, but the clamp stays as a second line of defence.
 */
export function dueDateFor(period: BillingPeriod, dueDay: number): Date {
  return utcDate(period.year, period.month, Math.min(dueDay, daysInMonth(period)));
}

export interface Occupancy {
  startsOn: Date;
  /** null means open-ended. */
  endsOn: Date | null;
}

/**
 * Days of `period` covered by `occupancy`, and whether that is the whole month.
 * This is what drives proration for mid-month move-ins and move-outs.
 */
export function occupiedDays(
  period: BillingPeriod,
  occupancy: Occupancy,
): { days: number; total: number; partial: boolean } {
  const start = periodStart(period);
  const end = periodEnd(period);
  const total = daysInMonth(period);

  const from = maxDate(start, occupancy.startsOn);
  const to = occupancy.endsOn ? minDate(end, occupancy.endsOn) : end;

  const days = inclusiveDayCount(from, to);
  return { days, total, partial: days > 0 && days < total };
}

/** Days of overlap between an arbitrary window and an occupancy. */
export function overlapDays(
  windowStart: Date,
  windowEnd: Date,
  occupancy: Occupancy,
): number {
  const from = maxDate(windowStart, occupancy.startsOn);
  const to = occupancy.endsOn ? minDate(windowEnd, occupancy.endsOn) : windowEnd;
  return inclusiveDayCount(from, to);
}
