import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const reconcile = await import('../supabase/functions/reconcile-jobs/index.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111', nonce = '22222222-2222-4222-8222-222222222222';
const tokenNames = ['APIFY_API_TOKEN','APIFY_API_TOKEN_2','APIFY_API_TOKEN_3','APIFY_API_TOKEN_4','APIFY_API_TOKEN_5'];
let env: Record<string, string>, fetcher: ReturnType<typeof vi.fn<typeof fetch>>, violations: string[], failSlot: number | null, monthlyFailSlot: number | null;
let cycles: Map<number, { startAt: string; endAt: string }>;
const request = (body: unknown = { action: 'billing_sync', continuation_budget: 0 }, secret = 'synthetic-internal') => new Request('https://fixture.test', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': secret }, body: JSON.stringify(body) });
const calls = (name: string) => fetcher.mock.calls.filter(([input]) => String(input).endsWith(`/rpc/${name}`));
beforeEach(() => {
  env = { PROVIDER_MODE: 'apify', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    REELRADAR_OWNER_USER_ID: owner, APIFY_ACCOUNT_ID: 'account1', INTERNAL_CRON_SECRET: 'synthetic-internal', SCRAPING_ENABLED: 'false' };
  tokenNames.forEach((name, index) => { env[name] = `synthetic-token${index + 1}`; }); failSlot = null; monthlyFailSlot = null; violations = []; cycles = new Map();
  vi.stubGlobal('Deno', { env: { get: (name: string) => env[name] }, serve: vi.fn() });
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://fixture.supabase.co') {
      const name = url.pathname.split('/').at(-1), args = JSON.parse(String(init?.body));
      if (name === 'worker_accounts') return Response.json([1,2,3,4,5].map(slot => ({ owner_user_id: owner, account_slot: slot,
        provider_user_id: `account${slot}`, enabled: true, authorization_confirmed: true })));
      if (name === 'worker_begin_account_usage') return Response.json({ observation_id: nonce, observed_at: new Date().toISOString() });
      if (['worker_record_usage','worker_record_account_usage','worker_invalidate_account_usage'].includes(String(name))) return Response.json(null);
      if (name === 'worker_record_monthly_billing_report') return Response.json(true);
      if (name === 'worker_claim_billing_reconciliation') return Response.json([1,2].map(slot => ({ reconciliation_token: nonce, job: {
        id: slot === 1 ? owner : nonce, owner_user_id: owner, kind: 'daily', live: true, apify_account_slot: slot, actor_run_id: `run${slot}`,
        expected_actor_id: 'actor', expected_provider_user_id: `account${slot}`, actual_cost_usd: null, provider_terminal_status: 'SUCCEEDED',
      } })));
      if (name === 'worker_reconcile_run_billing_only') return Response.json({ actual_cost_usd: args.p_usage_total_usd });
      violations.push(String(name)); throw new Error('Generic database operation forbidden during explicit sync');
    }
    if (url.origin === 'https://api.apify.com') {
      const slot = Number(new Headers(init?.headers).get('authorization')?.match(/^Bearer synthetic-token(\d)$/)?.[1]);
      expect(slot).toBeGreaterThan(0); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
      if (url.pathname === '/v2/users/me') return Response.json({ data: { id: failSlot === slot ? 'foreign' : `account${slot}`, token: 'must-not-return' } });
      if (url.pathname === '/v2/users/me/limits') {
        const cycle = { startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() }; cycles.set(slot, cycle);
        return Response.json({ data: { monthlyUsageCycle: cycle, current: { monthlyUsageUsd: slot / 100 }, limits: { maxMonthlyUsageUsd: 5 }, private: 'must-not-return' } });
      }
      if (url.pathname === '/v2/users/me/usage/monthly') return Response.json({ data: { usageCycle: cycles.get(slot), monthlyServiceUsage: {},
        totalUsageCreditsUsdBeforeVolumeDiscount: slot / 100, totalUsageCreditsUsdAfterVolumeDiscount: monthlyFailSlot === slot ? undefined : slot / 100 } });
      if (url.pathname.startsWith('/v2/actor-runs/')) return Response.json({ data: { id: `run${slot}`, actId: 'actor', userId: `account${slot}`,
        status: 'SUCCEEDED', defaultDatasetId: `dataset${slot}`, usageTotalUsd: slot === 1 ? .01 : undefined } });
      violations.push(url.pathname); throw new Error('Paid provider operation forbidden');
    }
    violations.push(url.origin); throw new Error('Unintercepted origin forbidden');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { expect(violations).toEqual([]); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('explicit all-five registered accounts billing-only sync', () => {
  it('refreshes all enabled fixedsecrets and bounded completed unbilled runs with no queue/wakes/starts', async () => {
    const waitUntil = vi.fn(); vi.stubGlobal('EdgeRuntime', { waitUntil });
    const response = await reconcile.handler(request()); expect(response.status).toBe(200);
    const text = await response.text(), result = JSON.parse(text).sync;
    expect(result.accounts.map((value: { accountSlot: number; success: boolean }) => [value.accountSlot,value.success])).toEqual([1,2,3,4,5].map(slot => [slot,true]));
    expect(result.runs).toEqual({ checked: 2, reconciled: 1, unknown: 1, failed: 0 }); expect(result.paidStarts).toBe(0);
    for (const secret of [...tokenNames,'synthetic-token','synthetic-service','must-not-return',nonce]) expect(text).not.toContain(secret);
    expect(waitUntil).not.toHaveBeenCalled(); expect(calls('worker_claim_billing_reconciliation')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/users/me'))).toHaveLength(5);
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/users/me/limits'))).toHaveLength(5);
    expect(calls('worker_record_monthly_billing_report')).toHaveLength(5);
    expect(result.accounts.every((account: { monthlyReportSyncedAt: string | null }) => account.monthlyReportSyncedAt !== null)).toBe(true);
  });
  it('keeps verified limits when monthly metadata is missing without persisting an invented zero', async () => {
    monthlyFailSlot = 3;
    const result = (await (await reconcile.handler(request())).json()).sync;
    expect(result.accounts[2]).toMatchObject({ success: true, error: null, monthlyReportSyncedAt: null, monthlyReportError: 'monthly_report_unavailable' });
    expect(calls('worker_record_monthly_billing_report')).toHaveLength(4);
    expect(calls('worker_invalidate_account_usage')).toHaveLength(0);
  });
  it('reports one unverified account but still syncs the otherfour with no guessed costs', async () => {
    failSlot = 4; const response = await reconcile.handler(request()); expect(response.status).toBe(200);
    const result = (await response.json()).sync;
    expect(result.accounts[3]).toMatchObject({ accountSlot: 4, success: false, syncedAt: null, error: 'usage_unverified' });
    expect(result.accounts.filter((value: { success: boolean }) => value.success)).toHaveLength(4);
    expect(calls('worker_invalidate_account_usage')).toHaveLength(1);
  });
  it.each([{ action: 'billing_sync' }, { action: 'billing_sync', continuation_budget: 1 }, { action: 'billing_sync', continuation_budget: 0, settle_job_id: owner }])('rejects nonisolated sync request before DB: %j', async input => {
    expect((await reconcile.handler(request(input))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires internal service authentication and rejects browser-supplied owner', async () => {
    expect((await reconcile.handler(request(undefined, 'wrong'))).status).toBe(401);
    expect((await reconcile.handler(request({ action: 'billing_sync', continuation_budget: 0, owner_user_id: owner }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
