/** Calendar-only values stay in YYYY-MM-DD form; no browser timezone conversion. */
export function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function todayInIndia(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function shiftCalendarDate(value: string, days: number): string {
  const date = calendarDate(value);
  if (!date) throw new Error('A valid calendar date is required.');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function shiftCalendarMonth(value: string, months: number): string {
  const date = calendarDate(value);
  if (!date) throw new Error('A valid calendar date is required.');
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(date.getTime());
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, last.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

export function calendarDays(month: string): string[] {
  const first = `${month.slice(0, 7)}-01`;
  const date = calendarDate(first);
  if (!date) throw new Error('A valid calendar month is required.');
  // Monday is the first column, including adjacent month dates for a stable grid.
  const start = shiftCalendarDate(first, -((date.getUTCDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => shiftCalendarDate(start, index));
}

export function calendarDateAllowed(value: string, min?: string, max?: string): boolean {
  return Boolean(calendarDate(value)) && (!min || value >= min) && (!max || value <= max);
}
