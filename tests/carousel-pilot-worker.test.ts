import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const providers = await import('../supabase/functions/_shared/providers.ts' as string);
const dispatcher = await import('../supabase/functions/refresh-dispatch/index.ts' as string);
const reconciler = await import('../supabase/functions/reconcile-jobs/index.ts' as string);
const webhook = await import('../supabase/functions/apify-webhook/index.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111';
const selected = '22222222-2222-4222-8222-222222222222';
const foreign = '33333333-3333-4333-8333-333333333333';
const claim = { job: { id: selected, owner_user_id: owner, kind: 'carousel', collection_source: 'carousel_pilot', live: true, reserved_usd: .10, results_limit: 30,
  expected_actor_id: 'actor', expected_provider_user_id: 'account', dispatch_nonce: owner }, creators: [{ id: foreign, username: 'fixture' }], max_total_charge_usd: .10 };
let values: Record<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const response = (data: unknown) => new Response(JSON.stringify(data));
const request = (payload: unknown, secret = 'secret') => new Request('https://fixture.test', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-secret': secret }, body: JSON.stringify(payload) });
beforeEach(() => {
  values = { PROVIDER_MODE: 'apify', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor', APIFY_API_TOKEN: 'fixture', APIFY_ACCOUNT_ID: 'account',
    APIFY_WEBHOOK_SHARED_SECRET: 'webhook', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
    INTERNAL_CRON_SECRET: 'secret', REELRADAR_OWNER_USER_ID: owner, SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true',
    RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true', CAROUSEL_PROVIDER_VALIDATED: 'false', CAROUSEL_PILOT_JOB_ID: selected };
  vi.stubGlobal('Deno', { env: { get: (key: string) => values[key] }, serve: vi.fn() });
  fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    const address = String(url);
    if (address.endsWith('/worker_accounts')) return response([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'account', enabled: true, authorization_confirmed: true }]);
    if (address.endsWith('/worker_begin_account_usage')) return response({ observation_id: foreign, observed_at: new Date().toISOString() });
    if (address.endsWith('/worker_invalidate_account_usage')) return response(null);
    if (address.endsWith('/users/me')) return response({ data: { id: 'account' } });
    if (address.endsWith('/users/me/limits')) return response({ data: { monthlyUsageCycle: { startAt: new Date(Date.now() - 86400000).toISOString(),
      endAt: new Date(Date.now() + 86400000).toISOString() }, current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 50 } } });
    if (address.endsWith('/worker_claim_carousel_pilot')) return response(structuredClone(claim));
    if (address.includes('/actors/actor/runs')) return response({ data: { id: 'run', actId: 'actor', userId: 'account', status: 'RUNNING', defaultDatasetId: 'dataset' } });
    if (address.endsWith('/worker_isolate_collection_settlement')) return response(null);
    if (address.endsWith('/worker_claim_reconciliation')) return response([]);
    if (address.endsWith('/worker_record_callback_receipt')) return response({ accepted: true });
    if (address.endsWith('/worker_get_collection_recovery_state')) return response({ input_digest: null, accepted_evidence: [], callback_hints: [] });
    if (address.endsWith('/worker_record_accepted_evidence')) return response({ recorded: true });
    if (address.endsWith('/worker_authorize_collection_submit')) return response({ authorized: true });
    if (address.endsWith('/worker_cancel_pre_submit')) return response({ cancelled: true });
    if (address.endsWith('/worker_claim_missing_run_recovery')) return response([]);
    if (address.endsWith('/worker_record_usage') || address.endsWith('/worker_attach_run') || address.endsWith('/worker_dispatch_failure') || address.endsWith('/worker_expire_dispatches') || address.endsWith('/worker_complete_reconciliation')) return response({});
    if (address.includes('/rest/v1/scrape_jobs?')) return response([]);
    throw new Error('Unexpected fixture transport');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('isolated carousel trial dispatch', () => {
  it('refreshes authoritative usage, claims one job and sends the matching provider cap with the broad gate closed', async () => {
    const result = await dispatcher.handler(request({ action: 'carousel_pilot', job_id: selected, continuation_budget: 0 }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ outcome: { job_id: selected, status: 'running' } });
    expect(() => providers.validateProfileSetup('carousel')).toThrow('mapping');
    const calls = fetcher.mock.calls.map(([url]) => String(url));
    expect(calls.filter(url => url.includes('/actors/'))).toHaveLength(1);
    expect(calls.find(url => url.includes('/actors/'))).toContain('maxTotalChargeUsd=0.1');
    expect(calls.indexOf('https://fixture.supabase.co/rest/v1/rpc/worker_record_usage')).toBeLessThan(calls.indexOf('https://fixture.supabase.co/rest/v1/rpc/worker_claim_carousel_pilot'));
    expect(calls.some(url => url.endsWith('/worker_claim_next') || url.endsWith('/worker_competitor_maintain'))).toBe(false);
  });
  it.each([
    { action: 'carousel_pilot', job_id: foreign }, { action: 'carousel_pilot', job_id: 'invalid' },
    { action: 'carousel_pilot', job_id: selected, kind: 'daily' },
  ])('blocks an invalid or unselected request before provider/database transport: %j', async payload => {
    expect((await dispatcher.handler(request(payload))).status).toBeGreaterThanOrEqual(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated requests and requires all existing live gates', async () => {
    expect((await dispatcher.handler(request({ action: 'carousel_pilot', job_id: selected }, 'wrong'))).status).toBe(401);
    for (const key of ['SCRAPING_ENABLED', 'PROVIDER_VALIDATED', 'RUN_CHARGE_CAP_VALIDATED', 'ACCOUNT_USAGE_VALIDATED', 'CAROUSEL_PILOT_JOB_ID']) {
      const prior = values[key]; delete values[key];
      await expect(worker.dispatchCarouselPilot(owner, selected)).rejects.toThrow(); values[key] = prior;
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cannot claim a paid run without authoritative account usage', async () => {
    fetcher.mockResolvedValue(response({ data: {} }));
    await expect(worker.dispatchCarouselPilot(owner, selected)).rejects.toThrow();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/worker_claim_carousel_pilot') || String(url).includes('/actors/'))).toBe(false);
  });
  it.each([
    { endpoint: '/users/me', stage: 'provider_usage', status: 401 },
    { endpoint: '/worker_record_usage', stage: 'usage_persistence', status: 403 },
  ])('identifies the failing billing stage without exposing upstream bodies: $stage', async ({ endpoint, stage, status }) => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith(endpoint) ? Promise.resolve(new Response('private upstream detail', { status })) : original(url, init));
    const result = await dispatcher.handler(request({ action: 'diagnostics' }));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'authoritative_usage_unavailable', stage, upstreamStatus: status });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/'))).toBe(false);
  });
  it('does not start again when the selected job is already claimed', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/worker_claim_carousel_pilot') ? Promise.resolve(response({ reason: 'pilot_job_not_pending' })) : original(url, init));
    expect(await worker.dispatchCarouselPilot(owner, selected)).toEqual({ reason: 'pilot_job_not_pending' });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/'))).toBe(false);
  });
  it('keeps an uncertain reservation after a provider timeout without retrying the start', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).includes('/actors/') ? Promise.reject(new Error('timeout')) : original(url, init));
    expect(await worker.dispatchCarouselPilot(owner, selected)).toEqual({ job_id: selected, status: 'uncertain' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/actors/'))).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/worker_dispatch_failure'))).toBe(true);
  });
  it.each([.11, 0, null])('rejects an invalid claim cap before a paid start: %s', async cap => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/worker_claim_carousel_pilot') ? Promise.resolve(response({ ...claim, max_total_charge_usd: cap })) : original(url, init));
    await expect(worker.dispatchCarouselPilot(owner, selected)).rejects.toThrow('Invalid carousel pilot claim');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/'))).toBe(false);
  });
  it('reconciles only the trial job and never starts queued jobs or schedules', async () => {
    const result = await reconciler.handler(request({ carousel_pilot_job_id: selected, continuation_budget: 0 }));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ outcomes: [], next: 'pilot_only' });
    const calls = fetcher.mock.calls.map(([url]) => String(url));
    const selector = fetcher.mock.calls.find(([url]) => String(url).endsWith('/worker_claim_reconciliation'))!;
    expect(JSON.parse(String(selector[1]?.body))).toMatchObject({ p_owner_user_id: owner, p_job_id: selected, p_kind: 'carousel', p_limit: 10 });
    expect(calls.some(url => url.includes('/actors/') || url.endsWith('/worker_competitor_maintain') || url.endsWith('/worker_claim_next') || url.endsWith('/worker_expire_dispatches'))).toBe(false);
  });
  it('settles one existing owned run without dispatching or maintaining queued collection', async () => {
    const result = await reconciler.handler(request({ settle_job_id: foreign, continuation_budget: 0 }));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ outcomes: [], next: 'settlement_only' });
    const calls = fetcher.mock.calls.map(([url]) => String(url));
    const selector = fetcher.mock.calls.find(([url]) => String(url).endsWith('/worker_claim_reconciliation'))!;
    expect(JSON.parse(String(selector[1]?.body))).toMatchObject({ p_owner_user_id: owner, p_job_id: foreign, p_kind: null, p_limit: 10 });
    expect(calls.some(url => url.includes('/actors/') || url.endsWith('/worker_competitor_maintain') || url.endsWith('/worker_claim_next') || url.endsWith('/worker_expire_dispatches'))).toBe(false);
    const isolation = fetcher.mock.calls.find(([url]) => String(url).endsWith('/worker_isolate_collection_settlement'))!;
    expect(JSON.parse(String(isolation[1]?.body))).toEqual({ p_owner_user_id: owner, p_job_id: foreign });
    expect(calls.indexOf(String(isolation[0]))).toBeLessThan(calls.indexOf(String(selector[0])));
  });
  it.each([{ settle_job_id: 'invalid' }, { settle_job_id: foreign, carousel_pilot_job_id: selected }])('rejects an invalid or conflicting settlement scope before transport: %j', async payload => {
    expect((await reconciler.handler(request(payload))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([true, false])('keeps a successful pilot webhook scoped, including after removing its temporary gate: %s', async configured => {
    if (!configured) { delete values.CAROUSEL_PILOT_JOB_ID; values.CAROUSEL_PROVIDER_VALIDATED = 'true'; }
    // Provenance, not either temporary environment gate, keeps the historical pilot isolated.
    const nonce = owner;
    const job = { ...claim.job, actor_run_id: 'run', dispatch_nonce: nonce, status: 'succeeded' };
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      const address = String(url);
      if (address.includes('/scrape_jobs?')) return response([job]);
      if (address.endsWith('/worker_claim_reconciliation')) return response([{ job, callback_hint: { run_id: 'run', dispatch_nonce: nonce }, reconciliation_token: foreign }]);
      if (address.includes('/actor-runs/run')) return response({ data: { id: 'run', actId: 'actor', userId: 'account', status: 'SUCCEEDED', usageTotalUsd: .001 } });
      if (address.endsWith('/worker_reconcile_run')) return response(job);
      if (address.endsWith('/worker_transcription_media_reconcile')) return response({ status: 'not_linked' });
      return original(url, init);
    });
    const result = await webhook.handler(new Request(`https://fixture.test/apify-webhook?job_id=${selected}&dispatch_nonce=${nonce}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'webhook' }, body: JSON.stringify({ run_id: 'run' }),
    }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ accepted: true, processing: 'succeeded', next: 'pilot_only' });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/') || String(url).endsWith('/worker_claim_next') || String(url).endsWith('/worker_competitor_maintain'))).toBe(false);
  });
});
