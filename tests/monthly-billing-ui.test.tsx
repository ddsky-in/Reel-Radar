import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { safeApifyAccounts } from '../src/lib/server/public-data';
import { ApifyAccountsSummary } from '../src/components/apify-accounts';
const fixture = () => ({ accounts: [1,2,3,4,5].map(slot => ({ slot, enabled: true, configured: true, reason: null,
  usage_usd: 1, limit_usd: 5, usage_checked_at: '2026-11-16T00:00:00Z', cycle_end_at: '2026-12-01T00:00:00Z', reserved_usd: .1, unreconciled_jobs: 0,
  monthly_report: { source: 'apify_monthly_usage', cycle_start_at: '2026-11-01T00:00:00Z', cycle_end_at: '2026-12-01T00:00:00Z', checked_at: '2026-11-16T00:00:00Z',
    before_discount_usd: 2, after_discount_usd: 1, service_amounts: { STORAGE: null }, token: 'must-not-return' } })), ready_accounts: 5,
  capacity: { occupied_slots: 0, uncertain_slots: 0, max_active: 3, paid_starts_gated: true } });
describe('provider billing presentation', () => {
  it('preserves the gate and provider report without exposing unapproved metadata', () => {
    const safe = safeApifyAccounts(fixture());
    expect(safe.capacity?.paid_starts_gated).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('must-not-return');
    const html = renderToStaticMarkup(<ApifyAccountsSummary value={safe}/>);
    for (const label of ['Paid collection is gated', 'Reserved · not billed', 'Usage credits after volume discounts', 'STORAGE: Unknown', 'not a final invoice']) expect(html).toContain(label);
  });
  it('rejects invalid provider totals rather than rendering a zero bill', () => {
    const value = fixture(); value.accounts[0].monthly_report.after_discount_usd = -1;
    expect(() => safeApifyAccounts(value)).toThrow();
  });
});
