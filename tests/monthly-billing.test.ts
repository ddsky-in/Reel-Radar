import { describe, expect, it } from 'vitest';
const { parseMonthlyBilling } = await import('../supabase/functions/_shared/monthly-billing.ts' as string);
const start = '2026-11-01T00:00:00Z', end = '2026-12-01T00:00:00Z';
const report = () => ({ data: { usageCycle: { startAt: start, endAt: end }, totalUsageCreditsUsdBeforeVolumeDiscount: 2,
  totalUsageCreditsUsdAfterVolumeDiscount: 1.5, monthlyServiceUsage: { ACTOR_COMPUTE_UNITS: { amountAfterVolumeDiscountUsd: .5 }, STORAGE: {} } } });
describe('provider monthly billing evidence', () => {
  it('preserves explicit totals and unknown service costs without summing a bill', () => {
    expect(parseMonthlyBilling(report(), start, end)).toEqual({ beforeDiscountUsd: 2, afterDiscountUsd: 1.5, serviceAmounts: { ACTOR_COMPUTE_UNITS: .5, STORAGE: null } });
  });
  it.each([null, undefined, -1, NaN, Infinity])('rejects missing or invalid provider total %s', amount => {
    const value = report(); Object.assign(value.data, { totalUsageCreditsUsdAfterVolumeDiscount: amount });
    expect(() => parseMonthlyBilling(value, start, end)).toThrow();
  });
  it('rejects a different billing cycle', () => {
    expect(() => parseMonthlyBilling(report(), '2026-10-01T00:00:00Z', end)).toThrow();
  });
});
