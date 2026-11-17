import { object } from './model.ts';

/** Only explicit provider totals are accepted; never sum prices or infer a bill. */
export function parseMonthlyBilling(value: unknown, cycleStart: string, cycleEnd: string) {
  const data = object(object(value).data), cycle = object(data.usageCycle);
  const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 999999;
  if (typeof cycle.startAt !== 'string' || typeof cycle.endAt !== 'string' ||
      Date.parse(cycle.startAt) !== Date.parse(cycleStart) || Date.parse(cycle.endAt) !== Date.parse(cycleEnd) ||
      !amount(data.totalUsageCreditsUsdBeforeVolumeDiscount) || !amount(data.totalUsageCreditsUsdAfterVolumeDiscount) ||
      !data.monthlyServiceUsage || typeof data.monthlyServiceUsage !== 'object' || Array.isArray(data.monthlyServiceUsage)) throw new Error('Monthly usage unverified');
  const services = Object.entries(data.monthlyServiceUsage);
  if (services.length > 100) throw new Error('Monthly service limit');
  const serviceAmounts: Record<string, number | null> = {};
  for (const [name, raw] of services) {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name)) throw new Error('Monthly service invalid');
    const row = object(raw), reported = row.amountAfterVolumeDiscountUsd;
    if (reported !== undefined && reported !== null && !amount(reported)) throw new Error('Monthly service invalid');
    serviceAmounts[name] = amount(reported) ? reported : null;
  }
  return { beforeDiscountUsd: data.totalUsageCreditsUsdBeforeVolumeDiscount, afterDiscountUsd: data.totalUsageCreditsUsdAfterVolumeDiscount, serviceAmounts };
}
