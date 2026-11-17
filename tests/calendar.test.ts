import { describe, expect, it } from 'vitest';
import { calendarDate, calendarDateAllowed, calendarDays, shiftCalendarDate, shiftCalendarMonth, todayInIndia } from '../src/lib/calendar';

describe('calendar values and boundaries', () => {
  it('keeps date-only values stable and rejects rolled or malformed dates', () => {
    expect(calendarDate('2028-02-29')?.toISOString()).toBe('2028-02-29T12:00:00.000Z');
    for (const value of ['2026-02-29', '2026-11-31', '11/09/2026', '2026-1-1', '']) expect(calendarDate(value)).toBeNull();
  });
  it('uses the IST calendar day across the UTC midnight boundary', () => {
    expect(todayInIndia(new Date('2026-11-09T18:29:59Z'))).toBe('2026-11-09');
    expect(todayInIndia(new Date('2026-11-09T18:30:00Z'))).toBe('2026-11-10');
  });
  it('moves through leap days and clamps month navigation to the last valid day', () => {
    expect(shiftCalendarDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftCalendarDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftCalendarMonth('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftCalendarMonth('2028-03-31', -1)).toBe('2028-02-29');
    expect(shiftCalendarMonth('2028-02-29', 12)).toBe('2029-02-28');
  });
  it('includes adjacent month days without allowing selections outside min/max', () => {
    const days = calendarDays('2026-11');
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2026-10-26');
    expect(days.at(-1)).toBe('2026-12-06');
    expect(calendarDateAllowed('2026-11-09', '2026-11-09', '2026-11-10')).toBe(true);
    expect(calendarDateAllowed('2026-11-08', '2026-11-09')).toBe(false);
    expect(calendarDateAllowed('2026-11-11', undefined, '2026-11-10')).toBe(false);
    expect(calendarDateAllowed('2026-02-29')).toBe(false);
  });
});
